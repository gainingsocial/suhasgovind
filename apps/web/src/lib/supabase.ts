import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Supabase Auth, server side (plan §39).
 *
 * Humans sign in here; machines use API keys. The dashboard never holds a database
 * credential — the anon key is a public, RLS-constrained identity, and everything the
 * dashboard actually reads comes from the API using the session token (P11/P15).
 *
 * Server-only. `next/headers` cannot be bundled into a Client Component, so the browser
 * client lives in `supabase-browser.ts` — see the note there.
 */

function requireConfig(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    // Failing loudly beats a login page that silently never works.
    throw new Error(
      'Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }

  return { url, anonKey };
}

/**
 * Server client, reading the session from cookies.
 *
 * Cookie writes are attempted and allowed to fail: a Server Component cannot set cookies,
 * and Supabase's refresh flow tries to. Swallowing that specific case is the documented
 * pattern — the middleware refreshes instead.
 */
export async function serverClient() {
  const { url, anonKey } = requireConfig();
  const store = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (items) => {
        try {
          for (const { name, value, options } of items) store.set(name, value, options);
        } catch {
          // Server Component render. The middleware owns refreshing the session.
        }
      },
    },
  });
}

/**
 * The access token to forward to the API.
 *
 * Returned rather than stored anywhere: it is short-lived by design, and the whole reason
 * the dashboard uses sessions instead of an API key is to avoid keeping a durable
 * credential in the browser.
 */
export async function sessionToken(): Promise<string | null> {
  const supabase = await serverClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function currentUser() {
  const supabase = await serverClient();
  // `getUser` revalidates against Supabase rather than trusting the cookie, which is what
  // makes it safe to gate a page on. `getSession` alone reads unverified cookie contents.
  const { data } = await supabase.auth.getUser();
  return data.user;
}
