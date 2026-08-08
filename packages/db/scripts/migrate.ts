#!/usr/bin/env node
/**
 * Apply pending migrations (Rule 7: every DB change gets a migration, and an applied
 * migration is never edited).
 *
 * Two transports, one algorithm:
 *
 *   DATABASE_URL                             direct Postgres connection — local Supabase,
 *                                            CI, anything we hold the password for.
 *   SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN
 *                                            Supabase Management API, for hosted projects
 *                                            where we hold a management token but not the
 *                                            database password.
 *
 * Bookkeeping is deliberately byte-compatible with drizzle-orm's own migrator —
 * `drizzle.__drizzle_migrations` (id / hash / created_at), where `hash` is the sha256 of
 * the migration file and `created_at` is the journal's `when`. A migration applied over
 * one transport is therefore seen as applied by the other, so adding DATABASE_URL later
 * does not re-run anything.
 *
 * Management API query endpoint:
 *   https://supabase.com/docs/reference/api/v1-run-a-query
 * Multi-statement bodies and explicit BEGIN/COMMIT were verified against the live
 * endpoint before this script was written — each migration is applied as one transaction.
 *
 * Usage:
 *   node --experimental-strip-types scripts/migrate.ts [--dry-run]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readMigrationFiles } from 'drizzle-orm/migrator';

/** Matches drizzle's defaults. Changing either orphans the existing ledger. */
const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';

type Row = Record<string, unknown>;

interface Executor {
  /** Safe to log — never contains a credential (P9). */
  readonly transport: string;
  /** Runs SQL that may hold several statements; resolves with the final result set. */
  exec: (sql: string) => Promise<Row[]>;
  close: () => Promise<void>;
}

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/** Host and database only — the password must never reach a log line (P9). */
function describeTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `direct connection to ${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return 'direct connection to the configured host';
  }
}

function createManagementExecutor(projectRef: string, accessToken: string): Executor {
  const endpoint = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;

  return {
    transport: `Supabase Management API (project ${projectRef})`,
    async exec(query) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });

      const body = await response.text();
      if (!response.ok) {
        // The body carries the Postgres error. The request headers held the token, so
        // only the response is ever surfaced.
        throw new Error(`Management API responded ${response.status}: ${body}`);
      }

      const parsed: unknown = body ? JSON.parse(body) : [];
      return Array.isArray(parsed) ? (parsed as Row[]) : [];
    },
    close: () => Promise.resolve(),
  };
}

async function createDirectExecutor(connectionString: string): Promise<Executor> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    fetch_types: false,
    onnotice: () => {},
  });

  return {
    transport: describeTarget(connectionString),
    exec: async (query) => (await sql.unsafe(query)) as unknown as Row[],
    close: () => sql.end({ timeout: 5 }),
  };
}

/**
 * Rule 14: when the environment is ambiguous, fail with an error that says what to set
 * rather than guessing at a target database.
 */
async function resolveExecutor(): Promise<Executor> {
  const { DATABASE_URL, SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN } = process.env;

  if (DATABASE_URL) return createDirectExecutor(DATABASE_URL);
  if (SUPABASE_PROJECT_REF && SUPABASE_ACCESS_TOKEN) {
    return createManagementExecutor(SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN);
  }

  throw new Error(
    'No migration target configured. Set DATABASE_URL, or set both SUPABASE_PROJECT_REF ' +
      'and SUPABASE_ACCESS_TOKEN to migrate a hosted project. See .env.example.',
  );
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const migrationsFolder = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'migrations',
  );

  // readMigrationFiles walks journal.entries in order, so index i of both lists is the
  // same migration. The journal is the only place the human-readable tag lives.
  const migrations = readMigrationFiles({ migrationsFolder });
  const journal = JSON.parse(
    await readFile(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };

  const executor = await resolveExecutor();
  console.log(`Target: ${executor.transport}`);

  try {
    await executor.exec(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}";`);
    await executor.exec(
      `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (
         id SERIAL PRIMARY KEY,
         hash text NOT NULL,
         created_at bigint
       );`,
    );

    const applied = await executor.exec(
      `SELECT created_at FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"
       ORDER BY created_at DESC LIMIT 1;`,
    );
    // Drizzle compares against the newest applied timestamp rather than tracking each
    // migration individually — mirrored here so both transports agree on what is pending.
    const [latest] = applied;
    const lastAppliedAt = latest ? Number(latest.created_at) : null;

    // readMigrationFiles walks the journal in order, so index i lines up with entry i.
    const pending = migrations
      .map((migration, index) => ({ migration, tag: journal.entries[index]?.tag ?? 'unknown' }))
      .filter(({ migration }) => lastAppliedAt === null || lastAppliedAt < migration.folderMillis);

    if (pending.length === 0) {
      console.log('Already up to date — no pending migrations.');
      return;
    }

    console.log(`${pending.length} pending migration(s):`);
    for (const { migration, tag } of pending) {
      console.log(`  - ${tag} (${migration.sql.length} statement(s))`);
    }

    if (dryRun) {
      console.log('\n--dry-run: nothing was applied.');
      return;
    }

    for (const { migration, tag } of pending) {
      process.stdout.write(`Applying ${tag} ... `);

      // One transaction per migration: on failure Postgres aborts it and the trailing
      // COMMIT degrades to a rollback, so a migration can never land half-applied.
      // `hash` is hex and `folderMillis` a number, so neither can break out of the literal.
      await executor.exec(
        [
          'BEGIN;',
          migration.sql.join('\n'),
          `INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" ("hash", "created_at")
           VALUES ('${migration.hash}', ${migration.folderMillis});`,
          'COMMIT;',
        ].join('\n'),
      );

      console.log('done');
    }

    console.log(`\nApplied ${pending.length} migration(s).`);
  } finally {
    await executor.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
