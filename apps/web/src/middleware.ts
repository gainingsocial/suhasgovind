import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/** The one origin the dashboard is served from. Everything else redirects to it. */
const CANONICAL_HOST = 'gainingsocial.com';

/**
 * One canonical origin, session refresh, and route protection (plan §39).
 *
 * Three jobs, and all of them have to happen here rather than in a page:
 *
 *   canonical `app.` and `www.` resolve to this same Worker, so the site answered on three
 *             hostnames. Session cookies are host-only, so crossing between them silently
 *             signed people out. One origin makes that unreachable.
 *
 *   refresh   Supabase access tokens are short-lived. A Server Component cannot set
 *             cookies, so a refresh performed during render is computed and then thrown
 *             away — the user is signed out mid-session for no visible reason. Middleware
 *             can write cookies, so this is where the refresh has to live.
 *
 *   protect   `/app/*` requires a session. Redirecting here means an unauthenticated
 *             request never reaches a page that would otherwise call the API and render an
 *             error, which reads as a broken product rather than as "please sign in".
 *
 * The dashboard is noindex throughout (see the layout), so no crawler ever follows these
 * redirects.
 */
export async function middleware(request: NextRequest) {
  // One origin, before anything else looks at the session.
  //
  // `app.gainingsocial.com` and `www.` both resolve to this same Worker, so the app was
  // reachable on three hostnames at once. That is not merely untidy: the Supabase session
  // cookie is host-only, so a person who signed in on the apex and then followed a link to
  // the `app.` subdomain arrived with no session and was asked to sign in a second time.
  // Collapsing to one host makes that class of bug unreachable.
  const host = request.headers.get('host')?.split(':')[0]?.toLowerCase();
  if (host && (host === `app.${CANONICAL_HOST}` || host === `www.${CANONICAL_HOST}`)) {
    const target = request.nextUrl.clone();
    target.host = CANONICAL_HOST;
    target.port = '';
    target.protocol = 'https:';
    // Permanent: this is a durable routing decision, and letting browsers and crawlers
    // cache it keeps the duplicate hostnames out of the search index.
    return NextResponse.redirect(target, 308);
  }

  const path = request.nextUrl.pathname;

  let response = NextResponse.next({ request });

  // Only the dashboard and the sign-in page have a session to reason about. The matcher
  // below has to be wide enough for the hostname redirect above to see every request, so
  // this is what keeps a Supabase round trip off every marketing page view — those pages
  // are static, indexed, and must stay fast.
  const needsSession = path.startsWith('/app') || path === '/signin';
  if (!needsSession) return response;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Without configuration there is no session to refresh and no way to sign in. Letting
  // the request through means the page renders its own "not configured" message, which
  // says more than a redirect loop to a login screen that cannot work.
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (items) => {
        for (const { name, value } of items) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of items) response.cookies.set(name, value, options);
      },
    },
  });

  // `getUser` revalidates against Supabase rather than trusting the cookie's contents,
  // which is what makes it safe to gate on. It is also what triggers the refresh whose
  // cookies the callback above captures.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && path.startsWith('/app')) {
    const target = request.nextUrl.clone();
    target.pathname = '/signin';
    // Preserved so signing in lands where the person was going, not on the overview.
    target.searchParams.set('next', path);
    return NextResponse.redirect(target);
  }

  if (user && path === '/signin') {
    const target = request.nextUrl.clone();
    target.pathname = '/app';
    target.search = '';
    return NextResponse.redirect(target);
  }

  return response;
}

export const config = {
  // Every HTML request, because the canonical-hostname redirect has to see requests for
  // marketing pages too — a visitor landing on `www.` deserves the redirect wherever they
  // landed, not only on `/app`.
  //
  // Static assets, images and anything with a file extension are still excluded: those are
  // served from the same hostname the page was, so redirecting them buys nothing and would
  // put a middleware invocation in front of every icon and script.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)'],
};
