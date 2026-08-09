import { pageSeo } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Privacy policy',
  description:
    'How GainingSocial handles personal data, social account credentials and published content, ' +
    'including data deletion and retention.',
  path: '/privacy',
});

/**
 * Privacy policy.
 *
 * Not only a legal formality — LinkedIn, Meta, TikTok and Google all require a reachable
 * privacy policy URL before granting API access, and Meta additionally requires stated
 * data deletion instructions. This page is therefore a prerequisite for every platform
 * approval, which is why it exists before there are customers to read it.
 *
 * Written plainly and specifically. A generic template is both less useful and more
 * likely to be rejected in review for not describing the actual integration.
 */

const LAST_UPDATED = '10 August 2026';

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Privacy policy</h1>
      <p className="mt-2 text-sm text-[var(--text-subtle)]">Last updated {LAST_UPDATED}</p>

      <div className="mt-10 space-y-10 text-sm text-pretty text-[var(--text-muted)]">
        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">What this service does</h2>
          <p className="mt-2">
            GainingSocial publishes content to social networks on behalf of its customers. Customers
            connect their own social accounts, and we act only on instructions they give us through
            our API or dashboard.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">What we collect</h2>
          <p className="mt-2">
            <strong className="text-[var(--text)]">Account information.</strong> The email address
            and name of people who sign in to the dashboard, used to authenticate them and to
            associate them with their organisation.
          </p>
          <p className="mt-2">
            <strong className="text-[var(--text)]">Social account credentials.</strong> Access
            tokens, refresh tokens and app passwords for the social accounts a customer connects.
            These are encrypted before they are stored, decrypted only immediately before a call to
            that social network, and never written to logs.
          </p>
          <p className="mt-2">
            <strong className="text-[var(--text)]">Content submitted for publishing.</strong> The
            text, images and video a customer asks us to publish, along with the destinations they
            chose and the resulting status from each network.
          </p>
          <p className="mt-2">
            <strong className="text-[var(--text)]">Operational records.</strong> Timestamps, request
            identifiers and error codes for each publishing attempt, used to diagnose failures and
            to show customers what happened to their posts.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">What we do not collect</h2>
          <p className="mt-2">
            We do not read a customer’s social inbox, follower lists or private messages unless they
            explicitly enable a feature that requires it. We do not sell data to anyone, and we do
            not use customer content to train models.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">How credentials are protected</h2>
          <p className="mt-2">
            Social account credentials are encrypted at the application layer with AES-256-GCM
            before being written to the database, using a key held outside the database. Each record
            is cryptographically bound to the organisation and connection it belongs to, so a record
            moved elsewhere cannot be decrypted at all.
          </p>
          <p className="mt-2">
            Credentials are never returned by the API, never included in a webhook, and never
            written to a log. A database backup on its own contains no usable social tokens.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">Deleting your data</h2>
          <p className="mt-2">
            Disconnecting a social account from the dashboard removes its stored credentials
            immediately, and we stop accessing that account. Deleting a profile removes it from the
            service, though records of posts already published remain for a limited period so
            in-flight work can complete and so past activity can still be explained.
          </p>
          <p className="mt-2">
            To request deletion of an entire account and everything associated with it, email{' '}
            <a href="mailto:privacy@gainingsocial.com" className="text-brand-600 hover:underline">
              privacy@gainingsocial.com
            </a>{' '}
            from the address on the account. We action requests within 30 days and confirm when the
            deletion is complete.
          </p>
          <p className="mt-2">
            Content already published to a social network is held by that network, not by us.
            Deleting it there is done through that platform or through our delete endpoint where the
            platform supports one.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">Where data is processed</h2>
          <p className="mt-2">
            The service runs on Cloudflare’s global network, with data stored in a Supabase
            PostgreSQL database and media in Cloudflare R2. Requests are served from the location
            nearest the caller; stored data resides in the region configured for the account.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">Third parties</h2>
          <p className="mt-2">
            We share data with a social network only when a customer instructs us to publish to it,
            and only what that publication requires. Our infrastructure providers — Cloudflare and
            Supabase — process data on our behalf under their own terms.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">Contact</h2>
          <p className="mt-2">
            Questions about this policy, or about data we hold, can be sent to{' '}
            <a href="mailto:privacy@gainingsocial.com" className="text-brand-600 hover:underline">
              privacy@gainingsocial.com
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
