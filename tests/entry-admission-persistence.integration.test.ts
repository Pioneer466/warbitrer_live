import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { runDatabaseMigrations } from "@/lib/db-migrations";
import { SHADOW_REENTRY_COOLDOWN_MS } from "@/lib/entry-admission-policy";
import type { CircuitBreakerIncident } from "@/lib/circuit-breaker-policy";
import {
  admitLiveEntryAtomically,
  admitShadowEntryAtomically,
  claimAdmittedLiveOrderAttemptAtomically,
  claimLiveOrderAttemptForSubmissionAtomically,
  revalidateLiveOrderAttemptBeforeDispatchAtomically,
  ConfigurationRevisionConflictError,
  DATABASE_MIGRATIONS,
  getLastAuthorizedEntryCosts,
  hashOrderAttemptRequest,
  LiveOrderAttemptClaimError,
  migratePostgresDatabase,
  observeCircuitBreakerIncident,
  PersistenceIdentityConflictError,
  insertOrderIntent,
  upsertOrderAttempt,
  upsertCircuitBreaker,
} from "@/lib/postgres-db";
import type {
  EntryAdmissionDecision,
  LiveEntryAdmissionInput,
  MarketAsset,
  OrderAttempt,
  OrderIntent,
  LiveOrderAttemptSubmissionInput,
  ShadowEntryAdmissionInput,
} from "@/lib/types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const DEFAULT_TEST_NOW = Date.now();
const DEFAULT_TEST_SLOT_DURATION_MS = 15 * 60_000;

describePostgres("Postgres entry admission", () => {
  it("installs the V4 reservation and immutable-request schema", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);

      const reservations = await pool.query<{
        scope_key: string;
        mode: string;
        asset: string | null;
      }>("SELECT scope_key, mode, asset FROM entry_reservations ORDER BY scope_key ASC");
      const hashColumn = await pool.query<{ is_nullable: string }>(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'order_attempts'
          AND column_name = 'request_sha256'
      `);

      expect(reservations.rows).toHaveLength(8);
      expect(reservations.rows).toContainEqual({ scope_key: "live:global", mode: "live", asset: null });
      expect(reservations.rows).toContainEqual({ scope_key: "shadow:btc", mode: "shadow", asset: "btc" });
      expect(hashColumn.rows).toEqual([{ is_nullable: "YES" }]);
    });
  }, 30_000);

  it("refuses and rolls V4 back when legacy live intents already violate the global scope", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 3));
      await insertOrderIntent(pool, buildIntent({ id: "legacy-live-a", mode: "live", status: "pending" }));
      await insertOrderIntent(
        pool,
        buildIntent({ id: "legacy-live-b", asset: "eth", mode: "live", status: "pending" }),
      );

      await expect(runDatabaseMigrations(pool, DATABASE_MIGRATIONS)).rejects.toThrow(
        /Migration 4 refused: multiple unresolved live intents/,
      );

      const applied = await pool.query<{ versions: number[] }>(
        "SELECT array_agg(version ORDER BY version) AS versions FROM schema_migrations",
      );
      const v4Table = await pool.query<{ table_name: string | null }>(
        "SELECT to_regclass('entry_admissions') AS table_name",
      );
      const hashColumn = await pool.query<{ total: number }>(`
        SELECT count(*)::integer AS total
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'order_attempts'
          AND column_name = 'request_sha256'
      `);

      expect(applied.rows[0]?.versions).toEqual([1, 2, 3]);
      expect(v4Table.rows[0]?.table_name).toBeNull();
      expect(hashColumn.rows[0]?.total).toBe(0);
    });
  }, 30_000);

  it("admits only one concurrent live intent across all assets", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc", "eth"], "live");

      const decisions = await Promise.all([
        admitLiveEntryAtomically(pool, buildLiveInput({ id: "live-btc", asset: "btc" })),
        admitLiveEntryAtomically(pool, buildLiveInput({ id: "live-eth", asset: "eth" })),
      ]);

      expect(decisions.filter(isAdmitted)).toHaveLength(1);
      expect(decisions.filter((decision) => !decision.admitted)).toEqual([
        expect.objectContaining({ code: "reservation_conflict" }),
      ]);
      const counts = await admissionCounts(pool);
      expect(counts).toEqual({ intents: 1, attempts: 1, admissions: 1 });

      const reservation = await pool.query<{ owner_intent_id: string; revision: number }>(
        "SELECT owner_intent_id, revision FROM entry_reservations WHERE scope_key = 'live:global'",
      );
      expect(reservation.rows[0]?.owner_intent_id).toBe(decisions.find(isAdmitted)?.intent.id);
      expect(reservation.rows[0]?.revision).toBe(1);
    });
  }, 30_000);

  it("isolates shadow reservations by asset while serializing the same asset", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc", "eth", "doge"], "shadow");

      const crossAsset = await Promise.all([
        admitShadowEntryAtomically(pool, buildShadowInput({ id: "shadow-btc", asset: "btc" })),
        admitShadowEntryAtomically(pool, buildShadowInput({ id: "shadow-eth", asset: "eth" })),
      ]);
      expect(crossAsset.every(isAdmitted)).toBe(true);

      const sameAsset = await Promise.all([
        admitShadowEntryAtomically(pool, buildShadowInput({ id: "shadow-doge-a", asset: "doge" })),
        admitShadowEntryAtomically(pool, buildShadowInput({ id: "shadow-doge-b", asset: "doge" })),
      ]);
      expect(sameAsset.filter(isAdmitted)).toHaveLength(1);
      expect(sameAsset.filter((decision) => !decision.admitted)).toEqual([
        expect.objectContaining({ code: "reservation_conflict" }),
      ]);
    });
  }, 30_000);

  it("enforces the shadow cooldown with the database clock", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "shadow");

      const first = await admitShadowEntryAtomically(
        pool,
        buildShadowInput({ id: "shadow-cooldown-first", grossCost: 0.9 }),
      );
      expect(first).toMatchObject({ admitted: true, fresh: true });
      const clock = await pool.query<{ now_ms: number }>(
        "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms",
      );
      const nextEligibleAt = Number(clock.rows[0]?.now_ms) + SHADOW_REENTRY_COOLDOWN_MS;
      await pool.query(
        `
          UPDATE order_intents
          SET status = 'hedged',
              shadow_execution_json = jsonb_build_object('nextEligibleAt', $2::bigint)
          WHERE id = $1
        `,
        ["shadow-cooldown-first", nextEligibleAt],
      );

      const forgedFutureClock = await admitShadowEntryAtomically(
        pool,
        buildShadowInput({
          id: "shadow-cooldown-forged-clock",
          grossCost: 0.88,
          now: nextEligibleAt + 1,
        }),
      );
      expect(forgedFutureClock).toMatchObject({
        admitted: false,
        code: "shadow_cooldown_active",
        blockingIntentId: "shadow-cooldown-first",
        nextEligibleAt,
      });
      if (forgedFutureClock.admitted) {
        throw new Error("Expected the database clock to keep the shadow cooldown active");
      }
      expect(forgedFutureClock.retryAfterMs).toBeGreaterThan(0);
      await expect(admissionCounts(pool)).resolves.toEqual({ intents: 1, attempts: 0, admissions: 1 });

      await expireShadowCooldown(pool, "shadow-cooldown-first");
      const afterCooldown = await admitShadowEntryAtomically(
        pool,
        buildShadowInput({ id: "shadow-cooldown-expired", grossCost: 0.88 }),
      );
      expect(afterCooldown).toMatchObject({ admitted: true, fresh: true });
    });
  }, 30_000);

  it("uses only admitted same-mode entries as the reentry baseline", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");

      const live = await admitLiveEntryAtomically(pool, buildLiveInput({ id: "baseline-live", grossCost: 0.9 }));
      expect(live).toMatchObject({ admitted: true, fresh: true });
      await pool.query(
        "UPDATE order_attempts SET status = 'failed', truth_status = 'not_submitted' WHERE intent_id = 'baseline-live'",
      );
      await pool.query("UPDATE order_intents SET status = 'hedged' WHERE id = 'baseline-live'");

      await setStrategyMode(pool, ["btc"], "shadow");
      const firstShadow = await admitShadowEntryAtomically(
        pool,
        buildShadowInput({ id: "z-baseline-shadow", grossCost: 0.9 }),
      );
      expect(firstShadow).toMatchObject({ admitted: true, fresh: true });
      await pool.query("UPDATE order_intents SET status = 'hedged' WHERE id = 'z-baseline-shadow'");
      await expireShadowCooldown(pool, "z-baseline-shadow");

      const unchangedShadow = await admitShadowEntryAtomically(
        pool,
        buildShadowInput({ id: "baseline-shadow-same", grossCost: 0.9 }),
      );
      expect(unchangedShadow).toMatchObject({
        admitted: false,
        code: "reentry_insufficient_improvement",
        previousGrossCost: 0.9,
      });

      const improvedShadow = await admitShadowEntryAtomically(
        pool,
        buildShadowInput({ id: "a-baseline-shadow-improved", grossCost: 0.88 }),
      );
      expect(improvedShadow).toMatchObject({ admitted: true, fresh: true });
      await expect(getLastAuthorizedEntryCosts(pool, "btc", "btc:slot", "live")).resolves.toEqual({
        POLY_UP_KALSHI_NO: 0.9,
      });
      await expect(getLastAuthorizedEntryCosts(pool, "btc", "btc:slot", "shadow")).resolves.toEqual({
        POLY_UP_KALSHI_NO: 0.88,
      });
    });
  }, 30_000);

  it("keeps terminal pre-admission intents as a conservative same-mode reentry baseline", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const priorDay = new Date().setUTCHours(0, 0, 0, 0) - DEFAULT_TEST_SLOT_DURATION_MS;
      const legacyLive = buildIntent({ id: "legacy-terminal-live", mode: "live", status: "settled", grossCost: 0.9 });
      const legacyShadow = buildIntent({
        id: "legacy-terminal-shadow",
        mode: "shadow",
        status: "settled",
        grossCost: 0.7,
      });
      for (const intent of [legacyLive, legacyShadow]) {
        intent.slotStartTs = priorDay - DEFAULT_TEST_SLOT_DURATION_MS;
        intent.slotEndTs = priorDay;
        intent.createdAt = intent.slotStartTs + 1;
        intent.updatedAt = intent.slotEndTs;
        intent.resolvedAt = intent.slotEndTs;
      }
      await insertOrderIntent(pool, legacyLive);
      await insertOrderIntent(pool, legacyShadow);
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS);
      await setStrategyMode(pool, ["btc"], "live");

      const unchanged = await admitLiveEntryAtomically(
        pool,
        buildLiveInput({ id: "legacy-baseline-unchanged", grossCost: 0.9 }),
      );
      expect(unchanged).toMatchObject({
        admitted: false,
        code: "reentry_insufficient_improvement",
        previousGrossCost: 0.9,
      });

      const improved = await admitLiveEntryAtomically(
        pool,
        buildLiveInput({ id: "legacy-baseline-improved", grossCost: 0.88 }),
      );
      expect(improved).toMatchObject({ admitted: true, fresh: true });
    });
  }, 30_000);

  it("replays the exact live request idempotently and rejects a changed request", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const original = buildLiveInput({ id: "idempotent-live" });

      const first = await admitLiveEntryAtomically(pool, original);
      expect(first).toMatchObject({ admitted: true, fresh: true, admission: { sequence: 1 } });
      if (!first.admitted || !first.plannedAttempt) {
        throw new Error("Expected a fresh live admission");
      }
      expect(first.admission.authorizedAt).toBeGreaterThanOrEqual(original.now);
      expect(first.admission.authorizedAt).toBeLessThan(original.latestSubmissionStartAt);
      expect(first.reservation.reservedAt).toBe(first.admission.authorizedAt);
      expect(first.plannedAttempt.truthStatus).toBe("admitted_not_claimed");
      expect(first.plannedAttempt.requestSha256).toBe(hashOrderAttemptRequest(original.plannedAttempt.request));
      await expect(
        pool.query("UPDATE order_attempts SET request_json = '{\"size\":11}'::jsonb WHERE id = $1", [
          original.plannedAttempt.id,
        ]),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        pool.query("UPDATE entry_admissions SET gross_cost = 0.1 WHERE intent_id = $1", [original.intent.id]),
      ).rejects.toMatchObject({ code: "55000" });

      const replay = buildLiveInput({ id: "idempotent-live" });
      replay.plannedAttempt.request = {
        nested: { tif: "FOK", tick: 0.01 },
        size: 10,
        price: 0.45,
      };
      await expect(admitLiveEntryAtomically(pool, replay)).resolves.toMatchObject({ admitted: true, fresh: false });

      const changed = buildLiveInput({ id: "idempotent-live" });
      changed.plannedAttempt.request = { ...changed.plannedAttempt.request, size: 11 };
      await expect(admitLiveEntryAtomically(pool, changed)).rejects.toBeInstanceOf(PersistenceIdentityConflictError);
      await expect(admissionCounts(pool)).resolves.toEqual({ intents: 1, attempts: 1, admissions: 1 });
    });
  }, 30_000);

  it("uses a conservative logical clock when the application is ahead of PostgreSQL", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const applicationNow = Date.now() + 5_000;
      const input = buildLiveInput({ id: "application-clock-ahead", now: applicationNow });

      const result = await admitLiveEntryAtomically(pool, input);

      expect(result).toMatchObject({ admitted: true, fresh: true });
      if (!result.admitted) {
        throw new Error("Expected admission with bounded application clock skew");
      }
      expect(result.admission.authorizedAt).toBeGreaterThanOrEqual(applicationNow);
      expect(result.reservation.reservedAt).toBe(result.admission.authorizedAt);
    });
  }, 30_000);

  it("allows exactly one concurrent claimant to consume an admitted live attempt", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const input = buildLiveInput({ id: "one-shot-live" });
      const admission = await admitLiveEntryAtomically(pool, input);
      expect(admission).toMatchObject({ admitted: true, fresh: true });

      const claim = {
        intentId: input.intent.id,
        attemptId: input.plannedAttempt.id,
        request: {
          nested: { tif: "FOK", tick: 0.01 },
          size: 10,
          price: 0.45,
        },
        claimedAt: Date.now(),
      };
      const claims = await Promise.allSettled([
        claimAdmittedLiveOrderAttemptAtomically(pool, claim),
        claimAdmittedLiveOrderAttemptAtomically(pool, claim),
      ]);

      const fulfilled = claims.filter(
        (result): result is PromiseFulfilledResult<OrderAttempt> => result.status === "fulfilled",
      );
      const rejected = claims.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]?.value).toMatchObject({
        id: input.plannedAttempt.id,
        status: "submitting",
        truthStatus: "submission_in_progress",
      });
      expect(fulfilled[0]?.value.updatedAt).toBeGreaterThanOrEqual(input.now);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(LiveOrderAttemptClaimError);
      expect(rejected[0]?.reason).toMatchObject({
        code: "attempt_already_claimed",
        intentId: input.intent.id,
        attemptId: input.plannedAttempt.id,
        actualStatus: "submitting",
      });

      const stored = await pool.query<{ status: string; truth_status: string; revision: number }>(
        "SELECT status, truth_status, revision FROM order_attempts WHERE id = $1",
        [input.plannedAttempt.id],
      );
      expect(stored.rows).toEqual([{ status: "submitting", truth_status: "submission_in_progress", revision: 1 }]);
    });
  }, 30_000);

  it("rejects an expired submission capability without consuming the planned attempt", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const now = Date.now();
      const input = buildLiveInput({
        id: "expired-live-claim",
        now,
        slotEndTs: now + 2_000,
        cutoffAt: now + 1_500,
        latestSubmissionStartAt: now + 300,
      });
      await expect(admitLiveEntryAtomically(pool, input)).resolves.toMatchObject({ admitted: true, fresh: true });
      await delayUntil(input.latestSubmissionStartAt);

      await expect(
        claimAdmittedLiveOrderAttemptAtomically(pool, {
          intentId: input.intent.id,
          attemptId: input.plannedAttempt.id,
          request: input.plannedAttempt.request,
          claimedAt: input.now,
        }),
      ).rejects.toMatchObject({ code: "submission_capability_expired", actualStatus: "planned" });

      const stored = await pool.query<{ status: string; truth_status: string; revision: number }>(
        "SELECT status, truth_status, revision FROM order_attempts WHERE id = $1",
        [input.plannedAttempt.id],
      );
      expect(stored.rows).toEqual([{ status: "planned", truth_status: "admitted_not_claimed", revision: 0 }]);
    });
  }, 30_000);

  it("rechecks the submission capability after waiting on the attempt lock", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const now = Date.now();
      const input = buildLiveInput({
        id: "claim-lock-expiry",
        now,
        slotEndTs: now + 3_000,
        cutoffAt: now + 2_000,
        latestSubmissionStartAt: now + 700,
      });
      await expect(admitLiveEntryAtomically(pool, input)).resolves.toMatchObject({ admitted: true, fresh: true });

      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT id FROM order_attempts WHERE id = $1 FOR UPDATE", [input.plannedAttempt.id]);

        const claim = claimAdmittedLiveOrderAttemptAtomically(pool, {
          intentId: input.intent.id,
          attemptId: input.plannedAttempt.id,
          request: input.plannedAttempt.request,
          claimedAt: Date.now(),
        });
        const assertion = expect(claim).rejects.toMatchObject({
          code: "submission_capability_expired",
          actualStatus: "planned",
        });
        await delayUntil(input.latestSubmissionStartAt);
        await writer.query("COMMIT");
        await assertion;
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
      }

      const stored = await pool.query<{ status: string; truth_status: string; revision: number }>(
        "SELECT status, truth_status, revision FROM order_attempts WHERE id = $1",
        [input.plannedAttempt.id],
      );
      expect(stored.rows).toEqual([{ status: "planned", truth_status: "admitted_not_claimed", revision: 0 }]);
    });
  }, 30_000);

  it("rejects disabled or shadow strategy state at claim time without consuming the attempt", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const input = buildLiveInput({ id: "claim-mode-revoked" });
      await expect(admitLiveEntryAtomically(pool, input)).resolves.toMatchObject({ admitted: true, fresh: true });
      const claim = {
        intentId: input.intent.id,
        attemptId: input.plannedAttempt.id,
        request: input.plannedAttempt.request,
        claimedAt: Date.now(),
      };

      await pool.query(
        `UPDATE strategy_configs SET payload = payload || '{"enableTrading":false}'::jsonb WHERE asset = 'btc'`,
      );
      await expect(claimAdmittedLiveOrderAttemptAtomically(pool, claim)).rejects.toMatchObject({
        code: "trading_disabled",
        actualStatus: "planned",
      });
      await expectAttemptToRemainUnclaimed(pool, input.plannedAttempt.id);

      await pool.query(
        `UPDATE strategy_configs
         SET payload = payload || '{"enableTrading":true,"shadowMode":true}'::jsonb
         WHERE asset = 'btc'`,
      );
      await expect(claimAdmittedLiveOrderAttemptAtomically(pool, claim)).rejects.toMatchObject({
        code: "execution_mode_mismatch",
        actualStatus: "planned",
      });
      await expectAttemptToRemainUnclaimed(pool, input.plannedAttempt.id);
    });
  }, 30_000);

  it("waits for a post-admission strategy revision and then revokes the claim", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const input = buildLiveInput({ id: "claim-strategy-race" });
      await expect(admitLiveEntryAtomically(pool, input)).resolves.toMatchObject({ admitted: true, fresh: true });

      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT asset FROM strategy_configs WHERE asset = 'btc' FOR UPDATE");
        await writer.query("UPDATE strategy_configs SET revision = revision + 1 WHERE asset = 'btc'");

        const claim = claimAdmittedLiveOrderAttemptAtomically(pool, {
          intentId: input.intent.id,
          attemptId: input.plannedAttempt.id,
          request: input.plannedAttempt.request,
          claimedAt: Date.now(),
        });
        const assertion = expect(claim).rejects.toMatchObject({
          code: "strategy_revision_changed",
          actualStatus: "planned",
        });
        await delay(50);
        await writer.query("COMMIT");
        await assertion;
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
      }

      await expectAttemptToRemainUnclaimed(pool, input.plannedAttempt.id);
    });
  }, 30_000);

  it("waits for a post-admission global-risk revision and then revokes the claim", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const input = buildLiveInput({ id: "claim-global-risk-race" });
      await expect(admitLiveEntryAtomically(pool, input)).resolves.toMatchObject({ admitted: true, fresh: true });

      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT id FROM global_risk_config WHERE id = 1 FOR UPDATE");
        await writer.query("UPDATE global_risk_config SET revision = revision + 1 WHERE id = 1");

        const claim = claimAdmittedLiveOrderAttemptAtomically(pool, {
          intentId: input.intent.id,
          attemptId: input.plannedAttempt.id,
          request: input.plannedAttempt.request,
          claimedAt: Date.now(),
        });
        const assertion = expect(claim).rejects.toMatchObject({
          code: "global_risk_revision_changed",
          actualStatus: "planned",
        });
        await delay(50);
        await writer.query("COMMIT");
        await assertion;
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
      }

      await expectAttemptToRemainUnclaimed(pool, input.plannedAttempt.id);
    });
  }, 30_000);

  it("waits for a post-admission slot breaker insertion and then revokes the claim", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const input = buildLiveInput({ id: "claim-breaker-race" });
      await expect(admitLiveEntryAtomically(pool, input)).resolves.toMatchObject({ admitted: true, fresh: true });

      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        const incident = buildTestBreakerIncident({
          id: "claim-race-slot-breaker",
          scope: { type: "slot", asset: "btc", slotKey: input.intent.slotKey },
          triggeredAt: Date.now(),
        });
        await observeCircuitBreakerIncident(writer, {
          incident,
          actor: incident.owner,
          requestId: "claim-race-slot-breaker",
        });

        const claim = claimAdmittedLiveOrderAttemptAtomically(pool, {
          intentId: input.intent.id,
          attemptId: input.plannedAttempt.id,
          request: input.plannedAttempt.request,
          claimedAt: Date.now(),
        });
        const assertion = expect(claim).rejects.toMatchObject({
          code: "circuit_breaker_active",
          actualStatus: "planned",
          reason: expect.stringContaining(`slot:${input.intent.slotKey}`),
        });
        await delay(50);
        await writer.query("COMMIT");
        await assertion;
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
      }

      await expectAttemptToRemainUnclaimed(pool, input.plannedAttempt.id);
    });
  }, 30_000);

  it("rejects a changed request without consuming the planned attempt", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const input = buildLiveInput({ id: "changed-request-claim" });
      await admitLiveEntryAtomically(pool, input);

      await expect(
        claimAdmittedLiveOrderAttemptAtomically(pool, {
          intentId: input.intent.id,
          attemptId: input.plannedAttempt.id,
          request: { ...input.plannedAttempt.request, size: 11 },
          claimedAt: Date.now(),
        }),
      ).rejects.toMatchObject({ code: "request_mismatch", actualStatus: "planned" });

      const stored = await pool.query<{
        status: string;
        truth_status: string | null;
        revision: number;
        updated_at: number;
      }>("SELECT status, truth_status, revision, updated_at FROM order_attempts WHERE id = $1", [
        input.plannedAttempt.id,
      ]);
      expect(stored.rows).toEqual([
        {
          status: "planned",
          truth_status: "admitted_not_claimed",
          revision: 0,
          updated_at: input.plannedAttempt.updatedAt,
        },
      ]);
    });
  }, 30_000);

  it("rejects wrong intent and admission links without consuming either attempt", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const input = buildLiveInput({ id: "linked-claim" });
      await admitLiveEntryAtomically(pool, input);

      await expect(
        claimAdmittedLiveOrderAttemptAtomically(pool, {
          intentId: "wrong-intent",
          attemptId: input.plannedAttempt.id,
          request: input.plannedAttempt.request,
          claimedAt: Date.now(),
        }),
      ).rejects.toMatchObject({ code: "attempt_intent_mismatch", actualStatus: "planned" });

      const unlinkedAttempt = {
        ...input.plannedAttempt,
        id: `${input.intent.id}:unlinked-attempt`,
        clientOrderId: `${input.intent.id}:unlinked-client`,
      };
      await upsertOrderAttempt(pool, unlinkedAttempt);
      await expect(
        claimAdmittedLiveOrderAttemptAtomically(pool, {
          intentId: input.intent.id,
          attemptId: unlinkedAttempt.id,
          request: unlinkedAttempt.request,
          claimedAt: Date.now(),
        }),
      ).rejects.toMatchObject({ code: "admission_attempt_mismatch", actualStatus: "planned" });

      const stored = await pool.query<{ id: string; status: string; revision: number }>(
        "SELECT id, status, revision FROM order_attempts ORDER BY id",
      );
      expect(stored.rows).toEqual([
        { id: input.plannedAttempt.id, status: "planned", revision: 0 },
        { id: unlinkedAttempt.id, status: "planned", revision: 0 },
      ]);
    });
  }, 30_000);

  it("rolls the claim back when the status transition cannot commit", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const input = buildLiveInput({ id: "rollback-claim" });
      await admitLiveEntryAtomically(pool, input);
      await pool.query(`
        CREATE FUNCTION reject_test_live_attempt_claim()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $trigger$
        BEGIN
          IF NEW.status = 'submitting' THEN
            RAISE EXCEPTION 'injected live attempt claim failure';
          END IF;
          RETURN NEW;
        END;
        $trigger$;

        CREATE TRIGGER reject_test_live_attempt_claim
        BEFORE UPDATE ON order_attempts
        FOR EACH ROW EXECUTE FUNCTION reject_test_live_attempt_claim();
      `);

      await expect(
        claimAdmittedLiveOrderAttemptAtomically(pool, {
          intentId: input.intent.id,
          attemptId: input.plannedAttempt.id,
          request: input.plannedAttempt.request,
          claimedAt: Date.now(),
        }),
      ).rejects.toThrow("injected live attempt claim failure");
      const stored = await pool.query<{ status: string; truth_status: string | null; revision: number }>(
        "SELECT status, truth_status, revision FROM order_attempts WHERE id = $1",
        [input.plannedAttempt.id],
      );
      expect(stored.rows).toEqual([{ status: "planned", truth_status: "admitted_not_claimed", revision: 0 }]);
    });
  }, 30_000);

  it("rolls intent, attempt, admission, and reservation back together", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      await pool.query(`
        CREATE FUNCTION reject_test_entry_admission()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $trigger$
        BEGIN
          RAISE EXCEPTION 'injected admission failure';
        END;
        $trigger$;

        CREATE TRIGGER reject_test_entry_admission
        BEFORE INSERT ON entry_admissions
        FOR EACH ROW EXECUTE FUNCTION reject_test_entry_admission();
      `);

      await expect(admitLiveEntryAtomically(pool, buildLiveInput({ id: "rollback-live" }))).rejects.toThrow(
        "injected admission failure",
      );
      await expect(admissionCounts(pool)).resolves.toEqual({ intents: 0, attempts: 0, admissions: 0 });
      const reservation = await pool.query<{ owner_intent_id: string | null; revision: number }>(
        "SELECT owner_intent_id, revision FROM entry_reservations WHERE scope_key = 'live:global'",
      );
      expect(reservation.rows[0]).toEqual({ owner_intent_id: null, revision: 0 });
    });
  }, 30_000);

  it("fails closed on stale configuration revisions and active breakers", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");

      const stale = buildLiveInput({ id: "stale-config" });
      stale.expectedStrategyRevision = 1;
      await expect(admitLiveEntryAtomically(pool, stale)).rejects.toBeInstanceOf(ConfigurationRevisionConflictError);

      await upsertCircuitBreaker(pool, {
        key: "asset:btc",
        active: true,
        reason: "manual",
        triggeredAt: 1_900,
        payload: { source: "integration-test" },
      });
      const blocked = await admitLiveEntryAtomically(pool, buildLiveInput({ id: "breaker-blocked" }));
      expect(blocked).toMatchObject({
        admitted: false,
        code: "circuit_breaker_active",
        activeBreakerKeys: ["asset:btc"],
      });
      await expect(admissionCounts(pool)).resolves.toEqual({ intents: 0, attempts: 0, admissions: 0 });
    });
  }, 30_000);

  it("waits for an in-flight configuration revision before deciding", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT asset FROM strategy_configs WHERE asset = 'btc' FOR UPDATE");
        await writer.query("UPDATE strategy_configs SET revision = revision + 1 WHERE asset = 'btc'");

        const admission = admitLiveEntryAtomically(pool, buildLiveInput({ id: "config-race" }));
        const assertion = expect(admission).rejects.toBeInstanceOf(ConfigurationRevisionConflictError);
        await delay(50);
        await writer.query("COMMIT");
        await assertion;
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
      }

      await expect(admissionCounts(pool)).resolves.toEqual({ intents: 0, attempts: 0, admissions: 0 });
    });
  }, 30_000);

  it("rechecks the live submission window after waiting on the reservation lock", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT scope_key FROM entry_reservations WHERE scope_key = 'live:global' FOR UPDATE");
        const now = Date.now();
        const input = buildLiveInput({
          id: "admission-lock-expiry",
          now,
          slotEndTs: now + 2_000,
          cutoffAt: now + 1_500,
          latestSubmissionStartAt: now + 300,
        });

        const admission = admitLiveEntryAtomically(pool, input);
        const assertion = expect(admission).resolves.toMatchObject({
          admitted: false,
          code: "submission_window_closed",
        });
        await delayUntil(input.latestSubmissionStartAt);
        await writer.query("COMMIT");
        await assertion;
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
      }

      await expect(admissionCounts(pool)).resolves.toEqual({ intents: 0, attempts: 0, admissions: 0 });
    });
  }, 30_000);

  it("rechecks the canonical slot after a shadow admission waits on its reservation lock", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "shadow");
      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT scope_key FROM entry_reservations WHERE scope_key = 'shadow:btc' FOR UPDATE");
        const now = Date.now();
        const input = buildShadowInput({ id: "shadow-slot-lock-expiry", now, slotEndTs: now + 300 });

        const admission = admitShadowEntryAtomically(pool, input);
        const assertion = expect(admission).resolves.toMatchObject({ admitted: false, code: "slot_closed" });
        await delayUntil(input.intent.slotEndTs);
        await writer.query("COMMIT");
        await assertion;
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
      }

      await expect(admissionCounts(pool)).resolves.toEqual({ intents: 0, attempts: 0, admissions: 0 });
    });
  }, 30_000);

  it("waits for a concurrent breaker activation and then blocks the entry", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        const incident = buildTestBreakerIncident({
          id: "admission-race-asset-breaker",
          scope: { type: "asset", asset: "btc" },
          triggeredAt: 1_900,
        });
        await observeCircuitBreakerIncident(writer, {
          incident,
          actor: incident.owner,
          requestId: "admission-race-asset-breaker",
        });

        const admission = admitLiveEntryAtomically(pool, buildLiveInput({ id: "breaker-race" }));
        await delay(50);
        await writer.query("COMMIT");
        await expect(admission).resolves.toMatchObject({
          admitted: false,
          code: "circuit_breaker_active",
          activeBreakerKeys: ["asset:btc"],
        });
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
      }

      await expect(admissionCounts(pool)).resolves.toEqual({ intents: 0, attempts: 0, admissions: 0 });
    });
  }, 30_000);
});

describePostgres("Postgres generic live order submission claims", () => {
  it("refuses V6 when a terminal legacy intent still has unresolved submission truth", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 5));
      const now = Date.now();
      const intent = buildIntent({ id: "legacy-terminal-attempt", mode: "live", status: "settled", now });
      const attempt = buildStageAttempt(intent, "hedge", "hedge");
      await insertOrderIntent(pool, intent);
      await pool.query(
        `
          INSERT INTO order_attempts (
            id, asset, shadow, intent_id, leg_id, stage, venue, side, order_type, client_order_id,
            venue_order_id, status, truth_status, request_json, request_sha256,
            result_json, error, created_at, updated_at
          ) VALUES (
            $1, $2, false, $3, $4, $5, $6, $7, $8, $9,
            NULL, 'submitting', 'submission_in_progress', $10::jsonb, $11,
            NULL, NULL, $12, $12
          )
        `,
        [
          attempt.id,
          attempt.asset,
          attempt.intentId,
          attempt.legId,
          attempt.stage,
          attempt.venue,
          attempt.side,
          attempt.orderType,
          attempt.clientOrderId,
          JSON.stringify(attempt.request),
          hashOrderAttemptRequest(attempt.request),
          attempt.createdAt,
        ],
      );

      await expect(runDatabaseMigrations(pool, DATABASE_MIGRATIONS)).rejects.toThrow(
        /Migration 6 refused: terminal intents have unresolved order submission truth/,
      );
      const applied = await pool.query<{ versions: number[] }>(
        "SELECT array_agg(version ORDER BY version) AS versions FROM schema_migrations",
      );
      const deadlineColumn = await pool.query<{ total: number }>(`
        SELECT count(*)::integer AS total
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'order_attempts'
          AND column_name = 'submission_deadline_at'
      `);
      expect(applied.rows[0]?.versions).toEqual([1, 2, 3, 4, 5]);
      expect(deadlineColumn.rows).toEqual([{ total: 0 }]);
    });
  }, 30_000);

  it("installs an immutable V6 submission deadline", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const deadlineColumn = await pool.query<{ is_nullable: string; data_type: string }>(`
        SELECT is_nullable, data_type
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'order_attempts'
          AND column_name = 'submission_deadline_at'
      `);
      expect(deadlineColumn.rows).toEqual([{ is_nullable: "YES", data_type: "bigint" }]);

      const now = Date.now();
      const intent = buildIntent({ id: "immutable-deadline", mode: "live", status: "primary_filled", now });
      const attempt = buildRecoveryAttempt(intent);
      const deadline = now + 10_000;
      await insertOrderIntent(pool, intent);
      await upsertOrderAttempt(pool, { ...attempt, submissionDeadlineAt: deadline });

      await expect(
        pool.query("UPDATE order_attempts SET submission_deadline_at = $2 WHERE id = $1", [attempt.id, deadline + 1]),
      ).rejects.toThrow(/submission deadline is immutable/);
      const stored = await pool.query<{ submission_deadline_at: number }>(
        "SELECT submission_deadline_at FROM order_attempts WHERE id = $1",
        [attempt.id],
      );
      expect(stored.rows).toEqual([{ submission_deadline_at: deadline }]);
    });
  }, 30_000);

  it("allows exactly one concurrent claimant and makes duplicate submission ambiguous", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const input = await buildStoredRecoverySubmissionInput(pool, "concurrent-recovery");

      const decisions = await Promise.all([
        claimLiveOrderAttemptForSubmissionAtomically(pool, input),
        claimLiveOrderAttemptForSubmissionAtomically(pool, input),
      ]);

      expect(decisions.filter((decision) => decision.decision === "claimed")).toHaveLength(1);
      expect(decisions.filter((decision) => decision.decision === "ambiguous")).toEqual([
        expect.objectContaining({ decision: "ambiguous", reason: "submission_in_progress" }),
      ]);
      expect(decisions.find((decision) => decision.decision === "claimed")).toMatchObject({
        decision: "claimed",
        fresh: true,
        attempt: {
          status: "submitting",
          truthStatus: "submission_in_progress",
          submissionDeadlineAt: input.submissionDeadlineAt,
        },
      });

      const stored = await pool.query<{
        total: number;
        status: string;
        truth_status: string;
        revision: number;
        request_sha256: string;
        submission_deadline_at: number;
      }>(
        `
          SELECT count(*) OVER ()::integer AS total,
                 status,
                 truth_status,
                 revision,
                 request_sha256,
                 submission_deadline_at
          FROM order_attempts
          WHERE id = $1
        `,
        [input.plannedAttempt.id],
      );
      expect(stored.rows).toEqual([
        {
          total: 1,
          status: "submitting",
          truth_status: "submission_in_progress",
          revision: 1,
          request_sha256: hashOrderAttemptRequest(input.plannedAttempt.request),
          submission_deadline_at: input.submissionDeadlineAt,
        },
      ]);
    });
  }, 30_000);

  it("reuses canonical JSON proof but rejects a changed request without mutating truth", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const input = await buildStoredRecoverySubmissionInput(pool, "request-proof");
      await expect(claimLiveOrderAttemptForSubmissionAtomically(pool, input)).resolves.toMatchObject({
        decision: "claimed",
      });

      const reorderedInput: LiveOrderAttemptSubmissionInput = {
        ...input,
        plannedAttempt: {
          ...input.plannedAttempt,
          request: {
            clientOrderId: input.plannedAttempt.clientOrderId,
            reduceOnly: false,
            buyMode: null,
            orderType: "IOC",
            maxCostUsd: 4.5,
            price: 0.45,
            size: 10,
            side: "BUY",
            outcome: "NO",
            tokenId: null,
            marketRef: `${input.plannedAttempt.asset}:ticker`,
          },
        },
      };
      await expect(claimLiveOrderAttemptForSubmissionAtomically(pool, reorderedInput)).resolves.toMatchObject({
        decision: "ambiguous",
        reason: "submission_in_progress",
      });

      const changedInput: LiveOrderAttemptSubmissionInput = {
        ...input,
        plannedAttempt: {
          ...input.plannedAttempt,
          request: { ...input.plannedAttempt.request, price: 0.46 },
        },
      };
      await expect(claimLiveOrderAttemptForSubmissionAtomically(pool, changedInput)).rejects.toMatchObject({
        code: "request_proof_mismatch",
        claimAuthorization: "not_granted",
      });
      const stored = await pool.query<{ status: string; truth_status: string; revision: number }>(
        "SELECT status, truth_status, revision FROM order_attempts WHERE id = $1",
        [input.plannedAttempt.id],
      );
      expect(stored.rows).toEqual([{ status: "submitting", truth_status: "submission_in_progress", revision: 1 }]);
    });
  }, 30_000);

  it("returns reusable venue truth instead of authorizing a second submission", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const input = await buildStoredRecoverySubmissionInput(pool, "reusable-venue-order");
      const decision = await claimLiveOrderAttemptForSubmissionAtomically(pool, input);
      expect(decision.decision).toBe("claimed");
      if (decision.decision !== "claimed") {
        throw new Error("Expected a claimed recovery attempt");
      }
      await upsertOrderAttempt(pool, {
        ...decision.attempt,
        venueOrderId: "venue-order-1",
        status: "submitted",
        truthStatus: "venue_acknowledged",
        updatedAt: decision.attempt.updatedAt + 1,
      });

      await expect(claimLiveOrderAttemptForSubmissionAtomically(pool, input)).resolves.toMatchObject({
        decision: "reusable",
        reason: "venue_order_recorded",
        attempt: { venueOrderId: "venue-order-1", status: "submitted" },
      });
    });
  }, 30_000);

  it("rolls a fresh attempt back when the claim transition fails", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const input = await buildStoredRecoverySubmissionInput(pool, "claim-rollback");
      await pool.query(`
        CREATE FUNCTION reject_test_submission_claim()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $test$
        BEGIN
          IF NEW.status = 'submitting' THEN
            RAISE EXCEPTION 'injected claim failure';
          END IF;
          RETURN NEW;
        END;
        $test$;

        CREATE TRIGGER reject_test_submission_claim
        BEFORE UPDATE ON order_attempts
        FOR EACH ROW EXECUTE FUNCTION reject_test_submission_claim();
      `);

      await expect(claimLiveOrderAttemptForSubmissionAtomically(pool, input)).rejects.toThrow(/injected claim failure/);
      const stored = await pool.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM order_attempts WHERE id = $1",
        [input.plannedAttempt.id],
      );
      expect(stored.rows).toEqual([{ total: 0 }]);
    });
  }, 30_000);

  it("rechecks the deadline with the database clock after waiting on the attempt lock", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const now = Date.now();
      const deadline = now + 400;
      const intent = buildIntent({ id: "deadline-lock", mode: "live", status: "primary_filled", now });
      const attempt = buildRecoveryAttempt(intent);
      const input = { plannedAttempt: attempt, submissionDeadlineAt: deadline };
      await insertOrderIntent(pool, intent);
      await upsertOrderAttempt(pool, { ...attempt, submissionDeadlineAt: deadline });

      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT id FROM order_attempts WHERE id = $1 FOR UPDATE", [attempt.id]);
        const claim = claimLiveOrderAttemptForSubmissionAtomically(pool, input);
        await delayUntil(deadline);
        await writer.query("COMMIT");
        await expect(claim).resolves.toMatchObject({
          decision: "rejected",
          reason: "submission_deadline_expired",
          attempt: {
            status: "failed",
            truthStatus: "not_submitted",
            error: "submission_deadline_expired",
            submissionDeadlineAt: deadline,
          },
        });
        await expect(claimLiveOrderAttemptForSubmissionAtomically(pool, input)).resolves.toMatchObject({
          decision: "rejected",
          reason: "submission_deadline_expired",
          attempt: { status: "failed", truthStatus: "not_submitted" },
        });
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
      }

      const stored = await pool.query<{
        status: string;
        truth_status: string;
        error: string;
        revision: number;
        submission_deadline_at: number;
      }>(
        `
          SELECT status, truth_status, error, revision, submission_deadline_at
          FROM order_attempts
          WHERE id = $1
        `,
        [attempt.id],
      );
      expect(stored.rows).toEqual([
        {
          status: "failed",
          truth_status: "not_submitted",
          error: "submission_deadline_expired",
          revision: 1,
          submission_deadline_at: deadline,
        },
      ]);
    });
  }, 30_000);

  it("expires an admitted initial claim at final dispatch without authorizing a venue call", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setStrategyMode(pool, ["btc"], "live");
      const now = Date.now();
      const input = buildLiveInput({
        id: "initial-final-deadline",
        now,
        cutoffAt: now + 1_000,
        latestSubmissionStartAt: now + 300,
      });
      const admission = await admitLiveEntryAtomically(pool, input);
      expect(admission).toMatchObject({ admitted: true });
      const claimed = await claimAdmittedLiveOrderAttemptAtomically(pool, {
        intentId: input.intent.id,
        attemptId: input.plannedAttempt.id,
        request: input.plannedAttempt.request,
        claimedAt: now,
      });
      expect(claimed).toMatchObject({ status: "submitting", revision: 1 });

      await delayUntil(input.latestSubmissionStartAt);
      const placeOrder = vi.fn();
      const decision = await revalidateLiveOrderAttemptBeforeDispatchAtomically(pool, {
        intentId: input.intent.id,
        attemptId: input.plannedAttempt.id,
        request: input.plannedAttempt.request,
        submissionDeadlineAt: input.latestSubmissionStartAt,
        expectedRevision: claimed.revision as number,
      });
      if (decision.decision === "ready") {
        placeOrder();
      }

      expect(decision).toMatchObject({
        decision: "expired",
        reason: "submission_deadline_expired",
        attempt: { status: "failed", truthStatus: "not_submitted", revision: 2 },
      });
      expect(placeOrder).not.toHaveBeenCalled();
    });
  }, 30_000);

  it("expires a recovery claim at final dispatch and fences request, deadline, and revision proof", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const now = Date.now();
      const intent = buildIntent({ id: "recovery-final-deadline", mode: "live", status: "primary_filled", now });
      const attempt = buildRecoveryAttempt(intent);
      const deadline = now + 300;
      await insertOrderIntent(pool, intent);
      const claim = await claimLiveOrderAttemptForSubmissionAtomically(pool, {
        plannedAttempt: attempt,
        submissionDeadlineAt: deadline,
      });
      expect(claim).toMatchObject({ decision: "claimed", attempt: { revision: 1 } });
      if (claim.decision !== "claimed") {
        throw new Error("Expected a claimed recovery attempt");
      }

      await expect(
        revalidateLiveOrderAttemptBeforeDispatchAtomically(pool, {
          intentId: intent.id,
          attemptId: attempt.id,
          request: { ...attempt.request, price: 0.46 },
          submissionDeadlineAt: deadline,
          expectedRevision: claim.attempt.revision as number,
        }),
      ).rejects.toMatchObject({ code: "request_proof_mismatch" });
      await expect(
        revalidateLiveOrderAttemptBeforeDispatchAtomically(pool, {
          intentId: intent.id,
          attemptId: attempt.id,
          request: attempt.request,
          submissionDeadlineAt: deadline + 1,
          expectedRevision: claim.attempt.revision as number,
        }),
      ).rejects.toMatchObject({ code: "submission_deadline_mismatch" });
      await expect(
        revalidateLiveOrderAttemptBeforeDispatchAtomically(pool, {
          intentId: intent.id,
          attemptId: attempt.id,
          request: attempt.request,
          submissionDeadlineAt: deadline,
          expectedRevision: (claim.attempt.revision as number) + 1,
        }),
      ).rejects.toMatchObject({ code: "claim_conflict" });

      await delayUntil(deadline);
      const placeOrder = vi.fn();
      const decision = await revalidateLiveOrderAttemptBeforeDispatchAtomically(pool, {
        intentId: intent.id,
        attemptId: attempt.id,
        request: attempt.request,
        submissionDeadlineAt: deadline,
        expectedRevision: claim.attempt.revision as number,
      });
      if (decision.decision === "ready") {
        placeOrder();
      }
      expect(decision).toMatchObject({
        decision: "expired",
        attempt: { status: "failed", truthStatus: "not_submitted", revision: 2 },
      });
      expect(placeOrder).not.toHaveBeenCalled();
    });
  }, 30_000);

  it("keeps a claimed recovery attempt ready without consuming its dispatch revision", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const input = await buildStoredRecoverySubmissionInput(pool, "recovery-final-ready");
      const claim = await claimLiveOrderAttemptForSubmissionAtomically(pool, input);
      expect(claim.decision).toBe("claimed");
      if (claim.decision !== "claimed") {
        throw new Error("Expected a claimed recovery attempt");
      }

      await expect(
        revalidateLiveOrderAttemptBeforeDispatchAtomically(pool, {
          intentId: input.plannedAttempt.intentId,
          attemptId: input.plannedAttempt.id,
          request: input.plannedAttempt.request,
          submissionDeadlineAt: input.submissionDeadlineAt,
          expectedRevision: claim.attempt.revision as number,
        }),
      ).resolves.toMatchObject({
        decision: "ready",
        attempt: { status: "submitting", truthStatus: "submission_in_progress", revision: 1 },
      });
    });
  }, 30_000);

  it("rejects initial or malformed attempts before creating durable state", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const now = Date.now();
      const intent = buildIntent({ id: "invalid-generic", mode: "live", status: "executing_primary", now });
      await insertOrderIntent(pool, intent);
      const attempt = buildAttempt(intent);

      await expect(
        claimLiveOrderAttemptForSubmissionAtomically(pool, {
          plannedAttempt: attempt,
          submissionDeadlineAt: now + 10_000,
        }),
      ).rejects.toMatchObject({
        code: "initial_attempt_requires_admission",
        claimAuthorization: "not_granted",
      });
      const stored = await pool.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM order_attempts WHERE id = $1",
        [attempt.id],
      );
      expect(stored.rows).toEqual([{ total: 0 }]);
    });
  }, 30_000);

  it("rejects a live attempt attached to a shadow parent intent", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const now = Date.now();
      const intent = buildIntent({ id: "shadow-parent", mode: "shadow", status: "primary_filled", now });
      const attempt = buildRecoveryAttempt({ ...intent, shadow: false });
      await insertOrderIntent(pool, intent);

      await expect(
        claimLiveOrderAttemptForSubmissionAtomically(pool, {
          plannedAttempt: attempt,
          submissionDeadlineAt: now + 10_000,
        }),
      ).rejects.toMatchObject({
        code: "invalid_planned_attempt",
        claimAuthorization: "not_granted",
      });
      const stored = await pool.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM order_attempts WHERE id = $1",
        [attempt.id],
      );
      expect(stored.rows).toEqual([{ total: 0 }]);
    });
  }, 30_000);

  it("authorizes only the explicit recovery stage and parent-status matrix", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const now = Date.now();
      const cases: Array<{
        id: string;
        status: OrderIntent["status"];
        stage: string;
        legRole: "primary" | "hedge";
      }> = [
        { id: "matrix-hedge", status: "primary_filled", stage: "hedge", legRole: "hedge" },
        { id: "matrix-retry", status: "hedging", stage: "hedge_retry:1", legRole: "hedge" },
        { id: "matrix-rescue", status: "rescue_hedge", stage: "hedge_rescue:2", legRole: "hedge" },
        { id: "matrix-unwind", status: "unwind_required", stage: "primary_unwind:1", legRole: "primary" },
        {
          id: "matrix-forced-unwind",
          status: "rescue_hedge",
          stage: "primary_unwind_forced:3",
          legRole: "primary",
        },
      ];

      for (const candidate of cases) {
        const intent = buildIntent({ id: candidate.id, mode: "live", status: candidate.status, now });
        const attempt = buildStageAttempt(intent, candidate.stage, candidate.legRole);
        await insertOrderIntent(pool, intent);
        await expect(
          claimLiveOrderAttemptForSubmissionAtomically(pool, {
            plannedAttempt: attempt,
            submissionDeadlineAt: now + 10_000,
          }),
        ).resolves.toMatchObject({ decision: "claimed", attempt: { stage: candidate.stage } });
      }
    });
  }, 30_000);

  it("rejects unknown stages, wrong parent states, legs, sides, and reduce-only identity", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const now = Date.now();
      const baseIntent = buildIntent({ id: "invalid-stage-matrix", mode: "live", status: "primary_filled", now });
      await insertOrderIntent(pool, baseIntent);
      const baseAttempt = buildStageAttempt(baseIntent, "hedge", "hedge");
      const invalidAttempts: OrderAttempt[] = [
        {
          ...baseAttempt,
          id: `${baseAttempt.id}:unknown`,
          stage: "incremental_hedge:1",
          clientOrderId: `${baseAttempt.clientOrderId}:unknown`,
          request: {
            ...baseAttempt.request,
            clientOrderId: `${baseAttempt.clientOrderId}:unknown`,
          },
        },
        {
          ...baseAttempt,
          id: `${baseAttempt.id}:leg`,
          legId: `${baseIntent.id}:polymarket`,
          clientOrderId: `${baseAttempt.clientOrderId}:leg`,
          request: {
            ...baseAttempt.request,
            clientOrderId: `${baseAttempt.clientOrderId}:leg`,
          },
        },
        {
          ...baseAttempt,
          id: `${baseAttempt.id}:side`,
          side: "SELL",
          clientOrderId: `${baseAttempt.clientOrderId}:side`,
          request: {
            ...baseAttempt.request,
            side: "SELL",
            clientOrderId: `${baseAttempt.clientOrderId}:side`,
          },
        },
        {
          ...baseAttempt,
          id: `${baseAttempt.id}:reduce-only`,
          clientOrderId: `${baseAttempt.clientOrderId}:reduce-only`,
          request: {
            ...baseAttempt.request,
            reduceOnly: true,
            clientOrderId: `${baseAttempt.clientOrderId}:reduce-only`,
          },
        },
        {
          ...baseAttempt,
          id: `${baseAttempt.id}:market-ref`,
          clientOrderId: `${baseAttempt.clientOrderId}:market-ref`,
          request: omitRequestField(
            { ...baseAttempt.request, clientOrderId: `${baseAttempt.clientOrderId}:market-ref` },
            "marketRef",
          ),
        },
        {
          ...baseAttempt,
          id: `${baseAttempt.id}:outcome`,
          clientOrderId: `${baseAttempt.clientOrderId}:outcome`,
          request: omitRequestField(
            { ...baseAttempt.request, clientOrderId: `${baseAttempt.clientOrderId}:outcome` },
            "outcome",
          ),
        },
        {
          ...baseAttempt,
          id: `${baseAttempt.id}:order-type`,
          clientOrderId: `${baseAttempt.clientOrderId}:order-type`,
          request: omitRequestField(
            { ...baseAttempt.request, clientOrderId: `${baseAttempt.clientOrderId}:order-type` },
            "orderType",
          ),
        },
        {
          ...baseAttempt,
          id: `${baseAttempt.id}:request-client-id`,
          clientOrderId: `${baseAttempt.clientOrderId}:request-client-id`,
          request: omitRequestField(baseAttempt.request, "clientOrderId"),
        },
      ];

      for (const attempt of invalidAttempts) {
        await expect(
          claimLiveOrderAttemptForSubmissionAtomically(pool, {
            plannedAttempt: attempt,
            submissionDeadlineAt: now + 10_000,
          }),
        ).rejects.toMatchObject({ code: "invalid_planned_attempt", claimAuthorization: "not_granted" });
      }

      const wrongStatusIntent = buildIntent({
        id: "invalid-parent-status",
        mode: "live",
        status: "hedging",
        now,
      });
      await insertOrderIntent(pool, wrongStatusIntent);
      await expect(
        claimLiveOrderAttemptForSubmissionAtomically(pool, {
          plannedAttempt: buildStageAttempt(wrongStatusIntent, "hedge", "hedge"),
          submissionDeadlineAt: now + 10_000,
        }),
      ).rejects.toMatchObject({ code: "invalid_planned_attempt", claimAuthorization: "not_granted" });

      const stored = await pool.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM order_attempts WHERE intent_id IN ($1, $2)",
        [baseIntent.id, wrongStatusIntent.id],
      );
      expect(stored.rows).toEqual([{ total: 0 }]);
    });
  }, 30_000);

  it("lets a terminal transition win before a claim without creating an attempt", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const now = Date.now();
      const intent = buildIntent({ id: "terminal-first", mode: "live", status: "primary_filled", now });
      const input = {
        plannedAttempt: buildStageAttempt(intent, "hedge", "hedge"),
        submissionDeadlineAt: now + 10_000,
      };
      await insertOrderIntent(pool, intent);

      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT id FROM order_intents WHERE id = $1 FOR UPDATE", [intent.id]);
        const claim = claimLiveOrderAttemptForSubmissionAtomically(pool, input);
        await delay(50);
        await writer.query("UPDATE order_intents SET status = 'hedged' WHERE id = $1", [intent.id]);
        await writer.query("COMMIT");
        await expect(claim).rejects.toMatchObject({
          code: "invalid_planned_attempt",
          claimAuthorization: "not_granted",
        });
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
      }

      const stored = await pool.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM order_attempts WHERE intent_id = $1",
        [intent.id],
      );
      expect(stored.rows).toEqual([{ total: 0 }]);
    });
  }, 30_000);

  it("lets a claimed submission win before terminalization and preserves the open parent", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const input = await buildStoredRecoverySubmissionInput(pool, "claim-first");
      await expect(claimLiveOrderAttemptForSubmissionAtomically(pool, input)).resolves.toMatchObject({
        decision: "claimed",
      });

      await expect(
        pool.query("UPDATE order_intents SET status = 'hedged' WHERE id = $1", [input.plannedAttempt.intentId]),
      ).rejects.toThrow(/order submission truth is unresolved/);
      const intent = await pool.query<{ status: string }>("SELECT status FROM order_intents WHERE id = $1", [
        input.plannedAttempt.intentId,
      ]);
      expect(intent.rows).toEqual([{ status: "primary_filled" }]);
    });
  }, 30_000);
});

function isAdmitted(decision: EntryAdmissionDecision): decision is Extract<EntryAdmissionDecision, { admitted: true }> {
  return decision.admitted;
}

function buildTestBreakerIncident(input: {
  id: string;
  scope: CircuitBreakerIncident["scope"];
  triggeredAt: number;
}): CircuitBreakerIncident {
  return {
    id: input.id,
    scope: input.scope,
    owner: "integration-test",
    incidentKey: input.id,
    reason: "manual",
    impact: "blocked",
    resolutionPolicy: "owner",
    intentId: null,
    exposure: { state: "none" },
    revision: 1,
    timestamps: {
      triggeredAt: input.triggeredAt,
      updatedAt: input.triggeredAt,
      lastObservedAt: input.triggeredAt,
      cooldownUntil: null,
      acknowledgedAt: null,
      resolvedAt: null,
    },
    payload: { source: "integration-test" },
  };
}

function buildLiveInput(overrides: {
  id: string;
  asset?: MarketAsset;
  grossCost?: number;
  now?: number;
  slotStartTs?: number;
  slotEndTs?: number;
  cutoffAt?: number;
  latestSubmissionStartAt?: number;
}): LiveEntryAdmissionInput {
  const now = overrides.now ?? DEFAULT_TEST_NOW;
  const slotStartTs = overrides.slotStartTs ?? now - 60_000;
  const slotEndTs = overrides.slotEndTs ?? now + DEFAULT_TEST_SLOT_DURATION_MS;
  const cutoffAt = overrides.cutoffAt ?? slotEndTs;
  const latestSubmissionStartAt = overrides.latestSubmissionStartAt ?? cutoffAt - 30_000;
  const intent = buildIntent({
    ...overrides,
    now,
    slotStartTs,
    slotEndTs,
    mode: "live",
    status: "executing_primary",
  });
  return {
    now,
    intent,
    plannedAttempt: buildAttempt(intent),
    expectedStrategyRevision: 0,
    expectedGlobalRiskRevision: 0,
    policyEvaluatedAt: now - 1,
    cutoffAt,
    latestSubmissionStartAt,
    evidence: { source: "integration", books: { polymarket: now - 5, kalshi: now - 4 } },
  };
}

function buildShadowInput(overrides: {
  id: string;
  asset?: MarketAsset;
  grossCost?: number;
  now?: number;
  slotStartTs?: number;
  slotEndTs?: number;
}): ShadowEntryAdmissionInput {
  const now = overrides.now ?? DEFAULT_TEST_NOW;
  const slotStartTs = overrides.slotStartTs ?? now - 60_000;
  const slotEndTs = overrides.slotEndTs ?? now + DEFAULT_TEST_SLOT_DURATION_MS;
  return {
    now,
    intent: buildIntent({ ...overrides, now, slotStartTs, slotEndTs, mode: "shadow", status: "pending" }),
    expectedStrategyRevision: 0,
    expectedGlobalRiskRevision: 0,
    policyEvaluatedAt: now - 1,
    evidence: { source: "integration", books: { polymarket: now - 5, kalshi: now - 4 } },
  };
}

function buildIntent(input: {
  id: string;
  asset?: MarketAsset;
  mode: "live" | "shadow";
  grossCost?: number;
  status: OrderIntent["status"];
  now?: number;
  slotStartTs?: number;
  slotEndTs?: number;
}): OrderIntent {
  const now = input.now ?? DEFAULT_TEST_NOW;
  const asset = input.asset ?? "btc";
  const polymarketLegId = `${input.id}:polymarket`;
  const kalshiLegId = `${input.id}:kalshi`;
  return {
    id: input.id,
    revision: 0,
    asset,
    shadow: input.mode === "shadow",
    slotKey: `${asset}:slot`,
    slotStartTs: input.slotStartTs ?? now - 60_000,
    slotEndTs: input.slotEndTs ?? now + DEFAULT_TEST_SLOT_DURATION_MS,
    combination: "POLY_UP_KALSHI_NO",
    status: input.status,
    createdAt: now - 10,
    updatedAt: now - 10,
    resolvedAt: null,
    primaryVenue: "polymarket",
    hedgeVenue: "kalshi",
    grossCost: input.grossCost ?? 0.9,
    targetNotionalUsd: 9,
    entrySizingReason: null,
    maxSlippageBps: 30,
    failureReason: null,
    projectedNetProfitUsd: 1,
    mismatchPFatal: null,
    mismatchPFatalUpper: null,
    mismatchModelVersion: null,
    fatalMismatchPnlUsd: null,
    conservativeExpectedPnlUsd: null,
    fatalLossExposureUsd: null,
    mismatchRiskAudit: null,
    shadowExecution: null,
    realizedPnlUsd: null,
    roi: null,
    polyResolution: null,
    kalshiResolution: null,
    legs: [
      {
        id: polymarketLegId,
        intentId: input.id,
        venue: "polymarket",
        outcome: "UP",
        marketRef: `${asset}:condition`,
        tokenId: `${asset}:token-up`,
        side: "BUY",
        requestedPrice: 0.45,
        requestedSize: 10,
        requestedNotionalUsd: 4.5,
        filledPrice: null,
        filledSize: 0,
        feeUsd: 0,
        status: "pending",
        venueOrderId: null,
        payoutUsd: null,
        resolvedOutcome: null,
      },
      {
        id: kalshiLegId,
        intentId: input.id,
        venue: "kalshi",
        outcome: "NO",
        marketRef: `${asset}:ticker`,
        side: "BUY",
        requestedPrice: 0.45,
        requestedSize: 10,
        requestedNotionalUsd: 4.5,
        filledPrice: null,
        filledSize: 0,
        feeUsd: 0,
        status: "pending",
        venueOrderId: null,
        payoutUsd: null,
        resolvedOutcome: null,
      },
    ],
  };
}

function buildAttempt(intent: OrderIntent): OrderAttempt {
  return {
    id: `${intent.id}:attempt`,
    asset: intent.asset,
    shadow: false,
    intentId: intent.id,
    legId: `${intent.id}:polymarket`,
    stage: "primary",
    venue: "polymarket",
    side: "BUY",
    orderType: "FOK",
    clientOrderId: `${intent.id}:client`,
    venueOrderId: null,
    status: "planned",
    truthStatus: "admitted_not_claimed",
    request: {
      price: 0.45,
      size: 10,
      nested: { tick: 0.01, tif: "FOK" },
    },
    result: null,
    error: null,
    createdAt: intent.updatedAt + 5,
    updatedAt: intent.updatedAt + 5,
  };
}

function omitRequestField(request: Record<string, unknown>, field: string) {
  return Object.fromEntries(Object.entries(request).filter(([key]) => key !== field));
}

function buildRecoveryAttempt(intent: OrderIntent): OrderAttempt {
  return buildStageAttempt(intent, "hedge", "hedge");
}

function buildStageAttempt(intent: OrderIntent, stage: string, legRole: "primary" | "hedge"): OrderAttempt {
  const leg = intent.legs.find((candidate) =>
    legRole === "primary" ? candidate.venue === intent.primaryVenue : candidate.venue === intent.hedgeVenue,
  );
  if (!leg) {
    throw new Error(`Missing ${legRole} leg for ${intent.id}`);
  }
  const side = legRole === "primary" ? "SELL" : "BUY";
  const reduceOnly = legRole === "primary";
  const orderType = legRole === "primary" ? "FAK" : "IOC";
  const clientOrderId = `${intent.id}:${stage}:client`;
  return {
    id: `${intent.id}:${stage}:attempt`,
    asset: intent.asset,
    shadow: false,
    intentId: intent.id,
    legId: leg.id,
    stage,
    venue: leg.venue,
    side,
    orderType,
    clientOrderId,
    venueOrderId: null,
    status: "planned",
    truthStatus: "not_submitted",
    request: {
      marketRef: leg.marketRef,
      tokenId: leg.tokenId ?? null,
      outcome: leg.outcome,
      side,
      size: 10,
      price: 0.45,
      maxCostUsd: 4.5,
      orderType,
      buyMode: null,
      reduceOnly,
      clientOrderId,
    },
    result: null,
    error: null,
    createdAt: intent.updatedAt + 5,
    updatedAt: intent.updatedAt + 5,
  };
}

async function buildStoredRecoverySubmissionInput(pool: Pool, id: string): Promise<LiveOrderAttemptSubmissionInput> {
  const now = Date.now();
  const intent = buildIntent({ id, mode: "live", status: "primary_filled", now });
  await insertOrderIntent(pool, intent);
  return {
    plannedAttempt: buildRecoveryAttempt(intent),
    submissionDeadlineAt: now + 10_000,
  };
}

async function setStrategyMode(pool: Pool, assets: MarketAsset[], mode: "live" | "shadow") {
  await pool.query(
    `
      UPDATE strategy_configs
      SET payload = payload || $2::jsonb
      WHERE asset = ANY($1::text[])
    `,
    [assets, JSON.stringify({ enableTrading: true, shadowMode: mode === "shadow" })],
  );
}

async function expireShadowCooldown(pool: Pool, intentId: string) {
  await pool.query(
    `
      UPDATE order_intents
      SET shadow_execution_json = jsonb_build_object('nextEligibleAt', 0)
      WHERE id = $1
    `,
    [intentId],
  );
}

async function admissionCounts(pool: Pool) {
  const result = await pool.query<{ intents: number; attempts: number; admissions: number }>(`
    SELECT
      (SELECT count(*)::integer FROM order_intents) AS intents,
      (SELECT count(*)::integer FROM order_attempts) AS attempts,
      (SELECT count(*)::integer FROM entry_admissions) AS admissions
  `);
  return result.rows[0];
}

async function expectAttemptToRemainUnclaimed(pool: Pool, attemptId: string) {
  const stored = await pool.query<{ status: string; truth_status: string; revision: number }>(
    "SELECT status, truth_status, revision FROM order_attempts WHERE id = $1",
    [attemptId],
  );
  expect(stored.rows).toEqual([{ status: "planned", truth_status: "admitted_not_claimed", revision: 0 }]);
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function delayUntil(timestamp: number) {
  await delay(Math.max(0, timestamp - Date.now() + 50));
}

async function withIsolatedSchema(run: (pool: Pool) => Promise<void>) {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const schema = `warbitrer_entry_admission_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 5,
    options: `-c search_path=${schema}`,
  });

  try {
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
