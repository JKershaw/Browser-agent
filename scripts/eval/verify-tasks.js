#!/usr/bin/env node
/**
 * Check that every task is answerable from the data it points at.
 *
 *     node scripts/eval/verify-tasks.js
 *
 * Needs network; needs no GPU. Run it before trusting a measurement, and after
 * editing any task.
 *
 * This exists because of a real false result. `wiki-telephone` asked who
 * invented the telephone and pointed at the "Telephone" article, whose summary
 * never mentions Bell. The model fetched the right URL twenty times out of
 * twenty, answered from what it had actually read, and was scored 0% — a
 * finding about the harness reported as a finding about the model. Nothing in
 * the run said so, because a wrong answer and an unanswerable question look
 * identical from the outside.
 *
 * A task with an `oracleUrl` states where its answer is supposed to live. This
 * fetches that and checks the answer expectation matches the payload.
 *
 * @module scripts/eval/verify-tasks
 */

import { startTargetServer } from '../../tests/e2e/test-server.js';
import { suite } from './tasks.js';

const target = await startTargetServer();
const { dev, holdout } = suite('all', target.url);
const all = [...dev, ...holdout];

let checked = 0;
let failed = 0;
let skipped = 0;

try {
  for (const task of all) {
    if (!task.oracleUrl) {
      // Hermetic tasks are answerable by construction — the fixture is in the
      // repo — and no-tool tasks have no source to check.
      skipped += 1;
      continue;
    }
    checked += 1;
    let body = '';
    try {
      const res = await fetch(task.oracleUrl);
      body = await res.text();
      if (!res.ok) {
        console.error(`✗ ${task.id}: oracle returned HTTP ${res.status}`);
        failed += 1;
        continue;
      }
    } catch (e) {
      console.error(`✗ ${task.id}: could not fetch oracle (${e?.message || e})`);
      failed += 1;
      continue;
    }

    const matches =
      task.answer instanceof RegExp
        ? task.answer.test(body)
        : body.toLowerCase().includes(String(task.answer).toLowerCase());

    if (matches) {
      console.log(`✓ ${task.id}: ${task.answer} is present at ${short(task.oracleUrl)}`);
    } else {
      console.error(
        `✗ ${task.id}: ${task.answer} does NOT appear at ${short(task.oracleUrl)} — ` +
          'the task is unanswerable and every sample will be scored answer_wrong.'
      );
      failed += 1;
    }
  }
} finally {
  await target.close();
}

console.log(`\n${checked} checked, ${failed} unanswerable, ${skipped} with no oracle to check.`);
process.exit(failed > 0 ? 1 : 0);

/** @param {string} url */
function short(url) {
  return url.replace('https://en.wikipedia.org/api/rest_v1/page/summary/', 'wiki:');
}
