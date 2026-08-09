import type {
  EstimatedTransformation,
  ValidationFinding,
} from '@gs/contracts/validation';

/**
 * Builders for validation findings.
 *
 * Adapters produce a lot of these, and hand-writing the object literal every time is how
 * `agent_action` ends up inconsistent across providers — which matters, because agents
 * branch on that string (plan §16, §48.4). These helpers make the common shapes uniform.
 */

export function error(
  code: string,
  message: string,
  options: {
    field?: string | null;
    agentAction: string;
    autofix?: ValidationFinding['autofix'];
  },
): ValidationFinding {
  return {
    severity: 'error',
    code,
    message,
    field: options.field ?? null,
    agent_action: options.agentAction,
    autofix: options.autofix ?? null,
  };
}

export function warning(
  code: string,
  message: string,
  options: {
    field?: string | null;
    agentAction: string;
    autofix?: ValidationFinding['autofix'];
  },
): ValidationFinding {
  return {
    severity: 'warning',
    code,
    message,
    field: options.field ?? null,
    agent_action: options.agentAction,
    autofix: options.autofix ?? null,
  };
}

export function transformation(
  kind: EstimatedTransformation['kind'],
  description: string,
  field: string | null = null,
): EstimatedTransformation {
  return { kind, description, field };
}

// ---------------------------------------------------------------------------
// Constraint checks shared by every adapter
//
// These encode limits the adapter declares in its capability document, so a provider
// cannot drift between "what it says it allows" and "what it rejects".
// ---------------------------------------------------------------------------

/**
 * Text length against a limit.
 *
 * Counts by Unicode code points, not UTF-16 units, because `"👋".length === 2` while every
 * platform counts it as one character. Getting this wrong rejects valid posts containing
 * emoji, which is most of them.
 */
export function checkTextLength(
  text: string,
  maxLength: number | null,
  options: { code: string; truncatable?: boolean } = { code: 'TEXT_TOO_LONG' },
): ValidationFinding | null {
  if (maxLength === null) return null;

  const length = [...text].length;
  if (length <= maxLength) return null;

  return error(options.code, `Text is ${length} characters; this destination allows ${maxLength}.`, {
    field: 'content.text',
    agentAction: 'shorten_text',
    autofix: options.truncatable
      ? {
          kind: 'truncate_text',
          description: `Truncate to ${maxLength} characters.`,
          parameters: { max_length: maxLength },
        }
      : null,
  });
}

export function checkMediaCount(
  count: number,
  maxCount: number | null,
  code = 'TOO_MANY_MEDIA_ITEMS',
): ValidationFinding | null {
  if (maxCount === null || count <= maxCount) return null;

  return error(code, `${count} media items attached; this destination allows ${maxCount}.`, {
    field: 'media',
    agentAction: 'remove_media',
    autofix: {
      kind: 'remove_media',
      description: `Keep the first ${maxCount} media items.`,
      parameters: { keep_first: maxCount },
    },
  });
}

export function checkMediaType(
  mimeType: string,
  supported: readonly string[],
  index: number,
  code = 'MEDIA_TYPE_UNSUPPORTED',
): ValidationFinding | null {
  // An empty list means the adapter declares no constraint, not that nothing is allowed.
  if (supported.length === 0 || supported.includes(mimeType)) return null;

  return error(code, `${mimeType} is not supported here. Supported: ${supported.join(', ')}.`, {
    field: `media[${index}]`,
    agentAction: 'create_or_select_a_compliant_media_variant',
    autofix: {
      kind: 'transcode_media',
      description: `Transcode to ${supported[0]}.`,
      parameters: { target_mime_type: supported[0] },
    },
  });
}

export function checkMediaSize(
  bytes: number,
  maxBytes: number | null,
  index: number,
  code = 'MEDIA_TOO_LARGE',
): ValidationFinding | null {
  if (maxBytes === null || bytes <= maxBytes) return null;

  const mb = (n: number) => (n / 1_048_576).toFixed(1);
  return error(code, `Media is ${mb(bytes)} MB; this destination allows ${mb(maxBytes)} MB.`, {
    field: `media[${index}]`,
    agentAction: 'create_media_variant',
    autofix: {
      kind: 'transcode_media',
      description: 'Re-encode at a lower bitrate to fit the size limit.',
      parameters: { max_bytes: maxBytes },
    },
  });
}

export function checkVideoDuration(
  durationSeconds: number | null,
  bounds: { min: number | null; max: number | null },
  index: number,
): ValidationFinding | null {
  // Rule 14: an unprobed duration is not assumed to be fine. The caller decides whether a
  // missing probe blocks publishing; here it simply cannot be checked.
  if (durationSeconds === null) return null;

  if (bounds.max !== null && durationSeconds > bounds.max) {
    return error('VIDEO_TOO_LONG', `Video is ${durationSeconds}s; the maximum here is ${bounds.max}s.`, {
      field: `media[${index}]`,
      agentAction: 'trim_video',
    });
  }

  if (bounds.min !== null && durationSeconds < bounds.min) {
    return error('VIDEO_TOO_SHORT', `Video is ${durationSeconds}s; the minimum here is ${bounds.min}s.`, {
      field: `media[${index}]`,
      agentAction: 'lengthen_video',
    });
  }

  return null;
}

/** Drops nulls so a chain of checks can be spread straight into a findings array. */
export function collect(...findings: readonly (ValidationFinding | null)[]): ValidationFinding[] {
  return findings.filter((f): f is ValidationFinding => f !== null);
}
