export {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  bytesToUtf8,
  randomBytes,
  timingSafeEqual,
  timingSafeEqualHex,
  utf8ToBytes,
} from './encoding.js';

export {
  decodeSecret,
  hmacSha256,
  hmacSha256Base64Url,
  hmacSha256Hex,
  sha256Hex,
  verifyHmacSha256Hex,
} from './hmac.js';

export type { CredentialContext, EncryptedRecord, KeyringEntry } from './credential-cipher.js';
export {
  CREDENTIAL_ALGORITHM,
  CredentialCipher,
  CredentialDecryptionError,
  CryptoConfigurationError,
  Keyring,
} from './credential-cipher.js';

export type { ApiKeyEnvironment, GeneratedApiKey } from './api-keys.js';
export {
  apiKeyLookupPrefix,
  apiKeyPrefixFor,
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
  parseApiKeyEnvironment,
  redactApiKey,
  verifyApiKey,
} from './api-keys.js';

export type { WebhookVerificationInput, WebhookVerificationResult } from './webhook-signing.js';
export {
  DEFAULT_TOLERANCE_SECONDS,
  WEBHOOK_HEADERS,
  deriveProviderVerifyToken,
  deriveWebhookSecret,
  signWebhookPayload,
  verifyProviderHmacSignature,
  verifyWebhookSignature,
  webhookSigningPayload,
} from './webhook-signing.js';

export type {
  IssueTokenInput,
  SignedTokenClaims,
  TokenVerificationFailure,
  TokenVerificationResult,
  VerifyTokenInput,
} from './signed-token.js';
export { TOKEN_PURPOSE, issueSignedToken, verifySignedToken } from './signed-token.js';
