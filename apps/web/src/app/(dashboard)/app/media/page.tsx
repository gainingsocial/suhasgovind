import { renderLoadFailure } from '@/components/page-states';
import { Card, CardHeader, EmptyState } from '@/components/ui';
import { dashboardContext } from '@/lib/session-api';

export const metadata = { title: 'Media' };

/**
 * Media (plan §31).
 *
 * There is deliberately no listing here yet. Media is fetched by id on the API — there is
 * no `GET /v1/media` — because the composer resolves assets it already knows about, and a
 * browse-everything endpoint would be a new paginated surface built for a screen nobody
 * has asked for. Saying so is better than an empty list implying uploads vanished.
 */
export default async function MediaPage() {
  try {
    await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Media</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          Images and video available to attach to posts.
        </p>
      </header>

      <Card>
        <CardHeader title="Uploading media" description="Three steps, and the bytes never pass through us" />
        <div className="space-y-3 px-4 py-4 text-sm sm:px-5">
          <p className="text-[var(--text-subtle)]">
            A 200 MB video through an API server is slow for you and expensive for us, so uploads go
            straight to storage with a short-lived signed URL.
          </p>
          <ol className="space-y-2">
            <li>
              <code className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-xs">
                POST /v1/media/uploads
              </code>{' '}
              returns a signed URL and a media id.
            </li>
            <li>
              <code className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-xs">
                PUT
              </code>{' '}
              the bytes to that URL.
            </li>
            <li>
              <code className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-xs">
                POST /v1/media/uploads/&#123;id&#125;/complete
              </code>{' '}
              probes the file and marks it ready.
            </li>
          </ol>
          <p className="text-[var(--text-subtle)]">
            Check an asset against your destinations before composing with{' '}
            <code className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-xs">
              POST /v1/media/preflight
            </code>
            .
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Your media" />
        <EmptyState
          title="Browse is not available yet"
          description="Media is addressed by id rather than browsed. Upload through the API and attach the id to a post; a library view arrives with the composer."
        />
      </Card>
    </div>
  );
}
