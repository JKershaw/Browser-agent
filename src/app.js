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
    opts.engine || (wantsMockEngine() ? createMockEngine({ script: mockScriptFromUrl(), deltaMs: 8 }) : createWebLLMEngine({ navigator: opts.navigator }))
  );

  /** Run one tool call: log it, execute it, settle the log entry. */
  async function executeTool(call, ctx) {
    const s = settings.get();
    const entry = log.start(call);
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
  }

  const loop = createAgentLoop({
    engine,
    executeTool,
    formatResult: formatResultForModel,
    getSettings: () => settings.get(),
    confirm: opts.confirm,
    hooks: {
      ...opts.hooks,
      onToolDenied: (payload) => {
        // Mirror the denial into the log so the record is complete.
        const pending = log.all().filter((e) => e.status === 'pending').at(-1);
        if (pending) log.deny(pending.id, payload.reason);
        opts.hooks?.onToolDenied?.(payload);
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
