/**
 * API key scopes (plan §38).
 *
 * These live in contracts rather than in the database schema because three layers need
 * them and only one of those may depend on `@gs/db`: the schema that persists a grant,
 * the auth layer that enforces it, and the OpenAPI document that publishes it.
 */
import { z } from 'zod';

/** Every scope the API recognizes. Adding one is a contract change. */
export const API_SCOPES = [
  'profiles:read',
  'profiles:write',
  'connections:read',
  'connections:write',
  'destinations:read',
  'media:read',
  'media:write',
  'posts:read',
  'posts:write',
  'capabilities:read',
  'webhooks:manage',
  'analytics:read',
  'inbox:read',
  'inbox:write',
  /**
   * Content Intelligence (plan §63Q). Separate from `posts:*` because repurposing is
   * optional around publishing (P19) and costs money per call — a key that publishes
   * should not be able to run up a model bill unless it was granted that too.
   */
  'content:read',
  'content:write',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const ApiScopeSchema = z.enum(API_SCOPES);

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/**
 * A `:write` scope does not imply its `:read` counterpart. Making it imply one would mean
 * a key granted only `posts:write` could enumerate existing posts, which is a different
 * capability from creating them — so the implication is deliberately absent and each
 * route declares exactly what it needs.
 */
export function hasScope(granted: readonly string[], required: ApiScope): boolean {
  return granted.includes(required);
}
