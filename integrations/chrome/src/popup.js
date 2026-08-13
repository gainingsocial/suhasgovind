/**
 * The popup: read the page, show what each network would publish, publish it.
 *
 * The preview is not decoration. Every other extension in this category posts and then
 * shows you what went out, which is when you discover LinkedIn silently dropped the link
 * or the image was the wrong aspect ratio. Composing first and publishing exactly what was
 * previewed is the whole difference, and it is why `publish_override` is passed through
 * untouched rather than rebuilt here.
 */
import { errorMessage, newIdempotencyKey, request, settings, trackedUrl } from './api.js';
import { buildArticle, collectRawMeta, isShareable } from './metadata.js';

const els = {
  status: document.getElementById('status'),
  preview: document.getElementById('preview'),
  title: document.getElementById('title'),
  url: document.getElementById('url'),
  targets: document.getElementById('targets'),
  share: document.getElementById('share'),
};

let composition = null;
let article = null;
let config = null;

function say(message, tone = 'info') {
  els.status.textContent = message;
  els.status.dataset.tone = tone;
  els.status.hidden = false;
}

document.getElementById('open-options').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

/**
 * Read the active tab, in the page's own context.
 *
 * `collectRawMeta` is injected directly. Chrome serializes it and calls it with no
 * arguments, which is why its `doc` parameter defaults to `document` — the page's own,
 * not this popup's.
 */
async function readPageDocument() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: collectRawMeta,
  });

  return result?.result ?? null;
}

async function start() {
  config = await settings();

  if (!config.apiKey) {
    say('Add your API key in Settings to get started.', 'warn');
    return;
  }

  if (!config.profileId || config.destinationIds.length === 0) {
    say('Choose a profile and at least one destination in Settings.', 'warn');
    return;
  }

  let raw;
  try {
    raw = await readPageDocument();
  } catch {
    say('This page cannot be read. Browser pages and the Web Store are off limits.', 'warn');
    return;
  }

  if (!raw) {
    say('Could not read this page.', 'warn');
    return;
  }

  article = buildArticle(raw);

  if (!isShareable(article)) {
    say('There is nothing shareable here — no title, or not a web page.', 'warn');
    return;
  }

  els.title.textContent = article.title;
  els.url.textContent = article.url;
  els.preview.hidden = false;

  say('Checking what each network will publish…');

  const { ok, data } = await request('/v1/articles/compose', {
    method: 'POST',
    body: {
      profile_id: config.profileId,
      article,
      targets: config.destinationIds.map((id) => ({ destination_id: id })),
      mode: 'optimize',
    },
  });

  if (!ok) {
    say(errorMessage(data), 'error');
    return;
  }

  composition = data;
  renderTargets(data);
}

function renderTargets(data) {
  els.targets.replaceChildren();

  const targets = data?.composition?.targets ?? [];
  let publishable = 0;

  for (const target of targets) {
    const row = document.createElement('div');
    row.className = 'target';
    row.dataset.status = target.status;

    const name = document.createElement('p');
    name.className = 'target-name';
    name.textContent = target.provider ?? target.destination_id ?? 'Destination';
    row.appendChild(name);

    const text = document.createElement('p');
    text.className = 'target-text';
    // The exact text that will be published, not an approximation of it.
    text.textContent = target.publish_override?.overrides?.text ?? data.derived?.text ?? '';
    row.appendChild(text);

    if (target.status === 'blocked') {
      const why = document.createElement('p');
      why.className = 'target-blocked';
      why.textContent = target.reason || 'This network cannot publish it.';
      row.appendChild(why);
    } else {
      publishable++;
    }

    els.targets.appendChild(row);
  }

  if (publishable === 0) {
    say('No connected network can publish this page.', 'warn');
    els.share.disabled = true;
    return;
  }

  els.status.hidden = true;
  els.share.disabled = false;
  els.share.textContent = `Share to ${publishable} ${publishable === 1 ? 'network' : 'networks'}`;
}

els.share.addEventListener('click', async () => {
  if (!composition) return;

  els.share.disabled = true;
  say('Publishing…');

  const targets = (composition.composition?.targets ?? [])
    .filter((target) => target.status !== 'blocked')
    .map((target) => target.publish_override);

  const derived = composition.derived ?? {};

  const linkUrl = config.utmEnabled
    ? trackedUrl(derived.link_url ?? article.url, 'social', config.utmCampaign)
    : (derived.link_url ?? article.url);

  const { ok, data } = await request('/v1/posts', {
    method: 'POST',
    idempotencyKey: newIdempotencyKey(),
    body: {
      profile_id: config.profileId,
      content: {
        text: derived.text,
        media_ids: derived.media_id ? [derived.media_id] : [],
        link_url: linkUrl,
      },
      targets,
    },
  });

  if (!ok) {
    say(errorMessage(data), 'error');
    els.share.disabled = false;
    return;
  }

  // 202, not 200. Publishing is asynchronous, so saying "Published" here would be a
  // claim the API has not made yet.
  say('Queued. It will go out in a moment.', 'ok');
  els.share.textContent = 'Shared';
});

start().catch((cause) => say(cause.message, 'error'));
