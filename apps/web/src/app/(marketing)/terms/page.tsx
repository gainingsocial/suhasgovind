import { pageSeo } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Terms of service',
  description:
    'Terms governing use of the GainingSocial publishing API, including acceptable use, platform ' +
    'rules and availability.',
  path: '/terms',
});

/**
 * Terms of service.
 *
 * Like the privacy policy, this is a hard prerequisite for platform approval rather than
 * only a legal formality — LinkedIn and Meta both check that the URL resolves and
 * describes the actual product.
 */

const LAST_UPDATED = '10 August 2026';

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Terms of service</h1>
      <p className="mt-2 text-sm text-[var(--text-subtle)]">Last updated {LAST_UPDATED}</p>

      <div className="mt-10 space-y-10 text-sm text-pretty text-[var(--text-muted)]">
        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">The service</h2>
          <p className="mt-2">
            GainingSocial provides an API and dashboard for publishing content to social networks.
            By using it you agree to these terms. If you are using it on behalf of an organisation,
            you confirm you are authorised to accept them for that organisation.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">Your content stays yours</h2>
          <p className="mt-2">
            You retain ownership of everything you publish through the service. You grant us only
            the permission needed to store it, process it and deliver it to the destinations you
            select. We do not use your content for anything else.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">Social network rules also apply</h2>
          <p className="mt-2">
            Publishing through this service does not exempt you from the terms of the networks you
            publish to. Each has its own rules on content, automation, disclosure and posting
            frequency, and those apply to anything sent through us.
          </p>
          <p className="mt-2">
            If a network suspends or restricts an account because of content published through the
            service, resolving that is between you and the network. We will help with the technical
            record of what was sent and when.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">Acceptable use</h2>
          <p className="mt-2">You may not use the service to:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>publish content you do not have the right to publish;</li>
            <li>impersonate a person or organisation;</li>
            <li>publish to accounts you do not own or have not been authorised to manage;</li>
            <li>send spam, or publish at a rate designed to evade a platform’s limits;</li>
            <li>publish content that is unlawful in the jurisdictions where it will be visible.</li>
          </ul>
          <p className="mt-2">
            We may suspend access where we reasonably believe these terms are being breached, and
            will explain why where doing so is lawful.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">Availability and limits</h2>
          <p className="mt-2">
            The service is provided as-is while in development, without an availability commitment.
            Publishing depends on third-party social networks that may be slow, rate-limited or
            unavailable, and we cannot guarantee delivery to a network that is refusing it.
          </p>
          <p className="mt-2">
            We take considerable care to avoid duplicate posts and to surface failures clearly, but
            we do not warrant that every post will publish successfully or at an exact time.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">Fees</h2>
          <p className="mt-2">
            The service is currently free to use. If paid plans are introduced, existing users will
            be given notice before any charge applies.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">Ending your use</h2>
          <p className="mt-2">
            You may stop using the service and request deletion of your data at any time, as
            described in the privacy policy. We may end provision of the service with reasonable
            notice, except where immediate suspension is necessary because of a breach of these
            terms.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--text)]">Contact</h2>
          <p className="mt-2">
            Questions about these terms can be sent to{' '}
            <a href="mailto:legal@gainingsocial.com" className="text-brand-600 hover:underline">
              legal@gainingsocial.com
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
