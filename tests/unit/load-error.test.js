import { describe, expect, it } from 'vitest';
import {
  LoadErrorKind,
  buildDebugReport,
  classifyLoadError,
  describeError,
  diagnoseLoadError,
} from '../../src/llm/load-error.js';

const GB = 1024 ** 3;

/** The error this whole module was written for, reproduced exactly. */
function cacheEntryNotFound() {
  const e = new Error("Failed to execute 'add' on 'Cache': Entry was not found.");
  e.name = 'NotFoundError';
  return e;
}

const named = (name, message) => {
  const e = new Error(message);
  e.name = name;
  return e;
};

describe('describeError', () => {
  it('keeps the name when it carries information', () => {
    expect(describeError(named('QuotaExceededError', 'Quota exceeded.'))).toBe('QuotaExceededError: Quota exceeded.');
  });

  it('drops a bare "Error" prefix that tells the reader nothing', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('copes with things that are not errors', () => {
    expect(describeError('a string')).toBe('a string');
    expect(describeError(null)).toBe('Unknown error');
    expect(describeError(undefined)).toBe('Unknown error');
  });
});

describe('classifyLoadError', () => {
  it('recognises the reported failure as a cache write, not a mystery', () => {
    expect(classifyLoadError(cacheEntryNotFound())).toBe(LoadErrorKind.CACHE_WRITE);
  });

  it('recognises an explicit quota refusal', () => {
    expect(classifyLoadError(named('QuotaExceededError', 'Quota exceeded.'))).toBe(LoadErrorKind.STORAGE_FULL);
    expect(classifyLoadError(new Error('The quota has been exceeded.'))).toBe(LoadErrorKind.STORAGE_FULL);
  });

  it('separates a network failure that happens to mention storage', () => {
    // WebLLM's IndexedDB backend wraps fetch failures in a "Failed to store"
    // message. Reading that as a storage problem would send the user off
    // deleting files to fix their wifi.
    expect(
      classifyLoadError(new Error('Failed to store https://host/params_shard_3.bin with error: Error: Network response was not ok'))
    ).toBe(LoadErrorKind.NETWORK);
    expect(classifyLoadError(new TypeError('Failed to fetch'))).toBe(LoadErrorKind.NETWORK);
    expect(classifyLoadError(new Error('net::ERR_CONNECTION_RESET'))).toBe(LoadErrorKind.NETWORK);
  });

  it('recognises a generic cache-write failure as storage', () => {
    expect(classifyLoadError(new Error("Failed to execute 'put' on 'Cache': unexpected"))).toBe(LoadErrorKind.CACHE_WRITE);
  });

  it('recognises GPU memory and device loss', () => {
    expect(classifyLoadError(new Error('Out of memory while creating buffer'))).toBe(LoadErrorKind.GPU_MEMORY);
    expect(classifyLoadError(new Error('requested size exceeds the max buffer size'))).toBe(LoadErrorKind.GPU_MEMORY);
    expect(classifyLoadError(named('DeviceLostError', 'device was lost'))).toBe(LoadErrorKind.DEVICE_LOST);
  });

  it('recognises a bad model id', () => {
    expect(classifyLoadError(named('ModelNotFoundError', 'Cannot find model record'))).toBe(LoadErrorKind.MODEL_UNKNOWN);
  });

  it('recognises cancellation', () => {
    expect(classifyLoadError(named('AbortError', 'aborted'))).toBe(LoadErrorKind.ABORTED);
  });

  it('recognises WebGPU disappearing mid-session', () => {
    expect(classifyLoadError(named('WebGPUNotAvailableError', 'WebGPU is not available'))).toBe(
      LoadErrorKind.WEBGPU_MISSING
    );
  });

  it('admits when it does not know', () => {
    expect(classifyLoadError(new Error('something entirely new'))).toBe(LoadErrorKind.UNKNOWN);
    expect(classifyLoadError(null)).toBe(LoadErrorKind.UNKNOWN);
  });
});

describe('diagnoseLoadError', () => {
  const tightPhone = {
    modelId: 'Qwen3-1.7B-q4f16_1-MLC',
    modelBytes: 1 * GB,
    storage: { supported: true, usageBytes: 5.6 * GB, quotaBytes: 5.9 * GB, freeBytes: 0.3 * GB, persisted: false },
    snapshot: {
      phase: 'download',
      phaseLabel: 'Downloading the model',
      overall: 0.52,
      fetchedBytes: 0.65 * GB,
      totalBytes: 1 * GB,
      elapsedMs: 108_000,
      detail: 'part 24 of 38',
    },
    caps: { deviceMemoryGb: 4, maxBufferBytes: 1_073_741_824, lowMemory: true },
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/126',
    pageUrl: 'https://www.jkershaw.com/Browser-agent/',
    timestamp: '2026-08-15T10:00:00.000Z',
  };

  it('names storage as the cause and quotes the numbers behind that claim', () => {
    const d = diagnoseLoadError(cacheEntryNotFound(), tightPhone);
    expect(d.kind).toBe(LoadErrorKind.CACHE_WRITE);
    expect(d.title).toMatch(/could not store/i);
    expect(d.explain).toMatch(/307 MB of storage left/);
    expect(d.explain).toMatch(/about 1\.00 GB/);
    // The bit the old message never said: it commits to a cause.
    expect(d.explain).toMatch(/almost certainly the whole story/);
    expect(d.explain).toMatch(/disappeared underneath it/);
  });

  it('offers actions that match the diagnosis', () => {
    const d = diagnoseLoadError(cacheEntryNotFound(), tightPhone);
    expect(d.actions).toMatchObject({ retry: true, smallerModel: true, freeSpace: true });
    expect(d.advice.join(' ')).toMatch(/Free up space/);
    expect(d.advice.join(' ')).toMatch(/carries on from where this one stopped/);
  });

  it('changes its story when the measurements say there is plenty of room', () => {
    const d = diagnoseLoadError(cacheEntryNotFound(), {
      ...tightPhone,
      storage: { supported: true, usageBytes: 1 * GB, quotaBytes: 60 * GB, freeBytes: 59 * GB, persisted: true },
    });
    // Same error, different evidence, different conclusion — which is the
    // point of measuring rather than assuming.
    expect(d.advice.join(' ')).toMatch(/damaged cache/);
    expect(d.advice.join(' ')).not.toMatch(/Free up space/);
    expect(d.actions.clearData).toBe(true);
  });

  it('does not quote storage numbers it does not have', () => {
    const d = diagnoseLoadError(cacheEntryNotFound(), {
      modelId: 'x',
      storage: { supported: false, reason: 'unsupported' },
    });
    expect(d.explain).not.toMatch(/storage left/);
    expect(d.kind).toBe(LoadErrorKind.CACHE_WRITE);
  });

  it('treats an almost-empty allowance as damning even with no model size', () => {
    const d = diagnoseLoadError(cacheEntryNotFound(), {
      storage: { supported: true, usageBytes: 1, quotaBytes: 2, freeBytes: 10 * 1024 * 1024 },
    });
    expect(d.advice.join(' ')).toMatch(/Free up space/);
  });

  it('sends a network failure somewhere useful instead of to storage', () => {
    const d = diagnoseLoadError(new TypeError('Failed to fetch'), tightPhone);
    expect(d.kind).toBe(LoadErrorKind.NETWORK);
    expect(d.actions.freeSpace).toBe(false);
    expect(d.explain).toMatch(/connection/i);
  });

  it('sends a GPU memory failure to the model picker, not the storage advice', () => {
    const d = diagnoseLoadError(new Error('Out of memory'), tightPhone);
    expect(d.kind).toBe(LoadErrorKind.GPU_MEMORY);
    expect(d.actions).toMatchObject({ smallerModel: true, freeSpace: false });
  });

  it('has an answer for every kind it can classify', () => {
    const samples = {
      [LoadErrorKind.ABORTED]: named('AbortError', 'aborted'),
      [LoadErrorKind.MODEL_UNKNOWN]: named('ModelNotFoundError', 'Cannot find model'),
      [LoadErrorKind.WEBGPU_MISSING]: named('WebGPUNotAvailableError', 'WebGPU is not available'),
      [LoadErrorKind.DEVICE_LOST]: named('DeviceLostError', 'device was lost'),
      [LoadErrorKind.GPU_MEMORY]: new Error('out of memory'),
      [LoadErrorKind.STORAGE_FULL]: named('QuotaExceededError', 'Quota exceeded.'),
      [LoadErrorKind.CACHE_WRITE]: cacheEntryNotFound(),
      [LoadErrorKind.NETWORK]: new TypeError('Failed to fetch'),
      [LoadErrorKind.UNKNOWN]: new Error('mystery'),
    };
    for (const [kind, error] of Object.entries(samples)) {
      const d = diagnoseLoadError(error, tightPhone);
      expect(d.kind).toBe(kind);
      expect(d.title.length).toBeGreaterThan(10);
      expect(d.explain.length).toBeGreaterThan(30);
      expect(d.advice.length).toBeGreaterThan(0);
      expect(d.debug).toMatch(/Browser Agent — model load failure/);
    }
  });

  it('hands an unrecognised failure over verbatim rather than pretending', () => {
    const d = diagnoseLoadError(new Error('mystery'), tightPhone);
    expect(d.kind).toBe(LoadErrorKind.UNKNOWN);
    expect(d.raw).toBe('mystery');
    expect(d.explain).toMatch(/does not match anything this app knows/);
    // Still surfaces the storage evidence, because it was worth surfacing.
    expect(d.explain).toMatch(/307 MB of storage left/);
  });

  it('works with no context at all', () => {
    const d = diagnoseLoadError(cacheEntryNotFound());
    expect(d.kind).toBe(LoadErrorKind.CACHE_WRITE);
    expect(d.debug).toMatch(/Storage:\s+unavailable/);
  });
});

describe('buildDebugReport', () => {
  const context = {
    modelId: 'Qwen3-1.7B-q4f16_1-MLC',
    modelBytes: 1 * GB,
    kind: 'cache-write',
    storage: { supported: true, usageBytes: 5.6 * GB, quotaBytes: 5.9 * GB, freeBytes: 0.3 * GB, persisted: false },
    snapshot: {
      phaseLabel: 'Downloading the model',
      overall: 0.52,
      fetchedBytes: 0.65 * GB,
      totalBytes: 1 * GB,
      elapsedMs: 108_000,
      detail: 'part 24 of 38',
    },
    caps: { deviceMemoryGb: 4, maxBufferBytes: 1_073_741_824, lowMemory: true },
    userAgent: 'Chrome/126 Android',
    pageUrl: 'https://example.test/Browser-agent/',
    timestamp: '2026-08-15T10:00:00.000Z',
  };

  it('contains everything a bug report needs and nothing it has to be asked for', () => {
    const report = buildDebugReport(cacheEntryNotFound(), context);
    expect(report).toMatch(/Model:\s+Qwen3-1\.7B-q4f16_1-MLC \(about 1\.00 GB\)/);
    expect(report).toMatch(/Error:\s+NotFoundError: Failed to execute 'add' on 'Cache'/);
    expect(report).toMatch(/Failed at: Downloading the model — 52% overall, 666 MB of 1\.00 GB \(part 24 of 38\), after 1 m 48 s/);
    expect(report).toMatch(/Storage:\s+5\.60 GB used of 5\.90 GB granted, 307 MB free \(persistent: no\)/);
    expect(report).toMatch(/Device:\s+memory 4 GB, max GPU buffer 1\.00 GB, flagged low-memory true/);
    expect(report).toMatch(/Page:\s+https:\/\/example\.test\/Browser-agent\//);
    expect(report).toMatch(/Browser:\s+Chrome\/126 Android/);
  });

  it('includes a bounded amount of stack', () => {
    const e = cacheEntryNotFound();
    e.stack = ['Error: boom', ...Array.from({ length: 40 }, (_, i) => `  at frame${i}`)].join('\n');
    const lines = buildDebugReport(e, context).split('\n');
    const stackAt = lines.indexOf('Stack:');
    expect(stackAt).toBeGreaterThan(0);
    // Enough to locate the failure, not so much that nobody pastes it.
    expect(lines.length - stackAt - 1).toBeLessThanOrEqual(8);
  });

  it('says "unknown" for each thing it could not measure', () => {
    const report = buildDebugReport(new Error('x'), {});
    expect(report).toMatch(/Time:\s+unknown/);
    expect(report).toMatch(/Model:\s+unknown/);
    expect(report).toMatch(/Page:\s+unknown/);
    expect(report).toMatch(/Browser:\s+unknown/);
    expect(report).toMatch(/memory unknown GB/);
    expect(report).not.toMatch(/Failed at:/);
  });

  it('classifies for itself when no category was passed in', () => {
    expect(buildDebugReport(cacheEntryNotFound(), {})).toMatch(/Category:\s+cache-write/);
  });
});

describe('advice about switching model', () => {
  const base = {
    modelId: 'Qwen3-1.7B-q4f16_1-MLC',
    modelBytes: 1024 ** 3,
    storage: { supported: true, usageBytes: 5.6 * GB, quotaBytes: 5.9 * GB, freeBytes: 0.3 * GB },
  };

  it('names only models genuinely smaller than the one that failed', () => {
    const d = diagnoseLoadError(cacheEntryNotFound(), {
      ...base,
      smallerModels: [{ id: 'Qwen3-0.6B-q4f16_1-MLC', label: 'Qwen3 0.6B (tiny, fastest)', approxDownload: '~0.4 GB' }],
    });
    const advice = d.advice.join(' ');
    expect(advice).toMatch(/Qwen3 0\.6B needs about 0\.4 GB/);
    // Advising a switch to the model that just failed reads as advice written
    // without looking, and discredits everything around it.
    expect(advice).not.toMatch(/Qwen3 1\.7B needs/);
  });

  it('says so plainly when there is nothing smaller to switch to', () => {
    const d = diagnoseLoadError(cacheEntryNotFound(), { ...base, smallerModels: [] });
    expect(d.advice.join(' ')).toMatch(/already the smallest model on offer/);
    expect(d.actions.smallerModel).toBe(false);
  });

  it('withholds the smaller-model button on every kind when there is none', () => {
    for (const error of [
      cacheEntryNotFound(),
      named('QuotaExceededError', 'Quota exceeded.'),
      new TypeError('Failed to fetch'),
      new Error('out of memory'),
      new Error('mystery'),
    ]) {
      expect(diagnoseLoadError(error, { ...base, smallerModels: [] }).actions.smallerModel).toBe(false);
    }
  });

  it('stays generic when the caller did not say what is available', () => {
    const d = diagnoseLoadError(cacheEntryNotFound(), base);
    expect(d.advice.join(' ')).toMatch(/choose a smaller model in Settings/i);
    expect(d.actions.smallerModel).toBe(true);
  });

  it('leads with the measurement when the measurement settles it', () => {
    const d = diagnoseLoadError(cacheEntryNotFound(), base);
    // The sentence that answers "why did this happen" comes first, not after a
    // paragraph about Chromium internals that a phone user will not scroll to.
    expect(d.explain.startsWith('The browser says this site has 307 MB')).toBe(true);
  });

  it('leads with the mechanism when the measurement exonerates storage', () => {
    const d = diagnoseLoadError(cacheEntryNotFound(), {
      ...base,
      storage: { supported: true, usageBytes: 1 * GB, quotaBytes: 60 * GB, freeBytes: 59 * GB },
    });
    expect(d.explain.startsWith('The download itself was fine')).toBe(true);
  });
});
