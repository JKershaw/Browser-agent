import { describe, it, expect, vi } from 'vitest';
import {
  CurlError,
  MASK,
  applyCredentials,
  applyProxy,
  attachHostCredentials,
  executeCurl,
  formatResultForModel,
  hostMatches,
  isHostAllowed,
  maskHeaders,
  maskSecrets,
  readBodyCapped,
} from '../../src/tools/curl.js';

/** Minimal Response stand-in whose body is a real ReadableStream. */
function makeResponse({ status = 200, statusText = 'OK', headers = {}, body = '', url = '', redirected = false } = {}) {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    statusText,
    url,
    redirected,
    headers: {
      forEach(fn) {
        for (const [k, v] of Object.entries(headers)) fn(v, k);
      },
    },
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent || bytes.length === 0) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {},
        };
      },
    },
    async text() {
      return body;
    },
  };
}

/** Response whose body arrives in many small chunks (exercises the cap loop). */
function makeChunkedResponse(chunks, extra = {}) {
  const encoded = chunks.map((c) => new TextEncoder().encode(c));
  let cancelled = false;
  const res = makeResponse({ ...extra, body: chunks.join('') });
  res.body = {
    getReader() {
      let i = 0;
      return {
        async read() {
          if (i >= encoded.length) return { done: true, value: undefined };
          const value = encoded[i];
          i += 1;
          return { done: false, value };
        },
        async cancel() {
          cancelled = true;
        },
      };
    },
  };
  res.wasCancelled = () => cancelled;
  return res;
}

const GET = (url = 'https://api.test/data') => ({ method: 'GET', url, headers: {}, body: null });

describe('hostMatches / isHostAllowed', () => {
  it.each([
    ['api.test', 'api.test', true],
    ['a.api.test', 'api.test', true],
    ['api.test', 'a.api.test', false],
    ['notapi.test', 'api.test', false],
    ['a.api.test', '*.api.test', true],
    ['api.test', '*.api.test', false],
    ['anything.test', '*', true],
    ['api.test', '', false],
    ['api.test', '  API.TEST ', true],
    ['api.test', '*.', false],
  ])('hostMatches(%s, %s) === %s', (host, pattern, expected) => {
    expect(hostMatches(host, pattern)).toBe(expected);
  });

  it('treats an empty allowlist as allow-all', () => {
    expect(isHostAllowed('anything.test', [])).toBe(true);
    expect(isHostAllowed('anything.test', undefined)).toBe(true);
    expect(isHostAllowed('anything.test', ['  ', ''])).toBe(true);
  });

  it('enforces a non-empty allowlist', () => {
    expect(isHostAllowed('api.test', ['api.test'])).toBe(true);
    expect(isHostAllowed('evil.test', ['api.test'])).toBe(false);
  });
});

describe('applyProxy', () => {
  it('returns the url unchanged when no template is set', () => {
    expect(applyProxy('https://a.test/x', '')).toBe('https://a.test/x');
    expect(applyProxy('https://a.test/x', '   ')).toBe('https://a.test/x');
    expect(applyProxy('https://a.test/x', undefined)).toBe('https://a.test/x');
  });

  it('substitutes and encodes {url}', () => {
    expect(applyProxy('https://a.test/x?q=1', 'https://p.test/?url={url}'))
      .toBe('https://p.test/?url=https%3A%2F%2Fa.test%2Fx%3Fq%3D1');
  });

  it('treats a template without {url} as a prefix', () => {
    expect(applyProxy('https://a.test/x', 'https://p.test/')).toBe('https://p.test/https://a.test/x');
  });
});

describe('applyCredentials', () => {
  const creds = [{ name: 'GitHub', value: 'ghp_secret123' }];

  it('substitutes a placeholder', () => {
    const r = applyCredentials({ Authorization: 'Bearer {{GitHub}}' }, creds);
    expect(r.headers.Authorization).toBe('Bearer ghp_secret123');
    expect(r.used).toEqual(['GitHub']);
    expect(r.secrets).toEqual(['ghp_secret123']);
  });

  it('matches placeholder names case-insensitively and ignores whitespace', () => {
    expect(applyCredentials({ A: '{{  github  }}' }, creds).headers.A).toBe('ghp_secret123');
  });

  it('leaves unknown placeholders intact and reports them', () => {
    const r = applyCredentials({ A: '{{Nope}}' }, creds);
    expect(r.headers.A).toBe('{{Nope}}');
    expect(r.missing).toEqual(['Nope']);
    expect(r.used).toEqual([]);
  });

  it('handles multiple placeholders in one value', () => {
    const r = applyCredentials({ A: '{{GitHub}}:{{GitHub}}' }, creds);
    expect(r.headers.A).toBe('ghp_secret123:ghp_secret123');
    expect(r.used).toEqual(['GitHub']);
  });

  it('substitutes an empty value for a credential with no value', () => {
    const r = applyCredentials({ A: 'x{{Blank}}' }, [{ name: 'Blank', value: '' }]);
    expect(r.headers.A).toBe('x');
    expect(r.secrets).toEqual([]);
  });

  it('is a no-op with no credentials configured', () => {
    expect(applyCredentials({ A: 'plain' }).headers).toEqual({ A: 'plain' });
  });
});

describe('attachHostCredentials', () => {
  const creds = [{ name: 'API', headerName: 'X-Api-Key', value: 'k1', hosts: ['api.test'] }];

  it('attaches a credential scoped to a matching host', () => {
    const r = attachHostCredentials({}, 'api.test', creds);
    expect(r.headers).toEqual({ 'X-Api-Key': 'k1' });
    expect(r.used).toEqual(['API']);
    expect(r.secrets).toEqual(['k1']);
  });

  it('does not attach on a non-matching host', () => {
    expect(attachHostCredentials({}, 'other.test', creds).headers).toEqual({});
  });

  it('never overwrites a header the model already set (case-insensitively)', () => {
    const r = attachHostCredentials({ 'x-api-key': 'model-value' }, 'api.test', creds);
    expect(r.headers).toEqual({ 'x-api-key': 'model-value' });
    expect(r.used).toEqual([]);
  });

  it('skips credentials with no headerName or no hosts', () => {
    expect(attachHostCredentials({}, 'api.test', [{ name: 'A', value: 'v', hosts: ['api.test'] }]).headers).toEqual({});
    expect(attachHostCredentials({}, 'api.test', [{ name: 'A', headerName: 'H', value: 'v' }]).headers).toEqual({});
    expect(attachHostCredentials({}, 'api.test', [{ name: 'A', headerName: 'H', value: 'v', hosts: [] }]).headers).toEqual({});
  });
});

describe('masking', () => {
  it('masks known secrets anywhere in a string', () => {
    expect(maskSecrets('token=abcd1234 end', ['abcd1234'])).toBe(`token=${MASK} end`);
  });

  it('ignores very short secrets to avoid mangling everything', () => {
    expect(maskSecrets('a-b-c', ['a'])).toBe('a-b-c');
  });

  it('masks longest secrets first', () => {
    expect(maskSecrets('abcdefgh', ['abcd', 'abcdefgh'])).toBe(MASK);
  });

  it('always masks sensitive header names even without a stored secret', () => {
    const masked = maskHeaders({ Authorization: 'Bearer literal', 'X-Api-Key': 'k', Accept: 'json' });
    expect(masked.Authorization).toBe(MASK);
    expect(masked['X-Api-Key']).toBe(MASK);
    expect(masked.Accept).toBe('json');
  });

  it('masks stored secrets appearing in non-sensitive headers', () => {
    expect(maskHeaders({ 'X-Custom': 'v=supersecret1' }, ['supersecret1'])['X-Custom']).toBe(`v=${MASK}`);
  });

  it('handles empty input', () => {
    expect(maskHeaders(undefined)).toEqual({});
  });
});

describe('readBodyCapped', () => {
  it('returns a short body untruncated', async () => {
    const r = await readBodyCapped(makeResponse({ body: 'hello' }), 1024);
    expect(r).toEqual({ text: 'hello', truncated: false, bytes: 5 });
  });

  it('truncates at the byte cap and cancels the stream', async () => {
    const res = makeChunkedResponse(['aaaa', 'bbbb', 'cccc']);
    const r = await readBodyCapped(res, 6);
    expect(r.text).toBe('aaaabb');
    expect(r.truncated).toBe(true);
    expect(res.wasCancelled()).toBe(true);
  });

  it('truncates cleanly when the cap falls on a chunk boundary', async () => {
    const r = await readBodyCapped(makeChunkedResponse(['aaaa', 'bbbb']), 4);
    expect(r.text).toBe('aaaa');
    expect(r.truncated).toBe(true);
  });

  it('does not flag truncation when the body exactly fills the cap', async () => {
    const r = await readBodyCapped(makeChunkedResponse(['aaaa']), 4);
    expect(r).toEqual({ text: 'aaaa', truncated: false, bytes: 4 });
  });

  it('skips empty chunks', async () => {
    const r = await readBodyCapped(makeChunkedResponse(['a', '', 'b']), 100);
    expect(r.text).toBe('ab');
  });

  it('falls back to text() when there is no stream', async () => {
    const res = { async text() { return 'plain'; } };
    expect(await readBodyCapped(res, 100)).toEqual({ text: 'plain', truncated: false, bytes: 5 });
  });

  it('truncates the text() fallback too', async () => {
    const res = { async text() { return 'abcdefgh'; } };
    const r = await readBodyCapped(res, 3);
    expect(r).toEqual({ text: 'abc', truncated: true, bytes: 8 });
  });

  it('returns empty for a response with neither body nor text()', async () => {
    expect(await readBodyCapped({}, 10)).toEqual({ text: '', truncated: false, bytes: 0 });
  });

  it('survives a reader that throws on cancel', async () => {
    const res = makeChunkedResponse(['aaaa', 'bbbb']);
    const orig = res.body.getReader;
    res.body.getReader = () => {
      const r = orig.call(res.body);
      r.cancel = async () => { throw new Error('already closed'); };
      return r;
    };
    const r = await readBodyCapped(res, 2);
    expect(r.truncated).toBe(true);
  });
});

describe('executeCurl — success paths', () => {
  it('performs a GET and returns status, headers and body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}', url: 'https://api.test/data' })
    );
    const r = await executeCurl(GET(), { fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"ok":true}');
    expect(r.headers['content-type']).toBe('application/json');
    expect(fetchImpl).toHaveBeenCalledWith('https://api.test/data', expect.objectContaining({ method: 'GET' }));
  });

  it('passes HTTP error statuses through as data, not tool failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ status: 404, statusText: 'Not Found', body: 'nope' }));
    const r = await executeCurl(GET(), { fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(404);
    expect(formatResultForModel(r)).toContain('HTTP 404 Not Found');
  });

  it('sends a body on POST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({}));
    await executeCurl({ method: 'POST', url: 'https://api.test/x', headers: {}, body: '{"a":1}' }, { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].body).toBe('{"a":1}');
  });

  it('never sends a body on GET or HEAD', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({}));
    await executeCurl({ method: 'GET', url: 'https://api.test/x', body: 'ignored' }, { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
  });

  it('does not read a body for HEAD', async () => {
    const res = makeResponse({ body: 'should not be read' });
    const spy = vi.spyOn(res, 'text');
    const r = await executeCurl({ method: 'HEAD', url: 'https://api.test/x' }, { fetchImpl: async () => res });
    expect(r.body).toBe('');
    expect(spy).not.toHaveBeenCalled();
  });

  it('omits ambient cookies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({}));
    await executeCurl(GET(), { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].credentials).toBe('omit');
  });

  it('routes through the configured proxy and records it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({}));
    const r = await executeCurl(GET(), { fetchImpl, proxyTemplate: 'https://p.test/?url={url}' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://p.test/?url=https%3A%2F%2Fapi.test%2Fdata');
    expect(r.request.proxied).toBe(true);
    expect(r.request.url).toBe('https://api.test/data');
  });

  it('injects a placeholder credential without leaking it into request.url', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({}));
    const r = await executeCurl(
      { method: 'GET', url: 'https://api.test/data', headers: { Authorization: 'Bearer {{Tok}}' } },
      { fetchImpl, credentials: [{ name: 'Tok', value: 'sekret-value' }] }
    );
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer sekret-value');
    expect(r.request.credentialsUsed).toEqual(['Tok']);
    expect(r.request.secrets).toContain('sekret-value');
  });

  it('reports missing credentials so the UI can warn', async () => {
    const r = await executeCurl(
      { method: 'GET', url: 'https://api.test/data', headers: { Authorization: '{{Absent}}' } },
      { fetchImpl: async () => makeResponse({}) }
    );
    expect(r.request.credentialsMissing).toEqual(['Absent']);
  });

  it('reports elapsed time from the injected clock', async () => {
    let t = 1000;
    const now = () => t;
    const fetchImpl = async () => { t = 1250; return makeResponse({}); };
    expect((await executeCurl(GET(), { fetchImpl, now })).elapsedMs).toBe(250);
  });

  it('marks a truncated body and reports the cap', async () => {
    const fetchImpl = async () => makeChunkedResponse(['x'.repeat(20)]);
    const r = await executeCurl(GET(), { fetchImpl, maxBytes: 5 });
    expect(r.truncated).toBe(true);
    expect(r.body).toBe('xxxxx');
    expect(formatResultForModel(r)).toContain('TRUNCATED at 5 bytes');
  });

  it('reports redirects', async () => {
    const fetchImpl = async () => makeResponse({ url: 'https://api.test/final', redirected: true });
    const r = await executeCurl(GET(), { fetchImpl });
    expect(r.redirected).toBe(true);
    expect(r.finalUrl).toBe('https://api.test/final');
    expect(formatResultForModel(r)).toContain('final URL: https://api.test/final');
  });

  it('tolerates a response with no headers object', async () => {
    const r = await executeCurl(GET(), { fetchImpl: async () => ({ status: 200, statusText: '', async text() { return 'x'; } }) });
    expect(r.ok).toBe(true);
    expect(r.headers).toEqual({});
  });
});

describe('executeCurl — rejection before dispatch', () => {
  const neverCalled = vi.fn();

  it.each([
    ['not-a-url', CurlError.INVALID_URL],
    ['/relative', CurlError.INVALID_URL],
    ['', CurlError.INVALID_URL],
  ])('rejects url %s', async (url, kind) => {
    const r = await executeCurl({ method: 'GET', url }, { fetchImpl: neverCalled });
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe(kind);
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://a.test'])(
    'rejects blocked scheme %s',
    async (url) => {
      const r = await executeCurl({ method: 'GET', url }, { fetchImpl: neverCalled });
      expect(r.error.kind).toBe(CurlError.BLOCKED_SCHEME);
      expect(r.error.message).toContain('http:');
    }
  );

  it('rejects an unsupported method', async () => {
    const r = await executeCurl({ method: 'TRACE', url: 'https://api.test/x' }, { fetchImpl: neverCalled });
    expect(r.error.kind).toBe(CurlError.BAD_METHOD);
  });

  it('rejects a host outside a configured allowlist and names the list', async () => {
    const r = await executeCurl(GET('https://evil.test/x'), { fetchImpl: neverCalled, allowlist: ['api.test'] });
    expect(r.error.kind).toBe(CurlError.BLOCKED_DOMAIN);
    expect(r.error.message).toContain('api.test');
  });

  it('allows a host on the allowlist', async () => {
    const r = await executeCurl(GET(), { fetchImpl: async () => makeResponse({}), allowlist: ['api.test'] });
    expect(r.ok).toBe(true);
  });

  it('rejects a proxy template that yields an invalid URL', async () => {
    const r = await executeCurl(GET(), { fetchImpl: neverCalled, proxyTemplate: 'not a url {url}' });
    expect(r.error.kind).toBe(CurlError.BAD_PROXY);
  });
});

describe('executeCurl — failure paths', () => {
  it('explains a network/CORS failure and mentions the missing proxy', async () => {
    const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    const r = await executeCurl(GET(), { fetchImpl });
    expect(r.error.kind).toBe(CurlError.NETWORK);
    expect(r.error.message).toContain('CORS');
    expect(r.error.message).toContain('No CORS proxy is configured');
    expect(r.detail).toContain('Failed to fetch');
  });

  it('says the proxy may be at fault when one is configured', async () => {
    const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    const r = await executeCurl(GET(), { fetchImpl, proxyTemplate: 'https://p.test/?url={url}' });
    expect(r.error.message).toContain('A CORS proxy is configured');
  });

  it('reports a timeout with the configured limit', async () => {
    const fetchImpl = (url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const r = await executeCurl(GET(), { fetchImpl, timeoutMs: 10 });
    expect(r.error.kind).toBe(CurlError.TIMEOUT);
    expect(r.error.message).toContain('10 ms');
  });

  it('reports cancellation when an external signal aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = (url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
        controller.abort();
      });
    const r = await executeCurl(GET(), { fetchImpl, signal: controller.signal });
    expect(r.error.kind).toBe(CurlError.CANCELLED);
  });

  it('reports cancellation when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = (url, init) =>
      new Promise((_resolve, reject) => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        if (init.signal.aborted) reject(e);
      });
    expect((await executeCurl(GET(), { fetchImpl, signal: controller.signal })).error.kind).toBe(CurlError.CANCELLED);
  });

  it('reports a body read failure distinctly from a connect failure', async () => {
    const res = makeResponse({});
    res.body = { getReader: () => ({ read: async () => { throw new Error('stream broke'); }, cancel: async () => {} }) };
    const r = await executeCurl(GET(), { fetchImpl: async () => res });
    expect(r.error.kind).toBe(CurlError.READ_FAILED);
    expect(r.error.message).toContain('stream broke');
  });

  it('reports a timeout that lands while reading the body', async () => {
    const res = makeResponse({});
    res.body = {
      getReader: () => ({
        read: async () => { await new Promise((r) => setTimeout(r, 50)); throw new Error('aborted'); },
        cancel: async () => {},
      }),
    };
    const r = await executeCurl(GET(), { fetchImpl: async () => res, timeoutMs: 5 });
    expect(r.error.kind).toBe(CurlError.TIMEOUT);
  });

  it('discards a response that redirected off the allowlist', async () => {
    const fetchImpl = async () => makeResponse({ url: 'https://evil.test/x', redirected: true, body: 'leak' });
    const r = await executeCurl(GET(), { fetchImpl, allowlist: ['api.test'] });
    expect(r.error.kind).toBe(CurlError.BLOCKED_REDIRECT);
    expect(JSON.stringify(r)).not.toContain('leak');
  });

  it('ignores an unparseable response.url when checking redirects', async () => {
    const fetchImpl = async () => makeResponse({ url: 'opaque', body: 'ok' });
    expect((await executeCurl(GET(), { fetchImpl, allowlist: ['api.test'] })).ok).toBe(true);
  });

  it('clears the timeout timer so the process can exit', async () => {
    const spy = vi.spyOn(globalThis, 'clearTimeout');
    await executeCurl(GET(), { fetchImpl: async () => makeResponse({}) });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('formatResultForModel', () => {
  it('renders an error clearly and warns against claiming success', () => {
    const out = formatResultForModel({ ok: false, error: { kind: 'network', message: 'boom' } });
    expect(out).toContain('TOOL ERROR (network)');
    expect(out).toContain('Do not claim it succeeded');
  });

  it('includes only interesting response headers', () => {
    const out = formatResultForModel({
      ok: true, status: 200, statusText: 'OK', elapsedMs: 5,
      headers: { 'content-type': 'text/plain', 'x-noise': 'ignore-me' }, body: 'hi',
    });
    expect(out).toContain('content-type: text/plain');
    expect(out).not.toContain('x-noise');
  });

  it('omits the header section when nothing is interesting', () => {
    const out = formatResultForModel({ ok: true, status: 200, statusText: 'OK', elapsedMs: 1, headers: { 'x-a': '1' }, body: '' });
    expect(out).not.toContain('headers:');
  });

  it('masks secrets that appear in the body', () => {
    const out = formatResultForModel({
      ok: true, status: 200, statusText: 'OK', elapsedMs: 1, headers: {},
      body: 'you sent sekret-value', request: { secrets: ['sekret-value'] },
    });
    expect(out).not.toContain('sekret-value');
    expect(out).toContain(MASK);
  });
});
