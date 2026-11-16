/**
 * Settings sheet (SPEC §8.2).
 *
 * Fields are wired straight to the settings store, which clamps and sanitises;
 * this layer never validates numbers itself, so there is exactly one place
 * where "what counts as a valid timeout" is decided.
 *
 * @module ui/settings
 */

import { MASK } from '../tools/curl.js';
import { EXTRA_MODELS, MODEL_TIERS } from '../llm/webllm.js';
import { formatSize } from '../llm/format.js';
import { clear, el, formatBytes } from './dom.js';

/**
 * @param {HTMLElement} root
 * @param {object} deps
 * @param {object} deps.settings Settings store.
 * @param {(modelId: string) => Promise<void>} deps.onLoadModel
 * @param {(id: string) => Promise<boolean>} [deps.isCached]
 * @param {(id: string) => Promise<boolean>} [deps.onDeleteModel] Remove a
 *   model's downloaded weights.
 * @param {object} [deps.caps] Capability probe result, for context lines.
 * @param {object} [deps.chats] Chat store (`state/chats.js`).
 * @param {() => string} [deps.getCurrentChatId]
 * @param {() => void} [deps.onNewChat]
 * @param {(id: string) => void} [deps.onOpenChat]
 * @param {(id: string) => void} [deps.onDeleteChat]
 * @param {() => void} [deps.onDeleteAllChats]
 * @returns {{render: Function, setModelState: Function, refreshCache: Function}}
 */
export function createSettingsSheet(root, deps) {
  const {
    settings, onLoadModel, isCached, onDeleteModel, caps,
    chats, getCurrentChatId, onNewChat, onOpenChat, onDeleteChat, onDeleteAllChats,
  } = deps;
  /** @type {Set<string>} Credential ids currently revealed. */
  const revealed = new Set();
  /** @type {Map<string, boolean>} Model id -> cached. */
  const cacheStatus = new Map();

  /**
   * What the engine is doing, as reported by `main.js`. Only one model is
   * ever on the GPU: loading another unloads it first, so "active" and
   * "loading" are never both set.
   */
  const modelState = { activeId: null, loadingId: null, failedId: null };

  /** Text typed into the advanced model-id field but not yet loaded. */
  let customDraft = '';

  /**
   * Text typed into the "add a credential" form but not yet submitted.
   *
   * The sheet re-renders on every settings change — including ones triggered
   * from elsewhere, like the async model cache probe — and a full rebuild would
   * otherwise wipe a half-entered API token the moment anything else changed.
   */
  const draft = { name: '', value: '', headerName: '', hosts: '', sessionOnly: false };

  const set = (patch) => settings.set(patch);

  /**
   * Re-render, preserving what the user was in the middle of doing: scroll
   * position, which control had focus, and the caret within it.
   */
  function render() {
    const scrollTop = root.scrollTop;
    const activeKey = document.activeElement?.dataset?.settingsKey || null;
    const selection = activeKey && typeof document.activeElement.selectionStart === 'number'
      ? [document.activeElement.selectionStart, document.activeElement.selectionEnd]
      : null;

    renderInner();

    root.scrollTop = scrollTop;
    if (activeKey) {
      const restored = root.querySelector(`[data-settings-key="${CSS.escape(activeKey)}"]`);
      if (restored) {
        restored.focus();
        if (selection && typeof restored.setSelectionRange === 'function') {
          try {
            restored.setSelectionRange(selection[0], selection[1]);
          } catch {
            /* input types that reject setSelectionRange (number, checkbox) */
          }
        }
      }
    }
  }

  function renderInner() {
    const s = settings.get();
    clear(root);

    root.append(...[
      section('Model', [
        modelList(s),
        customModelField(),
        toggle('Thinking mode', s.thinking, (v) => set({ thinking: v }),
          'Qwen3 can reason before answering. It roughly triples the latency of every tool round-trip, so it is off by default.'),
      ]),

      chats ? chatsSection() : null,

      section('Generation', [
        number('Temperature', s.temperature, 0, 2, 0.05, (v) => set({ temperature: v })),
        number('Max tokens per reply', s.maxTokens, 64, 8192, 64, (v) => set({ maxTokens: v })),
        number('Max tool calls per message', s.maxIterations, 1, 10, 1, (v) => set({ maxIterations: v }),
          'Hard-capped at 10 regardless of what you type.'),
      ]),

      section('Requests', [
        number('Timeout (seconds)', Math.round(s.timeoutMs / 1000), 1, 300, 1, (v) => set({ timeoutMs: v * 1000 })),
        number(`Response size limit (bytes) — currently ${formatBytes(s.maxBytes)}`, s.maxBytes, 256, 1024 * 1024, 256,
          (v) => set({ maxBytes: v }),
          'Longer responses are cut here and the model is told they were truncated.'),
        field('CORS proxy URL template', el('input', {
          type: 'text',
          class: 'input',
          value: s.proxyTemplate,
          placeholder: 'https://your-proxy.example/?url={url}',
          onchange: (e) => set({ proxyTemplate: e.target.value.trim() }),
        }), 'Off by default. {url} is replaced with the percent-encoded target. A template without {url} is treated as a prefix. Nothing is bundled — you supply the proxy.'),
      ]),

      section('Security', [
        toggle('Confirm before sending', s.confirmBeforeSend, (v) => set({ confirmBeforeSend: v }),
          'Every request shows an approve/deny card first. Two things always ask even with this off: DELETE, and any request that would carry one of your stored credentials.'),
        allowlistEditor(s),
        credentialsEditor(s),
      ]),

      section('Reset', [
        el('p', { class: 'muted', text: s.storageWorking ? 'Settings are saved in this browser’s localStorage.' : 'Settings could not be saved — they apply for this session only.' }),
        el('button', {
          class: 'btn btn-danger',
          type: 'button',
          onclick: () => {
            if (globalThis.confirm('Reset all settings and delete every stored credential?')) settings.reset();
          },
        }, 'Reset everything'),
      ]),
    ].filter(Boolean));
  }

  /**
   * Every model worth listing: the known tiers, then any custom id that is
   * selected, loaded or loading — so a model pinned through the advanced
   * field is visible and switchable like the rest.
   *
   * @param {object} s
   * @returns {Array<{id: string, label: string, approxDownload: string, downloadBytes?: number, note?: string, custom?: boolean}>}
   */
  function modelsToList(s) {
    const known = [...MODEL_TIERS, ...EXTRA_MODELS];
    const extra = [s.modelId, modelState.activeId, modelState.loadingId, modelState.failedId]
      .filter((id) => id && !isKnownModel(id));
    return [
      ...known,
      ...[...new Set(extra)].map((id) => ({ id, label: id, approxDownload: 'size unknown', custom: true })),
    ];
  }

  /** @param {object} s */
  function modelList(s) {
    const models = modelsToList(s);
    const downloaded = models.filter((m) => cacheStatus.get(m.id) === true);
    const knownBytes = downloaded.reduce((sum, m) => sum + (m.downloadBytes || 0), 0);
    const active = models.find((m) => m.id === modelState.activeId);
    const loading = models.find((m) => m.id === modelState.loadingId);

    const summary = [
      active ? `In use: ${active.label}.` : loading ? `Loading ${loading.label}…` : 'No model is loaded.',
      isCached
        ? `${downloaded.length} downloaded${knownBytes > 0 ? `, about ${formatSize(knownBytes)}` : ''}.`
        : null,
    ].filter(Boolean).join(' ');

    return group('Models', el('div', { class: 'stack' }, [
      el('p', { class: 'model-summary', text: summary }),
      el('ul', { class: 'model-list' }, models.map((m) => modelRow(m))),
    ]), [
      'One model is in memory at a time: switching unloads the current one. A downloaded model loads in seconds; any other downloads first, once.',
      caps?.lowMemory ? 'This device looks memory-constrained; prefer the small or tiny tier.' : null,
    ].filter(Boolean).join(' '));
  }

  /** @param {{id: string, label: string, approxDownload: string, note?: string, custom?: boolean}} m */
  function modelRow(m) {
    const isActive = modelState.activeId === m.id;
    const isLoading = modelState.loadingId === m.id;
    const isFailed = modelState.failedId === m.id;
    const cached = cacheStatus.get(m.id);

    /** @type {[string, string]|null} Badge text and modifier class. */
    let status = null;
    if (isLoading) status = ['Loading…', 'loading'];
    else if (isActive) status = ['In use', 'active'];
    else if (isFailed) status = ['Failed to load', 'failed'];
    else if (cached === true) status = ['Downloaded', 'cached'];
    else if (cached === false) status = ['Not downloaded', 'remote'];

    const actions = [];
    if (isActive) {
      actions.push(el('button', {
        class: 'btn btn-small',
        type: 'button',
        'aria-label': `Reload ${m.label}`,
        onclick: () => onLoadModel(m.id),
      }, 'Reload'));
    } else if (!isLoading) {
      actions.push(el('button', {
        class: 'btn btn-small btn-switch',
        type: 'button',
        'aria-label': `${cached === true ? 'Switch to' : 'Download and switch to'} ${m.label}`,
        onclick: () => {
          set({ modelId: m.id });
          onLoadModel(m.id);
        },
      }, cached === true ? 'Switch' : 'Download'));
      if (cached === true && onDeleteModel) {
        actions.push(el('button', {
          class: 'btn btn-small btn-danger',
          type: 'button',
          'aria-label': `Delete the download of ${m.label}`,
          onclick: () => deleteModel(m),
        }, 'Delete'));
      }
    }

    return el('li', {
      class: `model-row${isActive ? ' model-row-active' : ''}`,
      dataset: { modelId: m.id },
    }, [
      el('div', { class: 'model-row-main' }, [
        el('span', { class: 'model-name', text: m.label }),
        el('span', { class: 'model-meta' }, [
          m.custom ? null : el('span', { text: m.approxDownload }),
          status ? el('span', { class: `badge model-badge model-badge-${status[1]}`, text: status[0] }) : null,
        ]),
        (isActive || isLoading) && m.note ? el('span', { class: 'field-hint', text: m.note }) : null,
      ]),
      actions.length ? el('div', { class: 'model-row-actions' }, actions) : null,
    ]);
  }

  /** @param {{id: string, label: string, approxDownload: string}} m */
  async function deleteModel(m) {
    const size = m.approxDownload && m.approxDownload !== 'size unknown' ? ` (${m.approxDownload})` : '';
    if (!globalThis.confirm(`Delete the downloaded copy of ${m.label}? Using it again means downloading it again${size}.`)) return;
    try {
      await onDeleteModel(m.id);
    } finally {
      await refreshCache([m.id]);
    }
  }

  /** The advanced field: any id from WebLLM's catalog, loaded on demand. */
  function customModelField() {
    const input = el('input', {
      type: 'text',
      class: 'input',
      value: customDraft,
      placeholder: 'e.g. Llama-3.2-1B-Instruct-q4f16_1-MLC',
      dataset: { settingsKey: 'custom-model' },
      oninput: (e) => { customDraft = e.target.value; },
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          loadCustom();
        }
      },
    });
    const loadCustom = () => {
      const id = customDraft.trim();
      if (!id) return;
      customDraft = '';
      set({ modelId: id });
      onLoadModel(id);
    };
    return group('Advanced: load any WebLLM model id', el('div', { class: 'row' }, [
      input,
      el('button', { class: 'btn btn-small', type: 'button', onclick: loadCustom }, 'Load'),
    ]), 'Any id from WebLLM’s prebuilt catalog. Unknown ids fail at load time with the error shown in the chat.');
  }

  function chatsSection() {
    const saved = chats.list();
    const currentId = getCurrentChatId?.() ?? null;

    const rows = saved.map((c) => {
      const isCurrent = c.id === currentId;
      return el('li', { class: `chat-row${isCurrent ? ' chat-row-current' : ''}`, dataset: { chatId: c.id } }, [
        el('div', { class: 'chat-row-main' }, [
          el('span', { class: 'chat-title', text: c.title }),
          el('span', { class: 'chat-meta' }, [
            el('span', { text: [
              formatWhen(c.updatedAt),
              `${c.messageCount} message${c.messageCount === 1 ? '' : 's'}`,
              shortModelName(c.modelId),
            ].filter(Boolean).join(' · ') }),
            isCurrent ? el('span', { class: 'badge', text: 'open now' }) : null,
          ]),
        ]),
        el('div', { class: 'chat-row-actions' }, [
          isCurrent ? null : el('button', {
            class: 'btn btn-small',
            type: 'button',
            'aria-label': `Open chat: ${c.title}`,
            onclick: () => onOpenChat?.(c.id),
          }, 'Open'),
          el('button', {
            class: 'btn btn-small btn-danger',
            type: 'button',
            'aria-label': `Delete chat: ${c.title}`,
            onclick: () => {
              const what = isCurrent ? 'Delete this chat? It is the one on screen, so the screen clears too.' : `Delete the chat “${c.title}”?`;
              if (globalThis.confirm(what)) onDeleteChat?.(c.id);
            },
          }, 'Delete'),
        ]),
      ]);
    });

    return section('Chats', [
      el('div', { class: 'row' }, [
        el('button', { class: 'btn', type: 'button', onclick: () => onNewChat?.() }, 'New chat'),
        saved.length > 0
          ? el('button', {
            class: 'btn btn-danger',
            type: 'button',
            onclick: () => {
              if (globalThis.confirm(`Delete all ${saved.length} saved chat${saved.length === 1 ? '' : 's'}? This cannot be undone.`)) onDeleteAllChats?.();
            },
          }, 'Delete all chats')
          : null,
      ]),
      saved.length
        ? el('ul', { class: 'chat-list' }, rows)
        : el('p', { class: 'muted', text: 'No saved chats yet. Each chat is saved after every reply.' }),
      el('p', {
        class: 'field-hint',
        text: chats.storageWorking()
          ? 'Saved in this browser’s localStorage after every reply, newest 50 kept. Request and response details are saved too, with your credential values masked.'
          : 'Chats could not be saved in this browser — they last until the tab closes.',
      }),
    ]);
  }

  /**
   * Re-check which models are downloaded. After a load (a new download) or a
   * deletion, the cached state of those models has changed.
   *
   * @param {string[]} [ids] Only these; every listed model when omitted.
   */
  async function refreshCache(ids) {
    if (!isCached) return;
    const targets = ids ?? modelsToList(settings.get()).map((m) => m.id);
    await Promise.all(targets.map(async (id) => {
      cacheStatus.set(id, await isCached(id).catch(() => false));
    }));
    render();
  }

  /** @param {object} s */
  function allowlistEditor(s) {
    const input = el('input', {
      type: 'text',
      class: 'input',
      placeholder: 'api.example.com',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addHost();
        }
      },
    });
    const addHost = () => {
      const v = input.value.trim().toLowerCase();
      if (!v) return;
      set({ allowlist: [...s.allowlist, v] });
    };

    return group('Domain allowlist', el('div', { class: 'stack' }, [
      s.allowlist.length === 0
        ? el('p', { class: 'muted', text: 'Empty — every domain is allowed.' })
        : el('ul', { class: 'chips' }, s.allowlist.map((h) =>
            el('li', { class: 'chip' }, [
              el('span', { text: h }),
              el('button', {
                class: 'chip-x', type: 'button', 'aria-label': `Remove ${h}`,
                onclick: () => set({ allowlist: s.allowlist.filter((x) => x !== h) }),
              }, '×'),
            ])
          )),
      el('div', { class: 'row' }, [input, el('button', { class: 'btn btn-small', type: 'button', onclick: addHost }, 'Add')]),
    ]), 'When non-empty, requests to any other host are refused before being sent. A bare domain also matches its sub-domains; use *.example.com for sub-domains only.');
  }

  /** @param {object} s */
  function credentialsEditor(s) {
    const rows = s.credentials.map((c) => {
      const isRevealed = revealed.has(c.id);
      return el('div', { class: 'cred' }, [
        el('div', { class: 'cred-head' }, [
          el('strong', { text: c.name }),
          el('code', { class: 'cred-ph', text: `{{${c.name}}}` }),
          c.sessionOnly ? el('span', { class: 'badge', text: 'session only' }) : null,
        ]),
        c.headerName
          ? el('p', { class: 'muted', text: `auto-attached as ${c.headerName}${c.hosts.length ? ` on ${c.hosts.join(', ')}` : ' (no hosts set — never attached)'}` })
          : el('p', { class: 'muted', text: 'reference it in a header value as the placeholder above' }),
        el('div', { class: 'row' }, [
          el('code', { class: 'cred-value', text: isRevealed ? c.value : MASK }),
          el('button', {
            class: 'btn btn-small', type: 'button',
            onclick: () => {
              if (isRevealed) revealed.delete(c.id);
              else revealed.add(c.id);
              render();
            },
          }, isRevealed ? 'Hide' : 'Reveal'),
          el('button', {
            class: 'btn btn-small btn-danger', type: 'button',
            onclick: () => { revealed.delete(c.id); settings.removeCredential(c.id); },
          }, 'Delete'),
        ]),
      ]);
    });

    const draftField = (key, attrs) => el('input', {
      ...attrs,
      class: 'input',
      value: draft[key],
      dataset: { settingsKey: `cred-${key}` },
      oninput: (e) => { draft[key] = e.target.value; },
    });

    const name = draftField('name', { type: 'text', placeholder: 'Name (e.g. GitHub)' });
    const value = draftField('value', { type: 'password', placeholder: 'Secret value' });
    const header = draftField('headerName', { type: 'text', placeholder: 'Auto-attach header (optional)' });
    const hosts = draftField('hosts', { type: 'text', placeholder: 'Auto-attach hosts, comma-separated (optional)' });
    const sessionOnly = el('input', {
      type: 'checkbox',
      checked: draft.sessionOnly,
      dataset: { settingsKey: 'cred-sessionOnly' },
      onchange: (e) => { draft.sessionOnly = e.target.checked; },
    });

    const add = () => {
      const created = settings.addCredential({
        name: draft.name,
        value: draft.value,
        headerName: draft.headerName,
        hosts: draft.hosts.split(',').map((h) => h.trim()).filter(Boolean),
        sessionOnly: draft.sessionOnly,
      });
      if (!created) {
        globalThis.alert('A credential needs a name.');
        return;
      }
      // Only clear the draft once the credential is safely stored.
      Object.assign(draft, { name: '', value: '', headerName: '', hosts: '', sessionOnly: false });
      render();
    };

    return group('Credentials', el('div', { class: 'stack' }, [
      el('p', { class: 'warn-box', text: 'Stored credentials are kept in this browser’s localStorage in plain text. Anyone with access to this browser profile can read them. Use “session only” for anything sensitive — those are held in memory and disappear when you close the tab.' }),
      rows.length ? el('div', { class: 'stack' }, rows) : el('p', { class: 'muted', text: 'No credentials stored.' }),
      el('div', { class: 'stack cred-new' }, [
        name, value, header, hosts,
        el('label', { class: 'row' }, [sessionOnly, el('span', { text: ' Session only (never written to disk)' })]),
        el('button', { class: 'btn', type: 'button', onclick: add }, 'Add credential'),
      ]),
    ]), 'The model never sees a secret: it writes the placeholder and the browser substitutes the value just before sending.');
  }

  settings.subscribe(render);
  chats?.subscribe(render);
  render();

  // Cache status is async; fill it in and re-render once known.
  refreshCache().catch(() => {});

  return {
    render,

    /**
     * Report what the engine is doing.
     * @param {{activeId?: string|null, loadingId?: string|null, failedId?: string|null}} patch
     */
    setModelState(patch) {
      Object.assign(modelState, patch);
      render();
    },

    refreshCache,
  };
}

/**
 * When a chat was last touched, briefly: a time for today, a date otherwise.
 * @param {number} ts
 * @param {number} [now]
 * @returns {string}
 */
export function formatWhen(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  try {
    return sameDay
      ? `Today ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
      : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * A model's name without its tier note — "Qwen3 1.7B" for the small tier — or
 * the raw id for one typed into the advanced field.
 * @param {string|null} id
 * @returns {string|null}
 */
export function shortModelName(id) {
  if (!id) return null;
  const known = [...MODEL_TIERS, ...EXTRA_MODELS].find((m) => m.id === id);
  return known ? known.label.replace(/\s*\(.*\)\s*$/, '') : id;
}

/** @param {string} id */
function isKnownModel(id) {
  return [...MODEL_TIERS, ...EXTRA_MODELS].some((m) => m.id === id);
}

function section(title, children) {
  return el('section', { class: 'settings-section' }, [el('h3', { text: title }), ...children]);
}

/**
 * A labelled single control.
 *
 * `<label>` is correct only when it wraps exactly one form control. Wrapping a
 * composite group in one gives the group's *first* control an accessible name
 * made of the entire label text — a "Reveal" button announced as three
 * paragraphs of credential warning. Use `group()` for anything with more than
 * one control in it.
 */
function field(label, control, hint) {
  if (control && !control.dataset?.settingsKey) {
    control.dataset.settingsKey = `field-${label.slice(0, 40)}`;
  }
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: label }),
    control,
    hint ? el('span', { class: 'field-hint', text: hint }) : null,
  ]);
}

/**
 * A labelled cluster of several controls. Not a `<label>`; the caption is
 * associated with the group via `aria-labelledby` instead.
 */
let groupSeq = 0;
function group(label, content, hint) {
  groupSeq += 1;
  const id = `group-label-${groupSeq}`;
  return el('div', { class: 'field', role: 'group', 'aria-labelledby': id }, [
    el('span', { class: 'field-label', id, text: label }),
    content,
    hint ? el('span', { class: 'field-hint', text: hint }) : null,
  ]);
}

function toggle(label, checked, onChange, hint) {
  return el('label', { class: 'field field-toggle' }, [
    el('span', { class: 'field-label' }, [
      el('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }),
      el('span', { text: ` ${label}` }),
    ]),
    hint ? el('span', { class: 'field-hint', text: hint }) : null,
  ]);
}

function number(label, value, min, max, step, onChange, hint) {
  return field(label, el('input', {
    type: 'number', class: 'input', value, min, max, step,
    onchange: (e) => {
      const n = Number(e.target.value);
      if (Number.isFinite(n)) onChange(n);
    },
  }), hint);
}
