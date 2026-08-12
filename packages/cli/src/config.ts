import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Stored credentials.
 *
 * An API key is a bearer credential with full access to a tenant's publishing, so the file
 * is written 0600 and lives under the user's home directory rather than in the working
 * directory — a config file in a project folder gets committed eventually.
 *
 * `GS_API_KEY` in the environment always wins. CI has no home directory worth writing to,
 * and an environment variable is what a pipeline can inject.
 */

export interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
}

const CONFIG_DIR = path.join(homedir(), '.gainingsocial');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export async function readConfig(): Promise<StoredConfig> {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as StoredConfig;
  } catch {
    // Absent or unreadable is not an error — it is the state before `gs auth login`.
    return {};
  }
}

export async function writeConfig(config: StoredConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // Set explicitly as well as on create: an existing file keeps its old mode, so a config
  // written before this rule existed would stay world-readable.
  await chmod(CONFIG_FILE, 0o600);
}

export async function clearConfig(): Promise<void> {
  await rm(CONFIG_FILE, { force: true });
}

export function configPath(): string {
  return CONFIG_FILE;
}

export interface ResolvedCredentials {
  apiKey: string;
  baseUrl: string | undefined;
  source: 'environment' | 'config';
}

/**
 * Resolve the key to use, environment first.
 *
 * Reporting which source won matters: "why is it publishing to the wrong account" is
 * almost always a stale `GS_API_KEY` shadowing the file, and that is invisible unless the
 * CLI says so.
 */
export async function resolveCredentials(overrideKey?: string): Promise<ResolvedCredentials> {
  const config = await readConfig();
  const baseUrl = process.env.GS_BASE_URL ?? config.baseUrl;

  if (overrideKey) return { apiKey: overrideKey, baseUrl, source: 'environment' };

  const fromEnv = process.env.GS_API_KEY;
  if (fromEnv) return { apiKey: fromEnv, baseUrl, source: 'environment' };

  if (config.apiKey) return { apiKey: config.apiKey, baseUrl, source: 'config' };

  throw new Error(
    'No API key. Run `gs auth login --key sk_test_...`, or set GS_API_KEY in the environment.',
  );
}
