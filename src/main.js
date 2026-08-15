/**
 * UI entry point: builds the app object and binds it to the DOM.
 *
 * All the decision-making lives in `src/app.js` and the modules under
 * `src/agent/`; this file is wiring and event plumbing only.
 *
 * @module main
 */

import './ui/styles.css';
import { createApp, wantsMockEngine } from './app.js';
import { createChatPane } from './ui/chat.js';
import { createLogView } from './ui/logview.js';
import { createSettingsSheet } from './ui/settings.js';
import { createStatsBar } from './ui/stats.js';
import { renderCapabilityGate } from './ui/gate.js';
import { el } from './ui/dom.js';

const $ = (sel) => document.querySelector(sel);

const chat = createChatPane($('#messages'));
const stats = createStatsBar($('#statsbar'));

/** Tool card for the call currently in flight. */
let activeCard = null;
let modelLoaded = false;

const app = createApp({
  confirm: (call, credentialUse) => chat.confirm(call, app.settings.get().credentials, credentialUse),
  hooks: {
    onGenerationStart: ({ repair }) => chat.beginStream({ repair }),
    onDelta: (d) => chat.pushDelta(d),

    onMessage: (m) => {
      if (m.role === 'user') {
        // settleStream, not dropStream: a partial answer from a previous turn
        // is history and must not be deleted when the next message is sent.
        chat.settleStream();
        chat.addUserMessage(m.content);
        return;
      }
      if (m.role === 'assistant') {
        if (m.meta?.toolCall) chat.dropStream();
        else chat.commitStream(m.content, m.meta || {});
      }
      // 'tool' entries are already visible as cards; no bubble for them.
    },

    onToolCall: ({ call }) => {
      activeCard = chat.addToolCard(call);
    },
    onToolResult: ({ result }) => {
      activeCard?.settle(result);
      activeCard = null;
      stats.update({ lastToolMs: result.elapsedMs });
    },
    onToolDenied: ({ reason }) => {
      activeCard?.deny(reason);
      activeCard = null;
    },

    onNotice: (n) => chat.addNotice(n),

    onStateChange: (s) => {
      stats.update({ iteration: s.iteration, maxIterations: s.maxIterations, running: s.running });
      setBusy(s.running);
    },

    onTurnEnd: ({ stopReason }) => {
      const st = app.engine.stats();
      stats.update({
        prefill: st.prefillTokensPerSecond,
        decode: st.decodeTokensPerSecond,
        tokens: st.totalTokens,
      });

      // A turn can end between proposing a call and dispatching it — cancelled
      // at the confirmation card, most obviously. Neither onToolResult nor
      // onToolDenied fires then, so without this the card sits at "sending…"
      // forever, contradicting the log entry that correctly says it never went.
      if (activeCard) {
        activeCard.deny(
          stopReason === 'cancelled'
            ? 'You stopped the turn before this request was sent.'
            : 'The turn ended before this request was sent.'
        );
        activeCard = null;
      }

      // Leave any half-written reply visible and finished, rather than mid-
      // stream with a blinking caret.
      chat.settleStream();
    },
  },
});

/* ------------------------------------------------------------------ *
 * composer
 * ------------------------------------------------------------------ */

const input = $('#input');
const sendBtn = $('#send');
const stopBtn = $('#stop');

function setBusy(busy) {
  sendBtn.disabled = busy || !modelLoaded;
  stopBtn.hidden = !busy;
  input.disabled = busy;
}

async function send() {
  const text = input.value.trim();
  // Same gate as the Send button, so Enter cannot start a turn during the
  // first model download or after a load failure.
  if (!text || !modelLoaded || app.loop.getState().running) return;
  input.value = '';
  autoGrow();
  try {
    await app.loop.run(text);
  } catch (e) {
    chat.addNotice({ kind: 'error', text: `Something went wrong: ${e?.message || e}` });
  } finally {
    setBusy(false);
    input.focus();
  }
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
}

sendBtn.addEventListener('click', send);
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter is a newline. On touch keyboards Enter should
  // insert a newline instead, so only bind it where there is a real keyboard.
  if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) {
    e.preventDefault();
    send();
  }
});

stopBtn.addEventListener('click', () => {
  app.loop.cancel();
  chat.dismissConfirm();
});

/* ------------------------------------------------------------------ *
 * sheets
 * ------------------------------------------------------------------ */

const scrim = $('#scrim');

function openSheet(name) {
  for (const id of ['settings', 'log']) {
    const open = id === name;
    $(`#${id}-sheet`).dataset.open = String(open);
    $(`#toggle-${id}`).setAttribute('aria-expanded', String(open));
  }
  scrim.dataset.open = String(Boolean(name));
}

function closeSheets() {
  openSheet(null);
}

for (const id of ['settings', 'log']) {
  $(`#toggle-${id}`).addEventListener('click', () => {
    const isOpen = $(`#${id}-sheet`).dataset.open === 'true';
    openSheet(isOpen ? null : id);
  });
  $(`#close-${id}`).addEventListener('click', closeSheets);
}

scrim.addEventListener('click', closeSheets);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheets();
});

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

createLogView($('#log-body'), app.log);

async function loadModel(modelId) {
  // Loading underneath an in-flight generation would strand the user: the Stop
  // button disappears while the turn is still running, and any open
  // confirmation card would resolve against an engine that no longer exists.
  if (app.loop.getState().running) {
    app.loop.cancel();
    chat.dismissConfirm();
  }
  modelLoaded = false;
  setBusy(false);
  stats.setLoading('starting…');
  try {
    await app.engine.load(modelId, (p) => {
      const pct = Math.round((p.progress || 0) * 100);
      stats.setLoading(`${pct}% — ${p.text}`);
    });
    modelLoaded = true;
    stats.setLoading(null);
    stats.setModel(modelId);
    setBusy(false);
    chat.addNotice({ kind: 'info', text: `${modelId} is ready.` });
  } catch (e) {
    stats.setLoading(null);
    stats.setModel(modelId);
    chat.addNotice({
      kind: 'error',
      text: `The model could not be loaded: ${e?.message || e}. Check the model id in settings, your connection, and that this device has enough memory.`,
    });
  }
}

async function boot() {
  const { caps, model } = await app.probe();

  // Everything here already runs in the user's browser and is inspectable via
  // devtools, so exposing the app object gives away nothing. It is what the
  // Playwright suite and scripts/model-check.js drive.
  globalThis.__agent = app;

  // The mock engine exists for tests and needs no GPU, so it skips the gate.
  if (!caps.webgpu && !wantsMockEngine()) {
    $('#app').hidden = true;
    renderCapabilityGate($('#gate'), caps, { onRetry: () => globalThis.location.reload() });
    return;
  }

  if (app.isFileOrigin()) {
    $('#file-notice').hidden = false;
  }

  if (wantsMockEngine()) {
    chat.addNotice({
      kind: 'warning',
      text: 'Mock engine active (?mockEngine=1). Replies are scripted, not generated — this mode exists for the test suite. Remove the parameter to use the real model.',
    });
  }

  for (const n of app.notices) chat.addNotice(n);

  createSettingsSheet($('#settings-body'), {
    settings: app.settings,
    caps,
    isCached: app.engine.isCached ? (id) => app.engine.isCached(id) : undefined,
    onLoadModel: (id) => {
      closeSheets();
      return loadModel(id);
    },
  });

  if (model.reason) chat.addNotice({ kind: 'info', text: model.reason });
  app.settings.set({ modelId: model.id });

  chat.addNotice({
    kind: 'info',
    text: 'Ask for something on the web and the agent will offer to fetch it. Every request needs your approval first.',
  });

  await loadModel(model.id);
  input.focus();
}

boot().catch((e) => {
  $('#gate').append(el('p', { class: 'error-explain', text: `The app failed to start: ${e?.message || e}` }));
});
