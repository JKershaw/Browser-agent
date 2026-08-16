/**
 * What to try instead, for hosts whose HTML is unreachable but whose API is not.
 *
 * The browser will not let a page fetch most websites, and it will not say why.
 * The agent's own error message explains CORS honestly, but "the usual cause is
 * CORS" is not something a model can act on: measured on Qwen3-0.6B and
 * Qwen3-1.7B, asked to look something up on Wikipedia, both fetched the article
 * URL and failed, every time, 0 out of 20 each. Told in the system prompt that
 * HTML is unreachable, the 0.6B stopped fetching articles and started inventing
 * endpoints instead — `https://en.wikipedia.org/wikipedia/api/rest` — because
 * knowing HTML will fail does not tell you what will work.
 *
 * Handed the right endpoint, the same model reads the JSON and answers
 * correctly. So the missing ingredient is a URL, and this is where the few we
 * can vouch for live.
 *
 * Deliberately small, and deliberately not a directory of the web:
 *
 * - Every entry must be **verified** — the endpoint sends
 *   `Access-Control-Allow-Origin`, so the advice works from a page.
 * - Entries are surfaced **only when a request to that host has just failed**,
 *   so they cost nothing in the system prompt and cannot steer a model that was
 *   doing fine.
 * - The list will always be incomplete. That is honest: the alternative is
 *   pretending to know the whole web, and a wrong hint is worse than none.
 *
 * @module tools/api-hints
 */

/**
 * @typedef {object} ApiHint
 * @property {RegExp} test Matched against the failing request's hostname.
 * @property {string} hint One or two sentences naming a URL that does work.
 */

/** @type {ReadonlyArray<ApiHint>} */
export const API_HINTS = Object.freeze([
  {
    test: /(^|\.)wikipedia\.org$/i,
    hint:
      'Wikipedia article pages (/wiki/…) block cross-origin requests, but its APIs allow them. ' +
      'For a short summary use https://en.wikipedia.org/api/rest_v1/page/summary/Article_Title ' +
      '(underscores for spaces, no /wiki/). For article text use ' +
      'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=extracts&explaintext&titles=Article_Title ' +
      '— the origin=* parameter is required.',
  },
  {
    test: /(^|\.)wikidata\.org$/i,
    hint:
      'Use the Wikidata API rather than the HTML pages: ' +
      'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&ids=Q42.',
  },
  {
    test: /(^|\.)github\.com$/i,
    hint:
      'github.com pages block cross-origin requests; api.github.com allows them. ' +
      'For example https://api.github.com/repos/owner/name for a repository, or ' +
      'https://api.github.com/repos/owner/name/issues for its issues.',
  },
]);

/**
 * The hint for a host, if there is one.
 *
 * @param {string} host A hostname, with or without a port.
 * @returns {string|null}
 */
export function apiHintFor(host) {
  if (!host || typeof host !== 'string') return null;
  const name = host.split(':')[0];
  return API_HINTS.find((h) => h.test.test(name))?.hint ?? null;
}
