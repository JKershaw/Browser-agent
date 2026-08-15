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
import { clear, el, formatBytes } from './dom.js';

/**
 * @param {HTMLElement} root
 * @param {object} deps
 * @param {object} deps.settings Settings store.
 * @param {(modelId: string) => Promise<void>} deps.onLoadModel
 * @param {(id: string) => Promise<boolean>} [deps.isCached]
 * @param {object} [deps.caps] Capability probe result, for context lines.
 * @returns {{render: Function}}
 */
export function createSettingsSheet(root, deps) {
  const { settings, onLoadModel, isCached, caps } = deps;
  /** @type {Set<string>} Credential ids currently revealed. */
  const revealed = new Set();
  /** @type {Map<string, boolean>} Model id -> cached. */
  const cacheStatus = new Map();

  const set = (patch) => settings.set(patch);

  function render() {
    const s = settings.get();
    clear(root);

    root.append(
      section('Model', [
        modelPicker(s),
        field('Advanced: pin any WebLLM model id', el('input', {
          type: 'text',
          class: 'input',
          value: isKnownModel(s.modelId) ? '' : s.modelId,
          placeholder: 'e.g. Llama-3.2-1B-Instruct-q4f16_1-MLC',
          onchange: (e) => {
            const v = e.target.value.trim();
            if (v) set({ modelId: v });
          },
        }), 'Any id from WebLLM’s prebuilt catalog. Unknown ids fail at load time with the error shown in the chat.'),
        el('button', {
          class: 'btn',
          type: 'button',
          onclick: () => onLoadModel(settings.get().modelId),
        }, 'Load / reload model'),
        toggle('Thinking mode', s.thinking, (v) => set({ thinking: v }),
          'Qwen3 can reason before answering. It roughly triples the latency of every tool round-trip, so it is off by default.'),
      ]),

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
      ])
    );
  }

  /** @param {object} s */
  function modelPicker(s) {
    const options = [...MODEL_TIERS, ...EXTRA_MODELS];
    const select = el('select', {
      class: 'input',
      onchange: (e) => set({ modelId: e.target.value }),
    }, options.map((m) => el('option', {
      value: m.id,
      selected: m.id === s.modelId,
      text: `${m.label} — ${m.approxDownload}${cacheStatus.get(m.id) ? ' · cached' : ''}`,
    })));

    const active = options.find((m) => m.id === s.modelId);
    const hint = cacheStatus.get(s.modelId)
      ? 'Cached in this browser — loads in seconds.'
      : 'Not cached yet — the weights download on first load and are then reused.';

    return field('Model', select, [
      active?.note,
      hint,
      caps?.lowMemory ? 'This device looks memory-constrained; prefer the small or tiny tier.' : null,
    ].filter(Boolean).join(' '));
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

    const name = el('input', { type: 'text', class: 'input', placeholder: 'Name (e.g. GitHub)' });
    const value = el('input', { type: 'password', class: 'input', placeholder: 'Secret value' });
    const header = el('input', { type: 'text', class: 'input', placeholder: 'Auto-attach header (optional)' });
    const hosts = el('input', { type: 'text', class: 'input', placeholder: 'Auto-attach hosts, comma-separated (optional)' });
    const sessionOnly = el('input', { type: 'checkbox' });

    const add = () => {
      const created = settings.addCredential({
        name: name.value,
        value: value.value,
        headerName: header.value,
        hosts: hosts.value.split(',').map((h) => h.trim()).filter(Boolean),
        sessionOnly: sessionOnly.checked,
      });
      if (!created) {
        globalThis.alert('A credential needs a name.');
        return;
      }
      name.value = ''; value.value = ''; header.value = ''; hosts.value = ''; sessionOnly.checked = false;
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
  render();

  // Cache status is async; fill it in and re-render once known.
  if (isCached) {
    Promise.all([...MODEL_TIERS, ...EXTRA_MODELS].map(async (m) => {
      cacheStatus.set(m.id, await isCached(m.id));
    })).then(render).catch(() => {});
  }

  return { render };
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
