import { ERROR_CATALOG, type GeneratedErrorCode } from './error-catalog.generated';

/**
 * The error reference, derived from the catalog rather than written twice.
 *
 * Every error envelope the API returns carries a `docs_url`. It pointed at
 * `docs.gainingsocial.com`, a hostname that has never existed — so the single most useful
 * field in a failure response was a dead link, on every error, for every customer. These
 * pages are what it points at now.
 *
 * The per-code facts come from `error-catalog.generated.ts`, emitted from `@gs/errors` and
 * verified in CI. Hand-writing 89 pages would guarantee that some of them eventually
 * described a status or a retryability the API no longer returns, and a reference that is
 * subtly wrong is worse than one that is terse.
 *
 * What is written by hand is the part a catalog cannot hold: what a family of errors
 * actually means, and what to do about one.
 */

export interface ErrorFamily {
  type: string;
  title: string;
  /** What this whole family means, and the general shape of the fix. */
  summary: string;
}

export const ERROR_FAMILIES: readonly ErrorFamily[] = [
  {
    type: 'authentication_error',
    title: 'Authentication',
    summary:
      'The request did not carry a usable API key. Nothing about the key was accepted, so no tenant was resolved and no work was attempted. These are never retryable with the same key.',
  },
  {
    type: 'authorization_error',
    title: 'Authorization',
    summary:
      'The key is valid but is not allowed to do this. Either it lacks the scope, or it is pointed at a different environment or tenant than the resource it named. Ownership is checked server-side on every operation, so this is a real boundary rather than a UI restriction.',
  },
  {
    type: 'validation_error',
    title: 'Validation',
    summary:
      'The request was understood and refused. Either its shape is wrong, or its content cannot be published to a destination that was named. Preflight returns the same codes without publishing anything, which is the cheapest way to encounter them.',
  },
  {
    type: 'not_found_error',
    title: 'Not found',
    summary:
      'The named resource does not exist within your tenant. Note the last part: a resource belonging to somebody else returns not-found rather than forbidden, deliberately, so an identifier cannot be probed for existence across tenants.',
  },
  {
    type: 'conflict_error',
    title: 'Conflict',
    summary:
      'The resource exists but is in a state that does not allow this operation — cancelling a post that already published, retrying a target that never failed. The fix is to read the current state rather than to retry.',
  },
  {
    type: 'idempotency_error',
    title: 'Idempotency',
    summary:
      'Something about the idempotency key was wrong: missing where one is required, reused with a different body, or still in flight from a previous request. Publishing requires a key because a duplicate published post cannot be undone.',
  },
  {
    type: 'rate_limit_error',
    title: 'Rate limits',
    summary:
      'A limit was hit — ours, the platform’s application-wide budget, or the connected account’s own quota. Retry after the interval given rather than immediately; several of these carry a `retry_after` computed from what the provider told us.',
  },
  {
    type: 'connection_error',
    title: 'Connections',
    summary:
      'The connected social account cannot currently be used: it needs reauthorization, it was revoked at the platform, or its setup was never finished. These are resolved by a person reconnecting the account, not by retrying.',
  },
  {
    type: 'media_error',
    title: 'Media',
    summary:
      'A file could not be used as asked. Media is inspected for its real dimensions, duration and format rather than trusted from the request, so these reflect the file as it actually is.',
  },
  {
    type: 'provider_error',
    title: 'Providers',
    summary:
      'The social network itself failed, refused, or answered ambiguously. Raw provider errors are normalized and sanitized before they reach you — the code tells you what happened in this API’s vocabulary rather than the platform’s.',
  },
  {
    type: 'api_error',
    title: 'Service',
    summary:
      'Something on our side went wrong or is deliberately switched off. Quote the `request_id` from the response when reporting one.',
  },
];

export interface ErrorDoc extends GeneratedErrorCode {
  family: ErrorFamily;
}

const FAMILY_BY_TYPE = new Map(ERROR_FAMILIES.map((family) => [family.type, family]));

/** Fallback so a newly added error family cannot make a page throw at build time. */
const UNKNOWN_FAMILY: ErrorFamily = {
  type: 'api_error',
  title: 'Other',
  summary: 'An error whose family has no description yet.',
};

const BY_CODE = new Map(ERROR_CATALOG.map((entry) => [entry.code, entry]));

export function errorDoc(code: string): ErrorDoc {
  const entry = BY_CODE.get(code);
  if (!entry) throw new Error(`Unknown error code: ${code}`);
  return { ...entry, family: FAMILY_BY_TYPE.get(entry.type) ?? UNKNOWN_FAMILY };
}

export const ALL_ERROR_DOCS: readonly ErrorDoc[] = ERROR_CATALOG.map((entry) => errorDoc(entry.code));

export function errorDocsByFamily(): { family: ErrorFamily; docs: ErrorDoc[] }[] {
  return ERROR_FAMILIES.map((family) => ({
    family,
    docs: ALL_ERROR_DOCS.filter((doc) => doc.type === family.type),
  })).filter((group) => group.docs.length > 0);
}

export function isErrorCode(value: string): boolean {
  return BY_CODE.has(value);
}

/**
 * `shorten_text` reads as `Shorten text` for a human without losing the exact string an
 * agent branches on, which is printed verbatim alongside it.
 */
export function humanizeAgentAction(action: string): string {
  const words = action.split('_');
  const first = words[0] ?? '';
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}

/** Advice keyed on the two facts that actually determine what a caller should do. */
export function whatToDo(doc: ErrorDoc): string {
  if (doc.retryable) {
    return 'This error is marked retryable, which means the identical request could succeed later. Back off before retrying — exponentially, or after the interval in `retry_after` when one is present.';
  }
  if (doc.status === 404) {
    return 'Retrying will not help. Check the identifier, and check that it belongs to the environment the key is scoped to — a test key cannot see live resources, and vice versa.';
  }
  if (doc.status === 401 || doc.status === 403) {
    return 'Retrying will not help. The key needs to be valid, in the right environment, and carry the required scope. Create a new key with the scope rather than widening an existing one.';
  }
  return 'Retrying the identical request will fail the same way. Change something — the field named in `param`, the destination, or the connection — and send it again.';
}
