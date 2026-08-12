import { GuidePage } from '@/components/guide-page';
import { pageSeo } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Multi-tenant and white-label — publish on behalf of your customers',
  description:
    'Add social publishing to your SaaS without building it: profiles per customer, a hosted ' +
    'connect flow under your own branding, scoped API keys, test and live isolation, and ' +
    'server-side tenant ownership on every request.',
  path: '/docs/multi-tenant',
});

/**
 * Multi-tenant guide.
 *
 * The page for the actual buyer: a SaaS team who need social publishing inside their own
 * product and do not want to become experts in eleven platform APIs. "White-label social
 * media API" is a commercial-intent query, and this is the page that should answer it.
 */

const BODY = [
  {
    heading: 'One profile per customer',
    paragraphs: [
      'A profile is the brand, client or creator you publish on behalf of. Everything publishable belongs to one, and nothing crosses between them.',
      'Supply your own external_id — your customer\'s primary key — and creation becomes naturally idempotent. Repeating it conflicts rather than quietly creating a second profile, so your provisioning code can be re-run without producing duplicates.',
    ],
    code: `curl -X POST https://api.gainingsocial.com/v1/profiles \\
  -H "Authorization: Bearer sk_live_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Acme Coffee",
    "external_id": "customer_8412",
    "timezone": "Europe/London"
  }'`,
  },
  {
    heading: 'Your customers connect their own accounts, on your domain',
    paragraphs: [
      'A connect session is a signed, short-lived URL that hosts the entire connect flow — the platform chooser, the OAuth handshake, the destination picker, the error states — under your branding. Your customer never sees this product and never needs an account here.',
      'This is the part that is genuinely expensive to build yourself. It is not one OAuth flow; it is eleven, plus the ones that have no consent screen at all, plus the case where a Meta login returns nine Facebook Pages and somebody has to choose. All of that lives behind one URL.',
      'The link is a bearer credential, so it is deliberately short-lived. Generate it when your customer clicks the button, not in advance.',
    ],
    code: `curl -X POST https://api.gainingsocial.com/v1/connect-sessions \\
  -H "Authorization: Bearer sk_live_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "profile_id": "pro_...",
    "providers": ["linkedin", "x", "instagram"],
    "return_url": "https://yourapp.com/settings/social?done=1",
    "branding": {
      "company_name": "Acme Social",
      "logo_url": "https://acme.com/logo.svg",
      "accent": "#FACC15"
    },
    "expires_in": 900
  }'

# -> { "url": "https://connect.gainingsocial.com/s/...", "expires_at": "..." }
# Redirect your customer there. They come back to your return_url.`,
  },
  {
    heading: 'Test and live are separate worlds',
    paragraphs: [
      'A key is either sk_test_ or sk_live_, and the environment is encoded in the key rather than chosen per request. A test key cannot reach a live account by any means, including a live id copied into a test script — that returns ENVIRONMENT_MISMATCH rather than acting on it.',
      'This is why there is no dry_run flag. A flag is one forgotten parameter away from a real post going out; a separate credential is not.',
    ],
  },
  {
    heading: 'Scope keys to what they actually do',
    paragraphs: [
      'Scopes do not imply one another. posts:write does not grant posts:read, because creating a post and enumerating everything a customer has ever published are genuinely different capabilities.',
      'Give your publishing worker posts:write and nothing else. A key that leaks then cannot be used to read your customers\' history. Keys can also carry an expiry, which makes rotation something that happens on schedule rather than after an incident.',
      'A key can also be restricted to a single profile. That is the tightest form available: an agent acting for one customer gets a credential that cannot address any other, so a prompt-injection or a mistaken id cannot reach a different tenant.',
    ],
    code: `curl -X POST https://api.gainingsocial.com/v1/api-keys \\
  -H "Authorization: Bearer sk_live_your_admin_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "environment_id": "env_...",
    "name": "publishing worker",
    "scopes": ["posts:write", "media:write"],
    "restricted_to_profile_id": "pro_...",
    "expires_at": "2027-01-01T00:00:00Z"
  }'

# An empty scopes array is rejected. Stating what a key is for is the
# default; granting everything is the deliberate act.`,
  },
  {
    heading: 'Ownership is checked on the server, every time',
    paragraphs: [
      'Every operation resolves the full chain — destination to connection to profile to environment to project — and checks it against the authenticated key before doing anything. There is no request in which a tenant id is taken from the caller.',
      'That matters for a multi-tenant product in a way that is easy to underestimate. The common way this goes wrong is not a missing check on a sensitive endpoint; it is a check on the obvious endpoints and not on the retry endpoint, or the timeline endpoint, or the one added last month. Every route carries an ownership test.',
    ],
  },
  {
    heading: 'What your customers see when something breaks',
    paragraphs: [
      'Connections fail eventually — tokens expire, users revoke access, a platform changes what a permission grants. The connection.reauth_required webhook fires the moment one becomes unusable, so you can prompt the right customer to reconnect instead of discovering it when they ask why nothing has posted.',
      'Reconnecting is another connect session. The customer follows the same branded flow, and their existing destinations and scheduled posts are preserved.',
    ],
  },
];

const FAQS = [
  {
    question: 'Can I white-label the social account connection flow?',
    answer:
      'Yes. A connect session returns a signed URL that hosts the whole flow — platform chooser, OAuth handshake, destination picker and error states — with your product name and accent colour. Your customer never sees GainingSocial branding and never creates an account with us.',
  },
  {
    question: 'How do I keep one customer\'s accounts separate from another\'s?',
    answer:
      'Each customer is a profile, and every connection, destination, post and media asset belongs to exactly one. Ownership is resolved and verified server-side on every request from the authenticated key, so there is no request in which a caller can name a tenant.',
  },
  {
    question: 'Do I need my own developer app on each social network?',
    answer:
      'No. Publishing runs through our platform applications, so you inherit the approvals rather than applying for them. If you would rather use your own — some enterprises need posts attributed to their own app — you can supply your own client id and secret per platform instead.',
  },
  {
    question: 'Can I test without posting to real social accounts?',
    answer:
      'Yes. Test keys are a separate environment that cannot reach live accounts at all, and cannot be pointed at them by passing a live id. There is no dry-run flag, deliberately — a flag is one forgotten parameter away from a real post going out.',
  },
  {
    question: 'What happens when a customer revokes access at the platform?',
    answer:
      'The connection is marked unusable and a connection.reauth_required or connection.disconnected webhook fires. Queued posts to that destination are held rather than failing silently, and sending the customer through a new connect session restores publishing with their destinations intact.',
  },
  {
    question: 'How many social accounts can one profile have?',
    answer:
      'No fixed limit. One profile commonly holds several connections — one per network — and each connection can expose several destinations, such as every Facebook Page an account administers or every Pinterest board it owns.',
  },
];

export default function MultiTenantGuidePage() {
  return (
    <GuidePage
      breadcrumb={{ name: 'Multi-tenant', path: '/docs/multi-tenant' }}
      heading="Multi-tenant and white-label"
      lead="Add social publishing to your product without building eleven platform integrations. Your customers connect their accounts on your domain, under your branding, and never learn we exist."
      body={BODY}
      steps={[
        {
          name: 'Create a profile per customer',
          text: 'Keyed by your own identifier, so provisioning is idempotent and re-runnable.',
        },
        {
          name: 'Send them to a connect session',
          text: 'A signed, short-lived URL hosting the whole connect flow under your branding.',
        },
        {
          name: 'Publish on their behalf',
          text: 'One request per post, whatever mix of networks it targets.',
        },
        {
          name: 'Handle reauthorization',
          text: 'A webhook tells you the moment a connection expires, so you prompt the right customer.',
        },
      ]}
      faqs={FAQS}
      related={[
        { href: '/docs/webhooks', label: 'Receiving webhooks safely' },
        { href: '/docs/quickstart', label: 'Publish your first post' },
        { href: '/platforms', label: 'Supported networks' },
      ]}
    />
  );
}
