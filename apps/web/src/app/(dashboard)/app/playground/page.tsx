import { renderLoadFailure } from '@/components/page-states';
import type { ListResponse } from '@/lib/api';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';

import { Playground, type PlaygroundEndpoint } from './playground-client';

export const metadata = { title: 'Playground' };

/**
 * The developer playground (plan §58).
 *
 * Auto-populated from the current environment: a real key, a real profile id, a real
 * destination id. §58 asks for exactly that, and the reason is the first ten minutes — an
 * explorer that opens with `{profileId}` in the path is a form somebody has to go and do
 * research to fill in, which is the friction it exists to remove.
 */

interface Profile {
  id: string;
}

interface Destination {
  id: string;
}

/**
 * The endpoints worth exploring, in the order somebody meets them.
 *
 * A curated subset rather than everything in the OpenAPI document. The full surface is
 * documented at `/openapi.json`; a playground listing sixty operations is a menu nobody
 * reads, and the point here is to get somebody to a successful call quickly.
 */
function endpointsFor(profileId: string | null, destinationId: string | null): PlaygroundEndpoint[] {
  const post = JSON.stringify(
    {
      profile_id: profileId ?? 'pro_…',
      content: { text: 'Hello from the playground.', media_ids: [] },
      targets: [{ destination_id: destinationId ?? 'dst_…' }],
    },
    null,
    2,
  );

  return [
    {
      method: 'GET',
      path: '/v1/profiles',
      summary: 'List profiles',
      description: 'The brands and customers in this environment. Most calls need one of these ids.',
      tag: 'Start here',
      writes: false,
    },
    {
      method: 'GET',
      path: '/v1/connections',
      summary: 'List connections',
      description:
        'Connected accounts and their health. A connection that is not healthy cannot publish, and the health value says why.',
      tag: 'Start here',
      writes: false,
    },
    {
      method: 'GET',
      path: '/v1/destinations/{destinationId}/capabilities',
      summary: 'Get capabilities',
      description:
        'What this specific account can do — character limits, media formats, aspect ratios. These differ by account type, so never assume them.',
      tag: 'Start here',
      writes: false,
    },
    {
      method: 'POST',
      path: '/v1/compose',
      summary: 'Compose for every network',
      description:
        'One piece of writing, prepared per network, with a preview of exactly what each would publish. Never publishes anything.',
      tag: 'Publishing',
      sampleBody: JSON.stringify(
        {
          profile_id: profileId ?? 'pro_…',
          content: { text: 'Hello from the playground.', media_ids: [] },
          targets: [{ destination_id: destinationId ?? 'dst_…' }],
          mode: 'optimize',
        },
        null,
        2,
      ),
      writes: false,
    },
    {
      method: 'POST',
      path: '/v1/posts/preflight',
      summary: 'Validate without publishing',
      description:
        'Same body as creating a post. Performs no side effect, so call it as often as you like.',
      tag: 'Publishing',
      sampleBody: post,
      writes: false,
    },
    {
      method: 'POST',
      path: '/v1/posts',
      summary: 'Publish a post',
      description:
        'Returns 202. Publishing is asynchronous — poll the post or wait for a webhook rather than assuming success.',
      tag: 'Publishing',
      sampleBody: post,
      writes: true,
    },
    {
      method: 'GET',
      path: '/v1/posts',
      summary: 'List posts',
      description: 'Recent posts with rolled-up target counts.',
      tag: 'Publishing',
      writes: false,
    },
    {
      method: 'GET',
      path: '/v1/provider-health',
      summary: 'Provider status',
      description:
        'Recent success rates per platform. Tells "this platform is having a bad hour" apart from "this post is wrong".',
      tag: 'Observe',
      writes: false,
    },
    {
      method: 'GET',
      path: '/v1/analytics/summary',
      summary: 'Analytics summary',
      description: 'Totals from the latest observation of each post. Never a live provider call.',
      tag: 'Observe',
      writes: false,
    },
    {
      method: 'GET',
      path: '/v1/usage',
      summary: 'Usage',
      description: 'Metered usage for the last 30 days, summed from the immutable event log.',
      tag: 'Observe',
      writes: false,
    },
  ];
}

export default async function PlaygroundPage() {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  /**
   * Ids are fetched so the samples are runnable, and failures are tolerated.
   *
   * An environment with no profile yet should still get a working playground — the samples
   * simply carry placeholders. Failing the whole page because there is nothing to publish
   * to would hide the tool at exactly the moment somebody is trying to learn the API.
   */
  const [profiles, destinations] = await Promise.all([
    sessionFetchOr<ListResponse<Profile>>(context, '/v1/profiles?limit=1', {
      object: 'list',
      data: [],
      has_more: false,
      next_cursor: null,
    }),
    sessionFetchOr<ListResponse<Destination>>(context, '/v1/destinations?limit=1', {
      object: 'list',
      data: [],
      has_more: false,
      next_cursor: null,
    }),
  ]);

  const profileId = profiles.data[0]?.id ?? null;
  const destinationId = destinations.data[0]?.id ?? null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Playground</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          Real requests against the real API, pre-filled with this environment&rsquo;s ids.
          Paste a key below — a{' '}
          <strong>{context.environment.kind}</strong> key, to match this environment.
        </p>
      </header>

      <Playground
        endpoints={endpointsFor(profileId, destinationId)}
        apiOrigin={process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8787'}
        // Never the key itself: keys are only ever shown once, at creation. Somebody
        // pastes one in, and it stays in the browser rather than being stored anywhere.
        defaultKey={null}
        environmentKind={context.environment.kind}
        profileId={profileId}
        destinationId={destinationId}
      />
    </div>
  );
}
