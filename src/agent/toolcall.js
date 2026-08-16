/**
 * Tool-call parsing, validation and repair support.
 *
 * Pure module: string in -> plain result object out. No DOM, no network, no
 * globals beyond standard built-ins. This is the highest-value unit-test
 * target in the project because the model's output is the least trustworthy
 * input the app handles.
 *
 * @module agent/toolcall
 */

import { searchUrlFor } from '../tools/wiki-urls.js';

/** The general HTTP tool. */
export const TOOL_NAME = 'curl';

/** The Wikipedia lookup tool; see `tools/wiki.js` for why it exists. */
export const WIKI_TOOL = 'wiki';

/** Every tool name the parser will accept. */
export const TOOL_NAMES = Object.freeze([TOOL_NAME, WIKI_TOOL]);

/** HTTP methods the tool accepts, upper-case. */
export const ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/** Methods for which a non-null request body is rejected. */
const BODYLESS_METHODS = Object.freeze(['GET', 'HEAD']);

/** URL schemes the tool will dispatch. */
export const ALLOWED_SCHEMES = Object.freeze(['http:', 'https:']);

/**
 * Stable error codes. Surfaced to the user and fed verbatim into the repair
 * prompt, so the strings are part of the contract.
 * @enum {string}
 */
export const ParseError = Object.freeze({
  JSON_PARSE: 'E_JSON_PARSE',
  NOT_OBJECT: 'E_NOT_OBJECT',
  UNKNOWN_TOOL: 'E_UNKNOWN_TOOL',
  MISSING_ARGS: 'E_MISSING_ARGS',
  BAD_METHOD: 'E_BAD_METHOD',
  BAD_URL: 'E_BAD_URL',
  BAD_SCHEME: 'E_BAD_SCHEME',
  BAD_HEADERS: 'E_BAD_HEADERS',
  BAD_BODY: 'E_BAD_BODY',
  BODY_NOT_ALLOWED: 'E_BODY_NOT_ALLOWED',
  BAD_QUERY: 'E_BAD_QUERY',
});

/**
 * Remove reasoning-mode preambles that some models emit before their answer.
 * Handles both closed `<think>...</think>` blocks and an unterminated opening
 * tag (which happens when generation is cut short).
 *
 * @param {string} text Raw model output.
 * @returns {string} Text with thinking blocks removed.
 */
export function stripThinking(text) {
  if (typeof text !== 'string') return '';
  let out = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  // Unterminated opening tag: everything after it is reasoning we never saw
  // the end of. Drop it rather than feed half a thought to the parser.
  out = out.replace(/<think(?:ing)?>[\s\S]*$/i, '');
  // A stray closing tag has no reliable meaning: it can be a doubled closer
  // after a complete block ("<think>x</think>answer</think>"), or a model
  // talking about the tag. Deleting everything before it — the obvious reading
  // — throws away the answer in both cases, so the tag alone is removed and
  // every character of content is kept. Verbose output beats a blank reply.
  out = out.replace(/<\/think(?:ing)?>/gi, '');
  return out.trim();
}

/**
 * Scan forward from `start` (which must index a `{`) and return the index just
 * past the matching `}`, respecting JSON string literals and escapes.
 *
 * Exported for `stream-filter.js`, which needs the same "where does this
 * object end" answer to suppress a tool call from the streaming display.
 *
 * @param {string} s
 * @param {number} start
 * @returns {number} End index (exclusive), or -1 if unbalanced.
 */
export function matchBalanced(s, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Locate the JSON object a tool call would live in.
 *
 * Preference order: a fenced code block (``` or ```json), then the first
 * balanced `{...}` anywhere in the text. Returns the surrounding prose too so
 * the caller can still show what the model said around the call.
 *
 * @param {string} text Thinking-stripped model output.
 * @returns {{json: string, prose: string}|null}
 */
export function extractJsonCandidate(text) {
  if (typeof text !== 'string' || text.length === 0) return null;

  // Fenced blocks first. Accept an unterminated final fence too, since a
  // truncated stream commonly loses the closing backticks.
  const fence = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)/g;
  /** @type {Array<[number, number]>} Spans of every fence, JSON or not. */
  const fenceSpans = [];
  let m;
  while ((m = fence.exec(text)) !== null) {
    fenceSpans.push([m.index, m.index + m[0].length]);
    const lang = m[1].toLowerCase();
    if (lang && lang !== 'json' && lang !== 'tool' && lang !== 'tool_call') continue;
    const inner = m[2].trim();
    const open = inner.indexOf('{');
    if (open === -1) continue;
    const end = matchBalanced(inner, open);
    const json = end === -1 ? inner.slice(open) : inner.slice(open, end);
    const prose = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
    return { json, prose };
  }

  // Fallback: scan the raw text for balanced objects, but never inside a fence
  // we already rejected. A ```python block illustrating a call the model
  // explicitly declined to make must not be dispatched as a real one.
  const inFence = (i) => fenceSpans.some(([a, b]) => i >= a && i < b);

  // Try every balanced object, not just the first: prose routinely contains
  // braces — including the {{credential}} placeholders the system prompt
  // teaches the model to write — ahead of the real call.
  let cursor = 0;
  let firstCandidate = null;
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor);
    if (open === -1) break;
    if (inFence(open)) {
      cursor = open + 1;
      continue;
    }
    const end = matchBalanced(text, open);
    const json = end === -1 ? text.slice(open) : text.slice(open, end);
    const prose = end === -1
      ? text.slice(0, open).trim()
      : (text.slice(0, open) + text.slice(end)).trim();
    const candidate = { json, prose };

    if (looksLikeToolJson(json)) return candidate;
    if (firstCandidate === null) firstCandidate = candidate;
    if (end === -1) break;
    cursor = end;
  }

  return firstCandidate;
}

/**
 * Cheap pre-check: does this fragment mention a `"tool"` key?
 * Used to prefer a real call over incidental braces in prose.
 *
 * @param {string} json
 * @returns {boolean}
 */
function looksLikeToolJson(json) {
  return /"tool"\s*:/.test(json);
}

/** @param {string} code @param {string} message */
function err(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * Validate a `wiki` call and give it a URL.
 *
 * The URL is *derived*, never taken from the model — that is the entire point
 * of the tool. It is attached anyway because it is the request the confirmation
 * card, the log and the tool card will show, and a card that cannot name where
 * the request is going would be a real loss: the user's veto has to stay
 * informed no matter which tool asked.
 *
 * @param {object} args
 * @returns {{ok: true, call: object}|{ok: false, error: {code: string, message: string}}}
 */
function validateWikiCall(args) {
  const raw = args.query ?? args.q ?? args.search ?? args.term ?? args.title;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return err(ParseError.BAD_QUERY, 'args.query must be a non-empty search term, e.g. {"query": "Alan Turing"}.');
  }
  const query = raw.trim();
  return {
    ok: true,
    call: {
      tool: WIKI_TOOL,
      args: { query, method: 'GET', url: searchUrlFor(query), headers: {}, body: null },
    },
  };
}

/**
 * Validate a parsed object against the tool-call schema and normalise it.
 *
 * Normalisation performed: method upper-cased, header names/values coerced to
 * trimmed strings, absent `headers`/`body` filled with `{}` / `null`.
 *
 * @param {unknown} obj Result of `JSON.parse`.
 * @returns {{ok: true, call: {tool: string, args: {method: string, url: string, headers: Object<string,string>, body: string|null}}}
 *          |{ok: false, error: {code: string, message: string}}}
 */
export function validateToolCall(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return err(ParseError.NOT_OBJECT, 'Tool call must be a JSON object.');
  }

  if (!TOOL_NAMES.includes(obj.tool)) {
    return err(
      ParseError.UNKNOWN_TOOL,
      `Unknown tool ${JSON.stringify(obj.tool)}. The available tools are: ${TOOL_NAMES.map((t) => `"${t}"`).join(', ')}.`
    );
  }

  // Leniency, deliberately, and confined to `wiki`:
  // `{"tool":"wiki","args":"Alan Turing"}` and `{"tool":"wiki","query":"Alan
  // Turing"}` are both things a small model writes, and both say unambiguously
  // what it wants. Rejecting them buys a repair round and a second chance to
  // get the shape wrong, in exchange for nothing.
  //
  // `curl`'s validation is left exactly as it was. Loosening both at once would
  // put a second change into the measurement that decides whether adding a tool
  // costs anything on the existing curl tasks.
  if (obj.tool === WIKI_TOOL) {
    if (typeof obj.args === 'string') return validateWikiCall({ query: obj.args });
    if (obj.args === undefined || obj.args === null) return validateWikiCall(obj);
    if (typeof obj.args !== 'object' || Array.isArray(obj.args)) {
      return err(ParseError.MISSING_ARGS, 'Tool call is missing an "args" object.');
    }
    return validateWikiCall(obj.args);
  }

  const args = obj.args;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return err(ParseError.MISSING_ARGS, 'Tool call is missing an "args" object.');
  }

  // --- method ---
  const rawMethod = args.method === undefined || args.method === null ? 'GET' : args.method;
  if (typeof rawMethod !== 'string') {
    return err(ParseError.BAD_METHOD, 'args.method must be a string.');
  }
  const method = rawMethod.trim().toUpperCase();
  if (!ALLOWED_METHODS.includes(method)) {
    return err(
      ParseError.BAD_METHOD,
      `Method ${JSON.stringify(rawMethod)} is not allowed. Use one of: ${ALLOWED_METHODS.join(', ')}.`
    );
  }

  // --- url ---
  if (typeof args.url !== 'string' || args.url.trim() === '') {
    return err(ParseError.BAD_URL, 'args.url must be a non-empty string.');
  }
  const rawUrl = args.url.trim();
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return err(
      ParseError.BAD_URL,
      `args.url ${JSON.stringify(rawUrl)} is not an absolute URL. Include the scheme, e.g. "https://example.com/path".`
    );
  }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return err(
      ParseError.BAD_SCHEME,
      `Scheme "${parsed.protocol}" is blocked. Only http: and https: URLs can be requested.`
    );
  }

  // --- headers ---
  /** @type {Object<string,string>} */
  const headers = {};
  if (args.headers !== undefined && args.headers !== null) {
    if (typeof args.headers !== 'object' || Array.isArray(args.headers)) {
      return err(ParseError.BAD_HEADERS, 'args.headers must be an object mapping header names to string values.');
    }
    for (const [k, v] of Object.entries(args.headers)) {
      if (typeof v !== 'string') {
        if (typeof v === 'number' || typeof v === 'boolean') {
          headers[k.trim()] = String(v);
          continue;
        }
        return err(
          ParseError.BAD_HEADERS,
          `Header ${JSON.stringify(k)} must have a string value; got ${v === null ? 'null' : typeof v}.`
        );
      }
      if (k.trim() === '') {
        return err(ParseError.BAD_HEADERS, 'Header names must not be empty.');
      }
      headers[k.trim()] = v;
    }
  }

  // --- body ---
  let body = null;
  if (args.body !== undefined && args.body !== null) {
    if (typeof args.body === 'string') {
      body = args.body;
    } else if (typeof args.body === 'object') {
      // Models routinely inline the JSON body as an object instead of a
      // string. Accept it and serialise rather than burning a repair round.
      body = JSON.stringify(args.body);
    } else {
      return err(ParseError.BAD_BODY, 'args.body must be a string or null.');
    }
  }
  if (body !== null && BODYLESS_METHODS.includes(method)) {
    return err(
      ParseError.BODY_NOT_ALLOWED,
      `A ${method} request cannot carry a body. Drop args.body, or use POST/PUT/PATCH.`
    );
  }

  return { ok: true, call: { tool: TOOL_NAME, args: { method, url: parsed.href, headers, body } } };
}

/**
 * Parse one assistant message.
 *
 * Three outcomes:
 * - `tool_call`: a valid call was found.
 * - `text`: no tool call was attempted; this is the model's answer.
 * - `error`: something that clearly meant to be a tool call is malformed.
 *   The caller should run one repair round (see `repairPrompt`).
 *
 * The `text` vs `error` distinction matters: a model answering a question
 * *about* JSON must not be mistaken for a broken tool call, so a candidate is
 * only treated as an attempted call when it mentions a `"tool"` key.
 *
 * @param {string} raw Raw assistant output.
 * @returns {{kind: 'tool_call', call: object, prose: string, raw: string}
 *          |{kind: 'text', text: string, raw: string}
 *          |{kind: 'error', error: {code: string, message: string}, candidate: string, raw: string}}
 */
export function parseToolCall(raw) {
  const text = stripThinking(raw);
  const candidate = extractJsonCandidate(text);

  if (!candidate) return { kind: 'text', text, raw };

  let obj;
  let parsedOk = true;
  try {
    obj = JSON.parse(candidate.json);
  } catch {
    parsedOk = false;
  }

  if (!parsedOk) {
    // Only claim a broken tool call if the fragment actually looks like one.
    if (!/"tool"\s*:/.test(candidate.json)) return { kind: 'text', text, raw };
    return {
      kind: 'error',
      error: {
        code: ParseError.JSON_PARSE,
        message: 'The tool call was not valid JSON (check quoting, commas and braces).',
      },
      candidate: candidate.json,
      raw,
    };
  }

  const looksLikeCall = obj !== null && typeof obj === 'object' && !Array.isArray(obj) && 'tool' in obj;
  if (!looksLikeCall) return { kind: 'text', text, raw };

  const validated = validateToolCall(obj);
  if (!validated.ok) {
    return { kind: 'error', error: validated.error, candidate: candidate.json, raw };
  }
  return { kind: 'tool_call', call: validated.call, prose: candidate.prose, raw };
}

/**
 * Build the corrective message sent to the model after a parse failure.
 * One repair round only; see `agent/loop.js`.
 *
 * @param {{code: string, message: string}} error
 * @returns {string}
 */
export function repairPrompt(error) {
  return [
    `Your tool call could not be used. Error ${error.code}: ${error.message}`,
    '',
    'Reply with ONLY a single fenced JSON block in exactly this shape, and nothing else:',
    '```json',
    '{"tool": "curl", "args": {"method": "GET", "url": "https://example.com", "headers": {}, "body": null}}',
    '```',
    'If you no longer need the tool, reply with a plain-text answer instead.',
  ].join('\n');
}
