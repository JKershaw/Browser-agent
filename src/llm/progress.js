/**
 * Turning WebLLM's load progress into something a person can read.
 *
 * WebLLM reports progress as a fraction and a sentence. The catch is that the
 * fraction runs 0 → 1 **three separate times**: once while the weights
 * download, once while they are read back and uploaded to the GPU, and once
 * while the shaders compile. Rendering it directly gives you a bar that fills,
 * snaps back to empty, fills, snaps back and fills again — which is exactly
 * the sort of thing that makes someone assume the app has broken and close the
 * tab five minutes into a download.
 *
 * So this module parses the sentence, works out which pass we are in, and maps
 * the three passes onto one monotonic bar. It also extracts the byte counts,
 * which is what makes a real transfer rate and a real estimate possible.
 *
 * Pure and clock-injectable, so the unit suite can drive a whole load without
 * a GPU or a stopwatch.
 *
 * @module llm/progress
 */

/** The passes WebLLM makes, in the order it makes them. */
export const PHASE = Object.freeze({
  INIT: 'init',
  DOWNLOAD: 'download',
  CACHE: 'cache',
  SHADERS: 'shaders',
  DONE: 'done',
});

/** Order matters: it is what stops the bar going backwards. */
export const PHASE_ORDER = Object.freeze([PHASE.INIT, PHASE.DOWNLOAD, PHASE.CACHE, PHASE.SHADERS, PHASE.DONE]);

/** @type {Readonly<Record<string, string>>} */
export const PHASE_LABELS = Object.freeze({
  [PHASE.INIT]: 'Preparing',
  [PHASE.DOWNLOAD]: 'Downloading the model',
  [PHASE.CACHE]: 'Loading the model onto the GPU',
  [PHASE.SHADERS]: 'Compiling GPU shaders',
  [PHASE.DONE]: 'Ready',
});

/**
 * How much of the overall bar each pass is worth.
 *
 * `firstRun` is dominated by the download — minutes against seconds — so giving
 * the two GPU passes a fifth between them keeps the bar moving at roughly
 * constant speed rather than crawling and then leaping. When the weights are
 * already cached there is no download at all, and the split changes shape
 * entirely.
 */
export const WEIGHTS_FIRST_RUN = Object.freeze({ download: 0.8, cache: 0.12, shaders: 0.08 });
export const WEIGHTS_CACHED = Object.freeze({ download: 0, cache: 0.55, shaders: 0.45 });

/** Smoothing for the rate estimate. Low enough to ignore per-shard jitter. */
const RATE_ALPHA = 0.25;

/** No estimate is offered before this much has happened. Early ones are wild. */
const MIN_ELAPSED_FOR_ETA_MS = 4000;
const MIN_PROGRESS_FOR_ETA = 0.02;

/**
 * How long a silence has to last before it is worth mentioning.
 *
 * A shard on a poor mobile connection can take a while, so this is not an
 * error — but a card that says nothing for half a minute is indistinguishable
 * from a hung one, and the difference matters to someone deciding whether to
 * keep waiting.
 */
const STALL_AFTER_MS = 20_000;

const PATTERNS = [
  {
    phase: PHASE.DOWNLOAD,
    re: /^Fetching param cache\[(\d+)\/(\d+)\]:\s*(\d+)MB fetched\.\s*(\d+)% completed,\s*(\d+) secs elapsed/i,
  },
  {
    phase: PHASE.CACHE,
    re: /^Loading model from cache\[(\d+)\/(\d+)\]:\s*(\d+)MB loaded\.\s*(\d+)% completed,\s*(\d+) secs elapsed/i,
  },
  {
    phase: PHASE.SHADERS,
    re: /^Loading GPU shader modules\[(\d+)\/(\d+)\]:\s*(\d+)% completed,\s*(\d+) secs elapsed/i,
  },
];

/**
 * Pull the structure back out of a WebLLM progress sentence.
 *
 * Written to degrade rather than throw: WebLLM has changed this wording before
 * and will again, and an unrecognised line should cost us the byte counts, not
 * the whole loading screen.
 *
 * @param {string} text
 * @returns {{phase: string, index: number|null, count: number|null,
 *            megabytes: number|null, percent: number|null, seconds: number|null}}
 */
export function parseProgressText(text) {
  const raw = String(text ?? '').trim();
  const empty = { phase: PHASE.INIT, index: null, count: null, megabytes: null, percent: null, seconds: null };
  if (raw === '') return empty;

  if (/^Finish loading/i.test(raw)) return { ...empty, phase: PHASE.DONE };

  for (const { phase, re } of PATTERNS) {
    const m = re.exec(raw);
    if (!m) continue;
    // The shader line has no megabyte field, so the trailing groups shift.
    const hasBytes = phase !== PHASE.SHADERS;
    return {
      phase,
      index: Number(m[1]),
      count: Number(m[2]),
      megabytes: hasBytes ? Number(m[3]) : null,
      percent: Number(hasBytes ? m[4] : m[3]),
      seconds: Number(hasBytes ? m[5] : m[4]),
    };
  }

  return empty;
}

/**
 * Track a model load and produce a snapshot the UI can render directly.
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now] Injectable clock.
 * @param {boolean} [opts.expectDownload] Whether the weights are expected to be
 *   downloaded rather than read from cache. Only sets the initial weighting —
 *   the tracker corrects itself from what actually happens.
 * @returns {{report: Function, tick: Function, snapshot: Function}}
 */
export function createLoadTracker(opts = {}) {
  const now = opts.now || (() => Date.now());
  const startedAt = now();

  let weights = opts.expectDownload === false ? { ...WEIGHTS_CACHED } : { ...WEIGHTS_FIRST_RUN };
  let sawDownload = false;

  let phase = PHASE.INIT;
  let phaseFraction = 0;
  let overall = 0;
  let detail = '';
  let shard = { index: null, count: null };

  let fetchedBytes = null;
  let totalBytes = null;

  let lastAt = startedAt;
  let lastOverall = 0;
  let lastFetchedBytes = null;
  let overallRate = null; // fraction per ms
  let byteRate = null; // bytes per ms
  let etaAtReport = null;
  let etaReportedAt = startedAt;

  /**
   * Weighted position of the start of `p`, given the current weighting.
   *
   * The two ends are special-cased rather than left to fall out of the loop.
   * Letting `init` run off the end of it returns the sum of every weight — a
   * full bar — which is what "Start to fetch params", the very first thing
   * WebLLM says, used to produce.
   */
  function baseFor(p) {
    if (p === PHASE.INIT) return 0;
    if (p === PHASE.DONE) return 1;
    let base = 0;
    for (const candidate of [PHASE.DOWNLOAD, PHASE.CACHE, PHASE.SHADERS]) {
      if (candidate === p) return base;
      base += weights[candidate] || 0;
    }
    return base;
  }

  /**
   * Reweight when reality contradicts the prediction.
   *
   * `isCached()` is a hint, not a contract — a partially populated cache
   * downloads the missing shards anyway — so the bar has to cope with being
   * wrong without lurching.
   */
  function reconcileWeights(next) {
    if (next === PHASE.DOWNLOAD && !sawDownload) {
      sawDownload = true;
      if ((weights.download || 0) === 0) weights = { ...WEIGHTS_FIRST_RUN };
    }
    if (next === PHASE.CACHE && !sawDownload && (weights.download || 0) > 0) {
      // Straight to the GPU pass: the weights were already on disk.
      weights = { ...WEIGHTS_CACHED };
    }
  }

  function snapshot() {
    const at = now();
    const elapsedMs = at - startedAt;
    const sinceReportMs = at - lastAt;
    // Count the estimate down between reports. WebLLM speaks once per shard —
    // several seconds apart — and a number that sits frozen reads as a hang.
    const etaMs =
      etaAtReport === null ? null : Math.max(0, etaAtReport - (at - etaReportedAt));

    return {
      sinceReportMs,
      phase,
      phaseLabel: PHASE_LABELS[phase] || PHASE_LABELS[PHASE.INIT],
      detail,
      overall,
      phaseFraction,
      elapsedMs,
      fetchedBytes,
      totalBytes,
      bytesPerSecond: byteRate === null ? null : byteRate * 1000,
      // An estimate that has run out is no longer an estimate. Once the clock
      // has overtaken it the honest answer is "I no longer know", not "a few
      // seconds left" repeated indefinitely at someone on a stalled connection.
      etaMs:
        elapsedMs < MIN_ELAPSED_FOR_ETA_MS || overall < MIN_PROGRESS_FOR_ETA || etaMs === 0
          ? null
          : etaMs,
      stalled: sinceReportMs >= STALL_AFTER_MS && overall < 1,
      shard,
      firstRun: sawDownload,
    };
  }

  return {
    /**
     * Feed in one WebLLM progress report.
     * @param {{progress?: number, text?: string, timeElapsed?: number}} report
     */
    report(report = {}) {
      const parsed = parseProgressText(report.text);
      const at = now();

      if (PHASE_ORDER.indexOf(parsed.phase) >= PHASE_ORDER.indexOf(phase)) {
        reconcileWeights(parsed.phase);
        phase = parsed.phase;
      }

      // Prefer the parsed percentage: `progress` and the sentence come from the
      // same counters, but the sentence is the one that says which pass it is.
      const fraction =
        parsed.percent !== null && Number.isFinite(parsed.percent)
          ? parsed.percent / 100
          : Number.isFinite(report.progress)
            ? report.progress
            : phaseFraction;
      phaseFraction = Math.min(1, Math.max(0, fraction));

      shard = { index: parsed.index, count: parsed.count };
      detail =
        parsed.index !== null && parsed.count !== null ? `part ${parsed.index} of ${parsed.count}` : '';

      if (phase === PHASE.DOWNLOAD && parsed.megabytes !== null) {
        fetchedBytes = parsed.megabytes * 1024 * 1024;
        // WebLLM never states the total, but it states a percentage of it.
        if (phaseFraction > 0) totalBytes = Math.round(fetchedBytes / phaseFraction);
      }

      const next = phase === PHASE.DONE ? 1 : baseFor(phase) + phaseFraction * (weights[phase] || 0);
      // Monotonic. A pass restarting at 0% must not empty the bar.
      overall = Math.min(1, Math.max(overall, next));

      const dt = at - lastAt;
      if (dt > 0) {
        const dOverall = overall - lastOverall;
        if (dOverall > 0) {
          const inst = dOverall / dt;
          overallRate = overallRate === null ? inst : RATE_ALPHA * inst + (1 - RATE_ALPHA) * overallRate;
        }
        if (fetchedBytes !== null && lastFetchedBytes !== null && fetchedBytes > lastFetchedBytes) {
          const inst = (fetchedBytes - lastFetchedBytes) / dt;
          byteRate = byteRate === null ? inst : RATE_ALPHA * inst + (1 - RATE_ALPHA) * byteRate;
        }
      }

      etaAtReport = overallRate && overallRate > 0 ? (1 - overall) / overallRate : null;
      etaReportedAt = at;

      lastAt = at;
      lastOverall = overall;
      if (fetchedBytes !== null) lastFetchedBytes = fetchedBytes;

      return snapshot();
    },

    /** Refresh the time-derived fields without a new report. */
    tick: snapshot,
    snapshot,
  };
}
