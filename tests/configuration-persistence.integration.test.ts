import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import {
  ConfigurationRevisionConflictError,
  getExecutionConfiguration,
  getGlobalRiskConfig,
  getStrategyConfig,
  listStrategyConfigs,
  migratePostgresDatabase,
  tryWithGlobalLiveExecutionLock,
  updateGlobalRiskConfig,
  updateStrategyConfig,
  updateStrategyConfigs,
} from "@/lib/postgres-db";
import { MARKET_ASSETS } from "@/lib/market-catalog";
import type { ConfigurationMutationContext, StrategyConfigMapUpdate } from "@/lib/types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres("Postgres configuration revisions and audit", () => {
  it("waits for an in-flight live execution before mutating configuration", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const current = await getStrategyConfig(pool, "btc");
      let signalLiveAcquired!: () => void;
      let releaseLive!: () => void;
      const liveAcquired = new Promise<void>((resolve) => {
        signalLiveAcquired = resolve;
      });
      const liveRelease = new Promise<void>((resolve) => {
        releaseLive = resolve;
      });
      const heldLiveLock = tryWithGlobalLiveExecutionLock(pool, "configuration-lock-test", async () => {
        signalLiveAcquired();
        await liveRelease;
        return "released";
      });
      await liveAcquired;

      const mutation = updateStrategyConfig(
        pool,
        "btc",
        {
          config: { ...current.config, maxPairNotionalUsd: current.config.maxPairNotionalUsd + 1 },
          expectedRevision: current.revision,
        },
        mutationContext(),
      );

      let observationError: unknown;
      try {
        const lockState = await waitForExecutionLockState(
          pool,
          ({ granted, waiting }) => granted === 1 && waiting === 1,
        );
        expect(lockState).toEqual({ granted: 1, waiting: 1 });
      } catch (error) {
        observationError = error;
      } finally {
        releaseLive();
      }

      await expect(heldLiveLock).resolves.toEqual({ acquired: true, value: "released" });
      const updated = await mutation;
      if (observationError) {
        throw observationError;
      }
      expect(updated.revision).toBe(1);
    });
  }, 30_000);

  it("refuses a live execution lock while a configuration mutation holds it", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const current = await getStrategyConfig(pool, "btc");
      const auditBlocker = await pool.connect();
      await auditBlocker.query("BEGIN");
      await auditBlocker.query("LOCK TABLE configuration_audit_events IN ACCESS EXCLUSIVE MODE");

      const mutation = updateStrategyConfig(
        pool,
        "btc",
        {
          config: { ...current.config, maxPairNotionalUsd: current.config.maxPairNotionalUsd + 1 },
          expectedRevision: current.revision,
        },
        mutationContext(),
      );
      const liveCallback = vi.fn(async () => "unexpected");
      let liveAttempt: Awaited<ReturnType<typeof tryWithGlobalLiveExecutionLock<string>>> | undefined;
      let observationError: unknown;

      try {
        const lockState = await waitForExecutionLockState(pool, ({ granted }) => granted === 1);
        expect(lockState.granted).toBe(1);
        liveAttempt = await tryWithGlobalLiveExecutionLock(pool, "live-lock-test", liveCallback);
      } catch (error) {
        observationError = error;
      } finally {
        await auditBlocker.query("ROLLBACK");
        auditBlocker.release();
      }

      const updated = await mutation;
      if (observationError) {
        throw observationError;
      }
      expect(liveAttempt).toEqual({ acquired: false, value: null });
      expect(liveCallback).not.toHaveBeenCalled();
      expect(updated.revision).toBe(1);
    });
  }, 30_000);

  it("allows exactly one concurrent writer for an expected strategy revision", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const current = await getStrategyConfig(pool, "btc");

      const results = await Promise.allSettled([
        updateStrategyConfig(
          pool,
          "btc",
          {
            config: { ...current.config, maxPairNotionalUsd: current.config.maxPairNotionalUsd + 1 },
            expectedRevision: current.revision,
          },
          mutationContext(),
        ),
        updateStrategyConfig(
          pool,
          "btc",
          {
            config: { ...current.config, maxPairNotionalUsd: current.config.maxPairNotionalUsd + 2 },
            expectedRevision: current.revision,
          },
          mutationContext(),
        ),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.any(ConfigurationRevisionConflictError),
      });

      const persisted = await getStrategyConfig(pool, "btc");
      const audit = await pool.query<{ total: string }>(
        "SELECT count(*) AS total FROM configuration_audit_events WHERE configuration_type = 'strategy' AND configuration_key = 'btc'",
      );
      expect(persisted.revision).toBe(1);
      expect(Number(audit.rows[0]?.total)).toBe(1);
    });
  }, 30_000);

  it("keeps no-op writes revision-neutral and advances updated_at monotonically", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const futureUpdatedAt = Date.now() + 60_000;
      await pool.query("UPDATE strategy_configs SET updated_at = $1 WHERE asset = 'btc'", [futureUpdatedAt]);
      const current = await getStrategyConfig(pool, "btc");

      const unchanged = await updateStrategyConfig(
        pool,
        "btc",
        { config: current.config, expectedRevision: current.revision },
        mutationContext(),
      );
      expect(unchanged).toEqual(current);

      const changed = await updateStrategyConfig(
        pool,
        "btc",
        {
          config: { ...current.config, maxPairNotionalUsd: current.config.maxPairNotionalUsd + 1 },
          expectedRevision: current.revision,
        },
        mutationContext(),
      );
      const audit = await pool.query<{ total: string }>("SELECT count(*) AS total FROM configuration_audit_events");
      expect(changed).toMatchObject({ revision: 1, updatedAt: futureUpdatedAt + 1 });
      expect(Number(audit.rows[0]?.total)).toBe(1);
    });
  }, 30_000);

  it("rolls an entire seven-asset update back when one expected revision is stale", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const current = await listStrategyConfigs(pool);
      const updates = Object.fromEntries(
        MARKET_ASSETS.map((asset) => [
          asset,
          {
            config: {
              ...current[asset].config,
              maxPairNotionalUsd:
                asset === "btc"
                  ? current[asset].config.maxPairNotionalUsd + 1
                  : current[asset].config.maxPairNotionalUsd,
            },
            expectedRevision: asset === "doge" ? current[asset].revision + 1 : current[asset].revision,
          },
        ]),
      ) as StrategyConfigMapUpdate;

      await expect(updateStrategyConfigs(pool, updates, mutationContext())).rejects.toBeInstanceOf(
        ConfigurationRevisionConflictError,
      );

      const persisted = await listStrategyConfigs(pool);
      const audit = await pool.query<{ total: string }>("SELECT count(*) AS total FROM configuration_audit_events");
      expect(MARKET_ASSETS.map((asset) => persisted[asset].revision)).toEqual(MARKET_ASSETS.map(() => 0));
      expect(persisted.btc.config.maxPairNotionalUsd).toBe(current.btc.config.maxPairNotionalUsd);
      expect(Number(audit.rows[0]?.total)).toBe(0);
    });
  }, 30_000);

  it("updates only changed rows in one bulk transaction and audits each change", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const current = await listStrategyConfigs(pool);
      const requestId = randomUUID();
      const updates = Object.fromEntries(
        MARKET_ASSETS.map((asset) => [
          asset,
          {
            config: {
              ...current[asset].config,
              maxPairNotionalUsd:
                asset === "btc" || asset === "eth"
                  ? current[asset].config.maxPairNotionalUsd + 1
                  : current[asset].config.maxPairNotionalUsd,
            },
            expectedRevision: current[asset].revision,
          },
        ]),
      ) as StrategyConfigMapUpdate;

      const updated = await updateStrategyConfigs(pool, updates, { actor: "integration-test", requestId });
      expect(updated.btc.revision).toBe(1);
      expect(updated.eth.revision).toBe(1);
      expect(updated.doge.revision).toBe(0);

      const audit = await pool.query<{
        configuration_key: string;
        operation: string;
        request_id: string;
      }>(
        "SELECT configuration_key, operation, request_id::text FROM configuration_audit_events ORDER BY configuration_key",
      );
      expect(audit.rows).toEqual([
        { configuration_key: "btc", operation: "bulk_update", request_id: requestId },
        { configuration_key: "eth", operation: "bulk_update", request_id: requestId },
      ]);
    });
  }, 30_000);

  it("writes seven audit rows with one request id when all strategy configs change", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const current = await listStrategyConfigs(pool);
      const requestId = randomUUID();
      const updates = Object.fromEntries(
        MARKET_ASSETS.map((asset) => [
          asset,
          {
            config: {
              ...current[asset].config,
              maxPairNotionalUsd: current[asset].config.maxPairNotionalUsd + 1,
            },
            expectedRevision: current[asset].revision,
          },
        ]),
      ) as StrategyConfigMapUpdate;

      const updated = await updateStrategyConfigs(pool, updates, { actor: "integration-test", requestId });
      expect(MARKET_ASSETS.map((asset) => updated[asset].revision)).toEqual(MARKET_ASSETS.map(() => 1));

      const audit = await pool.query<{ request_id: string; total: number }>(
        `
          SELECT request_id::text, count(*) AS total
          FROM configuration_audit_events
          GROUP BY request_id
        `,
      );
      expect(audit.rows).toEqual([{ request_id: requestId, total: 7 }]);
    });
  }, 30_000);

  it("rolls every bulk row back when a later audit insert conflicts", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const requestId = randomUUID();
      const initial = await getStrategyConfig(pool, "doge");
      await updateStrategyConfig(
        pool,
        "doge",
        {
          config: { ...initial.config, maxPairNotionalUsd: initial.config.maxPairNotionalUsd + 1 },
          expectedRevision: initial.revision,
        },
        { actor: "integration-test", requestId },
      );
      const before = await listStrategyConfigs(pool);
      const updates = Object.fromEntries(
        MARKET_ASSETS.map((asset) => [
          asset,
          {
            config: {
              ...before[asset].config,
              maxPairNotionalUsd: before[asset].config.maxPairNotionalUsd + 1,
            },
            expectedRevision: before[asset].revision,
          },
        ]),
      ) as StrategyConfigMapUpdate;

      await expect(
        updateStrategyConfigs(pool, updates, { actor: "integration-test", requestId }),
      ).rejects.toMatchObject({ code: "23505" });

      expect(await listStrategyConfigs(pool)).toEqual(before);
      const audit = await pool.query<{ configuration_key: string }>(
        "SELECT configuration_key FROM configuration_audit_events",
      );
      expect(audit.rows).toEqual([{ configuration_key: "doge" }]);
    });
  }, 30_000);

  it("rolls the configuration change back when its audit insert fails", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const initial = await getStrategyConfig(pool, "btc");
      const context = mutationContext();
      const first = await updateStrategyConfig(
        pool,
        "btc",
        {
          config: { ...initial.config, maxPairNotionalUsd: initial.config.maxPairNotionalUsd + 1 },
          expectedRevision: initial.revision,
        },
        context,
      );

      await expect(
        updateStrategyConfig(
          pool,
          "btc",
          {
            config: { ...first.config, maxPairNotionalUsd: first.config.maxPairNotionalUsd + 1 },
            expectedRevision: first.revision,
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "23505" });

      const persisted = await getStrategyConfig(pool, "btc");
      const audit = await pool.query<{ total: string }>("SELECT count(*) AS total FROM configuration_audit_events");
      expect(persisted).toEqual(first);
      expect(Number(audit.rows[0]?.total)).toBe(1);
    });
  }, 30_000);

  it("uses CAS for global risk, emits its run event, and rejects every audit mutation", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const initial = await getGlobalRiskConfig(pool);
      const context = mutationContext();
      const updated = await updateGlobalRiskConfig(
        pool,
        {
          config: {
            ...initial.config,
            clusterExpectedFatalLossCapUsd: initial.config.clusterExpectedFatalLossCapUsd + 1,
          },
          expectedRevision: initial.revision,
        },
        context,
      );
      expect(updated.revision).toBe(1);

      const runEvents = await pool.query<{
        level: string;
        event_type: string;
        message: string;
        payload_json: Record<string, unknown>;
      }>(
        `
          SELECT level, event_type, message, payload_json
          FROM run_events
          WHERE event_type = 'risk.global_config.updated'
        `,
      );
      expect(runEvents.rows).toEqual([
        {
          level: "warn",
          event_type: "risk.global_config.updated",
          message: "Global mismatch risk configuration updated",
          payload_json: {
            requestId: context.requestId,
            actor: context.actor,
            previousRevision: initial.revision,
            nextRevision: updated.revision,
            previous: initial.config,
            updated: updated.config,
          },
        },
      ]);

      await expect(
        updateGlobalRiskConfig(pool, { config: initial.config, expectedRevision: initial.revision }, mutationContext()),
      ).rejects.toBeInstanceOf(ConfigurationRevisionConflictError);
      await expect(pool.query("UPDATE configuration_audit_events SET actor = 'mutated'")).rejects.toMatchObject({
        code: "55000",
      });
      await expect(pool.query("DELETE FROM configuration_audit_events")).rejects.toMatchObject({ code: "55000" });
      await expect(pool.query("TRUNCATE configuration_audit_events")).rejects.toMatchObject({ code: "55000" });
    });
  }, 30_000);

  it("rolls global risk, audit, and observability back together when the run event fails", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await pool.query(`
        CREATE FUNCTION reject_global_risk_run_event()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $test$
        BEGIN
          IF NEW.event_type = 'risk.global_config.updated' THEN
            RAISE EXCEPTION 'run event rejected for test' USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END;
        $test$;

        CREATE TRIGGER reject_global_risk_run_event
        BEFORE INSERT ON run_events
        FOR EACH ROW EXECUTE FUNCTION reject_global_risk_run_event();
      `);
      const initial = await getGlobalRiskConfig(pool);

      await expect(
        updateGlobalRiskConfig(
          pool,
          {
            config: {
              ...initial.config,
              clusterExpectedFatalLossCapUsd: initial.config.clusterExpectedFatalLossCapUsd + 1,
            },
            expectedRevision: initial.revision,
          },
          mutationContext(),
        ),
      ).rejects.toMatchObject({ code: "55000" });

      expect(await getGlobalRiskConfig(pool)).toEqual(initial);
      const counts = await pool.query<{ audits: number; run_events: number }>(`
        SELECT
          (SELECT count(*) FROM configuration_audit_events) AS audits,
          (SELECT count(*) FROM run_events WHERE event_type = 'risk.global_config.updated') AS run_events
      `);
      expect(counts.rows[0]).toEqual({ audits: 0, run_events: 0 });
    });
  }, 30_000);

  it("does not duplicate a global-risk run event for an existing request id", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const initial = await getGlobalRiskConfig(pool);
      const context = mutationContext();
      await pool.query(
        `
          INSERT INTO run_events (asset, level, event_type, message, payload_json, created_at)
          VALUES (NULL, 'warn', 'risk.global_config.updated', 'existing event', $1::jsonb, $2)
        `,
        [JSON.stringify({ requestId: context.requestId }), Date.now()],
      );

      const updated = await updateGlobalRiskConfig(
        pool,
        {
          config: {
            ...initial.config,
            clusterExpectedFatalLossCapUsd: initial.config.clusterExpectedFatalLossCapUsd + 1,
          },
          expectedRevision: initial.revision,
        },
        context,
      );

      expect(updated.revision).toBe(1);
      const result = await pool.query<{ total: number }>(
        `
          SELECT count(*) AS total
          FROM run_events
          WHERE event_type = 'risk.global_config.updated'
            AND payload_json->>'requestId' = $1
        `,
        [context.requestId],
      );
      expect(result.rows[0]?.total).toBe(1);
    });
  }, 30_000);

  it("fails closed when required strategy or global-risk rows are missing", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const strategy = await getStrategyConfig(pool, "hype");
      const globalRisk = await getGlobalRiskConfig(pool);
      await pool.query("DELETE FROM strategy_configs WHERE asset = 'hype'");
      await pool.query("DELETE FROM global_risk_config WHERE id = 1");

      await expect(getStrategyConfig(pool, "hype")).rejects.toThrow("Missing strategy configuration for hype");
      await expect(listStrategyConfigs(pool)).rejects.toThrow("Invalid strategy configuration set");
      await expect(
        updateStrategyConfig(
          pool,
          "hype",
          { config: strategy.config, expectedRevision: strategy.revision },
          mutationContext(),
        ),
      ).rejects.toThrow("Missing strategy configuration for hype");
      await expect(getGlobalRiskConfig(pool)).rejects.toThrow("Missing global risk configuration");
      await expect(
        updateGlobalRiskConfig(
          pool,
          { config: globalRisk.config, expectedRevision: globalRisk.revision },
          mutationContext(),
        ),
      ).rejects.toThrow("Missing global risk configuration");

      const counts = await pool.query<{ strategies: number; global_risk: number; audits: number }>(`
        SELECT
          (SELECT count(*) FROM strategy_configs) AS strategies,
          (SELECT count(*) FROM global_risk_config) AS global_risk,
          (SELECT count(*) FROM configuration_audit_events) AS audits
      `);
      expect(counts.rows[0]).toEqual({ strategies: 6, global_risk: 0, audits: 0 });
    });
  }, 30_000);

  it("rejects an invalid stored global-risk revision in the joined execution read", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await pool.query("ALTER TABLE global_risk_config DROP CONSTRAINT global_risk_config_revision_nonnegative");
      await pool.query("UPDATE global_risk_config SET revision = -1 WHERE id = 1");

      await expect(getExecutionConfiguration(pool, "btc")).rejects.toThrow(
        "Invalid stored global_risk configuration revision for global: -1",
      );
    });
  }, 30_000);
});

function mutationContext(): ConfigurationMutationContext {
  return { actor: "integration-test", requestId: randomUUID() };
}

async function withIsolatedSchema(run: (pool: Pool) => Promise<void>) {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const schema = `warbitrer_configuration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 4,
    application_name: schema,
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

async function waitForExecutionLockState(
  pool: Pool,
  predicate: (state: { granted: number; waiting: number }) => boolean,
) {
  const deadline = Date.now() + 5_000;
  let lastState = { granted: 0, waiting: 0 };
  do {
    const result = await pool.query<{ granted: number; waiting: number }>(
      `
        SELECT
          count(*) FILTER (WHERE locks.granted)::integer AS granted,
          count(*) FILTER (WHERE NOT locks.granted)::integer AS waiting
        FROM pg_locks locks
        JOIN pg_stat_activity activity ON activity.pid = locks.pid
        WHERE locks.locktype = 'advisory'
          AND locks.classid = $1::oid
          AND locks.objid = $2::oid
          AND locks.objsubid = 2
          AND activity.application_name = current_setting('application_name')
      `,
      [4_298, 2],
    );
    lastState = {
      granted: Number(result.rows[0]?.granted ?? 0),
      waiting: Number(result.rows[0]?.waiting ?? 0),
    };
    if (predicate(lastState)) {
      return lastState;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);

  throw new Error(`Timed out waiting for configuration execution lock state: ${JSON.stringify(lastState)}`);
}
