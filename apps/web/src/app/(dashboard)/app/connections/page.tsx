import { renderLoadFailure } from '@/components/page-states';
import { Badge, Card, CardHeader, EmptyState, Timestamp, statusPresentation } from '@/components/ui';
import type { ListResponse } from '@/lib/api';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';

import { ConnectPanel } from './connect-panel';

export const metadata = { title: 'Connections' };

/**
 * Connections (plan §56).
 *
 * Health is the primary column, not an afterthought. A connection is a live thing that
 * degrades — tokens expire, users revoke access, platforms rate limit — and the moment one
 * stops working, everything scheduled against it silently stops too.
 */

interface Connection {
  id: string;
  profile_id: string;
  provider: string;
  provider_account_name: string | null;
  provider_account_handle: string | null;
  health: string;
  health_detail: string | null;
  setup_completed_at: string | null;
  connected_at: string;
}

interface Platform {
  provider: string;
  display_name: string;
  available: boolean;
  requires_provider_app: boolean;
}

interface Profile {
  id: string;
  name: string;
}

const EMPTY = { object: 'list' as const, data: [], has_more: false, next_cursor: null };

export default async function ConnectionsPage() {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  const [connections, platforms, profiles] = await Promise.all([
    sessionFetchOr<ListResponse<Connection>>(context, '/v1/connections?limit=100', EMPTY),
    sessionFetchOr<ListResponse<Platform>>(context, '/v1/platforms', EMPTY),
    sessionFetchOr<ListResponse<Profile>>(context, '/v1/profiles?limit=100', EMPTY),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Connections</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          Social accounts linked to your profiles.
        </p>
      </header>

      <Card>
        <CardHeader
          title="Connected accounts"
          description={
            connections.data.length > 0
              ? `${connections.data.length} account${connections.data.length === 1 ? '' : 's'}`
              : undefined
          }
        />
        {connections.data.length === 0 ? (
          <EmptyState
            title="No accounts connected"
            description="Connect a social account to start publishing. Bluesky and Telegram need no platform approval and work as soon as you have a credential."
          />
        ) : (
          <ul className="divide-y">
            {connections.data.map((connection) => {
              const presentation = statusPresentation(connection.health);
              const unfinished = connection.setup_completed_at === null;

              return (
                <li key={connection.id} className="px-4 py-3 sm:px-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {connection.provider_account_name ?? connection.provider}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                        {connection.provider.replaceAll('_', ' ')}
                        {connection.provider_account_handle
                          ? ` · ${connection.provider_account_handle}`
                          : ''}{' '}
                        · connected <Timestamp iso={connection.connected_at} />
                      </p>
                      {/* The reason a connection is unhealthy is the whole point of
                          showing that it is. A badge alone sends people to support. */}
                      {connection.health_detail ? (
                        <p className="mt-1 text-xs text-fail-600">{connection.health_detail}</p>
                      ) : null}
                      {unfinished ? (
                        <p className="mt-1 text-xs text-[var(--text-subtle)]">
                          This account authorized more than one destination. Choose which ones
                          should publish before using it.
                        </p>
                      ) : null}
                    </div>
                    <Badge tone={unfinished ? 'warn' : presentation.tone}>
                      {unfinished ? 'Needs a destination' : presentation.label}
                    </Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ConnectPanel
        environmentId={context.environment.id}
        profiles={profiles.data}
        platforms={platforms.data}
      />

      <Card>
        <CardHeader
          title="Available platforms"
          description="Platforms marked as unavailable are built, but need the platform’s sign-off or credentials before they can publish"
        />
        <ul className="divide-y">
          {platforms.data.map((platform) => (
            <li
              key={platform.provider}
              className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium">{platform.display_name}</span>
                <span className="block text-xs text-[var(--text-subtle)]">
                  {platform.available
                    ? platform.requires_provider_app
                      ? 'Built — needs platform credentials'
                      : 'Ready, no approval needed'
                    : 'Adapter not built yet'}
                </span>
              </span>
              <Badge tone={platform.available ? (platform.requires_provider_app ? 'warn' : 'ok') : 'neutral'}>
                {platform.available ? (platform.requires_provider_app ? 'Needs setup' : 'Available') : 'Not yet'}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
