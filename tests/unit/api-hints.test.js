/**
 * Tests for the API hints, and for the one place they surface.
 *
 * The rule these pin down is that a hint is *targeted help at the moment of
 * failure*, not a directory bolted onto every prompt: it appears when a request
 * to that host has failed and at no other time.
 */

import { describe, expect, it } from 'vitest';
import { API_HINTS, apiHintFor, retryUrlFor } from '../../src/tools/api-hints.js';
import { executeCurl, formatResultForModel } from '../../src/tools/curl.js';

describe('apiHintFor', () => {
  it('names the exact URL for the article that was asked for', () => {
    // The point of the whole module: nothing left to fill in. An earlier
    // version said "…/page/summary/Article_Title" and the model requested
    // Article_Title, literally.
    expect(apiHintFor('https://en.wikipedia.org/wiki/Alexander_Graham_Bell')).toContain(
      'https://en.wikipedia.org/api/rest_v1/page/summary/Alexander_Graham_Bell'
    );
  });

  it('carries no placeholder a model could copy verbatim', () => {
    const hint = apiHintFor('https://en.wikipedia.org/wiki/Telephone');
    expect(hint).not.toMatch(/Article_Title|<[^>]+>|example\.com/);
  });

  it('normalises a percent-encoded or spaced title', () => {
    expect(apiHintFor('https://wikipedia.org/wiki/Clifton%20Suspension%20Bridge')).toContain(
      'summary/Clifton_Suspension_Bridge'
    );
  });

  it('keeps the language subdomain, and knows www is not one', () => {
    expect(apiHintFor('https://fr.wikipedia.org/wiki/Tour_Eiffel')).toContain('https://fr.wikipedia.org/');
    // www.wikipedia.org is the portal and has no article API; en does.
    expect(apiHintFor('https://www.wikipedia.org/wiki/Telephone')).toContain('https://en.wikipedia.org/');
  });

  it('falls back to the URL shape when there is no title to use', () => {
    const hint = apiHintFor('https://en.wikipedia.org/');
    expect(hint).toMatch(/rest_v1/);
    expect(hint).not.toMatch(/Request this instead/);
  });

  it('reads a title out of the query form too', () => {
    expect(apiHintFor('https://en.wikipedia.org/w/index.php?title=Bristol')).toContain('summary/Bristol');
  });

  it('builds the api.github.com URL for a repository page', () => {
    expect(apiHintFor('https://github.com/JKershaw/Browser-agent')).toContain(
      'https://api.github.com/repos/JKershaw/Browser-agent'
    );
  });

  it('does not match a lookalike host', () => {
    // The suffix check must be anchored: an attacker-registered
    // notwikipedia.org must not inherit Wikipedia's advice.
    expect(apiHintFor('https://notwikipedia.org/wiki/X')).toBeNull();
    expect(apiHintFor('https://wikipedia.org.evil.test/wiki/X')).toBeNull();
  });

  it('returns null for hosts it knows nothing about, rather than guessing', () => {
    expect(apiHintFor('https://example.com/')).toBeNull();
    expect(apiHintFor('not a url')).toBeNull();
    expect(apiHintFor(undefined)).toBeNull();
  });

  it('only ever names https URLs, since the app is served over https', () => {
    const probes = [
      'https://en.wikipedia.org/wiki/Telephone',
      'https://en.wikipedia.org/',
      'https://www.wikidata.org/wiki/Q42',
      'https://github.com/owner/name',
      'https://github.com/',
    ];
    for (const p of probes) {
      const hint = apiHintFor(p);
      expect(hint).not.toMatch(/http:\/\//);
      expect(hint).toMatch(/https:\/\//);
    }
    expect(API_HINTS.length).toBeGreaterThan(0);
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

describe('retryUrlFor', () => {
  it('yields the URL on its own, ready to be called', () => {
    expect(retryUrlFor('https://en.wikipedia.org/wiki/Telephone')).toBe(
      'https://en.wikipedia.org/api/rest_v1/page/summary/Telephone'
    );
    expect(retryUrlFor('https://github.com/JKershaw/Browser-agent')).toBe(
      'https://api.github.com/repos/JKershaw/Browser-agent'
    );
  });

  it('withholds an instruction when the advice is only a shape', () => {
    // "The URL shape is …/summary/ followed by the title" is guidance, not a
    // URL. Turning it into "call this exact URL" would send the model to a
    // 404 with a confident instruction behind it.
    expect(retryUrlFor('https://en.wikipedia.org/')).toBeNull();
    expect(retryUrlFor('https://github.com/')).toBeNull();
  });

  it('has nothing to say about hosts with no hint', () => {
    expect(retryUrlFor('https://example.com/')).toBeNull();
  });
});

describe('the model-facing failure text', () => {
  const refuse = () => Promise.reject(new TypeError('Failed to fetch'));

  it('ends with the instruction, because the end is what the model acts on', async () => {
    const r = await executeCurl(
      { method: 'GET', url: 'https://en.wikipedia.org/wiki/Alexander_Graham_Bell' },
      { fetchImpl: refuse, pageProtocol: 'https:' }
    );
    const text = formatResultForModel(r);
    expect(text.trim().split('\n').pop()).toBe(
      'NEXT STEP: call the tool again with exactly this URL: https://en.wikipedia.org/api/rest_v1/page/summary/Alexander_Graham_Bell'
    );
  });

  it('adds no instruction when there is no URL to offer', async () => {
    const r = await executeCurl(
      { method: 'GET', url: 'https://nowhere.example/thing' },
      { fetchImpl: refuse, pageProtocol: 'https:' }
    );
    expect(formatResultForModel(r)).not.toMatch(/NEXT STEP/);
  });

  it('keeps the instruction off successful results', async () => {
    const ok = () => Promise.resolve(new Response('{}', { status: 200 }));
    const r = await executeCurl(
      { method: 'GET', url: 'https://en.wikipedia.org/wiki/Telephone' },
      { fetchImpl: ok, pageProtocol: 'https:' }
    );
    expect(formatResultForModel(r)).not.toMatch(/NEXT STEP/);
  });
});
