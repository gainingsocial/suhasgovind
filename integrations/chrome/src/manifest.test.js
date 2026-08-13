import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The manifest, and whether it points at anything real.
 *
 * An extension whose manifest names a missing file does not fail loudly — Chrome refuses
 * to load it with a message you only see if you happen to be looking at the extensions
 * page. This is the one thing worth asserting mechanically, because it is invisible in
 * review: the first draft of this manifest declared three icons that did not exist.
 */

const dir = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(`${dir}manifest.json`, 'utf8'));

/** Every path the manifest references, wherever it appears. */
function referencedPaths(node) {
  if (typeof node === 'string') {
    return /\.(html|js|css|png|json)$/.test(node) ? [node] : [];
  }
  if (Array.isArray(node)) return node.flatMap(referencedPaths);
  if (node && typeof node === 'object') return Object.values(node).flatMap(referencedPaths);
  return [];
}

describe('manifest', () => {
  it('is Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('references only files that exist', () => {
    const missing = referencedPaths(manifest).filter((path) => !existsSync(`${dir}${path}`));
    expect(missing).toEqual([]);
  });

  it('declares every icon size the Chrome Web Store asks for', () => {
    expect(Object.keys(manifest.icons).sort()).toEqual(['128', '16', '48']);
  });

  it('asks for no host permission beyond our own API', () => {
    // A publishing extension that requests `<all_urls>` is asking to read every page the
    // person ever visits, and reviewers treat it accordingly. `activeTab` grants the same
    // reach for the tab actually being shared, only when the button is clicked.
    expect(manifest.host_permissions).toEqual(['https://api.gainingsocial.com/*']);
    expect(manifest.permissions).not.toContain('tabs');
    expect(manifest.permissions).toContain('activeTab');
  });

  it('has no remotely-hosted code, which the store forbids', () => {
    const sources = [`${dir}src/popup.html`, `${dir}src/options.html`]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    expect(sources).not.toMatch(/src=["']https?:/i);
  });
});

describe('page scripts', () => {
  const popup = readFileSync(`${dir}src/popup.js`, 'utf8');

  it('never evaluates code as a string', () => {
    // `new Function` and `eval` are blocked by the content security policy of any site
    // strict enough to set one — which is exactly the kind of site worth sharing from.
    expect(popup).not.toMatch(/new Function|\beval\(/);
  });

  it('builds DOM nodes rather than assigning innerHTML', () => {
    // Page-controlled strings — a title, a description — reach this UI. Assigning them as
    // HTML would make every shared page a scripting vector against the popup.
    expect(popup).not.toMatch(/innerHTML/);
  });
});
