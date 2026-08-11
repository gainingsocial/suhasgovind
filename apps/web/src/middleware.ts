import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Session refresh and route protection (plan §39).
 *
 * Two jobs, and both have to happen here rather than in a page:
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
  let response = NextResponse.next({ request });

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

  const path = request.nextUrl.pathname;

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
  // Static assets and images are excluded: running an auth check on every icon request
  // would add a Supabase round trip to each one.
  matcher: ['/app/:path*', '/signin'],
};
