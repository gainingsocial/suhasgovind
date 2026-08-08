/**
 * The public error envelope (plan §40).
 *
 * Mirrors `ApiError.toEnvelope()` in `@gs/errors`. It lives here, in schema form, because
 * the OpenAPI document and any generated client need it as data — `@gs/errors` produces
 * envelopes, this describes them.
 */
import { z } from 'zod';

export const SuggestedActionSchema = z.object({
  kind: z.string(),
  description: z.string(),
  href: z.string().optional(),
});

export const FieldIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

export const ErrorBodySchema = z.object({
  /** Broad category, e.g. `authentication_error`. Stable. */
  type: z.string(),
  /** Stable, documented, SCREAMING_SNAKE_CASE. Branch on this, not on the message. */
  code: z.string(),
  message: z.string(),
  /** Whether retrying the identical request could succeed. */
  retryable: z.boolean(),
  docs_url: z.string(),
  /** Always present, so a caller can quote one identifier for support. */
  request_id: z.string(),
  trace_id: z.string(),

  param: z.string().optional(),
  provider: z.string().optional(),
  destination_id: z.string().optional(),
  post_id: z.string().optional(),
  target_id: z.string().optional(),
  /** UTC ISO-8601 (Rule 15), when the provider tells us when to retry. */
  retry_after: z.string().optional(),
  /** What an autonomous agent should do next, rather than guessing (plan §51). */
  agent_action: z.string().optional(),
  suggested_actions: z.array(SuggestedActionSchema).optional(),
  details: z.array(FieldIssueSchema).optional(),
});

export const ErrorEnvelopeSchema = z.object({ error: ErrorBodySchema });

export type ErrorEnvelopeShape = z.infer<typeof ErrorEnvelopeSchema>;
