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
 * A hint is a *function of the URL that failed*, not a fixed sentence.
 *
 * The first version handed the model a template — "use
 * .../page/summary/Article_Title" — and a 0.6B model requested exactly that,
 * `Article_Title` and all. It is the same failure as the `example.com/path` in
 * our own schema example: a plausible-looking placeholder in front of a small
 * model is something to copy, not something to fill in. So a hint names the
 * real URL for the thing that was just asked for, and the model only has to
 * copy it.
 *
 * @typedef {object} ApiHint
 * @property {RegExp} test Matched against the failing request's hostname.
 * @property {(url: URL) => string|null} hint The advice, given the failed URL.
 */

/** @type {ReadonlyArray<ApiHint>} */
export const API_HINTS = Object.freeze([
  {
    test: /(^|\.)wikipedia\.org$/i,
    hint: (url) => {
      const title = wikipediaTitle(url);
      // "www" is three letters and is not a language: www.wikipedia.org is the
      // portal, which has no article API at all. Anything unrecognised falls
      // back to en, which at least exists.
      const sub = /^([a-z]{2,3})\.(m\.)?wikipedia\.org$/i.exec(url.hostname)?.[1]?.toLowerCase();
      const lang = !sub || sub === 'www' ? 'en' : sub;
      if (!title) {
        return (
          `Wikipedia article pages block cross-origin requests; its REST API allows them. ` +
          `The URL shape is https://${lang}.wikipedia.org/api/rest_v1/page/summary/ followed by ` +
          `the article title with underscores for spaces.`
        );
      }
      // The exact URL for what was just asked for. Nothing to fill in.
      return (
        `Wikipedia article pages block cross-origin requests; its REST API allows them. ` +
        `Request this instead: https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`
      );
    },
  },
  {
    test: /(^|\.)wikidata\.org$/i,
    hint: () =>
      'Wikidata HTML pages block cross-origin requests; the API allows them, e.g. ' +
      'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&ids=Q42',
  },
  {
    test: /(^|\.)github\.com$/i,
    hint: (url) => {
      const repo = /^\/([^/]+)\/([^/]+)/.exec(url.pathname);
      return repo
        ? `github.com pages block cross-origin requests; api.github.com allows them. ` +
          `Request this instead: https://api.github.com/repos/${repo[1]}/${repo[2]}`
        : 'github.com pages block cross-origin requests; api.github.com allows them, e.g. ' +
          'https://api.github.com/repos/owner/name';
    },
  },
]);

/**
 * The article title out of a Wikipedia URL, if there is one to find.
 *
 * Handles the two forms a model reaches for — `/wiki/Title` and
 * `/w/index.php?title=Title` — and returns null rather than a guess for
 * anything else, because a wrong title produces a confident 404 and that is
 * worse than admitting the shape.
 *
 * @param {URL} url
 * @returns {string|null}
 */
function wikipediaTitle(url) {
  const fromPath = /^\/wiki\/(.+)$/.exec(url.pathname);
  const raw = fromPath ? fromPath[1] : url.searchParams.get('title') || url.searchParams.get('search');
  if (!raw) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const title = decoded.trim().replace(/\s+/g, '_');
  return title && !title.includes('/') ? encodeURIComponent(title).replace(/%2F/gi, '') : null;
}

/**
 * The hint for a failed request, if there is one.
 *
 * @param {URL|string} url The URL that failed.
 * @returns {string|null}
 */
export function apiHintFor(url) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url));
  } catch {
    return null;
  }
  const entry = API_HINTS.find((h) => h.test.test(parsed.hostname));
  return entry ? entry.hint(parsed) || null : null;
}

/**
 * The URL a hint recommends, on its own.
 *
 * Prose is for the user; this is for the model. Told in a paragraph to
 * "request this instead: <url>", a 0.6B model changed the hostname and kept the
 * path, or read the URL back to the user as advice — it never called the tool
 * with it. What it needs is not a better sentence but a single unambiguous
 * instruction in the position it attends to, and that needs the URL as a value
 * rather than as a substring of English.
 *
 * @param {URL|string} url The URL that failed.
 * @returns {string|null}
 */
export function retryUrlFor(url) {
  const hint = apiHintFor(url);
  if (!hint) return null;
  const found = /https:\/\/\S+/.exec(hint.replace(/^[^:]*:\s*/, ''));
  const candidate = found?.[0]?.replace(/[.,)]+$/, '') ?? null;
  // Only a hint that names one concrete URL yields an instruction; the
  // fallback "the URL shape is …" text deliberately does not.
  return candidate && !/Article_Title|owner\/name|\/$/.test(candidate) ? candidate : null;
}
