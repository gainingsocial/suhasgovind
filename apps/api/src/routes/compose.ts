import { ComposeRequestSchema, ComposeResponseSchema, type ComposedTarget } from '@gs/contracts/http';
import { fromPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import type { FitDecision } from '@gs/contracts/validation';
import { findDestinationOwnerships, findProfileById, type DestinationOwnership } from '@gs/db';
import { planTextFit } from '@gs/domain';
import { ApiError } from '@gs/errors';
import { getAdapter, hasAdapter } from '@gs/providers';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { providerCallContext } from '../lib/provider-context.js';
import { parseBody } from '../lib/request.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';
import { runPreflight } from '../services/preflight.js';

/**
 * The Smart Universal Composer (plan §63B, §63C).
 *
 * > Upload once. Write once. Select networks. We prepare everything else.
 *
 * Runs the pipeline §63C specifies — resolve destinations, load effective capability,
 * evaluate text, evaluate media, build per-target variants, run auto-fit, run preflight,
 * report consolidated readiness — and returns a preview per network plus the exact
 * override needed to publish it.
 *
 * It does not publish. `POST /v1/posts` remains the only thing that does, which keeps one
 * idempotency story and one state machine rather than two.
 *
 * Returning `publish_override` matters more than it looks: without it every caller would
 * re-derive the adaptation themselves from the findings, and any drift between their
 * derivation and ours means publishing something subtly different from the preview the
 * author approved.
 */
export const compose = new Hono<AppEnv>();

/** Composition validates and previews; it never touches a provider. Still needs a bound. */
const COMPOSE_TIMEOUT_MS = 10_000;

/** Readiness, worst-first, so a mixed post reports its weakest target. */
const STATUS_FOR_DECISION: Record<FitDecision, ComposedTarget['status']> = {
  PASS: 'ready',
  SAFE_AUTOFIX: 'adapted',
  REVIEW_AUTOFIX: 'needs_review',
  USER_DECISION_REQUIRED: 'needs_decision',
  UNSUPPORTED: 'blocked',
};

const STATUS_RANK: Record<ComposedTarget['status'], number> = {
  ready: 0,
  adapted: 1,
  needs_review: 2,
  needs_decision: 3,
  blocked: 4,
};

const DECISION_RANK: Record<FitDecision, number> = {
  PASS: 0,
  SAFE_AUTOFIX: 1,
  REVIEW_AUTOFIX: 2,
  USER_DECISION_REQUIRED: 3,
  UNSUPPORTED: 4,
};

function worse(a: FitDecision, b: FitDecision): FitDecision {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

/**
 * One sentence a person reads before any detail (plan §63C: "plain-language guidance
 * appears first; technical details are expandable").
 *
 * Deliberately says what happened, not what is wrong. "Shortened to fit" tells somebody
 * what to look at; "validation failed" sends them hunting.
 */
function summarize(status: ComposedTarget['status'], name: string, detail: string | null): string {
  switch (status) {
    case 'ready':
      return `Ready to publish to ${name}.`;
    case 'adapted':
      return `Ready — ${detail ?? 'adapted automatically for this network'}.`;
    case 'needs_review':
      return `Nearly ready — ${detail ?? 'one change needs a look before publishing'}.`;
    case 'needs_decision':
      return `Needs a choice — ${detail ?? 'this network cannot take the post as composed'}.`;
    case 'blocked':
      return `Cannot publish to ${name} — ${detail ?? 'this content is not supported here'}.`;
  }
}

async function resolveOwnedProfile(c: Context<AppEnv>, publicProfileId: string): Promise<string> {
  const principal = c.get('principal');

  const profileId = fromPublicId('profile', publicProfileId);
  if (!profileId) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`profile_id` is not a valid profile id.',
      param: 'profile_id',
    });
  }

  if (principal.restrictedToProfileId !== null && principal.restrictedToProfileId !== profileId) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  const profile = await findProfileById(c.get('db'), principal.projectEnvironmentId, profileId);
  if (!profile) throw new ApiError('PROFILE_NOT_FOUND');

  return profileId;
}

compose.post('/', withDatabase(), authenticate(['posts:read']), async (c) => {
  const principal = c.get('principal');
  const body = await parseBody(c, ComposeRequestSchema);
  const profileId = await resolveOwnedProfile(c, body.profile_id);

  const requested = body.targets.map((target) => {
    const internalId = fromPublicId('destination', target.destination_id);
    if (!internalId) {
      throw new ApiError('INVALID_REQUEST', {
        message: `\`${target.destination_id}\` is not a valid destination id.`,
        param: 'targets.destination_id',
      });
    }
    return { internalId, publicId: target.destination_id };
  });

  const ownerships = await findDestinationOwnerships(
    c.get('db'),
    requested.map((entry) => entry.internalId),
  );

  // Ownership is verified before anything is composed (P5). Composing first would tell a
  // caller the character limit of a network somebody else's account is connected to.
  //
  // Over `requested` rather than over the ownership map, and for the same reason as in
  // `resolveTargets`: the map holds only destinations that exist, so an id matching
  // nothing was never checked here, while another tenant's threw 403 — telling a caller
  // which of the two they had guessed.
  for (const entry of requested) {
    const ownership = ownerships.get(entry.internalId);

    const wrongTenant =
      !ownership ||
      ownership.projectEnvironmentId !== principal.projectEnvironmentId ||
      ownership.projectId !== principal.projectId ||
      ownership.organizationId !== principal.organizationId;

    if (wrongTenant) {
      throw new ApiError('DESTINATION_NOT_FOUND', {
        message: `No such destination (${entry.publicId}).`,
        param: 'targets.destination_id',
      });
    }

    if (ownership.profileId !== profileId) {
      throw new ApiError('TENANT_FORBIDDEN', {
        message: 'A destination does not belong to this profile.',
        param: 'targets.destination_id',
      });
    }
  }

  const context = providerCallContext(c, { timeoutMs: COMPOSE_TIMEOUT_MS });

  /**
   * Preflight runs once for the whole set, before adaptation.
   *
   * It is the same code `POST /v1/posts` runs, which is what makes the composer's readout
   * trustworthy: a preview that came from different logic than the publish would be a
   * confident description of something that never happens.
   */
  const preflight = await runPreflight({
    db: c.get('db'),
    context,
    projectEnvironmentId: principal.projectEnvironmentId,
    organizationId: principal.organizationId,
    projectId: principal.projectId,
    profileId,
    content: body.content,
    targets: requested.map((entry) => ({
      destinationId: entry.internalId,
      publicDestinationId: entry.publicId,
    })),
    ownerships,
    publishAt: null,
  });

  const byDestination = new Map(preflight.targets.map((target) => [target.destination_id, target]));
  const targets: ComposedTarget[] = [];

  for (const entry of requested) {
    const ownership = ownerships.get(entry.internalId);
    const validation = byDestination.get(entry.publicId);

    if (!ownership || !validation) {
      targets.push(missingDestination(entry.publicId));
      continue;
    }

    targets.push(
      await composeForTarget({
        c,
        ownership,
        publicDestinationId: entry.publicId,
        validation,
        content: body.content,
        mode: body.mode,
      }),
    );
  }

  const worstStatus = targets.reduce<ComposedTarget['status']>(
    (worstSoFar, target) =>
      STATUS_RANK[target.status] > STATUS_RANK[worstSoFar] ? target.status : worstSoFar,
    'ready',
  );

  const blocked = targets.filter((target) => target.status === 'blocked').length;
  const needing = targets.filter(
    (target) => target.status === 'needs_review' || target.status === 'needs_decision',
  ).length;

  return c.json(
    ComposeResponseSchema.parse({
      object: 'composition',
      mode: body.mode,
      ready: worstStatus === 'ready' || worstStatus === 'adapted',
      summary:
        blocked > 0
          ? `${targets.length - blocked} of ${targets.length} networks are ready; ${blocked} cannot publish this post.`
          : needing > 0
            ? `${targets.length - needing} of ${targets.length} networks are ready; ${needing} need a quick look.`
            : `All ${targets.length} network${targets.length === 1 ? '' : 's'} ready to publish.`,
      targets,
    }),
    200,
  );
});

function missingDestination(publicDestinationId: string): ComposedTarget {
  return {
    destination_id: publicDestinationId,
    provider: 'mock',
    destination_name: 'Unknown destination',
    status: 'blocked',
    summary: 'This destination no longer exists.',
    preview: { text: '', first_comment_hashtags: [], media_ids: [], link_url: null },
    text_adaptations: [],
    media_fit: null,
    errors: [
      {
        code: 'DESTINATION_NOT_FOUND',
        message: 'No such destination, or it does not belong to this profile.',
        agent_action: 'list_destinations_for_the_profile',
      },
    ],
    warnings: [],
    publish_override: {},
  };
}

interface ComposeTargetInput {
  c: Context<AppEnv>;
  ownership: DestinationOwnership;
  publicDestinationId: string;
  validation: (typeof runPreflight extends (...args: never) => Promise<infer R>
    ? R extends { targets: (infer T)[] }
      ? T
      : never
    : never);
  content: { text: string; media_ids: string[]; link_url?: string | null };
  mode: 'exact' | 'optimize';
}

async function composeForTarget(input: ComposeTargetInput): Promise<ComposedTarget> {
  const { ownership, validation, content, mode } = input;
  const provider = isProviderName(ownership.provider) ? ownership.provider : null;

  /**
   * Effective capability where the destination has one, generic otherwise — the same
   * precedence media auto-fit uses. Composing against generic capability would show an
   * author a 2,200-character limit their unaudited account cannot actually use.
   */
  const constraints =
    (ownership.capabilities as { constraints?: Parameters<typeof planTextFit>[1] } | null)
      ?.constraints ??
    (provider && hasAdapter(provider)
      ? (
          await getAdapter(provider).capabilities({
            context: providerCallContext(input.c, { timeoutMs: COMPOSE_TIMEOUT_MS }),
            app: null,
          })
        ).constraints
      : null);

  const text = constraints
    ? planTextFit(
        {
          text: content.text,
          linkUrl: content.link_url ?? null,
          mode,
          supportsFirstComment: provider === 'instagram',
        },
        constraints,
      )
    : { text: content.text, extractedHashtags: [], adaptations: [], decision: 'PASS' as FitDecision };

  const mediaDecision = validation.media_fit?.decision ?? 'PASS';
  const combined = validation.errors.length > 0 ? 'UNSUPPORTED' : worse(text.decision, mediaDecision);
  const status = STATUS_FOR_DECISION[combined];

  const detail =
    validation.errors[0]?.message ??
    text.adaptations[0]?.reason ??
    validation.media_fit?.items.flatMap((item) => item.transforms)[0]?.reason ??
    null;

  /**
   * The override that reproduces this preview exactly.
   *
   * Only fields that actually changed. An override restating the canonical text would make
   * every later edit to the canonical post silently fail to reach this target — the author
   * would fix a typo once and see it corrected everywhere except the network that had been
   * "adapted".
   */
  const override: Record<string, unknown> = { destination_id: input.publicDestinationId };
  if (text.text !== content.text) {
    override.overrides = { text: text.text };
  }

  return {
    destination_id: input.publicDestinationId,
    provider: provider ?? 'mock',
    destination_name: ownership.destinationName,
    status,
    summary: summarize(status, ownership.destinationName, detail),
    preview: {
      text: text.text,
      first_comment_hashtags: text.extractedHashtags,
      media_ids: content.media_ids,
      link_url: content.link_url ?? null,
    },
    text_adaptations: text.adaptations.map((adaptation) => ({
      kind: adaptation.kind,
      decision: adaptation.decision,
      reason: adaptation.reason,
    })),
    media_fit: validation.media_fit,
    errors: validation.errors.map((error) => ({
      code: error.code,
      message: error.message,
      agent_action: error.agent_action,
    })),
    warnings: validation.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      agent_action: warning.agent_action,
    })),
    publish_override: override,
  };
}
