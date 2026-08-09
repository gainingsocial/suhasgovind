/**
 * `@gs/storage` — object-storage concerns shared by the API and the workers.
 *
 * A package rather than a helper inside `apps/api` because the publisher worker needs the
 * same presigner to hand providers a short-lived read URL, and `pnpm boundaries` rightly
 * forbids a worker importing from an app.
 */
export {
  mediaStorageKey,
  presign,
  type PresignedRequest,
  type PresignOptions,
  type R2Credentials,
} from './r2-presign.js';
