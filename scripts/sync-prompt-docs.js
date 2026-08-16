#!/usr/bin/env node
/**
 * Rewrite the base system prompt inside `docs/prompts.md` from the code.
 *
 *     npm run docs:prompts
 *
 * The doc is a verbatim mirror, and a mirror maintained by hand drifts. It was
 * hand-edited three times in one session, and one of those left a stale hint
 * example in it (`Article_Title`) describing behaviour the code had already
 * stopped producing — a doc that confidently described a bug we had fixed.
 *
 * `tests/unit/prompts.test.js` asserts the mirror matches, so CI fails rather
 * than letting the two drift apart quietly.
 *
 * @module scripts/sync-prompt-docs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt } from '../src/agent/prompts.js';

const DOC = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'prompts.md');

/** Anchors bounding the mirrored block; both are lines of the prompt itself. */
export const START = 'You are a helpful assistant running entirely inside the user';
export const END = 'Answer directly. Do not emit reasoning or <think> blocks.';

/**
 * Replace the mirrored prompt inside a document.
 *
 * @param {string} doc Current `docs/prompts.md` contents.
 * @param {string} prompt Freshly built system prompt.
 * @returns {string}
 * @throws {Error} When the anchors are missing, rather than writing a file with
 *   the prompt silently absent.
 */
export function replaceMirror(doc, prompt) {
  const from = doc.indexOf(START);
  const to = from === -1 ? -1 : doc.indexOf(END, from);
  if (from === -1 || to === -1) {
    throw new Error(
      'Could not find the mirrored prompt in docs/prompts.md. Expected a block ' +
        `starting "${START}…" and ending "${END}".`
    );
  }
  return doc.slice(0, from) + prompt + doc.slice(to + END.length);
}

// Only run when invoked directly, so the pure part above stays testable.
if (process.argv[1] && process.argv[1].endsWith('sync-prompt-docs.js')) {
  const doc = await readFile(DOC, 'utf8');
  const next = replaceMirror(doc, buildSystemPrompt());
  if (next === doc) {
    console.log('docs/prompts.md already matches src/agent/prompts.js');
  } else {
    await writeFile(DOC, next);
    console.log('docs/prompts.md updated from src/agent/prompts.js');
  }
}
