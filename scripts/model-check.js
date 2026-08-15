#!/usr/bin/env node
/**
 * Tool-call reliability check for the model tiers (SPEC §11.1).
 *
 * Validates the claim the tier table rests on: that the 4B, 1.7B and 0.6B
 * builds actually emit a well-formed tool call for a set of representative
 * prompts, and how often each fails or needs a repair round.
 *
 * **This needs a real GPU.** WebLLM is WebGPU-only, so the check drives the
 * built artifact in a real browser via Playwright and downloads several GB of
 * weights. It cannot run on a headless CI box without a GPU adapter — which is
 * exactly why it is a script you run deliberately rather than part of
 * `npm test`.
 *
 *     npm run build
 *     node scripts/model-check.js                     # all three tiers
 *     node scripts/model-check.js Qwen3-0.6B-q4f16_1-MLC
 *
 * Output is a table of: model, prompts attempted, valid first-try calls,
 * calls recovered by the repair round, hard failures, and median latency.
 * Paste it into BUILD_LOG.md when the tier table changes.
 */

import { chromium } from '@playwright/test';
import { startStaticServer, startTargetServer } from '../tests/e2e/test-server.js';
import { MODEL_TIERS } from '../src/llm/webllm.js';

/**
 * Prompts chosen to span the shapes the tool contract has to survive: a plain
 * GET, a GET the model must construct a query string for, a POST with a JSON
 * body, and a question that must NOT produce a tool call at all.
 */
const PROMPTS = [
  { ask: 'Fetch {BASE}/json and tell me the temperature.', expectTool: true },
  { ask: 'Get {BASE}/status/404 and tell me what status came back.', expectTool: true },
  { ask: 'POST the JSON {"hello":"world"} to {BASE}/echo and summarise the reply.', expectTool: true },
  { ask: 'Fetch {BASE}/headers and tell me which host header was received.', expectTool: true },
  { ask: 'What is the capital of France? Do not use any tool.', expectTool: false },
];

const RUNS_PER_PROMPT = 3;

const wanted = process.argv.slice(2);
const models = wanted.length > 0
  ? MODEL_TIERS.filter((m) => wanted.includes(m.id) || wanted.includes(m.tier))
  : [...MODEL_TIERS];

if (models.length === 0) {
  console.error(`No matching model. Known ids:\n${MODEL_TIERS.map((m) => `  ${m.id}`).join('\n')}`);
  process.exit(1);
}

const app = await startStaticServer();
const target = await startTargetServer();
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});

/** @type {Array<object>} */
const rows = [];

try {
  for (const model of models) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(app.url);

    // Bail early and loudly rather than silently reporting zeros.
    const hasGpu = await page.evaluate(() => Boolean(navigator.gpu));
    if (!hasGpu) {
      console.error('\nERROR: this browser has no WebGPU adapter, so no model can be loaded.');
      console.error('Run this on a machine with a GPU. Nothing was measured.\n');
      process.exit(2);
    }

    console.log(`\nLoading ${model.id} (${model.approxDownload})…`);
    await page.evaluate(async (id) => {
      await window.__agent.engine.load(id, (p) => {
        window.__loadProgress = p;
      });
    }, model.id);

    const stats = { model: model.id, attempts: 0, firstTry: 0, repaired: 0, failed: 0, wrongly: 0, latencies: [] };

    for (const prompt of PROMPTS) {
      for (let run = 0; run < RUNS_PER_PROMPT; run += 1) {
        const ask = prompt.ask.replaceAll('{BASE}', target.url);
        const t0 = Date.now();
        const result = await page.evaluate(async (text) => {
          const app_ = window.__agent;
          app_.loop.reset();
          const seen = { repairs: 0 };
          const r = await app_.loop.run(text);
          seen.repairs = app_.loop.getState().repairs;
          return { stopReason: r.stopReason, iterations: r.iterations, repairs: seen.repairs };
        }, ask);
        stats.latencies.push(Date.now() - t0);
        stats.attempts += 1;

        const calledTool = result.iterations > 0;
        if (prompt.expectTool && calledTool && result.repairs === 0) stats.firstTry += 1;
        else if (prompt.expectTool && calledTool) stats.repaired += 1;
        else if (prompt.expectTool) stats.failed += 1;
        else if (calledTool) stats.wrongly += 1;
        else stats.firstTry += 1;
      }
    }

    stats.medianMs = median(stats.latencies);
    rows.push(stats);
    await context.close();
  }

  console.log('\n=== Tool-call reliability ===\n');
  console.log('model                          attempts  first-try  repaired  failed  spurious  median');
  for (const r of rows) {
    console.log(
      `${r.model.padEnd(30)} ${String(r.attempts).padStart(8)}  ${String(r.firstTry).padStart(9)}  ` +
      `${String(r.repaired).padStart(8)}  ${String(r.failed).padStart(6)}  ${String(r.wrongly).padStart(8)}  ` +
      `${r.medianMs} ms`
    );
  }
  console.log('\n"spurious" = called the tool on the prompt that told it not to.\n');
} finally {
  await browser.close();
  await app.close();
  await target.close();
}

/** @param {number[]} xs */
function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
