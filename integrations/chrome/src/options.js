/**
 * Settings: the key, the profile, and which connected accounts to share to.
 *
 * The destination list is fetched live rather than cached, because a stale list is how
 * somebody publishes to an account they disconnected last week. It also surfaces
 * connection health, which is the thing people leave other tools over: a connection that
 * quietly stopped working and a post that simply never appeared.
 */
import { errorMessage, request, saveSettings, settings } from './api.js';

const els = {
  apiKey: document.getElementById('api-key'),
  profile: document.getElementById('profile'),
  destinations: document.getElementById('destinations'),
  utm: document.getElementById('utm'),
  campaign: document.getElementById('campaign'),
  save: document.getElementById('save'),
  status: document.getElementById('status'),
};

let selected = [];

function say(message, tone = 'info') {
  els.status.textContent = message;
  els.status.dataset.tone = tone;
  els.status.hidden = false;
}

async function loadProfiles(apiKey) {
  const { ok, data } = await request('/v1/profiles', { apiKey });

  if (!ok) {
    say(errorMessage(data), 'error');
    return [];
  }

  return data.data ?? [];
}

async function loadDestinations(apiKey, profileId) {
  els.destinations.replaceChildren();

  const { ok, data } = await request(
    `/v1/connections?profile_id=${encodeURIComponent(profileId)}`,
    { apiKey },
  );

  if (!ok) {
    say(errorMessage(data), 'error');
    return;
  }

  const connections = data.data ?? [];
  let count = 0;

  for (const connection of connections) {
    const result = await request(
      `/v1/connections/${encodeURIComponent(connection.id)}/destinations`,
      { apiKey },
    );
    if (!result.ok) continue;

    for (const destination of result.data.data ?? []) {
      const label = document.createElement('label');
      label.className = 'check';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = destination.id;
      box.checked = selected.includes(destination.id);
      label.appendChild(box);

      label.appendChild(
        document.createTextNode(` ${connection.provider} — ${destination.name}`),
      );

      if (connection.health && connection.health !== 'healthy') {
        const warn = document.createElement('span');
        warn.className = 'warn';
        warn.textContent = ` (needs attention: ${connection.health})`;
        label.appendChild(warn);
      }

      els.destinations.appendChild(label);
      count++;
    }
  }

  if (count === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No connected accounts on this profile yet. Connect one in the dashboard.';
    els.destinations.appendChild(empty);
  }
}

async function refresh() {
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) return;

  const profiles = await loadProfiles(apiKey);

  els.profile.replaceChildren();
  for (const profile of profiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.name;
    els.profile.appendChild(option);
  }

  const stored = await settings();
  if (stored.profileId && profiles.some((p) => p.id === stored.profileId)) {
    els.profile.value = stored.profileId;
  }

  if (els.profile.value) await loadDestinations(apiKey, els.profile.value);
}

els.apiKey.addEventListener('change', refresh);
els.profile.addEventListener('change', () => {
  selected = [];
  refresh();
});

els.save.addEventListener('click', async () => {
  const destinationIds = [...els.destinations.querySelectorAll('input:checked')].map(
    (box) => box.value,
  );

  await saveSettings({
    apiKey: els.apiKey.value.trim(),
    profileId: els.profile.value,
    destinationIds,
    utmEnabled: els.utm.checked,
    utmCampaign: els.campaign.value.trim() || 'gainingsocial',
  });

  selected = destinationIds;
  say('Saved.', 'ok');
});

(async function init() {
  const stored = await settings();

  els.apiKey.value = stored.apiKey;
  els.utm.checked = stored.utmEnabled;
  els.campaign.value = stored.utmCampaign;
  selected = stored.destinationIds;

  if (stored.apiKey) await refresh();
})();
