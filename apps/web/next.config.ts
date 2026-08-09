import type { NextConfig } from 'next';

/**
 * Next.js configuration.
 *
 * Versions are pinned exactly in package.json rather than floated (plan §4.2 "Deployment
 * rule"). Next and OpenNext move fast and a minor bump has broken Cloudflare deploys
 * before; an unattended upgrade would take the dashboard down with no code change to
 * point at.
 */
const config: NextConfig = {
  reactStrictMode: true,
  // The dashboard is an API client (P11/P15). It holds no database credentials and does
  // no image optimization against tenant media, so the optimizer is off rather than
  // proxying customer images through the Worker.
  images: { unoptimized: true },
  typedRoutes: true,
};

export default config;
