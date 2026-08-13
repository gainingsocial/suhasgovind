#!/usr/bin/env node
/**
 * Lint and test the WordPress plugin.
 *
 *   node scripts/check-wordpress-plugin.mjs
 *
 * Part of `pnpm run ci` rather than a separate GitHub workflow job, which means it also
 * runs on a developer's machine before anything is pushed — the plugin is the one part of
 * this repository the TypeScript toolchain cannot see at all, so without this it had no
 * automated verification of any kind.
 *
 * PHP is preinstalled on GitHub's Ubuntu runners, so nothing needs provisioning there. On
 * a machine without PHP this skips rather than fails, because a Windows checkout has no
 * reason to carry a PHP runtime — but it refuses to skip under CI, so the check can never
 * quietly stop running where it matters.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginDir = `${root}integrations/wordpress`;

/** The PHP binary, or null when there is none. `PHP_BINARY` allows a portable build. */
function findPhp() {
  for (const candidate of [process.env.PHP_BINARY, 'php'].filter(Boolean)) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

const php = findPhp();

if (!php) {
  // `CI` is set by GitHub Actions and essentially every other runner.
  if (process.env.CI) {
    console.error('No PHP found, and this is CI. The WordPress plugin would go unchecked.');
    console.error('Install PHP on the runner, or set PHP_BINARY.');
    process.exit(1);
  }

  console.log('WordPress plugin: skipped — no PHP on this machine (it runs in CI).');
  process.exit(0);
}

const version = execFileSync(php, ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8' }).trim();

const files = [
  `${pluginDir}/gainingsocial.php`,
  ...readdirSync(`${pluginDir}/includes`)
    .filter((name) => name.endsWith('.php'))
    .sort()
    .map((name) => `${pluginDir}/includes/${name}`),
];

console.log(`WordPress plugin: PHP ${version}`);

for (const file of files) {
  try {
    execFileSync(php, ['-l', file], { stdio: 'pipe' });
  } catch (error) {
    console.error(`  syntax error in ${file}`);
    console.error(String(error.stdout ?? error.message));
    process.exit(1);
  }
}

console.log(`  ${files.length} files parse`);

try {
  const output = execFileSync(php, [`${pluginDir}/tests/test-plugin.php`], { encoding: 'utf8' });
  // Only the summary line, so `pnpm run ci` output stays readable. The full run is
  // available by invoking the test file directly.
  console.log(`  ${output.trim().split('\n').pop()}`);
} catch (error) {
  console.error(String(error.stdout ?? error.message));
  process.exit(1);
}
