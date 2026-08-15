import { describe, it, expect, vi } from 'vitest';
import { ENGINE_METHODS, assertEngine, detectCapabilities, emptyStats } from '../../src/llm/engine.js';
import { createMockEngine } from '../../src/llm/mock.js';

describe('assertEngine', () => {
  it('accepts a complete engine', () => {
    expect(assertEngine(createMockEngine())).toBeTruthy();
  });

  it.each([null, undefined, 'engine', 42])('rejects non-object %s', (bad) => {
    expect(() => assertEngine(bad)).toThrow(/must be an object/);
  });

  it('names every missing method', () => {
    expect(() => assertEngine({ load: () => {} })).toThrow(/capabilities, generate, stats, unload/);
  });

  it('lists exactly the contract methods', () => {
    expect(ENGINE_METHODS).toEqual(['capabilities', 'load', 'generate', 'stats', 'unload']);
  });
});

describe('emptyStats', () => {
  it('is zeroed', () => {
    expect(emptyStats()).toEqual({
      prefillTokensPerSecond: null, decodeTokensPerSecond: null, totalTokens: 0, modelId: null,
    });
    expect(emptyStats('m').modelId).toBe('m');
  });
});

describe('detectCapabilities', () => {
  it('reports missing navigator', async () => {
    // `undefined` would fall back to the real navigator via the default
    // parameter, so pass null to model an environment with none.
    const r = await detectCapabilities(null);
    expect(r.webgpu).toBe(false);
    expect(r.reason).toContain('No navigator');
  });

  it('reports absent WebGPU', async () => {
    const r = await detectCapabilities({ deviceMemory: 8 });
    expect(r.webgpu).toBe(false);
    expect(r.reason).toContain('navigator.gpu is missing');
    expect(r.deviceMemoryGb).toBe(8);
    expect(r.lowMemory).toBe(false);
  });

  it('flags low memory even without WebGPU', async () => {
    expect((await detectCapabilities({ deviceMemory: 2 })).lowMemory).toBe(true);
  });

  it('reports a rejected adapter request', async () => {
    const nav = { gpu: { requestAdapter: async () => { throw new Error('policy blocked'); } } };
    const r = await detectCapabilities(nav);
    expect(r.webgpu).toBe(false);
    expect(r.reason).toContain('policy blocked');
  });

  it('reports a null adapter (headless / blocklisted GPU)', async () => {
    const r = await detectCapabilities({ gpu: { requestAdapter: async () => null } });
    expect(r.webgpu).toBe(false);
    expect(r.reason).toContain('no GPU adapter was granted');
  });

  it('reports a healthy adapter', async () => {
    const nav = { deviceMemory: 16, gpu: { requestAdapter: async () => ({ limits: { maxBufferSize: 2_000_000_000 } }) } };
    const r = await detectCapabilities(nav);
    expect(r).toMatchObject({ webgpu: true, lowMemory: false, maxBufferBytes: 2_000_000_000, deviceMemoryGb: 16 });
  });

  it('flags low memory from a small max buffer size', async () => {
    const nav = { deviceMemory: 16, gpu: { requestAdapter: async () => ({ limits: { maxBufferSize: 100_000_000 } }) } };
    expect((await detectCapabilities(nav)).lowMemory).toBe(true);
  });

  it('flags low memory from a small deviceMemory', async () => {
    const nav = { deviceMemory: 4, gpu: { requestAdapter: async () => ({ limits: { maxBufferSize: 2_000_000_000 } }) } };
    expect((await detectCapabilities(nav)).lowMemory).toBe(true);
  });

  it('copes with an adapter that reports no limits', async () => {
    const r = await detectCapabilities({ gpu: { requestAdapter: async () => ({}) } });
    expect(r.webgpu).toBe(true);
    expect(r.maxBufferBytes).toBeNull();
    expect(r.lowMemory).toBe(false);
  });
});

describe('createMockEngine', () => {
  it('satisfies the engine contract', async () => {
    const e = createMockEngine();
    expect(assertEngine(e)).toBe(e);
    expect((await e.capabilities()).available).toBe(true);
  });

  it('reports load progress and remembers the model id', async () => {
    const e = createMockEngine();
    const progress = [];
    await e.load('mock-model', (p) => progress.push(p.progress));
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    // Not monotonic, on purpose: the fraction restarts at the top of each of
    // WebLLM's three passes, and the mock would be lying if it did not.
    expect(progress.some((p, i) => i > 0 && p < progress[i - 1])).toBe(true);
    expect(e.stats().modelId).toBe('mock-model');
  });

  it('can be configured to fail loading', async () => {
    await expect(createMockEngine({ failLoad: true }).load('x')).rejects.toThrow(/fail loading/);
  });

  it('streams deltas that reassemble into the full reply', async () => {
    const e = createMockEngine({ script: ['one two three'] });
    const deltas = [];
    const full = await e.generate([], { onDelta: (d) => deltas.push(d) });
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(full);
    expect(full).toBe('one two three');
  });

  it('walks the script and repeats the final entry', async () => {
    const e = createMockEngine({ script: ['a', 'b'] });
    expect(await e.generate([])).toBe('a');
    expect(await e.generate([])).toBe('b');
    expect(await e.generate([])).toBe('b');
  });

  it('supports function entries that see the messages', async () => {
    const e = createMockEngine({ script: [(messages, i) => `saw ${messages.length} msgs at ${i}`] });
    expect(await e.generate([{ role: 'user', content: 'x' }])).toBe('saw 1 msgs at 0');
  });

  it('records calls for assertions', async () => {
    const e = createMockEngine();
    await e.generate([{ role: 'user', content: 'hi' }], { temperature: 0.1 });
    expect(e.calls[0].options.temperature).toBe(0.1);
  });

  it('throws AbortError when the signal is already aborted', async () => {
    const c = new AbortController();
    c.abort();
    await expect(createMockEngine({ script: ['a b'] }).generate([], { signal: c.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('setScript restarts the script', async () => {
    const e = createMockEngine({ script: ['a'] });
    await e.generate([]);
    e.setScript(['z']);
    expect(await e.generate([])).toBe('z');
  });

  it('handles an empty reply', async () => {
    expect(await createMockEngine({ script: [''] }).generate([])).toBe('');
  });

  it('unload clears the model id', async () => {
    const e = createMockEngine();
    await e.load('m');
    await e.unload();
    expect(e.stats().modelId).toBeNull();
  });

  it('accumulates token counts', async () => {
    const e = createMockEngine({ script: ['aaaa bbbb'] });
    await e.generate([]);
    expect(e.stats().totalTokens).toBeGreaterThan(0);
  });

  it('honours a delay between chunks', async () => {
    const e = createMockEngine({ script: ['a b c'], deltaMs: 5 });
    const t0 = Date.now();
    await e.generate([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10);
  });

  it('reports load progress with a simulated duration', async () => {
    const onProgress = vi.fn();
    await createMockEngine({ loadMs: 3 }).load('m', onProgress);
    // One "start", twelve download shards, four cache reads, three shader
    // batches and a finish — the shape `progress.js` has to cope with.
    expect(onProgress).toHaveBeenCalledTimes(21);
  });

  it('always claims nothing is cached, so the UI takes its first-run path', async () => {
    const e = createMockEngine();
    expect(await e.isCached('anything')).toBe(false);
    expect(await e.deleteFromCache('anything')).toBe(true);
  });

  it('replays WebLLM’s three-pass progress wording, restarts and all', async () => {
    const texts = [];
    await createMockEngine().load('m', (p) => texts.push(p.text));

    expect(texts[0]).toBe('Start to fetch params');
    expect(texts.some((t) => /^Fetching param cache\[\d+\/\d+\]: \d+MB fetched\. \d+% completed/.test(t))).toBe(true);
    expect(texts.some((t) => /^Loading model from cache\[\d+\/\d+\]: \d+MB loaded\./.test(t))).toBe(true);
    expect(texts.some((t) => /^Loading GPU shader modules\[\d+\/\d+\]: \d+% completed/.test(t))).toBe(true);
    expect(texts.at(-1)).toMatch(/^Finish loading on/);
  });

  it('fails part-way through the download when asked to, with the given error', async () => {
    const boom = new Error("Failed to execute 'add' on 'Cache': Entry was not found.");
    boom.name = 'NotFoundError';
    const seen = [];
    const engine = createMockEngine({ failLoad: true, loadError: boom, failAt: 0.5 });

    await expect(engine.load('m', (p) => seen.push(p.progress))).rejects.toThrow(boom);
    // Part-way, not at the start: the diagnosis has to be exercised against a
    // half-filled bar, which is where a real one dies.
    expect(seen.length).toBeGreaterThan(1);
    expect(Math.max(...seen)).toBeLessThan(1);
  });
});
