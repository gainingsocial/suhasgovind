/**
 * The API client, and the settings it reads.
 *
 * The API key lives in `chrome.storage.local`, not `sync`. Sync replicates to every
 * machine signed into the same Chrome profile, which silently spreads a publishing
 * credential further than the person granting it expects.
 */

export const API_BASE = 'https://api.gainingsocial.com';

export async function settings() {
  const stored = await chrome.storage.local.get([
    'apiKey',
    'profileId',
    'destinationIds',
    'utmEnabled',
    'utmCampaign',
  ]);

  return {
    apiKey: stored.apiKey || '',
    profileId: stored.profileId || '',
    destinationIds: stored.destinationIds || [],
    utmEnabled: Boolean(stored.utmEnabled),
    utmCampaign: stored.utmCampaign || 'gainingsocial',
  };
}

export async function saveSettings(values) {
  await chrome.storage.local.set(values);
}

/**
 * One request.
 *
 * Returns `{ ok, data }` rather than throwing, because every caller here is rendering the
 * outcome into a popup either way — and a rejected promise in a popup with no console open
 * is an empty panel with no explanation.
 */
export async function request(path, { method = 'GET', body, apiKey, idempotencyKey } = {}) {
  const key = apiKey ?? (await settings()).apiKey;

  if (!key) {
    return { ok: false, data: { error: { message: 'Add your API key in the extension options.' } } };
  }

  const headers = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };

  // `POST /v1/posts` requires it and rejects the request without one.
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    return {
      ok: false,
      data: { error: { message: `Could not reach the API: ${cause.message}` } },
    };
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    // A body that is not JSON is still a status worth reporting.
  }

  return { ok: response.ok, data };
}

/** The message to show, taken from the API's envelope rather than invented. */
export function errorMessage(data) {
  return data?.error?.message || 'The request failed.';
}

/**
 * Add campaign parameters to a URL.
 *
 * Kept here rather than in the metadata module because it is a publishing concern: the
 * extracted article should carry the page's canonical URL, and tagging happens on the way
 * out. `URL` handles the encoding, so a campaign with a space cannot double-encode.
 */
export function trackedUrl(url, network, campaign) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  parsed.searchParams.set('utm_source', network || 'social');
  parsed.searchParams.set('utm_medium', 'social');
  parsed.searchParams.set('utm_campaign', campaign || 'gainingsocial');

  return parsed.toString();
}

/**
 * The idempotency key for one share from this browser.
 *
 * A fresh random key per share attempt. Unlike the WordPress plugin there is no durable
 * per-post counter to advance, and a person clicking "Share" a second time on the same
 * page means it — they watched the first one and chose to do it again.
 */
export function newIdempotencyKey() {
  return `ext_${crypto.randomUUID()}`;
}
