/**
 * In-memory state for the mock provider (plan §49 test/simulation mode).
 *
 * The mock exists to prove the publishing engine end to end with zero network. That means
 * it has to be a *believable* provider, not a stub that always succeeds — the engine's
 * hardest paths are rate limits, ambiguous timeouts and duplicate suppression, and those
 * only get exercised if something can produce them on demand.
 *
 * State is per-isolate and deliberately not persisted. A test sets the behaviour it wants,
 * runs, and resets.
 */

export interface MockPublishedPost {
  externalPostId: string;
  externalUrl: string;
  destinationExternalId: string;
  /** Content fingerprint, used to answer reconciliation queries (ADR-006 Layer 4). */
  idempotencyKey: string;
  text: string;
  publishedAt: string;
  /** Set when the mock is asked to behave as an async-processing provider. */
  processingUntil?: number;
}

/**
 * How the mock should behave on the next publish.
 *
 * `failWith` names a scenario rather than an HTTP status because the point is to exercise
 * a *normalization path*, and the tests that matter are written in terms of "what happens
 * on an ambiguous timeout", not "what happens on a 504".
 */
export interface MockBehaviour {
  failWith:
    | null
    /** Provider accepted it but processes asynchronously — exercises the status poll. */
    | 'processing'
    /** 429 with Retry-After — exercises `respect_provider_retry_after`. */
    | 'rate_limited'
    /** 401 — exercises reauthorization detection and connection health. */
    | 'auth_expired'
    /** 403 — exercises the permanent, non-retryable path. */
    | 'auth_revoked'
    /** 5xx — exercises exponential backoff. */
    | 'unavailable'
    /**
     * The important one. The post IS created but the response never arrives, so a naive
     * engine retries and duplicates. Reconciliation must find the orphan.
     */
    | 'timeout_after_side_effect'
    /** Timeout with no side effect. Reconciliation must prove absence and allow a retry. */
    | 'timeout_no_side_effect'
    /** 4xx content rejection — exercises the permanent-failure path. */
    | 'content_rejected';
  /** Applies the behaviour only this many times, then reverts to success. */
  remaining: number;
  /** Milliseconds the provider takes to "process" when `failWith` is `processing`. */
  processingMs: number;
  /** Seconds the mock reports in Retry-After when rate limiting. */
  retryAfterSeconds: number;
}

const DEFAULT_BEHAVIOUR: MockBehaviour = {
  failWith: null,
  remaining: 0,
  processingMs: 50,
  retryAfterSeconds: 2,
};

class MockStore {
  private behaviour: MockBehaviour = { ...DEFAULT_BEHAVIOUR };
  private readonly posts = new Map<string, MockPublishedPost>();
  private sequence = 0;

  /** Set of scopes the mock connection is treated as having granted. */
  grantedScopes: string[] = ['post.write', 'post.read', 'destination.read'];
  /** Account classification, so effective-capability narrowing can be exercised. */
  accountType: string | null = 'business';

  setBehaviour(behaviour: Partial<MockBehaviour>): void {
    this.behaviour = { ...this.behaviour, ...behaviour };
  }

  /**
   * Read the behaviour for one attempt, decrementing `remaining`.
   *
   * Consuming on read is what makes "fail twice then succeed" expressible, which is the
   * shape almost every retry test needs.
   */
  consumeBehaviour(): MockBehaviour['failWith'] {
    if (this.behaviour.failWith === null || this.behaviour.remaining <= 0) return null;
    this.behaviour.remaining -= 1;
    return this.behaviour.failWith;
  }

  currentBehaviour(): Readonly<MockBehaviour> {
    return this.behaviour;
  }

  nextPostId(): string {
    this.sequence += 1;
    return `mock_post_${this.sequence.toString().padStart(6, '0')}`;
  }

  record(post: MockPublishedPost): void {
    this.posts.set(post.externalPostId, post);
  }

  get(externalPostId: string): MockPublishedPost | undefined {
    return this.posts.get(externalPostId);
  }

  delete(externalPostId: string): boolean {
    return this.posts.delete(externalPostId);
  }

  /**
   * Find a post matching a content fingerprint — the mock's answer to "did this already
   * publish?". A real adapter searches the destination's recent posts; the shape of the
   * question is identical, which is the point.
   */
  findByIdempotencyKey(
    destinationExternalId: string,
    idempotencyKey: string,
    publishedAtOrAfter: string,
  ): MockPublishedPost | undefined {
    for (const post of this.posts.values()) {
      if (
        post.destinationExternalId === destinationExternalId &&
        post.idempotencyKey === idempotencyKey &&
        post.publishedAt >= publishedAtOrAfter
      ) {
        return post;
      }
    }
    return undefined;
  }

  all(): MockPublishedPost[] {
    return [...this.posts.values()];
  }

  reset(): void {
    this.behaviour = { ...DEFAULT_BEHAVIOUR };
    this.posts.clear();
    this.sequence = 0;
    this.grantedScopes = ['post.write', 'post.read', 'destination.read'];
    this.accountType = 'business';
  }
}

export const mockStore = new MockStore();
