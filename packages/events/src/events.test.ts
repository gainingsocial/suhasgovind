import { describe, expect, it, vi } from 'vitest';

import { DOMAIN_EVENT_TYPES, DomainEventBus, createDomainEvent } from './domain-events.js';
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_SECONDS,
  buildWebhookEnvelope,
  isWebhookEventType,
  nextWebhookAttempt,
  webhookTypeForConnectionHealth,
  webhookTypeForDomainEvent,
  webhookTypeForPostStatus,
} from './webhook-events.js';

const base = {
  aggregateId: 'ptg_1',
  aggregateType: 'post_target' as const,
  traceId: 'trc_1',
  organizationId: 'org_1',
  projectId: 'prj_1',
  environmentId: 'env_1',
  environment: 'live' as const,
};

describe('domain events', () => {
  it('stamps an event ID, ISO timestamp and correlation context', () => {
    const event = createDomainEvent({
      ...base,
      type: 'post.target.published',
      payload: { provider_post_id: 'at://x' },
      occurredAt: new Date('2026-08-07T05:16:00.000Z'),
    });

    expect(event.id).toMatch(/^evt_[0-9a-z]{26}$/);
    expect(event.occurredAt).toBe('2026-08-07T05:16:00.000Z');
    expect(event.traceId).toBe('trc_1');
    expect(event.payload).toEqual({ provider_post_id: 'at://x' });
  });

  it('gives every event a unique ID', () => {
    const ids = new Set(
      Array.from({ length: 1000 }, () => createDomainEvent({ ...base, type: 'post.created' }).id),
    );
    expect(ids.size).toBe(1000);
  });
});

describe('DomainEventBus', () => {
  it('delivers to type-specific and wildcard subscribers', async () => {
    const specific = vi.fn();
    const wildcard = vi.fn();
    const bus = new DomainEventBus();

    bus.on('post.target.published', specific);
    bus.on('*', wildcard);

    await bus.emit(createDomainEvent({ ...base, type: 'post.target.published' }));
    await bus.emit(createDomainEvent({ ...base, type: 'post.created' }));

    expect(specific).toHaveBeenCalledTimes(1);
    expect(wildcard).toHaveBeenCalledTimes(2);
  });

  it('isolates a failing subscriber from the others', async () => {
    // A broken analytics consumer must never fail a publish that already succeeded
    // at the provider.
    const failures: unknown[] = [];
    const bus = new DomainEventBus((error) => failures.push(error));
    const healthy = vi.fn();

    bus.on('post.target.published', () => {
      throw new Error('analytics is down');
    });
    bus.on('post.target.published', healthy);

    await expect(
      bus.emit(createDomainEvent({ ...base, type: 'post.target.published' })),
    ).resolves.toBeUndefined();

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(1);
  });

  it('unsubscribes', async () => {
    const handler = vi.fn();
    const bus = new DomainEventBus();
    const off = bus.on('post.created', handler);

    off();
    await bus.emit(createDomainEvent({ ...base, type: 'post.created' }));

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('domain → webhook mapping', () => {
  it('classifies every domain event explicitly', () => {
    // Adding an internal event must be a deliberate decision about customer visibility,
    // never an accidental broadcast of implementation detail.
    for (const type of DOMAIN_EVENT_TYPES) {
      expect(webhookTypeForDomainEvent(type), `${type} is unclassified`).not.toBeUndefined();
    }
  });

  it('keeps internal-only events off the customer surface', () => {
    for (const type of ['post.target.leased', 'connection.credential_refreshed', 'usage.recorded'] as const) {
      expect(webhookTypeForDomainEvent(type)).toBeNull();
    }
  });

  it('maps post statuses to their announcements', () => {
    expect(webhookTypeForPostStatus('published')).toBe('post.published');
    expect(webhookTypeForPostStatus('partially_published')).toBe('post.partially_published');
    expect(webhookTypeForPostStatus('failed')).toBe('post.failed');
    expect(webhookTypeForPostStatus('queued')).toBeNull();
  });

  it('maps unhealthy connections to a reauthorization prompt', () => {
    expect(webhookTypeForConnectionHealth('reauth_required')).toBe('connection.reauth_required');
    expect(webhookTypeForConnectionHealth('revoked')).toBe('connection.reauth_required');
    expect(webhookTypeForConnectionHealth('permission_missing')).toBe('connection.reauth_required');
    expect(webhookTypeForConnectionHealth('disconnected')).toBe('connection.disconnected');
    expect(webhookTypeForConnectionHealth('healthy')).toBeNull();
  });

  it('validates webhook type strings', () => {
    expect(isWebhookEventType('post.published')).toBe(true);
    expect(isWebhookEventType('post.target.leased')).toBe(false);
  });
});

describe('webhook envelope', () => {
  it('carries the stable event ID and API version', () => {
    const event = createDomainEvent({
      ...base,
      profileId: 'pro_1',
      type: 'post.target.published',
      occurredAt: new Date('2026-08-07T05:16:00.000Z'),
    });

    const envelope = buildWebhookEnvelope({
      event,
      type: 'post.target.published',
      apiVersion: '2026-08-07',
      data: { post_id: 'pst_1' },
    });

    expect(envelope).toEqual({
      event_id: event.id,
      type: 'post.target.published',
      created_at: '2026-08-07T05:16:00.000Z',
      api_version: '2026-08-07',
      project_id: 'prj_1',
      environment: 'live',
      profile_id: 'pro_1',
      data: { post_id: 'pst_1' },
    });
  });
});

describe('webhook retry schedule', () => {
  const now = new Date('2026-08-07T05:00:00.000Z');

  it('follows the documented backoff curve', () => {
    const delays = WEBHOOK_RETRY_DELAYS_SECONDS.map(
      (_, index) => nextWebhookAttempt(index, { now, jitterRatio: 0, random: () => 0.5 })!.delaySeconds,
    );

    expect(delays).toEqual([0, 30, 120, 600, 3600, 21_600, 86_400]);
  });

  it('delivers the first attempt immediately', () => {
    const first = nextWebhookAttempt(0, { now, jitterRatio: 0 })!;

    expect(first.attempt).toBe(1);
    expect(first.delaySeconds).toBe(0);
    expect(first.scheduledAt.toISOString()).toBe(now.toISOString());
  });

  it('exhausts after the documented number of attempts', () => {
    expect(nextWebhookAttempt(WEBHOOK_MAX_ATTEMPTS - 1, { now })).not.toBeNull();
    expect(nextWebhookAttempt(WEBHOOK_MAX_ATTEMPTS, { now })).toBeNull();
  });

  it('applies jitter so a shared outage does not synchronize retries', () => {
    const low = nextWebhookAttempt(3, { now, random: () => 0 })!;
    const high = nextWebhookAttempt(3, { now, random: () => 1 })!;

    expect(low.delaySeconds).toBe(480); // 600 - 20%
    expect(high.delaySeconds).toBe(720); // 600 + 20%
  });

  it('never produces a negative delay', () => {
    for (let attempt = 0; attempt < WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      expect(nextWebhookAttempt(attempt, { now, random: () => 0 })!.delaySeconds).toBeGreaterThanOrEqual(0);
    }
  });
});
