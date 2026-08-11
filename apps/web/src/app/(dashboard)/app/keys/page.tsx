import { renderLoadFailure } from '@/components/page-states';
import { Badge, Card, CardHeader, EmptyState, Timestamp } from '@/components/ui';
import type { ListResponse } from '@/lib/api';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';

import { CreateKeyForm } from './create-key-form';

export const metadata = { title: 'API keys' };

/**
 * API keys (plan §38, §39).
 *
 * Created with a dashboard session, never with another key — a key that could mint a key
 * turns one leak into permanent self-renewing access that revoking the original does not
 * stop.
 */

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  environment: 'test' | 'live';
  status: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
}

export default async function KeysPage() {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  const keys = await sessionFetchOr<ListResponse<ApiKey>>(
    context,
    `/v1/api-keys?environment_id=${encodeURIComponent(context.environment.id)}`,
    { object: 'list', data: [], has_more: false, next_cursor: null },
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">API keys</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          Keys authenticate every request. Test keys can never touch live accounts.
        </p>
      </header>

      <Card>
        <CardHeader
          title="API keys"
          description={`In the ${context.environment.kind} environment`}
          action={<Badge tone={context.environment.kind === 'live' ? 'brand' : 'neutral'}>
            {context.environment.kind}
          </Badge>}
        />
        {keys.data.length === 0 ? (
          <EmptyState
            title="No keys yet"
            description="Create a key to start using the API. The value is shown once and cannot be retrieved later."
          />
        ) : (
          <ul className="divide-y">
            {keys.data.map((key) => (
              <li key={key.id} className="px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{key.name}</p>
                    <p className="mt-0.5 font-mono text-xs text-[var(--text-subtle)]">
                      {key.key_prefix}…
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                      {key.last_used_at ? (
                        <>
                          last used <Timestamp iso={key.last_used_at} />
                        </>
                      ) : (
                        'never used'
                      )}{' '}
                      · {key.scopes.length} scope{key.scopes.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <Badge tone={key.status === 'active' ? 'ok' : 'neutral'}>{key.status}</Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <CreateKeyForm environmentId={context.environment.id} />
    </div>
  );
}
