'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * The browser half of Supabase Auth, deliberately in its own module.
 *
 * The server half imports `next/headers`, which cannot be bundled into a Client Component
 * at all — importing both from one file makes the whole module unbuildable the moment a
 * client component touches it. Splitting them is not tidiness; it is the only arrangement
 * that compiles.
 *
 * Used by exactly one component: the sign-in form. Everything else in the dashboard reads
 * through the API with the session token (P15).
 */
export function browserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    // Failing loudly beats a sign-in button that silently never works.
    throw new Error(
      'Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }

  return createBrowserClient(url, anonKey);
}
