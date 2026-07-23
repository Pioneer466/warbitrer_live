import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import {
  createExecutionIncident,
  createManualKillIncident,
  createMarketDegradedIncident,
  createMarketFeedIncident,
  createPolygonRpcIncident,
} from "@/lib/circuit-breaker-incidents";
import {
  DATABASE_MIGRATIONS,
  acknowledgeCircuitBreakerIncident,
  acknowledgeManualKillCircuitBreaker,
  listCircuitBreakers,
  listCurrentCircuitBreakerIncidents,
  migratePostgresDatabase,
  observeCircuitBreakerIncident,
  recordCircuitBreakerExposureRecovery,
  resolveOwnedCircuitBreakerIncident,
} from "@/lib/postgres-db";
import { runDatabaseMigrations } from "@/lib/db-migrations";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const SLOT_KEY = "btc:1784547900000";

describePostgres("circuit-breaker incident persistence", () => {
  it("serializes two independent causes on one scope without overwriting either", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const triggeredAt = Date.now() - 5_000;
      const kalshi = createMarketFeedIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        venue: "kalshi",
        source: "rest-fallback",
        triggeredAt,
        stalenessMs: 2_500,
        details: ["stale"],
      });
      const polymarket = createMarketFeedIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        venue: "polymarket",
        source: "unavailable",
        triggeredAt: triggeredAt + 1,
        stalenessMs: null,
        details: ["disconnected"],
      });

      const [first, second] = await Promise.all([
        observeCircuitBreakerIncident(pool, observation(kalshi, "market-data", "observe-kalshi")),
        observeCircuitBreakerIncident(pool, observation(polymarket, "market-data", "observe-poly")),
      ]);
      const current = await listCurrentCircuitBreakerIncidents(pool);
      const projection = await listCircuitBreakers(pool);

      expect(new Set([first.id, second.id])).toEqual(new Set([kalshi.id, polymarket.id]));
      expect(current.map((incident) => incident.id).sort()).toEqual([kalshi.id, polymarket.id].sort());
      expect(projection.find((breaker) => breaker.key === `slot:${SLOT_KEY}`)).toMatchObject({
        active: true,
        payload: { projectionVersion: "multi-cause-ui-v1" },
      });
    });
  }, 30_000);

  it("resolves one owner cause without clearing another cause on the same scope", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const triggeredAt = Date.now() - 5_000;
      const kalshi = createMarketFeedIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        venue: "kalshi",
        source: "rest-fallback",
        triggeredAt,
        stalenessMs: 2_500,
        details: [],
      });
      const polymarket = createMarketFeedIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        venue: "polymarket",
        source: "rest-fallback",
        triggeredAt: triggeredAt + 1,
        stalenessMs: 2_500,
        details: [],
      });
      await observeCircuitBreakerIncident(pool, observation(kalshi, "market-data", "observe-kalshi"));
      await observeCircuitBreakerIncident(pool, observation(polymarket, "market-data", "observe-poly"));

      const resolved = await resolveOwnedCircuitBreakerIncident(pool, {
        incidentId: kalshi.id,
        expectedRevision: 1,
        owner: "market-data",
        conditionRecovered: true,
        actor: "market-data",
        requestId: "resolve-kalshi",
      });
      const open = await listCurrentCircuitBreakerIncidents(pool);
      const projection = await listCircuitBreakers(pool);

      expect(resolved.timestamps.resolvedAt).not.toBeNull();
      expect(open.map((incident) => incident.id)).toEqual([polymarket.id]);
      expect(projection.find((breaker) => breaker.key === `slot:${SLOT_KEY}`)).toMatchObject({ active: true });
    });
  }, 30_000);

  it("reuses one open logical occurrence and creates a new occurrence only after resolution", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const triggeredAt = Date.now() - 10_000;
      const firstObservation = createMarketFeedIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        venue: "kalshi",
        source: "rest-fallback",
        triggeredAt,
        stalenessMs: 2_500,
        details: ["first"],
      });
      const repeatedObservation = createMarketFeedIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        venue: "kalshi",
        source: "unavailable",
        triggeredAt: triggeredAt + 1_000,
        stalenessMs: 3_500,
        details: ["repeated"],
      });

      const first = await observeCircuitBreakerIncident(
        pool,
        observation(firstObservation, "market-data", "observe-first"),
      );
      const repeated = await observeCircuitBreakerIncident(
        pool,
        observation(repeatedObservation, "market-data", "observe-repeat"),
      );
      expect(repeated).toMatchObject({ id: first.id, revision: 2, payload: { details: ["repeated"] } });

      await resolveOwnedCircuitBreakerIncident(pool, {
        incidentId: first.id,
        expectedRevision: 2,
        owner: "market-data",
        conditionRecovered: true,
        actor: "market-data",
        requestId: "resolve-first",
      });
      const nextOccurrence = createMarketFeedIncident({
        ...repeatedObservation.payload,
        asset: "btc",
        slotKey: SLOT_KEY,
        venue: "kalshi",
        source: "rest-fallback",
        triggeredAt: triggeredAt + 2_000,
        stalenessMs: 1_000,
        details: ["again"],
      });
      const next = await observeCircuitBreakerIncident(
        pool,
        observation(nextOccurrence, "market-data", "observe-next"),
      );

      expect(next.id).toBe(nextOccurrence.id);
      expect(next.id).not.toBe(first.id);
      expect(await listCurrentCircuitBreakerIncidents(pool)).toHaveLength(1);
      expect(await listCurrentCircuitBreakerIncidents(pool, { includeResolved: true })).toHaveLength(2);
    });
  }, 30_000);

  it("replays an exact request id and rejects reuse with different content", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const firstIncident = feedIncident(Date.now() - 5_000, "kalshi");
      const first = await observeCircuitBreakerIncident(
        pool,
        observation(firstIncident, "market-data", "same-request"),
      );
      const replay = await observeCircuitBreakerIncident(
        pool,
        observation(firstIncident, "market-data", "same-request"),
      );
      expect(replay).toEqual(first);

      await expect(
        observeCircuitBreakerIncident(
          pool,
          observation(feedIncident(Date.now() - 4_000, "polymarket"), "market-data", "same-request"),
        ),
      ).rejects.toMatchObject({ code: "request_conflict" });
    });
  }, 30_000);

  it("enforces revision CAS and cooldown using the PostgreSQL clock", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const triggeredAt = Date.now() - 1_000;
      const cooldown = createMarketDegradedIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        triggeredAt,
        cooldownUntil: Date.now() + 60_000,
        degradedCount: 3,
        windowMs: 900_000,
      });
      await observeCircuitBreakerIncident(pool, observation(cooldown, "fill-quality", "observe-cooldown"));

      await expect(
        resolveOwnedCircuitBreakerIncident(pool, {
          incidentId: cooldown.id,
          expectedRevision: 9,
          owner: "fill-quality",
          conditionRecovered: true,
          actor: "fill-quality",
          requestId: "stale-revision",
        }),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      await expect(
        resolveOwnedCircuitBreakerIncident(pool, {
          incidentId: cooldown.id,
          expectedRevision: 1,
          owner: "fill-quality",
          conditionRecovered: true,
          actor: "fill-quality",
          requestId: "early-cooldown-clear",
        }),
      ).rejects.toMatchObject({ code: "cooldown_active" });
    });
  }, 30_000);

  it("requires durable exposure proof before owner resolution", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const triggeredAt = Date.now() - 10_000;
      const incident = createExecutionIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        intentId: "intent-truth-pending",
        stage: "submission_truth_pending",
        reason: "venue_error",
        disposition: "truth_pending",
        venue: "polymarket",
        triggeredAt,
      });
      await observeCircuitBreakerIncident(pool, observation(incident, "execution", "observe-truth-pending"));

      await expect(
        resolveOwnedCircuitBreakerIncident(pool, {
          incidentId: incident.id,
          expectedRevision: 1,
          owner: "execution",
          conditionRecovered: true,
          actor: "execution",
          requestId: "resolve-without-proof",
        }),
      ).rejects.toMatchObject({ code: "unresolved_exposure" });

      const resolved = await resolveOwnedCircuitBreakerIncident(pool, {
        incidentId: incident.id,
        expectedRevision: 1,
        owner: "execution",
        conditionRecovered: true,
        exposureRecoveryProof: {
          owner: "execution",
          confirmedAt: triggeredAt + 1,
          evidenceId: "venue-truth:order-1",
        },
        actor: "execution",
        requestId: "resolve-with-proof",
      });
      expect(resolved).toMatchObject({
        exposure: { state: "resolved", evidenceId: "venue-truth:order-1" },
        timestamps: { resolvedAt: expect.any(Number) },
      });
    });
  }, 30_000);

  it("requires exposure recovery before operator acknowledgement", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const triggeredAt = Date.now() - 10_000;
      const incident = createExecutionIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        intentId: "intent-manual",
        stage: "late_fill",
        reason: "hedge_failure",
        disposition: "manual_intervention",
        venue: "kalshi",
        triggeredAt,
      });
      await observeCircuitBreakerIncident(pool, observation(incident, "execution", "observe-manual"));

      await expect(
        acknowledgeCircuitBreakerIncident(pool, {
          incidentId: incident.id,
          expectedRevision: 1,
          operatorId: "operator-1",
          actor: "operator-1",
          requestId: "ack-without-proof",
        }),
      ).rejects.toMatchObject({ code: "unresolved_exposure" });

      const proven = await recordCircuitBreakerExposureRecovery(pool, {
        incidentId: incident.id,
        expectedRevision: 1,
        owner: "execution",
        recoveryProof: {
          owner: "execution",
          confirmedAt: triggeredAt + 1,
          evidenceId: "position-snapshot:1",
        },
        actor: "execution",
        requestId: "prove-exposure",
      });
      expect(proven).toMatchObject({ revision: 2, exposure: { state: "resolved" } });

      const acknowledged = await acknowledgeCircuitBreakerIncident(pool, {
        incidentId: incident.id,
        expectedRevision: 2,
        operatorId: "operator-1",
        actor: "operator-1",
        requestId: "ack-after-proof",
      });
      expect(acknowledged.timestamps).toMatchObject({
        acknowledgedAt: expect.any(Number),
        resolvedAt: expect.any(Number),
      });
    });
  }, 30_000);

  it("acknowledges only the exact manual-kill identity and leaves other global causes open", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const triggeredAt = Date.now() - 5_000;
      const manual = createManualKillIncident({ triggeredAt, operatorId: "operator-1" });
      const rpc = createPolygonRpcIncident({
        triggeredAt: triggeredAt + 1,
        failureKind: "health_check_failed",
        detail: "timeout",
      });
      await observeCircuitBreakerIncident(pool, observation(manual, "operator-1", "manual-on"));
      await observeCircuitBreakerIncident(pool, observation(rpc, "polygon-rpc-health", "rpc-on"));

      await expect(
        acknowledgeManualKillCircuitBreaker(pool, {
          incidentId: rpc.id,
          expectedRevision: 1,
          operatorId: "operator-1",
          actor: "operator-1",
          requestId: "wrong-manual-id",
        }),
      ).rejects.toMatchObject({ code: "not_manual_kill" });

      await acknowledgeManualKillCircuitBreaker(pool, {
        incidentId: manual.id,
        expectedRevision: 1,
        operatorId: "operator-1",
        actor: "operator-1",
        requestId: "manual-off",
      });
      expect((await listCurrentCircuitBreakerIncidents(pool)).map((incident) => incident.id)).toEqual([rpc.id]);
      expect((await listCircuitBreakers(pool)).find((breaker) => breaker.key === "global")).toMatchObject({
        active: true,
        reason: "rpc_unhealthy",
      });
    });
  }, 30_000);

  it("keeps facts, events, scopes, and legacy source rows immutable", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const incident = feedIncident(Date.now() - 5_000, "kalshi");
      await observeCircuitBreakerIncident(pool, observation(incident, "market-data", "immutable-observe"));

      const immutableMutations: Array<[string, unknown[]]> = [
        ["UPDATE circuit_breaker_incidents SET reason = 'risk_limit' WHERE id = $1", [incident.id]],
        ["DELETE FROM circuit_breaker_incident_events WHERE incident_id = $1", [incident.id]],
        ["UPDATE circuit_breaker_scopes SET created_at = created_at + 1 WHERE scope_key = 'global'", []],
        ["UPDATE circuit_breakers_legacy SET active = true WHERE key = 'global'", []],
        ["TRUNCATE circuit_breaker_incident_events", []],
      ];
      for (const [sql, values] of immutableMutations) {
        await expect(pool.query(sql, values)).rejects.toThrow(/append-only/);
      }
      expect(await listCurrentCircuitBreakerIncidents(pool)).toHaveLength(1);
    });
  }, 30_000);

  it("supports a caller-owned transaction and rolls back facts plus events together", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const incident = feedIncident(Date.now() - 5_000, "kalshi");
        await observeCircuitBreakerIncident(client, observation(incident, "market-data", "rollback-observe"));
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect(await listCurrentCircuitBreakerIncidents(pool)).toEqual([]);
    });
  }, 30_000);

  it("refuses a PoolClient that is not already inside a caller-owned transaction", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const client = await pool.connect();
      try {
        await expect(
          observeCircuitBreakerIncident(
            client,
            observation(feedIncident(Date.now() - 5_000, "kalshi"), "market-data", "client-without-tx"),
          ),
        ).rejects.toThrow(/SAVEPOINT can only be used in transaction blocks/);
      } finally {
        client.release();
      }
      expect(await listCurrentCircuitBreakerIncidents(pool)).toEqual([]);
    });
  }, 30_000);
});

describePostgres("circuit-breaker migration backfill", () => {
  it("backfills every valid active legacy row and turns malformed legacy state into a global blocking incident", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(
        pool,
        DATABASE_MIGRATIONS.filter((migration) => migration.version <= 4),
      );
      const triggeredAt = Date.now() - 5_000;
      await pool.query(
        `
          UPDATE circuit_breakers
          SET active = true, reason = 'manual', triggered_at = $1, payload_json = '{}'::jsonb
          WHERE key = 'global'
        `,
        [triggeredAt],
      );
      await pool.query(
        `
          UPDATE circuit_breakers
          SET active = true, reason = 'risk_limit', triggered_at = $1, payload_json = '{"source":"legacy"}'::jsonb
          WHERE key = 'asset:btc'
        `,
        [triggeredAt + 1],
      );
      await pool.query(
        `
          INSERT INTO circuit_breakers (key, active, reason, triggered_at, payload_json)
          VALUES ('malformed-scope', true, 'unknown-reason', -1, '[]'::jsonb)
        `,
      );

      await migratePostgresDatabase(pool);
      const incidents = await listCurrentCircuitBreakerIncidents(pool);
      const malformed = incidents.find((incident) => incident.owner === "migration-v5");

      expect(incidents).toHaveLength(3);
      expect(incidents.map((incident) => incident.reason)).toEqual(
        expect.arrayContaining(["manual", "risk_limit", "readiness_failed"]),
      );
      expect(malformed).toMatchObject({
        scope: { type: "global" },
        impact: "blocked",
        resolutionPolicy: "operator",
        exposure: { state: "unresolved" },
        payload: { legacyKey: "malformed-scope" },
      });
      expect(JSON.stringify(malformed?.payload)).not.toContain("unknown-reason");
      expect((await listCircuitBreakers(pool)).find((breaker) => breaker.key === "global")).toMatchObject({
        active: true,
      });
    });
  }, 30_000);

  it("repairs only inactive numeric slot keys with immutable legacy evidence", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(
        pool,
        DATABASE_MIGRATIONS.filter((migration) => migration.version <= 4),
      );
      const legacyKey = "slot:1784547900000";
      await pool.query(
        `
          INSERT INTO circuit_breakers (key, active, reason, triggered_at, payload_json)
          VALUES ($1, false, NULL, NULL, 'null'::jsonb)
        `,
        [legacyKey],
      );

      await migratePostgresDatabase(pool);

      const openIncidents = await listCurrentCircuitBreakerIncidents(pool);
      const allIncidents = await listCurrentCircuitBreakerIncidents(pool, { includeResolved: true });
      const repaired = allIncidents.find(
        (incident) => incident.owner === "migration-v5" && incident.payload?.legacyKey === legacyKey,
      );
      const events = await pool.query<{ event_type: string; status: string; actor: string }>(
        `
          SELECT event_type, status, actor
          FROM circuit_breaker_incident_events
          WHERE incident_id = $1
          ORDER BY revision ASC
        `,
        [repaired?.id],
      );
      const legacy = await pool.query<{ active: boolean; reason: string | null; payload_json: unknown }>(
        "SELECT active, reason, payload_json FROM circuit_breakers_legacy WHERE key = $1",
        [legacyKey],
      );

      expect(openIncidents.some((incident) => incident.id === repaired?.id)).toBe(false);
      expect(repaired).toMatchObject({
        owner: "migration-v5",
        revision: 3,
        exposure: {
          state: "resolved",
          confirmedBy: "migration-v5",
        },
      });
      expect(repaired?.timestamps.resolvedAt).not.toBeNull();
      expect(events.rows).toEqual([
        { event_type: "observed", status: "open", actor: "migration-v5" },
        { event_type: "exposure_resolved", status: "open", actor: "migration-v5" },
        { event_type: "operator_acknowledged", status: "resolved", actor: "migration-v9" },
      ]);
      expect(legacy.rows).toEqual([{ active: false, reason: null, payload_json: null }]);
    });
  }, 30_000);
});

function observation<T extends Parameters<typeof observeCircuitBreakerIncident>[1]["incident"]>(
  incident: T,
  actor: string,
  requestId: string,
) {
  return { incident, actor, requestId };
}

function feedIncident(triggeredAt: number, venue: "kalshi" | "polymarket") {
  return createMarketFeedIncident({
    asset: "btc",
    slotKey: SLOT_KEY,
    venue,
    source: "rest-fallback",
    triggeredAt,
    stalenessMs: 2_500,
    details: [],
  });
}

async function withIsolatedSchema(run: (pool: Pool, schema: string) => Promise<void>) {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required");
  }
  const schema = `warbitrer_breakers_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = createScopedPool(schema);
  try {
    await run(pool, schema);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

function createScopedPool(schema: string) {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 6,
    options: `-c search_path=${schema}`,
  });
}
