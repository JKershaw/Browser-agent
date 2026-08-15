/**
 * The request log: every tool call, its outcome, and its timing.
 *
 * In-memory only (SPEC §12 open question, resolved for v1): nothing about a
 * request survives a reload, which is the safe default when entries can carry
 * traces of credentialled requests. Export produces JSON with secrets already
 * masked — the export is meant to be pasted into a bug report.
 *
 * @module state/log
 */

import { maskHeaders, maskSecrets } from '../tools/curl.js';

/** Ring-buffer size; oldest entries are dropped past this. */
export const MAX_ENTRIES = 200;

let seq = 0;

/**
 * @param {object} [opts]
 * @param {number} [opts.max]
 * @param {() => number} [opts.now] Injectable clock.
 * @returns {object}
 */
export function createRequestLog(opts = {}) {
  const max = opts.max ?? MAX_ENTRIES;
  const now = opts.now ?? (() => Date.now());
  /** @type {Array<object>} */
  let entries = [];
  /** @type {Set<Function>} */
  const listeners = new Set();

  const notify = () => {
    for (const fn of listeners) fn(entries);
  };

  /**
   * Record a call that is about to be dispatched.
   *
   * @param {{args: {method: string, url: string, headers?: object, body?: string|null}}} call
   * @returns {object} The entry, so the caller can settle it later.
   */
  function start(call) {
    seq += 1;
    const entry = {
      id: `req-${seq}`,
      at: now(),
      status: 'pending',
      method: call.args.method,
      url: call.args.url,
      requestHeaders: maskHeaders(call.args.headers || {}),
      requestBody: call.args.body ?? null,
      response: null,
      error: null,
      elapsedMs: null,
      denied: false,
    };
    entries = [...entries, entry].slice(-max);
    notify();
    return entry;
  }

  /**
   * Attach the outcome of a curl execution to an entry.
   *
   * @param {string} id
   * @param {object} result Output of `executeCurl`.
   */
  function settle(id, result) {
    const secrets = result?.request?.secrets || [];
    entries = entries.map((e) => {
      if (e.id !== id) return e;
      const base = {
        ...e,
        elapsedMs: result?.elapsedMs ?? null,
        requestHeaders: maskHeaders(result?.request?.headers || e.requestHeaders, secrets),
        proxied: Boolean(result?.request?.proxied),
        credentialsUsed: result?.request?.credentialsUsed || [],
      };
      if (result?.ok) {
        return {
          ...base,
          status: 'ok',
          response: {
            status: result.status,
            statusText: result.statusText,
            headers: result.headers,
            body: maskSecrets(result.body ?? '', secrets),
            truncated: Boolean(result.truncated),
            redirected: Boolean(result.redirected),
            finalUrl: maskSecrets(result.finalUrl || '', secrets),
          },
        };
      }
      return {
        ...base,
        status: 'error',
        error: { kind: result?.error?.kind || 'unknown', message: result?.error?.message || 'Unknown failure.' },
      };
    });
    notify();
  }

  /**
   * Mark an entry as refused by the user; no request was sent.
   * @param {string} id
   * @param {string} [reason]
   */
  function deny(id, reason) {
    entries = entries.map((e) =>
      e.id === id ? { ...e, status: 'denied', denied: true, error: { kind: 'denied', message: reason || 'Denied by the user.' } } : e
    );
    notify();
  }

  return {
    start,
    settle,
    deny,
    all: () => entries,
    size: () => entries.length,
    clear() {
      entries = [];
      notify();
    },
    /**
     * @param {(entries: Array<object>) => void} fn
     * @returns {() => void} Unsubscribe.
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /**
     * Pretty-printed JSON of the whole log, already masked.
     * @returns {string}
     */
    toJSON() {
      return JSON.stringify({ exportedAt: new Date(now()).toISOString(), entries }, null, 2);
    },
  };
}
