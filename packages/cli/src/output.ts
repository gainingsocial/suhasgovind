/**
 * Output.
 *
 * Two modes, chosen with `--json`. Human output is aligned columns; `--json` is the raw
 * API response, unreformatted, so a script can pipe it into jq without the CLI having
 * quietly renamed a field.
 *
 * Everything human goes to stdout and everything diagnostic to stderr, so
 * `gs posts list --json > posts.json` produces a clean file even when a warning is
 * printed.
 */

/** Colour only when stdout is a terminal — piped output must not carry escape codes. */
const COLOUR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const CODES = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
} as const;

function paint(text: string, code: keyof typeof CODES): string {
  return COLOUR ? `${CODES[code]}${text}${CODES.reset}` : text;
}

export const style = {
  dim: (t: string) => paint(t, 'dim'),
  bold: (t: string) => paint(t, 'bold'),
  red: (t: string) => paint(t, 'red'),
  green: (t: string) => paint(t, 'green'),
  yellow: (t: string) => paint(t, 'yellow'),
};

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function warn(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * A left-aligned table.
 *
 * Width is measured on the uncoloured string: escape codes count toward `.length` but
 * occupy no columns, so padding computed from a coloured value misaligns every row after
 * the first.
 */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  if (rows.length === 0) {
    print(style.dim('No results.'));
    return;
  }

  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );

  print(headers.map((header, i) => style.dim(header.padEnd(widths[i]!))).join('  '));
  for (const row of rows) {
    print(headers.map((_, i) => (row[i] ?? '').padEnd(widths[i]!)).join('  ').trimEnd());
  }
}

/** Colour a status the way a reader expects: green succeeded, red failed, yellow pending. */
export function statusLabel(status: string): string {
  if (status === 'published' || status === 'healthy' || status === 'ready') return style.green(status);
  if (status === 'failed' || status === 'cancelled' || status.includes('error')) return style.red(status);
  return style.yellow(status);
}

/** Trim a long string for a table cell without hiding that it was trimmed. */
export function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return [...flat].length <= max ? flat : `${[...flat].slice(0, max - 1).join('')}…`;
}
