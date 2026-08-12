/**
 * `@gs/provider-meta-core` — the parts of the Graph API that Facebook, Instagram and
 * Threads genuinely share.
 *
 * Not an adapter. It has no `ProviderName`, is never registered in `@gs/providers`, and
 * publishes nothing on its own. It is a leaf library under `packages/providers/*` so the
 * P1 boundary still holds: nothing outside a provider package may import it.
 */
export {
  appSecretProof,
  GRAPH_CODE,
  GRAPH_HOST,
  GRAPH_VERSION,
  GraphError,
  graphCall,
  normalizeGraphError,
  requireAccessToken,
  THREADS_HOST,
  type GraphCallInput,
  type GraphErrorBody,
  type GraphResult,
  type GraphUsage,
} from './graph.js';

export {
  buildAuthorizationUrl,
  exchangeCodeForLongLivedToken,
  exchangeForLongLivedToken,
  inspectToken,
  listManagedPages,
  revokePermissions,
  SHORT_LIVED_TOKEN_WARNING,
  TASK_CREATE_CONTENT,
  type ExchangedToken,
  type ManagedPage,
} from './facebook-login.js';

export {
  handleMetaWebhook,
  metaHandshake,
  parseMetaEvents,
  verifyMetaSignature,
} from './webhooks.js';

export {
  ContainerNotReadyError,
  readContainerStatus,
  waitForContainer,
  type ContainerPollConfig,
  type ContainerState,
  type ContainerStatus,
  type WaitOptions,
} from './containers.js';
