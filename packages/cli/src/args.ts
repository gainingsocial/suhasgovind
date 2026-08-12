/**
 * Argument parsing.
 *
 * Hand-rolled rather than pulling in a framework, for the same reason the SDK has no
 * dependencies: a CLI whose install pulls twenty transitive packages is a CLI people
 * hesitate to install. The surface here is small and stable enough that the parser is
 * shorter than the configuration a framework would need.
 */

export interface ParsedArgs {
  /** Positional arguments, in order, with the command words already consumed. */
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Parse `--key value`, `--key=value`, `--flag` and `-k value`.
 *
 * A `--` terminator stops parsing, so a value that looks like a flag can still be passed
 * — `gs post --text -- --not-a-flag`.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');

      if (equals !== -1) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }

      const next = argv[i + 1];
      // A bare `--flag` followed by another flag is boolean; followed by a value it takes
      // it. Treating everything as boolean would silently drop `--profile pro_123`.
      if (next === undefined || next.startsWith('-')) {
        flags[body] = true;
      } else {
        flags[body] = next;
        i++;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const body = token.slice(1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        flags[body] = true;
      } else {
        flags[body] = next;
        i++;
      }
      continue;
    }

    positionals.push(token);
  }

  return { positionals, flags };
}

/** Read a flag that must carry a value, failing with a message naming the flag. */
export function requireFlag(args: ParsedArgs, ...names: string[]): string {
  for (const name of names) {
    const value = args.flags[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  throw new UsageError(`--${names[0]} is required.`);
}

export function optionalFlag(args: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.flags[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

export function boolFlag(args: ParsedArgs, ...names: string[]): boolean {
  return names.some((name) => args.flags[name] === true || args.flags[name] === 'true');
}

/**
 * A mistake in how the command was invoked, as opposed to a failure carrying it out.
 *
 * Separated because the two want different output: usage errors print the usage line and
 * exit 2, while an API failure prints the error envelope and exits 1. Conflating them
 * makes a script unable to tell "I called this wrong" from "the call failed".
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
