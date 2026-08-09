import {
  NO_CAPABILITIES,
  type CapabilityRestriction,
  type ProviderCapabilities,
} from '@gs/contracts/capabilities';
import type { ProviderName } from '@gs/contracts/providers';

/**
 * Capability document construction (plan §17).
 *
 * Every adapter builds from `NO_CAPABILITIES`, so a field added to the schema later
 * defaults to "not supported" for adapters that have not considered it. The alternative —
 * spreading a permissive default — means a new capability silently reads as `true`
 * everywhere and preflight starts approving posts the provider will reject.
 */

export interface BuildCapabilitiesInput {
  provider: ProviderName;
  adapterVersion: string;
  resolution: 'generic' | 'effective';
  publishing?: Partial<ProviderCapabilities['publishing']>;
  actions?: Partial<ProviderCapabilities['actions']>;
  constraints?: Partial<ProviderCapabilities['constraints']>;
  restrictions?: readonly CapabilityRestriction[];
}

export function buildCapabilities(input: BuildCapabilitiesInput): ProviderCapabilities {
  return {
    schema_version: NO_CAPABILITIES.schema_version,
    provider: input.provider,
    adapter_version: input.adapterVersion,
    resolution: input.resolution,
    publishing: { ...NO_CAPABILITIES.publishing, ...input.publishing },
    actions: { ...NO_CAPABILITIES.actions, ...input.actions },
    constraints: { ...NO_CAPABILITIES.constraints, ...input.constraints },
    restrictions: input.restrictions ?? [],
    resolved_at: new Date().toISOString(),
  };
}

/**
 * Narrow a generic capability document to what one destination can actually do.
 *
 * Every capability turned off produces a restriction explaining why, because
 * `video: false` without a reason is useless to an agent — it cannot tell "the platform
 * doesn't do video" from "you're missing a scope", and the remediation differs completely
 * (plan §48.4).
 *
 * Restriction is one-way: this can only remove capabilities, never add them. An adapter
 * that thinks a destination can do more than the platform generically supports has a bug
 * in its generic document.
 */
export function restrictCapabilities(
  generic: ProviderCapabilities,
  restrictions: readonly CapabilityRestriction[],
): ProviderCapabilities {
  const publishing = { ...generic.publishing };
  const actions = { ...generic.actions };

  for (const restriction of restrictions) {
    const [group, key] = restriction.capability.split('.');
    if (key === undefined) continue;

    if (group === 'publishing' && key in publishing) {
      publishing[key as keyof typeof publishing] = false;
    } else if (group === 'actions' && key in actions) {
      actions[key as keyof typeof actions] = false;
    }
    // A restriction naming an unknown capability is retained in the list rather than
    // dropped: it still tells a human something, and silently discarding it would hide
    // an adapter bug.
  }

  return {
    ...generic,
    resolution: 'effective',
    publishing,
    actions,
    restrictions,
    resolved_at: new Date().toISOString(),
  };
}

/** Restriction for a capability gated behind an OAuth scope the connection lacks. */
export function scopeRestriction(
  capability: string,
  requiredScopes: readonly string[],
): CapabilityRestriction {
  return {
    capability,
    reason: 'scope_missing',
    message: `Requires ${requiredScopes.join(', ')}, which this connection did not grant.`,
    agent_action: 'reauthorize_with_required_scopes',
    required_scopes: requiredScopes,
  };
}

/** Restriction for a capability the connected account type cannot use. */
export function accountTypeRestriction(
  capability: string,
  required: string,
  actual: string | null,
): CapabilityRestriction {
  return {
    capability,
    reason: 'account_type_ineligible',
    message: `Requires a ${required} account; this connection is ${actual ?? 'of an unknown type'}.`,
    agent_action: 'connect_an_eligible_account',
  };
}

/**
 * Restriction for a capability blocked by pending platform approval.
 *
 * The case plan §63 is about: TikTok forces unaudited clients to private-only posting and
 * YouTube restricts unverified projects' uploads to private. Surfacing it as a capability
 * restriction rather than a publish-time failure is the difference between a caller
 * knowing up front and finding out after the post is silently private.
 */
export function approvalRestriction(capability: string, detail: string): CapabilityRestriction {
  return {
    capability,
    reason: 'provider_approval_pending',
    message: detail,
    agent_action: 'await_platform_approval',
  };
}

/** True when every scope in `required` was granted. */
export function hasScopes(granted: readonly string[], required: readonly string[]): boolean {
  const set = new Set(granted);
  return required.every((scope) => set.has(scope));
}
