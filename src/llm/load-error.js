/**
 * Working out why a model failed to load, and saying so usefully.
 *
 * The default failure message a browser gives you here is close to useless.
 * The one that prompted this module was:
 *
 *     Failed to execute 'add' on 'Cache': Entry was not found.
 *
 * — raised on a phone that was nearly full, two thirds of the way through a
 * download. Nothing in that sentence mentions storage, and the app's own
 * message at the time ("check the model id, your connection, and that this
 * device has enough memory") listed three possibilities without committing to
 * any of them, which is not much better than silence.
 *
 * The fix is to stop guessing and start measuring. `navigator.storage.estimate()`
 * says how much room this origin actually has; the progress tracker says how
 * far the load got and how much it had moved. With those in hand the app can
 * usually name the cause outright, and where it genuinely cannot it can at
 * least hand over a report worth pasting into a bug.
 *
 * Pure: no DOM, no globals, everything measured is passed in.
 *
 * @module llm/load-error
 */

import { formatDuration, formatSize } from './format.js';
import { describeStorage } from './storage.js';

/** @enum {string} */
export const LoadErrorKind = Object.freeze({
  ABORTED: 'aborted',
  MODEL_UNKNOWN: 'model-unknown',
  WEBGPU_MISSING: 'webgpu-missing',
  DEVICE_LOST: 'device-lost',
  GPU_MEMORY: 'gpu-memory',
  STORAGE_FULL: 'storage-full',
  CACHE_WRITE: 'cache-write',
  NETWORK: 'network',
  UNKNOWN: 'unknown',
});

/**
 * Ordered because several of these overlap in wording and the first match
 * wins. "Failed to store …: Network response was not ok" is a network failure
 * that mentions storage; "Failed to execute 'add' on 'Cache'" is a storage
 * failure that mentions neither quota nor disk. Order encodes which reading
 * takes precedence.
 *
 * @type {ReadonlyArray<{kind: string, re: RegExp}>}
 */
const RULES = Object.freeze([
  { kind: LoadErrorKind.MODEL_UNKNOWN, re: /ModelNotFoundError|UnsupportedModelIdError|MissingModelWasmError|cannot find model|not found in .*model_list/i },
  { kind: LoadErrorKind.WEBGPU_MISSING, re: /WebGPUNotAvailableError|WebGPUNotFoundError|webgpu is not (available|supported)|requestAdapter (returned|failed)/i },
  { kind: LoadErrorKind.DEVICE_LOST, re: /DeviceLostError|device (was )?lost|gpu device.*lost/i },
  { kind: LoadErrorKind.GPU_MEMORY, re: /out of memory|\bOOM\b|exceeds the max|maxBufferSize|maxStorageBufferBindingSize|buffer (size|allocation) .*(exceed|fail)|not enough memory/i },
  { kind: LoadErrorKind.STORAGE_FULL, re: /QuotaExceededError|quota (has been )?exceeded|exceeded the quota|storage (quota|limit) (exceeded|reached)|disk (is )?full/i },
  // Chromium's wording when the cache entry it was streaming into disappeared.
  { kind: LoadErrorKind.CACHE_WRITE, re: /entry was not found/i },
  { kind: LoadErrorKind.NETWORK, re: /failed to fetch|networkerror|network error|network response was not ok|request failed|load failed|cannot fetch|ERR_[A-Z_]{3,}|connection (was )?(reset|closed|refused)/i },
  { kind: LoadErrorKind.CACHE_WRITE, re: /on 'Cache(Storage)?'|failed to store .* with error|cache\.(add|put) |unable to (write|open) .*cache/i },
]);

/**
 * `name: message`, which is what the rules and the debug report both want.
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  if (error === null || error === undefined) return 'Unknown error';
  if (typeof error === 'string') return error;
  const name = error.name && error.name !== 'Error' ? String(error.name) : '';
  const message = error.message ? String(error.message) : String(error);
  return name ? `${name}: ${message}` : message;
}

/**
 * @param {unknown} error
 * @returns {string} A {@link LoadErrorKind}.
 */
export function classifyLoadError(error) {
  if (error && typeof error === 'object' && error.name === 'AbortError') return LoadErrorKind.ABORTED;
  const text = describeError(error);
  for (const { kind, re } of RULES) {
    if (re.test(text)) return kind;
  }
  return LoadErrorKind.UNKNOWN;
}

/**
 * How much room the browser said there was, reduced to a verdict.
 *
 * @param {object} context
 * @returns {'insufficient'|'tight'|'ok'|'unknown'}
 */
function storageVerdict(context) {
  const free = context?.storage?.freeBytes;
  const needed = context?.modelBytes;
  if (typeof free !== 'number' || !Number.isFinite(free)) return 'unknown';
  if (typeof needed !== 'number' || !Number.isFinite(needed) || needed <= 0) {
    // No size to compare against, but a nearly-empty allowance is damning on
    // its own — nothing this app does fits in a couple of hundred megabytes.
    return free < 300 * 1024 * 1024 ? 'insufficient' : 'unknown';
  }
  if (free < needed) return 'insufficient';
  if (free < needed * 1.12) return 'tight';
  return 'ok';
}

/** Sentence quoting the measured numbers, or null when there are none. */
function storageSentence(context) {
  const st = context?.storage;
  if (!st || typeof st.freeBytes !== 'number') return null;
  const needed = context?.modelBytes;
  const room = `The browser says this site has ${formatSize(st.freeBytes)} of storage left`;
  return typeof needed === 'number' && Number.isFinite(needed) && needed > 0
    ? `${room}, and this model needs about ${formatSize(needed)}.`
    : `${room}.`;
}

/**
 * Advice for switching model, naming only models that are actually smaller.
 *
 * Suggesting a smaller model to someone already on the smallest — or worse,
 * naming the model that has just failed — reads as advice written without
 * looking, and undermines the rest of the message.
 *
 * @param {object} context
 * @returns {string|null}
 */
function smallerModelAdvice(context) {
  const options = context?.smallerModels;
  if (!Array.isArray(options)) {
    return 'Or choose a smaller model in Settings.';
  }
  if (options.length === 0) return null;
  const named = options.map((m) => `${m.label.replace(/\s*\(.*\)$/, '')} needs ${m.approxDownload.replace('~', 'about ')}`);
  return `Or choose a smaller model in Settings — ${named.join(', and ')}.`;
}

/** Advice shared by every storage-shaped failure. */
function storageAdvice(context) {
  const verdict = storageVerdict(context);
  const out = [];

  if (verdict === 'insufficient' || verdict === 'tight') {
    out.push('Free up space on the device. The browser only offers a site a share of what is free, so deleting a few large files buys back more than you might expect.');
  }
  out.push('“Clear stored model data” below removes the part that did download. It is unusable on its own, and on a full device it is often the biggest single thing here worth deleting.');

  const smaller = smallerModelAdvice(context);
  if (smaller) out.push(smaller);
  else out.push('This is already the smallest model on offer, so the space has to come from the device itself.');

  if (verdict === 'ok') {
    out.push('There is room free, so this is more likely a damaged cache than a full device: clear this site’s data in your browser settings, then reload.');
  }
  // True of both cache backends: each shard is checked for before it is
  // fetched, so a retry resumes rather than starting again.
  out.push('Retrying is cheap — the parts already stored are kept, so a second attempt carries on from where this one stopped.');
  return out;
}

/** Whether offering "choose a smaller model" would lead anywhere. */
function hasSmaller(context) {
  return !Array.isArray(context?.smallerModels) || context.smallerModels.length > 0;
}

/**
 * Explain a failed load.
 *
 * @param {unknown} error
 * @param {object} [context]
 * @param {string} [context.modelId]
 * @param {number} [context.modelBytes] Approximate download size.
 * @param {object} [context.storage] From `estimateStorage`.
 * @param {object} [context.snapshot] From the progress tracker.
 * @param {object} [context.caps] From `detectCapabilities`.
 * @param {string} [context.userAgent]
 * @param {string} [context.pageUrl]
 * @param {string} [context.timestamp]
 * @returns {{kind: string, title: string, explain: string, advice: string[],
 *            actions: {retry: boolean, smallerModel: boolean, freeSpace: boolean, clearData: boolean},
 *            raw: string, debug: string}}
 */
export function diagnoseLoadError(error, context = {}) {
  const kind = classifyLoadError(error);
  const raw = describeError(error);
  const verdict = storageVerdict(context);
  const measured = storageSentence(context);

  /** @type {{title: string, explain: string, advice: string[], actions: object}} */
  let out;

  switch (kind) {
    case LoadErrorKind.CACHE_WRITE: {
      // When the measurement is decisive it goes first. Burying "923 MB free,
      // needs 1 GB" at the end of a paragraph about Chromium internals puts the
      // one sentence that answers the question below where anyone reads to.
      const damning = verdict === 'insufficient' || verdict === 'tight';
      const mechanism =
        'The download itself was fine; what failed was storing it. “Entry was not found” is what Chrome reports when the storage it was writing into disappeared underneath it — the browser evicting what it had just written to make room for something else.';
      out = {
        title: 'The browser could not store the model',
        explain: damning
          ? `${measured} That is almost certainly the whole story. ${mechanism}`
          : [mechanism, measured].filter(Boolean).join(' '),
        advice: storageAdvice(context),
        actions: {
          retry: true,
          smallerModel: hasSmaller(context),
          freeSpace: true,
          clearData: verdict === 'ok',
        },
      };
      break;
    }

    case LoadErrorKind.STORAGE_FULL:
      out = {
        title: 'There is not enough storage for this model',
        explain: [
          measured,
          'The browser refused to store any more data for this site.',
        ]
          .filter(Boolean)
          .join(' '),
        advice: storageAdvice(context),
        actions: { retry: true, smallerModel: hasSmaller(context), freeSpace: true, clearData: false },
      };
      break;

    case LoadErrorKind.NETWORK:
      out = {
        title: 'The download did not finish',
        explain:
          'The connection to the model host dropped part-way through. Model weights are hundreds of megabytes fetched in dozens of pieces, so a brief drop in signal is enough to end it.',
        advice: [
          'Check the connection and try again. Everything already downloaded is kept, so the retry resumes rather than restarting.',
          hasSmaller(context)
            ? 'On a metered or unstable mobile connection, a smaller model finishes in far fewer pieces.'
            : 'This is already the smallest model on offer, so there is nothing lighter to fall back to.',
        ],
        actions: { retry: true, smallerModel: hasSmaller(context), freeSpace: false, clearData: false },
      };
      break;

    case LoadErrorKind.GPU_MEMORY:
      out = {
        title: 'The model does not fit in this device’s GPU memory',
        explain:
          'The weights downloaded, but the GPU could not hold them. Phones and integrated graphics cap how much a page may allocate, often well below the total system memory.',
        advice: [
          hasSmaller(context)
            ? (smallerModelAdvice(context) || 'Choose a smaller model in Settings.').replace(/^Or c/, 'C')
            : 'This is already the smallest model on offer — this device may not have enough GPU memory to run one at all.',
          'Closing other tabs frees GPU memory too, though usually less than switching model does.',
        ],
        actions: { retry: true, smallerModel: hasSmaller(context), freeSpace: false, clearData: false },
      };
      break;

    case LoadErrorKind.DEVICE_LOST:
      out = {
        title: 'The graphics device was lost while loading',
        explain:
          'The browser took the GPU away mid-load. That normally means a driver reset, the tab being backgrounded for too long, or memory pressure elsewhere on the device.',
        advice: [
          'Reload the page and try again, keeping this tab in the foreground while it loads.',
          'If it keeps happening, a smaller model puts less pressure on the GPU.',
        ],
        actions: { retry: true, smallerModel: hasSmaller(context), freeSpace: false, clearData: false },
      };
      break;

    case LoadErrorKind.MODEL_UNKNOWN:
      out = {
        title: 'That model id is not one WebLLM knows',
        explain:
          'The id did not match anything in WebLLM’s prebuilt catalogue. This is usually a typo in the advanced model field, or an id from a newer release than the one bundled here.',
        advice: ['Open Settings and pick one of the listed models, or clear the advanced model id to go back to the default.'],
        actions: { retry: false, smallerModel: true, freeSpace: false, clearData: false },
      };
      break;

    case LoadErrorKind.WEBGPU_MISSING:
      out = {
        title: 'WebGPU became unavailable',
        explain:
          'The browser reported WebGPU when the page started but would not provide it when the model tried to load. A browser or driver update part-way through a session can do this.',
        advice: ['Reload the page. If the capability screen appears instead, it will explain what to enable.'],
        actions: { retry: true, smallerModel: false, freeSpace: false, clearData: false },
      };
      break;

    case LoadErrorKind.ABORTED:
      out = {
        title: 'Loading was cancelled',
        explain: 'The load stopped before it finished, because something asked it to.',
        advice: ['Start it again from Settings whenever you are ready.'],
        actions: { retry: true, smallerModel: false, freeSpace: false, clearData: false },
      };
      break;

    default:
      out = {
        title: 'The model could not be loaded',
        explain: [
          'The failure does not match anything this app knows how to explain, so here it is verbatim, with everything measured at the time.',
          verdict === 'insufficient' || verdict === 'tight' ? measured : null,
        ]
          .filter(Boolean)
          .join(' '),
        advice: [
          'Try again — transient failures during a load are common.',
          'If it repeats, the details below are what a bug report needs.',
        ],
        actions: {
          retry: true,
          smallerModel: hasSmaller(context),
          freeSpace: verdict === 'insufficient' || verdict === 'tight',
          clearData: true,
        },
      };
      break;
  }

  return { kind, raw, ...out, debug: buildDebugReport(error, { ...context, kind }) };
}

/**
 * Everything known about the failure, as plain text to copy into a bug report.
 *
 * Deliberately verbatim and deliberately complete: the whole point is that the
 * person hitting this is not at a debugger, and a screenshot of a one-line
 * message is what bug reports usually arrive as.
 *
 * @param {unknown} error
 * @param {object} [context]
 * @returns {string}
 */
export function buildDebugReport(error, context = {}) {
  const snap = context.snapshot || null;
  const lines = [
    'Browser Agent — model load failure',
    `Time:      ${context.timestamp || 'unknown'}`,
    `Model:     ${context.modelId || 'unknown'}${context.modelBytes ? ` (about ${formatSize(context.modelBytes)})` : ''}`,
    `Category:  ${context.kind || classifyLoadError(error)}`,
    `Error:     ${describeError(error)}`,
  ];

  if (snap) {
    const pct = `${Math.round((snap.overall ?? 0) * 100)}%`;
    const bytes =
      snap.fetchedBytes && snap.totalBytes
        ? `, ${formatSize(snap.fetchedBytes)} of ${formatSize(snap.totalBytes)}`
        : '';
    lines.push(
      `Failed at: ${snap.phaseLabel || snap.phase} — ${pct} overall${bytes}` +
        `${snap.detail ? ` (${snap.detail})` : ''}, after ${formatDuration(snap.elapsedMs)}`
    );
  }

  lines.push(`Storage:   ${describeStorage(context.storage)}`);

  const caps = context.caps || {};
  lines.push(
    `Device:    memory ${caps.deviceMemoryGb ?? 'unknown'} GB, ` +
      `max GPU buffer ${caps.maxBufferBytes ? formatSize(caps.maxBufferBytes) : 'unknown'}, ` +
      `flagged low-memory ${caps.lowMemory === undefined ? 'unknown' : caps.lowMemory}`
  );
  lines.push(`Page:      ${context.pageUrl || 'unknown'}`);
  lines.push(`Browser:   ${context.userAgent || 'unknown'}`);

  const stack = error && typeof error === 'object' && typeof error.stack === 'string' ? error.stack : '';
  if (stack) {
    lines.push('Stack:');
    for (const line of stack.split('\n').slice(0, 8)) lines.push(`  ${line.trim()}`);
  }

  return lines.join('\n');
}
