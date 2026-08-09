import type { Metadata, Viewport } from 'next';

import './globals.css';

const SITE_URL = 'https://gainingsocial.com';

/**
 * Root layout.
 *
 * Deliberately thin: it owns only <html>, <body> and the site-wide metadata defaults.
 * The two route groups have genuinely different chrome — marketing has a public header
 * and footer built for reading, the dashboard has an app shell built for working — so
 * each brings its own layout rather than one layout branching on the URL.
 *
 * `metadataBase` is what makes every relative Open Graph and canonical URL resolve to an
 * absolute one. Without it Next emits relative URLs, which crawlers and social scrapers
 * silently ignore — the tags are present and useless.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'GainingSocial — One API for publishing to every social network',
    template: '%s · GainingSocial',
  },
  description:
    'Publish to Bluesky, LinkedIn, Instagram, TikTok and more through a single REST API. ' +
    'Built-in duplicate prevention, per-platform validation before you post, and webhooks ' +
    'that tell you the moment something goes live or fails.',
  applicationName: 'GainingSocial',
  authors: [{ name: 'GainingSocial' }],
  creator: 'GainingSocial',
  openGraph: {
    type: 'website',
    siteName: 'GainingSocial',
    locale: 'en_US',
    url: SITE_URL,
  },
  twitter: { card: 'summary_large_image' },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
  alternates: { canonical: '/' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom stays enabled. Locking it is a common mistake that removes the only
  // accessibility affordance some readers have on a phone.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7f8' },
    { media: '(prefers-color-scheme: dark)', color: '#1b1c20' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
