import Link from 'next/link';

import { Card, CardHeader, EmptyState } from '@/components/ui';
import { NoEnvironmentError, NotSignedInError } from '@/lib/session-api';
import { ApiRequestError } from '@/lib/api';

/**
 * The three ways a dashboard page can fail to load, rendered as answers rather than
 * errors.
 *
 * Each of these is a state a real person reaches, and each needs a different next action.
 * Collapsing them into one "something went wrong" is what makes a product feel broken when
 * it is merely waiting for the user to do something.
 */
export function renderLoadFailure(error: unknown): React.ReactNode {
  if (error instanceof NotSignedInError) {
    return (
      <Card>
        <CardHeader title="Session expired" />
        <EmptyState
          title="Please sign in again"
          description="Your session ended. Signing in again takes a moment and nothing was lost."
          action={
            <Link
              href="/signin"
              className="inline-flex min-h-9 items-center rounded-lg bg-brand-600 px-3 text-sm font-medium text-[var(--on-brand)]"
            >
              Sign in
            </Link>
          }
        />
      </Card>
    );
  }

  if (error instanceof NoEnvironmentError) {
    return (
      <Card>
        <CardHeader title="No project yet" />
        <EmptyState
          title="This account has no project"
          description="You are signed in, but not a member of any project. Ask whoever invited you to add you, or create one to get started."
        />
      </Card>
    );
  }

  if (error instanceof ApiRequestError) {
    return (
      <Card>
        <CardHeader title="Could not load" />
        <EmptyState
          title={error.message}
          description={
            error.requestId
              ? `Quote request ${error.requestId} if you need to ask us about this.`
              : 'Try again in a moment.'
          }
        />
      </Card>
    );
  }

  // An unexpected throw is re-raised so the error boundary handles it. Swallowing it here
  // would turn a real bug into a permanently empty panel nobody investigates.
  throw error;
}
