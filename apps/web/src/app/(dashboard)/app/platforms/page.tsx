import { renderLoadFailure } from '@/components/page-states';
import { Badge, Card, CardHeader, CopyButton, Timestamp } from '@/components/ui';
import type { ListResponse } from '@/lib/api';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';

import { CredentialForm } from './credential-form';

export const metadata = { title: 'Platform credentials' };

/**
 * Platform credentials (plan §23).
 *
 * This page is where a granted platform approval becomes a working integration. Every
 * adapter reads its client id and secret from the database at call time, so pasting them
 * here switches that platform on — no deploy, no restart, no code change.
 */

interface ProviderApp {
  id: string;
  provider: string;
  ownership: string;
  client_id: string | null;
  configured: boolean;
  approval_status: string;
  redirect_uri: string;
  updated_at: string;
}

interface Platform {
  provider: string;
  display_name: string;
  available: boolean;
  requires_provider_app: boolean;
}

const EMPTY = { object: 'list' as const, data: [], has_more: false, next_cursor: null };

export default async function PlatformsPage() {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  const [apps, platforms] = await Promise.all([
    sessionFetchOr<ListResponse<ProviderApp>>(
      context,
      `/v1/provider-apps?environment_id=${encodeURIComponent(context.environment.id)}`,
      EMPTY,
    ),
    sessionFetchOr<ListResponse<Platform>>(context, '/v1/platforms', EMPTY),
  ]);

  const configured = new Map(apps.data.map((app) => [app.provider, app]));

  // Only platforms whose adapter exists and whose auth model actually needs a registered
  // application. Bluesky and Telegram have nothing to paste, and listing them here would
  // imply they are blocked on something.
  const needsCredentials = platforms.data.filter(
    (platform) => platform.available && platform.requires_provider_app,
  );

  const ready = platforms.data.filter(
    (platform) => platform.available && !platform.requires_provider_app,
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Platform credentials</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          Paste a platform’s client id and secret and that platform goes live. No deploy needed.
        </p>
      </header>

      {ready.length > 0 ? (
        <Card>
          <CardHeader
            title="Ready now"
            description="These need no registered application at all"
          />
          <ul className="divide-y">
            {ready.map((platform) => (
              <li
                key={platform.provider}
                className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5"
              >
                <span className="text-sm font-medium">{platform.display_name}</span>
                <Badge tone="ok">No setup needed</Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Needs credentials"
          description="Adapters are built and tested. They wait only on the platform’s client id and secret."
        />
        {needsCredentials.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-[var(--text-subtle)] sm:px-5">
            Every built platform is configured.
          </p>
        ) : (
          <ul className="divide-y">
            {needsCredentials.map((platform) => {
              const app = configured.get(platform.provider);
              return (
                <li key={platform.provider} className="px-4 py-3 sm:px-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{platform.display_name}</p>
                      {app?.configured ? (
                        <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                          client id <span className="font-mono">{app.client_id}</span> ·{' '}
                          {app.ownership.replaceAll('_', ' ')} · updated{' '}
                          <Timestamp iso={app.updated_at} />
                        </p>
                      ) : (
                        <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                          Not configured. Connecting this platform returns
                          PROVIDER_NOT_CONFIGURED until credentials are stored.
                        </p>
                      )}
                      {/* The reviewer checks this exact string against what is registered,
                          so it is copyable rather than something to retype. */}
                      {app?.redirect_uri ? (
                        <div className="mt-2 flex items-center gap-2">
                          <code className="min-w-0 truncate rounded bg-[var(--surface-sunken)] px-2 py-1 font-mono text-xs">
                            {app.redirect_uri}
                          </code>
                          <CopyButton value={app.redirect_uri} />
                        </div>
                      ) : null}
                    </div>
                    <Badge tone={app?.configured ? 'ok' : 'warn'}>
                      {app?.configured ? 'Configured' : 'Needs credentials'}
                    </Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <CredentialForm platforms={needsCredentials} />
    </div>
  );
}
