/**
 * Tests for the Wikipedia lookup tool.
 *
 * The tool exists because a small model gets the article title right and the
 * URL around it wrong, so what is worth testing is everything the model no
 * longer has to do: resolving a search term to a title, surviving a summary
 * endpoint that refuses, and telling the model what to try next when nothing
 * matched. The network is faked; `executeCurl` is exercised for real underneath,
 * so the allowlist and the byte cap are covered on the way through.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  WikiError,
  articleUrlFor,
  executeWiki,
  formatWikiForModel,
  searchUrlFor,
  stripSnippetHtml,
  summaryUrlFor,
} from '../../src/tools/wiki.js';

/** Minimal Response stand-in; `executeCurl` reads a real stream. */
function makeResponse({ status = 200, body = '', url = '' } = {}) {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    url,
    redirected: false,
    headers: { forEach() {} },
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

const searchBody = (hits) => JSON.stringify({ query: { search: hits } });
const HIT = { title: 'Alan Turing', snippet: 'Alan <span class="searchmatch">Turing</span> was a mathematician' };

/** Route fake responses by which endpoint the URL belongs to. */
function router({ search, summary }) {
  return vi.fn(async (url) => {
    if (url.includes('/w/api.php')) return search;
    if (url.includes('/api/rest_v1/')) return summary;
    throw new TypeError('Failed to fetch');
  });
}

describe('URL construction', () => {
  it('sends origin=* so the API answers a page at all', () => {
    expect(searchUrlFor('Alan Turing')).toContain('origin=*');
  });

  it('encodes the search term rather than pasting it in', () => {
    expect(searchUrlFor('Alan Turing & co')).toContain('srsearch=Alan%20Turing%20%26%20co');
  });

  it('spells titles the way Wikipedia paths do', () => {
    expect(summaryUrlFor('Alan Turing')).toBe('https://en.wikipedia.org/api/rest_v1/page/summary/Alan_Turing');
    expect(articleUrlFor('Alan Turing')).toBe('https://en.wikipedia.org/wiki/Alan_Turing');
  });

  it('produces a URL rather than the string "undefined" for a missing value', () => {
    // These are called with whatever the parser hands over. A guard that turns
    // absent input into the literal text "undefined" would send a request for
    // an article by that name, which exists and is not what anyone asked for.
    for (const build of [searchUrlFor, summaryUrlFor, articleUrlFor]) {
      for (const bad of [undefined, null, '']) {
        expect(build(bad)).not.toContain('undefined');
        expect(build(bad)).not.toContain('null');
      }
    }
  });

  it('never produces the www portal, which answers the article API with a 500', () => {
    // Two of the eleven measured failures built exactly that host.
    for (const u of [searchUrlFor('x'), summaryUrlFor('x'), articleUrlFor('x')]) {
      expect(u).not.toContain('www.wikipedia.org');
    }
  });
});

describe('stripSnippetHtml', () => {
  it('removes markup and entities from a search snippet', () => {
    expect(stripSnippetHtml('Alan <span class="searchmatch">Turing</span> &amp; friends')).toBe(
      'Alan Turing & friends'
    );
  });

  it('survives an empty or absent snippet', () => {
    expect(stripSnippetHtml(undefined)).toBe('');
  });
});

describe('executeWiki', () => {
  it('resolves a search term to an article and returns its summary', async () => {
    const fetchImpl = router({
      search: makeResponse({ body: searchBody([HIT]) }),
      summary: makeResponse({ body: JSON.stringify({ extract: 'Alan Mathison Turing was an English mathematician.' }) }),
    });

    const r = await executeWiki({ query: 'alan turing' }, { fetchImpl });

    expect(r.ok).toBe(true);
    expect(r.title).toBe('Alan Turing');
    expect(r.extract).toContain('English mathematician');
    expect(r.exact).toBe(true);
    expect(r.url).toBe('https://en.wikipedia.org/wiki/Alan_Turing');
  });

  it('reports both requests, so the log cannot understate what was fetched', async () => {
    const fetchImpl = router({
      search: makeResponse({ body: searchBody([HIT]) }),
      summary: makeResponse({ body: JSON.stringify({ extract: 'x' }) }),
    });
    const r = await executeWiki({ query: 'alan turing' }, { fetchImpl });
    expect(r.requests).toHaveLength(2);
    expect(r.requests[0].request.url).toContain('/w/api.php');
    expect(r.requests[1].request.url).toContain('/api/rest_v1/');
  });

  it('falls back to the search snippet when the summary endpoint refuses', async () => {
    const fetchImpl = router({
      search: makeResponse({ body: searchBody([HIT]) }),
      summary: makeResponse({ status: 404, body: 'not found' }),
    });

    const r = await executeWiki({ query: 'alan turing' }, { fetchImpl });

    expect(r.ok).toBe(true);
    expect(r.extract).toBe('Alan Turing was a mathematician');
    // The model is told the text is second-best rather than being left to
    // assume it read the article.
    expect(r.exact).toBe(false);
    expect(formatWikiForModel(r)).toContain('search snippet');
  });

  it('offers the other matches when the first is not what was wanted', async () => {
    const fetchImpl = router({
      search: makeResponse({ body: searchBody([HIT, { title: 'Turing test' }, { title: 'Turing machine' }]) }),
      summary: makeResponse({ body: JSON.stringify({ extract: 'x' }) }),
    });
    const r = await executeWiki({ query: 'turing' }, { fetchImpl });
    expect(r.alternatives).toEqual(['Turing test', 'Turing machine']);
  });

  it('distinguishes nothing-matched from could-not-reach', async () => {
    const empty = await executeWiki(
      { query: 'qqqzzz' },
      { fetchImpl: router({ search: makeResponse({ body: searchBody([]) }) }) }
    );
    expect(empty.ok).toBe(false);
    expect(empty.error.kind).toBe(WikiError.NO_MATCH);

    const offline = await executeWiki(
      { query: 'x' },
      {
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      }
    );
    expect(offline.ok).toBe(false);
    expect(offline.error.kind).toBe(WikiError.UNREACHABLE);
  });

  it('treats a non-result response as a bad response, not as no match', async () => {
    const r = await executeWiki(
      { query: 'x' },
      { fetchImpl: router({ search: makeResponse({ body: '<html>error</html>' }) }) }
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe(WikiError.BAD_RESPONSE);
  });

  it('admits it found an article it could not read', async () => {
    // Summary refused and the snippet is empty: there is a title but no text.
    // Reporting the title alone would invite the model to answer from the name.
    const fetchImpl = router({
      search: makeResponse({ body: searchBody([{ title: 'Alan Turing', snippet: '' }]) }),
      summary: makeResponse({ status: 404, body: 'nope' }),
    });
    const r = await executeWiki({ query: 'alan turing' }, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe(WikiError.BAD_RESPONSE);
    expect(r.error.message).toContain('Alan Turing');
    expect(r.title).toBe('Alan Turing');
  });

  it('treats a summary that parses but carries no extract as unreadable', async () => {
    const fetchImpl = router({
      search: makeResponse({ body: searchBody([{ title: 'Alan Turing', snippet: '' }]) }),
      summary: makeResponse({ body: '{"not_an_extract": true}' }),
    });
    const r = await executeWiki({ query: 'alan turing' }, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe(WikiError.BAD_RESPONSE);
  });

  it('refuses an empty search term without touching the network', async () => {
    const fetchImpl = vi.fn();
    const r = await executeWiki({ query: '   ' }, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honours the domain allowlist like any other request', async () => {
    const r = await executeWiki(
      { query: 'x' },
      { fetchImpl: vi.fn(), allowlist: ['example.com'] }
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe(WikiError.UNREACHABLE);
    expect(r.error.message).toContain('allowlist');
  });
});

describe('formatWikiForModel', () => {
  it('gives the model prose rather than JSON', () => {
    const text = formatWikiForModel({
      ok: true,
      title: 'Alan Turing',
      extract: 'He was a mathematician.',
      exact: true,
      url: 'https://en.wikipedia.org/wiki/Alan_Turing',
    });
    expect(text).toContain('WIKIPEDIA: Alan Turing');
    expect(text).toContain('He was a mathematician.');
    expect(text).not.toContain('{');
  });

  it('ends a failure with an imperative naming the next call', () => {
    // The position finding, applied: on this model an instruction in the last
    // line is acted on and the same instruction mid-paragraph is not.
    const withAlts = formatWikiForModel({
      ok: false,
      error: { kind: WikiError.NO_MATCH, message: 'No Wikipedia article matched "turring".' },
      alternatives: ['Turing test'],
    });
    expect(withAlts.trim().split('\n').pop()).toMatch(/^NEXT STEP: call the wiki tool again with one of those titles/);

    const without = formatWikiForModel({
      ok: false,
      error: { kind: WikiError.NO_MATCH, message: 'none' },
      alternatives: [],
    });
    expect(without.trim().split('\n').pop()).toMatch(/^NEXT STEP: call the wiki tool again with a shorter/);
  });
});
