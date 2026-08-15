/**
 * Chat pane: streaming assistant messages, collapsible tool cards, error
 * styling and the confirmation flow.
 *
 * Nothing here interprets markdown or HTML. Model output and HTTP response
 * bodies are rendered as plain text (see `ui/dom.js`), because both are
 * attacker-influenceable.
 *
 * @module ui/chat
 */

import { MASK, maskHeaders, maskSecrets, previewHeaders } from '../tools/curl.js';
import { clear, disclosure, el, formatMs, prettyJson } from './dom.js';

/**
 * @param {HTMLElement} root Scroll container the messages live in.
 * @returns {object}
 */
export function createChatPane(root) {
  /** @type {HTMLElement|null} The assistant bubble currently streaming. */
  let streaming = null;
  let streamBuffer = '';
  let pendingCard = null;

  /** Scroll to the bottom unless the user has deliberately scrolled up. */
  function autoScroll() {
    const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 120;
    if (nearBottom) root.scrollTop = root.scrollHeight;
  }

  function add(node) {
    root.append(node);
    autoScroll();
    return node;
  }

  return {
    /** Remove every message. */
    clear() {
      clear(root);
      streaming = null;
      streamBuffer = '';
      pendingCard = null;
    },

    /**
     * @param {string} text
     */
    addUserMessage(text) {
      return add(el('div', { class: 'msg msg-user' }, [el('div', { class: 'msg-body', text })]));
    },

    /**
     * Begin (or restart) the streaming assistant bubble.
     * @param {{repair?: boolean}} [opts]
     */
    beginStream(opts = {}) {
      streamBuffer = '';
      streaming = el('div', { class: `msg msg-assistant${opts.repair ? ' msg-repair' : ''}` }, [
        opts.repair ? el('div', { class: 'msg-tag', text: 'correcting its tool call…' }) : null,
        el('div', { class: 'msg-body' }),
        el('span', { class: 'caret', 'aria-hidden': 'true' }),
      ]);
      return add(streaming);
    },

    /** @param {string} delta */
    pushDelta(delta) {
      if (!streaming) this.beginStream();
      streamBuffer += delta;
      streaming.querySelector('.msg-body').textContent = streamBuffer;
      autoScroll();
    },

    /**
     * Discard the streaming bubble. Used when the output turned out to be a
     * tool call, which is rendered as a card instead.
     */
    dropStream() {
      streaming?.remove();
      streaming = null;
      streamBuffer = '';
    },

    /**
     * Settle the streaming bubble with the model's final text.
     *
     * The streamed text is raw; the committed text has had any thinking-mode
     * preamble removed, so replacing it here is what the user should be left
     * looking at.
     *
     * @param {string} text
     * @param {{parseError?: object}} [meta]
     */
    commitStream(text, meta = {}) {
      if (!streaming) return this.addAssistantMessage(text, meta);
      streaming.querySelector('.caret')?.remove();
      streaming.querySelector('.msg-body').textContent = text;
      streaming.classList.remove('msg-repair');
      streaming.querySelector('.msg-tag')?.remove();
      if (meta.parseError) {
        streaming.prepend(el('div', { class: 'msg-tag msg-tag-warn', text: 'tool call failed to parse' }));
      }
      const node = streaming;
      streaming = null;
      streamBuffer = '';
      autoScroll();
      return node;
    },

    /**
     * Render a settled assistant message (used when nothing streamed).
     * @param {string} text
     * @param {{parseError?: object}} [meta]
     */
    addAssistantMessage(text, meta = {}) {
      return add(
        el('div', { class: 'msg msg-assistant' }, [
          meta.parseError ? el('div', { class: 'msg-tag msg-tag-warn', text: 'tool call failed to parse' }) : null,
          el('div', { class: 'msg-body', text }),
        ])
      );
    },

    /**
     * A collapsible card for one tool call and its outcome.
     *
     * @param {{args: {method: string, url: string, headers: object, body: string|null}}} call
     * @returns {{settle: Function, deny: Function, node: HTMLElement}}
     */
    addToolCard(call) {
      const { method, url } = call.args;
      const statusEl = el('span', { class: 'tool-status', text: 'sending…' });
      const requestSection = requestBlock(call.args);
      const bodyEl = el('div', { class: 'tool-detail' }, requestSection ? [requestSection] : []);
      const details = el('details', { class: 'tool-details', open: true }, [
        el('summary', {}, [
          el('span', { class: `method method-${method.toLowerCase()}`, text: method }),
          el('span', { class: 'tool-url', text: url }),
          statusEl,
        ]),
        bodyEl,
      ]);
      const node = add(el('div', { class: 'msg msg-tool tool-card' }, [details]));

      return {
        node,
        /**
         * @param {object} result Output of `executeCurl`.
         */
        settle(result) {
          const secrets = result?.request?.secrets || [];
          if (result.ok) {
            const cls = result.status >= 400 ? 'bad' : 'good';
            node.classList.add(`tool-${cls}`);
            statusEl.className = `tool-status tool-status-${cls}`;
            statusEl.textContent = `${result.status} · ${formatMs(result.elapsedMs)}`;
            bodyEl.append(responseBlock(result, secrets));
            // A successful call collapses to its summary line: the detail stays
            // one click away, but a long conversation does not become a wall of
            // response headers. Failures stay open — those you need to read.
            if (cls === 'good') details.open = false;
          } else {
            node.classList.add('tool-error');
            statusEl.className = 'tool-status tool-status-error';
            statusEl.textContent = `failed · ${formatMs(result.elapsedMs)}`;
            bodyEl.append(
              el('div', { class: 'tool-section' }, [
                el('h4', { text: `Error: ${result.error.kind}` }),
                el('p', { class: 'error-explain', text: result.error.message }),
              ])
            );
          }
          autoScroll();
        },
        /** @param {string} [reason] */
        deny(reason) {
          node.classList.add('tool-denied');
          statusEl.className = 'tool-status tool-status-denied';
          statusEl.textContent = 'denied';
          bodyEl.append(
            el('div', { class: 'tool-section' }, [
              el('h4', { text: 'Not sent' }),
              el('p', { text: reason || 'You denied this request. The model was told.' }),
            ])
          );
        },
      };
    },

    /**
     * Show the approve/deny card and resolve with the user's decision.
     *
     * Thumb-friendly on a phone: full-width stacked buttons, and the URL wraps
     * rather than truncating so the host is always visible before approving.
     *
     * @param {{args: object}} call
     * @param {Array<object>} credentials Used to mask values in the preview.
     * @param {{used?: string[], blocked?: string[], missing?: string[]}} [credentialUse]
     *   What `curl.js` will actually do with credentials for this call —
     *   including auto-attached ones the model never wrote and the user would
     *   otherwise have no way to see before approving.
     * @returns {Promise<{approved: boolean, reason?: string, rememberHost?: boolean}>}
     */
    confirm(call, credentials = [], credentialUse = {}) {
      const { method, url, headers, body } = call.args;
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        /* keep the raw string; validation already ran upstream */
      }
      const secrets = credentials.map((c) => c.value).filter(Boolean);

      return new Promise((resolve) => {
        const finish = (decision) => {
          card.remove();
          pendingCard = null;
          resolve(decision);
        };

        const remember = el('input', { type: 'checkbox', id: 'remember-host' });
        const isDelete = method === 'DELETE';

        const card = el('div', { class: `confirm-card${isDelete ? ' confirm-danger' : ''}` }, [
          el('div', { class: 'confirm-head' }, [
            el('span', { class: `method method-${method.toLowerCase()}`, text: method }),
            el('strong', { text: host }),
          ]),
          isDelete ? el('p', { class: 'confirm-warn', text: 'DELETE always asks, even on approved domains.' }) : null,
          el('div', { class: 'confirm-url', text: maskSecrets(url, secrets) }),
          credentialUse.used?.length
            ? el('p', { class: 'confirm-cred', text: `This request will carry your stored credential${credentialUse.used.length === 1 ? '' : 's'}: ${credentialUse.used.join(', ')}. Approve only if you trust ${host} with ${credentialUse.used.length === 1 ? 'it' : 'them'}.` })
            : null,
          credentialUse.blocked?.length
            ? el('p', { class: 'muted', text: `Not sent (scoped to other hosts): ${credentialUse.blocked.join(', ')}.` })
            : null,
          headers && Object.keys(headers).length > 0
            ? disclosure(
                `${Object.keys(headers).length} header(s)`,
                // previewHeaders, not maskHeaders: these are the model's
                // pre-substitution headers, where the value is usually a
                // {{placeholder}}. Masking those would hide exactly what the
                // user needs to see to judge the request.
                kvTable(previewHeaders(headers, secrets)),
                { class: 'confirm-more' }
              )
            : null,
          body ? disclosure('request body', el('pre', { class: 'code', text: prettyJson(maskSecrets(body, secrets)) }), { class: 'confirm-more' }) : null,
          el('label', { class: 'confirm-remember' }, [
            remember,
            el('span', { text: ` Auto-approve ${host} for the rest of this session` }),
          ]),
          el('div', { class: 'confirm-actions' }, [
            el('button', {
              class: 'btn btn-approve',
              type: 'button',
              onclick: () => finish({ approved: true, rememberHost: remember.checked }),
            }, 'Approve'),
            el('button', {
              class: 'btn btn-deny',
              type: 'button',
              onclick: () => finish({ approved: false, reason: 'The user denied the request at the confirmation prompt.' }),
            }, 'Deny'),
          ]),
        ]);

        pendingCard = { card, finish };
        add(card);
        card.querySelector('.btn-approve')?.focus();
      });
    },

    /** Force-close an open confirmation card (used when a turn is cancelled). */
    dismissConfirm() {
      pendingCard?.finish({ approved: false, reason: 'Cancelled.' });
    },

    /**
     * @param {{kind: string, text: string}} notice
     */
    addNotice(notice) {
      return add(el('div', { class: `notice notice-${notice.kind}`, role: 'status' }, [
        el('span', { text: notice.text }),
      ]));
    },
  };
}

/**
 * The request half of a tool card, or null when there is nothing to say — an
 * empty "Request: none" block is noise on every plain GET.
 *
 * @param {object} args
 * @returns {HTMLElement|null}
 */
function requestBlock(args) {
  const headers = args.headers || {};
  if (Object.keys(headers).length === 0 && !args.body) return null;
  const rows = [el('h4', { text: 'Request' })];
  if (Object.keys(headers).length > 0) rows.push(kvTable(previewHeaders(headers)));
  if (args.body) rows.push(el('pre', { class: 'code', text: prettyJson(args.body) }));
  return el('div', { class: 'tool-section' }, rows);
}

/**
 * Headers worth showing without being asked. CORS and transport headers are
 * present on every response and tell the reader nothing.
 */
const NOTABLE_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'location', 'retry-after', 'etag', 'last-modified',
  'cache-control', 'x-ratelimit-remaining', 'x-ratelimit-limit', 'server',
];

/**
 * @param {object} result
 * @param {string[]} secrets
 */
function responseBlock(result, secrets) {
  const rows = [
    el('h4', { text: `Response — HTTP ${result.status} ${result.statusText}`.trim() }),
  ];
  if (result.redirected) {
    rows.push(el('p', { class: 'muted', text: `redirected to ${maskSecrets(result.finalUrl, secrets)}` }));
  }

  const all = maskHeaders(result.headers || {}, secrets);
  const notable = Object.fromEntries(
    Object.entries(all).filter(([k]) => NOTABLE_RESPONSE_HEADERS.includes(k.toLowerCase()))
  );
  const rest = Object.keys(all).length - Object.keys(notable).length;
  rows.push(kvTable(notable));
  if (rest > 0) {
    rows.push(disclosure(`${rest} more header${rest === 1 ? '' : 's'}`, kvTable(all), { class: 'confirm-more' }));
  }

  rows.push(el('pre', { class: 'code', text: prettyJson(maskSecrets(result.body || '', secrets)) }));
  if (result.truncated) {
    rows.push(el('p', { class: 'muted', text: `Truncated at ${result.maxBytes} bytes.` }));
  }
  return el('div', { class: 'tool-section' }, rows);
}

/**
 * Render a string map as a two-column table. Values are set as text, never
 * parsed — a response header is untrusted input.
 *
 * @param {Object<string,string>} map
 * @returns {HTMLElement}
 */
export function kvTable(map) {
  const entries = Object.entries(map || {});
  if (entries.length === 0) return el('p', { class: 'muted', text: 'none' });
  return el(
    'table',
    { class: 'kv' },
    entries.map(([k, v]) =>
      el('tr', {}, [
        el('th', { text: k }),
        el('td', { class: v === MASK ? 'masked' : '', text: v }),
      ])
    )
  );
}
