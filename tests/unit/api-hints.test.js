/**
 * Tests for the API hints, and for the one place they surface.
 *
 * The rule these pin down is that a hint is *targeted help at the moment of
 * failure*, not a directory bolted onto every prompt: it appears when a request
 * to that host has failed and at no other time.
 */

import { describe, expect, it } from 'vitest';
import { API_HINTS, apiHintFor } from '../../src/tools/api-hints.js';
import { executeCurl } from '../../src/tools/curl.js';

describe('apiHintFor', () => {
  it('matches a host and its subdomains', () => {
    expect(apiHintFor('en.wikipedia.org')).toMatch(/rest_v1/);
    expect(apiHintFor('wikipedia.org')).toMatch(/rest_v1/);
    expect(apiHintFor('de.m.wikipedia.org')).toMatch(/rest_v1/);
  });

  it('ignores a port', () => {
    expect(apiHintFor('en.wikipedia.org:443')).toMatch(/rest_v1/);
  });

  it('does not match a lookalike host', () => {
    // The suffix check must be anchored: an attacker-registered
    // notwikipedia.org must not inherit Wikipedia's advice.
    expect(apiHintFor('notwikipedia.org')).toBeNull();
    expect(apiHintFor('wikipedia.org.evil.test')).toBeNull();
  });

  it('returns null for hosts it knows nothing about, rather than guessing', () => {
    expect(apiHintFor('example.com')).toBeNull();
    expect(apiHintFor('')).toBeNull();
    expect(apiHintFor(undefined)).toBeNull();
  });

  it('only ever names https URLs, since the app is served over https', () => {
    for (const { hint } of API_HINTS) {
      expect(hint).not.toMatch(/http:\/\//);
      expect(hint).toMatch(/https:\/\//);
    }
  });
});

describe('the network failure explanation', () => {
  /** A fetch that fails the way a CORS refusal does: an opaque TypeError. */
  const refuse = () => Promise.reject(new TypeError('Failed to fetch'));

  it('names a working endpoint when the failed host has one', async () => {
    const r = await executeCurl(
      { method: 'GET', url: 'https://en.wikipedia.org/wiki/Telephone' },
      { fetchImpl: refuse, pageProtocol: 'https:' }
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('network');
    expect(r.error.message).toMatch(/CORS/);
    // The part a model can act on.
    expect(r.error.message).toMatch(/rest_v1\/page\/summary/);
  });

  it('still explains itself for a host it has no hint for', async () => {
    const r = await executeCurl(
      { method: 'GET', url: 'https://nowhere.example/thing' },
      { fetchImpl: refuse, pageProtocol: 'https:' }
    );
    expect(r.error.message).toMatch(/CORS/);
    expect(r.error.message).not.toMatch(/rest_v1/);
    // No trailing gap where the hint would have been.
    expect(r.error.message).not.toMatch(/ {2}/);
  });

  it('does not appear when the request succeeds', async () => {
    const ok = () =>
      Promise.resolve(
        new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      );
    const r = await executeCurl(
      { method: 'GET', url: 'https://en.wikipedia.org/api/rest_v1/page/summary/Telephone' },
      { fetchImpl: ok, pageProtocol: 'https:' }
    );
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/underscores for spaces/);
  });

  it('is not offered for a timeout, which a different URL would not fix', async () => {
    const hang = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    const r = await executeCurl(
      { method: 'GET', url: 'https://en.wikipedia.org/wiki/Telephone' },
      { fetchImpl: hang, pageProtocol: 'https:', timeoutMs: 10 }
    );
    expect(r.error.kind).toBe('timeout');
    expect(r.error.message).not.toMatch(/rest_v1/);
  });
});
