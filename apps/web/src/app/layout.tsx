import type { Metadata, Viewport } from 'next';

import { Shell } from '@/components/shell';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'GainingSocial', template: '%s · GainingSocial' },
  description: 'One API. Multiple social networks. Production-grade publishing.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom is left enabled deliberately. Locking it is a common dashboard mistake and it
  // removes the only accessibility affordance some readers have on a phone.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7f8' },
    { media: '(prefers-color-scheme: dark)', color: '#1b1c20' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* First tab stop on every page. Without it, keyboard users traverse the whole
            navigation before reaching content on every single navigation. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-sm focus:text-white"
        >
          Skip to content
        </a>
        <Shell>
          <div id="main">{children}</div>
        </Shell>
      </body>
    </html>
  );
}
