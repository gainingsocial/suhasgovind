import { toPublicId } from '@gs/contracts/ids';
import {
  attachProviderEventOwner,
  emitWebhookEvent,
  findConnectionsByProviderAccount,
  markProviderEventProcessed,
  setConnectionHealth,
  type Database,
  type ProviderEvent,
  type SocialConnection,
} from '@gs/db';
import { CURRENT_WEBHOOK_API_VERSION } from '@gs/events';
import type { Logger } from '@gs/observability';
import type { ProviderEventKind, VerifiedProviderEvent } from '@gs/provider-kit';

/**
 * Turning a verified provider event into a domain effect (plan §34, §42).
 *
 * Runs on the queue, never in the ingress. Every step is idempotent because the queue is
 * at-least-once (P4): the health transition is conditional on the current value, and the
 * customer webhook is emitted only when that transition actually moved something. A
 * redelivered revocation therefore produces one `connection.reauth_required`, not one per
 * delivery.
 */

/**
 * How each event kind maps onto connection health.
 *
 * `null` means "record it, change nothing". That is the correct handling for the majority
 * of provider traffic — engagement events and account metadata changes say nothing about
 * whether the credential still works, and downgrading health on one would disable
 * publishing for an account that is perfectly healthy.
 */
const HEALTH_FOR_KIND: Partial<Record<ProviderEventKind, SocialConnection['health']>> = {
  authorization_revoked: 'revoked',
  permissions_changed: 'permission_missing',
};

export interface ProcessResult {
  /** How many connections the event applied to. Zero is normal and not an error. */
  affectedConnections: number;
  /** True when at least one connection's health actually moved. */
  changed: boolean;
}

export async function processProviderEvent(
  db: Database,
  row: ProviderEvent,
  logger: Logger,
): Promise<ProcessResult> {
  /**
   * A rejected signature reaches processing only if something enqueued it by mistake.
   * Acting on an unverified payload is how a forged webhook disconnects a real account,
   * so this is checked again here rather than trusted from the ingress.
   */
  if (!row.signatureVerified) {
    await markProviderEventProcessed(db, row.id, 'signature_not_verified');
    return { affectedConnections: 0, changed: false };
  }

  const event = row.payload as unknown as VerifiedProviderEvent;

  if (!event?.externalAccountId) {
    // Nothing to route it to. Stored for forensics, closed out so the sweeper stops
    // seeing it — an event we cannot attribute will never become attributable later.
    await markProviderEventProcessed(db, row.id, 'no_external_account_id');
    return { affectedConnections: 0, changed: false };
  }

  const connections = await findConnectionsByProviderAccount(
    db,
    row.provider,
    event.externalAccountId,
  );

  if (connections.length === 0) {
    await markProviderEventProcessed(db, row.id, 'no_matching_connection');
    return { affectedConnections: 0, changed: false };
  }

  // Attribution is recorded even when several connections match, so the event is findable
  // from at least one of them in the dashboard.
  await attachProviderEventOwner(db, row.id, {
    connectionId: connections[0]!.id,
    projectEnvironmentId: connections[0]!.projectEnvironmentId,
  });

  const health = HEALTH_FOR_KIND[event.kind];
  if (!health) {
    await markProviderEventProcessed(db, row.id, null);
    return { affectedConnections: connections.length, changed: false };
  }

  let changed = false;

  for (const connection of connections) {
    const transition = await setConnectionHealth(db, connection.id, health, event.eventType, {
      reason: `Provider webhook: ${event.eventType}`,
      traceId: row.traceId,
    });

    if (!transition.changed) continue;
    changed = true;

    /**
     * Told once, at the moment it becomes true.
     *
     * `connection.reauth_required` is the event a customer builds an alert on (plan §42),
     * and an alert that fires on every webhook redelivery is an alert that gets muted.
     */
    await emitWebhookEvent(db, {
      organizationId: connection.organizationId,
      projectId: connection.projectId,
      projectEnvironmentId: connection.projectEnvironmentId,
      profileId: connection.profileId,
      eventType: 'connection.reauth_required',
      apiVersion: CURRENT_WEBHOOK_API_VERSION,
      payload: {
        connection_id: toPublicId('connection', connection.id),
        provider: connection.provider,
        health,
        reason: event.eventType,
        detected_by: 'provider_webhook',
      },
      aggregateType: 'connection',
      aggregateId: connection.id,
      traceId: row.traceId ?? undefined,
    });

    logger.info('provider_webhook.connection_health_changed', {
      provider: row.provider,
      from: transition.from,
      to: transition.to,
      kind: event.kind,
    });
  }

  await markProviderEventProcessed(db, row.id, null);
  return { affectedConnections: connections.length, changed };
}
