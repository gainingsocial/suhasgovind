import Link from 'next/link';

import { CodeBlock } from '@/components/code';
import { ALL_ERROR_DOCS, errorDocsByFamily } from '@/lib/error-docs';
import { breadcrumbSchema, jsonLd, pageSeo } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'API error codes',
  description:
    'Every error code the publishing API can return, with its HTTP status, whether retrying ' +
    'could help, and the machine-readable action an agent should take next.',
  path: '/docs/errors',
});

/**
 * The error reference index.
 *
 * Grouped by family rather than listed alphabetically. Somebody arriving here from a
 * failing request already knows their code and will use the browser's find; somebody
 * browsing wants to understand which kinds of failure exist, and eighty-nine names in
 * alphabetical order teaches that to nobody.
 */

const ENVELOPE = `
{
  "error": {
    "type": "connection_error",
    "code": "CONNECTION_REAUTH_REQUIRED",
    "message": "This connection needs to be reauthorized before it can publish.",
    "retryable": false,
    "provider": "linkedin",
    "agent_action": "create_connect_session_for_reauthorization",
    "docs_url": "https://gainingsocial.com/docs/errors/CONNECTION_REAUTH_REQUIRED",
    "request_id": "req_06fy2aavb5yb1db0enh4wc7yj4",
    "trace_id": "trc_06fy2aavb5yb3351nf1fbt8aag"
  }
}
`;

const UNKNOWN_OUTCOMES = [
  ['PROVIDER_TIMEOUT', 'The provider may have published before the connection dropped.'],
  ['POSSIBLE_DUPLICATE', 'The provider says equivalent content may already exist.'],
  ['RECONCILIATION_REQUIRED', 'We are already asking the provider what happened.'],
] as const;

export default function ErrorIndexPage() {
  const groups = errorDocsByFamily();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLd(
          breadcrumbSchema([
            { name: 'Home', path: '/' },
            { name: 'Documentation', path: '/docs' },
            { name: 'Error codes', path: '/docs/errors' },
          ]),
        )}
      />

      <div className="py-14">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          API error codes
        </h1>
        <p className="mt-4 max-w-3xl text-base text-pretty text-[var(--text-muted)] sm:text-lg">
          All {ALL_ERROR_DOCS.length} codes the API can return. Branch on{' '}
          <code className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[0.85em]">
            code
          </code>
          , never on{' '}
          <code className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[0.85em]">
            message
          </code>{' '}
          — codes are stable and versioned, messages are not.
        </p>

        <div className="mt-10 grid gap-8 xl:grid-cols-2 xl:items-start">
          <div className="min-w-0 max-w-2xl space-y-4 text-[15px] leading-relaxed text-[var(--text-muted)]">
            <p>
              Every error uses the same envelope, on every route, including the ones a platform
              caused. <code className="font-mono text-[0.9em]">request_id</code> and{' '}
              <code className="font-mono text-[0.9em]">trace_id</code> are on every response —
              successes included, as the{' '}
              <code className="font-mono text-[0.9em]">x-request-id</code> and{' '}
              <code className="font-mono text-[0.9em]">x-trace-id</code> headers. Quote either one
              in a support request.
            </p>
            <p>
              <code className="font-mono text-[0.9em]">retryable</code> is computed from the
              catalog rather than inferred from the status code, and the two disagree often enough
              that guessing from the status is a real source of bugs. Two 409s make the point:{' '}
              <Link
                href="/docs/errors/IDEMPOTENCY_REQUEST_IN_PROGRESS"
                className="font-mono text-[0.9em] text-[var(--text)] underline underline-offset-4"
              >
                IDEMPOTENCY_REQUEST_IN_PROGRESS
              </Link>{' '}
              is retryable because the first request is still running and will finish;{' '}
              <Link
                href="/docs/errors/DUPLICATE_CONTENT_BLOCKED"
                className="font-mono text-[0.9em] text-[var(--text)] underline underline-offset-4"
              >
                DUPLICATE_CONTENT_BLOCKED
              </Link>{' '}
              is not, because identical content can only be refused identically.
            </p>
            <p>
              <code className="font-mono text-[0.9em]">retryable: false</code> never means give up.
              It means <em>this exact request</em> will fail the same way — change something, or
              take the <code className="font-mono text-[0.9em]">agent_action</code>.
            </p>
          </div>

          <CodeBlock code={ENVELOPE} lang="json" title="The envelope" badge="409" copyable={false} />
        </div>

        <section className="mt-14 rounded-[var(--radius-card)] border bg-[var(--surface-sunken)] p-6">
          <h2 className="text-lg font-semibold tracking-tight">
            Three codes that are not failures
          </h2>
          <p className="mt-2 max-w-3xl text-[15px] text-pretty text-[var(--text-muted)]">
            Each describes an outcome that is genuinely unknown rather than known-bad, and none of
            them should be retried by a caller.
          </p>
          <ul className="mt-5 grid gap-3 md:grid-cols-3">
            {UNKNOWN_OUTCOMES.map(([code, why]) => (
              <li
                key={code}
                className="rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-4"
              >
                <Link
                  href={`/docs/errors/${code}` as never}
                  className="font-mono text-sm font-medium break-words underline underline-offset-4"
                >
                  {code}
                </Link>
                <p className="mt-2 text-sm text-pretty text-[var(--text-muted)]">{why}</p>
              </li>
            ))}
          </ul>
          <p className="mt-5 max-w-3xl text-[15px] text-pretty text-[var(--text-muted)]">
            The engine reconciles first and either adopts the post it finds or retries once it has
            proved nothing was created. A client that retries on its own is racing that process,
            and the prize for winning is a duplicate post.
          </p>
        </section>

        {groups.map((group) => (
          <section key={group.family.type} id={group.family.type} className="mt-14 scroll-mt-24">
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
              {group.family.title}
            </h2>
            <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-pretty text-[var(--text-muted)]">
              {group.family.summary}
            </p>

            <ul className="mt-6 grid gap-3 md:grid-cols-2">
              {group.docs.map((doc) => (
                /* min-w-0: `break-words` lets a long code wrap, but it does not reduce the
                   item's intrinsic minimum width, so the grid track still sizes to
                   IDEMPOTENCY_REQUEST_IN_PROGRESS unbroken. */
                <li key={doc.code} className="min-w-0">
                  <Link
                    href={`/docs/errors/${doc.code}` as never}
                    className="flex h-full items-start gap-3 rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-4 transition-colors hover:border-[var(--border-strong)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-sm font-medium break-words">
                        {doc.code}
                      </span>
                      <span className="mt-1.5 block text-sm text-pretty text-[var(--text-muted)]">
                        {doc.message}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1.5">
                      <span className="font-mono text-xs text-[var(--text-subtle)]">
                        {doc.status}
                      </span>
                      {doc.retryable ? (
                        <span className="rounded-full bg-ok-100 px-2 py-0.5 text-[11px] font-medium text-ok-600">
                          retryable
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
