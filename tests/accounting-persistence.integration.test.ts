import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type { AccountingLedgerInput } from "@/lib/accounting-ledger";
import { DEFAULT_DATABASE_MAINTENANCE_CONFIG } from "@/lib/db-maintenance";
import { runDatabaseMigrations } from "@/lib/db-migrations";
import {
  AccountingPersistenceError,
  acquireAccountingTransactionLock,
  admitLiveEntryAtomically,
  claimAdmittedLiveOrderAttemptAtomically,
  claimLiveOrderAttemptForSubmissionAtomically,
  closeIntentWithoutExposureAtomically,
  DATABASE_MIGRATIONS,
  finalizeIntentAccountingAtomically,
  getAccountingHead,
  getLiveAccountingBacklog,
  ingestVenueFillAtomically,
  insertOrderIntent,
  listAccountingFillEvidenceForIntent,
  listStableAccountingProjectionBacklog,
  migratePostgresDatabase,
  reaccountIntentAtomically,
  revalidateLiveOrderAttemptBeforeDispatchAtomically,
  runDatabaseMaintenance,
  sumAllTimeAccountingLedger,
  sumAccountingRealizedPnlForUtcDay,
  upsertLegacyFillProjection,
} from "@/lib/postgres-db";
import type { LiveEntryAdmissionInput, LiveFill, LiveOrder, OrderAttempt, OrderIntent } from "@/lib/types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres("Postgres accounting persistence", () => {
  it("backfills historical heads as legacy_pending and blocks a new live admission", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const historical = buildIntent("legacy-accounting", "failed");
      await insertOrderIntent(pool, historical);
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS);

      await expect(getAccountingHead(pool, historical.id)).resolves.toMatchObject({
        state: "legacy_pending",
        revision: 0,
      });
      await expect(getLiveAccountingBacklog(pool)).resolves.toEqual({
        total: 1,
        missingHeads: 0,
        legacyPending: 1,
        quarantined: 0,
        terminalOpen: 0,
        historicalLegacyPending: 0,
        oldestIntentId: historical.id,
      });

      await setLiveStrategy(pool);
      const admission = buildLiveAdmission("blocked-by-accounting");
      await expect(admitLiveEntryAtomically(pool, admission)).resolves.toMatchObject({
        admitted: false,
        code: "circuit_breaker_active",
        reason: expect.stringContaining("accounting backlog"),
      });
      const stored = await pool.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM order_intents WHERE id = $1",
        [admission.intent.id],
      );
      expect(stored.rows).toEqual([{ total: 0 }]);
    });
  }, 30_000);

  it("keeps prior-day terminal migration debt visible without contaminating a new UTC risk day", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const dayStart = utcDayStart(Date.now());
      const historical = buildIntent("legacy-prior-day", "failed");
      historical.slotStartTs = dayStart - 30 * 60_000;
      historical.slotEndTs = dayStart - 15 * 60_000;
      historical.createdAt = historical.slotStartTs + 10;
      historical.updatedAt = dayStart - 1_000;
      historical.resolvedAt = dayStart - 1_000;
      await insertOrderIntent(pool, historical);
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS);

      await expect(getLiveAccountingBacklog(pool)).resolves.toEqual({
        total: 0,
        missingHeads: 0,
        legacyPending: 0,
        quarantined: 0,
        terminalOpen: 0,
        historicalLegacyPending: 1,
        oldestIntentId: null,
      });
      await setLiveStrategy(pool);
      await expect(admitLiveEntryAtomically(pool, buildLiveAdmission("new-utc-risk-day"))).resolves.toMatchObject({
        admitted: true,
      });
    });
  }, 30_000);

  it("protects mandatory accounting heads and blocks live entry if one is missing", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const intent = buildIntent("accounting-missing-head", "failed");
      await insertFixtureParent(pool, intent);

      await expect(pool.query("DELETE FROM accounting_heads WHERE intent_id = $1", [intent.id])).rejects.toThrow(
        /accounting heads cannot be deleted/,
      );

      await pool.query("ALTER TABLE accounting_heads DISABLE TRIGGER accounting_heads_delete_guard");
      try {
        await pool.query("DELETE FROM accounting_heads WHERE intent_id = $1", [intent.id]);
      } finally {
        await pool.query("ALTER TABLE accounting_heads ENABLE TRIGGER accounting_heads_delete_guard");
      }

      await expect(getLiveAccountingBacklog(pool)).resolves.toEqual({
        total: 1,
        missingHeads: 1,
        legacyPending: 0,
        quarantined: 0,
        terminalOpen: 0,
        historicalLegacyPending: 0,
        oldestIntentId: intent.id,
      });
      await setLiveStrategy(pool);
      await expect(
        admitLiveEntryAtomically(pool, buildLiveAdmission("blocked-by-missing-head")),
      ).resolves.toMatchObject({
        admitted: false,
        code: "circuit_breaker_active",
        reason: expect.stringContaining("1 missing heads"),
      });
    });

    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 7));
      const intent = buildIntent("accounting-missing-head-migration", "failed");
      await insertFixtureParent(pool, intent);
      await pool.query("DELETE FROM accounting_heads WHERE intent_id = $1", [intent.id]);
      await expect(runDatabaseMigrations(pool, DATABASE_MIGRATIONS)).rejects.toThrow(
        /order intents are missing mandatory accounting heads/,
      );
    });
  }, 30_000);

  it("refuses a terminal parent commit without matching accounting and exposes the gap before rollback", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const fixture = buildSettledFixture("terminal-accounting-guard");
      await insertFixtureParent(pool, fixture.intent);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `
            UPDATE order_intents
            SET status = 'settled', resolved_at = $2, updated_at = $2, revision = revision + 1
            WHERE id = $1
          `,
          [fixture.intent.id, fixture.intent.resolvedAt],
        );
        await expect(getLiveAccountingBacklog(client)).resolves.toMatchObject({
          total: 1,
          terminalOpen: 1,
          oldestIntentId: fixture.intent.id,
        });
        await expect(client.query("COMMIT")).rejects.toThrow(/requires accounting head stable/);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      const parent = await pool.query<{ status: string; revision: number }>(
        "SELECT status, revision FROM order_intents WHERE id = $1",
        [fixture.intent.id],
      );
      expect(parent.rows).toEqual([{ status: "hedged", revision: 0 }]);
      await expect(getAccountingHead(pool, fixture.intent.id)).resolves.toMatchObject({ state: "open", revision: 0 });
    });
  }, 30_000);

  it("finalizes exactly once, replays the request, and publishes exact UTC daily P&L", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const fixture = buildSettledFixture("accounting-finalize");
      await insertFixtureParent(pool, fixture.intent);
      await ingestFixtureFills(pool, fixture);

      const requestId = randomUUID();
      const input = {
        context: context(requestId, fixture.now),
        expectedHeadRevision: 0,
        expectedIntentRevision: 0,
        terminalIntent: fixture.intent,
        ledgerInput: fixture.ledger,
        stability: { venueTruth: "final", observationCount: 3 },
      };
      const first = await finalizeIntentAccountingAtomically(pool, input);
      expect(first).toMatchObject({ replayed: false, version: 1, head: { state: "stable", revision: 1 } });
      await expect(finalizeIntentAccountingAtomically(pool, input)).resolves.toMatchObject({
        replayed: true,
        version: 1,
        head: { state: "stable", revision: 1 },
      });
      await expect(
        finalizeIntentAccountingAtomically(pool, {
          ...input,
          stability: { venueTruth: "changed" },
        }),
      ).rejects.toMatchObject({ code: "request_conflict" });

      const dayStart = utcDayStart(fixture.intent.resolvedAt!);
      await expect(sumAccountingRealizedPnlForUtcDay(pool, dayStart)).resolves.toEqual({
        units: "98000000",
        usd: 0.98,
        entries: 1,
      });
      await expect(sumAllTimeAccountingLedger(pool)).resolves.toEqual({
        realizedPnlUnits: "98000000",
        feeUnits: "2000000",
        realizedPnlUsd: 0.98,
        feesUsd: 0.02,
        entries: 1,
      });
      await expect(listStableAccountingProjectionBacklog(pool)).resolves.toMatchObject([
        { accountingVersion: 1, proofSha256: first.proofSha256, intent: { id: fixture.intent.id } },
      ]);
      await insertMatchingStablePnlChange(pool, fixture.intent.id);
      await expect(listStableAccountingProjectionBacklog(pool)).resolves.toEqual([]);
      const version = await pool.query<{
        realized_pnl_units: string;
        cost_basis_units: string;
        fee_units: string;
      }>(
        `
          SELECT realized_pnl_units::text, cost_basis_units::text, fee_units::text
          FROM accounting_versions WHERE intent_id = $1 AND version = 1
        `,
        [fixture.intent.id],
      );
      expect(version.rows).toEqual([
        { realized_pnl_units: "98000000", cost_basis_units: "900000000", fee_units: "2000000" },
      ]);
      const committed = await pool.query<{
        status: string;
        revision: number;
        realized_pnl_usd: number;
        settlements: number;
      }>(
        `
          SELECT intent.status, intent.revision, intent.realized_pnl_usd,
            (SELECT count(*)::integer FROM settlements WHERE intent_id = intent.id) AS settlements
          FROM order_intents AS intent
          WHERE intent.id = $1
        `,
        [fixture.intent.id],
      );
      expect(committed.rows).toEqual([{ status: "settled", revision: 1, realized_pnl_usd: 0.98, settlements: 2 }]);
      await expect(
        pool.query("UPDATE order_intents SET realized_pnl_usd = 99, revision = revision + 1 WHERE id = $1", [
          fixture.intent.id,
        ]),
      ).rejects.toThrow(/projection does not match its exact accounting version/);
      await expect(
        pool.query("UPDATE order_intents SET poly_resolution = 'DOWN' WHERE id = $1", [fixture.intent.id]),
      ).rejects.toThrow(/contradicts its exact parent projection/);
      await expect(
        pool.query(
          `
            UPDATE order_intents
            SET legs_json = jsonb_set(legs_json, '{0,payoutUsd}', '9.5'::jsonb)
            WHERE id = $1
          `,
          [fixture.intent.id],
        ),
      ).rejects.toThrow(/contradicts its exact parent projection/);
      const unchanged = await pool.query<{ revision: number; realized_pnl_usd: number }>(
        "SELECT revision, realized_pnl_usd FROM order_intents WHERE id = $1",
        [fixture.intent.id],
      );
      expect(unchanged.rows).toEqual([{ revision: 1, realized_pnl_usd: 0.98 }]);
    });
  }, 30_000);

  it("promotes provisional fill evidence immutably and refuses accounting until every fill is final", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const fixture = buildSettledFixture("accounting-finality-promotion");
      await insertFixtureParent(pool, fixture.intent);
      const provisional = fixture.fills[1];
      const finalFill = { ...provisional.fill, feeUsd: 0.013 };
      const finalizedLedger = {
        ...fixture.ledger,
        fills: fixture.ledger.fills.map((fill) =>
          fill.id === finalFill.id ? { ...fill, feeUsd: finalFill.feeUsd } : fill,
        ),
      };
      const first = await ingestVenueFillAtomically(pool, {
        context: context(randomUUID(), fixture.now),
        expectedHeadRevision: 0,
        legId: provisional.legId,
        finality: "non_final",
        fill: provisional.fill,
      });
      expect(first.decision).toBe("recorded");
      if (!("factSha256" in first)) {
        throw new Error("Expected provisional fill evidence to be recorded");
      }
      await ingestVenueFillAtomically(pool, {
        context: context(randomUUID(), fixture.now),
        expectedHeadRevision: 0,
        legId: fixture.fills[0].legId,
        finality: "final",
        fill: fixture.fills[0].fill,
      });

      await expect(
        finalizeIntentAccountingAtomically(pool, {
          context: context(randomUUID(), fixture.now),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: fixture.intent,
          ledgerInput: fixture.ledger,
          stability: { source: "premature-finalization" },
        }),
      ).rejects.toMatchObject({ code: "state_conflict" });

      const promoted = await ingestVenueFillAtomically(pool, {
        context: context(randomUUID(), fixture.now + 1),
        expectedHeadRevision: 0,
        legId: provisional.legId,
        finality: "final",
        fill: finalFill,
      });
      expect(promoted).toMatchObject({ decision: "recorded", factSha256: first.factSha256 });
      const listed = await listAccountingFillEvidenceForIntent(pool, fixture.intent.id);
      expect(listed.map(({ id, legId, finality }) => ({ id, legId, finality }))).toEqual(
        fixture.ledger.fills
          .map(({ id, legId, finality }) => ({ id, legId, finality }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      );
      expect(listed.find((fill) => fill.id === provisional.fill.id)).toMatchObject({
        price: provisional.fill.price,
        size: provisional.fill.size,
        feeUsd: finalFill.feeUsd,
      });

      const legacyFill = await pool.query<{ fee_usd: number }>("SELECT fee_usd FROM fills WHERE id = $1", [
        provisional.fill.id,
      ]);
      expect(legacyFill.rows).toEqual([{ fee_usd: provisional.fill.feeUsd }]);

      const immutable = await pool.query<{
        initial_finality: string;
        initial_fee_units: string;
        observations: number;
        previous_finality: string;
        observed_finality: string;
        observed_fee_units: string;
      }>(
        `
          SELECT
            fact.finality AS initial_finality,
            fact.fee_units::text AS initial_fee_units,
            count(observation.id)::integer AS observations,
            max(observation.previous_finality) AS previous_finality,
            max(observation.observed_finality) AS observed_finality,
            max(observation.observed_fee_units)::text AS observed_fee_units
          FROM accounting_fill_facts AS fact
          LEFT JOIN accounting_fill_finality_observations AS observation
            ON observation.fill_id = fact.fill_id
          WHERE fact.fill_id = $1
          GROUP BY fact.finality, fact.fee_units
        `,
        [provisional.fill.id],
      );
      expect(immutable.rows).toEqual([
        {
          initial_finality: "non_final",
          initial_fee_units: "1000000",
          observations: 1,
          previous_finality: "non_final",
          observed_finality: "final",
          observed_fee_units: "1300000",
        },
      ]);
      await expect(
        pool.query("UPDATE accounting_fill_finality_observations SET observed_finality = 'final' WHERE fill_id = $1", [
          provisional.fill.id,
        ]),
      ).rejects.toThrow(/append-only/);

      await expect(
        finalizeIntentAccountingAtomically(pool, {
          context: context(randomUUID(), fixture.now + 1),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: fixture.intent,
          ledgerInput: finalizedLedger,
          stability: { source: "promoted-finalization" },
        }),
      ).resolves.toMatchObject({ version: 1, head: { state: "stable" } });
    });
  }, 30_000);

  it("quarantines changed economics and rejects a projection that omits durable fill evidence", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const fixture = buildSettledFixture("accounting-finality-conflict");
      await insertFixtureParent(pool, fixture.intent);
      const evidence = fixture.fills[0];
      await ingestVenueFillAtomically(pool, {
        context: context(randomUUID(), fixture.now),
        expectedHeadRevision: 0,
        legId: evidence.legId,
        finality: "ambiguous",
        fill: evidence.fill,
      });
      await expect(
        ingestVenueFillAtomically(pool, {
          context: context(randomUUID(), fixture.now + 1),
          expectedHeadRevision: 0,
          legId: evidence.legId,
          finality: "final",
          fill: { ...evidence.fill, price: evidence.fill.price + 0.01 },
        }),
      ).resolves.toMatchObject({ decision: "quarantined", reason: "fill_economic_conflict" });
      await expect(
        finalizeIntentAccountingAtomically(pool, {
          context: context(randomUUID(), fixture.now + 2),
          expectedHeadRevision: 1,
          expectedIntentRevision: 0,
          terminalIntent: fixture.intent,
          ledgerInput: fixture.ledger,
          stability: { source: "conflicting-quarantine-must-not-recover" },
        }),
      ).rejects.toMatchObject({ code: "state_conflict" });
      const observations = await pool.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM accounting_fill_finality_observations",
      );
      expect(observations.rows).toEqual([{ total: 0 }]);
    });

    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const fixture = buildSettledFixture("accounting-fill-omission");
      await insertFixtureParent(pool, fixture.intent);
      await ingestFixtureFills(pool, fixture);
      const extraFill: LiveFill = {
        ...fixture.fills[0].fill,
        id: `${fixture.intent.id}:extra-fill`,
        venueOrderId: `${fixture.intent.id}:extra-order`,
        tradeId: `${fixture.intent.id}:extra-trade`,
        size: 1,
        filledAt: fixture.now - 250,
      };
      await ingestVenueFillAtomically(pool, {
        context: context(randomUUID(), fixture.now),
        expectedHeadRevision: 0,
        legId: fixture.fills[0].legId,
        finality: "final",
        fill: extraFill,
      });

      await expect(
        finalizeIntentAccountingAtomically(pool, {
          context: context(randomUUID(), fixture.now),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: fixture.intent,
          ledgerInput: fixture.ledger,
          stability: { source: "omitted-fill" },
        }),
      ).rejects.toMatchObject({ code: "identity_conflict" });
      const counts = await pool.query<{ versions: number; settlements: number }>(`
        SELECT
          (SELECT count(*)::integer FROM accounting_versions) AS versions,
          (SELECT count(*)::integer FROM accounting_settlement_facts) AS settlements
      `);
      expect(counts.rows).toEqual([{ versions: 0, settlements: 0 }]);
    });
  }, 30_000);

  it("serializes concurrent finalization and rolls every accounting write back on a ledger failure", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const fixture = buildSettledFixture("accounting-concurrent");
      await insertFixtureParent(pool, fixture.intent);
      await ingestFixtureFills(pool, fixture);

      const attempts = await Promise.allSettled([
        finalizeIntentAccountingAtomically(pool, {
          context: context(randomUUID(), fixture.now),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: fixture.intent,
          ledgerInput: fixture.ledger,
          stability: { source: "first" },
        }),
        finalizeIntentAccountingAtomically(pool, {
          context: context(randomUUID(), fixture.now),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: fixture.intent,
          ledgerInput: fixture.ledger,
          stability: { source: "second" },
        }),
      ]);
      expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = attempts.find((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(rejected?.reason).toBeInstanceOf(AccountingPersistenceError);
      expect(rejected?.reason).toMatchObject({ code: "revision_conflict" });
      const counts = await pool.query<{ versions: number; ledger: number }>(`
        SELECT
          (SELECT count(*)::integer FROM accounting_versions) AS versions,
          (SELECT count(*)::integer FROM accounting_realized_pnl_ledger) AS ledger
      `);
      expect(counts.rows).toEqual([{ versions: 1, ledger: 1 }]);
    });

    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const fixture = buildSettledFixture("accounting-rollback");
      await insertFixtureParent(pool, fixture.intent);
      await ingestFixtureFills(pool, fixture);
      await pool.query(`
        CREATE FUNCTION fail_accounting_ledger_insert()
        RETURNS trigger LANGUAGE plpgsql AS $test$
        BEGIN
          RAISE EXCEPTION 'injected accounting ledger failure';
        END;
        $test$;
        CREATE TRIGGER fail_accounting_ledger_insert
        BEFORE INSERT ON accounting_realized_pnl_ledger
        FOR EACH ROW EXECUTE FUNCTION fail_accounting_ledger_insert();
      `);

      await expect(
        finalizeIntentAccountingAtomically(pool, {
          context: context(randomUUID(), fixture.now),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: fixture.intent,
          ledgerInput: fixture.ledger,
          stability: { source: "rollback" },
        }),
      ).rejects.toThrow(/injected accounting ledger failure/);
      await expect(getAccountingHead(pool, fixture.intent.id)).resolves.toMatchObject({ state: "open", revision: 0 });
      const counts = await pool.query<{
        versions: number;
        settlements: number;
        legacy_settlements: number;
        requests: number;
        terminal_parents: number;
      }>(`
        SELECT
          (SELECT count(*)::integer FROM accounting_versions) AS versions,
          (SELECT count(*)::integer FROM accounting_settlement_facts) AS settlements,
          (SELECT count(*)::integer FROM settlements) AS legacy_settlements,
          (SELECT count(*)::integer FROM accounting_mutation_requests
            WHERE operation = 'finalize') AS requests,
          (SELECT count(*)::integer FROM order_intents
            WHERE id = '${fixture.intent.id}' AND status = 'settled') AS terminal_parents
      `);
      expect(counts.rows).toEqual([
        { versions: 0, settlements: 0, legacy_settlements: 0, requests: 0, terminal_parents: 0 },
      ]);
    });
  }, 30_000);

  it("retains immutable accounting proof when legacy fill and settlement retention expires", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const fixture = buildSettledFixture("accounting-retention");
      await insertFixtureParent(pool, fixture.intent);
      await ingestFixtureFills(pool, fixture);
      await finalizeIntentAccountingAtomically(pool, {
        context: context(randomUUID(), fixture.now),
        expectedHeadRevision: 0,
        expectedIntentRevision: 0,
        terminalIntent: fixture.intent,
        ledgerInput: fixture.ledger,
        stability: { source: "retention-test" },
      });

      const retention = Object.fromEntries(
        Object.keys(DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention).map((key) => [key, 1]),
      ) as typeof DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention;
      const summary = await runDatabaseMaintenance(pool, { intervalMs: 1, retention }, Date.now() + 24 * 60 * 60_000);
      expect(summary.deleted).toMatchObject({ fills: 2, settlements: 2, closedIntents: 0 });
      const proof = await pool.query<{
        intents: number;
        heads: number;
        fill_facts: number;
        settlement_facts: number;
        versions: number;
        ledger: number;
        legacy_fills: number;
        legacy_settlements: number;
      }>(`
        SELECT
          (SELECT count(*)::integer FROM order_intents) AS intents,
          (SELECT count(*)::integer FROM accounting_heads WHERE state = 'stable') AS heads,
          (SELECT count(*)::integer FROM accounting_fill_facts) AS fill_facts,
          (SELECT count(*)::integer FROM accounting_settlement_facts) AS settlement_facts,
          (SELECT count(*)::integer FROM accounting_versions) AS versions,
          (SELECT count(*)::integer FROM accounting_realized_pnl_ledger) AS ledger,
          (SELECT count(*)::integer FROM fills) AS legacy_fills,
          (SELECT count(*)::integer FROM settlements) AS legacy_settlements
      `);
      expect(proof.rows).toEqual([
        {
          intents: 1,
          heads: 1,
          fill_facts: 2,
          settlement_facts: 2,
          versions: 1,
          ledger: 1,
          legacy_fills: 0,
          legacy_settlements: 0,
        },
      ]);
    });
  }, 30_000);

  it("quarantines a late fill atomically, preserves the stable head proof, then appends a correction", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const fixture = buildSettledFixture("accounting-revision");
      await insertFixtureParent(pool, fixture.intent);
      await ingestFixtureFills(pool, fixture);
      const finalized = await finalizeIntentAccountingAtomically(pool, {
        context: context(randomUUID(), fixture.now),
        expectedHeadRevision: 0,
        expectedIntentRevision: 0,
        terminalIntent: fixture.intent,
        ledgerInput: fixture.ledger,
        stability: { source: "initial" },
      });
      const firstProof = finalized.proofSha256;
      await insertMatchingStablePnlChange(pool, fixture.intent.id);

      const lateFill: LiveFill = {
        ...fixture.fills[0].fill,
        id: `${fixture.intent.id}:fill-poly-late`,
        venueOrderId: `${fixture.intent.id}:poly-order-late`,
        tradeId: `${fixture.intent.id}:poly-trade-late`,
        size: 1,
        feeUsd: 0,
        filledAt: fixture.now - 250,
      };
      const late = await ingestVenueFillAtomically(pool, {
        context: context(randomUUID(), fixture.now),
        expectedHeadRevision: 1,
        legId: fixture.intent.legs[0].id,
        finality: "final",
        fill: lateFill,
      });
      expect(late).toMatchObject({
        decision: "quarantined",
        reason: "late_terminal_fill",
        head: { state: "quarantined", revision: 2, currentVersion: 1, currentProofSha256: firstProof },
      });
      const incident = await pool.query<{ total: number }>(`
        SELECT count(*)::integer AS total
        FROM circuit_breaker_incident_current
        WHERE owner = 'execution' AND incident_key LIKE 'execution:venue_error:manual_intervention:%'
      `);
      expect(incident.rows).toEqual([{ total: 1 }]);

      const revisedLedger: AccountingLedgerInput = {
        ...fixture.ledger,
        version: 2,
        fills: [...fixture.ledger.fills, { ...lateFill, legId: fixture.intent.legs[0].id, finality: "final" }],
        settlements: fixture.ledger.settlements.map((settlement) =>
          settlement.legId === fixture.intent.legs[0].id
            ? {
                ...settlement,
                id: `${settlement.id}:v2`,
                settledSize: 11,
                payoutUsd: 11,
                settledAt: lateFill.filledAt + 10,
              }
            : settlement,
        ),
      };
      const currentIntent = await pool.query<{ revision: number; updated_at: number }>(
        "SELECT revision, updated_at FROM order_intents WHERE id = $1",
        [fixture.intent.id],
      );
      const corrected = await reaccountIntentAtomically(pool, {
        context: context(randomUUID(), fixture.now),
        expectedHeadRevision: 2,
        expectedIntentRevision: 1,
        terminalIntent: {
          ...fixture.intent,
          revision: Number(currentIntent.rows[0]?.revision),
          updatedAt: Number(currentIntent.rows[0]?.updated_at),
        },
        ledgerInput: revisedLedger,
        stability: { source: "late-fill-review", quarantineReviewed: true },
      });
      expect(corrected).toMatchObject({ replayed: false, version: 2, head: { state: "stable", revision: 3 } });
      const ledger = await pool.query<{ deltas: string[]; resulting: string[] }>(`
        SELECT
          array_agg(realized_pnl_delta_units::text ORDER BY accounting_version) AS deltas,
          array_agg(resulting_realized_pnl_units::text ORDER BY accounting_version) AS resulting
        FROM accounting_realized_pnl_ledger
        WHERE intent_id = '${fixture.intent.id}'
      `);
      expect(ledger.rows).toEqual([{ deltas: ["98000000", "60000000"], resulting: ["98000000", "158000000"] }]);
      await expect(sumAllTimeAccountingLedger(pool)).resolves.toEqual({
        realizedPnlUnits: "158000000",
        feeUnits: "2000000",
        realizedPnlUsd: 1.58,
        feesUsd: 0.02,
        entries: 2,
      });
      await expect(listStableAccountingProjectionBacklog(pool)).resolves.toMatchObject([
        {
          accountingVersion: 2,
          proofSha256: corrected.proofSha256,
          realizedPnlUsd: 1.58,
          intent: { id: fixture.intent.id },
          stablePnlChange: { realizedPnlUsd: 0.98 },
        },
      ]);
    });
  }, 30_000);

  it("closes proven zero exposure and quarantines any later fill", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const intent = buildIntent("accounting-zero", "failed");
      await insertFixtureParent(pool, intent);
      await expect(
        closeIntentWithoutExposureAtomically(pool, {
          context: context(randomUUID(), intent.resolvedAt! + 5),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: {
            ...intent,
            legs: intent.legs.map((leg, index) =>
              index === 0 ? { ...leg, filledPrice: 0.4, filledSize: 1, feeUsd: 0.01, status: "filled" as const } : leg,
            ) as OrderIntent["legs"],
          },
          proof: { venueOrders: "none", positions: "none", observedAt: intent.resolvedAt! + 5 },
        }),
      ).rejects.toMatchObject({ code: "exposure_present" });
      const closure = await closeIntentWithoutExposureAtomically(pool, {
        context: context(randomUUID(), intent.resolvedAt! + 10),
        expectedHeadRevision: 0,
        expectedIntentRevision: 0,
        terminalIntent: intent,
        proof: { venueOrders: "none", positions: "none", observedAt: intent.resolvedAt! + 10 },
      });
      expect(closure).toMatchObject({
        replayed: false,
        version: null,
        head: { state: "no_exposure", revision: 1 },
      });
      const closedParent = await pool.query<{ status: string; revision: number; realized_pnl_usd: number }>(
        "SELECT status, revision, realized_pnl_usd FROM order_intents WHERE id = $1",
        [intent.id],
      );
      expect(closedParent.rows).toEqual([{ status: "failed", revision: 1, realized_pnl_usd: 0 }]);

      await expect(
        pool.query(
          `
            UPDATE order_intents
            SET legs_json = jsonb_set(legs_json, '{0,filledSize}', '1'::jsonb),
                revision = revision + 1,
                updated_at = updated_at + 1
            WHERE id = $1
          `,
          [intent.id],
        ),
      ).rejects.toThrow(/no-exposure accounting head .* contradicts its exact parent projection/);

      const fill = buildFill(intent, intent.legs[0].id, "polymarket", 0.4, 1);
      await expect(upsertLegacyFillProjection(pool, fill)).rejects.toThrow(/bypasses durable accounting ingestion/);
      const quarantined = await ingestVenueFillAtomically(pool, {
        context: context(randomUUID(), intent.resolvedAt! + 20),
        expectedHeadRevision: 1,
        legId: intent.legs[0].id,
        finality: "final",
        fill,
      });
      expect(quarantined).toMatchObject({
        decision: "quarantined",
        reason: "head_already_closed",
        head: { state: "quarantined", revision: 2, currentVersion: null },
      });
    });
  }, 30_000);

  it("rejects fill writes that bypass atomic accounting ingestion", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const intent = buildIntent("accounting-fill-ingestion-guard", "failed");
      await insertFixtureParent(pool, intent);
      const fill = buildFill(intent, intent.legs[0].id, "polymarket", 0.4, 1);

      await expect(upsertLegacyFillProjection(pool, fill)).rejects.toThrow(/bypasses durable accounting ingestion/);
      const rejected = await pool.query<{ fills: number; facts: number }>(`
        SELECT
          (SELECT count(*)::integer FROM fills) AS fills,
          (SELECT count(*)::integer FROM accounting_fill_facts) AS facts
      `);
      expect(rejected.rows).toEqual([{ fills: 0, facts: 0 }]);

      await expect(
        ingestVenueFillAtomically(pool, {
          context: context(randomUUID(), intent.resolvedAt! + 10),
          expectedHeadRevision: 0,
          legId: intent.legs[0].id,
          finality: "final",
          fill,
        }),
      ).resolves.toMatchObject({ decision: "recorded", head: { state: "open", revision: 0 } });
      const recorded = await pool.query<{ fills: number; facts: number }>(`
        SELECT
          (SELECT count(*)::integer FROM fills) AS fills,
          (SELECT count(*)::integer FROM accounting_fill_facts) AS facts
      `);
      expect(recorded.rows).toEqual([{ fills: 1, facts: 1 }]);
    });
  }, 30_000);

  it("preserves pre-V8 legacy fills but rejects new bypasses on a legacy-pending parent", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const intent = buildIntent("accounting-legacy-fill-boundary", "failed");
      await insertFixtureParent(pool, intent);
      const legacyFill = buildFill(intent, intent.legs[0].id, "polymarket", 0.4, 1);
      await upsertLegacyFillProjection(pool, legacyFill);

      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS);
      const migrated = await pool.query<{ state: string; fills: number }>(
        `
          SELECT
            head.state,
            (SELECT count(*)::integer FROM fills WHERE intent_id = head.intent_id) AS fills
          FROM accounting_heads AS head
          WHERE head.intent_id = $1
        `,
        [intent.id],
      );
      expect(migrated.rows).toEqual([{ state: "legacy_pending", fills: 1 }]);

      await expect(
        upsertLegacyFillProjection(pool, {
          ...legacyFill,
          id: `${legacyFill.id}:late`,
          venueOrderId: `${legacyFill.venueOrderId}:late`,
          tradeId: `${legacyFill.tradeId}:late`,
          filledAt: legacyFill.filledAt + 1,
        }),
      ).rejects.toThrow(/bypasses durable accounting ingestion/);
      const after = await pool.query<{ fills: number }>(
        "SELECT count(*)::integer AS fills FROM fills WHERE intent_id = $1",
        [intent.id],
      );
      expect(after.rows).toEqual([{ fills: 1 }]);
    });
  }, 30_000);

  it("recovers a contradicted no-exposure closure only from exact late-fill evidence", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const fixture = buildSettledFixture("accounting-late-fill-recovery");
      const pending: OrderIntent = {
        ...fixture.intent,
        status: "pending",
        resolvedAt: null,
        failureReason: null,
        realizedPnlUsd: null,
        roi: null,
        polyResolution: null,
        kalshiResolution: null,
        legs: fixture.intent.legs.map((leg) => ({
          ...leg,
          filledPrice: null,
          filledSize: 0,
          feeUsd: 0,
          status: "pending",
          venueOrderId: null,
          payoutUsd: null,
          resolvedOutcome: null,
        })) as OrderIntent["legs"],
      };
      await insertOrderIntent(pool, pending);
      const failed: OrderIntent = {
        ...pending,
        status: "failed",
        updatedAt: fixture.now,
        resolvedAt: fixture.now,
        failureReason: "Primary order not observed before timeout",
        realizedPnlUsd: 0,
      };
      await closeIntentWithoutExposureAtomically(pool, {
        context: context(randomUUID(), fixture.now),
        expectedHeadRevision: 0,
        expectedIntentRevision: 0,
        terminalIntent: failed,
        proof: { venueOrders: "none", fills: "none", observedAt: fixture.now },
      });

      await expect(
        pool.query(
          `
            UPDATE order_intents
            SET status = 'hedged', resolved_at = NULL, realized_pnl_usd = NULL,
                updated_at = $2, revision = revision + 1
            WHERE id = $1
          `,
          [fixture.intent.id, fixture.now],
        ),
      ).rejects.toThrow(/no-exposure accounting head .* requires failed, skipped, or canceled parent intent/);

      let expectedHeadRevision = 1;
      for (const evidence of fixture.fills) {
        const decision = await ingestVenueFillAtomically(pool, {
          context: context(randomUUID(), fixture.now),
          expectedHeadRevision,
          legId: evidence.legId,
          finality: "final",
          fill: evidence.fill,
        });
        expect(decision).toMatchObject({ decision: "quarantined" });
        expectedHeadRevision += 1;
      }

      await pool.query(
        `
          UPDATE order_intents
          SET status = 'hedged', resolved_at = NULL, realized_pnl_usd = NULL, roi = NULL,
              updated_at = $2, revision = revision + 1
          WHERE id = $1
        `,
        [fixture.intent.id, fixture.now],
      );
      const finalized = await finalizeIntentAccountingAtomically(pool, {
        context: context(randomUUID(), fixture.now + 1),
        expectedHeadRevision,
        expectedIntentRevision: 2,
        terminalIntent: {
          ...fixture.intent,
          revision: 2,
          updatedAt: fixture.now,
        },
        ledgerInput: fixture.ledger,
        stability: { source: "exact-late-fill-recovery", quarantineReviewed: true },
      });
      expect(finalized).toMatchObject({
        version: 1,
        head: { state: "stable", revision: expectedHeadRevision + 1 },
      });
      await expect(getAccountingHead(pool, fixture.intent.id)).resolves.toMatchObject({
        state: "stable",
        currentVersion: 1,
      });
    });
  }, 30_000);

  it("treats residual position value as exposure while allowing sub-threshold dust", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const intent = buildIntent("accounting-position-threshold", "failed");
      await insertFixtureParent(pool, intent);
      const leg = intent.legs[0];
      await pool.query(
        `
          INSERT INTO positions (
            id, asset, venue, market_ref, outcome, size, average_price, current_price,
            current_value_usd, realized_pnl_usd, unrealized_pnl_usd, redeemable,
            mergeable, updated_at, raw_json
          ) VALUES (
            $1, $2, $3, $4, $5, 0.01, 0.5, 0.5,
            0.06, 0, 0, false, false, $6, '{}'::jsonb
          )
        `,
        [`${intent.id}:position`, intent.asset, leg.venue, leg.marketRef, leg.outcome, intent.updatedAt],
      );
      const closeInput = {
        context: context(randomUUID(), intent.resolvedAt! + 10),
        expectedHeadRevision: 0,
        expectedIntentRevision: 0,
        terminalIntent: intent,
        proof: { positions: "threshold-checked" },
      };
      await expect(closeIntentWithoutExposureAtomically(pool, closeInput)).rejects.toMatchObject({
        code: "exposure_present",
      });

      await pool.query("UPDATE positions SET current_value_usd = 0.01 WHERE id = $1", [`${intent.id}:position`]);
      await expect(
        closeIntentWithoutExposureAtomically(pool, {
          ...closeInput,
          context: context(randomUUID(), intent.resolvedAt! + 11),
        }),
      ).resolves.toMatchObject({ head: { state: "no_exposure" } });
    });
  }, 30_000);

  it("rejects resolved attempts with missing or contradictory durable venue truth", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const intent = buildIntent("accounting-confirmed-guard", "failed");
      await insertFixtureParent(pool, intent);
      await expect(
        insertResolvedAttemptRow(pool, intent, "missing-id", {
          venueOrderId: null,
          status: "confirmed",
          truthStatus: "filled",
          result: {},
        }),
      ).rejects.toThrow(/lacks matching durable venue truth/);
      await expect(
        insertResolvedAttemptRow(pool, intent, "orphan", {
          venueOrderId: `${intent.id}:missing-venue-order`,
          status: "confirmed",
          truthStatus: "filled",
          result: {},
        }),
      ).rejects.toThrow(/lacks matching durable venue truth/);
      const confirmedOrderId = `${intent.id}:confirmed-order`;
      await insertMatchingVenueOrderRow(pool, intent, "missing-truth", confirmedOrderId);
      await expect(
        insertResolvedAttemptRow(pool, intent, "missing-truth", {
          venueOrderId: confirmedOrderId,
          status: "confirmed",
          truthStatus: null,
          result: {},
        }),
      ).rejects.toThrow(/lacks matching durable venue truth/);
      const inconclusiveOrderId = `${intent.id}:inconclusive-order`;
      await insertMatchingVenueOrderRow(pool, intent, "inconclusive", inconclusiveOrderId);
      await expect(
        insertResolvedAttemptRow(pool, intent, "inconclusive", {
          venueOrderId: inconclusiveOrderId,
          status: "confirmed",
          truthStatus: "submission_unknown",
          result: {},
        }),
      ).rejects.toThrow(/lacks matching durable venue truth/);
      const contradictoryOrderId = `${intent.id}:contradictory-order-status`;
      await insertMatchingVenueOrderRow(pool, intent, "contradictory-status", contradictoryOrderId);
      await expect(
        insertResolvedAttemptRow(pool, intent, "contradictory-status", {
          venueOrderId: contradictoryOrderId,
          status: "confirmed",
          truthStatus: "filled",
          result: {
            venue: "polymarket",
            venueOrderId: contradictoryOrderId,
            status: "canceled",
            filledSize: 0,
          },
        }),
      ).rejects.toThrow(/lacks matching durable venue truth/);

      const progressedOrderId = `${intent.id}:progressed-order`;
      await insertMatchingVenueOrderRow(pool, intent, "progressed", progressedOrderId, {
        status: "pending",
        requestedSize: 10,
      });
      await insertResolvedAttemptRow(pool, intent, "progressed", {
        venueOrderId: progressedOrderId,
        status: "confirmed",
        truthStatus: "pending",
        result: {
          venue: "polymarket",
          venueOrderId: progressedOrderId,
          status: "pending",
          filledSize: 0,
        },
      });
      await expect(
        pool.query(
          `
            UPDATE venue_orders
            SET status = 'filled', filled_size = 10, average_fill_price = 0.4, fee_usd = 0.01
            WHERE venue_order_id = $1
          `,
          [progressedOrderId],
        ),
      ).resolves.toBeDefined();

      const regressedOrderId = `${intent.id}:regressed-order`;
      await insertMatchingVenueOrderRow(pool, intent, "regressed", regressedOrderId);
      await expect(
        insertResolvedAttemptRow(pool, intent, "regressed", {
          venueOrderId: regressedOrderId,
          status: "confirmed",
          truthStatus: "filled",
          result: {
            venue: "polymarket",
            venueOrderId: regressedOrderId,
            status: "filled",
            filledSize: 10,
          },
        }),
      ).rejects.toThrow(/lacks matching durable venue truth/);

      await expect(
        insertResolvedAttemptRow(pool, intent, "contradictory-result", {
          venueOrderId: null,
          status: "failed",
          truthStatus: "not_submitted",
          result: { status: "accepted" },
        }),
      ).rejects.toThrow(/contradictory venue truth/);
      const linkedOrderId = `${intent.id}:linked-order`;
      await insertMatchingVenueOrderRow(pool, intent, "linked", linkedOrderId);
      await expect(
        insertResolvedAttemptRow(pool, intent, "linked", {
          venueOrderId: null,
          status: "failed",
          truthStatus: "not_submitted",
          result: null,
        }),
      ).rejects.toThrow(/contradictory venue truth/);
    });

    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 7));
      const intent = buildIntent("accounting-confirmed-legacy", "failed");
      await insertFixtureParent(pool, intent);
      const venueOrderId = `${intent.id}:inconclusive-order`;
      await insertMatchingVenueOrderRow(pool, intent, "legacy-inconclusive", venueOrderId);
      await insertResolvedAttemptRow(pool, intent, "legacy-inconclusive", {
        venueOrderId,
        status: "confirmed",
        truthStatus: "confirmation_unknown",
        result: {},
      });
      await expect(
        closeIntentWithoutExposureAtomically(pool, {
          context: context(randomUUID(), intent.resolvedAt! + 10),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: intent,
          proof: { venueOrders: "none" },
        }),
      ).rejects.toMatchObject({ code: "unresolved_submission" });
      await expect(runDatabaseMigrations(pool, DATABASE_MIGRATIONS)).rejects.toThrow(
        /confirmed order attempts lack matching durable venue truth/,
      );
    });

    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 7));
      const intent = buildIntent("accounting-not-submitted-legacy", "failed");
      await insertFixtureParent(pool, intent);
      await insertResolvedAttemptRow(pool, intent, "legacy-result", {
        venueOrderId: null,
        status: "failed",
        truthStatus: "not_submitted",
        result: { status: "accepted" },
      });
      await expect(
        closeIntentWithoutExposureAtomically(pool, {
          context: context(randomUUID(), intent.resolvedAt! + 10),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: intent,
          proof: { venueOrders: "none" },
        }),
      ).rejects.toMatchObject({ code: "unresolved_submission" });
      await expect(runDatabaseMigrations(pool, DATABASE_MIGRATIONS)).rejects.toThrow(
        /not-submitted order attempts have contradictory venue truth/,
      );
    });
  }, 30_000);

  it("rejects contradictory venue-order economics in migration, writes, and zero-exposure closure", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 7));
      const intent = buildIntent("accounting-invalid-order-legacy", "failed");
      await insertFixtureParent(pool, intent);
      await insertMatchingVenueOrderRow(pool, intent, "filled-zero", `${intent.id}:filled-zero`, {
        status: "filled",
        filledSize: 0,
      });

      await expect(
        closeIntentWithoutExposureAtomically(pool, {
          context: context(randomUUID(), intent.resolvedAt! + 10),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: intent,
          proof: { venueOrders: "terminal-zero-fill" },
        }),
      ).rejects.toMatchObject({ code: "exposure_present" });
      await expect(runDatabaseMigrations(pool, DATABASE_MIGRATIONS)).rejects.toThrow(
        /venue orders contain contradictory size, status, or price truth/,
      );
    });

    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 7));
      const intent = buildIntent("accounting-invalid-order-price-fee-legacy", "failed");
      await insertFixtureParent(pool, intent);
      await insertMatchingVenueOrderRow(pool, intent, "bad-price", `${intent.id}:bad-price`, {
        requestedPrice: Number.NaN,
      });
      await insertMatchingVenueOrderRow(pool, intent, "bad-fee", `${intent.id}:bad-fee`, {
        feeUsd: Number.POSITIVE_INFINITY,
      });

      await expect(
        closeIntentWithoutExposureAtomically(pool, {
          context: context(randomUUID(), intent.resolvedAt! + 10),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: intent,
          proof: { venueOrders: "invalid-price-fee" },
        }),
      ).rejects.toMatchObject({ code: "exposure_present" });
      await expect(runDatabaseMigrations(pool, DATABASE_MIGRATIONS)).rejects.toThrow(
        /venue orders contain contradictory size, status, or price truth/,
      );
    });

    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const intent = buildIntent("accounting-invalid-order-write", "failed");
      await insertFixtureParent(pool, intent);
      const cases: Array<{
        suffix: string;
        constraint: string;
        overrides: Parameters<typeof insertMatchingVenueOrderRow>[4];
      }> = [
        { suffix: "bad-request", constraint: "requested_size", overrides: { requestedSize: Number.NaN } },
        {
          suffix: "bad-request-price",
          constraint: "requested_price",
          overrides: { requestedPrice: Number.NaN },
        },
        { suffix: "zero-request-price", constraint: "requested_price", overrides: { requestedPrice: 0 } },
        {
          suffix: "bad-filled-size",
          constraint: "filled_size",
          overrides: { requestedSize: 1, filledSize: Number.POSITIVE_INFINITY, averageFillPrice: 0.5 },
        },
        { suffix: "filled-zero", constraint: "status_fill", overrides: { status: "filled", filledSize: 0 } },
        {
          suffix: "partial-complete",
          constraint: "status_fill",
          overrides: { status: "partially_filled", requestedSize: 1, filledSize: 1, averageFillPrice: 0.5 },
        },
        {
          suffix: "bad-average",
          constraint: "average_fill_price",
          overrides: { status: "canceled", filledSize: 0.5, averageFillPrice: Number.POSITIVE_INFINITY },
        },
        {
          suffix: "missing-average",
          constraint: "average_fill_price",
          overrides: { status: "canceled", filledSize: 0.5, averageFillPrice: null },
        },
        { suffix: "nonfinite-fee", constraint: "fee", overrides: { feeUsd: Number.POSITIVE_INFINITY } },
        { suffix: "negative-fee", constraint: "fee", overrides: { feeUsd: -0.01 } },
      ];
      for (const invalid of cases) {
        await expect(
          insertMatchingVenueOrderRow(
            pool,
            intent,
            invalid.suffix,
            `${intent.id}:${invalid.suffix}`,
            invalid.overrides,
          ),
        ).rejects.toThrow(new RegExp(`venue_orders_${invalid.constraint}`));
      }

      await expect(
        insertMatchingVenueOrderRow(pool, intent, "tolerated-overfill", `${intent.id}:tolerated-overfill`, {
          status: "filled",
          requestedSize: 1,
          filledSize: 1.0000005,
          averageFillPrice: 0.5,
        }),
      ).resolves.toBeUndefined();
    });
  }, 30_000);

  it("rejects unknown order lifecycle statuses before they can prove zero exposure", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 7));
      const intent = buildIntent("accounting-unknown-order-status", "failed");
      await insertFixtureParent(pool, intent);
      await insertMatchingVenueOrderRow(pool, intent, "unknown-status", `${intent.id}:venue-order`);
      await pool.query("UPDATE venue_orders SET status = 'unknown_status' WHERE intent_id = $1", [intent.id]);

      await expect(
        closeIntentWithoutExposureAtomically(pool, {
          context: context(randomUUID(), intent.resolvedAt! + 10),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: intent,
          proof: { venueOrders: "unknown-status" },
        }),
      ).rejects.toMatchObject({ code: "exposure_present" });
      await expect(runDatabaseMigrations(pool, DATABASE_MIGRATIONS)).rejects.toThrow(
        /venue orders contain contradictory size, status, or price truth/,
      );
    });

    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 7));
      const intent = buildIntent("accounting-unknown-attempt-status", "failed");
      await insertFixtureParent(pool, intent);
      await insertResolvedAttemptRow(pool, intent, "unknown-status", {
        venueOrderId: null,
        status: "failed",
        truthStatus: "not_submitted",
        result: null,
      });
      await pool.query("UPDATE order_attempts SET status = 'unknown_status' WHERE intent_id = $1", [intent.id]);

      await expect(
        closeIntentWithoutExposureAtomically(pool, {
          context: context(randomUUID(), intent.resolvedAt! + 10),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: intent,
          proof: { orderAttempts: "unknown-status" },
        }),
      ).rejects.toMatchObject({ code: "unresolved_submission" });
      await expect(runDatabaseMigrations(pool, DATABASE_MIGRATIONS)).rejects.toThrow(
        /order attempts contain unknown lifecycle status/,
      );
    });

    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const intent = buildIntent("accounting-status-constraints", "failed");
      await insertFixtureParent(pool, intent);
      await insertMatchingVenueOrderRow(pool, intent, "valid", `${intent.id}:venue-order`);
      await insertResolvedAttemptRow(pool, intent, "valid-attempt", {
        venueOrderId: null,
        status: "failed",
        truthStatus: "not_submitted",
        result: null,
      });

      await expect(
        pool.query("UPDATE venue_orders SET status = 'unknown_status' WHERE intent_id = $1", [intent.id]),
      ).rejects.toThrow(/venue_orders_status_valid/);
      await expect(
        pool.query("UPDATE order_attempts SET status = 'unknown_status' WHERE intent_id = $1", [intent.id]),
      ).rejects.toThrow(/order_attempts_status_valid/);
    });
  }, 30_000);

  it("rejects invalid live fills and contradictory parent identities durably", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 7));
      const intent = buildIntent("accounting-invalid-fill-legacy", "failed");
      await insertFixtureParent(pool, intent);
      await upsertLegacyFillProjection(pool, buildFill(intent, intent.legs[0].id, "polymarket", 0.4, 0));

      await expect(
        closeIntentWithoutExposureAtomically(pool, {
          context: context(randomUUID(), intent.resolvedAt! + 10),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: intent,
          proof: { fills: "invalid-size" },
        }),
      ).rejects.toMatchObject({ code: "exposure_present" });
      await expect(runDatabaseMigrations(pool, DATABASE_MIGRATIONS)).rejects.toThrow(
        /live legacy fills contain invalid economic truth/,
      );
    });

    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const intent = buildIntent("accounting-invalid-fill-write", "failed");
      await insertFixtureParent(pool, intent);
      const valid = buildFill(intent, intent.legs[0].id, "polymarket", 0.4, 1);
      for (const invalid of [
        { ...valid, price: Number.POSITIVE_INFINITY },
        { ...valid, size: 0 },
        { ...valid, feeUsd: -0.01 },
      ]) {
        await expect(upsertLegacyFillProjection(pool, invalid)).rejects.toThrow(/fills_live_economics_valid/);
      }
      await expect(upsertLegacyFillProjection(pool, { ...valid, asset: "eth" })).rejects.toThrow(
        /parent intent identity/,
      );
      await expect(
        insertMatchingVenueOrderRow(pool, intent, "wrong-asset", `${intent.id}:wrong-asset`, { asset: "eth" }),
      ).rejects.toThrow(/parent intent identity/);
      await expect(
        insertResolvedAttemptRow(pool, intent, "wrong-asset", {
          asset: "eth",
          venueOrderId: null,
          status: "failed",
          truthStatus: "not_submitted",
          result: null,
        }),
      ).rejects.toThrow(/parent intent identity/);
    });

    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 7));
      const intent = buildIntent("accounting-invalid-fill-parent", "failed");
      await insertFixtureParent(pool, intent);
      await upsertLegacyFillProjection(pool, {
        ...buildFill(intent, intent.legs[0].id, "polymarket", 0.4, 1),
        asset: "eth",
      });
      await expect(runDatabaseMigrations(pool, DATABASE_MIGRATIONS)).rejects.toThrow(
        /order truth rows contradict parent intent identity/,
      );
    });
  }, 30_000);

  it("treats non-finite positions as global accounting ambiguity", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 7));
      const intent = buildIntent("accounting-nonfinite-position", "failed");
      await insertFixtureParent(pool, intent);
      await pool.query(
        `
          INSERT INTO positions (
            id, asset, venue, market_ref, outcome, size, average_price, current_price,
            current_value_usd, realized_pnl_usd, unrealized_pnl_usd, redeemable,
            mergeable, updated_at, raw_json
          ) VALUES (
            'unrelated-nonfinite-position', 'eth', 'kalshi', 'unrelated-market', 'YES',
            'NaN'::double precision, NULL, NULL, 0, 0, 0, false, false, $1, '{}'::jsonb
          )
        `,
        [intent.updatedAt],
      );

      await expect(
        closeIntentWithoutExposureAtomically(pool, {
          context: context(randomUUID(), intent.resolvedAt! + 10),
          expectedHeadRevision: 0,
          expectedIntentRevision: 0,
          terminalIntent: intent,
          proof: { positions: "global-scan" },
        }),
      ).rejects.toMatchObject({ code: "exposure_present" });
      await expect(runDatabaseMigrations(pool, DATABASE_MIGRATIONS)).rejects.toThrow(
        /positions contain non-finite exposure truth/,
      );
    });

    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const intent = buildIntent("accounting-nonfinite-position-write", "failed");
      await insertFixtureParent(pool, intent);
      await expect(
        pool.query(
          `
            INSERT INTO positions (
              id, asset, venue, market_ref, outcome, size, average_price, current_price,
              current_value_usd, realized_pnl_usd, unrealized_pnl_usd, redeemable,
              mergeable, updated_at, raw_json
            ) VALUES (
              'nonfinite-position-write', 'btc', 'polymarket', $1, 'UP', 1, 0.4, 0.4,
              'Infinity'::double precision, 0, 0, false, false, $2, '{}'::jsonb
            )
          `,
          [intent.legs[0].marketRef, intent.updatedAt],
        ),
      ).rejects.toThrow(/positions_accounting_values_finite/);
    });
  }, 30_000);

  it("accepts one venue trade id on distinct venue orders without conflating maker fills", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const intent = buildIntent("accounting-maker", "settled");
      await insertFixtureParent(pool, intent);
      const first = buildFill(intent, intent.legs[0].id, "polymarket", 0.4, 1);
      const second = {
        ...first,
        id: `${intent.id}:fill:second`,
        venueOrderId: `${intent.id}:order:second`,
      };
      await expect(
        ingestVenueFillAtomically(pool, {
          context: context(randomUUID(), intent.resolvedAt! + 10),
          expectedHeadRevision: 0,
          legId: intent.legs[0].id,
          finality: "final",
          fill: first,
        }),
      ).resolves.toMatchObject({ decision: "recorded" });
      await expect(
        ingestVenueFillAtomically(pool, {
          context: context(randomUUID(), intent.resolvedAt! + 20),
          expectedHeadRevision: 0,
          legId: intent.legs[0].id,
          finality: "final",
          fill: second,
        }),
      ).resolves.toMatchObject({ decision: "recorded" });
      const facts = await pool.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM accounting_fill_facts WHERE intent_id = $1",
        [intent.id],
      );
      expect(facts.rows).toEqual([{ total: 2 }]);
    });
  }, 30_000);

  it("aggregates more than 200 immutable ledger entries without a recency limit", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const template = buildIntent("accounting-daily-template", "settled");
      await insertOrderIntent(pool, template);
      const dayStart = utcDayStart(template.resolvedAt!);

      await pool.query(
        `
          INSERT INTO order_intents (
            id, revision, asset, shadow, slot_key, slot_start_ts, slot_end_ts, combination, status,
            created_at, updated_at, resolved_at, primary_venue, hedge_venue, gross_cost,
            target_notional_usd, max_slippage_bps, entry_sizing_reason, failure_reason,
            projected_net_profit_usd, realized_pnl_usd, roi, poly_resolution, kalshi_resolution,
            legs_json, mismatch_p_fatal, mismatch_p_fatal_upper, mismatch_model_version,
            fatal_mismatch_pnl_usd, conservative_expected_pnl_usd, fatal_loss_exposure_usd,
            mismatch_risk_audit_json, shadow_execution_json
          )
          SELECT
            'accounting-daily-' || series.value, 0, asset, false, slot_key, slot_start_ts, slot_end_ts,
            combination, status, created_at, updated_at, resolved_at, primary_venue, hedge_venue,
            gross_cost, target_notional_usd, max_slippage_bps, entry_sizing_reason, failure_reason,
            projected_net_profit_usd, NULL, NULL, poly_resolution, kalshi_resolution, legs_json,
            mismatch_p_fatal, mismatch_p_fatal_upper, mismatch_model_version, fatal_mismatch_pnl_usd,
            conservative_expected_pnl_usd, fatal_loss_exposure_usd, mismatch_risk_audit_json,
            shadow_execution_json
          FROM order_intents AS template
          CROSS JOIN generate_series(1, 201) AS series(value)
          WHERE template.id = $1
        `,
        [template.id],
      );
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS);
      await pool.query(
        `
          INSERT INTO accounting_versions (
            intent_id, version, previous_version, request_id, evidence_sha256, proof_sha256,
            captured_at, recorded_at, cost_basis_units, payout_units, fee_units,
            realized_pnl_units, roi_units, evidence_json, proof_json
          )
          SELECT
            intent.id, 1, NULL,
            ('10000000-0000-4000-8000-' || lpad(substring(intent.id from '[0-9]+$'), 12, '0'))::uuid,
            md5(intent.id || ':evidence') || md5(intent.id || ':evidence:2'),
            md5(intent.id || ':proof') || md5(intent.id || ':proof:2'),
            $1, $1, 0, 100000000, 0, 100000000, NULL, '{}'::jsonb, '{}'::jsonb
          FROM order_intents AS intent
          WHERE intent.id LIKE 'accounting-daily-%' AND intent.id <> 'accounting-daily-template'
        `,
        [dayStart + 1_000],
      );
      await pool.query(
        `
          INSERT INTO accounting_realized_pnl_ledger (
            intent_id, accounting_version, request_id, asset, shadow, effective_at, recorded_at,
            cost_basis_delta_units, payout_delta_units, fee_delta_units, realized_pnl_delta_units,
            resulting_realized_pnl_units, proof_sha256
          )
          SELECT
            version.intent_id, 1,
            ('20000000-0000-4000-8000-' || lpad(substring(version.intent_id from '[0-9]+$'), 12, '0'))::uuid,
            'btc', false, $1, $1, 0, 100000000, 0, 100000000, 100000000, version.proof_sha256
          FROM accounting_versions AS version
          WHERE version.intent_id LIKE 'accounting-daily-%'
            AND version.intent_id <> 'accounting-daily-template'
        `,
        [dayStart + 1_000],
      );

      await expect(sumAccountingRealizedPnlForUtcDay(pool, dayStart)).resolves.toEqual({
        units: "20100000000",
        usd: 201,
        entries: 201,
      });
      const view = await pool.query<{ units: string; entries: number }>(
        `
          SELECT realized_pnl_units::text AS units, ledger_entries::integer AS entries
          FROM accounting_daily_realized_pnl
          WHERE utc_day = to_timestamp($1 / 1000.0)::date AND shadow = false
        `,
        [dayStart],
      );
      expect(view.rows).toEqual([{ units: "20100000000", entries: 201 }]);
    });
  }, 30_000);

  it("blocks new entry on accounting quarantine while preserving exposed-intent recovery", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setLiveStrategy(pool);
      const blocker = buildIntent("accounting-lock-blocker", "pending");
      blocker.resolvedAt = null;
      await insertOrderIntent(pool, blocker);

      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await acquireAccountingTransactionLock(writer);
        await writer.query(
          `
            UPDATE accounting_heads
            SET state = 'quarantined', revision = revision + 1, updated_at = updated_at + 1
            WHERE intent_id = $1
          `,
          [blocker.id],
        );
        const admissionPromise = admitLiveEntryAtomically(pool, buildLiveAdmission("accounting-lock-candidate"));
        await delay(50);
        let settled = false;
        void admissionPromise.finally(() => {
          settled = true;
        });
        await delay(50);
        expect(settled).toBe(false);
        await writer.query("COMMIT");
        await expect(admissionPromise).resolves.toMatchObject({
          admitted: false,
          code: "circuit_breaker_active",
          reason: expect.stringContaining("1 quarantined"),
        });
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
      }
    });

    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await setLiveStrategy(pool);
      const admittedInput = buildLiveAdmission("accounting-claim-candidate");
      const admission = await admitLiveEntryAtomically(pool, admittedInput);
      expect(admission).toMatchObject({ admitted: true });
      const blocker = buildIntent("accounting-claim-blocker", "pending");
      blocker.resolvedAt = null;
      await insertOrderIntent(pool, blocker);
      await pool.query(
        `
          UPDATE accounting_heads
          SET state = 'quarantined', revision = revision + 1, updated_at = updated_at + 1
          WHERE intent_id = $1
        `,
        [blocker.id],
      );

      await expect(
        claimAdmittedLiveOrderAttemptAtomically(pool, {
          intentId: admittedInput.intent.id,
          attemptId: admittedInput.plannedAttempt.id,
          request: admittedInput.plannedAttempt.request,
          claimedAt: Date.now(),
        }),
      ).rejects.toMatchObject({ code: "accounting_backlog", actualStatus: "planned" });

      const recoveryParent = buildIntent("accounting-recovery-claim", "primary_filled");
      recoveryParent.resolvedAt = null;
      await insertOrderIntent(pool, recoveryParent);
      const hedgeLeg = recoveryParent.legs[1];
      const recoveryAttempt: OrderAttempt = {
        id: `${recoveryParent.id}:hedge-attempt`,
        asset: recoveryParent.asset,
        shadow: false,
        intentId: recoveryParent.id,
        legId: hedgeLeg.id,
        stage: "hedge",
        venue: "kalshi",
        side: "BUY",
        orderType: "IOC",
        clientOrderId: `${recoveryParent.id}:hedge-client`,
        venueOrderId: null,
        status: "planned",
        truthStatus: null,
        request: {
          marketRef: hedgeLeg.marketRef,
          tokenId: null,
          outcome: hedgeLeg.outcome,
          side: "BUY",
          size: 10,
          price: 0.5,
          maxCostUsd: 5.1,
          orderType: "IOC",
          buyMode: null,
          reduceOnly: false,
          clientOrderId: `${recoveryParent.id}:hedge-client`,
        },
        submissionDeadlineAt: Date.now() + 30_000,
        result: null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const recoveryClaim = await claimLiveOrderAttemptForSubmissionAtomically(pool, {
        plannedAttempt: recoveryAttempt,
        submissionDeadlineAt: recoveryAttempt.submissionDeadlineAt!,
      });
      expect(recoveryClaim).toMatchObject({
        decision: "claimed",
        fresh: true,
        attempt: { status: "submitting", truthStatus: "submission_in_progress" },
      });
      await expect(
        revalidateLiveOrderAttemptBeforeDispatchAtomically(pool, {
          intentId: recoveryParent.id,
          attemptId: recoveryAttempt.id,
          request: recoveryAttempt.request,
          submissionDeadlineAt: recoveryAttempt.submissionDeadlineAt!,
          expectedRevision: recoveryClaim.attempt.revision!,
        }),
      ).resolves.toMatchObject({ decision: "ready", attempt: { status: "submitting" } });
      const attempts = await pool.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM order_attempts WHERE intent_id = $1",
        [recoveryParent.id],
      );
      expect(attempts.rows).toEqual([{ total: 1 }]);
    });
  }, 30_000);
});

function buildSettledFixture(id: string) {
  const intent = buildIntent(id, "settled");
  const now = intent.resolvedAt! + 1_000;
  const fills = [
    {
      legId: intent.legs[0].id,
      fill: buildFill(intent, intent.legs[0].id, "polymarket", 0.4, 10),
    },
    {
      legId: intent.legs[1].id,
      fill: buildFill(intent, intent.legs[1].id, "kalshi", 0.5, 10),
    },
  ] as const;
  const ledger: AccountingLedgerInput = {
    version: 1,
    capturedAt: now,
    evidenceCompleteness: "complete",
    intent,
    legs: intent.legs,
    fills: fills.map(({ legId, fill }) => ({ ...fill, legId, finality: "final" })),
    settlements: [
      {
        id: `${id}:settlement-poly`,
        asset: intent.asset,
        shadow: intent.shadow,
        intentId: intent.id,
        legId: intent.legs[0].id,
        venue: "polymarket",
        marketRef: intent.legs[0].marketRef,
        tokenId: intent.legs[0].tokenId,
        outcome: "UP",
        resolvedOutcome: "UP",
        payoutUsd: 10,
        settledSize: 10,
        feeUsd: 0,
        settledAt: intent.resolvedAt! - 100,
        finality: "final",
      },
      {
        id: `${id}:settlement-kalshi`,
        asset: intent.asset,
        shadow: intent.shadow,
        intentId: intent.id,
        legId: intent.legs[1].id,
        venue: "kalshi",
        marketRef: intent.legs[1].marketRef,
        outcome: "NO",
        resolvedOutcome: "YES",
        payoutUsd: 0,
        settledSize: 10,
        feeUsd: 0,
        settledAt: intent.resolvedAt! - 100,
        finality: "final",
      },
    ],
  };
  return { intent, now, fills, ledger };
}

async function ingestFixtureFills(pool: Pool, fixture: ReturnType<typeof buildSettledFixture>) {
  for (const evidence of fixture.fills) {
    await ingestVenueFillAtomically(pool, {
      context: context(randomUUID(), fixture.now),
      expectedHeadRevision: 0,
      legId: evidence.legId,
      finality: "final",
      fill: evidence.fill,
    });
  }
}

async function insertFixtureParent(pool: Pool, terminalIntent: OrderIntent) {
  const parent: OrderIntent = {
    ...terminalIntent,
    status: terminalIntent.status === "settled" || terminalIntent.status === "unwound" ? "hedged" : "pending",
    resolvedAt: null,
    failureReason: null,
    realizedPnlUsd: null,
    roi: null,
    polyResolution: null,
    kalshiResolution: null,
    legs: terminalIntent.legs.map((leg) => ({
      ...leg,
      payoutUsd: null,
      resolvedOutcome: null,
    })) as OrderIntent["legs"],
  };
  await insertOrderIntent(pool, parent);
}

async function insertResolvedAttemptRow(
  pool: Pool,
  intent: OrderIntent,
  suffix: string,
  evidence: {
    asset?: OrderAttempt["asset"];
    shadow?: boolean;
    venueOrderId: string | null;
    status: "confirmed" | "failed";
    truthStatus: string | null;
    result: Record<string, unknown> | null;
  },
) {
  const leg = intent.legs[0];
  await pool.query(
    `
      INSERT INTO order_attempts (
        id, asset, shadow, intent_id, leg_id, stage, venue, side, order_type,
        client_order_id, venue_order_id, status, truth_status, request_json,
        result_json, error, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 'primary', $6, 'BUY', 'FOK',
        $7, $8, $9, $10, $11::jsonb,
        $12::jsonb, NULL, $13, $13
      )
    `,
    [
      `${intent.id}:attempt:${suffix}`,
      evidence.asset ?? intent.asset,
      evidence.shadow ?? intent.shadow,
      intent.id,
      leg.id,
      leg.venue,
      `${intent.id}:client:${suffix}`,
      evidence.venueOrderId,
      evidence.status,
      evidence.truthStatus,
      JSON.stringify({
        marketRef: leg.marketRef,
        tokenId: leg.tokenId ?? null,
        outcome: leg.outcome,
        side: "BUY",
        orderType: "FOK",
      }),
      evidence.result === null ? null : JSON.stringify(evidence.result),
      intent.createdAt,
    ],
  );
}

async function insertMatchingVenueOrderRow(
  pool: Pool,
  intent: OrderIntent,
  suffix: string,
  venueOrderId: string,
  overrides: Partial<
    Pick<
      LiveOrder,
      "asset" | "shadow" | "requestedPrice" | "requestedSize" | "filledSize" | "averageFillPrice" | "feeUsd" | "status"
    >
  > = {},
) {
  const leg = intent.legs[0];
  await pool.query(
    `
      INSERT INTO venue_orders (
        id, asset, shadow, intent_id, venue, venue_order_id, client_order_id,
        market_ref, token_id, side, outcome, order_type, requested_price,
        requested_size, filled_size, average_fill_price, fee_usd, status,
        created_at, updated_at, raw_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, 'BUY', $10, 'FOK', $11,
        $12, $13, $14, $15, $16,
        $17, $17, '{}'::jsonb
      )
    `,
    [
      `${intent.id}:venue-order:${suffix}`,
      overrides.asset ?? intent.asset,
      overrides.shadow ?? intent.shadow,
      intent.id,
      leg.venue,
      venueOrderId,
      `${intent.id}:client:${suffix}`,
      leg.marketRef,
      leg.tokenId ?? null,
      leg.outcome,
      Object.prototype.hasOwnProperty.call(overrides, "requestedPrice") ? overrides.requestedPrice : 0.5,
      overrides.requestedSize ?? 1,
      overrides.filledSize ?? 0,
      overrides.averageFillPrice ?? null,
      overrides.feeUsd ?? null,
      overrides.status ?? "canceled",
      intent.createdAt,
    ],
  );
}

async function insertMatchingStablePnlChange(pool: Pool, intentId: string) {
  await pool.query(
    `
      INSERT INTO stable_pnl_changes (
        intent_id, asset, combination, changed_at, settled_at, realized_pnl_usd, roi,
        target_notional_usd, equity_usd, cash_usd, positions_value_usd, strategy_pnl_usd,
        account_delta_usd, baseline_equity_usd, peak_equity_usd, drawdown_usd,
        venue_breakdown_json, stability_json, accounting_version, accounting_proof_sha256
      )
      SELECT
        intent.id, intent.asset, intent.combination, intent.updated_at, intent.resolved_at,
        intent.realized_pnl_usd, intent.roi, intent.target_notional_usd,
        100, 100, 0, intent.realized_pnl_usd, 0, 100, 100, 0, '{}'::jsonb, '{}'::jsonb,
        head.current_version, head.current_proof_sha256
      FROM order_intents AS intent
      JOIN accounting_heads AS head ON head.intent_id = intent.id AND head.state = 'stable'
      WHERE intent.id = $1
    `,
    [intentId],
  );
}

function buildIntent(id: string, status: OrderIntent["status"]): OrderIntent {
  const resolvedAt = Date.now() - 2_000;
  const slotStartTs = resolvedAt - 15 * 60_000;
  return {
    id,
    revision: 0,
    asset: "btc",
    shadow: false,
    slotKey: "btc:accounting-slot",
    slotStartTs,
    slotEndTs: slotStartTs + 15 * 60_000,
    combination: "POLY_UP_KALSHI_NO",
    status,
    createdAt: slotStartTs + 10,
    updatedAt: resolvedAt,
    resolvedAt,
    primaryVenue: "polymarket",
    hedgeVenue: "kalshi",
    grossCost: 0.9,
    targetNotionalUsd: 9,
    entrySizingReason: null,
    maxSlippageBps: 30,
    failureReason: status === "failed" ? "no submission" : null,
    projectedNetProfitUsd: 0.98,
    mismatchRiskAudit: null,
    shadowExecution: null,
    realizedPnlUsd: null,
    roi: null,
    polyResolution: status === "settled" ? "UP" : null,
    kalshiResolution: status === "settled" ? "YES" : null,
    legs: [
      {
        id: `${id}:poly-leg`,
        intentId: id,
        venue: "polymarket",
        outcome: "UP",
        marketRef: `${id}:condition`,
        tokenId: `${id}:token-up`,
        side: "BUY",
        requestedPrice: 0.4,
        requestedSize: 10,
        requestedNotionalUsd: 4,
        filledPrice: status === "settled" ? 0.4 : null,
        filledSize: status === "settled" ? 10 : 0,
        feeUsd: status === "settled" ? 0.01 : 0,
        status: status === "settled" ? "filled" : "failed",
        venueOrderId: status === "settled" ? `${id}:poly-order` : null,
        payoutUsd: status === "settled" ? 10 : null,
        resolvedOutcome: status === "settled" ? "UP" : null,
      },
      {
        id: `${id}:kalshi-leg`,
        intentId: id,
        venue: "kalshi",
        outcome: "NO",
        marketRef: `${id}:ticker`,
        side: "BUY",
        requestedPrice: 0.5,
        requestedSize: 10,
        requestedNotionalUsd: 5,
        filledPrice: status === "settled" ? 0.5 : null,
        filledSize: status === "settled" ? 10 : 0,
        feeUsd: status === "settled" ? 0.01 : 0,
        status: status === "settled" ? "filled" : "failed",
        venueOrderId: status === "settled" ? `${id}:kalshi-order` : null,
        payoutUsd: status === "settled" ? 0 : null,
        resolvedOutcome: status === "settled" ? "YES" : null,
      },
    ],
  };
}

function buildFill(
  intent: OrderIntent,
  legId: string,
  venue: "polymarket" | "kalshi",
  price: number,
  size: number,
): LiveFill {
  const leg = intent.legs.find((candidate) => candidate.id === legId && candidate.venue === venue)!;
  return {
    id: `${intent.id}:fill:${venue}`,
    asset: intent.asset,
    shadow: intent.shadow,
    intentId: intent.id,
    venue,
    venueOrderId: `${intent.id}:order:${venue}`,
    tradeId: `${intent.id}:shared-maker-trade`,
    marketRef: leg.marketRef,
    tokenId: leg.tokenId,
    side: "BUY",
    outcome: leg.outcome,
    price,
    size,
    feeUsd: 0.01,
    liquidity: "MAKER",
    filledAt: intent.resolvedAt! - 500,
    raw: { source: "accounting-integration" },
  };
}

function buildLiveAdmission(id: string): LiveEntryAdmissionInput {
  const now = Date.now();
  const intent = buildIntent(id, "pending");
  intent.status = "executing_primary";
  intent.createdAt = now;
  intent.updatedAt = now;
  intent.resolvedAt = null;
  intent.slotStartTs = now - 1_000;
  intent.slotEndTs = now + 15 * 60_000;
  intent.slotKey = "btc:live-accounting-slot";
  intent.legs = intent.legs.map((leg) => ({ ...leg, status: "pending" })) as OrderIntent["legs"];
  const attempt: OrderAttempt = {
    id: `${id}:attempt`,
    asset: "btc",
    shadow: false,
    intentId: id,
    legId: intent.legs[0].id,
    stage: "primary",
    venue: "polymarket",
    side: "BUY",
    orderType: "FOK",
    clientOrderId: `${id}:client`,
    venueOrderId: null,
    status: "planned",
    truthStatus: "admitted_not_claimed",
    request: { price: 0.4, size: 10 },
    submissionDeadlineAt: now + 30_000,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  return {
    now,
    intent,
    plannedAttempt: attempt,
    expectedStrategyRevision: 0,
    expectedGlobalRiskRevision: 0,
    policyEvaluatedAt: now,
    cutoffAt: now + 60_000,
    latestSubmissionStartAt: now + 30_000,
    evidence: { source: "accounting-integration" },
  };
}

async function setLiveStrategy(pool: Pool) {
  await pool.query(`
    UPDATE strategy_configs
    SET payload = jsonb_set(jsonb_set(payload, '{enableTrading}', 'true'), '{shadowMode}', 'false')
    WHERE asset = 'btc'
  `);
}

function context(requestId: string, occurredAt: number) {
  return { actor: "accounting-integration", requestId, occurredAt };
}

function utcDayStart(timestamp: number) {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withIsolatedSchema(run: (pool: Pool) => Promise<void>) {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  const schema = `accounting_${randomUUID().replace(/-/g, "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 12,
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
