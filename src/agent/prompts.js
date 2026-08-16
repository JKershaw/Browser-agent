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
    'You have exactly one tool: `curl`. It performs a single HTTP request using the browser\'s fetch API.',
    '',
    'To call it, reply with ONLY a fenced JSON block and no other text:',
    '```json',
    '{"tool": "curl", "args": {"method": "GET", "url": "https://example.com/path", "headers": {}, "body": null}}',
    '```',
    '',
    'Rules for the call:',
    `- "method" must be one of: ${ALLOWED_METHODS.join(', ')}.`,
    '- "url" must be absolute and start with http:// or https://.',
    '- "headers" is an object of string values; use {} when you need none.',
    '- "body" is a string or null. GET and HEAD must use null.',
    '- Emit exactly one tool call per reply. Never invent the result of a call.',
    '',
    'After each call you receive a message beginning with "TOOL RESULT" containing the HTTP status, selected headers and the response body (possibly truncated). Read it, then either call the tool again or answer the user in plain text.',
    '',
    `You may make at most ${maxIterations} tool calls for one user message. When you have what you need, stop calling the tool and reply in plain prose. Never show the user raw JSON tool calls as your final answer.`,
    '',
    'If a call fails, the result explains why. Report the failure honestly to the user rather than pretending the request worked or inventing data.',
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
