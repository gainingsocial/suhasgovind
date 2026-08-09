import type { NextConfig } from 'next';

/**
 * Next.js configuration.
 *
 * Versions are pinned exactly in package.json rather than floated (plan §4.2 "Deployment
 * rule"): Next and OpenNext move fast, and an unattended minor bump has broken Cloudflare
 * deploys before — the dashboard would go down with no code change to point at.
 *
 * ## Two build targets, on purpose
 *
 * `NEXT_STATIC_EXPORT=1` produces a static site served by Cloudflare Workers Assets.
 * Everything else produces a server-rendered Worker via OpenNext.
 *
 * The static path exists because OpenNext cannot be built on Windows: it emits absolute
 * manifest paths that fail at runtime with `Dynamic require of
 * "/.next/server/middleware-manifest.json" is not supported`. Every page is static today,
 * so the export is a faithful build rather than a degraded one — but the moment sign-in
 * lands, server rendering is required and the deploy must come from CI on Linux.
 */
const isStaticExport = process.env.NEXT_STATIC_EXPORT === '1';

const config: NextConfig = {
  reactStrictMode: true,
  ...(isStaticExport ? { output: 'export' as const } : {}),
  // The dashboard is an API client (P11/P15). It holds no database credentials and does
  // not proxy tenant media, so the optimizer is off rather than routing customer images
  // through the Worker.
  images: { unoptimized: true },
  typedRoutes: true,
};

export default config;
