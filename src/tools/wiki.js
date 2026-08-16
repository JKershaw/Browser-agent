/**
 * A Wikipedia lookup that takes a search term instead of a URL.
 *
 * Why a second tool exists at all, when `curl` can already reach Wikipedia:
 * measured on Qwen3-0.6B, asked to look something up, the model builds a URL
 * that fails and then cannot repair it. Across the eleven failures in that
 * measurement the *article title* was correct eleven times out of eleven, and
 * the scheme, host and path shape were wrong in ten. Four of them recombined
 * the suggested URL with their own — the right host on the wrong path, or the
 * right path on the wrong host.
 *
 * So the tool asks for the one part the model reliably gets right, and does the
 * rest itself. Every hop inside this module is a hop the model cannot get
 * wrong: search resolves the term to a real title, and the title is what fetches
 * the article. That covers the ambiguous title, the `www` portal that answers
 * the article API with a 500, and the redirect, none of which the model ever
 * sees.
 *
 * The requests still go through `executeCurl`, so the allowlist, the timeout,
 * the byte cap, the proxy and the redirect checks all apply exactly as they do
 * to a model-built request. This is a narrower interface to the same tool, not
 * a way around its rules.
 *
 * @module tools/wiki
 */

import { executeCurl } from './curl.js';
import { articleUrlFor, searchUrlFor, summaryUrlFor } from './wiki-urls.js';

export { WIKI_HOST, articleUrlFor, searchUrlFor, summaryUrlFor } from './wiki-urls.js';

/**
 * Distinct failure modes, kept separate for the same reason `CurlError` is:
 * a model that is told *which* thing went wrong can do something about it.
 * @enum {string}
 */
export const WikiError = Object.freeze({
  /** The search ran and matched nothing. */
  NO_MATCH: 'no_match',
  /** Search or article fetch did not complete. */
  UNREACHABLE: 'unreachable',
  /** A response arrived but was not the shape the API documents. */
  BAD_RESPONSE: 'bad_response',
});

/**
 * Strip the HTML the search API puts in its snippets.
 *
 * Snippets arrive with `<span class="searchmatch">` around the hit. This is the
 * fallback extract, so it reaches the model's context and must be plain text.
 *
 * @param {string} html
 * @returns {string}
 */
export function stripSnippetHtml(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Look one thing up on Wikipedia.
 *
 * Never throws for an expected failure, matching the `executeCurl` contract:
 * every outcome is a plain object the agent loop can serialise.
 *
 * @param {{query: string}} args
 * @param {object} [opts] Passed through to `executeCurl` (fetchImpl, timeoutMs,
 *   maxBytes, allowlist, proxyTemplate, signal, …).
 * @returns {Promise<object>}
 */
export async function executeWiki(args, opts = {}) {
  const query = String(args?.query ?? '').trim();
  /** Every request made, so the log and the UI can show the whole story. */
  const requests = [];

  if (query === '') {
    return {
      ok: false,
      tool: 'wiki',
      query,
      error: { kind: WikiError.NO_MATCH, message: 'No search term was given.' },
      requests,
    };
  }

  const search = await executeCurl(
    { method: 'GET', url: searchUrlFor(query), headers: {}, body: null },
    opts
  );
  requests.push(search);

  if (!search.ok) {
    return {
      ok: false,
      tool: 'wiki',
      query,
      error: { kind: WikiError.UNREACHABLE, message: search.error.message },
      requests,
    };
  }

  let hits;
  try {
    hits = JSON.parse(search.body)?.query?.search;
  } catch {
    hits = null;
  }
  if (!Array.isArray(hits)) {
    return {
      ok: false,
      tool: 'wiki',
      query,
      error: {
        kind: WikiError.BAD_RESPONSE,
        message: `Wikipedia's search API answered with something other than a result list (HTTP ${search.status}).`,
      },
      requests,
    };
  }
  if (hits.length === 0) {
    return {
      ok: false,
      tool: 'wiki',
      query,
      error: { kind: WikiError.NO_MATCH, message: `No Wikipedia article matched "${query}".` },
      alternatives: [],
      requests,
    };
  }

  const title = String(hits[0].title);
  const alternatives = hits.slice(1).map((h) => String(h.title));

  // The summary is the good extract; the search snippet is the fallback. A
  // title that search returned can still miss here — a redirect the REST API
  // resolves differently, or a page type it does not serve — and a fragment of
  // real article text beats reporting nothing at all.
  const summary = await executeCurl(
    { method: 'GET', url: summaryUrlFor(title), headers: {}, body: null },
    opts
  );
  requests.push(summary);

  let extract = '';
  let exact = false;
  if (summary.ok && summary.status < 400) {
    try {
      extract = String(JSON.parse(summary.body)?.extract ?? '').trim();
      exact = extract !== '';
    } catch {
      extract = '';
    }
  }
  if (extract === '') extract = stripSnippetHtml(hits[0].snippet);

  if (extract === '') {
    return {
      ok: false,
      tool: 'wiki',
      query,
      title,
      alternatives,
      error: {
        kind: WikiError.BAD_RESPONSE,
        message: `Found the article "${title}" but could not read any text from it.`,
      },
      requests,
    };
  }

  return {
    ok: true,
    tool: 'wiki',
    query,
    title,
    extract,
    /** False when the text is a search snippet rather than the article summary. */
    exact,
    alternatives,
    url: articleUrlFor(title),
    requests,
  };
}

/**
 * Render a wiki result as the text the model sees.
 *
 * Deliberately short and unstructured. The model's job here is to read one
 * paragraph and answer a question about it; JSON, headers and byte counts are
 * things it would have to look past to do that.
 *
 * On failure the last line is an imperative naming the next call, for the
 * reason recorded in `formatResultForModel` and in BUILD_LOG: on a model this
 * size, an instruction in the final position is acted on and the same
 * instruction in a paragraph is not.
 *
 * @param {object} result Output of `executeWiki`.
 * @returns {string}
 */
export function formatWikiForModel(result) {
  if (!result.ok) {
    const alts = result.alternatives?.length
      ? [`Closest article titles: ${result.alternatives.join(', ')}.`]
      : [];
    const next = result.alternatives?.length
      ? `NEXT STEP: call the wiki tool again with one of those titles as the query.`
      : `NEXT STEP: call the wiki tool again with a shorter or more common search term.`;
    return [
      `WIKI ERROR (${result.error.kind})`,
      result.error.message,
      ...alts,
      '',
      next,
    ].join('\n');
  }

  return [
    `WIKIPEDIA: ${result.title}`,
    result.extract,
    ...(result.exact ? [] : ['(This is a search snippet, not the article summary.)']),
    `Source: ${result.url}`,
  ].join('\n');
}
