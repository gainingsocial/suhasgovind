import type { ProviderName } from '@gs/contracts/providers';

/**
 * The hosted connect page (plan §22).
 *
 * Rendered as a single self-contained document with no build step, no framework and no
 * external requests. That is a deliberate constraint rather than minimalism for its own
 * sake: this page is opened by somebody else's customer, often on a phone, often from an
 * email link, and every external asset is a request that can be slow, blocked, or a
 * privacy problem for the customer whose brand is on the page.
 *
 * The customer's branding is applied through CSS custom properties. The defaults are the
 * product palette — yellow for primary action against black text, red and green reserved
 * for status so a coloured badge always means the same thing.
 */

export interface ConnectPageProvider {
  provider: ProviderName;
  displayName: string;
  status: {
    accountName: string;
    health: string;
    setupComplete: boolean;
  } | null;
}

export interface ConnectPageInput {
  token: string;
  branding: Record<string, unknown>;
  returnUrl: string | null;
  providers: ConnectPageProvider[];
}

/**
 * Escape for HTML text and attribute contexts.
 *
 * Every interpolation below goes through this. The values are not arbitrary — they come
 * from provider names and customer branding — but "not arbitrary" is not the same as
 * "trusted", and a company name is customer-supplied text that reaches an end user's
 * browser.
 */
function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Accept only a literal hex colour. Anything else could close the style block. */
function safeAccent(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

/** Accept only an absolute HTTPS image URL, since the CSP allows `img-src https:`. */
function safeLogo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function statusBadge(status: ConnectPageProvider['status']): string {
  if (!status) return '<span class="badge">Not connected</span>';
  if (!status.setupComplete) {
    return '<span class="badge badge-warn">Needs a destination</span>';
  }
  if (status.health === 'healthy' || status.health === 'refresh_due') {
    return '<span class="badge badge-ok">Connected</span>';
  }
  return `<span class="badge badge-bad">${esc(status.health.replaceAll('_', ' '))}</span>`;
}

export function renderConnectPage(input: ConnectPageInput): string {
  const accent = safeAccent(input.branding.accent) ?? '#FFC800';
  const logo = safeLogo(input.branding.logo_url);
  const company =
    typeof input.branding.company_name === 'string' && input.branding.company_name.length > 0
      ? input.branding.company_name
      : null;

  const rows = input.providers
    .map(
      (item) => `
      <li class="row" data-provider="${esc(item.provider)}">
        <div class="row-main">
          <div class="row-name">${esc(item.displayName)}</div>
          <div class="row-meta">${
            item.status ? esc(item.status.accountName) : 'No account linked yet'
          }</div>
        </div>
        <div class="row-side">
          ${statusBadge(item.status)}
          <button type="button" class="btn" data-connect="${esc(item.provider)}">${
            item.status ? 'Reconnect' : 'Connect'
          }</button>
        </div>
      </li>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Connect your accounts${company ? ` · ${esc(company)}` : ''}</title>
<style>
  :root {
    color-scheme: light;
    --accent: ${accent};
    --ink: #101010;
    --paper: #ffffff;
    --muted: #626262;
    --line: #e4e4e4;
    --ok: #1a7f4b;
    --bad: #c02626;
    --warn: #8a6100;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px 16px 48px;
    background: #f7f7f5;
    color: var(--ink);
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 520px; margin: 0 auto; }
  header { text-align: center; margin-bottom: 24px; }
  header img { max-height: 44px; max-width: 200px; }
  h1 { font-size: 22px; margin: 16px 0 4px; letter-spacing: -0.01em; }
  .lede { color: var(--muted); font-size: 14px; margin: 0; }
  .card { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  ul { list-style: none; margin: 0; padding: 0; }
  .row { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .row:last-child { border-bottom: 0; }
  .row-main { min-width: 0; flex: 1; }
  .row-name { font-weight: 600; font-size: 15px; }
  .row-meta { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-side { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .badge { font-size: 12px; padding: 3px 8px; border-radius: 999px; background: #f0f0ee; color: var(--muted); white-space: nowrap; }
  .badge-ok { background: #e7f5ed; color: var(--ok); }
  .badge-bad { background: #fdeaea; color: var(--bad); }
  .badge-warn { background: #fdf3e0; color: var(--warn); }
  .btn {
    font: inherit; font-size: 14px; font-weight: 600;
    background: var(--accent); color: var(--ink);
    border: 0; border-radius: 8px; padding: 8px 14px; cursor: pointer;
  }
  .btn:disabled { opacity: 0.55; cursor: progress; }
  .btn-quiet { background: transparent; border: 1px solid var(--line); }
  form.creds { padding: 0 16px 16px; display: none; }
  form.creds.open { display: block; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
  input { width: 100%; font: inherit; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
  .help { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .msg { margin: 12px 0 0; font-size: 13px; }
  .msg-bad { color: var(--bad); }
  .msg-ok { color: var(--ok); }
  footer { margin-top: 20px; text-align: center; }
  .fine { color: var(--muted); font-size: 12px; margin-top: 20px; text-align: center; }
</style>
</head>
<body>
<main>
  <header>
    ${logo ? `<img src="${esc(logo)}" alt="${esc(company ?? 'Logo')}">` : ''}
    <h1>Connect your accounts</h1>
    <p class="lede">${
      company
        ? `${esc(company)} will be able to publish posts to the accounts you connect.`
        : 'Choose the accounts you want to publish to.'
    }</p>
  </header>

  <div class="card">
    <ul id="providers">${rows}</ul>
    <form class="creds" id="creds" autocomplete="off">
      <div id="fields"></div>
      <p class="msg" id="msg"></p>
      <p style="margin-top:14px; display:flex; gap:8px;">
        <button type="submit" class="btn" id="submit">Connect</button>
        <button type="button" class="btn btn-quiet" id="cancel">Cancel</button>
      </p>
    </form>
  </div>

  <footer>
    ${
      input.returnUrl
        ? '<button type="button" class="btn btn-quiet" id="done">I am finished</button>'
        : ''
    }
  </footer>
  <p class="fine">You can revoke access at any time from the social platform itself.</p>
</main>

<script>
(function () {
  var token = ${JSON.stringify(input.token)};
  var creds = document.getElementById('creds');
  var fields = document.getElementById('fields');
  var msg = document.getElementById('msg');
  var submit = document.getElementById('submit');
  var pending = null;

  function say(text, tone) {
    msg.textContent = text || '';
    msg.className = 'msg' + (tone ? ' msg-' + tone : '');
  }

  function post(path, body) {
    return fetch('/connect/' + encodeURIComponent(token) + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          // The API's error envelope is the same one the REST API returns, so the message
          // here is the one written for a human rather than a generic failure string.
          throw new Error((data && data.error && data.error.message) || 'Something went wrong.');
        }
        return data;
      });
    });
  }

  document.getElementById('providers').addEventListener('click', function (event) {
    var button = event.target.closest('[data-connect]');
    if (!button) return;
    var provider = button.getAttribute('data-connect');

    button.disabled = true;
    say('');

    post('/authorize', { provider: provider }).then(function (data) {
      if (data.completion === 'redirect') {
        // Full-page navigation, not a popup: popups are blocked on mobile far more often
        // than they work, and the provider decides where the user lands afterwards.
        window.location.href = data.authorization_url;
        return;
      }

      pending = { state: data.state, url: data.authorization_url };
      fields.innerHTML = '';
      data.required_credential_fields.forEach(function (field) {
        var id = 'f_' + field.name;
        var label = document.createElement('label');
        label.setAttribute('for', id);
        label.textContent = field.label;
        var input = document.createElement('input');
        input.id = id;
        input.name = field.name;
        input.type = field.type === 'password' ? 'password' : 'text';
        input.required = true;
        fields.appendChild(label);
        fields.appendChild(input);
        if (field.help) {
          var help = document.createElement('p');
          help.className = 'help';
          help.textContent = field.help;
          fields.appendChild(help);
        }
      });

      if (data.authorization_url) {
        var link = document.createElement('p');
        link.className = 'help';
        link.innerHTML = 'Need one? <a href="' + data.authorization_url.replace(/"/g, '&quot;') +
          '" target="_blank" rel="noopener noreferrer">Create it here</a>.';
        fields.appendChild(link);
      }

      creds.classList.add('open');
      creds.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      button.disabled = false;
    }).catch(function (error) {
      say(error.message, 'bad');
      button.disabled = false;
    });
  });

  creds.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!pending) return;

    var credentials = {};
    Array.prototype.forEach.call(fields.querySelectorAll('input'), function (input) {
      credentials[input.name] = input.value;
    });

    submit.disabled = true;
    say('Checking with the platform…');

    post('/complete', { state: pending.state, credentials: credentials }).then(function () {
      // Reloading re-reads the real connection state rather than trusting what the page
      // believes happened, which is what makes the status badges honest.
      window.location.reload();
    }).catch(function (error) {
      say(error.message, 'bad');
      submit.disabled = false;
    });
  });

  document.getElementById('cancel').addEventListener('click', function () {
    creds.classList.remove('open');
    pending = null;
    say('');
  });

  var done = document.getElementById('done');
  if (done) {
    done.addEventListener('click', function () {
      done.disabled = true;
      post('/finish', {}).then(function (data) {
        if (data.return_url) window.location.href = data.return_url;
      }).catch(function () {
        done.disabled = false;
      });
    });
  }
})();
</script>
</body>
</html>`;
}
