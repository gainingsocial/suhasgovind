import { NextResponse, type NextRequest } from 'next/server';

import { serverClient } from '@/lib/supabase';

/**
 * Magic-link landing (plan §39).
 *
 * The email link carries a one-time code which is exchanged here for a session. A Route
 * Handler rather than a page because the exchange writes cookies, and this is the only
 * kind of Next.js handler that reliably can.
 *
 * `next` is validated as a same-origin path rather than being used as given. An
 * attacker-supplied absolute URL here would turn the sign-in flow into an open redirect
 * that lands a freshly-authenticated user on somebody else's site.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  const requested = url.searchParams.get('next') ?? '/app';
  const next = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/app';

  if (!code) {
    return NextResponse.redirect(new URL('/signin?error=missing_code', url.origin));
  }

  const supabase = await serverClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // An expired or already-used link is the common case, not an attack. Sending the
    // person back to request a new one is more useful than showing them the error.
    return NextResponse.redirect(new URL('/signin?error=link_expired', url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
