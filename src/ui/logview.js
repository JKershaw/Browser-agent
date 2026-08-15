/**
 * Request log view: chronological, full detail, credentials masked, exportable
 * as JSON (SPEC §8.4).
 *
 * The log store has already masked everything (`state/log.js`); this view only
 * renders, so there is no second place a secret could slip through.
 *
 * @module ui/logview
 */

import { clear, disclosure, downloadText, el, formatMs, prettyJson } from './dom.js';
import { kvTable } from './chat.js';

/**
 * @param {HTMLElement} root
 * @param {object} log The request log store.
 * @returns {{render: Function}}
 */
export function createLogView(root, log) {
  function render(entries = log.all()) {
    clear(root);

    root.append(
      el('div', { class: 'log-toolbar' }, [
        el('span', { class: 'muted', text: `${entries.length} request${entries.length === 1 ? '' : 's'}` }),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn btn-small',
          type: 'button',
          disabled: entries.length === 0,
          onclick: () => downloadText('browser-agent-log.json', log.toJSON()),
        }, 'Export JSON'),
        el('button', {
          class: 'btn btn-small',
          type: 'button',
          disabled: entries.length === 0,
          onclick: () => log.clear(),
        }, 'Clear'),
      ])
    );

    if (entries.length === 0) {
      root.append(el('p', { class: 'muted empty', text: 'No requests yet. Ask the agent to fetch something.' }));
      return;
    }

    // Newest first: the thing you just did is the thing you want to read.
    for (const entry of [...entries].reverse()) root.append(renderEntry(entry));
  }

  log.subscribe(render);
  render();
  return { render };
}

/** @param {object} e */
function renderEntry(e) {
  const time = new Date(e.at).toLocaleTimeString();
  const status =
    e.status === 'ok' ? `${e.response.status}` :
    e.status === 'denied' ? 'denied' :
    e.status === 'error' ? 'failed' : '…';

  const detail = [
    el('div', { class: 'log-section' }, [
      el('h4', { text: 'Request' }),
      el('p', { class: 'log-url', text: e.url }),
      e.proxied ? el('p', { class: 'muted', text: 'sent via the configured CORS proxy' }) : null,
      e.credentialsUsed?.length ? el('p', { class: 'muted', text: `credentials used: ${e.credentialsUsed.join(', ')}` }) : null,
      kvTable(e.requestHeaders),
      e.requestBody ? el('pre', { class: 'code', text: prettyJson(e.requestBody) }) : null,
    ]),
  ];

  if (e.status === 'ok') {
    detail.push(
      el('div', { class: 'log-section' }, [
        el('h4', { text: `Response — HTTP ${e.response.status} ${e.response.statusText}`.trim() }),
        e.response.redirected ? el('p', { class: 'muted', text: `final URL: ${e.response.finalUrl}` }) : null,
        kvTable(e.response.headers),
        el('pre', { class: 'code', text: prettyJson(e.response.body) }),
        e.response.truncated ? el('p', { class: 'muted', text: 'body truncated at the configured limit' }) : null,
      ])
    );
  } else if (e.error) {
    detail.push(
      el('div', { class: 'log-section' }, [
        el('h4', { text: `Error — ${e.error.kind}` }),
        el('p', { class: 'error-explain', text: e.error.message }),
      ])
    );
  }

  return el('div', { class: `log-entry log-${e.status}` }, [
    disclosure(`${time}  ${e.method}  ${shortUrl(e.url)}  ·  ${status}  ·  ${formatMs(e.elapsedMs)}`, detail, {
      class: 'log-disclosure',
    }),
  ]);
}

/**
 * Shorten a URL for the summary line without hiding the host, which is the
 * part that matters for judging a request at a glance.
 *
 * @param {string} url
 * @returns {string}
 */
export function shortUrl(url) {
  try {
    const u = new URL(url);
    const tail = `${u.pathname}${u.search}`;
    return `${u.host}${tail.length > 40 ? `${tail.slice(0, 39)}…` : tail}`;
  } catch {
    return String(url).slice(0, 60);
  }
}
