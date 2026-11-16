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
import { createLoadingPanel } from './ui/loading.js';
import { renderCapabilityGate } from './ui/gate.js';
import { createLoadTracker } from './llm/progress.js';
import { formatSize } from './llm/format.js';
import { el } from './ui/dom.js';
import { createInstallPrompt, isStandalone, registerServiceWorker } from './pwa/install.js';
import { CHATS_KEY } from './state/chats.js';

const $ = (sel) => document.querySelector(sel);

const chat = createChatPane($('#messages'));
const stats = createStatsBar($('#statsbar'));

/** Tool card for the call currently in flight. */
let activeCard = null;
let modelLoaded = false;

/** Built in boot(), after the capability gate. */
let settingsSheet = null;

/**
 * The engine's token count when the conversation on screen began. The engine
 * counts from its last model load; the stats bar shows this conversation.
 */
let tokenBase = 0;

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
        // A split multi-step ask reaches the transcript one step at a time,
        // but the user typed one message: show their text once, as typed,
        // then mark each later step as the agent moving through the plan.
        const step = m.meta?.step;
        if (!step) chat.addUserMessage(m.content);
        else if (step.index === 0) chat.addUserMessage(step.original);
        else chat.addStepMessage(m.content, step.index + 1, step.total);
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
        tokens: Math.max(0, st.totalTokens - tokenBase),
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
 * chats
 * ------------------------------------------------------------------ */

/** The hint every empty chat starts with. */
function showWelcome() {
  if (wantsMockEngine()) {
    chat.addNotice({
      kind: 'warning',
      text: 'Mock engine active (?mockEngine=1). Replies are scripted, not generated — this mode exists for the test suite. Remove the parameter to use the real model.',
    });
  }
  chat.addNotice({
    kind: 'info',
    text: 'Ask for something on the web and the agent will offer to fetch it. Every request needs your approval first.',
  });
}

/**
 * Clear the conversation pane and refill it.
 *
 * The loading card is the app's, not the conversation's: a download in
 * progress, or the report of one that failed, is put back at the end — the
 * composer stays disabled until a model loads, and without the card nothing
 * would say why.
 *
 * @param {() => void} fill
 */
function rebuildChat(fill) {
  activeCard = null;
  chat.clear();
  fill();
  const card = loading.node();
  if (card) chat.addNode(card);
  tokenBase = app.engine.stats().totalTokens;
  stats.update({ tokens: 0, iteration: 0, lastToolMs: null });
  settingsSheet?.render();
  chat.scrollToEnd();
}

async function startNewChat() {
  // Cancels a running turn (synchronously, inside newChat) and then closes
  // its confirmation card, in the same order as the Stop button.
  const pending = app.newChat();
  chat.dismissConfirm();
  const { savedPrevious } = await pending;
  rebuildChat(() => {
    if (savedPrevious) {
      chat.addNotice({ kind: 'info', text: 'New chat started. The previous one is saved under Settings → Chats.' });
    }
    showWelcome();
  });
  closeSheets();
  if (!input.disabled) input.focus();
}

/** @param {string} id */
async function openSavedChat(id) {
  const pending = app.openChat(id);
  chat.dismissConfirm();
  const record = await pending;
  if (!record) {
    chat.addNotice({ kind: 'warning', text: 'That chat is no longer saved — it may have been deleted in another tab.' });
    settingsSheet?.render();
    return;
  }
  rebuildChat(() => {
    chat.addNotice({ kind: 'info', text: `Reopened “${record.title}”. Carry on where it left off.` });
    chat.replay(app.loop.transcript);
  });
  closeSheets();
  if (!input.disabled) input.focus();
}

/** @param {string} id */
async function deleteSavedChat(id) {
  const isCurrent = id === app.currentChatId();
  const pending = app.deleteChat(id);
  if (isCurrent) chat.dismissConfirm();
  const { wasCurrent } = await pending;
  if (wasCurrent) rebuildChat(showWelcome);
}

async function deleteAllChats() {
  const pending = app.deleteAllChats();
  chat.dismissConfirm();
  await pending;
  rebuildChat(showWelcome);
}

$('#new-chat').addEventListener('click', () => {
  startNewChat().catch((e) => chat.addNotice({ kind: 'error', text: `Could not start a new chat: ${e?.message || e}` }));
});

// Another tab saved or deleted a chat: show the list as storage now has it.
globalThis.addEventListener?.('storage', (e) => {
  if (e.key === null || e.key === CHATS_KEY) app.chats.refresh();
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
  if (e.key !== 'Escape') return;
  // An open sheet is the topmost thing on screen, so Escape closes it first;
  // with nothing else open, Escape refuses a pending confirmation card — the
  // reversible reading of a dismissive keystroke. Never both at once.
  const sheetOpen = ['settings', 'log'].some((id) => $(`#${id}-sheet`).dataset.open === 'true');
  if (sheetOpen) closeSheets();
  else chat.denyConfirm();
});

/* ------------------------------------------------------------------ *
 * install + offline
 * ------------------------------------------------------------------ */

// Installed at module load, not in boot(): Chrome can fire
// beforeinstallprompt early, and an event nobody was listening for is gone.
const installBtn = $('#install');
const install = createInstallPrompt({
  target: globalThis,
  onChange: ({ available }) => {
    installBtn.hidden = !available || isStandalone(globalThis);
  },
  onInstalled: () => {
    chat.addNotice({
      kind: 'info',
      text: 'Installed. Browser Agent now opens from your apps like any other. Once a model has finished downloading, chatting works without a connection; fetching from the web still needs one.',
    });
  },
});
installBtn.addEventListener('click', () => install.prompt());

const OFFLINE_NOTICE =
  'This device is offline. Chatting with a downloaded model still works; fetching anything from the web needs a connection.';
globalThis.addEventListener('offline', () => chat.addNotice({ kind: 'warning', text: OFFLINE_NOTICE }));
globalThis.addEventListener('online', () => chat.addNotice({ kind: 'info', text: 'Back online.' }));

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

createLogView($('#log-body'), app.log);

const loading = createLoadingPanel($('#messages'));

/**
 * How often the loading card refreshes itself between WebLLM's reports.
 *
 * WebLLM speaks once per shard, which on a slow connection is several seconds
 * apart. A card that only moves when it is spoken to looks frozen for most of
 * the download, so the elapsed time and the estimate tick along in between.
 */
const LOADING_TICK_MS = 250;

/** @type {ReturnType<typeof setInterval>|null} */
let loadingTimer = null;
/** Capabilities from boot, kept for the failure report. */
let bootCaps = null;

/**
 * Which load is the current one.
 *
 * Nothing stops the settings sheet starting a second load while the first is
 * still downloading — the composer is disabled, the sheet is not. The first
 * load's progress callbacks keep firing regardless, and without this they would
 * write into the card the second load has since built, producing a bar that
 * jumps between two downloads and a failure attributed to the wrong model.
 */
let loadSeq = 0;

function stopLoadingTimer() {
  if (loadingTimer !== null) {
    clearInterval(loadingTimer);
    loadingTimer = null;
  }
}

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
  stopLoadingTimer();

  loadSeq += 1;
  const mySeq = loadSeq;
  const current = () => mySeq === loadSeq;

  // Loading unloads whatever was on the GPU first, so nothing is "in use"
  // until this finishes.
  settingsSheet?.setModelState({ activeId: null, loadingId: modelId, failedId: null });

  const cached = app.engine.isCached
    ? await app.engine.isCached(modelId).catch(() => false)
    : false;
  if (!current()) return;

  const tracker = createLoadTracker({ expectDownload: !cached });
  loading.start({ modelId, cached });
  loading.update(tracker.snapshot());
  stats.setLoading('starting…');
  chat.scrollToEnd();

  // Advisory, and non-blocking: a wrong "not enough room" verdict must never be
  // the reason a load that would have worked never starts.
  if (!cached) {
    try {
      const pre = await app.preflight(modelId);
      // Said out loud that the download is continuing regardless: a warning
      // shown above a bar that is visibly filling otherwise reads as a
      // contradiction, and the quota is an estimate the browser may revise.
      if (pre.headroom.message && current()) {
        loading.warn(`${pre.headroom.message} Carrying on for now — the browser’s figure is only an estimate.`);
      }
    } catch {
      /* the load itself is the real test */
    }
  }
  if (!current()) return;

  loadingTimer = setInterval(() => {
    if (current()) loading.update(tracker.tick());
  }, LOADING_TICK_MS);

  try {
    await app.engine.load(modelId, (report) => {
      const snapshot = tracker.report(report);
      if (!current()) return;
      loading.update(snapshot);
      stats.setLoading(`${Math.round(snapshot.overall * 100)}% · ${snapshot.phaseLabel}`);
    });
    if (!current()) return;
    stopLoadingTimer();
    loading.destroy();
    modelLoaded = true;
    stats.setLoading(null);
    stats.setModel(modelId);
    setBusy(false);
    // The engine's count restarts with a new model; so does the baseline.
    tokenBase = app.engine.stats().totalTokens;
    settingsSheet?.setModelState({ activeId: modelId, loadingId: null, failedId: null });
    // A first load has just downloaded it.
    settingsSheet?.refreshCache([modelId]).catch(() => {});
    chat.addNotice({ kind: 'info', text: `${modelId} is ready.` });
  } catch (e) {
    // A superseded load's failure is not news — the user has already moved on
    // to another model, and its card belongs to that one now.
    if (!current()) return;
    stopLoadingTimer();
    stats.setLoading(null);
    stats.setModel(modelId);
    settingsSheet?.setModelState({ activeId: null, loadingId: null, failedId: modelId });
    // A half-finished download may or may not count as cached; ask again.
    settingsSheet?.refreshCache([modelId]).catch(() => {});
    await reportLoadFailure(e, modelId, tracker.snapshot());
  }
}

/**
 * Turn a load failure into an explanation, with the numbers to back it up.
 *
 * @param {unknown} error
 * @param {string} modelId
 * @param {object} snapshot Progress at the moment it failed.
 */
async function reportLoadFailure(error, modelId, snapshot) {
  let diagnosis;
  try {
    diagnosis = await app.diagnoseLoad(error, { modelId, snapshot, caps: bootCaps });
  } catch {
    // The diagnosis is a convenience; failing to produce one must not replace
    // a bad error message with no error message at all.
    chat.addNotice({ kind: 'error', text: `The model could not be loaded: ${error?.message || error}` });
    return;
  }

  loading.fail(diagnosis, {
    onRetry: () => loadModel(modelId),
    onSmallerModel: () => openSheet('settings'),
    onFreeSpace: async () => {
      const { deleted, freedBytes } = await app.freeCachedModels([modelId]);
      chat.addNotice({
        kind: 'info',
        text: deleted.length
          ? `Removed stored data for ${deleted.join(', ')}${freedBytes ? `, freeing ${formatSize(freedBytes)}` : ''}. Try loading again.`
          : 'There was no stored model data to remove, so the space will have to come from elsewhere on the device.',
      });
      chat.scrollToEnd();
    },
  });
  chat.scrollToEnd();
}

async function boot() {
  const { caps, model } = await app.probe();
  bootCaps = caps;

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

  // Fire-and-forget: the page works the same whether or not this succeeds.
  registerServiceWorker({
    location: globalThis.location,
    navigator: globalThis.navigator,
    dev: import.meta.env.DEV,
  });

  if (globalThis.navigator?.onLine === false) {
    chat.addNotice({ kind: 'warning', text: OFFLINE_NOTICE });
  }

  for (const n of app.notices) chat.addNotice(n);

  settingsSheet = createSettingsSheet($('#settings-body'), {
    settings: app.settings,
    caps,
    isCached: app.engine.isCached ? (id) => app.engine.isCached(id) : undefined,
    onDeleteModel: (id) => app.deleteCachedModel(id),
    onLoadModel: (id) => {
      closeSheets();
      return loadModel(id);
    },
    chats: app.chats,
    getCurrentChatId: () => app.currentChatId(),
    onNewChat: () => startNewChat(),
    onOpenChat: (id) => openSavedChat(id),
    onDeleteChat: (id) => deleteSavedChat(id),
    onDeleteAllChats: () => deleteAllChats(),
  });

  if (model.reason) chat.addNotice({ kind: 'info', text: model.reason });
  app.settings.set({ modelId: model.id });

  showWelcome();

  await loadModel(model.id);
  input.focus();
}

boot().catch((e) => {
  $('#gate').append(el('p', { class: 'error-explain', text: `The app failed to start: ${e?.message || e}` }));
});
