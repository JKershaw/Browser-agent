/**
 * Wikipedia URL construction, with no dependencies.
 *
 * Split out of `tools/wiki.js` so the parser can derive a call's URL without
 * importing the executor: `agent/toolcall.js` needs `searchUrlFor`, and
 * `tools/wiki.js` needs `executeCurl`, which needs `agent/toolcall.js`. A leaf
 * module breaks that cycle instead of relying on the bindings happening to be
 * initialised in the right order.
 *
 * @module tools/wiki-urls
 */

/** Wikipedia language edition these helpers address. */
export const WIKI_HOST = 'en.wikipedia.org';

/** How many search hits to keep for the "did you mean" recovery path. */
export const MAX_ALTERNATIVES = 5;

/** A title as Wikipedia paths spell it: spaces become underscores. */
function pathTitle(title) {
  return encodeURIComponent(String(title ?? '').trim().replace(/\s+/g, '_'));
}

/**
 * The search endpoint for a term.
 *
 * `origin=*` is what makes the Action API send `Access-Control-Allow-Origin`;
 * without it this is as unreachable from a page as the article HTML is.
 *
 * @param {string} query
 * @returns {string}
 */
export function searchUrlFor(query) {
  const q = String(query ?? '').trim();
  return (
    `https://${WIKI_HOST}/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(q)}&srlimit=${MAX_ALTERNATIVES}&format=json&origin=*`
  );
}

/**
 * The REST summary endpoint for an exact article title.
 *
 * @param {string} title
 * @returns {string}
 */
export function summaryUrlFor(title) {
  return `https://${WIKI_HOST}/api/rest_v1/page/summary/${pathTitle(title)}`;
}

/**
 * The human-readable article page, for citing a source.
 *
 * @param {string} title
 * @returns {string}
 */
export function articleUrlFor(title) {
  return `https://${WIKI_HOST}/wiki/${pathTitle(title)}`;
}
