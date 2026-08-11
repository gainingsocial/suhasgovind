import { cookies } from 'next/headers';

import { apiFetch, ApiRequestError, type ListResponse } from './api';
import { sessionToken } from './supabase';

/**
 * Server-side API access for the dashboard (plan §39, P15).
 *
 * Every screen reads through the same public API an external customer uses. The dashboard
 * holds no database credential and no long-lived API key — it forwards the signed-in
 * person's short-lived Supabase session, so an XSS bug steals a session that expires
 * rather than a key that does not (plan §39).
 *
 * A person can belong to several environments, so which one a request acts on has to be
 * stated explicitly. The API treats the header as a *selection* and checks it against
 * membership: it selects, it does not authorize.
 */

const ENVIRONMENT_COOKIE = 'gs_environment';

export interface Environment {
  id: string;
  object: 'environment';
  organization_id: string;
  project_id: string;
  kind: 'test' | 'live';
  role: string;
}

/** Signed in, with at least one environment. Everything a dashboard page needs to load. */
export interface DashboardContext {
  token: string;
  environment: Environment;
  environments: Environment[];
}

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in.');
    this.name = 'NotSignedInError';
  }
}

/** A signed-in person who has no organization yet. Distinct from being signed out. */
export class NoEnvironmentError extends Error {
  constructor() {
    super('This account is not a member of any project yet.');
    this.name = 'NoEnvironmentError';
  }
}

/**
 * Resolve the session and the environment to act in.
 *
 * The selected environment is remembered in a cookie so switching does not reset on every
 * navigation, but the cookie is never trusted on its own — the value is looked up in the
 * list the API returned for this person, and an unrecognized one falls back to the default
 * rather than being forwarded. A cookie that could name any environment would be a tenant
 * selector under the user's control.
 */
export async function dashboardContext(): Promise<DashboardContext> {
  const token = await sessionToken();
  if (!token) throw new NotSignedInError();

  const environments = await apiFetch<ListResponse<Environment>>('/v1/environments', {
    apiKey: token,
  });

  if (environments.data.length === 0) throw new NoEnvironmentError();

  const store = await cookies();
  const requested = store.get(ENVIRONMENT_COOKIE)?.value;

  const selected =
    environments.data.find((environment) => environment.id === requested) ??
    // Test first when nothing is chosen. A new user's first actions should not be able to
    // publish to a real audience by default.
    environments.data.find((environment) => environment.kind === 'test') ??
    environments.data[0]!;

  return { token, environment: selected, environments: environments.data };
}

/** Call the API as the signed-in person, in the selected environment. */
export async function sessionFetch<T>(
  context: DashboardContext,
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  return apiFetch<T>(path, {
    apiKey: context.token,
    method: options.method,
    body: options.body,
    idempotencyKey: options.idempotencyKey,
    environmentId: context.environment.id,
  });
}

/**
 * Fetch, or return a fallback when the call fails.
 *
 * Used for the panels on the overview page. One failing panel should degrade to "could
 * not load" rather than replacing the whole dashboard with an error screen — the other
 * panels still carry information the person came for, and an outage on one endpoint is
 * not an outage on all of them.
 */
export async function sessionFetchOr<T>(
  context: DashboardContext,
  path: string,
  fallback: T,
): Promise<T> {
  try {
    return await sessionFetch<T>(context, path);
  } catch (error) {
    if (error instanceof ApiRequestError) return fallback;
    throw error;
  }
}

export { ENVIRONMENT_COOKIE };
