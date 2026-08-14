import Link from 'next/link';

import { BrandSwitcher } from '@/components/brand-switcher';
import { renderLoadFailure } from '@/components/page-states';
import { Badge, Card, CardHeader, EmptyState, Timestamp, cx } from '@/components/ui';
import type { ListResponse } from '@/lib/api';
import { resolveBrand } from '@/lib/brands';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';

export const metadata = { title: 'Inbox' };

/**
 * The unified inbox (plan Phase 7, creator plan §5.5).
 *
 * One list instead of six apps. The whole value is that a creator stops tab-switching, so
 * the ordering is by *what is waiting on a person*, not by network — grouping by platform
 * would rebuild the problem this screen exists to remove.
 *
 * Reads come from our own store rather than live provider calls. Plan Phase 7 is explicit
 * about this and an inbox makes the point sharper than analytics does: it is refreshed
 * constantly, so fetching from six platforms per load would spend a rate limit publishing
 * depends on, to render a list somebody scrolls past in a second.
 *
 * **Read-only, and it says so.** Replying is a provider side effect and belongs on the same
 * path as publishing (plan §19) — with an attempt record, a timeout, normalized errors and
 * idempotency (Rule 6). No adapter implements it yet and no route exposes it, so this page
 * links out to the platform rather than showing a reply box that would quietly fail. A
 * disabled compose field would be a worse lie than an honest outbound link.
 */

interface Contact {
  id: string;
  object: 'contact';
  display_name: string | null;
  handle: string | null;
  avatar_url: string | null;
}

interface Comment {
  id: string;
  object: 'comment';
  provider: string;
  destination_id: string;
  post_id: string | null;
  external_comment_id: string;
  parent_comment_id: string | null;
  author: Contact | null;
  body: string | null;
  like_count: number | null;
  reply_count: number | null;
  posted_at: string | null;
  handled_at: string | null;
}

interface Conversation {
  id: string;
  object: 'conversation';
  provider: string;
  destination_id: string;
  contact: Contact | null;
  subject: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
}

const EMPTY_COMMENTS: ListResponse<Comment> = {
  object: 'list',
  data: [],
  has_more: false,
  next_cursor: null,
};

const EMPTY_CONVERSATIONS: ListResponse<Conversation> = {
  object: 'list',
  data: [],
  has_more: false,
  next_cursor: null,
};

function personLabel(contact: Contact | null): string {
  if (!contact) return 'Someone';
  return contact.display_name ?? (contact.handle ? `@${contact.handle}` : 'Someone');
}

/**
 * Avatar, or initials when a platform gives us no image.
 *
 * A broken image icon in a list of twenty rows makes the whole screen look unfinished, and
 * several providers return no avatar at all for a commenter.
 */
function Avatar({ contact }: { contact: Contact | null }) {
  const label = personLabel(contact);
  const initial = label.replace(/^@/, '').charAt(0).toUpperCase() || '?';

  if (contact?.avatar_url) {
    return (
      // A plain <img>, not next/image. These are avatars from a dozen provider CDNs whose
      // hostnames are not knowable up front, and the Next loader requires each one to be
      // allow-listed in config — so an unrecognized host would render nothing at all.
      <img
        src={contact.avatar_url}
        alt=""
        width={32}
        height={32}
        // Referrer suppressed: an avatar URL fetch should not tell a social platform which
        // page of our dashboard somebody is looking at.
        referrerPolicy="no-referrer"
        className="h-8 w-8 shrink-0 rounded-full object-cover"
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--surface-sunken)] text-xs font-semibold text-[var(--text-muted)]"
    >
      {initial}
    </span>
  );
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string; show?: string }>;
}) {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  const { brand, show } = await searchParams;
  const { brands, selected } = await resolveBrand(context, brand);

  // The inbox is not scoped to one brand by default, unlike insights. Somebody checking
  // replies wants everything waiting on them, and splitting that by brand would mean
  // checking three screens to answer one question.
  const showAll = show === 'all';
  const scope = brand && selected ? `&profile_id=${selected.id}` : '';

  const [comments, conversations] = await Promise.all([
    sessionFetchOr<ListResponse<Comment>>(
      context,
      `/v1/comments?handled=${showAll ? 'all' : 'unhandled'}${scope}`,
      EMPTY_COMMENTS,
    ),
    sessionFetchOr<ListResponse<Conversation>>(
      context,
      `/v1/conversations?include_archived=${showAll}${scope}`,
      EMPTY_CONVERSATIONS,
    ),
  ]);

  const waiting = comments.data.length + conversations.data.filter((c) => c.unread_count > 0).length;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Inbox</h1>
          <p className="mt-1 text-sm text-[var(--text-subtle)]">
            Comments and messages from every network, in one list.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <BrandSwitcher brands={brands} selected={selected} basePath="/app/inbox" />

          {/* Two states, as links, so each is a real URL. */}
          <div className="flex items-center gap-1.5" role="group" aria-label="Filter">
            {[
              { label: 'Needs a reply', href: '/app/inbox', active: !showAll },
              { label: 'Everything', href: '/app/inbox?show=all', active: showAll },
            ].map((tab) => (
              <Link
                key={tab.href}
                href={tab.href as never}
                aria-current={tab.active ? 'true' : undefined}
                className={cx(
                  'inline-flex min-h-8 items-center rounded-full px-3 text-xs font-medium transition-colors',
                  tab.active
                    ? 'bg-brand-100 text-[var(--brand-text)]'
                    : 'border text-[var(--text-muted)] hover:bg-[var(--surface-sunken)]',
                )}
              >
                {tab.label}
              </Link>
            ))}
          </div>
        </div>
      </header>

      {/*
        The count, when there is one. An inbox whose whole job is "is anything waiting on
        me" should answer that above the fold rather than making somebody count rows.
      */}
      {!showAll && waiting > 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          <span className="font-semibold text-[var(--text)]">{waiting}</span>{' '}
          {waiting === 1 ? 'thing is' : 'things are'} waiting on you.
        </p>
      ) : null}

      <Card>
        <CardHeader
          title="Comments"
          description={showAll ? 'Everything we have collected' : 'Nobody has replied to these yet'}
        />
        {comments.data.length === 0 ? (
          <EmptyState
            title={showAll ? 'No comments collected yet' : 'Nothing waiting'}
            description={
              showAll
                ? 'Comments arrive through platform webhooks. Only the Meta family has a certified webhook integration today, so Facebook, Instagram and Threads are the networks that fill this in.'
                : 'Every comment we know about has been handled. Switch to Everything to see the history.'
            }
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {comments.data.map((comment) => (
              <li key={comment.id} className="flex gap-3 px-4 py-3.5 sm:px-5">
                <Avatar contact={comment.author} />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium">{personLabel(comment.author)}</span>
                    <Badge tone="neutral">{comment.provider}</Badge>
                    {comment.handled_at ? <Badge tone="ok">Handled</Badge> : null}
                  </div>

                  <p className="mt-1 text-sm text-[var(--text-muted)]">
                    {comment.body ?? <span className="italic">No text — likely a reaction or an attachment.</span>}
                  </p>

                  <p className="mt-1.5 text-xs text-[var(--text-subtle)]">
                    {comment.posted_at ? <Timestamp iso={comment.posted_at} relative /> : 'Time unknown'}
                    {comment.like_count ? ` · ${comment.like_count} likes` : ''}
                    {comment.reply_count ? ` · ${comment.reply_count} replies` : ''}
                    {comment.post_id ? (
                      <>
                        {' · '}
                        <Link href={`/app/posts/${comment.post_id}` as never} className="underline">
                          see the post
                        </Link>
                      </>
                    ) : null}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Messages" description="Direct conversations, newest first" />
        {conversations.data.length === 0 ? (
          <EmptyState
            title="No conversations"
            description="Direct messages appear here once a network delivers them."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {conversations.data.map((conversation) => (
              <li key={conversation.id} className="flex gap-3 px-4 py-3.5 sm:px-5">
                <Avatar contact={conversation.contact} />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium">{personLabel(conversation.contact)}</span>
                    <Badge tone="neutral">{conversation.provider}</Badge>
                    {conversation.unread_count > 0 ? (
                      <Badge tone="brand">{conversation.unread_count} unread</Badge>
                    ) : null}
                  </div>

                  {conversation.subject ? (
                    <p className="mt-1 text-sm font-medium">{conversation.subject}</p>
                  ) : null}

                  <p className="mt-1 truncate text-sm text-[var(--text-muted)]">
                    {conversation.last_message_preview ?? 'No preview available.'}
                  </p>

                  <p className="mt-1.5 text-xs text-[var(--text-subtle)]">
                    {conversation.last_message_at ? (
                      <Timestamp iso={conversation.last_message_at} relative />
                    ) : (
                      'Time unknown'
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/*
        Said once, plainly, at the bottom. Somebody who reads a full inbox and finds no way
        to answer will assume the feature is broken; saying it up front would make the
        screen look like an apology.
      */}
      <p className="text-xs text-[var(--text-subtle)]">
        Replying from here is not built yet — a reply is a provider side effect and has to go
        through the same publishing path as a post, with retries and an attempt record. For
        now, open the post on the platform to answer.
      </p>
    </div>
  );
}
