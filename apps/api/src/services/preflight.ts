import type { TargetValidationResult, ValidationFinding } from '@gs/contracts/validation';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import { isProviderName, type ProviderName } from '@gs/contracts/providers';
import {
  findMediaByIds,
  type DestinationOwnership,
  type Database,
  type MediaAsset,
} from '@gs/db';
import { resolveTargetContent } from '@gs/domain';
import { getAdapter, hasAdapter } from '@gs/providers';
import type { ProviderCallContext, ResolvedMedia } from '@gs/provider-kit';

/**
 * Preflight validation (plan §18, P7).
 *
 * Runs the same resolution the publisher will run, then asks each adapter to validate the
 * result. Sharing the resolution is the whole point: if preflight validated something
 * other than what publishes, the product's central promise would be false.
 *
 * Hard rule: no provider publish side effect happens here. Callers are encouraged to hit
 * preflight freely, and the certification harness asserts adapters honour it.
 *
 * Ten of the eleven checks plan §18 lists are performed by the core — ownership, health,
 * media readiness, scheduling. Only the platform-specific ones are delegated, because
 * only the adapter knows them (P1).
 */

export interface PreflightTargetInput {
  destinationId: string;
  publicDestinationId: string;
  overrides?: Record<string, unknown> | null;
  options?: Record<string, Record<string, unknown>> | null;
}

export interface PreflightInput {
  db: Database;
  context: ProviderCallContext;
  projectEnvironmentId: string;
  profileId: string;
  content: { text: string; media_ids: string[]; link_url?: string | null };
  targets: readonly PreflightTargetInput[];
  ownerships: Map<string, DestinationOwnership>;
  publishAt: Date | null;
}

export interface PreflightOutcome {
  valid: boolean;
  targets: TargetValidationResult[];
}

function finding(
  severity: 'error' | 'warning',
  code: string,
  message: string,
  agentAction: string,
  field: string | null = null,
): ValidationFinding {
  return { severity, code, message, field, agent_action: agentAction, autofix: null };
}

/** Scheduling bounds. A schedule in the past is a bug in the caller, not an instruction. */
const MIN_SCHEDULE_LEAD_MS = 60_000;
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Media as an adapter sees it.
 *
 * `downloadUrl` is deliberately empty during preflight: no adapter may fetch bytes while
 * validating, and handing over a real signed URL would invite exactly that. Adapters
 * validate against probed metadata, which is all they need.
 */
function toResolvedMedia(asset: MediaAsset): ResolvedMedia {
  return {
    mediaId: toPublicId('media', asset.id),
    kind: asset.kind ?? 'image',
    mimeType: asset.mimeType ?? 'application/octet-stream',
    bytes: asset.byteSize ?? 0,
    width: asset.width,
    height: asset.height,
    durationSeconds: asset.durationSeconds,
    altText: asset.altText,
    downloadUrl: '',
  };
}

/** Checks that need no adapter, so a broken connection is reported without a network call. */
function coreFindings(
  ownership: DestinationOwnership | undefined,
  publishAt: Date | null,
  now: Date,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  if (!ownership) {
    findings.push(
      finding(
        'error',
        'DESTINATION_NOT_FOUND',
        'No such destination, or it does not belong to this profile.',
        'list_destinations_for_the_profile',
        'targets.destination_id',
      ),
    );
    return findings;
  }

  if (ownership.disconnectedAt) {
    findings.push(
      finding(
        'error',
        'CONNECTION_DISCONNECTED',
        'The connection behind this destination has been disconnected.',
        'create_connect_session_for_reauthorization',
      ),
    );
  } else if (ownership.connectionHealth === 'reauth_required' || ownership.connectionHealth === 'revoked') {
    findings.push(
      finding(
        'error',
        'CONNECTION_REAUTH_REQUIRED',
        'The connection must be re-authorized before it can publish.',
        'create_connect_session_for_reauthorization',
      ),
    );
  } else if (ownership.connectionHealth === 'permission_missing') {
    findings.push(
      finding(
        'error',
        'CONNECTION_PERMISSION_MISSING',
        'The connection is missing a permission this destination needs.',
        'reauthorize_with_required_scopes',
      ),
    );
  } else if (ownership.connectionHealth === 'rate_limited') {
    // A warning, not an error: publishing still works, it is just delayed. Blocking here
    // would make a transient provider condition look like a content problem.
    findings.push(
      finding(
        'warning',
        'CONNECTION_RATE_LIMITED',
        'The provider is rate limiting this account; publishing may be delayed.',
        'wait_for_retry',
      ),
    );
  }

  if (!ownership.setupCompletedAt) {
    // Plan §21.3 — a connection can exist and still be unusable because a secondary
    // selection was never made. Saying so here beats failing at publish time.
    findings.push(
      finding(
        'error',
        'CONNECTION_INCOMPLETE_SETUP',
        'This connection needs a destination selection before it can publish.',
        'complete_connection_setup',
      ),
    );
  }

  if (!ownership.selected) {
    findings.push(
      finding(
        'error',
        'DESTINATION_NOT_SELECTED',
        'This destination was not selected during connect and cannot be published to.',
        'select_the_destination',
      ),
    );
  }

  if (ownership.profileDisabledAt || ownership.profileDeletedAt) {
    findings.push(
      finding('error', 'PROFILE_DISABLED', 'Publishing is suspended for this profile.', 'enable_the_profile'),
    );
  }

  if (!hasAdapter(ownership.provider)) {
    findings.push(
      finding(
        'error',
        'PROVIDER_NOT_SUPPORTED',
        `No adapter is available for ${ownership.provider} yet.`,
        'check_supported_providers',
      ),
    );
  }

  if (publishAt) {
    const delta = publishAt.getTime() - now.getTime();
    if (delta < MIN_SCHEDULE_LEAD_MS) {
      findings.push(
        finding(
          'error',
          'SCHEDULE_IN_PAST',
          '`publish_at` must be at least a minute in the future. Omit it to publish now.',
          'omit_publish_at_or_choose_a_future_time',
          'publish_at',
        ),
      );
    } else if (delta > MAX_SCHEDULE_AHEAD_MS) {
      findings.push(
        finding(
          'error',
          'SCHEDULE_TOO_FAR_AHEAD',
          'Posts cannot be scheduled more than a year ahead.',
          'choose_a_nearer_time',
          'publish_at',
        ),
      );
    }
  }

  return findings;
}

export async function runPreflight(input: PreflightInput): Promise<PreflightOutcome> {
  const now = new Date();

  // All media for the whole post in one query, including per-target overrides. A
  // ten-image carousel across five targets would otherwise be fifty lookups.
  const publicMediaIds = new Set(input.content.media_ids);
  for (const target of input.targets) {
    const override = target.overrides?.media_ids;
    if (Array.isArray(override)) for (const id of override) publicMediaIds.add(String(id));
  }

  // Callers speak public ids; the database stores UUIDs. Keeping both directions means an
  // unparseable id is reported as not-found rather than silently dropped from the query,
  // which would let a post publish with fewer images than the caller asked for.
  const internalByPublic = new Map<string, string>();
  for (const publicId of publicMediaIds) {
    const internal = fromPublicId('media', publicId);
    if (internal) internalByPublic.set(publicId, internal);
  }

  const mediaByInternalId = await findMediaByIds(input.db, input.projectEnvironmentId, [
    ...internalByPublic.values(),
  ]);

  const mediaByPublicId = new Map<string, MediaAsset>();
  for (const [publicId, internalId] of internalByPublic) {
    const asset = mediaByInternalId.get(internalId);
    if (asset) mediaByPublicId.set(publicId, asset);
  }

  const results: TargetValidationResult[] = [];

  for (const target of input.targets) {
    const ownership = input.ownerships.get(target.destinationId);
    const findings = coreFindings(ownership, input.publishAt, now);

    const provider: ProviderName | null =
      ownership && isProviderName(ownership.provider) ? ownership.provider : null;

    const resolved = resolveTargetContent({
      canonical: {
        text: input.content.text,
        media_ids: input.content.media_ids,
        link: input.content.link_url ?? undefined,
      },
      overrides: target.overrides ?? null,
      options: target.options ?? null,
      provider: ownership?.provider ?? 'unknown',
    });

    // Media has to exist, belong to this environment and be probed. Validating against a
    // client's *claimed* dimensions would approve posts the provider then rejects.
    const media: ResolvedMedia[] = [];
    resolved.media_ids.forEach((publicMediaId: string, index: number) => {
      const asset = mediaByPublicId.get(publicMediaId);
      if (!asset) {
        findings.push(
          finding(
            'error',
            'MEDIA_NOT_FOUND',
            'No such media asset, or it belongs to another environment.',
            'upload_the_media_first',
            `media[${index}]`,
          ),
        );
        return;
      }
      if (asset.status !== 'ready') {
        findings.push(
          finding(
            'error',
            'MEDIA_UPLOAD_INCOMPLETE',
            `Media is ${asset.status}; it must finish probing before it can be published.`,
            'wait_for_media_to_become_ready',
            `media[${index}]`,
          ),
        );
        return;
      }
      media.push(toResolvedMedia(asset));
    });

    let estimatedTransformations: TargetValidationResult['estimated_transformations'] = [];

    // Only ask the adapter once the core checks pass. A disconnected connection has
    // nothing useful to say about text length, and asking would mean a pointless call.
    const coreValid = !findings.some((f) => f.severity === 'error');
    if (coreValid && provider && hasAdapter(provider)) {
      const adapter = getAdapter(provider);
      const adapterResult = await adapter.publishing.validate({
        context: input.context,
        target: {
          postId: 'preflight',
          postTargetId: 'preflight',
          destinationExternalId: ownership!.providerDestinationId,
        },
        content: {
          text: resolved.text ?? '',
          media,
          linkUrl: resolved.link ?? null,
          providerOptions: resolved.options,
          compliance: {},
        },
        // Preflight runs without credentials on purpose: a validator that needs a token
        // is making a network call, which plan §18 forbids.
        credentials: null,
        app: null,
      });

      findings.push(...adapterResult.findings);
      estimatedTransformations = [...adapterResult.estimatedTransformations];
    }

    const errors = findings.filter((f) => f.severity === 'error');
    const warnings = findings.filter((f) => f.severity === 'warning');

    results.push({
      destination_id: target.publicDestinationId,
      provider: provider ?? 'mock',
      valid: errors.length === 0,
      errors,
      warnings,
      estimated_transformations: estimatedTransformations,
    });
  }

  return { valid: results.every((r) => r.valid), targets: results };
}
