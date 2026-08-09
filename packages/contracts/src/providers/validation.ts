import { z } from 'zod';

import { ProviderNameSchema } from '../common/providers.js';

/**
 * Preflight validation results (plan §18, P7 "validation is part of the product").
 *
 * The shape is shared by the adapter's internal `validate()` and the public
 * `POST /v1/posts/preflight` response, so an adapter finding cannot be richer than what
 * the API can express — the two drifting is how "preflight said fine, publish failed"
 * happens.
 *
 * Hard rule from plan §18: the validation pipeline calls adapter validators but MUST NOT
 * perform social publish side effects. A `validate()` that uploads media to warm a cache
 * is a bug, not an optimization.
 */

/**
 * Severity decides whether publishing proceeds.
 *
 *   error    this target cannot publish as composed
 *   warning  it will publish, but not as the author probably intends — silent truncation,
 *            a stripped link, a re-encode
 *
 * Warnings are surfaced rather than swallowed because plan P16 says users should not have
 * to memorize platform specifications; a warning is how the product teaches instead.
 */
export const ValidationSeveritySchema = z.enum(['error', 'warning']);
export type ValidationSeverity = z.infer<typeof ValidationSeveritySchema>;

export const ValidationFindingSchema = z
  .object({
    severity: ValidationSeveritySchema,
    /** Stable SCREAMING_SNAKE_CASE code, documented in `docs/errors/`. */
    code: z.string(),
    message: z.string(),
    /**
     * Which part of the request produced this, as a dotted path
     * (e.g. `content.text`, `media[1]`, `provider_options.tiktok.privacy_level`).
     * Lets a UI attach the finding to the right field instead of dumping it in a banner.
     */
    field: z.string().nullable(),
    /** Machine-readable next step (plan §16, §48.4). */
    agent_action: z.string(),
    /**
     * A concrete fix the caller can apply, when one exists (plan P17 "auto-fix before
     * asking the user to fix"). Consumed by Smart Media Auto-Fit and the composer.
     */
    autofix: z
      .object({
        kind: z.enum([
          'truncate_text',
          'remove_media',
          'transcode_media',
          'crop_media',
          'strip_link',
          'reduce_hashtags',
          'set_privacy_level',
          'remove_mentions',
        ]),
        description: z.string(),
        /** Fix parameters, shape depending on `kind`. */
        parameters: z.record(z.string(), z.unknown()),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type ValidationFinding = z.infer<typeof ValidationFindingSchema>;

/**
 * A transformation publishing will apply if the post proceeds as composed.
 *
 * Distinct from a warning: this is not "you might not want this", it is "here is exactly
 * what we will do". Plan §18 item 11 requires estimated transformations to be reported
 * before publish, so nothing the engine does to content is a surprise after the fact.
 */
export const EstimatedTransformationSchema = z
  .object({
    kind: z.enum(['text_truncated', 'media_transcoded', 'media_cropped', 'link_shortened', 'hashtags_moved']),
    description: z.string(),
    field: z.string().nullable(),
  })
  .strict();

export type EstimatedTransformation = z.infer<typeof EstimatedTransformationSchema>;

/** Validation outcome for one publish target. */
export const TargetValidationResultSchema = z
  .object({
    destination_id: z.string(),
    provider: ProviderNameSchema,
    valid: z.boolean(),
    errors: z.array(ValidationFindingSchema).readonly(),
    warnings: z.array(ValidationFindingSchema).readonly(),
    estimated_transformations: z.array(EstimatedTransformationSchema).readonly(),
  })
  .strict();

export type TargetValidationResult = z.infer<typeof TargetValidationResultSchema>;

/**
 * What an adapter's `validate()` returns: findings for one target, without the identity
 * fields the engine already knows. Keeping the adapter from restating `destination_id`
 * removes a class of bug where an adapter echoes the wrong one.
 */
export interface AdapterValidationResult {
  findings: readonly ValidationFinding[];
  estimatedTransformations: readonly EstimatedTransformation[];
}

/** Convenience: a target is valid when nothing at `error` severity was found. */
export function isValid(findings: readonly ValidationFinding[]): boolean {
  return !findings.some((f) => f.severity === 'error');
}

export function partitionFindings(findings: readonly ValidationFinding[]): {
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
} {
  const errors: ValidationFinding[] = [];
  const warnings: ValidationFinding[] = [];
  for (const finding of findings) {
    (finding.severity === 'error' ? errors : warnings).push(finding);
  }
  return { errors, warnings };
}
