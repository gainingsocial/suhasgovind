#!/usr/bin/env node
/**
 * Configure Supabase Auth for production: sign-in redirects, and the SMTP sender.
 *
 *   node scripts/setup-auth-email.mjs
 *
 * ## Why this exists
 *
 * Two settings live in the Supabase project rather than in this repository, and both of
 * them silently break sign-in when wrong. Neither is visible in a code review, so they get
 * written down here as executable configuration instead of as a wiki page nobody reads.
 *
 * ### Redirects
 *
 * `site_url` and `uri_allow_list` decide where a magic link lands. Shipped as
 * `http://localhost:3000` with an empty allow list, every sign-in email sent anyone who
 * clicked it to their own machine, where nothing is listening — the link appeared to do
 * nothing at all. This script is idempotent, so running it is always safe.
 *
 * ### SMTP
 *
 * Supabase's built-in mailer delivers **only to members of the Supabase project** and caps
 * the whole project at 2 emails per hour. That is a testing convenience, not a sending
 * path: with it, no customer can ever receive a sign-in link. The API refuses to raise the
 * limit until custom SMTP is set, and says so:
 *
 *   "Custom SMTP required to configure SMTP_SENDER_NAME or RATE_LIMIT_EMAIL_SENT."
 *
 * So SMTP credentials are a hard external dependency, in the same category as the provider
 * client IDs — the code is ready and waits on the account. Put these in `.env` and re-run:
 *
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_ADMIN_EMAIL
 *
 * The sending domain must also be verified with DNS records at the provider. Those go in
 * the Cloudflare zone — `scripts/` has zone access already via CLOUDFLARE_API_TOKEN.
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }),
);

const token = process.env.SUPABASE_ACCESS_TOKEN ?? env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF ?? env.SUPABASE_PROJECT_REF;

if (!token || !ref) {
  console.error('Need SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF (in the environment or .env).');
  process.exit(1);
}

const SITE = 'https://gainingsocial.com';

/**
 * Every origin a sign-in link may return to.
 *
 * `www.` and `app.` are included because both hostnames resolve to the same Worker and a
 * person may have started there. The middleware redirects them to the apex, but the
 * allow-list is checked by Supabase *before* the browser ever reaches our redirect — an
 * origin missing here is rejected at the source and falls back to `site_url`.
 *
 * `localhost` stays for development. It is not a production hole: a redirect target is
 * only reachable by someone already holding the one-time code from their own inbox.
 */
const ALLOW_LIST = [
  `${SITE}/auth/callback`,
  `${SITE}/**`,
  'https://www.gainingsocial.com/auth/callback',
  'https://www.gainingsocial.com/**',
  'https://app.gainingsocial.com/auth/callback',
  'https://app.gainingsocial.com/**',
  'http://localhost:3000/**',
].join(',');

const api = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function patch(body, label) {
  const response = await fetch(api, { method: 'PATCH', headers, body: JSON.stringify(body) });
  const text = await response.text();

  if (!response.ok) {
    console.error(`  ${label}: FAILED (${response.status}) ${text.slice(0, 300)}`);
    return false;
  }
  console.log(`  ${label}: ok`);
  return true;
}

const current = await fetch(api, { headers }).then((r) => r.json());

console.log(`Supabase auth config for ${ref}`);
console.log(`  current site_url: ${current.site_url}`);

let failed = false;

failed = !(await patch({ site_url: SITE, uri_allow_list: ALLOW_LIST }, 'redirects')) || failed;

const smtp = {
  host: process.env.SMTP_HOST ?? env.SMTP_HOST,
  port: process.env.SMTP_PORT ?? env.SMTP_PORT,
  user: process.env.SMTP_USER ?? env.SMTP_USER,
  pass: process.env.SMTP_PASS ?? env.SMTP_PASS,
  admin: process.env.SMTP_ADMIN_EMAIL ?? env.SMTP_ADMIN_EMAIL,
};

if (smtp.host && smtp.port && smtp.user && smtp.pass && smtp.admin) {
  const ok = await patch(
    {
      smtp_host: smtp.host,
      smtp_port: Number(smtp.port),
      smtp_user: smtp.user,
      smtp_pass: smtp.pass,
      smtp_admin_email: smtp.admin,
      smtp_sender_name: 'GainingSocial',
      // Raised only once SMTP is set — the API rejects it otherwise. 30/hour is a
      // sign-up rate, not a send budget: each one is a person waiting on a link.
      rate_limit_email_sent: 30,
    },
    'smtp',
  );
  failed = !ok || failed;
} else {
  console.log('  smtp: skipped — no SMTP_* in .env');
  console.log('');
  console.log('  Sign-in email is limited to Supabase project members at 2/hour until');
  console.log('  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_ADMIN_EMAIL are set.');
  console.log('  Customers cannot receive a sign-in link before then.');
}

process.exit(failed ? 1 : 0);
