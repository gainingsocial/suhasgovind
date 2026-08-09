import { ProviderCapabilitiesSchema } from '@gs/contracts/capabilities';
import { PROVIDER_NAMES, requiresProviderApp } from '@gs/contracts/providers';
import { ValidationFindingSchema } from '@gs/contracts/validation';
import { PROVIDER_ERROR_CODES } from '@gs/errors';
import { describe, expect, it } from 'vitest';

import type { SocialProviderAdapter } from '../adapter.js';
import { ProviderTimeoutError } from '../http.js';
import type {
  ProviderAppCredentials,
  ProviderCredentials,
  ResolvedTargetContent,
  TargetRef,
} from '../types.js';
import { createTestContext } from './context.js';

/**
 * Adapter contract tests (plan §66.2, enforcing the §65 certification checklist).
 *
 * Every adapter runs this suite. It is deliberately provider-agnostic: it asserts the
 * things that must be true of *any* adapter, so a new provider cannot ship having
 * quietly skipped reconciliation, or having invented an error code the engine does not
 * understand.
 *
 * What it cannot check is whether the adapter matches the real provider — that needs the
 * mock provider server (§66.3) and live test-account tests (§66.5). This is the floor,
 * not the ceiling.
 */

export interface CertificationFixtures {
  /** Constructed fresh per test so state cannot leak between assertions. */
  createAdapter: () => SocialProviderAdapter;
  /** Credentials the adapter would receive after a successful connect. */
  credentials: ProviderCredentials;
  /** `null` for strategies that need no registered platform app (Bluesky, Telegram). */
  app: ProviderAppCredentials | null;
  target: TargetRef;
  /** Content that must validate cleanly. */
  validContent: ResolvedTargetContent;
  /** Content that must produce at least one `error` finding, e.g. over-length text. */
  invalidContent: ResolvedTargetContent;
  /**
   * Set when the platform genuinely offers no way to search recent posts, which makes
   * `findPossibleDuplicate` impossible. Requires a written justification — this waives a
   * real safety property (ADR-006 Layer 4), so it should be rare and argued.
   */
  reconciliationUnavailableBecause?: string;
}

export function certifyAdapter(fixtures: CertificationFixtures): void {
  const name = fixtures.createAdapter().provider;

  describe(`adapter certification: ${name}`, () => {
    // ---- identity -----------------------------------------------------------

    describe('identity', () => {
      it('declares a registered provider name', () => {
        expect(PROVIDER_NAMES).toContain(fixtures.createAdapter().provider);
      });

      it('declares a non-empty adapter version', () => {
        // Recorded on every attempt (plan §44). An empty version makes a behaviour
        // change unattributable after the fact.
        expect(fixtures.createAdapter().version).toMatch(/\S/);
      });

      it('declares an auth strategy consistent with whether an app is supplied', () => {
        const adapter = fixtures.createAdapter();
        const needsApp = requiresProviderApp(adapter.authStrategy);

        // A strategy needing a registered app must be given one, and one that does not
        // must work without — that is what lets Bluesky ship before any approval lands.
        expect(needsApp).toBe(fixtures.app !== null);
      });
    });

    // ---- capabilities (§65 Destinations, Validation) -------------------------

    describe('capabilities', () => {
      it('returns a schema-valid generic document', async () => {
        const capabilities = await fixtures.createAdapter().capabilities();
        expect(() => ProviderCapabilitiesSchema.parse(capabilities)).not.toThrow();
        expect(capabilities.resolution).toBe('generic');
      });

      it('stamps its own provider and version onto the document', async () => {
        const adapter = fixtures.createAdapter();
        const capabilities = await adapter.capabilities();
        expect(capabilities.provider).toBe(adapter.provider);
        expect(capabilities.adapter_version).toBe(adapter.version);
      });

      it('resolves effective capability that never exceeds generic capability', async () => {
        const adapter = fixtures.createAdapter();
        const generic = await adapter.capabilities();
        const effective = await adapter.capabilities({
          context: createTestContext(),
          app: fixtures.app,
          credentials: fixtures.credentials,
          destinationExternalId: fixtures.target.destinationExternalId,
          grantedScopes: fixtures.credentials.grantedScopes,
        });

        expect(effective.resolution).toBe('effective');

        // Restriction is one-way (plan §17). A destination that appears to do more than
        // the platform generically supports means the generic document is wrong.
        for (const [key, enabled] of Object.entries(effective.publishing)) {
          if (enabled) {
            expect(
              generic.publishing[key as keyof typeof generic.publishing],
              `publishing.${key} is enabled for the destination but not generically`,
            ).toBe(true);
          }
        }
      });

      it('explains every capability it removes', async () => {
        const adapter = fixtures.createAdapter();
        const generic = await adapter.capabilities();
        const effective = await adapter.capabilities({
          context: createTestContext(),
          app: fixtures.app,
          credentials: fixtures.credentials,
          destinationExternalId: fixtures.target.destinationExternalId,
          grantedScopes: fixtures.credentials.grantedScopes,
        });

        const explained = new Set(effective.restrictions.map((r) => r.capability));

        for (const [key, enabled] of Object.entries(generic.publishing)) {
          if (enabled && !effective.publishing[key as keyof typeof effective.publishing]) {
            // Unexplained removal leaves an agent unable to tell "impossible" from
            // "fixable by re-authorizing" (plan §48.4).
            expect(explained, `publishing.${key} was removed without a restriction`).toContain(
              `publishing.${key}`,
            );
          }
        }
      });
    });

    // ---- validation (§65 Validation, plan §18) -------------------------------

    describe('validation', () => {
      it('accepts valid content', async () => {
        const result = await fixtures.createAdapter().publishing.validate({
          context: createTestContext(),
          target: fixtures.target,
          content: fixtures.validContent,
          credentials: fixtures.credentials,
          app: fixtures.app,
        });

        const errors = result.findings.filter((f) => f.severity === 'error');
        expect(errors, `unexpected errors: ${JSON.stringify(errors)}`).toHaveLength(0);
      });

      it('rejects invalid content with a schema-valid, actionable finding', async () => {
        const result = await fixtures.createAdapter().publishing.validate({
          context: createTestContext(),
          target: fixtures.target,
          content: fixtures.invalidContent,
          credentials: fixtures.credentials,
          app: fixtures.app,
        });

        const errors = result.findings.filter((f) => f.severity === 'error');
        expect(errors.length).toBeGreaterThan(0);

        for (const finding of result.findings) {
          expect(() => ValidationFindingSchema.parse(finding)).not.toThrow();
          // Agents branch on this string, so an empty one makes the finding unusable
          // for the audience the product is built for (plan P12).
          expect(finding.agent_action).toMatch(/\S/);
          expect(finding.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
        }
      });

      it('performs no provider side effect while validating', async () => {
        // Plan §18: preflight is safe to call freely. An adapter that uploads media to
        // warm a cache breaks that promise, and the call log is where it shows up.
        const context = createTestContext();
        await fixtures.createAdapter().publishing.validate({
          context,
          target: fixtures.target,
          content: fixtures.validContent,
          credentials: fixtures.credentials,
          app: fixtures.app,
        });

        const mutating = context.entries.filter(
          (entry) => entry.method !== 'GET' && entry.method !== 'HEAD',
        );
        expect(
          mutating,
          `validate() performed mutating calls: ${JSON.stringify(mutating)}`,
        ).toHaveLength(0);
      });
    });

    // ---- reliability (§65 Reliability, plan §79) -----------------------------

    describe('error normalization', () => {
      it('maps a timeout to PROVIDER_TIMEOUT', () => {
        // The critical case: a timeout cannot distinguish "never arrived" from
        // "published, response lost". Mapping it anywhere else lets the engine retry
        // blindly and duplicate a post (ADR-006 Layer 4, plan §2.2).
        const normalized = fixtures
          .createAdapter()
          .normalizeError(new ProviderTimeoutError('publish', 15_000), {
            operation: 'publish',
            provider: name,
          });

        expect(normalized.code).toBe('PROVIDER_TIMEOUT');
      });

      it('maps an unrecognized failure to UNKNOWN_PROVIDER_ERROR rather than guessing', () => {
        const normalized = fixtures
          .createAdapter()
          .normalizeError(new Error('something nobody has seen before'), {
            operation: 'publish',
            provider: name,
          });

        // Rule 14: fail safely. UNKNOWN_PROVIDER_ERROR is not auto-retried, so an
        // unclassified error cannot silently duplicate a post.
        expect(normalized.code).toBe('UNKNOWN_PROVIDER_ERROR');
      });

      it('only ever emits codes from the shared taxonomy', () => {
        const adapter = fixtures.createAdapter();
        const samples: unknown[] = [
          new Error('boom'),
          new ProviderTimeoutError('publish', 1),
          { status: 401, body: 'unauthorized' },
          { status: 403, body: 'forbidden' },
          { status: 429, body: 'slow down' },
          { status: 500, body: 'server error' },
          { status: 503, body: 'unavailable' },
          null,
          undefined,
          'a bare string',
        ];

        for (const sample of samples) {
          const normalized = adapter.normalizeError(sample, { operation: 'publish', provider: name });
          expect(
            PROVIDER_ERROR_CODES,
            `normalizeError produced "${normalized.code}", which the engine cannot branch on`,
          ).toContain(normalized.code);
          // Sanitized summary is required; a raw provider payload here can carry a token.
          expect(normalized.message).toMatch(/\S/);
        }
      });

      it('never throws while normalizing', () => {
        // normalizeError runs on the failure path. If it can throw, a provider outage
        // becomes an unhandled exception and the attempt record is never written.
        const adapter = fixtures.createAdapter();
        for (const sample of [null, undefined, 0, '', [], {}, Symbol('x')]) {
          expect(() =>
            adapter.normalizeError(sample, { operation: 'publish', provider: name }),
          ).not.toThrow();
        }
      });
    });

    // ---- effective-once (§65 Reliability, ADR-006) ---------------------------

    describe('reconciliation', () => {
      it('implements findPossibleDuplicate, or documents why it cannot', () => {
        const adapter = fixtures.createAdapter();

        if (fixtures.reconciliationUnavailableBecause) {
          expect(fixtures.reconciliationUnavailableBecause).toMatch(/\S/);
          return;
        }

        // Without this, an ambiguous timeout can only escalate to a human, because
        // retrying risks a duplicate and not retrying risks a lost post.
        expect(
          adapter.publishing.findPossibleDuplicate,
          'no findPossibleDuplicate and no justification in reconciliationUnavailableBecause',
        ).toBeTypeOf('function');
      });
    });
  });
}
