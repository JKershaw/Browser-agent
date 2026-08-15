import { describe, it, expect, vi } from 'vitest';
import { MASK } from '../../src/tools/curl.js';
import { createRequestLog } from '../../src/state/log.js';

const call = (overrides = {}) => ({
  args: { method: 'GET', url: 'https://api.test/x', headers: {}, body: null, ...overrides },
});

const okResult = (overrides = {}) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: '{"a":1}',
  truncated: false,
  redirected: false,
  finalUrl: 'https://api.test/x',
  elapsedMs: 42,
  request: { headers: {}, secrets: [], credentialsUsed: [], proxied: false },
  ...overrides,
});

describe('createRequestLog', () => {
  it('records a pending entry on start', () => {
    const log = createRequestLog({ now: () => 1000 });
    const e = log.start(call());
    expect(e).toMatchObject({ status: 'pending', method: 'GET', url: 'https://api.test/x', at: 1000 });
    expect(log.size()).toBe(1);
  });

  it('settles a successful request', () => {
    const log = createRequestLog();
    const e = log.start(call());
    log.settle(e.id, okResult());
    const [entry] = log.all();
    expect(entry.status).toBe('ok');
    expect(entry.response.status).toBe(200);
    expect(entry.response.body).toBe('{"a":1}');
    expect(entry.elapsedMs).toBe(42);
  });

  it('settles a failed request with its error kind', () => {
    const log = createRequestLog();
    const e = log.start(call());
    log.settle(e.id, { ok: false, error: { kind: 'network', message: 'CORS probably' }, elapsedMs: 7 });
    const [entry] = log.all();
    expect(entry.status).toBe('error');
    expect(entry.error).toEqual({ kind: 'network', message: 'CORS probably' });
  });

  it('tolerates a malformed result object', () => {
    const log = createRequestLog();
    const e = log.start(call());
    log.settle(e.id, { ok: false });
    expect(log.all()[0].error).toEqual({ kind: 'unknown', message: 'Unknown failure.' });
  });

  it('ignores settling an unknown id', () => {
    const log = createRequestLog();
    log.start(call());
    log.settle('nope', okResult());
    expect(log.all()[0].status).toBe('pending');
  });

  it('marks a denial', () => {
    const log = createRequestLog();
    const e = log.start(call());
    log.deny(e.id, 'user said no');
    expect(log.all()[0]).toMatchObject({ status: 'denied', denied: true, error: { kind: 'denied', message: 'user said no' } });
  });

  it('uses a default denial message', () => {
    const log = createRequestLog();
    const e = log.start(call());
    log.deny(e.id);
    expect(log.all()[0].error.message).toContain('Denied by the user');
  });

  it('records truncation and redirects', () => {
    const log = createRequestLog();
    const e = log.start(call());
    log.settle(e.id, okResult({ truncated: true, redirected: true, finalUrl: 'https://api.test/final' }));
    expect(log.all()[0].response).toMatchObject({ truncated: true, redirected: true, finalUrl: 'https://api.test/final' });
  });

  it('records proxy use and credential names', () => {
    const log = createRequestLog();
    const e = log.start(call());
    log.settle(e.id, okResult({ request: { headers: {}, secrets: [], credentialsUsed: ['GitHub'], proxied: true } }));
    expect(log.all()[0]).toMatchObject({ proxied: true, credentialsUsed: ['GitHub'] });
  });
});

describe('createRequestLog — masking', () => {
  it('masks sensitive headers at start, before any secret is known', () => {
    const log = createRequestLog();
    const e = log.start(call({ headers: { Authorization: 'Bearer literal-token' } }));
    expect(e.requestHeaders.Authorization).toBe(MASK);
  });

  it('masks stored secrets in headers, body and final URL on settle', () => {
    const log = createRequestLog();
    const e = log.start(call());
    log.settle(e.id, okResult({
      body: 'echo: sekret-value-1',
      finalUrl: 'https://api.test/?t=sekret-value-1',
      request: { headers: { 'X-Custom': 'v=sekret-value-1' }, secrets: ['sekret-value-1'], credentialsUsed: ['T'], proxied: false },
    }));
    const dump = JSON.stringify(log.all());
    expect(dump).not.toContain('sekret-value-1');
    expect(dump).toContain(MASK);
  });

  it('exports masked JSON', () => {
    const log = createRequestLog({ now: () => 0 });
    const e = log.start(call({ headers: { Authorization: 'Bearer abc' } }));
    log.settle(e.id, okResult({ body: 'sekret-value-1', request: { headers: {}, secrets: ['sekret-value-1'] } }));
    const json = log.toJSON();
    expect(json).not.toContain('sekret-value-1');
    expect(json).not.toContain('Bearer abc');
    expect(JSON.parse(json).exportedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(JSON.parse(json).entries).toHaveLength(1);
  });
});

describe('createRequestLog — capacity and subscriptions', () => {
  it('drops the oldest entries past the cap', () => {
    const log = createRequestLog({ max: 3 });
    for (let i = 0; i < 5; i += 1) log.start(call({ url: `https://api.test/${i}` }));
    expect(log.size()).toBe(3);
    expect(log.all().map((e) => e.url)).toEqual([
      'https://api.test/2', 'https://api.test/3', 'https://api.test/4',
    ]);
  });

  it('clears', () => {
    const log = createRequestLog();
    log.start(call());
    log.clear();
    expect(log.size()).toBe(0);
  });

  it('notifies subscribers on every mutation', () => {
    const log = createRequestLog();
    const fn = vi.fn();
    log.subscribe(fn);
    const e = log.start(call());
    log.settle(e.id, okResult());
    log.deny(e.id);
    log.clear();
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('unsubscribes', () => {
    const log = createRequestLog();
    const fn = vi.fn();
    log.subscribe(fn)();
    log.start(call());
    expect(fn).not.toHaveBeenCalled();
  });

  it('gives every entry a distinct id', () => {
    const log = createRequestLog();
    const ids = [log.start(call()).id, log.start(call()).id, log.start(call()).id];
    expect(new Set(ids).size).toBe(3);
  });
});
