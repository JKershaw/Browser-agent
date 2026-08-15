import { describe, expect, it } from 'vitest';
import {
  PHASE,
  PHASE_LABELS,
  WEIGHTS_CACHED,
  WEIGHTS_FIRST_RUN,
  createLoadTracker,
  parseProgressText,
} from '../../src/llm/progress.js';

/** The wording WebLLM actually emits, copied from its progress callback. */
const download = (i, n, mb, pct, secs) =>
  `Fetching param cache[${i}/${n}]: ${mb}MB fetched. ${pct}% completed, ${secs} secs elapsed.` +
  ' It can take a while when we first visit this page to populate the cache. Later refreshes will become faster.';
const cacheLoad = (i, n, mb, pct, secs) =>
  `Loading model from cache[${i}/${n}]: ${mb}MB loaded. ${pct}% completed, ${secs} secs elapsed.`;
const shaders = (i, n, pct, secs) => `Loading GPU shader modules[${i}/${n}]: ${pct}% completed, ${secs} secs elapsed.`;

describe('parseProgressText', () => {
  it('reads the download line', () => {
    expect(parseProgressText(download(24, 38, 612, 65, 108))).toEqual({
      phase: PHASE.DOWNLOAD,
      index: 24,
      count: 38,
      megabytes: 612,
      percent: 65,
      seconds: 108,
    });
  });

  it('reads the GPU upload line, which is worded differently', () => {
    expect(parseProgressText(cacheLoad(19, 38, 500, 50, 12))).toMatchObject({
      phase: PHASE.CACHE,
      index: 19,
      megabytes: 500,
      percent: 50,
    });
  });

  it('reads the shader line, which has no megabyte field', () => {
    // The trailing groups shift when the MB clause is absent; getting this
    // wrong reads "seconds elapsed" as a percentage.
    expect(parseProgressText(shaders(2, 3, 66, 9))).toEqual({
      phase: PHASE.SHADERS,
      index: 2,
      count: 3,
      megabytes: null,
      percent: 66,
      seconds: 9,
    });
  });

  it('recognises the start and finish lines', () => {
    expect(parseProgressText('Start to fetch params').phase).toBe(PHASE.INIT);
    expect(parseProgressText('Finish loading on WebGPU - Apple M2').phase).toBe(PHASE.DONE);
  });

  it('falls back to "preparing" for anything it does not recognise', () => {
    for (const text of ['', null, undefined, 'Something new in a future release']) {
      expect(parseProgressText(text).phase).toBe(PHASE.INIT);
      expect(parseProgressText(text).percent).toBeNull();
    }
  });
});

describe('createLoadTracker', () => {
  /** A clock the test drives by hand. */
  function clock(start = 1000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
  }

  it('stays at zero for WebLLM’s opening line', () => {
    // "Start to fetch params" is the first thing WebLLM says, before a single
    // byte has moved. Treating it as an unrecognised phase and letting it fall
    // through the weighting filled the bar completely, so the download then ran
    // its whole course behind a bar that already said 100%.
    const tracker = createLoadTracker({ now: () => 1000 });
    const snap = tracker.report({ text: 'Start to fetch params', progress: 0 });
    expect(snap.phase).toBe(PHASE.INIT);
    expect(snap.overall).toBe(0);
  });

  it('does not let an unrecognised opening line fill the bar either', () => {
    const tracker = createLoadTracker({ now: () => 1000 });
    expect(tracker.report({ text: 'Some future wording', progress: 0 }).overall).toBe(0);
  });

  it('maps three restarting passes onto one bar that never goes backwards', () => {
    const c = clock();
    const tracker = createLoadTracker({ now: c.now });
    const seen = [];
    const push = (text, progress) => {
      c.advance(1000);
      seen.push(tracker.report({ text, progress }).overall);
    };

    push(download(19, 38, 512, 50, 5), 0.5);
    push(download(38, 38, 1024, 100, 10), 1);
    // WebLLM's fraction drops back to 0.25 here. The bar must not.
    push(cacheLoad(10, 38, 256, 25, 11), 0.25);
    push(cacheLoad(38, 38, 1024, 100, 14), 1);
    push(shaders(1, 3, 33, 15), 0.33);
    push(shaders(3, 3, 100, 18), 1);

    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    expect(seen[0]).toBeCloseTo(WEIGHTS_FIRST_RUN.download / 2, 5);
    expect(seen[1]).toBeCloseTo(WEIGHTS_FIRST_RUN.download, 5);
    expect(seen.at(-1)).toBeCloseTo(1, 5);
  });

  it('gives the download the lion’s share of the bar on a first run', () => {
    const c = clock();
    const tracker = createLoadTracker({ now: c.now, expectDownload: true });
    c.advance(1000);
    const snap = tracker.report({ text: download(38, 38, 1024, 100, 10), progress: 1 });
    // Finishing the download is most of the way there, not a third of the way.
    expect(snap.overall).toBeCloseTo(0.8, 5);
  });

  it('reweights when the weights turn out to be cached after all', () => {
    const c = clock();
    const tracker = createLoadTracker({ now: c.now, expectDownload: true });
    c.advance(1000);
    // Straight to the GPU pass: nothing was downloaded.
    const snap = tracker.report({ text: cacheLoad(38, 38, 1024, 100, 3), progress: 1 });
    expect(snap.overall).toBeCloseTo(WEIGHTS_CACHED.cache, 5);
    expect(snap.firstRun).toBe(false);
  });

  it('reweights when a supposedly cached model downloads anyway', () => {
    const c = clock();
    // isCached() is a hint: a partly populated cache still fetches the rest.
    const tracker = createLoadTracker({ now: c.now, expectDownload: false });
    c.advance(1000);
    const snap = tracker.report({ text: download(19, 38, 512, 50, 5), progress: 0.5 });
    expect(snap.overall).toBeCloseTo(WEIGHTS_FIRST_RUN.download / 2, 5);
    expect(snap.firstRun).toBe(true);
  });

  it('derives the download total from the bytes and the percentage', () => {
    const c = clock();
    const tracker = createLoadTracker({ now: c.now });
    c.advance(1000);
    const snap = tracker.report({ text: download(24, 38, 500, 50, 10), progress: 0.5 });
    expect(snap.fetchedBytes).toBe(500 * 1024 * 1024);
    expect(snap.totalBytes).toBe(1000 * 1024 * 1024);
    expect(snap.detail).toBe('part 24 of 38');
  });

  it('measures the transfer rate on its own clock', () => {
    const c = clock();
    const tracker = createLoadTracker({ now: c.now });
    c.advance(1000);
    tracker.report({ text: download(1, 38, 100, 10, 1), progress: 0.1 });
    c.advance(1000);
    // 100 MB in one second.
    const snap = tracker.report({ text: download(2, 38, 200, 20, 2), progress: 0.2 });
    expect(snap.bytesPerSecond).toBeCloseTo(100 * 1024 * 1024, -3);
  });

  it('withholds an estimate until it has seen enough to make one', () => {
    const c = clock();
    const tracker = createLoadTracker({ now: c.now });
    c.advance(500);
    expect(tracker.report({ text: download(1, 38, 10, 1, 1), progress: 0.01 }).etaMs).toBeNull();

    c.advance(9500);
    const snap = tracker.report({ text: download(10, 38, 250, 25, 10), progress: 0.25 });
    expect(snap.etaMs).toBeGreaterThan(0);
  });

  it('estimates a remaining time in the right ballpark', () => {
    const c = clock();
    const tracker = createLoadTracker({ now: c.now });
    // A steady 10% of the download every 10 s. The download is 80% of the bar,
    // so at the halfway mark there should be roughly 60 s of work left.
    for (let i = 1; i <= 5; i += 1) {
      c.advance(10_000);
      tracker.report({ text: download(i, 38, i * 100, i * 10, i * 10), progress: i / 10 });
    }
    const eta = tracker.snapshot().etaMs;
    expect(eta).toBeGreaterThan(40_000);
    expect(eta).toBeLessThan(90_000);
  });

  it('counts the estimate down between reports, so it never looks frozen', () => {
    const c = clock();
    const tracker = createLoadTracker({ now: c.now });
    for (let i = 1; i <= 5; i += 1) {
      c.advance(10_000);
      tracker.report({ text: download(i, 38, i * 100, i * 10, i * 10), progress: i / 10 });
    }
    const first = tracker.tick();
    c.advance(5000);
    const later = tracker.tick();

    expect(later.etaMs).toBeCloseTo(first.etaMs - 5000, -2);
    expect(later.elapsedMs).toBe(first.elapsedMs + 5000);
    // Ticking reports time passing, not progress being made.
    expect(later.overall).toBe(first.overall);
  });

  it('withdraws the estimate rather than counting it below zero', () => {
    const c = clock();
    const tracker = createLoadTracker({ now: c.now });
    for (let i = 1; i <= 5; i += 1) {
      c.advance(10_000);
      tracker.report({ text: download(i, 38, i * 100, i * 10, i * 10), progress: i / 10 });
    }
    // Overrun. An estimate that has expired is no longer an estimate, and the
    // UI shows "estimating…" rather than "a few seconds left" indefinitely.
    c.advance(10 * 60 * 1000);
    expect(tracker.tick().etaMs).toBeNull();
  });

  it('labels each phase in words', () => {
    const c = clock();
    const tracker = createLoadTracker({ now: c.now });
    c.advance(1000);
    expect(tracker.report({ text: download(1, 38, 10, 5, 1) }).phaseLabel).toBe(PHASE_LABELS[PHASE.DOWNLOAD]);
    c.advance(1000);
    expect(tracker.report({ text: cacheLoad(1, 38, 10, 5, 1) }).phaseLabel).toBe(PHASE_LABELS[PHASE.CACHE]);
    c.advance(1000);
    expect(tracker.report({ text: shaders(1, 3, 5, 1) }).phaseLabel).toBe(PHASE_LABELS[PHASE.SHADERS]);
    c.advance(1000);
    expect(tracker.report({ text: 'Finish loading on WebGPU' }).phaseLabel).toBe(PHASE_LABELS[PHASE.DONE]);
  });

  it('ignores a late report from a phase already left behind', () => {
    const c = clock();
    const tracker = createLoadTracker({ now: c.now });
    c.advance(1000);
    tracker.report({ text: shaders(2, 3, 66, 9) });
    c.advance(1000);
    // The four parallel download loops can emit out of order at a boundary.
    const snap = tracker.report({ text: download(38, 38, 1024, 100, 10) });
    expect(snap.phase).toBe(PHASE.SHADERS);
  });

  it('falls back to the raw fraction when the text is unrecognised', () => {
    const c = clock();
    const tracker = createLoadTracker({ now: c.now, expectDownload: false });
    c.advance(1000);
    tracker.report({ text: cacheLoad(1, 38, 10, 10, 1), progress: 0.1 });
    c.advance(1000);
    const snap = tracker.report({ text: 'A wording nobody has seen before', progress: 0.9 });
    // Phase held; the number still moved.
    expect(snap.phase).toBe(PHASE.CACHE);
    expect(snap.overall).toBeGreaterThan(0.1 * WEIGHTS_CACHED.cache);
  });

  it('starts from a sane snapshot before anything has been reported', () => {
    const snap = createLoadTracker({ now: () => 0 }).snapshot();
    expect(snap).toMatchObject({
      phase: PHASE.INIT,
      overall: 0,
      etaMs: null,
      fetchedBytes: null,
      totalBytes: null,
      bytesPerSecond: null,
    });
  });

  it('clamps a nonsensical fraction rather than propagating it', () => {
    const c = clock();
    const tracker = createLoadTracker({ now: c.now });
    c.advance(1000);
    const snap = tracker.report({ text: 'unknown', progress: 4 });
    expect(snap.phaseFraction).toBe(1);
    expect(snap.overall).toBeLessThanOrEqual(1);
  });
});

describe('a stalled load', () => {
  function stalledTracker() {
    let t = 1000;
    const tracker = createLoadTracker({ now: () => t });
    for (let i = 1; i <= 5; i += 1) {
      t += 10_000;
      tracker.report({ text: download(i, 38, i * 100, i * 10, i * 10), progress: i / 10 });
    }
    return { tracker, advance: (ms) => { t += ms; } };
  }

  it('is not flagged while reports keep arriving', () => {
    const { tracker, advance } = stalledTracker();
    advance(3000);
    expect(tracker.tick().stalled).toBe(false);
  });

  it('is flagged once the engine has gone quiet for long enough', () => {
    const { tracker, advance } = stalledTracker();
    advance(25_000);
    const snap = tracker.tick();
    expect(snap.stalled).toBe(true);
    expect(snap.sinceReportMs).toBe(25_000);
  });

  it('stops claiming an estimate it has already overrun', () => {
    const { tracker, advance } = stalledTracker();
    advance(10 * 60 * 1000);
    // "a few seconds left", repeated for ten minutes, is worse than admitting
    // the estimate has expired.
    expect(tracker.tick().etaMs).toBeNull();
  });

  it('is never flagged once the load has finished', () => {
    let t = 1000;
    const tracker = createLoadTracker({ now: () => t });
    t += 1000;
    tracker.report({ text: 'Finish loading on WebGPU', progress: 1 });
    t += 60_000;
    expect(tracker.tick().stalled).toBe(false);
  });
});
