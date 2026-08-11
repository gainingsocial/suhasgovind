import type { Metadata } from 'next';

import { SignInForm } from './signin-form';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

/**
 * Sign in (plan §39).
 *
 * A magic link rather than a password. Passwords for a dashboard that holds social
 * credentials are a liability with no upside here: there is no password to reuse, nothing
 * to phish that is not already single-use, and no reset flow to get wrong. The email round
 * trip is the cost, and for a tool people sign into weekly rather than hourly it is the
 * right trade.
 */
export default function SignInPage() {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center px-4 py-12">
      <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-[var(--text-subtle)]">
        We will email you a link. No password to remember or lose.
      </p>
      <SignInForm />
    </main>
  );
}
