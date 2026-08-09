import { fromPublicId, type ResourceKind } from '@gs/contracts/ids';
import { ApiError } from '@gs/errors';
import type { Context } from 'hono';
import { type z } from 'zod';

import type { AppEnv } from '../env.js';

/**
 * Request parsing helpers.
 *
 * Every one of these turns a malformed input into a typed `ApiError` carrying the field
 * that was wrong. Plan §16 is explicit that an agent must never have to parse an English
 * sentence to work out what to do, so a validation failure has to name its `param`.
 */

/** Zod issues → the `FieldIssue[]` the error envelope publishes. */
function toFieldIssues(error: z.ZodError): { param: string; code: string; message: string }[] {
  return error.issues.map((issue) => ({
    param: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * Parse and validate a JSON request body.
 *
 * A body that is not JSON at all is its own error rather than a schema failure: reporting
 * "expected object, received undefined" for a malformed payload sends the caller looking
 * at the wrong thing.
 */
export async function parseBody<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError('INVALID_REQUEST', {
      message: 'Request body must be valid JSON.',
    });
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError('INVALID_REQUEST', {
      message: 'The request body failed validation.',
      details: toFieldIssues(result.error),
    });
  }

  return result.data;
}

/** Parse and validate the query string. */
export function parseQuery<S extends z.ZodType>(c: Context<AppEnv>, schema: S): z.infer<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    throw new ApiError('INVALID_REQUEST', {
      message: 'The query string failed validation.',
      details: toFieldIssues(result.error),
    });
  }

  return result.data;
}

/**
 * Resolve a prefixed public id from the path to its internal UUID.
 *
 * A wrong-prefix id (`pst_…` where a profile was expected) is rejected here rather than
 * being looked up and missing. That distinction matters: a 404 would suggest the resource
 * might exist somewhere, when in fact the caller passed the wrong kind of thing entirely.
 */
export function requirePathId(
  c: Context<AppEnv>,
  kind: ResourceKind,
  param: string,
): string {
  const value = c.req.param(param);
  if (!value) {
    throw new ApiError('INVALID_REQUEST', { message: `Missing \`${param}\` in the path.` });
  }

  const uuid = fromPublicId(kind, value);
  if (!uuid) {
    throw new ApiError('INVALID_REQUEST', {
      message: `\`${value}\` is not a valid ${kind} id.`,
      param,
    });
  }

  return uuid;
}

/**
 * Read the `Idempotency-Key` header (plan §25 Layer 1).
 *
 * Required on unsafe operations that create provider side effects. Optional here so the
 * route decides — `POST /v1/posts` demands one, `POST /v1/profiles` does not, because a
 * duplicate profile is recoverable and a duplicate published post is not.
 */
export function idempotencyKey(c: Context<AppEnv>): string | null {
  const value = c.req.header('idempotency-key');
  if (!value) return null;

  // Bounded because it is stored and indexed. An unbounded header becomes an unbounded
  // index entry.
  if (value.length < 8 || value.length > 255) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`Idempotency-Key` must be between 8 and 255 characters.',
    });
  }

  return value;
}
