/**
 * Composition root: wires settings, log, engine, tool and agent loop together.
 *
 * Kept free of DOM code so both the real UI and the debug page build on the
 * same object, and so a headless harness can drive the whole app.
 *
 * @module app
 */

import { createAgentLoop } from './agent/loop.js';
import { executeCurl, formatResultForModel } from './tools/curl.js';
import { assertEngine, detectCapabilities } from './llm/engine.js';
import { createMockEngine } from './llm/mock.js';
import { MODEL_TIERS, createWebLLMEngine, looksMobile, pickDefaultModel } from './llm/webllm.js';
import { createRequestLog } from './state/log.js';
import { createSettingsStore } from './state/settings.js';

/**
 * Is the page running from a `file://` origin? Model caching is unreliable
 * there (SPEC §2.1), so the UI shows a notice.
 * @param {Location} [loc]
 * @returns {boolean}
 */
export function isFileOrigin(loc = globalThis.location) {
  return String(loc?.protocol || '') === 'file:';
}

/**
 * Read the `?mockEngine=1` escape hatch used by the e2e suite.
 * @param {string} [search]
 * @returns {boolean}
 */
export function wantsMockEngine(search = globalThis.location?.search || '') {
  return new URLSearchParams(search).get('mockEngine') === '1';
}

/**
 * Build the application object.
 *
 * @param {object} [opts]
 * @param {object} [opts.engine] Pre-built engine (tests inject one).
 * @param {Storage} [opts.storage]
 * @param {Function} [opts.fetchImpl]
 * @param {object} [opts.navigator]
 * @param {(call: object) => Promise<object>} [opts.confirm]
 * @param {object} [opts.hooks] Forwarded to the agent loop.
 * @returns {object}
 */
export function createApp(opts = {}) {
  const notices = [];
  const settings = createSettingsStore({
    storage: opts.storage,
    onStorageError: (msg) => notices.push({ kind: 'warning', text: msg }),
  });
  const log = createRequestLog();

  const engine = assertEngine(
    opts.engine || (wantsMockEngine()
      ? createMockEngine({ script: mockScriptFromUrl(), deltaMs: 8, loadMs: mockLoadMsFromUrl() })
      : createWebLLMEngine({ navigator: opts.navigator }))
  );

  /**
   * The log entry for the call currently being decided on.
   *
   * The entry is opened when the loop *proposes* a call, not when the request
   * is dispatched, because a denied call is never dispatched at all — and a
   * denial the user made is exactly the kind of thing the record must contain.
   * Holding the id here also means a denial can never be attributed to some
   * other request that happens to be pending.
   *
   * @type {{id: string}|null}
   */
  let openEntry = null;

  /** Run one tool call: execute it and settle the entry opened for it. */
  async function executeTool(call, ctx) {
    const s = settings.get();
    const entry = openEntry ?? log.start(call);
    openEntry = null;
    try {
      const result = await executeCurl(call.args, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: s.timeoutMs,
        maxBytes: s.maxBytes,
        proxyTemplate: s.proxyTemplate,
        allowlist: s.allowlist,
        credentials: s.credentials,
        signal: ctx?.signal,
      });
      log.settle(entry.id, result);
      return result;
    } catch (e) {
      // `executeCurl` is contracted not to throw, so this is a bug rather than
      // an expected path — but an entry stuck at "pending" forever is worse
      // than an honest error, and the loop turns the rethrow into a notice.
      log.settle(entry.id, {
        ok: false,
        error: { kind: 'internal', message: `The tool crashed: ${e?.message || e}` },
      });
      throw e;
    }
  }

  const loop = createAgentLoop({
    engine,
    executeTool,
    formatResult: formatResultForModel,
    getSettings: () => settings.get(),
    confirm: opts.confirm,
    hooks: {
      ...opts.hooks,
      onToolCall: (payload) => {
        openEntry = log.start(payload.call);
        opts.hooks?.onToolCall?.(payload);
      },
      onToolDenied: (payload) => {
        if (openEntry) {
          log.deny(openEntry.id, payload.reason);
          openEntry = null;
        }
        opts.hooks?.onToolDenied?.(payload);
      },
      onTurnEnd: (payload) => {
        // A turn can end between proposal and dispatch (cancellation), which
        // would otherwise strand the entry as pending forever.
        if (openEntry) {
          log.deny(openEntry.id, 'The turn ended before this request was sent.');
          openEntry = null;
        }
        opts.hooks?.onTurnEnd?.(payload);
      },
    },
  });

  return {
    settings,
    log,
    engine,
    loop,
    notices,
    isFileOrigin: () => isFileOrigin(),

    /**
     * Detect the device's capabilities and pick a starting model.
     * @returns {Promise<{caps: object, model: {id: string, reason: string}}>}
     */
    async probe() {
      const caps = await detectCapabilities(opts.navigator ?? globalThis.navigator);
      const saved = settings.getPersisted().modelId;
      const model = saved
        ? { id: saved, reason: '' }
        : pickDefaultModel(caps, looksMobile(opts.navigator?.userAgent));
      return { caps, model };
    },

    /** All models offered in the picker, spec tiers first. */
    tiers: MODEL_TIERS,
  };
}

/**
 * How long the mock engine should pretend to spend loading.
 *
 * Lets the e2e suite hold the app in its loading state, which is where every
 * user spends the first few minutes on a real first run.
 *
 * @returns {number}
 */
function mockLoadMsFromUrl() {
  const raw = new URLSearchParams(globalThis.location?.search || '').get('mockLoadMs');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30_000) : 0;
}

/**
 * The e2e suite passes a scripted set of replies as a URL parameter so a
 * scenario can be expressed entirely in the page URL.
 * @returns {string[]}
 */
function mockScriptFromUrl() {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('mockScript');
    if (!raw) return ['Hello from the mock engine.'];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return ['Hello from the mock engine.'];
  }
}
