import { describe, expect, it, vi } from 'vitest';
import {
  HEADROOM_FACTOR,
  checkHeadroom,
  describeStorage,
  estimateStorage,
  requestPersistence,
} from '../../src/llm/storage.js';

const GB = 1024 ** 3;

const navWith = (storage) => ({ storage });

describe('estimateStorage', () => {
  it('reports usage, quota and the free space between them', async () => {
    const est = await estimateStorage(
      navWith({ estimate: async () => ({ usage: 3 * GB, quota: 5 * GB }), persisted: async () => true })
    );
    expect(est).toMatchObject({
      supported: true,
      usageBytes: 3 * GB,
      quotaBytes: 5 * GB,
      freeBytes: 2 * GB,
      persisted: true,
    });
  });

  it('never reports negative free space when usage overshoots quota', async () => {
    const est = await estimateStorage(navWith({ estimate: async () => ({ usage: 6 * GB, quota: 5 * GB }) }));
    expect(est.freeBytes).toBe(0);
  });

  it('degrades to unsupported rather than throwing', async () => {
    expect((await estimateStorage(undefined)).supported).toBe(false);
    expect((await estimateStorage({})).supported).toBe(false);
    const est = await estimateStorage(navWith({ estimate: 'not a function' }));
    expect(est.supported).toBe(false);
    expect(est.reason).toMatch(/does not expose/);
  });

  it('survives estimate() rejecting', async () => {
    const est = await estimateStorage(navWith({
      estimate: async () => {
        throw new Error('denied');
      },
    }));
    expect(est.supported).toBe(false);
    expect(est.reason).toMatch(/denied/);
  });

  it('keeps the numbers when only persisted() fails', async () => {
    const est = await estimateStorage(navWith({
      estimate: async () => ({ usage: 1 * GB, quota: 4 * GB }),
      persisted: async () => {
        throw new Error('nope');
      },
    }));
    expect(est.freeBytes).toBe(3 * GB);
    expect(est.persisted).toBeNull();
  });

  it('tolerates an estimate with no usable numbers', async () => {
    const est = await estimateStorage(navWith({ estimate: async () => ({}) }));
    expect(est.supported).toBe(true);
    expect(est.usageBytes).toBeNull();
    expect(est.freeBytes).toBeNull();
  });
});

describe('requestPersistence', () => {
  it('returns null where the API is missing', async () => {
    expect(await requestPersistence(undefined)).toBeNull();
    expect(await requestPersistence({ storage: {} })).toBeNull();
  });

  it('does not ask again when persistence is already granted', async () => {
    const persist = vi.fn();
    expect(await requestPersistence(navWith({ persisted: async () => true, persist }))).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('asks when it is not, and reports a refusal as false', async () => {
    expect(await requestPersistence(navWith({ persisted: async () => false, persist: async () => false }))).toBe(false);
    expect(await requestPersistence(navWith({ persisted: async () => false, persist: async () => true }))).toBe(true);
  });

  it('treats a throwing implementation as unknown, not as a failure to load', async () => {
    const result = await requestPersistence(navWith({
      persist: async () => {
        throw new Error('blocked');
      },
    }));
    expect(result).toBeNull();
  });
});

describe('checkHeadroom', () => {
  it('calls it insufficient when the model simply does not fit', () => {
    const r = checkHeadroom({ freeBytes: 0.3 * GB, neededBytes: 1 * GB });
    expect(r.level).toBe('insufficient');
    expect(r.shortfallBytes).toBeGreaterThan(0.69 * GB);
    expect(r.message).toMatch(/307 MB more/);
    expect(r.message).toMatch(/717 MB short/);
    expect(r.message).toMatch(/smaller model/);
  });

  it('calls it tight when it fits but only just', () => {
    const r = checkHeadroom({ freeBytes: 1.05 * GB, neededBytes: 1 * GB });
    expect(r.level).toBe('tight');
    expect(r.shortfallBytes).toBeNull();
    expect(r.message).toMatch(/may just fit/);
  });

  it('is quiet when there is room', () => {
    expect(checkHeadroom({ freeBytes: 8 * GB, neededBytes: 1 * GB })).toEqual({
      level: 'ok',
      shortfallBytes: null,
      message: null,
    });
  });

  it('puts the boundary exactly where HEADROOM_FACTOR says', () => {
    const needed = 1 * GB;
    expect(checkHeadroom({ freeBytes: needed * HEADROOM_FACTOR, neededBytes: needed }).level).toBe('ok');
    expect(checkHeadroom({ freeBytes: needed * HEADROOM_FACTOR - 1, neededBytes: needed }).level).toBe('tight');
    expect(checkHeadroom({ freeBytes: needed, neededBytes: needed }).level).toBe('tight');
    expect(checkHeadroom({ freeBytes: needed - 1, neededBytes: needed }).level).toBe('insufficient');
  });

  it('says "unknown" rather than guessing when a number is missing', () => {
    for (const args of [
      {},
      { freeBytes: 1 * GB },
      { neededBytes: 1 * GB },
      { freeBytes: null, neededBytes: 1 * GB },
      { freeBytes: 1 * GB, neededBytes: 0 },
      { freeBytes: NaN, neededBytes: 1 * GB },
    ]) {
      expect(checkHeadroom(args).level).toBe('unknown');
    }
    expect(checkHeadroom().level).toBe('unknown');
  });
});

describe('describeStorage', () => {
  it('summarises a full estimate', () => {
    const text = describeStorage({
      supported: true,
      usageBytes: 3 * GB,
      quotaBytes: 5 * GB,
      freeBytes: 2 * GB,
      persisted: false,
    });
    expect(text).toBe('3.00 GB used of 5.00 GB granted, 2.00 GB free (persistent: no)');
  });

  it('is explicit about what it could not measure', () => {
    expect(describeStorage(null)).toMatch(/unavailable/);
    expect(describeStorage({ supported: false, reason: 'blocked' })).toBe('unavailable (blocked)');
    expect(describeStorage({ supported: true, usageBytes: null, quotaBytes: null })).toMatch(/without usable numbers/);
    expect(describeStorage({ supported: true, usageBytes: 1, quotaBytes: 2, freeBytes: 1, persisted: null }))
      .toMatch(/persistent: unknown/);
  });
});
