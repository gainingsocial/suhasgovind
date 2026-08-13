import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import staticAssetsIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache';

/**
 * OpenNext configuration.
 *
 * ## Why the incremental cache is declared at all
 *
 * Next stores the output of a prerendered *dynamic* route — `/docs/errors/[code]`, 93
 * pages generated from the error catalog — in the incremental cache rather than alongside
 * the static assets. With no cache configured, OpenNext has nowhere to read them from and
 * every one of those URLs 404s, which was exactly what happened on the first deploy: the
 * sitemap advertised 93 pages the site would not serve, and `docs_url` on every error
 * response pointed at one of them.
 *
 * `staticAssetsIncrementalCache` reads them straight out of the Workers assets binding
 * that is already bound. No R2 bucket, no KV namespace, nothing to provision — which
 * matters here, because provisioning needs somebody signed in to Cloudflare and this
 * should not have been blocked on that.
 *
 * The trade is that it is read-only: pages cannot be revalidated at runtime, only rebuilt
 * and redeployed. That is exactly right for this site. Every page is content in the
 * repository, the error reference is generated from a catalog that only changes when the
 * code does, and there is no revalidation anywhere in the app to give up.
 */
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
});
