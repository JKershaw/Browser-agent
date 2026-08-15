/**
 * What the browser will actually let us store, and whether the model fits.
 *
 * Model weights are hundreds of megabytes to a couple of gigabytes, written
 * into the Cache API a shard at a time. On a device that is close to full this
 * fails — sometimes with an honest quota error, sometimes with something far
 * less obvious (see `load-error.js`). Either way the app can measure the space
 * *before* spending five minutes downloading into it, and can quote real
 * numbers afterwards instead of speculating.
 *
 * @module llm/storage
 */

import { formatSize } from './format.js';

/**
 * How much slack to insist on beyond the raw weight size.
 *
 * The published download figures are approximate, and the weights are not the
 * only thing cached: the compiled wasm library, the tokenizer and the chat
 * config go in alongside them. Twelve per cent covers that without being so
 * cautious that a device which would have worked gets told it will not.
 */
export const HEADROOM_FACTOR = 1.12;

/** @typedef {'unknown'|'ok'|'tight'|'insufficient'} HeadroomLevel */

/**
 * Ask the browser how much storage this origin is using and is allowed.
 *
 * Every field is optional: `navigator.storage` is absent in older browsers and
 * on some insecure origins, and `estimate()` can reject. The caller always gets
 * an object, never an exception — a failed measurement must not be the reason a
 * model download does not start.
 *
 * @param {object} [nav] Injectable `navigator`.
 * @returns {Promise<{supported: boolean, usageBytes: number|null, quotaBytes: number|null,
 *                    freeBytes: number|null, persisted: boolean|null, reason: string|null}>}
 */
export async function estimateStorage(nav = globalThis.navigator) {
  const out = {
    supported: false,
    usageBytes: null,
    quotaBytes: null,
    freeBytes: null,
    persisted: null,
    reason: null,
  };

  const storage = nav?.storage;
  if (!storage || typeof storage.estimate !== 'function') {
    out.reason = 'This browser does not expose navigator.storage.estimate().';
    return out;
  }

  try {
    const est = await storage.estimate();
    out.supported = true;
    if (typeof est?.usage === 'number' && Number.isFinite(est.usage)) out.usageBytes = est.usage;
    if (typeof est?.quota === 'number' && Number.isFinite(est.quota)) out.quotaBytes = est.quota;
    if (out.usageBytes !== null && out.quotaBytes !== null) {
      out.freeBytes = Math.max(0, out.quotaBytes - out.usageBytes);
    }
  } catch (e) {
    out.reason = `navigator.storage.estimate() failed: ${e?.message || e}`;
    return out;
  }

  // Reported separately: persistence can be denied while the estimate works
  // fine, and the two facts want different remedies.
  try {
    if (typeof storage.persisted === 'function') out.persisted = Boolean(await storage.persisted());
  } catch {
    /* leave as unknown */
  }

  return out;
}

/**
 * Ask for persistent storage, so the browser stops treating the weights as
 * disposable.
 *
 * Best-effort by design. Chrome decides from site engagement without prompting,
 * and a refusal is not an error — it only means the cache may be evicted under
 * pressure, which is worth knowing when a download later fails halfway.
 *
 * @param {object} [nav] Injectable `navigator`.
 * @returns {Promise<boolean|null>} `null` when the API is unavailable.
 */
export async function requestPersistence(nav = globalThis.navigator) {
  const storage = nav?.storage;
  if (!storage || typeof storage.persist !== 'function') return null;
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    return Boolean(await storage.persist());
  } catch {
    return null;
  }
}

/**
 * Will `neededBytes` fit in the space the browser is offering?
 *
 * @param {object} args
 * @param {number|null} [args.freeBytes] From {@link estimateStorage}.
 * @param {number|null} [args.neededBytes] Approximate download size.
 * @param {number} [args.headroom]
 * @returns {{level: HeadroomLevel, shortfallBytes: number|null, message: string|null}}
 */
export function checkHeadroom({ freeBytes = null, neededBytes = null, headroom = HEADROOM_FACTOR } = {}) {
  if (
    freeBytes === null || freeBytes === undefined || !Number.isFinite(freeBytes) ||
    neededBytes === null || neededBytes === undefined || !Number.isFinite(neededBytes) || neededBytes <= 0
  ) {
    return { level: 'unknown', shortfallBytes: null, message: null };
  }

  const comfortable = neededBytes * headroom;

  if (freeBytes < neededBytes) {
    return {
      level: 'insufficient',
      shortfallBytes: Math.ceil(neededBytes - freeBytes),
      message:
        `This model needs about ${formatSize(neededBytes)} but the browser will only let this ` +
        `site store ${formatSize(freeBytes)} more — roughly ${formatSize(neededBytes - freeBytes)} short. ` +
        'Free up space on the device, or pick a smaller model.',
    };
  }

  if (freeBytes < comfortable) {
    return {
      level: 'tight',
      shortfallBytes: null,
      message:
        `This model needs about ${formatSize(neededBytes)} and the browser will only let this site ` +
        `store ${formatSize(freeBytes)} more. It may just fit, but the download can fail near the end ` +
        'if anything else on the device claims space first.',
    };
  }

  return { level: 'ok', shortfallBytes: null, message: null };
}

/**
 * One-line summary of a storage estimate, for the debug report and the
 * pre-flight notice.
 *
 * @param {{supported: boolean, usageBytes: number|null, quotaBytes: number|null,
 *          freeBytes: number|null, persisted: boolean|null, reason: string|null}} est
 * @returns {string}
 */
export function describeStorage(est) {
  if (!est || !est.supported) return `unavailable (${est?.reason || 'no reason reported'})`;
  if (est.usageBytes === null || est.quotaBytes === null) return 'reported, but without usable numbers';
  const persisted = est.persisted === null ? 'unknown' : est.persisted ? 'yes' : 'no';
  return (
    `${formatSize(est.usageBytes)} used of ${formatSize(est.quotaBytes)} granted, ` +
    `${formatSize(est.freeBytes)} free (persistent: ${persisted})`
  );
}
