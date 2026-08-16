/**
 * What the streaming bubble is allowed to show.
 *
 * The committed message is cleaned — `stripThinking` removes reasoning blocks,
 * and a tool call replaces the bubble with a card — but the *streamed* text was
 * rendered raw. On a phone that looked like the agent thinking out loud in
 * `<think>` tags and then printing a JSON blob, which is exactly what a real
 * user's screenshot showed. This module computes, from the raw buffer so far,
 * the text the user should actually see mid-stream.
 *
 * It is deliberately stateless: the chat pane re-renders the whole buffer on
 * every delta, so the filter can re-derive the visible text from scratch each
 * time. That makes it self-correcting — text held back because it *might* be
 * the start of a tag or a tool call reappears the moment the next characters
 * prove it is prose.
 *
 * @module agent/stream-filter
 */

import { matchBalanced, stripThinking } from './toolcall.js';

/** Tags whose partial prefix at the end of the buffer must be held back. */
const THINK_TAGS = ['<think>', '<thinking>', '</think>', '</thinking>'];

/**
 * The first JSON key of a tool call. A brace is suppressed only while what
 * follows it is consistent with this key, so `{{credential}}` placeholders and
 * braces in prose stay visible.
 */
const TOOL_KEY = '"tool"';

/**
 * Compute the display text for a partially streamed model reply.
 *
 * Held back, permanently: complete or unterminated `<think>` blocks, and any
 * JSON object (bare or fenced) whose first key is — or is so far a prefix of —
 * `"tool"`. Held back, temporarily: a trailing partial `<think>`-family tag and
 * a trailing partial code-fence opener, both of which are shown as soon as
 * further characters rule them out.
 *
 * @param {string} raw The accumulated raw stream buffer.
 * @returns {string} What the bubble should display right now.
 */
export function visibleStreamText(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  let text = withoutPartialThinkTag(raw);
  text = withoutPartialFenceOpener(text);
  text = stripThinking(text);
  text = withoutToolFences(text);
  text = withoutBareToolJson(text);
  return text.trim();
}

/**
 * Drop a trailing fragment that is a strict prefix of a think tag, e.g. `<thi`.
 * A complete tag is left for `stripThinking` to handle.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutPartialThinkTag(text) {
  const lt = text.lastIndexOf('<');
  if (lt === -1) return text;
  const tail = text.slice(lt).toLowerCase();
  if (THINK_TAGS.some((tag) => tag.startsWith(tail) && tail.length < tag.length)) {
    return text.slice(0, lt);
  }
  return text;
}

/**
 * Drop a trailing code-fence opener that has no content yet (backticks, an
 * optional language word, an optional newline). If it turns out to hold a tool
 * call the fence is removed for good by {@link withoutToolFences}; if it turns
 * out to be prose code, it reappears with its first line of content.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutPartialFenceOpener(text) {
  const m = text.match(/`{1,3}[A-Za-z0-9_-]*[ \t]*\r?\n?[ \t]*$/);
  if (!m) return text;
  const before = text.slice(0, m.index);
  // A trailing ``` after an odd number of fence markers is a *closer*, not an
  // opener — stripping it would amputate the end of every complete code block.
  const fences = (before.match(/```/g) || []).length;
  return fences % 2 === 1 ? text : before;
}

/**
 * Remove fenced blocks that hold (the beginning of) a tool call.
 *
 * Same fence grammar as `extractJsonCandidate`, including the unterminated
 * final fence a cut-short stream produces. A fence with a non-JSON language or
 * visibly non-tool content is left alone — a model illustrating code in prose
 * must stay visible.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutToolFences(text) {
  const fence = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)/g;
  return text.replace(fence, (whole, lang, inner) => {
    const l = lang.toLowerCase();
    if (l && l !== 'json' && l !== 'tool' && l !== 'tool_call') return whole;
    const body = inner.trim();
    // Nothing inside yet: could still become a tool call, hold the fence back.
    if (body === '') return '';
    if (body.startsWith('{') && isToolShapedAt(body, 0)) return '';
    return whole;
  });
}

/**
 * Remove every bare JSON object whose first key is (a prefix of) `"tool"`,
 * balanced or still open at the end of the buffer.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutBareToolJson(text) {
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor);
    if (open === -1) break;
    if (!isToolShapedAt(text, open)) {
      cursor = open + 1;
      continue;
    }
    const end = matchBalanced(text, open);
    const cut = end === -1 ? text.length : end;
    text = text.slice(0, open) + text.slice(cut);
    cursor = open;
  }
  return text;
}

/**
 * Is the object starting at `open` a tool call, as far as the buffer goes?
 *
 * True while everything after the brace is consistent with `"tool"` being the
 * first key — including a bare `{` with nothing after it yet. False the moment
 * a character diverges, which is what lets `{{placeholder}}` and prose braces
 * through.
 *
 * @param {string} text
 * @param {number} open Index of a `{`.
 * @returns {boolean}
 */
function isToolShapedAt(text, open) {
  const rest = text.slice(open + 1).replace(/^[\s]*/, '');
  const probe = rest.slice(0, TOOL_KEY.length);
  return TOOL_KEY.startsWith(probe);
}
