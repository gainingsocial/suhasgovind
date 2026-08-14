import Link from 'next/link';

import { BrandSwitcher } from '@/components/brand-switcher';
import { renderLoadFailure } from '@/components/page-states';
import { Badge, Card, CardHeader, EmptyState, Timestamp } from '@/components/ui';
import type { ListResponse } from '@/lib/api';
import { resolveBrand } from '@/lib/brands';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';
import {
  AddMemoryForm,
  AddSourceForm,
  ApprovalDecision,
  ModePicker,
  RemoveMemoryButton,
  type AutomationMode,
} from './controls';

export const metadata = { title: 'Autopilot' };

/**
 * Autopilot — the automation control plane (creator plan §5.4).
 *
 * The highest-value screen in the product, because it is the one that turns a publishing
 * tool into something that runs without you. It is also the one that has to earn trust, so
 * the ordering is deliberate: **what is waiting on you** comes first, then **what is
 * running**, then **the rules everything obeys**. A screen that led with configuration would
 * be asking somebody to grant autonomy before showing them what autonomy produced.
 *
 * The three levels are not an invention of this page — they are the `automation_mode` the
 * engine already stores per source, and each maps onto machinery that already exists:
 *
 *   draft_only            no policy involved; writes and stops
 *   approval_required     the approval control plane (plan Phase 9)
 *   auto_publish_if_safe  policy engine + preflight + memory, and it still refuses when
 *                         any of the three is unhappy
 *
 * Rule C4: every automated action names the rule that caused it and stays reversible.
 */

interface Approval {
  id: string;
  object: 'approval_request';
  subject_type: string;
  subject_id: string;
  status: string;
  reason_code: string | null;
  required_approver_role: string;
  summary: string | null;
  expires_at: string;
  created_at: string;
}

interface ContentSource {
  id: string;
  object: 'content_source';
  kind: string;
  profile_id: string | null;
  url: string | null;
  name: string | null;
  automation_mode: AutomationMode;
  last_fetched_at: string | null;
  next_fetch_at: string | null;
  disabled_at: string | null;
}

interface DraftSetSummary {
  id: string;
  object: 'draft_set';
  status: string;
  profile_id: string;
  title: string | null;
  grounding_failed: boolean;
  draft_count: number;
}

interface BrandMemoryEntry {
  id: string;
  object: 'brand_memory_entry';
  kind: string;
  label: string;
  body: string | null;
  updated_at: string;
}

const emptyList = <T,>(): ListResponse<T> => ({
  object: 'list',
  data: [],
  has_more: false,
  next_cursor: null,
});

/** Memory kinds in the words a person would use, matching the add form. */
const MEMORY_KIND_LABEL: Record<string, string> = {
  vocabulary: 'Words we use',
  banned_claim: 'Never say',
  product: 'Product',
  audience: 'Audience',
  competitor: 'Competitor',
  campaign: 'Campaign',
  faq: 'Question',
};

/**
 * Why a post is being held, as a sentence.
 *
 * The engine stores a stable machine code; showing it raw would make the most sensitive
 * screen in the product read like a stack trace. An unrecognized code falls through to a
 * tidied version of itself rather than being hidden — a reason we cannot phrase is still a
 * reason somebody needs to see.
 */
const REASON_TEXT: Record<string, string> = {
  policy_requires_approval: 'Your rules say a person signs this off.',
  agent_unconfigured: 'An agent asked to publish before it was given permission to.',
  spend_limit: 'This would go past a limit you set.',
  sensitive_content: 'This touched something you asked to be warned about.',
  rate_limit: 'This is more than you allowed in one day.',
};

function reasonText(code: string | null): string {
  if (!code) return 'Held for review.';
  return REASON_TEXT[code] ?? code.replace(/_/g, ' ');
}

export default async function AutopilotPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string }>;
}) {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  const { brand } = await searchParams;
  const { brands, selected } = await resolveBrand(context, brand);

  /**
   * Approvals are environment-scoped, not brand-scoped, and authenticated as a person
   * rather than as a key — a decision is an accountable human act, so the API checks
   * organization membership rather than an API scope.
   */
  const approvals = await sessionFetchOr<ListResponse<Approval>>(
    context,
    `/v1/approvals?environment_id=${context.environment.id}`,
    emptyList<Approval>(),
  );

  const [sources, draftSets, memory] = selected
    ? await Promise.all([
        sessionFetchOr<ListResponse<ContentSource>>(
          context,
          `/v1/content-sources?profile_id=${selected.id}&limit=50`,
          emptyList<ContentSource>(),
        ),
        sessionFetchOr<ListResponse<DraftSetSummary>>(
          context,
          `/v1/draft-sets?profile_id=${selected.id}`,
          emptyList<DraftSetSummary>(),
        ),
        sessionFetchOr<ListResponse<BrandMemoryEntry>>(
          context,
          `/v1/memory/brand?profile_id=${selected.id}`,
          emptyList<BrandMemoryEntry>(),
        ),
      ])
    : [emptyList<ContentSource>(), emptyList<DraftSetSummary>(), emptyList<BrandMemoryEntry>()];

  const live = sources.data.filter((source) => !source.disabled_at);
  const autonomous = live.filter((source) => source.automation_mode === 'auto_publish_if_safe');
  const reviewable = draftSets.data.filter((set) => set.status === 'ready_for_review');

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Autopilot</h1>
          <p className="mt-1 text-sm text-[var(--text-subtle)]">
            What publishes without you, how much it is allowed to do, and the rules it obeys.
          </p>
        </div>
        <BrandSwitcher brands={brands} selected={selected} basePath="/app/autopilot" />
      </header>

      {/*
        Waiting on you, first. Somebody opening this screen with three posts held is here
        for those three posts — anything above them is an obstacle.
      */}
      <Card>
        <CardHeader
          title="Waiting on you"
          description="Held before publishing, because a rule said a person should look"
        />
        {approvals.data.length === 0 ? (
          <EmptyState
            title="Nothing is waiting"
            description="When a rule holds a post, it appears here with the reason and stays until you decide."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {approvals.data.map((approval) => (
              <li key={approval.id} className="px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {approval.summary ?? 'A post is waiting for approval.'}
                    </p>
                    {/* Rule C4 — the automation names the rule that caused it. */}
                    <p className="mt-1 text-xs text-[var(--text-subtle)]">
                      {reasonText(approval.reason_code)} · needs {approval.required_approver_role} ·
                      expires <Timestamp iso={approval.expires_at} relative />
                    </p>
                    {approval.subject_type === 'post' ? (
                      <Link
                        href={`/app/posts/${approval.subject_id}` as never}
                        className="mt-1 inline-block text-xs underline"
                      >
                        Read it first
                      </Link>
                    ) : null}
                  </div>

                  <ApprovalDecision approvalId={approval.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {!selected ? (
        <Card>
          <EmptyState
            title="No brand yet"
            description="Autopilot runs per brand — create one, then connect a feed and it starts turning new articles into posts."
          />
        </Card>
      ) : (
        <>
          {/* Drafts the machine produced and is holding. */}
          {reviewable.length > 0 ? (
            <Card>
              <CardHeader
                title="Drafts ready to read"
                description="Written from your sources and held for review"
              />
              <ul className="divide-y divide-[var(--border)]">
                {reviewable.map((set) => (
                  <li key={set.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{set.title ?? 'Untitled draft set'}</p>
                      <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                        {set.draft_count} {set.draft_count === 1 ? 'draft' : 'drafts'}
                      </p>
                    </div>
                    {/*
                      Grounding failure is shown, never hidden. It means a generated claim
                      could not be traced back to the source — the one thing that must
                      never be published quietly.
                    */}
                    {set.grounding_failed ? (
                      <Badge tone="fail">Some claims could not be checked</Badge>
                    ) : (
                      <Badge tone="ok">Every claim traced to the source</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {/* What is running. */}
          <Card>
            <CardHeader
              title="Your feeds"
              description="Each one turns new articles into posts, at the level you set"
              action={<AddSourceForm profileId={selected.id} />}
            />

            {live.length === 0 ? (
              <EmptyState
                title="No feeds connected"
                description="Connect a blog, an RSS feed or your site, and new articles become drafts automatically. Start at Ask me first — you can raise it once you trust it."
              />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {live.map((source) => (
                  <li key={source.id} className="px-4 py-4 sm:px-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{source.name ?? source.url ?? 'Untitled source'}</p>
                        <p className="mt-0.5 truncate text-xs text-[var(--text-subtle)]">
                          {source.kind} · {source.url ?? 'no address'}
                        </p>
                        <p className="mt-1 text-xs text-[var(--text-subtle)]">
                          {source.last_fetched_at ? (
                            <>
                              Last checked <Timestamp iso={source.last_fetched_at} relative />
                            </>
                          ) : (
                            'Not checked yet'
                          )}
                          {source.next_fetch_at ? (
                            <>
                              {' · next '}
                              <Timestamp iso={source.next_fetch_at} relative />
                            </>
                          ) : null}
                        </p>
                      </div>

                      <ModePicker sourceId={source.id} current={source.automation_mode} />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/*
              Stated plainly, because granting autonomy without knowing the limits is how
              somebody ends up not trusting any of it.
            */}
            {autonomous.length > 0 ? (
              <p className="border-t px-4 py-2.5 text-xs text-[var(--text-subtle)]">
                {autonomous.length} {autonomous.length === 1 ? 'feed publishes' : 'feeds publish'} on
                their own. Even then, anything that fails a check, breaks a rule below, or cannot be
                traced to its source is held for you instead.
              </p>
            ) : null}
          </Card>

          {/* The rules everything obeys. */}
          <Card>
            <CardHeader
              title="What it knows about you"
              description="Facts, phrases and hard limits every draft is written against"
              action={<AddMemoryForm profileId={selected.id} />}
            />

            {memory.data.length === 0 ? (
              <EmptyState
                title="Nothing recorded yet"
                description="Add the things you would tell a new person on your team: how you talk, what you sell, and what you must never claim."
              />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {memory.data.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{entry.label}</span>
                        {/* A banned claim is a limit, not a note — it reads differently. */}
                        <Badge tone={entry.kind === 'banned_claim' ? 'fail' : 'neutral'}>
                          {MEMORY_KIND_LABEL[entry.kind] ?? entry.kind.replace(/_/g, ' ')}
                        </Badge>
                      </div>
                      {entry.body ? (
                        <p className="mt-1 text-sm text-[var(--text-muted)]">{entry.body}</p>
                      ) : null}
                    </div>

                    <RemoveMemoryButton profileId={selected.id} entryId={entry.id} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <p className="text-xs text-[var(--text-subtle)]">
        Everything on this page is also an API call and an agent tool — an AI agent operating
        your account gets exactly these rules and these limits, not a separate set.
      </p>
    </div>
  );
}
