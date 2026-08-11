import { renderLoadFailure } from '@/components/page-states';
import { Card, CardHeader, EmptyState, ResourceId, Timestamp } from '@/components/ui';
import type { ListResponse } from '@/lib/api';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';

import { CreateProfileForm } from './create-profile-form';

export const metadata = { title: 'Profiles' };

/**
 * Profiles (plan §55).
 *
 * A profile is the brand, customer or creator identity you publish on behalf of.
 * Everything publishable hangs off one, which is why this page comes before connections
 * in the onboarding order.
 */

interface Profile {
  id: string;
  name: string;
  external_id: string | null;
  timezone: string;
  disabled_at: string | null;
  created_at: string;
}

export default async function ProfilesPage() {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  const profiles = await sessionFetchOr<ListResponse<Profile>>(context, '/v1/profiles?limit=100', {
    object: 'list',
    data: [],
    has_more: false,
    next_cursor: null,
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Profiles</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          Each profile is a brand or customer you publish for. Connections and posts belong to one.
        </p>
      </header>

      <Card>
        <CardHeader
          title="Your profiles"
          description={profiles.data.length > 0 ? `${profiles.data.length} total` : undefined}
        />
        {profiles.data.length === 0 ? (
          <EmptyState
            title="No profiles yet"
            description="Create a profile for each brand, client or location you publish on behalf of."
          />
        ) : (
          <ul className="divide-y">
            {profiles.data.map((profile) => (
              <li key={profile.id} className="px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {profile.name}
                      {profile.disabled_at ? (
                        <span className="ml-2 text-xs text-[var(--text-subtle)]">disabled</span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                      {profile.timezone}
                      {profile.external_id ? ` · your id: ${profile.external_id}` : ''} · created{' '}
                      <Timestamp iso={profile.created_at} />
                    </p>
                  </div>
                  {/* The id is what an integrator puts in their code, so it is copyable
                      here rather than something to select by hand from a details page. */}
                  <ResourceId id={profile.id} label="Profile id" />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <CreateProfileForm />
    </div>
  );
}
