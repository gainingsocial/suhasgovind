import Link from 'next/link';

import {
  EffectiveOnceDiagram,
  FanOutDiagram,
  PreflightDiagram,
  SchedulingDiagram,
} from '@/components/diagrams';
import { faqSchema, jsonLd, pageSeo, productSchema, type Faq } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'One API for publishing to every social network',
  description:
    'Publish to Bluesky, LinkedIn, Instagram, TikTok and more through a single REST API. ' +
    'Duplicate prevention, per-platform validation before you post, and webhooks the moment ' +
    'something goes live or fails.',
  path: '/',
});

/**
 * Home page.
 *
 * Written to rank for "social media publishing API" and its neighbours, which means it
 * has to actually answer the question rather than assert a benefit. Search rewards a page
 * that explains the mechanism; so do developers, who are the buyers here.
 *
 * Exactly one `h1`. Every section is a real `h2` with prose under it, not a card grid of
 * three-word claims — a page of slogans has nothing for a crawler to index and nothing
 * for a reader to evaluate.
 */

const FAQS: readonly Faq[] = [
  {
    question: 'What is a social media publishing API?',
    answer:
      'A social media publishing API lets software post to social networks programmatically instead of through each platform’s own app. Rather than integrating with LinkedIn, Instagram, TikTok and Bluesky separately — each with its own authentication, character limits, media rules and error formats — you make one API call and the service translates it for each destination.',
  },
  {
    question: 'Which social networks are supported?',
    answer:
      'Bluesky works today and needs no approval from anyone. LinkedIn, Facebook Pages, Instagram, Threads, TikTok, YouTube, Pinterest, X, Discord, Telegram and Google Business Profile are built and waiting on each platform’s developer approval, which takes between two and eight weeks depending on the platform.',
  },
  {
    question: 'How do you stop the same post going out twice?',
    answer:
      'Four independent layers. Every request carries an idempotency key, so retrying a request never creates a second post. Each destination is locked while it publishes, so a duplicated background job cannot publish twice. Content is fingerprinted to catch an accidental repeat. And when a network accepts a post but the confirmation is lost, we check the account before retrying rather than posting again blindly.',
  },
  {
    question: 'What happens if a post fails on one network but works on another?',
    answer:
      'Each destination succeeds or fails independently and reports its own status. A post that reached three networks and failed on the fourth is marked partly published, never as a single success or a single failure, and the failing destination carries its own error explaining what to fix.',
  },
  {
    question: 'Can I schedule posts for the future?',
    answer:
      'Yes. Send a publish time and the post goes out then. A background check runs every minute as a safety net, so a scheduled post still publishes even if something upstream fails — which is the failure that otherwise goes unnoticed until a customer asks why their post never appeared.',
  },
  {
    question: 'Is it suitable for AI agents?',
    answer:
      'It is designed for them. Every error carries a machine-readable code and a suggested next action rather than only an English sentence, capabilities are queryable so an agent can ask what a destination allows before composing, and a preflight endpoint validates a post without publishing it.',
  },
  {
    question: 'Do I need a developer account with each social network?',
    answer:
      'For most platforms, no — you connect your accounts and the service uses its own approved applications. Enterprise customers who prefer to use their own Meta, LinkedIn or TikTok apps can bring them, which is supported without any change to how you call the API.',
  },
  {
    question: 'How much does it cost?',
    answer:
      'It is free while in development. Bluesky, LinkedIn, Meta, TikTok, YouTube and the other supported platforms do not charge for API access; X is the only major network that requires a paid tier to publish.',
  },
];

export default function HomePage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(productSchema())} />
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(faqSchema(FAQS))} />

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 pt-14 pb-10 sm:px-6 sm:pt-20">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-medium text-brand-600">Social publishing infrastructure</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
            One API for publishing to every social network
          </h1>
          <p className="mt-5 text-base text-pretty text-[var(--text-muted)] sm:text-lg">
            Write a post once. GainingSocial validates it against each platform’s own rules,
            publishes it, retries what fails, and tells you the moment it goes live — through a
            single REST API instead of eleven separate integrations.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/docs/quickstart"
              className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-brand-600 px-5 text-sm font-medium text-[var(--on-brand)] transition-colors hover:bg-brand-500 sm:w-auto"
            >
              Read the quickstart
            </Link>
            <Link
              href="/features/publishing"
              className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border px-5 text-sm font-medium transition-colors hover:bg-[var(--surface-sunken)] sm:w-auto"
            >
              How publishing works
            </Link>
          </div>
        </div>

        <div className="mx-auto mt-12 max-w-3xl">
          <FanOutDiagram />
        </div>
      </section>

      {/* Preflight */}
      <Section
        id="preflight"
        heading="Find out before you post, not after"
        lead="Every network has different limits — character counts, image dimensions, how many photos, whether video is allowed at all. Preflight checks your post against each destination’s actual rules and tells you what will happen, before anything is published."
      >
        <PreflightDiagram className="mx-auto max-w-3xl" />
        <Prose>
          <p>
            The alternative is what most tools do: accept the post, try to publish, and surface a
            platform error afterwards. By then the post has already gone out to the destinations
            that accepted it, and you are left with a half-published post and an error message in
            somebody else’s vocabulary.
          </p>
          <p>
            Preflight returns a per-destination verdict with a machine-readable code, the exact
            field at fault, and — where one exists — a concrete fix, such as the length to truncate
            to or the aspect ratio to crop for. It is safe to call as often as you like, because it
            performs no publishing side effects.
          </p>
        </Prose>
      </Section>

      {/* Effective-once */}
      <Section
        id="duplicates"
        heading="The same post never goes out twice"
        lead="Duplicate posts are the failure people remember. They happen when a network accepts a post but the confirmation is lost in transit, and the publishing system — having no way to tell success from failure — tries again."
        tone="sunken"
      >
        <EffectiveOnceDiagram className="mx-auto max-w-3xl" />
        <Prose>
          <p>
            Rather than retrying blindly, GainingSocial treats an ambiguous outcome as genuinely
            unknown and goes and looks: it searches the connected account for the post before doing
            anything else. If the post is there, it is adopted and nothing is republished. If it is
            provably absent, retrying is safe. If neither can be established, the post is held for a
            human rather than guessed at.
          </p>
          <p>
            Three further layers sit in front of that. Requests carry an idempotency key so a
            network retry cannot create a second post. Each destination is locked for the duration
            of its publish, so a duplicated background job cannot publish twice. And content is
            fingerprinted, so an accidental repeat of identical content to the same place is caught
            before it reaches the platform.
          </p>
        </Prose>
      </Section>

      {/* Scheduling */}
      <Section
        id="scheduling"
        heading="Scheduled posts actually go out"
        lead="Scheduling is easy to build and easy to get subtly wrong. The failure mode is silent: the post simply never publishes, and nobody finds out until someone asks."
      >
        <SchedulingDiagram className="mx-auto max-w-3xl" />
        <Prose>
          <p>
            A background reconciler runs every minute and looks for anything overdue — posts whose
            time has come, work abandoned by a process that died mid-publish, notifications that
            were never delivered. Anything it finds, it picks back up.
          </p>
          <p>
            That safety net is not an optimisation. Without it, a post scheduled for next Tuesday
            depends entirely on one delayed message surviving a week, and if it does not, nothing
            reports the loss.
          </p>
        </Prose>
      </Section>

      {/* Built for agents */}
      <Section
        id="agents"
        heading="Built for software and AI agents, not just people"
        lead="Most social tools are a dashboard with an API bolted on. This is an API with a dashboard on top — and the difference shows in the error messages."
        tone="sunken"
      >
        <Prose>
          <p>
            Every error carries a stable code, an explicit statement of whether retrying could help,
            and a machine-readable next action. An agent never has to parse an English sentence to
            decide what to do. Capabilities are queryable, so an agent can ask what a specific
            connected account permits — accounting for granted permissions, account type and
            platform approval — before it composes anything.
          </p>
          <p>
            Publishing is asynchronous and returns immediately. Reliable delivery never depends on
            your process staying alive, which matters when the caller is a scheduled job or an agent
            that may be terminated mid-run.
          </p>
        </Prose>
      </Section>

      {/* FAQ */}
      <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Frequently asked questions
        </h2>
        <dl className="mt-8 divide-y">
          {FAQS.map((faq) => (
            <div key={faq.question} className="py-5">
              <dt className="text-base font-medium">{faq.question}</dt>
              <dd className="mt-2 text-sm text-pretty text-[var(--text-muted)]">{faq.answer}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="border-t bg-[var(--surface-sunken)]">
        <div className="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">Start with one API call</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm text-[var(--text-muted)]">
            Bluesky needs no approval from anyone — you can be publishing today, and the same code
            reaches every other network as its approval lands.
          </p>
          <Link
            href="/docs/quickstart"
            className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-5 text-sm font-medium text-[var(--on-brand)]"
          >
            Read the quickstart
          </Link>
        </div>
      </section>
    </>
  );
}

function Section({
  id,
  heading,
  lead,
  children,
  tone,
}: {
  id: string;
  heading: string;
  lead: string;
  children: React.ReactNode;
  tone?: 'sunken';
}) {
  return (
    <section
      id={id}
      className={tone === 'sunken' ? 'border-y bg-[var(--surface-sunken)]' : undefined}
    >
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            {heading}
          </h2>
          <p className="mt-3 text-base text-pretty text-[var(--text-muted)]">{lead}</p>
        </div>
        <div className="mt-10">{children}</div>
      </div>
    </section>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-10 max-w-2xl space-y-4 text-sm text-pretty text-[var(--text-muted)]">
      {children}
    </div>
  );
}
