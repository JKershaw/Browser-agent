/**
 * Minimal DOM helpers.
 *
 * One rule this module exists to enforce: **untrusted text is only ever set
 * via `textContent`.** Everything rendered in this app — model output, HTTP
 * response bodies, header values, URLs — is attacker-influenceable, so there is
 * no `innerHTML` path anywhere in `src/ui/`.
 *
 * @module ui/dom
 */

/**
 * Create an element.
 *
 * @param {string} tag
 * @param {object} [attrs] Attributes. `class`, `text`, `html`-free by design.
 *   Keys starting with `on` are bound as event listeners. `dataset` is an
 *   object of data attributes.
 * @param {Array<Node|string>|Node|string} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') {
      node.textContent = String(v);
    } else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'class') {
      node.className = String(v);
    } else if (v === true) {
      node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** @param {Element} node */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Format a byte count for humans.
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a duration for humans.
 * @param {number|null} ms
 * @returns {string}
 */
export function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Pretty-print a JSON string; return it unchanged when it is not JSON.
 * @param {string} text
 * @returns {string}
 */
export function prettyJson(text) {
  const s = String(text ?? '');
  const trimmed = s.trim();
  if (trimmed === '' || !/^[[{]/.test(trimmed)) return s;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return s;
  }
}

/**
 * A `<details>` disclosure with a summary line.
 *
 * @param {string} summary
 * @param {Array<Node|string>|Node|string} body
 * @param {object} [opts]
 * @param {boolean} [opts.open]
 * @param {string} [opts.class]
 * @returns {HTMLElement}
 */
export function disclosure(summary, body, opts = {}) {
  return el('details', { class: opts.class, open: opts.open }, [
    el('summary', { text: summary }),
    el('div', { class: 'disclosure-body' }, body),
  ]);
}

/**
 * Copy text to the clipboard, falling back to a hidden textarea where the
 * async Clipboard API is unavailable (older Safari, insecure origins).
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = el('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Offer a string to the user as a file download.
 * @param {string} filename
 * @param {string} text
 * @param {string} [mime]
 */
export function downloadText(filename, text, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
