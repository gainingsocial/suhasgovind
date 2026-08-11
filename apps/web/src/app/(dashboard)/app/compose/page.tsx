import { renderLoadFailure } from '@/components/page-states';
import { Badge } from '@/components/ui';
import type { ListResponse } from '@/lib/api';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';

import { Composer } from './composer';

export const metadata = { title: 'Compose' };

/**
 * Composer (plan §57).
 *
 * The product's central promise is that you write once and every platform gets something
 * it will accept. So the composer shows per-destination consequences *before* you press
 * publish — the same preflight an API caller would run, against the same body that will be
 * published, because plan §18's guarantee is worthless if the UI checks something else.
 */

interface Connection {
  id: string;
  profile_id: string;
  provider: string;
  provider_account_name: string | null;
  health: string;
  setup_completed_at: string | null;
}

interface Destination {
  id: string;
  connection_id: string;
  provider: string;
  name: string;
  selected: boolean;
}

interface Profile {
  id: string;
  name: string;
}

const EMPTY = { object: 'list' as const, data: [], has_more: false, next_cursor: null };

export default async function ComposePage() {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  const [profiles, connections] = await Promise.all([
    sessionFetchOr<ListResponse<Profile>>(context, '/v1/profiles?limit=100', EMPTY),
    sessionFetchOr<ListResponse<Connection>>(context, '/v1/connections?limit=100', EMPTY),
  ]);

  // Only connections that can actually publish. Offering a destination behind a broken or
  // unfinished connection means composing a post that fails the moment it is submitted.
  const usable = connections.data.filter(
    (connection) =>
      connection.setup_completed_at !== null &&
      (connection.health === 'healthy' || connection.health === 'refresh_due'),
  );

  const destinationLists = await Promise.all(
    usable.map((connection) =>
      sessionFetchOr<ListResponse<Destination>>(
        context,
        `/v1/connections/${connection.id}/destinations`,
        EMPTY,
      ),
    ),
  );

  const destinations = destinationLists
    .flatMap((list) => list.data)
    .filter((destination) => destination.selected)
    .map((destination) => {
      const connection = usable.find((row) => row.id === destination.connection_id);
      return {
        id: destination.id,
        profileId: connection?.profile_id ?? '',
        provider: destination.provider,
        name: destination.name,
        accountName: connection?.provider_account_name ?? null,
      };
    });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Compose</h1>
          <p className="mt-1 text-sm text-[var(--text-subtle)]">
            Write once. Every destination gets a version it will accept.
          </p>
        </div>
        <Badge tone="brand">Preflight on</Badge>
      </header>

      <Composer profiles={profiles.data} destinations={destinations} />
    </div>
  );
}
