import { renderLoadFailure } from '@/components/page-states';
import { Badge, Card, CardHeader, EmptyState, Timestamp } from '@/components/ui';
import type { ListResponse } from '@/lib/api';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';

export const metadata = { title: 'Webhooks' };

/**
 * Webhook endpoints (plan §59, §35).
 *
 * Webhooks are a product surface, not a convenience (P8): an integrator who cannot find
 * out that a post published has to poll, and polling a publishing API is how rate limits
 * get exhausted.
 */

interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  status: string;
  event_types: string[];
  created_at: string;
}

export default async function WebhooksPage() {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  const endpoints = await sessionFetchOr<ListResponse<WebhookEndpoint>>(
    context,
    '/v1/webhooks?limit=50',
    { object: 'list', data: [], has_more: false, next_cursor: null },
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Webhooks</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          Get notified the moment a post publishes or fails.
        </p>
      </header>

      <Card>
        <CardHeader
          title="Endpoints"
          description={endpoints.data.length > 0 ? `${endpoints.data.length} configured` : undefined}
        />
        {endpoints.data.length === 0 ? (
          <EmptyState
            title="No endpoints yet"
            description="Add an endpoint and we will POST a signed event on every publish, failure and retry. Create one with POST /v1/webhooks."
          />
        ) : (
          <ul className="divide-y">
            {endpoints.data.map((endpoint) => (
              <li key={endpoint.id} className="px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs">{endpoint.url}</p>
                    {endpoint.description ? (
                      <p className="mt-0.5 text-sm">{endpoint.description}</p>
                    ) : null}
                    <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                      {/* An empty subscription list means everything, which is the API's
                          default and worth stating rather than rendering as "0 events". */}
                      {endpoint.event_types.length === 0
                        ? 'all events'
                        : `${endpoint.event_types.length} event type${endpoint.event_types.length === 1 ? '' : 's'}`}{' '}
                      · added <Timestamp iso={endpoint.created_at} />
                    </p>
                  </div>
                  <Badge tone={endpoint.status === 'enabled' ? 'ok' : 'neutral'}>
                    {endpoint.status}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
