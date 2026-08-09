import { Card, CardHeader, EmptyState } from '@/components/ui';

export const metadata = { title: 'API keys' };

export default function Page() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">API keys</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">Keys authenticate every request. Test keys can never touch live accounts.</p>
      </header>

      <Card>
        <CardHeader title="API keys" />
        <EmptyState title="No keys yet" description="Create a key to start using the API. The value is shown once and cannot be retrieved later." />
      </Card>
    </div>
  );
}
