import { mkdirSync } from "node:fs";
import path from "node:path";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { migrations } from "./migrations.generated";

/**
 * One schema, two engines.
 *
 *  - DATABASE_URL set: node-postgres against any Postgres (Neon, Supabase, RDS).
 *  - otherwise: PGlite, a real Postgres compiled to WASM, stored in ./.data.
 *
 * Local development, CI and the test suite therefore run the same SQL dialect as
 * production with nothing to install. Migrations are bundled as code and applied on
 * first use under an advisory lock, so a fresh deploy needs no separate migrate step.
 */

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

type RawQuery = (sql: string) => Promise<{ rows: any[] }>;

const globalRef = globalThis as unknown as { __onfileDb?: Promise<Db>; __onfileClose?: () => Promise<void> };

async function applyMigrations(tx: RawQuery, lock: boolean) {
  if (lock) await tx("SELECT pg_advisory_xact_lock(742600119)");
  await tx("CREATE TABLE IF NOT EXISTS _migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await tx("SELECT id FROM _migrations")).rows.map((r) => r.id as string));
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    for (const statement of m.statements) await tx(statement);
    await tx(`INSERT INTO _migrations (id) VALUES ('${m.id.replace(/'/g, "''")}')`);
  }
}

async function init(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX ?? 5), idleTimeoutMillis: 20_000 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await applyMigrations((q) => client.query(q), true);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    globalRef.__onfileClose = () => pool.end();
    return drizzle(pool, { schema });
  }

  if (process.env.VERCEL) {
    throw new Error("DATABASE_URL is not set. Add a Postgres database (for example Neon) to this deployment.");
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  let dataDir: string | undefined;
  if (process.env.ONFILE_DB !== "memory") {
    dataDir = path.join(process.cwd(), ".data", "pg");
    mkdirSync(dataDir, { recursive: true });
  }
  const client = new PGlite(dataDir);
  await client.waitReady;
  await client.transaction(async (tx) => {
    await applyMigrations((q) => tx.query(q) as Promise<{ rows: any[] }>, false);
  });
  globalRef.__onfileClose = () => client.close();
  return drizzle(client, { schema }) as unknown as Db;
}

export function getDb(): Promise<Db> {
  if (!globalRef.__onfileDb) {
    globalRef.__onfileDb = init().catch((err) => {
      globalRef.__onfileDb = undefined;
      throw err;
    });
  }
  return globalRef.__onfileDb;
}

/** Test helper: drop the in-memory database so each suite starts clean. */
export async function resetDb() {
  if (globalRef.__onfileDb) {
    await globalRef.__onfileDb.catch(() => {});
    await globalRef.__onfileClose?.().catch(() => {});
  }
  globalRef.__onfileDb = undefined;
  globalRef.__onfileClose = undefined;
}

export { schema };
