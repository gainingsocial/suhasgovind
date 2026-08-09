import { Badge, Card, CardHeader, EmptyState } from '@/components/ui';

export const metadata = { title: 'Connections' };

/**
 * Connections (plan §56).
 *
 * Health is the primary column, not an afterthought. A connection is a live thing that
 * degrades — tokens expire, users revoke access, platforms rate limit — and the moment
 * one stops working, everything scheduled against it silently stops too.
 */
export default function ConnectionsPage() {
  const platforms = [
    { name: 'Bluesky', ready: true, note: 'No approval needed' },
    { name: 'Telegram', ready: false, note: 'Coming soon' },
    { name: 'LinkedIn', ready: false, note: 'Awaiting platform approval' },
    { name: 'Facebook Page', ready: false, note: 'Awaiting platform approval' },
    { name: 'Instagram', ready: false, note: 'Awaiting platform approval' },
    { name: 'Threads', ready: false, note: 'Awaiting platform approval' },
  ];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Connections</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          Social accounts linked to your profiles.
        </p>
      </header>

      <Card>
        <CardHeader title="Connected accounts" />
        <EmptyState
          title="No accounts connected"
          description="Connect a social account to start publishing. Bluesky needs no approval and works immediately."
        />
      </Card>

      <Card>
        <CardHeader
          title="Available platforms"
          description="Platforms marked as awaiting approval are built, but need the platform's sign-off before they can publish"
        />
        <ul className="divide-y">
          {platforms.map((platform) => (
            <li key={platform.name} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{platform.name}</span>
                <span className="block text-xs text-[var(--text-subtle)]">{platform.note}</span>
              </span>
              <Badge tone={platform.ready ? 'ok' : 'neutral'}>
                {platform.ready ? 'Available' : 'Not yet'}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
