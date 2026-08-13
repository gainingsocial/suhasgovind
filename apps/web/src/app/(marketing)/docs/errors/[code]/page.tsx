import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CodeBlock } from '@/components/code';
import {
  ALL_ERROR_DOCS,
  errorDoc,
  humanizeAgentAction,
  isErrorCode,
  whatToDo,
} from '@/lib/error-docs';
import { breadcrumbSchema, jsonLd, pageSeo } from '@/lib/seo';

/**
 * One page per error code, generated from the catalog.
 *
 * These are the destinations of the `docs_url` in every error envelope the API returns, so
 * they are read at the worst possible moment — something has just failed. The page answers
 * the three questions in that order: what happened, is retrying worth anything, and what
 * do I change.
 *
 * A code that is not in the catalog 404s rather than rendering an authoritative-looking
 * page about an error that does not exist. That is enforced by the `isErrorCode` guard
 * below rather than by `dynamicParams = false`, deliberately: the guard is a property of
 * this page, so it holds whether a request is served from the prerendered output or
 * rendered on demand. `dynamicParams = false` puts the same rule in the router, where it
 * depends on the deployment finding the prerender manifest — and when that lookup failed
 * on Cloudflare, all 93 valid codes 404'd along with the invalid ones.
 */

export function generateStaticParams(): { code: string }[] {
  return ALL_ERROR_DOCS.map((doc) => ({ code: doc.code }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>;
}): Promise<Metadata> {
  const { code } = await params;
  if (!isErrorCode(code)) return {};
  const doc = errorDoc(code);

  return pageSeo({
    title: `${doc.code} — ${doc.status} error`,
    description: `${doc.message} What ${doc.code} means, whether retrying helps, and how to resolve it.`,
    path: `/docs/errors/${doc.code}`,
  });
}

export default async function ErrorCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!isErrorCode(code)) notFound();

  const doc = errorDoc(code);
  const envelope = `
{
  "error": {
    "type": ${JSON.stringify(doc.type)},
    "code": ${JSON.stringify(doc.code)},
    "message": ${JSON.stringify(doc.message)},
    "retryable": ${doc.retryable},${
      doc.agentAction ? `\n    "agent_action": ${JSON.stringify(doc.agentAction)},` : ''
    }
    "docs_url": "https://gainingsocial.com/docs/errors/${doc.code}",
    "request_id": "req_06fy2aavb5yb1db0enh4wc7yj4",
    "trace_id": "trc_06fy2aavb5yb3351nf1fbt8aag"
  }
}
`;

  const related = ALL_ERROR_DOCS.filter(
    (other) => other.type === doc.type && other.code !== doc.code,
  ).slice(0, 8);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLd(
          breadcrumbSchema([
            { name: 'Home', path: '/' },
            { name: 'Documentation', path: '/docs' },
            { name: 'Error codes', path: '/docs/errors' },
            { name: doc.code, path: `/docs/errors/${doc.code}` },
          ]),
        )}
      />

      <article className="py-14">
        <nav aria-label="Breadcrumb" className="text-sm text-[var(--text-subtle)]">
          <Link href="/docs" className="hover:text-[var(--text)]">
            Docs
          </Link>
          <span className="px-2">/</span>
          <Link href="/docs/errors" className="hover:text-[var(--text)]">
            Error codes
          </Link>
        </nav>

        <h1 className="mt-5 font-mono text-2xl font-semibold tracking-tight break-words sm:text-4xl">
          {doc.code}
        </h1>
        <p className="mt-5 max-w-3xl text-base text-pretty text-[var(--text-muted)] sm:text-lg">
          {doc.message}
        </p>

        <dl className="mt-8 grid gap-px overflow-hidden rounded-[var(--radius-card)] border bg-[var(--border)] sm:grid-cols-3">
          <div className="bg-[var(--surface-raised)] p-5">
            <dt className="text-sm text-[var(--text-subtle)]">HTTP status</dt>
            <dd className="mt-1 font-mono text-2xl font-semibold">{doc.status}</dd>
          </div>
          <div className="bg-[var(--surface-raised)] p-5">
            <dt className="text-sm text-[var(--text-subtle)]">Retryable</dt>
            <dd className="mt-1.5">
              <span
                className={`inline-flex rounded-full px-2.5 py-1 text-sm font-medium ${
                  doc.retryable
                    ? 'bg-ok-100 text-ok-600'
                    : 'bg-[var(--surface-sunken)] text-[var(--text-muted)]'
                }`}
              >
                {doc.retryable ? 'Yes' : 'No'}
              </span>
            </dd>
          </div>
          <div className="bg-[var(--surface-raised)] p-5">
            <dt className="text-sm text-[var(--text-subtle)]">Family</dt>
            <dd className="mt-1.5">
              <Link
                href={`/docs/errors#${doc.type}` as never}
                className="text-base font-medium underline underline-offset-4"
              >
                {doc.family.title}
              </Link>
            </dd>
          </div>
        </dl>

        <div className="mt-12 grid gap-10 xl:grid-cols-2 xl:items-start">
          {/* min-w-0: a grid item will not shrink below its content, and the content is a
              code panel wider than the column. Without it the track grows and the page
              scrolls sideways on a phone. */}
          <div className="min-w-0 max-w-2xl">
            <h2 className="text-xl font-semibold tracking-tight">What it means</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-pretty text-[var(--text-muted)]">
              {doc.family.summary}
            </p>

            <h2 className="mt-10 text-xl font-semibold tracking-tight">What to do</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-pretty text-[var(--text-muted)]">
              {whatToDo(doc)}
            </p>

            {doc.agentAction ? (
              <div className="mt-6 rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-5">
                <p className="text-sm font-medium">
                  Agent action: {humanizeAgentAction(doc.agentAction)}
                </p>
                <p className="mt-2 text-sm text-pretty text-[var(--text-muted)]">
                  An autonomous caller should take this step rather than parsing the message. The
                  exact string in <code className="font-mono text-[0.9em]">agent_action</code> is{' '}
                  <code className="font-mono text-[0.9em] break-words">{doc.agentAction}</code>, and
                  it is stable.
                </p>
              </div>
            ) : null}
          </div>

          <div className="min-w-0">
            <CodeBlock
              code={envelope}
              lang="json"
              title="Example response"
              badge={String(doc.status)}
              copyable={false}
            />
            <p className="mt-4 text-sm text-pretty text-[var(--text-subtle)]">
              The message shown is the catalog default. A specific occurrence usually carries a
              more precise one, and may add <code className="font-mono">param</code>,{' '}
              <code className="font-mono">provider</code>,{' '}
              <code className="font-mono">destination_id</code> or{' '}
              <code className="font-mono">retry_after</code>. The code never changes.
            </p>
          </div>
        </div>

        {related.length > 0 ? (
          <section className="mt-14 border-t pt-10">
            <h2 className="text-xl font-semibold tracking-tight">
              Other {doc.family.title.toLowerCase()} errors
            </h2>
            <ul className="mt-5 grid gap-3 sm:grid-cols-2">
              {related.map((other) => (
                <li key={other.code} className="min-w-0">
                  <Link
                    href={`/docs/errors/${other.code}` as never}
                    className="flex items-center justify-between gap-3 rounded-lg border bg-[var(--surface-raised)] p-3.5 transition-colors hover:border-[var(--border-strong)]"
                  >
                    <span className="min-w-0 font-mono text-sm break-words">{other.code}</span>
                    <span className="shrink-0 font-mono text-xs text-[var(--text-subtle)]">
                      {other.status}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-8">
              <Link href="/docs/errors" className="text-sm underline underline-offset-4">
                All {ALL_ERROR_DOCS.length} error codes →
              </Link>
            </p>
          </section>
        ) : null}
      </article>
    </>
  );
}
