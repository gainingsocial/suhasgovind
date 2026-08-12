import { describe, expect, it } from 'vitest';

import { boolFlag, optionalFlag, parseArgs, requireFlag, UsageError } from './args.js';
import { truncate } from './output.js';

/**
 * The parser is where a CLI goes quietly wrong.
 *
 * A flag silently read as boolean when it carried a value does not fail — it publishes to
 * the wrong profile, or with no text. These are the cases worth pinning down.
 */

describe('argument parsing', () => {
  it('reads --key value', () => {
    expect(parseArgs(['--profile', 'pro_1']).flags.profile).toBe('pro_1');
  });

  it('reads --key=value', () => {
    expect(parseArgs(['--profile=pro_1']).flags.profile).toBe('pro_1');
  });

  it('treats a flag followed by another flag as boolean', () => {
    const parsed = parseArgs(['--json', '--profile', 'pro_1']);
    expect(parsed.flags.json).toBe(true);
    // The value must not be swallowed by the preceding boolean flag.
    expect(parsed.flags.profile).toBe('pro_1');
  });

  it('treats a trailing flag as boolean', () => {
    expect(parseArgs(['--json']).flags.json).toBe(true);
  });

  it('collects positionals in order', () => {
    expect(parseArgs(['get', 'pst_1', '--json']).positionals).toEqual(['get', 'pst_1']);
  });

  it('keeps positionals and flags separate regardless of order', () => {
    const parsed = parseArgs(['--profile', 'pro_1', 'upload', 'photo.jpg']);
    expect(parsed.positionals).toEqual(['upload', 'photo.jpg']);
    expect(parsed.flags.profile).toBe('pro_1');
  });

  it('stops parsing at --, so a value may look like a flag', () => {
    const parsed = parseArgs(['--text', 'hi', '--', '--not-a-flag']);
    expect(parsed.flags.text).toBe('hi');
    expect(parsed.positionals).toEqual(['--not-a-flag']);
  });

  it('supports short flags', () => {
    expect(parseArgs(['-f', 'post.json']).flags.f).toBe('post.json');
  });

  it('preserves an empty-string value rather than turning it into a flag', () => {
    // `--text=` is a deliberate empty caption, not a boolean.
    expect(parseArgs(['--text=']).flags.text).toBe('');
  });
});

describe('flag helpers', () => {
  it('names the flag when a required one is missing', () => {
    // The message has to say which flag; "missing argument" sends someone to the docs.
    expect(() => requireFlag(parseArgs([]), 'profile')).toThrow(/--profile is required/);
  });

  it('accepts any of several aliases', () => {
    expect(requireFlag(parseArgs(['-f', 'post.json']), 'file', 'f')).toBe('post.json');
  });

  it('rejects a required flag given without a value', () => {
    // `--profile --json` parses `profile` as boolean; treating that as present would send
    // `true` to the API as a profile id.
    expect(() => requireFlag(parseArgs(['--profile', '--json']), 'profile')).toThrow(UsageError);
  });

  it('returns undefined for an absent optional flag', () => {
    expect(optionalFlag(parseArgs([]), 'profile')).toBeUndefined();
  });

  it('reads a boolean flag written either way', () => {
    expect(boolFlag(parseArgs(['--json']), 'json')).toBe(true);
    expect(boolFlag(parseArgs(['--json=true']), 'json')).toBe(true);
    expect(boolFlag(parseArgs([]), 'json')).toBe(false);
  });
});

describe('output', () => {
  it('leaves a short string alone', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('marks a truncated string so the reader knows it was cut', () => {
    expect(truncate('a'.repeat(20), 10)).toBe(`${'a'.repeat(9)}…`);
  });

  it('flattens newlines, which would otherwise break table alignment', () => {
    expect(truncate('two\nlines', 20)).toBe('two lines');
  });

  it('counts emoji as one character each', () => {
    // Slicing by UTF-16 units would cut a surrogate pair in half and emit a replacement
    // character into the middle of a table cell.
    expect(truncate('👋'.repeat(5), 10)).toBe('👋'.repeat(5));
  });
});
