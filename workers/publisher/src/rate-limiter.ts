/**
 * Rate-limit coordination Durable Object (plan §29).
 *
 * Provider rate limits are per app, per account and sometimes per destination — never per
 * Worker isolate. Cloudflare runs many isolates concurrently, so a per-isolate counter
 * coordinates nothing: ten isolates each politely staying under the limit will together
 * blow through it ten times over. A Durable Object is the only thing in the platform that
 * gives a single serialization point for a given key.
 *
 * What this object knows is deliberately mostly *observed* rather than assumed. We do not
 * hard-code "LinkedIn allows N per hour" — provider limits change without notice, and a
 * stale constant is worse than none. Instead the limiter learns from `Retry-After` and
 * rate-limit headers the provider actually returns, and applies a conservative default
 * concurrency cap in the meantime.
 */

interface LimiterState {
  /** Permits currently held. Released explicitly, or when they age out. */
  active: { permitId: string; expiresAt: number }[];
  /** Set from a provider 429. No permits are issued until it passes. */
  cooldownUntil: number | null;
  /** Remaining budget the provider last reported, if it reports one. */
  remaining: number | null;
  /** When the provider says the window resets. */
  resetAt: number | null;
  /** Consecutive 429s. Drives a widening cooldown when a provider keeps refusing. */
  consecutive429: number;
}

const INITIAL_STATE: LimiterState = {
  active: [],
  cooldownUntil: null,
  remaining: null,
  resetAt: null,
  consecutive429: 0,
};

/**
 * Concurrent in-flight calls per key.
 *
 * Low on purpose. Publishing is not latency-sensitive — a post arriving two seconds later
 * is invisible to the customer, whereas tripping an app-level rate limit degrades every
 * tenant sharing that provider app.
 */
const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Permits expire so a worker that crashes mid-call cannot leak one forever. Slightly
 * longer than the longest provider call budget.
 */
const PERMIT_TTL_MS = 60_000;

export interface PermitRequest {
  /** Rate-limit dimension, e.g. `linkedin:member:con_123`. */
  key: string;
  maxConcurrency?: number;
}

export interface PermitResponse {
  granted: boolean;
  permitId?: string;
  /** When to try again, as epoch ms. Present when `granted` is false. */
  retryAfterMs?: number;
  reason?: 'cooldown' | 'concurrency' | 'budget_exhausted';
}

export interface ReportRequest {
  key: string;
  permitId?: string;
  /** Provider's HTTP status, so a 429 can widen the cooldown. */
  status?: number;
  /** Parsed `Retry-After`, as epoch ms. */
  retryAfterMs?: number;
  remaining?: number;
  resetAtMs?: number;
}

export class RateLimiter implements DurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async load(key: string): Promise<LimiterState> {
    return (await this.state.storage.get<LimiterState>(key)) ?? { ...INITIAL_STATE, active: [] };
  }

  private async save(key: string, value: LimiterState): Promise<void> {
    await this.state.storage.put(key, value);
  }

  /** Drop permits whose holder never reported back. */
  private prune(limiter: LimiterState, now: number): LimiterState {
    return { ...limiter, active: limiter.active.filter((p) => p.expiresAt > now) };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/acquire') {
      const body = (await request.json()) as PermitRequest;
      return Response.json(await this.acquire(body));
    }

    if (url.pathname === '/report') {
      const body = (await request.json()) as ReportRequest;
      await this.report(body);
      return Response.json({ ok: true });
    }

    if (url.pathname === '/release') {
      const body = (await request.json()) as { key: string; permitId: string };
      await this.release(body.key, body.permitId);
      return Response.json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }

  async acquire(input: PermitRequest): Promise<PermitResponse> {
    const now = Date.now();
    let limiter = this.prune(await this.load(input.key), now);

    if (limiter.cooldownUntil && limiter.cooldownUntil > now) {
      // The provider told us to wait. Ignoring it is how an account-level rate limit
      // becomes an app-level ban.
      return { granted: false, retryAfterMs: limiter.cooldownUntil - now, reason: 'cooldown' };
    }

    if (limiter.remaining !== null && limiter.remaining <= 0) {
      const resetIn = limiter.resetAt ? Math.max(limiter.resetAt - now, 1000) : 60_000;
      return { granted: false, retryAfterMs: resetIn, reason: 'budget_exhausted' };
    }

    const max = input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    if (limiter.active.length >= max) {
      // Short retry: a permit is likely to free up in seconds, and a long backoff here
      // would stall a queue that is merely busy rather than limited.
      return { granted: false, retryAfterMs: 2_000, reason: 'concurrency' };
    }

    const permitId = crypto.randomUUID();
    limiter = {
      ...limiter,
      active: [...limiter.active, { permitId, expiresAt: now + PERMIT_TTL_MS }],
      // Decrement optimistically. The provider's next response corrects it, and
      // over-counting is the safe direction to be wrong in.
      remaining: limiter.remaining === null ? null : limiter.remaining - 1,
    };

    await this.save(input.key, limiter);
    return { granted: true, permitId };
  }

  async release(key: string, permitId: string): Promise<void> {
    const limiter = this.prune(await this.load(key), Date.now());
    await this.save(key, {
      ...limiter,
      active: limiter.active.filter((p) => p.permitId !== permitId),
    });
  }

  /**
   * Record what the provider actually said.
   *
   * This is where the limiter learns. A 429 widens the cooldown geometrically, because a
   * provider that refuses twice in a row is telling us the first backoff was too short.
   */
  async report(input: ReportRequest): Promise<void> {
    const now = Date.now();
    let limiter = this.prune(await this.load(input.key), now);

    if (input.permitId) {
      limiter = { ...limiter, active: limiter.active.filter((p) => p.permitId !== input.permitId) };
    }

    if (input.remaining !== undefined) limiter = { ...limiter, remaining: input.remaining };
    if (input.resetAtMs !== undefined) limiter = { ...limiter, resetAt: input.resetAtMs };

    if (input.status === 429) {
      const consecutive = limiter.consecutive429 + 1;
      // Honour the provider's own figure when it gives one; otherwise back off
      // geometrically from 5s, capped at 15 minutes.
      const fallback = Math.min(5_000 * 2 ** (consecutive - 1), 900_000);
      const until = input.retryAfterMs ?? now + fallback;

      limiter = {
        ...limiter,
        consecutive429: consecutive,
        cooldownUntil: Math.max(until, limiter.cooldownUntil ?? 0),
      };
    } else if (input.status !== undefined && input.status < 400) {
      // A clean success means the cooldown worked. Resetting the counter stops one bad
      // minute from suppressing an account for the next hour.
      limiter = { ...limiter, consecutive429: 0, cooldownUntil: null };
    }

    await this.save(input.key, limiter);
  }
}

/**
 * Client helper. Keeps the URL shapes in one place so a worker cannot drift from the
 * object's routes.
 */
export class RateLimiterClient {
  constructor(private readonly namespace: DurableObjectNamespace | undefined) {}

  private stub(key: string) {
    if (!this.namespace) return null;
    // `idFromName` means the same key always reaches the same object — which is the whole
    // point. A random id would give every isolate its own limiter and coordinate nothing.
    return this.namespace.get(this.namespace.idFromName(key));
  }

  async acquire(key: string, maxConcurrency?: number): Promise<PermitResponse> {
    const stub = this.stub(key);
    // No binding means no coordination. Granting is the right default: refusing would
    // stop publishing entirely in a local dev environment, and the provider's own limits
    // still apply.
    if (!stub) return { granted: true, permitId: 'no-limiter' };

    const response = await stub.fetch('https://limiter/acquire', {
      method: 'POST',
      body: JSON.stringify({ key, maxConcurrency }),
    });
    return (await response.json()) as PermitResponse;
  }

  async report(input: ReportRequest): Promise<void> {
    const stub = this.stub(input.key);
    if (!stub) return;
    await stub.fetch('https://limiter/report', { method: 'POST', body: JSON.stringify(input) });
  }

  async release(key: string, permitId: string): Promise<void> {
    const stub = this.stub(key);
    if (!stub || permitId === 'no-limiter') return;
    await stub.fetch('https://limiter/release', {
      method: 'POST',
      body: JSON.stringify({ key, permitId }),
    });
  }
}
