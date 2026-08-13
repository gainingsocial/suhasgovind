import type { ReactNode } from 'react';

import { CopyButton } from './copy-button';
import { cx } from './ui';

/**
 * Code panels for the marketing site and docs.
 *
 * A developer evaluating an API reads the request before the prose. The homepage went a
 * long time without showing one, which meant the single most persuasive thing about this
 * product — that publishing everywhere really is one call — was only ever asserted.
 *
 * Highlighting is done here rather than by pulling in a syntax library. Shiki and friends
 * cost 1–3 MB and load a full grammar to colour four snippets whose languages are JSON,
 * an HTTP request and a curl line. The tokenizer below is a hundred lines and runs at
 * build time on the server, so the client downloads coloured markup and no highlighter
 * at all.
 */

export type CodeLang = 'bash' | 'json' | 'http' | 'ts';

/** A syntactic class. Deliberately few — more colours would fight the palette. */
type Token = 'plain' | 'dim' | 'key' | 'value' | 'accent';

const TOKEN_CLASS: Record<Token, string> = {
  plain: 'text-[var(--code-fg)]',
  dim: 'text-[var(--code-dim)]',
  key: 'text-[var(--code-key)]',
  value: 'text-[var(--code-value)]',
  accent: 'text-[var(--code-key)] font-medium',
};

interface Rule {
  token: Token;
  pattern: string;
  /** Re-tokenized with this language instead of being emitted flat. */
  nest?: { lang: CodeLang; strip: number };
}

/**
 * Ordered — first match wins, so comments and strings must precede anything that could
 * match inside them. Getting that order wrong is how a `#` inside a URL turns the rest
 * of the line into a comment.
 */
const RULES: Record<CodeLang, Rule[]> = {
  bash: [
    { token: 'dim', pattern: '#[^\\n]*' },
    // A quoted JSON body is the whole point of most curl examples, so it is highlighted
    // as JSON rather than flattened into one long string.
    {
      token: 'value',
      pattern: "'\\s*[{\\[][\\s\\S]*?[}\\]]\\s*'",
      nest: { lang: 'json', strip: 1 },
    },
    { token: 'value', pattern: '\'(?:[^\'\\\\]|\\\\.)*\'|"(?:[^"\\\\]|\\\\.)*"' },
    { token: 'accent', pattern: '\\b(?:curl|npm|pnpm|npx|node|gs|export)\\b' },
    { token: 'key', pattern: '(?<![\\w-])--?[A-Za-z][\\w-]*' },
    { token: 'dim', pattern: '\\\\\\n|[|>]' },
  ],
  json: [
    { token: 'key', pattern: '"(?:[^"\\\\]|\\\\.)*"(?=\\s*:)' },
    { token: 'value', pattern: '"(?:[^"\\\\]|\\\\.)*"' },
    { token: 'value', pattern: '\\b-?\\d+(?:\\.\\d+)?\\b' },
    { token: 'value', pattern: '\\b(?:true|false|null)\\b' },
    { token: 'dim', pattern: '[{}\\[\\],:]' },
  ],
  http: [
    { token: 'accent', pattern: '^(?:GET|POST|PATCH|PUT|DELETE)\\b' },
    { token: 'key', pattern: '^[A-Za-z][A-Za-z-]*(?=:)' },
    { token: 'dim', pattern: '^#[^\\n]*' },
    { token: 'value', pattern: '\\bHTTP/[\\d.]+\\b' },
  ],
  ts: [
    { token: 'dim', pattern: '//[^\\n]*' },
    { token: 'value', pattern: '`(?:[^`\\\\]|\\\\.)*`|\'(?:[^\'\\\\]|\\\\.)*\'|"(?:[^"\\\\]|\\\\.)*"' },
    {
      token: 'accent',
      pattern: '\\b(?:import|from|const|let|await|async|function|return|new|export|for|of|if)\\b',
    },
    { token: 'key', pattern: '\\b[A-Za-z_$][\\w$]*(?=\\s*:)' },
    { token: 'dim', pattern: '[{}()\\[\\];,]' },
  ],
};

/** One compiled alternation per language, built once per module load. */
const COMPILED = new Map<CodeLang, RegExp>();

function matcher(lang: CodeLang): RegExp {
  const cached = COMPILED.get(lang);
  if (cached) return cached;
  const source = RULES[lang].map((rule) => `(${rule.pattern})`).join('|');
  // `m` so `^` anchors per line — the HTTP rules depend on it. `g` for the scan.
  const compiled = new RegExp(source, 'gm');
  COMPILED.set(lang, compiled);
  return compiled;
}

function tokenize(code: string, lang: CodeLang, keyPrefix = ''): ReactNode[] {
  const regex = matcher(lang);
  const rules = RULES[lang];
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;

  regex.lastIndex = 0;
  for (let match = regex.exec(code); match !== null; match = regex.exec(code)) {
    // Which alternative fired: group N+1 corresponds to rule N.
    const group = match.findIndex((value, position) => position > 0 && value !== undefined) - 1;
    const rule = rules[group];
    if (!rule) continue;

    if (match.index > last) nodes.push(code.slice(last, match.index));

    const key = `${keyPrefix}${index++}`;
    if (rule.nest) {
      const text = match[0];
      const open = text.slice(0, rule.nest.strip);
      const close = text.slice(text.length - rule.nest.strip);
      nodes.push(
        <span key={key}>
          <span className={TOKEN_CLASS.dim}>{open}</span>
          {tokenize(text.slice(rule.nest.strip, text.length - rule.nest.strip), rule.nest.lang, `${key}-`)}
          <span className={TOKEN_CLASS.dim}>{close}</span>
        </span>,
      );
    } else {
      nodes.push(
        <span key={key} className={TOKEN_CLASS[rule.token]}>
          {match[0]}
        </span>,
      );
    }

    last = match.index + match[0].length;
    // A zero-length match would spin forever.
    if (match[0].length === 0) regex.lastIndex += 1;
  }

  if (last < code.length) nodes.push(code.slice(last));
  return nodes;
}

export interface CodeBlockProps {
  code: string;
  lang?: CodeLang;
  /** Shown in the panel's title bar. A filename, a route, or what the snippet is. */
  title?: string;
  /** Right-hand label in the title bar — a status code, a language name. */
  badge?: string;
  /** Suppresses the copy button for output that nobody would paste anywhere. */
  copyable?: boolean;
  className?: string;
}

export function CodeBlock({
  code,
  lang = 'bash',
  title,
  badge,
  copyable = true,
  className,
}: CodeBlockProps) {
  const body = code.trim();

  return (
    <div
      className={cx(
        'overflow-hidden rounded-[var(--radius-card)] border border-[var(--code-border)] bg-[var(--code-bg)]',
        className,
      )}
    >
      {title || badge ? (
        <div className="flex items-center gap-3 border-b border-[var(--code-border)] bg-[var(--code-chrome)] px-4 py-2.5">
          {title ? (
            <span className="truncate font-mono text-xs text-[var(--code-fg)]">{title}</span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {badge ? (
              <span className="font-mono text-[11px] tracking-wide text-[var(--code-dim)] uppercase">
                {badge}
              </span>
            ) : null}
            {copyable ? <CopyButton value={body} /> : null}
          </span>
        </div>
      ) : null}

      {/* Wide snippets scroll inside the panel. A code block that widens the page is the
          classic cause of horizontal scroll on a phone. */}
      <pre className="overflow-x-auto px-4 py-4 text-[13px] leading-relaxed">
        <code className="font-mono text-[var(--code-fg)]">{tokenize(body, lang)}</code>
      </pre>
    </div>
  );
}

/** Inline code, for prose. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[0.9em] text-[var(--text)]">
      {children}
    </code>
  );
}
