import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { GainingSocial, type CreatePostRequest, type MeResponse } from '@gs/sdk';

import { boolFlag, optionalFlag, requireFlag, UsageError, type ParsedArgs } from './args.js';
import { clearConfig, configPath, readConfig, resolveCredentials, writeConfig } from './config.js';
import { print, printJson, statusLabel, style, table, truncate, warn } from './output.js';

/**
 * Command implementations (plan Phase 3, CLI).
 *
 * Each takes the already-parsed arguments and a client. Nothing here calls `process.exit`
 * — a command either returns or throws, and the entry point owns the exit code. A command
 * that exits directly cannot be tested and cannot be composed.
 */

export interface CommandContext {
  args: ParsedArgs;
  json: boolean;
}

async function client(args: ParsedArgs): Promise<GainingSocial> {
  const { apiKey, baseUrl } = await resolveCredentials(optionalFlag(args, 'key'));
  return new GainingSocial({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    appName: 'gs-cli',
  });
}

/** Read a request body from a file, or from stdin when the path is `-`. */
async function readBody(file: string): Promise<unknown> {
  const raw =
    file === '-'
      ? await new Promise<string>((resolve, reject) => {
          let data = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (chunk) => (data += chunk));
          process.stdin.on('end', () => resolve(data));
          process.stdin.on('error', reject);
        })
      : await readFile(path.resolve(file), 'utf8');

  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`${file} is not valid JSON.`);
  }
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

export async function authCommand({ args, json }: CommandContext): Promise<void> {
  const sub = args.positionals[0] ?? 'whoami';

  if (sub === 'login') {
    const key = requireFlag(args, 'key');
    if (!key.startsWith('sk_test_') && !key.startsWith('sk_live_')) {
      // Catching this here beats a 401 that reads like the key is wrong when it is
      // actually a session token or a truncated paste.
      throw new UsageError('An API key starts with `sk_test_` or `sk_live_`.');
    }

    const existing = await readConfig();
    // Resolved the same way as every other command — flag, then GS_BASE_URL, then the
    // stored value. Reading only the flag here would verify the key against production
    // while every subsequent command talked to staging, and store a key that does not
    // work there.
    const baseUrl = optionalFlag(args, 'base-url') ?? process.env.GS_BASE_URL ?? existing.baseUrl;

    // Verified before it is stored. Writing an unusable key and failing on the next
    // command would make the failure look unrelated to logging in.
    const gs = new GainingSocial({ apiKey: key, ...(baseUrl ? { baseUrl } : {}), appName: 'gs-cli' });
    const me = await gs.identity.me();

    await writeConfig({ ...existing, apiKey: key, ...(baseUrl ? { baseUrl } : {}) });

    if (json) return printJson(me);
    print(`${style.green('Signed in.')} Key stored in ${style.dim(configPath())}`);
    printIdentity(me);
    return;
  }

  if (sub === 'logout') {
    await clearConfig();
    print(`${style.green('Signed out.')} Removed ${style.dim(configPath())}`);
    if (process.env.GS_API_KEY) {
      // Otherwise the next command still works and looks like logout did nothing.
      warn(style.yellow('GS_API_KEY is still set in your environment and will continue to be used.'));
    }
    return;
  }

  if (sub === 'whoami') {
    const { source } = await resolveCredentials(optionalFlag(args, 'key'));
    const me = await (await client(args)).identity.me();
    if (json) return printJson(me);

    printIdentity(me);
    print(style.dim(`Key from ${source === 'environment' ? 'GS_API_KEY' : configPath()}`));
    return;
  }

  throw new UsageError(`Unknown auth command "${sub}". Try login, logout or whoami.`);
}

function printIdentity(me: MeResponse): void {
  print(`${style.bold('Project')}      ${me.project_id}`);
  // The single most useful line: publishing to live when you meant test is not recoverable.
  print(
    `${style.bold('Environment')}  ${me.environment === 'live' ? style.red(me.environment) : style.green(me.environment)}`,
  );
  print(`${style.bold('Scopes')}       ${me.scopes.join(', ')}`);
  if (me.restricted_to_profile_id) {
    print(`${style.bold('Restricted')}   ${me.restricted_to_profile_id}`);
  }
}

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

export async function profilesCommand({ args, json }: CommandContext): Promise<void> {
  const gs = await client(args);
  const sub = args.positionals[0] ?? 'list';

  if (sub === 'list') {
    const page = await gs.profiles.list({ limit: Number(optionalFlag(args, 'limit') ?? 25) });
    if (json) return printJson(page);

    table(
      ['ID', 'NAME', 'EXTERNAL ID', 'TIMEZONE'],
      page.data.map((p) => [p.id, truncate(p.name, 30), p.external_id ?? '—', p.timezone]),
    );
    if (page.has_more) print(style.dim(`\nMore results. Next cursor: ${page.next_cursor}`));
    return;
  }

  if (sub === 'create') {
    const profile = await gs.profiles.create({
      name: requireFlag(args, 'name'),
      ...(optionalFlag(args, 'external-id') ? { external_id: optionalFlag(args, 'external-id')! } : {}),
      ...(optionalFlag(args, 'timezone') ? { timezone: optionalFlag(args, 'timezone')! } : {}),
    } as never);

    if (json) return printJson(profile);
    print(`${style.green('Created')} ${profile.id}  ${profile.name}`);
    return;
  }

  throw new UsageError(`Unknown profiles command "${sub}". Try list or create.`);
}

// ---------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------

export async function connectionsCommand({ args, json }: CommandContext): Promise<void> {
  const gs = await client(args);
  const sub = args.positionals[0] ?? 'list';

  if (sub === 'list') {
    const page = await gs.connections.list({
      ...(optionalFlag(args, 'profile') ? { profile_id: optionalFlag(args, 'profile')! } : {}),
      limit: Number(optionalFlag(args, 'limit') ?? 25),
    });
    if (json) return printJson(page);

    table(
      ['ID', 'PROVIDER', 'ACCOUNT', 'HEALTH', 'SETUP'],
      page.data.map((c) => [
        c.id,
        c.provider,
        truncate(c.provider_account_name ?? '—', 28),
        statusLabel(c.health),
        // The field that explains "connected but nothing publishes": a connection with
        // several destinations stays unusable until one is chosen.
        c.setup_completed_at === null ? style.yellow('destination needed') : 'ready',
      ]),
    );
    return;
  }

  if (sub === 'destinations') {
    const connectionId = args.positionals[1];
    if (!connectionId) throw new UsageError('Usage: gs connections destinations <connection_id>');

    const page = await gs.connections.destinations(connectionId);
    if (json) return printJson(page);

    table(
      ['ID', 'NAME', 'TYPE', 'SELECTED'],
      page.data.map((d) => [
        d.id,
        truncate(d.name, 34),
        d.destination_type,
        d.selected ? style.green('yes') : style.dim('no'),
      ]),
    );
    return;
  }

  if (sub === 'disconnect') {
    const connectionId = args.positionals[1];
    if (!connectionId) throw new UsageError('Usage: gs connections disconnect <connection_id>');

    const result = await gs.connections.disconnect(connectionId);
    if (json) return printJson(result);
    print(`${style.green('Disconnected')} ${connectionId}`);
    if (!result.revoked_at_provider) {
      // Saying which happened is more useful than implying success.
      warn(style.dim('The provider did not confirm revocation; access may persist until revoked there.'));
    }
    return;
  }

  throw new UsageError(`Unknown connections command "${sub}". Try list, destinations or disconnect.`);
}

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

export async function mediaCommand({ args, json }: CommandContext): Promise<void> {
  const gs = await client(args);
  const sub = args.positionals[0] ?? 'upload';

  if (sub === 'upload') {
    const file = args.positionals[1];
    if (!file) throw new UsageError('Usage: gs media upload <file> --profile pro_...');

    const profileId = requireFlag(args, 'profile');
    const bytes = await readFile(path.resolve(file));
    const filename = path.basename(file);

    const media = await gs.media.upload(new Uint8Array(bytes), {
      profile_id: profileId,
      filename,
      mime_type: optionalFlag(args, 'type') ?? guessMimeType(filename),
      ...(optionalFlag(args, 'alt') ? { alt_text: optionalFlag(args, 'alt')! } : {}),
    });

    if (json) return printJson(media);
    print(`${style.green('Uploaded')} ${media.id}  ${filename}  ${statusLabel(media.status)}`);
    if (media.status !== 'ready') {
      // Probing runs after the bytes land; attaching too early is a retryable error.
      print(style.dim('Still being probed. Attach it once it reports ready.'));
    }
    return;
  }

  if (sub === 'get') {
    const mediaId = args.positionals[1];
    if (!mediaId) throw new UsageError('Usage: gs media get <media_id>');
    const media = await gs.media.get(mediaId);
    if (json) return printJson(media);
    print(`${media.id}  ${statusLabel(media.status)}  ${media.mime_type ?? '—'}`);
    return;
  }

  throw new UsageError(`Unknown media command "${sub}". Try upload or get.`);
}

/**
 * Guess a MIME type from the extension.
 *
 * Only a default — the API probes the real file server-side and validates against that,
 * so a wrong guess here is corrected rather than believed.
 */
function guessMimeType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  const types: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
  };
  const guess = types[extension];
  if (!guess) {
    throw new UsageError(
      `Cannot infer a media type from "${filename}". Pass --type, e.g. --type image/jpeg.`,
    );
  }
  return guess;
}

// ---------------------------------------------------------------------------
// preflight and post
// ---------------------------------------------------------------------------

/** Build a post body from flags, or read it whole from a file. */
async function postBody(args: ParsedArgs): Promise<CreatePostRequest> {
  const file = optionalFlag(args, 'file', 'f');
  if (file) return (await readBody(file)) as CreatePostRequest;

  const text = optionalFlag(args, 'text');
  const destinations = optionalFlag(args, 'destination', 'd');

  if (!text && !destinations) {
    throw new UsageError(
      'Supply --file post.json, or --text and --destination. Use --file - to read stdin.',
    );
  }

  return {
    profile_id: requireFlag(args, 'profile'),
    content: { text: text ?? '', media_ids: (optionalFlag(args, 'media') ?? '').split(',').filter(Boolean) },
    targets: (destinations ?? '')
      .split(',')
      .filter(Boolean)
      .map((destination_id) => ({ destination_id })),
    ...(optionalFlag(args, 'at') ? { publish_at: optionalFlag(args, 'at')! } : {}),
  } as CreatePostRequest;
}

export async function preflightCommand({ args, json }: CommandContext): Promise<boolean> {
  const gs = await client(args);
  const result = await gs.posts.preflight(await postBody(args));

  if (json) {
    printJson(result);
    return result.valid;
  }

  for (const target of result.targets) {
    const verdict = target.valid ? style.green('ok') : style.red('blocked');
    print(`${verdict}  ${target.provider}  ${style.dim(target.destination_id)}`);

    for (const error of target.errors) {
      print(`      ${style.red(error.code)} ${error.message}`);
      // The machine-readable next step is the whole point of the finding; a human
      // reading it still benefits from being told what to change.
      print(style.dim(`      → ${error.agent_action}`));
    }
    for (const warning of target.warnings) {
      print(`      ${style.yellow(warning.code)} ${warning.message}`);
    }
  }

  print(result.valid ? style.green('\nReady to publish.') : style.red('\nNot publishable as composed.'));
  return result.valid;
}

export async function postCommand({ args, json }: CommandContext): Promise<void> {
  const gs = await client(args);
  const sub = args.positionals[0];

  if (sub === 'get') {
    const postId = args.positionals[1];
    if (!postId) throw new UsageError('Usage: gs post get <post_id>');

    const post = await gs.posts.get(postId);
    if (json) return printJson(post);

    print(`${style.bold(post.id)}  ${statusLabel(post.status)}`);
    print(style.dim(post.created_at));
    print('');
    table(
      ['TARGET', 'PROVIDER', 'STATUS', 'ATTEMPTS', 'URL'],
      post.targets.map((t) => [
        t.id,
        t.provider,
        statusLabel(t.status),
        String(t.attempt_count),
        t.external_url ?? (t.error_code ? style.red(t.error_code) : '—'),
      ]),
    );
    return;
  }

  if (sub === 'list') {
    const page = await gs.posts.list({
      ...(optionalFlag(args, 'profile') ? { profile_id: optionalFlag(args, 'profile')! } : {}),
      ...(optionalFlag(args, 'status') ? { status: optionalFlag(args, 'status')! } : {}),
      limit: Number(optionalFlag(args, 'limit') ?? 25),
    });
    if (json) return printJson(page);

    table(
      ['ID', 'STATUS', 'CREATED', 'TEXT'],
      page.data.map((p) => [
        p.id,
        statusLabel(p.status),
        p.created_at.slice(0, 16).replace('T', ' '),
        truncate(p.content.text, 40),
      ]),
    );
    return;
  }

  if (sub === 'cancel') {
    const postId = args.positionals[1];
    if (!postId) throw new UsageError('Usage: gs post cancel <post_id>');
    const post = await gs.posts.cancel(postId);
    if (json) return printJson(post);
    print(`${style.green('Cancelled')} ${post.id}`);
    return;
  }

  if (sub === 'retry') {
    const postId = args.positionals[1];
    if (!postId) throw new UsageError('Usage: gs post retry <post_id> [target_id]');
    const targetId = args.positionals[2];

    const post = targetId
      ? await gs.posts.retryTarget(postId, targetId)
      : await gs.posts.retry(postId);
    if (json) return printJson(post);
    print(`${style.green('Retrying')} ${post.id}${targetId ? ` target ${targetId}` : ''}`);
    return;
  }

  // No subcommand: publish.
  const body = await postBody(args);

  if (!boolFlag(args, 'skip-preflight')) {
    // Publishing is the one irreversible act here, so the safe order is the default and
    // skipping the check is the deliberate flag.
    const check = await gs.posts.preflight(body);
    if (!check.valid) {
      warn(style.red('Preflight failed. Nothing was published.'));
      for (const target of check.targets.filter((t) => !t.valid)) {
        for (const error of target.errors) {
          warn(`  ${target.provider}: ${error.code} ${error.message}`);
        }
      }
      throw new Error('Preflight failed.');
    }
  }

  const post = await gs.posts.create(body, {
    ...(optionalFlag(args, 'idempotency-key')
      ? { idempotencyKey: optionalFlag(args, 'idempotency-key')! }
      : {}),
  });

  if (json) return printJson(post);
  print(`${style.green('Queued')} ${post.id}  ${statusLabel(post.status)}`);
  // Nothing is published yet. Saying so avoids the reasonable assumption that a
  // successful command means a live post.
  print(style.dim(`Publishing happens in the background. Watch it with: gs logs ${post.id}`));
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

export async function logsCommand({ args, json }: CommandContext): Promise<void> {
  const gs = await client(args);
  const postId = args.positionals[0];
  if (!postId) throw new UsageError('Usage: gs logs <post_id>');

  const timeline = await gs.posts.timeline(postId);
  if (json) return printJson(timeline);

  if (timeline.events.length === 0) {
    print(style.dim('No events yet.'));
    return;
  }

  for (const event of timeline.events) {
    const when = event.at.slice(0, 19).replace('T', ' ');
    const scope = event.provider ?? 'post';
    print(`${style.dim(when)}  ${style.bold(scope.padEnd(10))}  ${event.type}`);
    if (event.message) print(`${' '.repeat(21)}${event.message}`);
  }
}

// ---------------------------------------------------------------------------
// platforms
// ---------------------------------------------------------------------------

export async function platformsCommand({ args, json }: CommandContext): Promise<void> {
  const gs = await client(args);
  const sub = args.positionals[0] ?? 'list';

  if (sub === 'list') {
    const page = await gs.platforms.list();
    if (json) return printJson(page);

    table(
      ['PROVIDER', 'NAME', 'AUTH', 'AVAILABLE'],
      page.data.map((p) => [
        p.provider,
        p.display_name,
        p.auth_strategy ?? '—',
        p.available ? style.green('yes') : style.dim('coming soon'),
      ]),
    );
    return;
  }

  if (sub === 'capabilities') {
    const target = args.positionals[1];
    if (!target) {
      throw new UsageError('Usage: gs platforms capabilities <provider|destination_id>');
    }

    // A destination id resolves effective capability; a provider name resolves generic.
    // The distinction is load-bearing enough to be worth inferring rather than flagging.
    const capabilities = target.startsWith('dst_')
      ? await gs.platforms.destinationCapabilities(target)
      : await gs.platforms.capabilities(target as never);

    if (json) return printJson(capabilities);

    print(`${style.bold(capabilities.provider)}  ${style.dim(capabilities.resolution)}`);
    print('');
    table(
      ['CAPABILITY', 'SUPPORTED'],
      Object.entries(capabilities.publishing).map(([key, value]) => [
        key,
        value ? style.green('yes') : style.dim('no'),
      ]),
    );

    if (capabilities.restrictions.length > 0) {
      print(`\n${style.bold('Restrictions')}`);
      for (const restriction of capabilities.restrictions) {
        print(`  ${style.yellow(restriction.capability)}  ${restriction.reason}`);
        print(style.dim(`    ${restriction.message}`));
      }
    }
    return;
  }

  throw new UsageError(`Unknown platforms command "${sub}". Try list or capabilities.`);
}
