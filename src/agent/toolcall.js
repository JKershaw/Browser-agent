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

/** The only tool this agent exposes. */
export const TOOL_NAME = 'curl';

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
  // A stray closing tag with no opener means the opener was trimmed upstream.
  const strayClose = out.match(/<\/think(?:ing)?>/i);
  if (strayClose) out = out.slice(strayClose.index + strayClose[0].length);
  return out.trim();
}

/**
 * Scan forward from `start` (which must index a `{`) and return the index just
 * past the matching `}`, respecting JSON string literals and escapes.
 *
 * @param {string} s
 * @param {number} start
 * @returns {number} End index (exclusive), or -1 if unbalanced.
 */
function matchBalanced(s, start) {
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
  let m;
  while ((m = fence.exec(text)) !== null) {
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

  // Fallback: first balanced object in the raw text.
  const open = text.indexOf('{');
  if (open === -1) return null;
  const end = matchBalanced(text, open);
  if (end === -1) return { json: text.slice(open), prose: text.slice(0, open).trim() };
  return {
    json: text.slice(open, end),
    prose: (text.slice(0, open) + text.slice(end)).trim(),
  };
}

/** @param {string} code @param {string} message */
function err(code, message) {
  return { ok: false, error: { code, message } };
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

  if (obj.tool !== TOOL_NAME) {
    return err(
      ParseError.UNKNOWN_TOOL,
      `Unknown tool ${JSON.stringify(obj.tool)}. The only available tool is "${TOOL_NAME}".`
    );
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
