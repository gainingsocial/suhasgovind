import Link from 'next/link';

import { CodeBlock } from '@/components/code';
import { FaqList, Section, SectionHeader } from '@/components/marketing';
import { breadcrumbSchema, faqSchema, jsonLd, pageSeo, type Faq } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Delete your data',
  description:
    'How to delete the data GainingSocial holds — disconnect an account, delete a profile, or ' +
    'request removal of everything. What is deleted immediately, what is retained, and for how long.',
  path: '/data-deletion',
});

/**
 * Data deletion instructions.
 *
 * Meta requires a reachable, public URL describing how a person deletes their data before
 * it will review an application, and LinkedIn, TikTok and Google all ask for the same
 * thing in their own words. This page is that URL.
 *
 * It is written to be true rather than reassuring. Every claim below corresponds to
 * something the code actually does: disconnecting destroys the stored provider credentials
 * in the same transaction that marks the connection disconnected, and deleting a profile
 * cascades that to every account under it. Claiming deletion that does not happen is worse
 * than having no page — it is the exact thing an audit is looking for.
 */

const DISCONNECT_CALL = `
curl -X POST https://api.gainingsocial.com/v1/connections/con_.../disconnect \\
  -H "Authorization: Bearer sk_live_..."
`;

const DELETE_PROFILE_CALL = `
curl -X DELETE https://api.gainingsocial.com/v1/profiles/pro_... \\
  -H "Authorization: Bearer sk_live_..."
`;

const FAQS: readonly Faq[] = [
  {
    question: 'How do I delete my data from GainingSocial?',
    answer:
      'Disconnect the social account in the dashboard under Connections, which immediately destroys the access token we hold for it. To remove a brand or client entirely, delete its profile — that disconnects every account under it and destroys their credentials too. To remove your whole organisation, email privacy@gainingsocial.com from the address on the account and it is erased within 30 days.',
  },
  {
    question: 'What happens to my access token when I disconnect?',
    answer:
      'It is deleted from the database in the same transaction that marks the connection disconnected. It is not archived, not soft-deleted and not kept for analytics. A disconnected connection cannot publish, so the token has no remaining purpose, and keeping a live credential past the moment somebody asked us to stop using it would be indefensible.',
  },
  {
    question: 'Do you also revoke access at the social network?',
    answer:
      'Where the network provides a revocation endpoint, the adapter calls it. Not every network does, so the API reports revocation honestly as unconfirmed rather than implying it happened. Revoking our app in the network’s own settings is always available to you and always works.',
  },
  {
    question: 'What is kept after deletion, and why?',
    answer:
      'A record that a post was published — its id, when it went out and to which network — is retained so past activity remains explicable and so we can answer a later dispute about whether something was published. It contains no credentials. Aggregate usage counters are retained for billing and fraud purposes. Everything else goes.',
  },
  {
    question: 'How long does deletion take?',
    answer:
      'Credentials are destroyed immediately and synchronously — before the API responds. Full erasure of an organisation, including backups, completes within 30 days, which is the retention period of our encrypted database backups.',
  },
  {
    question: 'I connected an account through a company that uses GainingSocial. Who do I ask?',
    answer:
      'Ask them first — they are the controller of that data and can disconnect your account immediately. If you cannot reach them, email privacy@gainingsocial.com with the network and account name and we will locate and delete the connection ourselves.',
  },
];

export default function DataDeletionPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLd(
          breadcrumbSchema([
            { name: 'Home', path: '/' },
            { name: 'Data deletion', path: '/data-deletion' },
          ]),
        )}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(faqSchema(FAQS))} />

      <div className="mx-auto max-w-3xl px-4 pt-14 pb-4 sm:px-6 sm:pt-20">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-[2.6rem] sm:leading-[1.1]">
          Delete your data
        </h1>
        <p className="mt-5 text-lg text-pretty text-[var(--text-muted)]">
          Three routes, depending on how much you want removed. The first two take effect
          immediately and you can do both yourself.
        </p>
      </div>

      <Section>
        <div className="mx-auto max-w-3xl">
          <ol className="space-y-12">
            <li>
              <div className="flex items-center gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-600 font-mono text-sm font-bold text-[var(--on-brand)]">
                  1
                </span>
                <h2 className="text-xl font-semibold tracking-tight">
                  Disconnect one social account
                </h2>
              </div>
              <p className="mt-4 text-base leading-relaxed text-pretty text-[var(--text-muted)]">
                Sign in, open <strong className="font-medium text-[var(--text)]">Connections</strong>,
                and choose <strong className="font-medium text-[var(--text)]">Disconnect</strong> on
                the account. The access token and any refresh token we hold for it are deleted from
                the database in the same transaction that marks the connection disconnected —
                immediately, before the request returns.
              </p>
              <p className="mt-4 text-base leading-relaxed text-pretty text-[var(--text-muted)]">
                The equivalent API call, if you would rather do it from code:
              </p>
              <CodeBlock code={DISCONNECT_CALL} lang="bash" className="mt-4" />
            </li>

            <li>
              <div className="flex items-center gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-600 font-mono text-sm font-bold text-[var(--on-brand)]">
                  2
                </span>
                <h2 className="text-xl font-semibold tracking-tight">
                  Delete a brand or client entirely
                </h2>
              </div>
              <p className="mt-4 text-base leading-relaxed text-pretty text-[var(--text-muted)]">
                Deleting a profile disconnects every social account beneath it and destroys all of
                their credentials in one transaction. Use this when you have stopped working with a
                client, rather than disconnecting their accounts one at a time and hoping you got
                them all.
              </p>
              <CodeBlock code={DELETE_PROFILE_CALL} lang="bash" className="mt-4" />
            </li>

            <li>
              <div className="flex items-center gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-600 font-mono text-sm font-bold text-[var(--on-brand)]">
                  3
                </span>
                <h2 className="text-xl font-semibold tracking-tight">
                  Delete everything we hold about you
                </h2>
              </div>
              <p className="mt-4 text-base leading-relaxed text-pretty text-[var(--text-muted)]">
                Email{' '}
                <a
                  href="mailto:privacy@gainingsocial.com?subject=Data%20deletion%20request"
                  className="font-medium text-[var(--text)] underline underline-offset-4"
                >
                  privacy@gainingsocial.com
                </a>{' '}
                from the address on the account, saying you want your data deleted. No form, no
                justification required. We confirm the request, erase the organisation and every
                profile, connection, credential, media file and draft under it, and confirm again
                when it is done.
              </p>
              <p className="mt-4 text-base leading-relaxed text-pretty text-[var(--text-muted)]">
                Live systems are cleared within seven days. Encrypted backups roll off within 30,
                which is the outside limit for the whole request.
              </p>
            </li>
          </ol>
        </div>
      </Section>

      <Section tone="sunken">
        <div className="mx-auto max-w-3xl">
          <SectionHeader heading="What is deleted, and what is not" align="left" />

          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-[15px]">
              <thead>
                <tr className="border-b">
                  <th scope="col" className="py-3 pr-4 font-semibold">
                    Data
                  </th>
                  <th scope="col" className="py-3 pr-4 font-semibold">
                    On deletion
                  </th>
                  <th scope="col" className="py-3 font-semibold">
                    Why
                  </th>
                </tr>
              </thead>
              <tbody className="text-[var(--text-muted)]">
                {[
                  [
                    'Access and refresh tokens',
                    'Destroyed immediately',
                    'A live secret with no remaining purpose.',
                  ],
                  [
                    'Profile, connection and destination records',
                    'Removed from every view; erased on full deletion',
                    'Retained only long enough to keep past posts explicable.',
                  ],
                  [
                    'Uploaded media',
                    'Deleted from storage',
                    'Yours, and of no use to us once you are gone.',
                  ],
                  [
                    'Drafts, sources and generated content',
                    'Deleted',
                    'Derived from your material.',
                  ],
                  [
                    'Published post records',
                    'Id, time and network retained',
                    'So a later question about whether something was published can be answered. Contains no credentials.',
                  ],
                  [
                    'Aggregate usage counters',
                    'Retained',
                    'Required for billing integrity and fraud prevention. Not linked to post content.',
                  ],
                ].map(([data, action, why]) => (
                  <tr key={data} className="border-b align-top">
                    <td className="py-3 pr-4 font-medium text-[var(--text)]">{data}</td>
                    <td className="py-3 pr-4">{action}</td>
                    <td className="py-3">{why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-8 text-base leading-relaxed text-pretty text-[var(--text-muted)]">
            If you connected your account through a company that uses GainingSocial to publish on
            your behalf, that company is the controller of your data. Ask them to disconnect it —
            they can do so immediately. If they are unreachable, email us and we will do it.
          </p>
        </div>
      </Section>

      <Section>
        <div className="mx-auto max-w-3xl">
          <SectionHeader heading="Questions about deletion" align="left" />
          <FaqList faqs={FAQS} columns={1} />

          <p className="mt-12 text-base text-[var(--text-muted)]">
            See also our{' '}
            <Link href="/privacy" className="text-[var(--text)] underline underline-offset-4">
              privacy policy
            </Link>{' '}
            for what is collected in the first place, and{' '}
            <Link href="/terms" className="text-[var(--text)] underline underline-offset-4">
              the terms
            </Link>
            .
          </p>
        </div>
      </Section>
    </>
  );
}
