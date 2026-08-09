import { Badge, Card, CardHeader, EmptyState } from '@/components/ui';

export const metadata = { title: 'Posts' };

/**
 * Post list (plan §60).
 *
 * Every row shows per-destination status, not a single rolled-up verdict. Plan §61 is
 * explicit that a failed target must never hide behind an aggregate — "partly published"
 * with three green and one red is the whole point of a multi-target publisher.
 */
export default function PostsPage() {
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Posts</h1>
          <p className="mt-1 text-sm text-[var(--text-subtle)]">
            Everything you have published, scheduled or attempted.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge tone="ok">Published</Badge>
          <Badge tone="warn">Partly</Badge>
          <Badge tone="fail">Failed</Badge>
        </div>
      </header>

      <Card>
        <CardHeader title="All posts" description="Newest first" />
        <EmptyState
          title="Nothing here yet"
          description="Posts appear the moment they are accepted, with live status for each destination."
        />
      </Card>
    </div>
  );
}
