#!/usr/bin/env node
import { isGainingSocialError } from '@gs/sdk';

import { boolFlag, parseArgs, UsageError } from './args.js';
import {
  authCommand,
  connectionsCommand,
  logsCommand,
  mediaCommand,
  platformsCommand,
  postCommand,
  preflightCommand,
  profilesCommand,
  type CommandContext,
} from './commands.js';
import { print, style, warn } from './output.js';

/**
 * `gs` — the GainingSocial CLI (plan Phase 3).
 *
 * The entry point owns argument dispatch and the exit code, and nothing else does. Three
 * codes, because a script needs to tell them apart:
 *
 *   0  it worked
 *   1  the operation failed
 *   2  the command was invoked wrongly
 *
 * A CLI that exits 1 for both a failed publish and a typo in a flag cannot be used in a
 * pipeline that should stop on one and not the other.
 */

const USAGE = `${style.bold('gs')} — publish to every social network from the command line

${style.bold('Usage')}
  gs <command> [subcommand] [options]

${style.bold('Commands')}
  auth login --key sk_test_...     Store and verify an API key
  auth whoami                      Show the project, environment and scopes
  auth logout                      Remove the stored key

  profiles list                    List profiles
  profiles create --name "Acme"    Create a profile

  connections list                 List connected accounts
  connections destinations <id>    List the destinations behind a connection
  connections disconnect <id>      Disconnect an account

  platforms list                   Every network, and whether it is available
  platforms capabilities <target>  Provider name for generic, dst_... for effective

  media upload <file> --profile pro_...   Upload an image or video
  media get <media_id>             Show a media asset

  preflight --file post.json       Validate without publishing. No side effects.
  post --file post.json            Publish. Runs preflight first unless --skip-preflight
  post list                        List posts
  post get <post_id>               Show a post and each of its targets
  post cancel <post_id>            Cancel a post that has not begun publishing
  post retry <post_id> [target]    Retry failed targets, or one target

  logs <post_id>                   Every state change and provider attempt, in order

${style.bold('Options')}
  --json                           Raw API response, for scripting
  --key sk_...                     Override the stored key for one command
  --profile pro_...                Profile to act on
  --text "..."                     Post text, instead of --file
  --destination dst_a,dst_b        Where to publish, instead of --file
  --media med_a,med_b              Media to attach
  --at 2026-09-01T10:00:00Z        Schedule instead of publishing now
  --skip-preflight                 Publish without validating first

${style.bold('Environment')}
  GS_API_KEY                       Takes precedence over the stored key
  GS_BASE_URL                      Point at a different deployment
  NO_COLOR                         Disable colour

${style.bold('Examples')}
  gs auth login --key sk_test_...
  gs preflight --profile pro_1 --text "Hello" --destination dst_1
  gs post --profile pro_1 --text "Hello" --destination dst_1,dst_2
  gs post list --status failed --json | jq '.data[].id'
`;

type Handler = (context: CommandContext) => Promise<void | boolean>;

const COMMANDS: Record<string, Handler> = {
  auth: authCommand,
  profiles: profilesCommand,
  profile: profilesCommand,
  connections: connectionsCommand,
  connection: connectionsCommand,
  platforms: platformsCommand,
  media: mediaCommand,
  preflight: preflightCommand,
  post: postCommand,
  posts: postCommand,
  logs: logsCommand,
};

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const name = argv[0];

  if (!name || name === 'help' || name === '--help' || name === '-h') {
    print(USAGE);
    return 0;
  }

  if (name === '--version' || name === '-v') {
    print('0.1.0');
    return 0;
  }

  const handler = COMMANDS[name];
  if (!handler) {
    warn(style.red(`Unknown command "${name}".`));
    warn('Run `gs help` to see what is available.');
    return 2;
  }

  const args = parseArgs(argv.slice(1));
  const result = await handler({ args, json: boolFlag(args, 'json') });

  // `preflight` reports its verdict through the exit code so a CI step can gate on it
  // without parsing output.
  return result === false ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof UsageError) {
    warn(style.red(error.message));
    warn('Run `gs help` for usage.');
    process.exitCode = 2;
  } else if (isGainingSocialError(error)) {
    // The envelope already says everything worth saying, in a form that was designed to
    // be acted on. Reformatting it into a sentence would lose the parts that matter.
    warn(style.red(`${error.code}: ${error.message}`));
    if (error.agentAction) warn(style.dim(`Next: ${error.agentAction}`));
    if (error.details?.length) {
      for (const detail of error.details) warn(style.dim(`  ${detail.path}: ${detail.message}`));
    }
    if (error.requestId) warn(style.dim(`Request ${error.requestId} — quote this to support.`));
    warn(style.dim(error.docsUrl));
    process.exitCode = 1;
  } else {
    warn(style.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
