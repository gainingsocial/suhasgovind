import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema/index.js';

/**
 * Database connectivity (ADR-003).
 *
 * Workers reach Supabase Postgres through Hyperdrive, which pools connections at the
 * edge. Node tooling (migrations, integration tests) connects directly. The driver
 * interface is identical either way, so repositories never know which they are on.
 */

export type Database = ReturnType<typeof createDatabase>;
export type Sql = postgres.Sql;

export interface DatabaseHandle {
  db: Database;
  sql: Sql;
  /** Close the pool. Never call this in a Worker — the runtime manages the lifecycle. */
  close: () => Promise<void>;
}

export interface CreateDatabaseOptions {
  connectionString: string;
  /**
   * Keep small. Each Worker isolate gets its own pool, and Hyperdrive already pools
   * upstream — a large per-isolate pool multiplies into connection exhaustion.
   */
  max?: number;
  /** Seconds before an idle connection is closed. */
  idleTimeout?: number;
  /** Seconds to wait for a connection before failing fast. */
  connectTimeout?: number;
  /** Set false in Workers; prepared statements do not survive a pooled connection. */
  prepare?: boolean;
}

function createDatabase(sql: Sql) {
  return drizzle(sql, { schema, casing: 'snake_case' });
}

export function createDatabaseHandle(options: CreateDatabaseOptions): DatabaseHandle {
  const sql = postgres(options.connectionString, {
    max: options.max ?? 5,
    idle_timeout: options.idleTimeout ?? 20,
    connect_timeout: options.connectTimeout ?? 10,
    // Hyperdrive and Supabase's pooler both multiplex, so a prepared statement created on
    // one physical connection may not exist on the next. Disabling them avoids
    // "prepared statement does not exist" under load.
    prepare: options.prepare ?? false,
    // Skips the type-introspection round trip on every cold start. We do not use custom
    // Postgres types, so there is nothing to introspect.
    fetch_types: false,
    // The driver must never print a query containing credentials.
    debug: false,
    onnotice: () => {},
  });

  return {
    sql,
    db: createDatabase(sql),
    close: () => sql.end({ timeout: 5 }),
  };
}

/** Minimal shape of a Cloudflare Hyperdrive binding. */
export interface HyperdriveBinding {
  connectionString: string;
}

/**
 * Build a handle from a Worker environment.
 *
 * Prefers the Hyperdrive binding and falls back to `DATABASE_URL` for `wrangler dev`
 * without Hyperdrive configured, and for Node-side tooling.
 */
export function createDatabaseFromEnv(env: {
  HYPERDRIVE?: HyperdriveBinding;
  DATABASE_URL?: string;
}): DatabaseHandle {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      'No database connection configured. Bind HYPERDRIVE or set DATABASE_URL (see .env.example).',
    );
  }

  return createDatabaseHandle({ connectionString });
}

export { schema };
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
