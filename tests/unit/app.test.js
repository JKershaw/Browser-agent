import { describe, it, expect, vi } from 'vitest';
import { createApp, isFileOrigin, wantsMockEngine } from '../../src/app.js';
import { createMemoryStorage } from '../../src/state/settings.js';
import { createMockEngine } from '../../src/llm/mock.js';

const toolCall = (url = 'https://api.test/x', method = 'GET') =>
  '```json\n' + JSON.stringify({ tool: 'curl', args: { method, url, headers: {}, body: null } }) + '\n```';

const okResponse = (body = '{"ok":true}') => ({
  status: 200,
  statusText: 'OK',
  url: '',
  redirected: false,
  headers: { forEach(fn) { fn('application/json', 'content-type'); } },
  async text() { return body; },
});

/** An app wired to a scripted engine and a fake fetch. */
function makeApp({ script = ['hello'], fetchImpl, confirm, hooks } = {}) {
  return createApp({
    storage: createMemoryStorage(),
    engine: createMockEngine({ script }),
    fetchImpl: fetchImpl || (async () => okResponse()),
    confirm,
    hooks,
  });
}

describe('isFileOrigin', () => {
  it.each([
    ['file:', true],
    ['https:', false],
    ['http:', false],
  ])('%s -> %s', (protocol, expected) => {
    expect(isFileOrigin({ protocol })).toBe(expected);
  });

  it('is false when there is no location', () => {
    expect(isFileOrigin(null)).toBe(false);
  });
});

describe('wantsMockEngine', () => {
  it.each([
    ['?mockEngine=1', true],
    ['?mockEngine=0', false],
    ['?other=1', false],
    ['', false],
  ])('%s -> %s', (search, expected) => {
    expect(wantsMockEngine(search)).toBe(expected);
  });
});

describe('createApp — wiring', () => {
  it('exposes the pieces the UI binds to', () => {
    const app = makeApp();
    expect(app.settings.get().maxIterations).toBe(5);
    expect(app.log.all()).toEqual([]);
    expect(typeof app.loop.run).toBe('function');
    expect(app.tiers.length).toBeGreaterThan(0);
  });

  it('rejects an engine that does not implement the contract', () => {
    expect(() => createApp({ storage: createMemoryStorage(), engine: { load: () => {} } }))
      .toThrow(/missing required method/);
  });

  it('records a storage failure as a notice instead of throwing', () => {
    const app = createApp({
      storage: { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); }, removeItem: () => {} },
      engine: createMockEngine(),
    });
    app.settings.set({ temperature: 0.2 });
    expect(app.notices[0].text).toContain('QuotaExceeded');
    expect(app.notices[0].kind).toBe('warning');
  });
});

describe('createApp — tool execution', () => {
  it('runs a tool call and logs the result', async () => {
    const app = makeApp({ script: [toolCall(), 'done'] });
    app.settings.set({ confirmBeforeSend: false });
    const r = await app.loop.run('go');

    expect(r.stopReason).toBe('text');
    const entries = app.log.all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'ok', method: 'GET', url: 'https://api.test/x' });
    expect(entries[0].response.status).toBe(200);
  });

  it('passes the current settings through to the tool', async () => {
    const fetchImpl = vi.fn(async () => okResponse('x'.repeat(5000)));
    const app = makeApp({ script: [toolCall(), 'done'], fetchImpl });
    app.settings.set({ confirmBeforeSend: false, maxBytes: 300, timeoutMs: 5000 });
    await app.loop.run('go');
    expect(app.log.all()[0].response.truncated).toBe(true);
  });

  it('honours the domain allowlist without dispatching', async () => {
    const fetchImpl = vi.fn();
    const app = makeApp({ script: [toolCall('https://evil.test/x'), 'done'], fetchImpl });
    app.settings.set({ confirmBeforeSend: false, allowlist: ['api.test'] });
    await app.loop.run('go');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(app.log.all()[0]).toMatchObject({ status: 'error', error: { kind: 'blocked_domain' } });
  });

  const credentialCall = '```json\n' + JSON.stringify({
    tool: 'curl',
    args: { method: 'GET', url: 'https://api.test/x', headers: { Authorization: 'Bearer {{Tok}}' }, body: null },
  }) + '\n```';

  it('substitutes a stored credential without logging it', async () => {
    let sent = null;
    const app = makeApp({
      script: [credentialCall, 'done'],
      fetchImpl: async (_u, i) => { sent = i.headers; return okResponse(); },
      confirm: async () => ({ approved: true }),
    });
    app.settings.addCredential({ name: 'Tok', value: 'super-secret-value' });
    await app.loop.run('go');

    expect(sent.Authorization).toBe('Bearer super-secret-value');
    expect(app.log.toJSON()).not.toContain('super-secret-value');
    expect(app.log.all()[0].credentialsUsed).toEqual(['Tok']);
  });

  it('asks before sending a credential even with confirm-before-send off', async () => {
    // Leaking a long-lived token is as irreversible as a DELETE, so it gets
    // the same treatment: the global toggle does not cover it.
    const confirm = vi.fn(async () => ({ approved: true }));
    const app = makeApp({ script: [credentialCall, 'done'], confirm });
    app.settings.set({ confirmBeforeSend: false });
    app.settings.addCredential({ name: 'Tok', value: 'super-secret-value' });
    await app.loop.run('go');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('does not ask for an ordinary request when confirmation is off', async () => {
    const confirm = vi.fn(async () => ({ approved: true }));
    const app = makeApp({ script: [toolCall(), 'done'], confirm });
    app.settings.set({ confirmBeforeSend: false });
    await app.loop.run('go');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('forwards hooks to the caller as well as its own', async () => {
    const onToolCall = vi.fn();
    const onTurnEnd = vi.fn();
    const app = makeApp({ script: [toolCall(), 'done'], hooks: { onToolCall, onTurnEnd } });
    app.settings.set({ confirmBeforeSend: false });
    await app.loop.run('go');
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('releases a proposed-but-unsent entry when the turn is cancelled', async () => {
    const app = makeApp({
      script: [toolCall(), 'done'],
      confirm: () => new Promise(() => {}), // card never answered
    });
    app.settings.set({ confirmBeforeSend: true });
    const run = app.loop.run('go');
    await new Promise((r) => setTimeout(r, 5));
    app.loop.cancel();
    await run;

    expect(app.log.all().every((e) => e.status !== 'pending')).toBe(true);
  });
});

describe('createApp — probe', () => {
  it('picks a small model on a constrained device and explains why', async () => {
    const app = createApp({
      storage: createMemoryStorage(),
      engine: createMockEngine(),
      navigator: { deviceMemory: 4, gpu: { requestAdapter: async () => ({ limits: { maxBufferSize: 5e8 } }) } },
    });
    const { caps, model } = await app.probe();
    expect(caps.webgpu).toBe(true);
    expect(caps.lowMemory).toBe(true);
    expect(model.id).toContain('1.7B');
    expect(model.reason).toContain('memory-constrained');
  });

  it('reports the absence of WebGPU rather than guessing', async () => {
    const app = createApp({ storage: createMemoryStorage(), engine: createMockEngine(), navigator: {} });
    const { caps } = await app.probe();
    expect(caps.webgpu).toBe(false);
    expect(caps.reason).toContain('navigator.gpu');
  });

  it('respects a model the user has already chosen', async () => {
    const storage = createMemoryStorage();
    const app = createApp({ storage, engine: createMockEngine(), navigator: { deviceMemory: 2 } });
    app.settings.set({ modelId: 'Qwen3-4B-q4f16_1-MLC' });
    const { model } = await app.probe();
    expect(model.id).toBe('Qwen3-4B-q4f16_1-MLC');
    expect(model.reason).toBe('');
  });
});

describe('createApp — mock engine URL flags', () => {
  const withSearch = (search, fn) => {
    const original = globalThis.location;
    // The flags are read from location.search at construction time.
    Object.defineProperty(globalThis, 'location', {
      value: { search, protocol: 'https:' },
      configurable: true,
      writable: true,
    });
    try {
      return fn();
    } finally {
      Object.defineProperty(globalThis, 'location', { value: original, configurable: true, writable: true });
    }
  };

  it('builds a scripted mock engine from the URL', async () => {
    const app = withSearch('?mockEngine=1&mockScript=' + encodeURIComponent('["scripted reply"]'), () =>
      createApp({ storage: createMemoryStorage() })
    );
    expect(await app.engine.generate([])).toBe('scripted reply');
  });

  it('falls back to a default reply when the script is not valid JSON', async () => {
    const app = withSearch('?mockEngine=1&mockScript=not-json', () =>
      createApp({ storage: createMemoryStorage() })
    );
    expect(await app.engine.generate([])).toContain('mock engine');
  });

  it('accepts a single non-array script entry', async () => {
    const app = withSearch('?mockEngine=1&mockScript=' + encodeURIComponent('"just one"'), () =>
      createApp({ storage: createMemoryStorage() })
    );
    expect(await app.engine.generate([])).toBe('just one');
  });

  it('honours a simulated load delay, clamped to something sane', async () => {
    const app = withSearch('?mockEngine=1&mockLoadMs=60', () => createApp({ storage: createMemoryStorage() }));
    const t0 = Date.now();
    await app.engine.load('m');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
  });

  it.each(['?mockEngine=1&mockLoadMs=abc', '?mockEngine=1&mockLoadMs=-5', '?mockEngine=1'])(
    'treats %s as no delay',
    async (search) => {
      const app = withSearch(search, () => createApp({ storage: createMemoryStorage() }));
      const t0 = Date.now();
      await app.engine.load('m');
      expect(Date.now() - t0).toBeLessThan(40);
    }
  );

  it('reports a file:// origin', () => {
    const app = withSearch('?mockEngine=1', () => createApp({ storage: createMemoryStorage() }));
    expect(app.isFileOrigin()).toBe(false);
  });
});

describe('createApp — every setting actually reaches the tool', () => {
  /**
   * These exist because `curl.js` was thoroughly tested in isolation and the
   * settings store was thoroughly tested in isolation, while the wiring
   * between them was tested by nothing: disconnecting the CORS proxy entirely,
   * or dropping the abort signal, left the whole suite green.
   */
  const spyApp = (script) => {
    const fetchImpl = vi.fn(async () => okResponse());
    const app = createApp({
      storage: createMemoryStorage(),
      engine: createMockEngine({ script }),
      fetchImpl,
      confirm: async () => ({ approved: true }),
    });
    return { app, fetchImpl };
  };

  it('routes the request through the configured CORS proxy', async () => {
    const { app, fetchImpl } = spyApp([toolCall('https://api.test/data'), 'done']);
    app.settings.set({ confirmBeforeSend: false, proxyTemplate: 'https://proxy.test/?url={url}' });
    await app.loop.run('go');

    // The URL fetch was actually called with, not the one the model asked for.
    expect(fetchImpl.mock.calls[0][0]).toBe('https://proxy.test/?url=https%3A%2F%2Fapi.test%2Fdata');
    expect(app.log.all()[0].proxied).toBe(true);
  });

  it('sends directly when no proxy is configured', async () => {
    const { app, fetchImpl } = spyApp([toolCall('https://api.test/data'), 'done']);
    app.settings.set({ confirmBeforeSend: false });
    await app.loop.run('go');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.test/data');
  });

  it('gives the request an abort signal that Stop actually fires', async () => {
    let seenSignal = null;
    const app = createApp({
      storage: createMemoryStorage(),
      engine: createMockEngine({ script: [toolCall(), 'done'] }),
      // Hang the request so the turn can be cancelled while it is in flight —
      // every other cancellation test cancels at the confirmation card.
      fetchImpl: (_u, init) => new Promise((_resolve, reject) => {
        seenSignal = init.signal;
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
    });
    app.settings.set({ confirmBeforeSend: false });

    const run = app.loop.run('go');
    await new Promise((r) => setTimeout(r, 20));
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal.aborted).toBe(false);

    app.loop.cancel();
    const result = await run;
    expect(seenSignal.aborted).toBe(true);
    expect(result.stopReason).toBe('cancelled');
  });

  it('applies the configured timeout to the request', async () => {
    const app = createApp({
      storage: createMemoryStorage(),
      engine: createMockEngine({ script: [toolCall(), 'done'] }),
      fetchImpl: (_u, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
    });
    app.settings.set({ confirmBeforeSend: false, timeoutMs: 1000 });
    await app.loop.run('go');

    const entry = app.log.all()[0];
    expect(entry.status).toBe('error');
    expect(entry.error.kind).toBe('timeout');
    // The message must quote the limit that was actually configured.
    expect(entry.error.message).toContain('1000 ms');
  });

  it('applies the configured response size limit', async () => {
    const fetchImpl = vi.fn(async () => okResponse('y'.repeat(4000)));
    const app = createApp({
      storage: createMemoryStorage(),
      engine: createMockEngine({ script: [toolCall(), 'done'] }),
      fetchImpl,
    });
    app.settings.set({ confirmBeforeSend: false, maxBytes: 512 });
    await app.loop.run('go');

    const entry = app.log.all()[0];
    expect(entry.response.truncated).toBe(true);
    expect(entry.response.body.length).toBeLessThanOrEqual(512);
  });

  it('does not truncate when the limit is generous', async () => {
    const app = createApp({
      storage: createMemoryStorage(),
      engine: createMockEngine({ script: [toolCall(), 'done'] }),
      fetchImpl: async () => okResponse('y'.repeat(4000)),
    });
    app.settings.set({ confirmBeforeSend: false, maxBytes: 100_000 });
    await app.loop.run('go');
    expect(app.log.all()[0].response.truncated).toBe(false);
  });

  it('passes stored credentials through for substitution', async () => {
    const { app, fetchImpl } = spyApp([
      '```json\n' + JSON.stringify({
        tool: 'curl',
        args: { method: 'GET', url: 'https://api.test/x', headers: { 'X-Key': '{{K}}' }, body: null },
      }) + '\n```',
      'done',
    ]);
    app.settings.addCredential({ name: 'K', value: 'the-secret-value' });
    await app.loop.run('go');
    expect(fetchImpl.mock.calls[0][1].headers['X-Key']).toBe('the-secret-value');
  });

  it('reads settings again on each pass, so a mid-turn change takes effect', async () => {
    const { app, fetchImpl } = spyApp([toolCall(), toolCall(), 'done']);
    app.settings.set({ confirmBeforeSend: false });
    let call = 0;
    const original = app.settings.get.bind(app.settings);
    // Flip the proxy on between the first and second tool call.
    app.settings.get = () => {
      call += 1;
      return call > 3
        ? { ...original(), proxyTemplate: 'https://late.proxy/?url={url}' }
        : original();
    };
    await app.loop.run('go');
    app.settings.get = original;

    const urls = fetchImpl.mock.calls.map((c) => c[0]);
    expect(urls[0]).toBe('https://api.test/x');
    expect(urls[1]).toContain('late.proxy');
  });
});

describe('createApp — optional wiring', () => {
  it('works with no hooks and no confirm handler supplied', async () => {
    // main.js always passes both, but app.js is the headless entry point that
    // scripts and tests drive directly, so the optional paths must hold up.
    const app = createApp({
      storage: createMemoryStorage(),
      engine: createMockEngine({ script: [toolCall(), 'done'] }),
      fetchImpl: async () => okResponse(),
    });
    app.settings.set({ confirmBeforeSend: false });
    const r = await app.loop.run('go');
    expect(r.stopReason).toBe('text');
    expect(app.log.all()[0].status).toBe('ok');
  });

  it('denies safely when confirmation is required but no handler exists', async () => {
    const fetchImpl = vi.fn();
    const app = createApp({
      storage: createMemoryStorage(),
      engine: createMockEngine({ script: [toolCall(), 'ok'] }),
      fetchImpl,
    });
    // confirmBeforeSend defaults to true, so this is the out-of-the-box state.
    await app.loop.run('go');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(app.log.all()[0].status).toBe('denied');
  });

  it('falls back to the ambient navigator when none is injected', async () => {
    const app = createApp({ storage: createMemoryStorage(), engine: createMockEngine() });
    const { caps } = await app.probe();
    // Node has no navigator.gpu, so this exercises the real global path.
    expect(caps.webgpu).toBe(false);
    expect(typeof caps.reason).toBe('string');
  });

  it('uses the ambient fetch when none is injected', async () => {
    const app = createApp({
      storage: createMemoryStorage(),
      engine: createMockEngine({ script: [toolCall('https://127.0.0.1:1/nope'), 'failed'] }),
    });
    app.settings.set({ confirmBeforeSend: false });
    await app.loop.run('go');
    // Nothing listens on port 1; the point is that a real fetch was reached.
    expect(app.log.all()[0].status).toBe('error');
  });
});
