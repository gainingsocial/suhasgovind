import { Badge, Button, Card, CardHeader } from '@/components/ui';

export const metadata = { title: 'Compose' };

/**
 * Composer (plan §57).
 *
 * The product's central promise is that you write once and every platform gets something
 * it will accept. So the composer shows per-destination consequences *while you type* —
 * character counts against each platform's own limit, what gets truncated, what a link
 * will do — rather than failing after you press publish.
 *
 * This is the shell. Live preflight wiring lands with the API key flow.
 */
export default function ComposePage() {
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Compose</h1>
          <p className="mt-1 text-sm text-[var(--text-subtle)]">
            Write once. Every destination gets a version it will accept.
          </p>
        </div>
        <Badge tone="brand">Preflight on</Badge>
      </header>

      {/* Editor above preview on phones, side by side from lg. Stacking is right on a
          narrow screen: a half-width editor is unusable for writing. */}
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader title="Your post" description="Shared text, before per-destination tweaks" />
          <div className="p-4 sm:p-5">
            <label htmlFor="post-text" className="sr-only">
              Post text
            </label>
            <textarea
              id="post-text"
              rows={8}
              placeholder="What do you want to say?"
              className="w-full resize-y rounded-lg border bg-[var(--surface)] p-3 text-sm outline-none placeholder:text-[var(--text-subtle)] focus-visible:border-brand-500"
            />

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="secondary">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <circle cx="8.5" cy="9.5" r="1.5" />
                  <path d="m21 16-5-5L5 20" />
                </svg>
                Add media
              </Button>
              <Button variant="secondary">Schedule</Button>
              <Button variant="primary" className="ml-auto">
                Publish
              </Button>
            </div>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Destinations" description="Where this goes" />
            <div className="px-4 py-6 text-center text-sm text-[var(--text-subtle)] sm:px-5">
              Connect an account to choose destinations.
            </div>
          </Card>

          <Card>
            <CardHeader title="Preflight" description="Problems found before publishing" />
            <div className="px-4 py-6 text-center text-sm text-[var(--text-subtle)] sm:px-5">
              Checks run as you type, per destination.
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
