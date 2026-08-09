import { Card, CardHeader, EmptyState } from '@/components/ui';

export const metadata = { title: 'Media' };

export default function Page() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Media</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">Images and video available to attach to posts.</p>
      </header>

      <Card>
        <CardHeader title="Media" />
        <EmptyState title="No media yet" description="Upload images and video here, then attach them to any post." />
      </Card>
    </div>
  );
}
