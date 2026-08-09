import { Card, CardHeader, EmptyState } from '@/components/ui';

export const metadata = { title: 'Webhooks' };

export default function Page() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Webhooks</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">Get notified the moment a post publishes or fails.</p>
      </header>

      <Card>
        <CardHeader title="Webhooks" />
        <EmptyState title="No endpoints yet" description="Add an endpoint and we will POST a signed event on every publish, failure and retry." />
      </Card>
    </div>
  );
}
