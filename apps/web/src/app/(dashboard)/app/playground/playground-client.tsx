'use client';

import { useMemo, useState } from 'react';

/**
 * The developer playground (plan §58).
 *
 * A Stripe-style explorer: pick an endpoint on the left, edit a typed request in the
 * middle, read the response and copy a working snippet on the right.
 *
 * Two decisions shape it.
 *
 * **It calls the real API with a real key.** A playground that mocks its responses teaches
 * a shape the API does not have, and the first real call is then a surprise. The default
 * key is the environment's test key, so the blast radius of experimenting is a test
 * environment.
 *
 * **Live calls are a separate, deliberate button.** §58 asks for "execute live (clear
 * confirmation)", and the reason is that one of these endpoints publishes to a real
 * audience. Making that the same click as "try it" is how somebody posts a placeholder to
 * a brand's actual account.
 */

export interface PlaygroundEndpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  description: string;
  tag: string;
  /** Pre-filled request body, already valid for the schema. */
  sampleBody?: string;
  /** True when calling it changes something a customer would notice. */
  writes: boolean;
}

interface Props {
  endpoints: PlaygroundEndpoint[];
  apiOrigin: string;
  /** Filled in from the environment's own key, so the first call works with no setup. */
  defaultKey: string | null;
  environmentKind: 'test' | 'live';
  profileId: string | null;
  destinationId: string | null;
}

interface Outcome {
  status: number;
  durationMs: number;
  body: string;
  requestId: string | null;
}

export function Playground({
  endpoints,
  apiOrigin,
  defaultKey,
  environmentKind,
  profileId,
  destinationId,
}: Props) {
  const [selected, setSelected] = useState(endpoints[0]);
  const [apiKey, setApiKey] = useState(defaultKey ?? '');
  const [pathValue, setPathValue] = useState(endpoints[0]?.path ?? '');
  const [body, setBody] = useState(endpoints[0]?.sampleBody ?? '');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [running, setRunning] = useState(false);
  const [snippet, setSnippet] = useState<'curl' | 'sdk'>('curl');

  const grouped = useMemo(() => {
    const byTag = new Map<string, PlaygroundEndpoint[]>();
    for (const endpoint of endpoints) {
      byTag.set(endpoint.tag, [...(byTag.get(endpoint.tag) ?? []), endpoint]);
    }
    return [...byTag.entries()];
  }, [endpoints]);

  function choose(endpoint: PlaygroundEndpoint) {
    setSelected(endpoint);
    // Placeholders are substituted from the current environment, so an endpoint with a
    // path parameter is runnable immediately rather than after a hunt for an id.
    setPathValue(
      endpoint.path
        .replace('{profileId}', profileId ?? '{profileId}')
        .replace('{destinationId}', destinationId ?? '{destinationId}'),
    );
    setBody(endpoint.sampleBody ?? '');
    setOutcome(null);
  }

  async function run() {
    if (!selected || running) return;

    setRunning(true);
    const startedAt = performance.now();

    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      };

      // Generated per run, so repeatedly pressing Send does not replay one reservation and
      // report the first response forever — which would look like the button was broken.
      if (selected.method === 'POST' && selected.path === '/v1/posts') {
        headers['idempotency-key'] = crypto.randomUUID();
      }

      const response = await fetch(`${apiOrigin}${pathValue}`, {
        method: selected.method,
        headers,
        body: selected.method === 'GET' || body.trim() === '' ? undefined : body,
      });

      const text = await response.text();
      let formatted = text;
      try {
        formatted = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Not JSON. Shown raw rather than swallowed — an HTML error page from a proxy is
        // exactly the thing somebody needs to see.
      }

      setOutcome({
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
        body: formatted,
        requestId: response.headers.get('x-request-id'),
      });
    } catch (error) {
      setOutcome({
        status: 0,
        durationMs: Math.round(performance.now() - startedAt),
        body: error instanceof Error ? error.message : String(error),
        requestId: null,
      });
    } finally {
      setRunning(false);
    }
  }

  const curl = useMemo(() => {
    if (!selected) return '';

    const lines = [`curl -X ${selected.method} '${apiOrigin}${pathValue}' \\`];
    lines.push(`  -H 'Authorization: Bearer ${apiKey || 'sk_test_…'}' \\`);

    if (selected.method !== 'GET' && body.trim()) {
      lines.push(`  -H 'Content-Type: application/json' \\`);
      if (selected.path === '/v1/posts') {
        lines.push(`  -H 'Idempotency-Key: $(uuidgen)' \\`);
      }
      lines.push(`  -d '${body.replace(/\n\s*/g, ' ')}'`);
    } else {
      lines[lines.length - 1] = lines[lines.length - 1]!.replace(/ \\$/, '');
    }

    return lines.join('\n');
  }, [selected, apiOrigin, pathValue, apiKey, body]);

  const sdk = useMemo(() => {
    if (!selected) return '';

    const call = selected.path.replace(/^\/v1\//, '').split('/')[0];
    return [
      `import { GainingSocial } from '@gs/sdk';`,
      ``,
      `const gs = new GainingSocial({ apiKey: process.env.GS_API_KEY });`,
      ``,
      selected.method === 'GET'
        ? `const result = await gs.${call}.list();`
        : `const result = await gs.${call}.create(${body.trim() || '{}'});`,
    ].join('\n');
  }, [selected, body]);

  if (!selected) return null;

  const statusTone =
    outcome === null
      ? ''
      : outcome.status >= 200 && outcome.status < 300
        ? 'text-[var(--ok)]'
        : outcome.status === 0
          ? 'text-[var(--text-subtle)]'
          : 'text-[var(--danger)]';

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_minmax(0,1fr)]">
      <nav aria-label="Endpoints" className="rounded-lg border border-[var(--border)] p-2">
        {grouped.map(([tag, items]) => (
          <div key={tag} className="mb-3">
            <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
              {tag}
            </p>
            <ul>
              {items.map((endpoint) => (
                <li key={`${endpoint.method} ${endpoint.path}`}>
                  <button
                    type="button"
                    onClick={() => choose(endpoint)}
                    aria-current={selected.path === endpoint.path ? 'true' : undefined}
                    className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                      selected.path === endpoint.path
                        ? 'bg-[var(--surface-2)] font-medium'
                        : 'hover:bg-[var(--surface-2)]'
                    }`}
                  >
                    <span className="mr-2 font-mono text-[10px] uppercase text-[var(--text-subtle)]">
                      {endpoint.method}
                    </span>
                    {endpoint.summary}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <section className="space-y-3 rounded-lg border border-[var(--border)] p-4">
        <div>
          <h2 className="text-sm font-semibold">{selected.summary}</h2>
          <p className="mt-1 text-xs text-[var(--text-subtle)]">{selected.description}</p>
        </div>

        <label className="block">
          <span className="text-xs font-medium">API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk_test_…"
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium">Path</span>
          <input
            value={pathValue}
            onChange={(event) => setPathValue(event.target.value)}
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs"
          />
        </label>

        {selected.method !== 'GET' && (
          <label className="block">
            <span className="text-xs font-medium">Request body</span>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={12}
              spellCheck={false}
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs"
            />
          </label>
        )}

        {/*
          The confirmation §58 asks for, and it earns its place: several of these endpoints
          publish to a real audience, and making that the same click as "try it" is how a
          placeholder ends up on a brand's actual account.
        */}
        {selected.writes && environmentKind === 'live' && (
          <p className="rounded border border-[var(--danger)] px-3 py-2 text-xs text-[var(--danger)]">
            This is a <strong>live</strong> environment and this endpoint changes something
            real. A post sent from here goes out to an actual audience.
          </p>
        )}

        <button
          type="button"
          onClick={run}
          disabled={running || !apiKey}
          className="rounded bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-[var(--brand-contrast)] disabled:opacity-50"
        >
          {running ? 'Sending…' : environmentKind === 'live' && selected.writes ? 'Send live request' : 'Send request'}
        </button>
      </section>

      <section className="space-y-3 rounded-lg border border-[var(--border)] p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Response</h2>
          {outcome && (
            <p className={`font-mono text-xs ${statusTone}`}>
              {outcome.status === 0 ? 'network error' : outcome.status} · {outcome.durationMs}ms
            </p>
          )}
        </div>

        {outcome ? (
          <>
            <pre className="max-h-80 overflow-auto rounded bg-[var(--surface-2)] p-3 font-mono text-xs">
              {outcome.body}
            </pre>
            {outcome.requestId && (
              // Surfaced because it is the one string that makes a support conversation
              // short, and nobody thinks to copy it out of a header.
              <p className="text-xs text-[var(--text-subtle)]">
                Request id <code className="font-mono">{outcome.requestId}</code> — quote this
                if you need help with what happened.
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-[var(--text-subtle)]">
            Nothing sent yet. Responses appear here exactly as the API returns them.
          </p>
        )}

        <div>
          <div className="mb-2 flex gap-2">
            {(['curl', 'sdk'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setSnippet(kind)}
                className={`rounded px-2 py-1 text-xs ${
                  snippet === kind ? 'bg-[var(--surface-2)] font-medium' : ''
                }`}
              >
                {kind === 'curl' ? 'cURL' : 'SDK'}
              </button>
            ))}
          </div>
          <pre className="overflow-auto rounded bg-[var(--surface-2)] p-3 font-mono text-xs">
            {snippet === 'curl' ? curl : sdk}
          </pre>
        </div>
      </section>
    </div>
  );
}
