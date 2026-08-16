/**
 * Prompt text. This is load-bearing code, not configuration: small models
 * follow the tool-call contract only when the instructions are this explicit.
 * Any edit here should be re-checked against the e2e suite.
 *
 * Mirrored verbatim in `docs/prompts.md`.
 *
 * @module agent/prompts
 */

import { ALLOWED_METHODS } from './toolcall.js';

/**
 * Build the system prompt.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.credentialNames] Names the model may reference as `{{name}}`.
 * @param {string[]} [opts.allowlist] Domain allowlist, if one is configured.
 * @param {number} [opts.maxIterations]
 * @param {boolean} [opts.thinking] Whether hybrid thinking mode is enabled.
 * @returns {string}
 */
export function buildSystemPrompt(opts = {}) {
  const { credentialNames = [], allowlist = [], maxIterations = 5, thinking = false } = opts;

  const lines = [
    'You are a helpful assistant running entirely inside the user\'s web browser.',
    '',
    'You have two tools. To call one, reply with ONLY a fenced JSON block and no other text.',
    '',
    // Deliberately first. It is the simpler call, it is the one most user
    // questions want, and a model that reads no further than the first example
    // should have found the one with a single argument.
    '`wiki` looks something up on Wikipedia. It takes a search term, not a URL:',
    '```json',
    '{"tool": "wiki", "args": {"query": "Alan Turing"}}',
    '```',
    '',
    '`curl` performs a single HTTP request using the browser\'s fetch API:',
    '```json',
    '{"tool": "curl", "args": {"method": "GET", "url": "https://example.com/path", "headers": {}, "body": null}}',
    '```',
    '',
    // Conditional on needing a lookup at all, and that word is load-bearing.
    // The first version read "Use `wiki` whenever the answer would be on
    // Wikipedia", which is unconditionally true of almost any question: asked
    // for the chemical symbol for gold and told to use no tool, the model
    // searched Wikipedia in 20 samples out of 20, having been given an
    // instruction that said to. Restraint went from 100% to 0% on one line.
    'When you need to look something up, use `wiki` for anything Wikipedia covers — a person, a place, an event, an idea. If the user gives you a URL, use `curl` with that URL exactly as written.',
    '',
    // The example strings are the most-copied text in this prompt. Measured on
    // Qwen3-0.6B: asked to "fetch http://127.0.0.1:PORT/status/503", it sent
    // https://example.com/status/503 — or plain https://example.com/path — in
    // 17 samples out of 20. The same substitution produced the first failure
    // this project's real-model suite ever showed, and a later hint containing
    // "Article_Title" was requested literally. An example is something a small
    // model copies, so every placeholder here needs the rule stated — including
    // the new one, which is a person's name and looks nothing like a template.
    // Two short sentences, not one long one. Merging both warnings into a
    // single sentence measured worse: `local-get-json-after-3-turns` went to
    // 65%, sending https://example.com/path in five samples out of twenty —
    // the exact bug the original wording was written to stop. The first
    // sentence below is restored verbatim because it is the version that
    // measured 95%+; the wiki placeholder gets its own line rather than
    // sharing one.
    'The URL in that example is a placeholder. Never send it. Use the URL the user gave you, character for character, including its host and port.',
    '"Alan Turing" is a placeholder too. Search for what the user actually asked about.',
    '',
    'Rules for a `curl` call:',
    `- "method" must be one of: ${ALLOWED_METHODS.join(', ')}.`,
    '- "url" must be absolute and start with http:// or https://.',
    '- "headers" is an object of string values; use {} when you need none.',
    '- "body" is a string or null. GET and HEAD must use null.',
    '- Emit exactly one tool call per reply. Never invent the result of a call.',
    '',
    'After each call you receive a message beginning with "TOOL RESULT". For `curl` it contains the HTTP status, selected headers and the response body (possibly truncated); for `wiki` it contains the article text. Read it, then either call a tool again or answer the user in plain text.',
    '',
    `You may make at most ${maxIterations} tool calls for one user message. When you have what you need, stop calling the tool and reply in plain prose. Never show the user raw JSON tool calls as your final answer.`,
    '',
    // "Report the failure honestly" used to stand alone here, and a 0.6B model
    // obeyed it to the letter: handed a failure whose message named a URL that
    // would have worked, it reported the failure and stopped. An instruction to
    // give up beats a hint unless the order between them is stated.
    'If a call fails, the result explains why, and sometimes names a URL that would work instead. When it does, call the tool again with that URL — that is what it is for.',
    'Report a failure to the user only once you have no working alternative left, and then report it honestly rather than pretending the request worked or inventing data.',
    '',
    // The defining constraint of running in a page, and until now the model was
    // never told about it. Measured on Qwen3-0.6B: asked to look something up
    // on Wikipedia, it reached for the article URL every time, which browsers
    // refuse to fetch cross-origin — 0 out of 20.
    'You are in a web page, so requests are subject to CORS. Ordinary web pages meant for humans (HTML) almost always refuse cross-origin requests and are too large to read; JSON APIs almost always permit them and are small. Prefer a site’s JSON API over its HTML pages.',
    'If a request fails with a network error, the same URL will fail again. Do not retry it — reach for that site’s API instead.',
  ];

  if (credentialNames.length > 0) {
    lines.push(
      '',
      'Stored credentials are available. Reference one by name inside a header value using double braces; the browser substitutes the real secret before sending, and you never see it:',
      '```json',
      `{"tool": "curl", "args": {"method": "GET", "url": "https://api.example.com/me", "headers": {"Authorization": "Bearer {{${credentialNames[0]}}}"}, "body": null}}`,
      '```',
      `Available credential names: ${credentialNames.map((n) => `{{${n}}}`).join(', ')}.`
    );
  }

  if (allowlist.length > 0) {
    lines.push(
      '',
      `Requests are restricted to these domains: ${allowlist.join(', ')}. Requests anywhere else are refused before they are sent.`
    );
  }

  lines.push(
    '',
    'The user must approve each request before it is sent, and may deny it. A denial is a real answer from the user, not an error to retry blindly.'
  );

  // Last, deliberately. Everything above this point is about making calls, and
  // a 0.6B model that had read all of it answered "none of the provided tools
  // can be used to answer the question" when asked for the capital of France —
  // 100% before the tool guidance grew, 50% after. Stated near the top it
  // changed nothing (50% -> 55%, intervals overlapping). The NEXT STEP line had
  // already shown that for this model the end of a message is worth more than
  // the middle of one.
  lines.push(
    '',
    // Plural since there are two tools: "the tool" read as naming curl alone,
    // leaving the easier tool exempt from the only line that grants restraint.
    'Both tools are optional. If you already know the answer, or the user asks you not to use a tool, answer in plain prose without calling either one — that is a complete and correct response, not a failure.'
  );

  if (!thinking) {
    lines.push('', 'Answer directly. Do not emit reasoning or <think> blocks.');
  }

  return lines.join('\n');
}

/**
 * Wrap a tool result as the user-role message handed back to the model.
 * The `TOOL RESULT` marker is referenced by the system prompt above.
 *
 * @param {string} body Formatted result text.
 * @returns {string}
 */
export function toolResultMessage(body) {
  return `TOOL RESULT\n${body}`;
}

/**
 * Message sent when the user denies a request at the confirmation card.
 *
 * @param {{method: string, url: string}} call
 * @param {string} [reason]
 * @returns {string}
 */
export function denialMessage(call, reason) {
  return [
    'TOOL RESULT',
    'DENIED BY USER',
    `The user refused to send ${call.method} ${call.url}.`,
    reason ? `Reason given: ${reason}` : 'No reason was given.',
    'Do not retry the same request. Either ask the user what they would prefer, or answer without this data.',
  ].join('\n');
}

/**
 * Notice shown when the agent stops because the turn ran out of room.
 *
 * Refusals are reported separately from sent requests: telling a user who
 * denied everything that the agent "made 3 tool calls" is simply untrue.
 *
 * @param {number} sent Requests actually sent.
 * @param {number} [denied] Requests the user refused.
 * @returns {string}
 */
export function capMessage(sent, denied = 0) {
  const parts = [];
  if (sent > 0) parts.push(`${sent} tool call${sent === 1 ? '' : 's'}`);
  if (denied > 0) parts.push(`${denied} refused request${denied === 1 ? '' : 's'}`);
  const what = parts.length > 0 ? parts.join(' and ') : 'no completed tool calls';
  return `Stopped after ${what} — this message reached its limit. Ask again to continue.`;
}
