import { describe, it, expect, vi } from 'vitest';
import { assertEngine } from '../../src/llm/engine.js';
import {
  EXTRA_MODELS,
  MODEL_TIERS,
  createWebLLMEngine,
  downloadBytesFor,
  looksMobile,
  pickDefaultModel,
  smallerModelsThan,
} from '../../src/llm/webllm.js';

/** Fake `@mlc-ai/web-llm` module. */
function fakeModule({ chunks = [{ choices: [{ delta: { content: 'hi' } }] }], failCache = false } = {}) {
  const inner = {
    unload: vi.fn(async () => {}),
    interruptGenerate: vi.fn(),
    chat: {
      completions: {
        create: vi.fn(async () => ({
          async *[Symbol.asyncIterator]() {
            for (const c of chunks) yield c;
          },
        })),
      },
    },
  };
  return {
    inner,
    module: {
      prebuiltAppConfig: { model_list: [{ model_id: 'A', vram_required_MB: 100, low_resource_required: true }] },
      hasModelInCache: failCache ? async () => { throw new Error('no cache api'); } : async (id) => id === 'cached-model',
      deleteModelAllInfoInCache: vi.fn(async () => {}),
      CreateMLCEngine: vi.fn(async (id, cfg) => {
        cfg.initProgressCallback?.({ progress: 0.5, text: 'fetching' });
        cfg.initProgressCallback?.({ text: 'no progress field' });
        return inner;
      }),
    },
  };
}

const engineWith = (fake, navOverride) =>
  createWebLLMEngine({ importWebLLM: async () => fake.module, navigator: navOverride ?? { gpu: {} } });

describe('model tiers', () => {
  it('matches the three tiers in the spec', () => {
    expect(MODEL_TIERS.map((m) => m.tier)).toEqual(['default', 'small', 'tiny']);
    expect(MODEL_TIERS.map((m) => m.id)).toEqual([
      'Qwen3-4B-q4f16_1-MLC', 'Qwen3-1.7B-q4f16_1-MLC', 'Qwen3-0.6B-q4f16_1-MLC',
    ]);
  });

  it('orders tiers from largest to smallest', () => {
    const vram = MODEL_TIERS.map((m) => m.vramMb);
    expect(vram).toEqual([...vram].sort((a, b) => b - a));
  });

  it('offers newer models without making them default', () => {
    expect(EXTRA_MODELS.length).toBeGreaterThan(0);
    expect(EXTRA_MODELS.map((m) => m.id)).not.toContain(MODEL_TIERS[0].id);
  });
});

describe('pickDefaultModel', () => {
  it('picks the 4B default on a capable desktop', () => {
    const r = pickDefaultModel({ lowMemory: false, deviceMemoryGb: 16 }, false);
    expect(r.id).toBe('Qwen3-4B-q4f16_1-MLC');
    expect(r.reason).toBe('');
  });

  it('pre-selects the small model on a constrained device and explains why', () => {
    const r = pickDefaultModel({ lowMemory: true, deviceMemoryGb: 4 });
    expect(r.id).toBe('Qwen3-1.7B-q4f16_1-MLC');
    expect(r.reason).toContain('memory-constrained');
  });

  it('pre-selects the small model on mobile', () => {
    const r = pickDefaultModel({ lowMemory: false, deviceMemoryGb: 8 }, true);
    expect(r.id).toBe('Qwen3-1.7B-q4f16_1-MLC');
    expect(r.reason).toContain('Mobile');
  });

  it('drops to the tiny model on a very small device', () => {
    const r = pickDefaultModel({ deviceMemoryGb: 2, lowMemory: true });
    expect(r.id).toBe('Qwen3-0.6B-q4f16_1-MLC');
    expect(r.reason).toContain('2 GB');
  });

  it('defaults sensibly with no capability information', () => {
    expect(pickDefaultModel().id).toBe('Qwen3-4B-q4f16_1-MLC');
    expect(pickDefaultModel({ deviceMemoryGb: null, lowMemory: false }).id).toBe('Qwen3-4B-q4f16_1-MLC');
  });
});

describe('looksMobile', () => {
  it.each([
    ['Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile', true],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', true],
    ['Mozilla/5.0 (iPad; CPU OS 17_0)', true],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120', false],
    ['', false],
  ])('%s -> %s', (ua, expected) => {
    expect(looksMobile(ua)).toBe(expected);
  });
});

describe('createWebLLMEngine', () => {
  it('satisfies the engine contract', () => {
    expect(() => assertEngine(engineWith(fakeModule()))).not.toThrow();
  });

  it('reports availability from navigator.gpu', async () => {
    expect((await engineWith(fakeModule()).capabilities()).available).toBe(true);
    const without = await engineWith(fakeModule(), {}).capabilities();
    expect(without.available).toBe(false);
    expect(without.reason).toContain('WebGPU');
  });

  it('lazily imports the module only when needed', async () => {
    const importWebLLM = vi.fn(async () => fakeModule().module);
    const e = createWebLLMEngine({ importWebLLM, navigator: { gpu: {} } });
    await e.capabilities();
    expect(importWebLLM).not.toHaveBeenCalled();
    await e.catalog();
    expect(importWebLLM).toHaveBeenCalledTimes(1);
    await e.catalog();
    expect(importWebLLM).toHaveBeenCalledTimes(1); // memoised
  });

  it('exposes the prebuilt catalog', async () => {
    expect(await engineWith(fakeModule()).catalog()).toEqual([{ id: 'A', vramMb: 100, lowResource: true }]);
  });

  it('reports cache status and survives a missing Cache API', async () => {
    const e = engineWith(fakeModule());
    expect(await e.isCached('cached-model')).toBe(true);
    expect(await e.isCached('other')).toBe(false);
    expect(await engineWith(fakeModule({ failCache: true })).isCached('x')).toBe(false);
  });

  it('loads a model and forwards progress', async () => {
    const fake = fakeModule();
    const e = engineWith(fake);
    const progress = [];
    await e.load('Qwen3-0.6B-q4f16_1-MLC', (p) => progress.push(p));
    expect(fake.module.CreateMLCEngine).toHaveBeenCalledWith('Qwen3-0.6B-q4f16_1-MLC', expect.any(Object));
    expect(progress[0]).toEqual({ progress: 0.5, text: 'fetching', timeElapsed: null });
    expect(progress[1]).toEqual({ progress: 0, text: 'no progress field', timeElapsed: null });
    expect(e.stats().modelId).toBe('Qwen3-0.6B-q4f16_1-MLC');
  });

  it('unloads a previous model before loading another', async () => {
    const fake = fakeModule();
    const e = engineWith(fake);
    await e.load('a');
    await e.load('b');
    expect(fake.inner.unload).toHaveBeenCalledTimes(1);
    expect(e.stats().modelId).toBe('b');
  });

  it('refuses to generate before a model is loaded', async () => {
    await expect(engineWith(fakeModule()).generate([])).rejects.toThrow(/No model is loaded/);
  });

  it('streams deltas and returns the joined text', async () => {
    const fake = fakeModule({
      chunks: [
        { choices: [{ delta: { content: 'Hello ' } }] },
        { choices: [{ delta: { content: 'world' } }] },
        { choices: [], usage: { total_tokens: 12, extra: { prefill_tokens_per_s: 500, decode_tokens_per_s: 40 } } },
      ],
    });
    const e = engineWith(fake);
    await e.load('m');
    const deltas = [];
    const text = await e.generate([{ role: 'user', content: 'hi' }], { onDelta: (d) => deltas.push(d) });
    expect(text).toBe('Hello world');
    expect(deltas).toEqual(['Hello ', 'world']);
    expect(e.stats()).toMatchObject({ prefillTokensPerSecond: 500, decodeTokensPerSecond: 40, totalTokens: 12 });
  });

  it('requests usage stats and disables thinking by default', async () => {
    const fake = fakeModule();
    const e = engineWith(fake);
    await e.load('m');
    await e.generate([], { temperature: 0.3, maxTokens: 256 });
    const req = fake.inner.chat.completions.create.mock.calls[0][0];
    expect(req).toMatchObject({ stream: true, temperature: 0.3, max_tokens: 256 });
    expect(req.stream_options).toEqual({ include_usage: true });
    expect(req.extra_body).toEqual({ enable_thinking: false });
  });

  it('leaves thinking enabled when asked', async () => {
    const fake = fakeModule();
    const e = engineWith(fake);
    await e.load('m');
    await e.generate([], { thinking: true });
    expect(fake.inner.chat.completions.create.mock.calls[0][0].extra_body).toBeUndefined();
  });

  it('throws immediately for an already-aborted signal', async () => {
    const e = engineWith(fakeModule());
    await e.load('m');
    const c = new AbortController();
    c.abort();
    await expect(e.generate([], { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('interrupts generation and raises AbortError when cancelled mid-stream', async () => {
    const c = new AbortController();
    const fake = fakeModule({
      chunks: [
        { choices: [{ delta: { content: 'a' } }] },
        { choices: [{ delta: { content: 'b' } }] },
      ],
    });
    // Abort as soon as the first chunk lands.
    fake.inner.chat.completions.create = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: 'a' } }] };
        c.abort();
        yield { choices: [{ delta: { content: 'b' } }] };
      },
    }));
    const e = engineWith(fake);
    await e.load('m');
    await expect(e.generate([], { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.inner.interruptGenerate).toHaveBeenCalled();
  });

  it('survives interruptGenerate throwing after generation finished', async () => {
    const fake = fakeModule();
    fake.inner.interruptGenerate = vi.fn(() => { throw new Error('nothing running'); });
    const e = engineWith(fake);
    await e.load('m');
    const c = new AbortController();
    const p = e.generate([], { signal: c.signal });
    await p;
    expect(() => c.abort()).not.toThrow();
  });

  it('ignores chunks with no content', async () => {
    const fake = fakeModule({ chunks: [{ choices: [{ delta: {} }] }, { choices: [] }] });
    const e = engineWith(fake);
    await e.load('m');
    expect(await e.generate([])).toBe('');
  });

  it('unload clears engine state', async () => {
    const fake = fakeModule();
    const e = engineWith(fake);
    await e.load('m');
    await e.unload();
    expect(e.stats().modelId).toBeNull();
    await expect(e.generate([])).rejects.toThrow(/No model is loaded/);
    await e.unload(); // idempotent
  });

  it('reports null throughput before any generation', async () => {
    const e = engineWith(fakeModule());
    await e.load('m');
    expect(e.stats()).toMatchObject({ prefillTokensPerSecond: null, decodeTokensPerSecond: null, totalTokens: 0 });
  });
});

describe('downloadBytesFor', () => {
  it('knows the size of every model it offers, so the storage check can run', () => {
    for (const model of [...MODEL_TIERS, ...EXTRA_MODELS]) {
      expect(downloadBytesFor(model.id)).toBeGreaterThan(0);
    }
  });

  it('agrees with the size printed in the picker', () => {
    // A mismatch here would warn about the wrong number of gigabytes.
    for (const model of [...MODEL_TIERS, ...EXTRA_MODELS]) {
      const printed = Number(model.approxDownload.replace(/[^\d.]/g, ''));
      expect(downloadBytesFor(model.id) / 1024 ** 3).toBeCloseTo(printed, 5);
    }
  });

  it('returns null for an id typed into the advanced field', () => {
    // Guessing here would either block a load that would work or wave through
    // one that cannot; "unknown" is the honest answer.
    expect(downloadBytesFor('Some-Other-Model-MLC')).toBeNull();
    expect(downloadBytesFor('')).toBeNull();
  });
});

describe('deleteFromCache', () => {
  it('asks WebLLM to drop every trace of a model', async () => {
    const fake = fakeModule();
    expect(await engineWith(fake).deleteFromCache('Qwen3-4B-q4f16_1-MLC')).toBe(true);
    expect(fake.module.deleteModelAllInfoInCache).toHaveBeenCalledWith('Qwen3-4B-q4f16_1-MLC');
  });

  it('reports failure rather than throwing at someone already out of space', async () => {
    const fake = fakeModule();
    fake.module.deleteModelAllInfoInCache = async () => { throw new Error('cache locked'); };
    expect(await engineWith(fake).deleteFromCache('x')).toBe(false);
  });

  it('reports false when the installed WebLLM has no such helper', async () => {
    const fake = fakeModule();
    delete fake.module.deleteModelAllInfoInCache;
    expect(await engineWith(fake).deleteFromCache('x')).toBe(false);
  });
});

describe('smallerModelsThan', () => {
  it('excludes the model itself and anything larger', () => {
    expect(smallerModelsThan('Qwen3-1.7B-q4f16_1-MLC').map((m) => m.id)).toEqual(['Qwen3-0.6B-q4f16_1-MLC']);
    expect(smallerModelsThan('Qwen3-4B-q4f16_1-MLC').map((m) => m.id)).toEqual([
      'Qwen3-1.7B-q4f16_1-MLC',
      'Qwen3-0.6B-q4f16_1-MLC',
    ]);
  });

  it('returns nothing for the smallest tier, so the advice can say so', () => {
    expect(smallerModelsThan('Qwen3-0.6B-q4f16_1-MLC')).toEqual([]);
  });

  it('offers every tier for an id it does not recognise', () => {
    // An advanced id could be any size; the known-small options are still the
    // most useful thing to put in front of someone.
    expect(smallerModelsThan('Some-Advanced-Model-MLC')).toHaveLength(MODEL_TIERS.length);
  });

  it('orders them largest first, so the least drastic option comes first', () => {
    const sizes = smallerModelsThan('Qwen3.5-4B-q4f16_1-MLC').map((m) => downloadBytesFor(m.id));
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it('carries the label and size the advice quotes', () => {
    const [first] = smallerModelsThan('Qwen3-4B-q4f16_1-MLC');
    expect(first).toMatchObject({ label: expect.stringContaining('Qwen3 1.7B'), approxDownload: '~1 GB' });
  });
});
