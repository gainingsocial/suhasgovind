import Link from 'next/link';

import { CodeBlock } from '@/components/code';
import {
  ButtonLink,
  CheckList,
  ClosingCta,
  Eyebrow,
  FaqList,
  PlatformStrip,
  Prose,
  Section,
  SectionHeader,
  Split,
  StatBand,
  Steps,
} from '@/components/marketing';
import {
  EffectiveOnceDiagram,
  FanOutDiagram,
  PreflightDiagram,
  SchedulingDiagram,
} from '@/components/diagrams';
import { PLATFORM_COUNT } from '@/lib/platforms';
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
 *
 * The request and its 202 are shown above the fold. A developer deciding whether to read
 * on is looking for the call, and describing it in a paragraph asks them to take on faith
 * the one thing that would settle it.
 */

const PUBLISH_REQUEST = `
curl -X POST https://api.gainingsocial.com/v1/posts \\
  -H "Authorization: Bearer sk_live_..." \\
  -H "Idempotency-Key: 4f9c2a1e-7b03-4d5a-9f21" \\
  -H "Content-Type: application/json" \\
  -d '{
    "profile_id": "pro_01j9x4",
    "content": { "text": "We are launching today." },
    "targets": [
      { "destination_id": "dst_bluesky" },
      { "destination_id": "dst_linkedin" },
      { "destination_id": "dst_instagram" }
    ]
  }'
`;

const PUBLISH_RESPONSE = `
{
  "id": "pst_01j9x4c7",
  "object": "post",
  "status": "queued",
  "publish_at": null,
  "targets": [
    { "id": "ptg_01", "provider": "bluesky", "status": "queued" },
    { "id": "ptg_02", "provider": "linkedin", "status": "queued" },
    { "id": "ptg_03", "provider": "instagram", "status": "queued" }
  ],
  "created_at": "2026-08-13T09:41:22Z",
  "request_id": "req_01j9x4c7"
}
`;

const ERROR_ENVELOPE = `
{
  "error": {
    "type": "validation_error",
    "code": "MEDIA_RATIO_UNSUPPORTED",
    "message": "The selected video is not valid for the TikTok destination.",
    "param": "content.media_ids[0]",
    "provider": "tiktok",
    "retryable": false,
    "agent_action": "create_or_select_a_9_16_video_variant",
    "docs_url": "https://gainingsocial.com/docs/errors/MEDIA_RATIO_UNSUPPORTED",
    "request_id": "req_01j9x4c7"
  }
}
`;

const CONNECT_SNIPPET = `
POST /v1/connections/authorize
{ "profile_id": "pro_01j9x4", "provider": "bluesky" }
`;

const PREFLIGHT_SNIPPET = `
POST /v1/posts/preflight
# same body as publishing, no side effects
`;

const PUBLISH_SNIPPET = `
POST /v1/posts
# 202 Accepted — publishing continues without you
`;

const STATS = [
  {
    value: String(PLATFORM_COUNT),
    label: 'Networks, one contract',
    detail: 'The same request body reaches every one. No per-platform branching in your code.',
  },
  {
    value: '4',
    label: 'Layers against duplicates',
    detail: 'Idempotency key, execution lease, content fingerprint, and a check before any ambiguous retry.',
  },
  {
    value: '202',
    label: 'Returned immediately',
    detail: 'Delivery never depends on your process staying alive. Nothing long-running runs in the request.',
  },
  {
    value: '100%',
    label: 'Errors with a stable code',
    detail: 'Every failure carries a documented code, whether a retry could help, and a next action.',
  },
];

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
      'It is designed for them. Every error carries a machine-readable code and a suggested next action rather than only an English sentence, capabilities are queryable so an agent can ask what a destination allows before composing, and a preflight endpoint validates a post without publishing it. The same API is also exposed over MCP, so an agent can call it as a tool.',
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
      <section className="mx-auto max-w-6xl px-4 pt-12 pb-14 sm:px-6 sm:pt-16">
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
          <div>
            <Eyebrow>Social publishing infrastructure</Eyebrow>
            <h1 className="mt-4 text-[2.1rem] leading-[1.1] font-semibold tracking-tight text-balance sm:text-5xl">
              One API for publishing to every social network
            </h1>
            <p className="mt-5 text-lg text-pretty text-[var(--text-muted)]">
              Write a post once. GainingSocial validates it against each platform’s own rules,
              publishes it, retries what fails, and tells you the moment it goes live — through a
              single REST API instead of {PLATFORM_COUNT} separate integrations.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <ButtonLink href="/docs/quickstart">Read the quickstart</ButtonLink>
              <ButtonLink href="/features/publishing" variant="secondary">
                How publishing works
              </ButtonLink>
            </div>

            <p className="mt-6 text-sm text-[var(--text-subtle)]">
              Free while in development. Bluesky publishes today with no application to anyone —
              every other network is written and waiting on its approval.
            </p>
          </div>

          {/* The call and what comes back. Stacked rather than tabbed: a tab hides half the
              answer behind an interaction, and the 202 is the half people doubt. */}
          <div className="min-w-0 space-y-4">
            <CodeBlock
              code={PUBLISH_REQUEST}
              lang="bash"
              title="Publish to three networks"
              badge="curl"
            />
            <CodeBlock
              code={PUBLISH_RESPONSE}
              lang="json"
              title="Response"
              badge="202 Accepted"
              copyable={false}
            />
          </div>
        </div>
      </section>

      <PlatformStrip />

      {/* Three calls */}
      <Section id="how-it-works">
        <SectionHeader
          eyebrow="How it works"
          heading="From nothing to published in three calls"
          lead="Connecting an account, checking a post and publishing it are the whole loop. Everything else in the API exists to tell you what happened afterwards."
        />
        <div className="mt-12">
          <Steps
            steps={[
              {
                title: 'Connect an account',
                body: 'One call starts an authorization and tells you how to finish it — a redirect for platforms with a consent screen, a credential form for those without. Your code branches on the answer, not on a list of which platform is which.',
                media: <CodeBlock code={CONNECT_SNIPPET} lang="http" copyable={false} />,
              },
              {
                title: 'Check before you post',
                body: 'Preflight takes the identical body and performs no side effects, so it is safe to call as often as you like. It returns a verdict for each destination and, where one exists, the concrete fix.',
                media: <CodeBlock code={PREFLIGHT_SNIPPET} lang="http" copyable={false} />,
              },
              {
                title: 'Publish',
                body: 'You get a post id straight away and each destination reports its own status as it lands. Subscribe to a webhook, or poll the post — both tell you the same thing.',
                media: <CodeBlock code={PUBLISH_SNIPPET} lang="http" copyable={false} />,
              },
            ]}
          />
        </div>

        <div className="mt-14">
          <FanOutDiagram className="mx-auto max-w-3xl" />
        </div>
      </Section>

      {/* Preflight */}
      <Section id="preflight" tone="sunken">
        <Split media={<PreflightDiagram />}>
          <SectionHeader
            eyebrow="Preflight"
            heading="Find out before you post, not after"
            align="left"
          />
          <Prose className="mt-6">
            <p>
              Every network has different limits — character counts, image dimensions, how many
              photos, whether video is allowed at all. Preflight checks your post against each
              destination’s actual rules and tells you what will happen, before anything is
              published.
            </p>
            <p>
              The alternative is what most tools do: accept the post, try to publish, and surface a
              platform error afterwards. By then the post has already gone out to the destinations
              that accepted it, and you are left with a half-published post and an error message in
              somebody else’s vocabulary.
            </p>
          </Prose>
          <CheckList
            items={[
              'A verdict per destination, with the exact field at fault',
              'A concrete fix where one exists — the length to trim to, the ratio to crop for',
              'No publishing side effects, so it is safe to call on every keystroke',
            ]}
          />
        </Split>
      </Section>

      {/* Effective-once */}
      <Section id="duplicates">
        <Split media={<EffectiveOnceDiagram />} reversed>
          <SectionHeader
            eyebrow="Effective-once publishing"
            heading="The same post never goes out twice"
            align="left"
          />
          <Prose className="mt-6">
            <p>
              Duplicate posts are the failure people remember. They happen when a network accepts a
              post but the confirmation is lost in transit, and the publishing system — having no
              way to tell success from failure — tries again.
            </p>
            <p>
              Rather than retrying blindly, GainingSocial treats an ambiguous outcome as genuinely
              unknown and goes and looks: it searches the connected account for the post before
              doing anything else. If the post is there, it is adopted and nothing is republished.
              If it is provably absent, retrying is safe. If neither can be established, the post is
              held for a human rather than guessed at.
            </p>
          </Prose>
          <CheckList
            items={[
              'An idempotency key, so a network retry cannot create a second post',
              'A lease on each destination, so a duplicated background job cannot publish twice',
              'A content fingerprint, so an accidental repeat is caught before it reaches the platform',
              'A reconciliation check before any retry whose outcome was ambiguous',
            ]}
          />
        </Split>
      </Section>

      {/* Scheduling */}
      <Section id="scheduling" tone="sunken">
        <Split media={<SchedulingDiagram />}>
          <SectionHeader
            eyebrow="Scheduling"
            heading="Scheduled posts actually go out"
            align="left"
          />
          <Prose className="mt-6">
            <p>
              Scheduling is easy to build and easy to get subtly wrong. The failure mode is silent:
              the post simply never publishes, and nobody finds out until someone asks.
            </p>
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
        </Split>
      </Section>

      {/* Built for agents */}
      <Section id="agents">
        <Split
          media={
            <CodeBlock
              code={ERROR_ENVELOPE}
              lang="json"
              title="An error an agent can act on"
              badge="422"
              copyable={false}
            />
          }
          reversed
        >
          <SectionHeader
            eyebrow="Agent-native"
            heading="Built for software and AI agents, not just people"
            align="left"
          />
          <Prose className="mt-6">
            <p>
              Most social tools are a dashboard with an API bolted on. This is an API with a
              dashboard on top — and the difference shows in the error messages.
            </p>
            <p>
              Every error carries a stable code, an explicit statement of whether retrying could
              help, and a machine-readable next action. An agent never has to parse an English
              sentence to decide what to do. Capabilities are queryable, so it can ask what a
              specific connected account permits — accounting for granted permissions, account type
              and platform approval — before it composes anything.
            </p>
            <p>
              The same API is reachable over MCP, so an agent can call it as a tool without a
              wrapper. Every tool call re-enters through the same front door and gets exactly the
              scopes its key carries.
            </p>
          </Prose>
        </Split>

        <div className="mt-16">
          <StatBand stats={STATS} />
        </div>
      </Section>

      {/* FAQ */}
      <Section id="faq" tone="sunken">
        <SectionHeader
          eyebrow="Questions"
          heading="Frequently asked questions"
          lead="If something here is not answered, the documentation goes considerably deeper."
        />
        <FaqList faqs={FAQS} />
        <p className="mt-10 text-center text-sm text-[var(--text-subtle)]">
          More in the{' '}
          <Link href="/faq" className="text-[var(--text)] underline underline-offset-4">
            full FAQ
          </Link>{' '}
          and the{' '}
          <Link href="/docs" className="text-[var(--text)] underline underline-offset-4">
            API documentation
          </Link>
          .
        </p>
      </Section>

      <ClosingCta
        heading="Start with one API call"
        lead="Bluesky needs no approval from anyone — you can be publishing today, and the same code reaches every other network as its approval lands."
        primary={{ href: '/docs/quickstart', label: 'Read the quickstart' }}
        secondary={{ href: '/platforms', label: 'See every network' }}
      />
    </>
  );
}
