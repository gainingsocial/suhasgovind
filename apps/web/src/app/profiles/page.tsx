import { Card, CardHeader, EmptyState } from '@/components/ui';

export const metadata = { title: 'Profiles' };

/**
 * Profiles (plan §55).
 *
 * A profile is the brand, customer or creator identity you publish on behalf of.
 * Everything publishable hangs off one, which is why this page comes before connections
 * in the onboarding order.
 */
export default function ProfilesPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Profiles</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          Each profile is a brand or customer you publish for. Connections and posts belong to one.
        </p>
      </header>

      <Card>
        <CardHeader title="Your profiles" />
        <EmptyState
          title="No profiles yet"
          description="Create a profile for each brand, client or location you publish on behalf of."
        />
      </Card>
    </div>
  );
}
