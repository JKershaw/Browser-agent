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
import { diagnoseLoadError } from './llm/load-error.js';
import { createMockEngine } from './llm/mock.js';
import { checkHeadroom, estimateStorage, requestPersistence } from './llm/storage.js';
import {
  MODEL_TIERS,
  createWebLLMEngine,
  downloadBytesFor,
  looksMobile,
  pickDefaultModel,
  smallerModelsThan,
} from './llm/webllm.js';
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
      ? createMockEngine({
        script: mockScriptFromUrl(),
        deltaMs: 8,
        loadMs: mockLoadMsFromUrl(),
        ...mockLoadFailureFromUrl(),
      })
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

  /**
   * Ask the engine to drop a model's cached weights.
   * @param {string} modelId
   * @returns {Promise<boolean>}
   */
  async function deleteCachedModel(modelId) {
    if (typeof engine.deleteFromCache !== 'function') return false;
    return Boolean(await engine.deleteFromCache(modelId));
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

    /**
     * Check there is somewhere to put the model before spending minutes
     * fetching it.
     *
     * A download that dies at 65% because the device was always too full is a
     * waste of the user's time and their mobile data, and the failure it
     * produces is far harder to read than the warning it could have been. This
     * measures first and reports what it found.
     *
     * Advisory only: `navigator.storage` is missing in places the app still
     * works, and the quota it reports is an estimate the browser is free to
     * revise. Refusing to try on the strength of it would be worse than the
     * failure it prevents.
     *
     * @param {string} modelId
     * @returns {Promise<{storage: object, neededBytes: number|null,
     *                    headroom: {level: string, shortfallBytes: number|null, message: string|null},
     *                    persisted: boolean|null}>}
     */
    async preflight(modelId) {
      const nav = opts.navigator ?? globalThis.navigator;
      // Asked for before the download, not after: persistence exempts the
      // weights from eviction, and eviction mid-download is one of the ways
      // this fails on a device under storage pressure.
      const persisted = await requestPersistence(nav);
      const storage = await estimateStorage(nav);
      const neededBytes = downloadBytesFor(modelId);
      return {
        storage,
        neededBytes,
        headroom: checkHeadroom({ freeBytes: storage.freeBytes, neededBytes }),
        persisted,
      };
    },

    /**
     * Explain a load failure with everything measurable attached.
     *
     * @param {unknown} error
     * @param {{modelId?: string, snapshot?: object, caps?: object, storage?: object}} [ctx]
     * @returns {Promise<object>} A diagnosis from `llm/load-error.js`.
     */
    async diagnoseLoad(error, ctx = {}) {
      const nav = opts.navigator ?? globalThis.navigator;
      // Re-measured rather than reused: the interesting question is how much
      // room there is *now*, after the attempt, and a download that half
      // succeeded has changed the answer.
      const storage = ctx.storage ?? (await estimateStorage(nav));
      return diagnoseLoadError(error, {
        modelId: ctx.modelId,
        modelBytes: downloadBytesFor(ctx.modelId),
        // So the advice never suggests switching to the model that just failed.
        smallerModels: smallerModelsThan(ctx.modelId),
        storage,
        snapshot: ctx.snapshot,
        caps: ctx.caps,
        userAgent: nav?.userAgent || 'unknown',
        pageUrl: reportablePageUrl(),
        timestamp: new Date().toISOString(),
      });
    },

    /**
     * Reclaim the space a model's weights occupy.
     * @param {string} modelId
     * @returns {Promise<boolean>}
     */
    deleteCachedModel,

    /**
     * Delete every model this app knows how to cache, and report what that won
     * back.
     *
     * Includes the model that has just failed, deliberately. A download that
     * stopped two thirds of the way through leaves two thirds of the weights
     * on the device, and they are worth nothing on their own — on a phone that
     * has run out of room, that dead weight is often the largest single thing
     * the app can give back.
     *
     * @param {string[]} [alsoDelete] Extra ids — typically the one that failed,
     *   which may be an advanced id outside the tier list.
     * @returns {Promise<{deleted: string[], freedBytes: number|null}>}
     */
    async freeCachedModels(alsoDelete = []) {
      const nav = opts.navigator ?? globalThis.navigator;
      const before = await estimateStorage(nav);

      const ids = [...new Set([...MODEL_TIERS.map((t) => t.id), ...alsoDelete.filter(Boolean)])];
      const deleted = [];
      for (const id of ids) {
        // Deleting what was never there is harmless, but reporting it as
        // reclaimed space would be a lie, so ask first where we can.
        let cached = true;
        if (typeof engine.isCached === 'function') {
          cached = await engine.isCached(id).catch(() => false);
        }
        if (!cached) continue;
        if (await deleteCachedModel(id)) deleted.push(id);
      }

      const after = await estimateStorage(nav);
      const freedBytes =
        before.usageBytes !== null && after.usageBytes !== null
          ? Math.max(0, before.usageBytes - after.usageBytes)
          : null;
      return { deleted, freedBytes };
    },

    /** All models offered in the picker, spec tiers first. */
    tiers: MODEL_TIERS,
  };
}

/**
 * Where the app is hosted, without whatever is in the query string.
 *
 * The debug report is written to be pasted into a public bug tracker. Origin
 * and path are what diagnose a deployment; query parameters are not, and this
 * app has no way of knowing what someone has put in one.
 *
 * @param {Location} [loc]
 * @returns {string}
 */
export function reportablePageUrl(loc = globalThis.location) {
  if (!loc) return 'unknown';
  const origin = loc.origin && loc.origin !== 'null' ? loc.origin : loc.protocol || '';
  const path = loc.pathname || '';
  const base = `${origin}${path}` || String(loc.href || 'unknown');
  return loc.search ? `${base} (query string omitted)` : base;
}

/**
 * The e2e suite's hook for reproducing a specific load failure.
 *
 * `?mockLoadFail=cache` replays the error that prompted all of this, verbatim,
 * including its DOMException name — so the diagnosis path is tested against the
 * real string rather than a paraphrase of it.
 *
 * @returns {{failLoad?: boolean, loadError?: Error, failAt?: number}}
 */
export function mockLoadFailureFromUrl(search = globalThis.location?.search || '') {
  const kind = new URLSearchParams(search).get('mockLoadFail');
  if (!kind) return {};

  const errors = {
    cache: (() => {
      const e = new Error("Failed to execute 'add' on 'Cache': Entry was not found.");
      e.name = 'NotFoundError';
      return e;
    })(),
    quota: (() => {
      const e = new Error('Quota exceeded.');
      e.name = 'QuotaExceededError';
      return e;
    })(),
    network: new TypeError('Failed to fetch'),
    gpu: new Error('Out of memory: the requested buffer size exceeds the max buffer size.'),
  };

  return { failLoad: true, loadError: errors[kind] || new Error(`Mock load failure: ${kind}`), failAt: 0.65 };
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
