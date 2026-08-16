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

import { MASK, isMixedContent, maskHeaders, maskSecrets, previewHeaders } from '../tools/curl.js';
import { visibleStreamText } from '../agent/stream-filter.js';
import { clear, disclosure, el, formatMs, prettyJson } from './dom.js';

/**
 * How long Approve stays disabled after a confirmation card appears.
 *
 * Long enough to defeat a key repeat or the reflex second Enter that follows
 * pressing Enter to send; short enough that a deliberate click is never
 * frustrated.
 */
export const ARM_DELAY_MS = 600;

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
     * Append an already-built element — the loading card, which owns its own
     * lifecycle and updates in place rather than being re-rendered.
     * @param {Node} node
     */
    addNode(node) {
      return add(node);
    },

    /** Keep the newest content in view after something else resized the card. */
    scrollToEnd() {
      autoScroll();
    },

    /**
     * @param {string} text
     */
    addUserMessage(text) {
      return add(el('div', { class: 'msg msg-user' }, [el('div', { class: 'msg-body', text })]));
    },

    /**
     * A step of a split multi-step ask (agent/split.js). Rendered as the
     * agent narrating its way through the user's plan, not as a user bubble —
     * the user did not type this line on its own.
     *
     * @param {string} text The step being started.
     * @param {number} n 1-based step number.
     * @param {number} total Steps in the plan.
     */
    addStepMessage(text, n, total) {
      return add(el('div', { class: 'msg msg-step' }, [
        el('div', { class: 'msg-tag', text: `step ${n} of ${total}` }),
        el('div', { class: 'msg-body', text }),
      ]));
    },

    /**
     * Begin (or restart) the streaming assistant bubble.
     * @param {{repair?: boolean}} [opts]
     */
    beginStream(opts = {}) {
      // Settle any bubble still open. A repair round starts a second
      // generation, and without this the first one is left on screen forever
      // with a live blinking caret implying it is still being written.
      this.settleStream();
      streamBuffer = '';
      streaming = el('div', { class: `msg msg-assistant${opts.repair ? ' msg-repair' : ''}` }, [
        opts.repair ? el('div', { class: 'msg-tag', text: 'correcting its tool call…' }) : null,
        el('div', { class: 'msg-body' }),
        el('span', { class: 'caret', 'aria-hidden': 'true' }),
      ]);
      return add(streaming);
    },

    /**
     * Append a streamed chunk and re-render the bubble.
     *
     * The bubble shows `visibleStreamText(buffer)`, not the raw buffer: raw
     * streaming put `<think>` blocks and tool-call JSON on screen (seen in a
     * real user's screenshot) — content the committed message never contains.
     * While everything so far is held back, the bubble says it is thinking
     * rather than sitting empty behind a caret.
     *
     * @param {string} delta
     */
    pushDelta(delta) {
      if (!streaming) this.beginStream();
      streamBuffer += delta;
      const visible = visibleStreamText(streamBuffer);
      streaming.querySelector('.msg-body').textContent = visible;
      streaming.classList.toggle('msg-thinking', visible === '');
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
     * Close off an open bubble without replacing its text.
     *
     * Called when a turn ends for any reason — cancellation, an engine error,
     * a repair round starting. Whatever the model managed to say stays on
     * screen and stops pretending to still be arriving; an empty bubble is
     * removed rather than left as a stray caret.
     *
     * Crucially this makes the bubble *permanent*, so the next user message no
     * longer retroactively deletes a partial answer from the history.
     */
    settleStream() {
      if (!streaming) return;
      streaming.querySelector('.caret')?.remove();
      streaming.classList.remove('msg-thinking');
      // Judged on what was *displayed*, not what arrived: a stream that was
      // nothing but a suppressed <think> block leaves an empty bubble, and an
      // empty bubble marked "interrupted" is a shrug rendered in HTML.
      if (visibleStreamText(streamBuffer) === '') streaming.remove();
      else streaming.classList.add('msg-interrupted');
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
      streaming.classList.remove('msg-repair', 'msg-thinking');
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
          pendingCard?.cleanup?.();
          card.remove();
          pendingCard = null;
          resolve(decision);
        };

        const remember = el('input', { type: 'checkbox', id: 'remember-host' });
        const isDelete = method === 'DELETE';

        const approve = el('button', {
          class: 'btn btn-approve',
          type: 'button',
          // Armed after a short delay: the card appears a moment after the
          // user pressed Enter to send, so an ordinary second Enter — or a key
          // repeat — would otherwise land on Approve and dispatch a request
          // nobody looked at.
          disabled: true,
          onclick: () => finish({ approved: true, rememberHost: remember.checked }),
        }, 'Approve');

        const deny = el('button', {
          class: 'btn btn-deny',
          type: 'button',
          onclick: () => finish({ approved: false, reason: 'The user denied the request at the confirmation prompt.' }),
        }, 'Deny');

        const card = el('div', { class: `confirm-card${isDelete ? ' confirm-danger' : ''}` }, [
          el('div', { class: 'confirm-head' }, [
            el('span', { class: `method method-${method.toLowerCase()}`, text: method }),
            hostDisplay(host),
          ]),
          isDelete ? el('p', { class: 'confirm-warn', text: 'DELETE always asks, even on approved domains.' }) : null,
          el('div', { class: 'confirm-url', text: maskSecrets(url, secrets) }),
          // The wiki tool resolves a search term to a title and then fetches
          // that article, so approving this card sends two requests, not one.
          // A card that showed only the first would understate what the user is
          // agreeing to — the one thing the confirmation step cannot do.
          call.tool === 'wiki'
            ? el('p', {
                class: 'confirm-cred',
                text:
                  `Wikipedia lookup for “${call.args.query}”. Approving sends up to two requests to ${host}: ` +
                  'this search, and then the article it matches.',
              })
            : null,
          credentialUse.used?.length
            ? el('p', { class: 'confirm-cred', text: `This request will carry your stored credential${credentialUse.used.length === 1 ? '' : 's'}: ${credentialUse.used.join(', ')}. Approve only if you trust ${host} with ${credentialUse.used.length === 1 ? 'it' : 'them'}.` })
            : null,
          // A proxy sees the full target URL and every header, credentials
          // included. A card naming only the target host would be asserting
          // the opposite of where the data actually goes.
          credentialUse.proxyHost
            ? el('p', { class: 'confirm-cred', text: `Sent via your configured proxy ${credentialUse.proxyHost}, not directly to ${host}. That proxy sees the full URL and every header${credentialUse.used?.length ? ', including the credentials above' : ''}.` })
            : null,
          // Knowable before dispatch, so say so here rather than letting the
          // user approve something the browser will refuse to send.
          isMixedContent(url) && !credentialUse.proxyHost
            ? el('p', { class: 'confirm-warn', text: 'This will be blocked: a page served over HTTPS cannot make plain http:// requests. Approving it will produce an error, not a response.' })
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
          el('div', { class: 'confirm-actions' }, [approve, deny]),
        ]);

        pendingCard = { card, finish };
        add(card);

        // Deny takes focus, not Approve. Whatever a stray keystroke does, it
        // must be the reversible thing.
        deny.focus();
        const armTimer = setTimeout(() => {
          approve.disabled = false;
        }, ARM_DELAY_MS);
        pendingCard.cleanup = () => clearTimeout(armTimer);
      });
    },

    /** Force-close an open confirmation card (used when a turn is cancelled). */
    dismissConfirm() {
      pendingCard?.finish({ approved: false, reason: 'Cancelled.' });
    },

    /**
     * Deny an open confirmation card exactly as the Deny button would.
     * Bound to Escape: the refusal is the reversible outcome, so it is the
     * one a dismissive keystroke may safely mean.
     */
    denyConfirm() {
      pendingCard?.finish({
        approved: false,
        reason: 'The user denied the request at the confirmation prompt.',
      });
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
 * Render a hostname with its tail emphasised.
 *
 * The meaningful part of a host is its *end*. A long deceptive prefix —
 * `api.github.com…….evil.example` — reads as trustworthy left-to-right, and
 * left-to-right is how people read. Muting everything but the last few labels
 * pulls the eye to where the truth is.
 *
 * This is a visual aid, not a security boundary: the full host is always
 * rendered in full, and "last three labels" is an approximation of the
 * registrable domain, not a public-suffix lookup.
 *
 * @param {string} host
 * @returns {HTMLElement}
 */
export function hostDisplay(host) {
  const { head, tail } = splitHostForDisplay(host);
  if (head === '') return el('strong', { class: 'confirm-host', text: tail });
  return el('strong', { class: 'confirm-host' }, [
    el('span', { class: 'host-prefix', text: `${head}.` }),
    el('span', { class: 'host-tail', text: tail }),
  ]);
}

/**
 * Split a hostname into a de-emphasised prefix and the tail worth reading.
 *
 * Pure, so the rule is testable without a DOM. `head` is empty when the host is
 * short enough to read whole. Concatenating `head`, `'.'` and `tail` always
 * reproduces the input exactly — nothing is ever dropped.
 *
 * @param {string} host
 * @returns {{head: string, tail: string}}
 */
export function splitHostForDisplay(host) {
  const s = String(host);
  // An IP address has no registrable domain, so "the last three labels" is
  // meaningless for one — de-emphasising the first octet of 127.0.0.1 only
  // makes the address harder to read. Render it whole.
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(s) || s.startsWith('[')) {
    return { head: '', tail: s };
  }
  const labels = s.split('.');
  if (labels.length <= 3) return { head: '', tail: s };
  return { head: labels.slice(0, -3).join('.'), tail: labels.slice(-3).join('.') };
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
