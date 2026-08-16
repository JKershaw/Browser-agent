#!/usr/bin/env node
/**
 * Tool-call evaluation harness: how *often* does the agent do the job?
 *
 *     npm run build
 *     node scripts/tool-eval.js --suite local --n 10
 *     node scripts/tool-eval.js --suite wiki --n 20 --model Qwen3-1.7B-q4f16_1-MLC
 *     node scripts/tool-eval.js --suite all --holdout --json before.json
 *
 * Why this exists alongside `model-check.js`: that script scores a sample on
 * `iterations > 0`, so a well-formed request to the wrong host counts as a
 * first-try success. This one grades the request the model actually built and
 * the answer it actually gave, reports a rate with a confidence interval, and
 * takes enough samples for the interval to mean something. A 0.6B model at
 * temperature 0.6 is a distribution; one sample is a draw from it, not a
 * measurement of it.
 *
 * **Needs a real GPU.** Headless Chromium's software adapter has no
 * `shader-f16`, which every `q4f16_1` build requires, so this runs headed like
 * the real-model e2e suite and shares its browser profile and fixed port — the
 * weight cache is partitioned by origin, and a fixed origin is what makes a
 * second run take seconds instead of five minutes.
 *
 * @module scripts/tool-eval
 */

import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { startStaticServer, startTargetServer } from '../tests/e2e/test-server.js';
import { STORAGE_KEY } from '../src/state/settings.js';
import { Grade, grade, summarise, wilson } from './eval/score.js';
import { suite as pickSuite } from './eval/tasks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(HERE, '..', '.playwright-profile');
/** Shared with `tests/e2e/real-model.spec.js`, deliberately: same cache. */
const APP_PORT = 43117;

const args = parseArgs(process.argv.slice(2));
const MODELS = args.model.length ? args.model : ['Qwen3-0.6B-q4f16_1-MLC'];

const app = await startStaticServer(APP_PORT);
const target = await startTargetServer();
const tasks = (() => {
  const s = pickSuite(args.suite, target.url);
  const chosen = args.holdout ? s.holdout : s.dev;
  return args.task ? chosen.filter((t) => t.id === args.task) : chosen;
})();

console.log(
  `\n${args.holdout ? 'HOLDOUT' : 'dev'} · suite "${args.suite}" · ` +
    `${tasks.length} tasks × ${args.n} samples · temperature ${args.temp}\n`
);

const context = await chromium.launchPersistentContext(PROFILE, {
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  headless: Boolean(process.env.REAL_MODEL_HEADLESS),
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});

/** @type {object[]} */
const results = [];

try {
  for (const modelId of MODELS) {
    await context.addInitScript(
      ([key, id, temperature]) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            modelId: id,
            temperature,
            confirmBeforeSend: false, // the harness measures the model, not the user
            maxIterations: 4,
          })
        );
      },
      [STORAGE_KEY, modelId, args.temp]
    );

    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`  [page error] ${m.text().slice(0, 160)}`);
    });

    process.stdout.write(`Loading ${modelId}… `);
    const t0 = Date.now();
    await page.goto(app.url);

    const hasGpu = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
      return Boolean(adapter?.features.has('shader-f16'));
    });
    if (!hasGpu) {
      console.error(
        '\n\nERROR: no WebGPU adapter with shader-f16. Nothing was measured.\n' +
          'Run this on a machine with a real GPU; a software adapter cannot load these weights.\n'
      );
      process.exitCode = 2;
      break;
    }

    const ready = await page
      .waitForFunction(
        () => {
          if (document.querySelector('.loading-card-failed')) return 'failed';
          const send = document.querySelector('#send');
          return send && !send.disabled ? 'ready' : false;
        },
        null,
        { timeout: 15 * 60_000 }
      )
      .then((h) => h.jsonValue());

    if (ready === 'failed') {
      const why = (await page.locator('.loading-card-failed').innerText()).replace(/\s+/g, ' ');
      console.error(`\n\nERROR: ${modelId} failed to load: ${why.slice(0, 200)}\n`);
      process.exitCode = 2;
      break;
    }
    console.log(`ready in ${Math.round((Date.now() - t0) / 1000)}s`);

    for (const task of tasks) {
      const graded = [];
      for (let i = 0; i < args.n; i += 1) {
        const sample = await runOnce(page, task.ask, task.preamble);
        const g = grade(task, sample);
        graded.push({ grade: g, sample });
        process.stdout.write(g === Grade.OK ? '.' : '✗');
      }
      const s = summarise(graded);
      results.push({ modelId, task: task.id, ...s, samples: graded });
      console.log(`  ${task.id.padEnd(20)} ${pct(s)}  ${describe(s.counts)}`);
    }

    await page.close();
  }

  report(results);

  if (args.json) {
    await writeFile(args.json, JSON.stringify({ suite: args.suite, holdout: args.holdout, n: args.n, temp: args.temp, results }, null, 2));
    console.log(`Written to ${args.json}\n`);
  }
} finally {
  await context.close();
  await app.close();
  await target.close();
}

/**
 * Run one turn in the page and record what the agent did.
 *
 * Drives `app.loop` rather than the DOM: the UI is covered by the e2e suite,
 * and what is being measured here is the model's behaviour, which the composer
 * only slows down.
 *
 * A task may specify a `preamble`: turns played first, on the same transcript,
 * whose requests are not graded. Conversation history is a variable like any
 * other — a model that copies a URL faithfully from a clean transcript may not
 * do so after three turns of something else — and it cannot be studied without
 * being able to put it there deliberately.
 *
 * @param {import('playwright').Page} page
 * @param {string} ask
 * @param {string[]} [preamble]
 */
function runOnce(page, ask, preamble) {
  return page.evaluate(async ([text, before]) => {
    const agent = window.__agent;
    agent.log.clear();
    agent.loop.reset();
    for (const turn of before || []) await agent.loop.run(turn);
    // Only the graded turn's requests count; the preamble's are history.
    agent.log.clear();
    const started = performance.now();
    let stopReason = null;
    let error = null;
    let transcript = [];
    try {
      const r = await agent.loop.run(text);
      stopReason = r.stopReason;
      transcript = r.transcript || [];
    } catch (e) {
      error = String(e?.message || e);
    }
    const last = [...transcript].reverse().find((m) => m.role === 'assistant');
    return {
      stopReason,
      error,
      repairs: agent.loop.getState().repairs,
      ms: Math.round(performance.now() - started),
      requests: agent.log.all().map((e) => ({
        method: e.method,
        url: e.url,
        status: e.status,
        httpStatus: e.response?.status ?? null,
        errorKind: e.error?.kind || null,
      })),
      answer: last?.content || '',
    };
  }, [ask, preamble]);
}

/** @param {object[]} rows */
function report(rows) {
  if (rows.length === 0) return;
  console.log('\n=== Tool-call success rate ===\n');
  console.log('model                       task                  n   pass   rate  95% CI');
  for (const r of rows) {
    console.log(
      `${r.modelId.padEnd(27)} ${r.task.padEnd(20)} ${String(r.n).padStart(2)}  ${String(r.passes).padStart(4)}  ` +
        `${(r.rate * 100).toFixed(0).padStart(4)}%  ${(r.low * 100).toFixed(0)}–${(r.high * 100).toFixed(0)}%`
    );
  }

  for (const modelId of [...new Set(rows.map((r) => r.modelId))]) {
    const mine = rows.filter((r) => r.modelId === modelId);
    const passes = mine.reduce((a, r) => a + r.passes, 0);
    const n = mine.reduce((a, r) => a + r.n, 0);
    const w = wilson(passes, n);
    console.log(
      `\n${modelId}: ${passes}/${n} = ${(w.rate * 100).toFixed(0)}% ` +
        `(95% CI ${(w.low * 100).toFixed(0)}–${(w.high * 100).toFixed(0)}%)`
    );
    const all = {};
    for (const r of mine) for (const [k, v] of Object.entries(r.counts)) all[k] = (all[k] || 0) + v;
    console.log(`  ${describe(all)}`);
  }

  // The URLs it chose are the most useful thing on the page when a run goes
  // badly, and are invisible in the rates.
  const wrong = rows
    .flatMap((r) => r.samples.map((s) => ({ task: r.task, ...s })))
    .filter((s) => s.grade === Grade.WRONG_TARGET)
    .flatMap((s) => s.sample.requests.map((q) => `${s.task}: ${q.method} ${q.url}`));
  if (wrong.length) {
    console.log('\nWrong targets (up to 10):');
    for (const line of [...new Set(wrong)].slice(0, 10)) console.log(`  ${line}`);
  }
  console.log();
}

/** @param {{rate: number, low: number, high: number}} s */
function pct(s) {
  return `${(s.rate * 100).toFixed(0).padStart(3)}% (${(s.low * 100).toFixed(0)}–${(s.high * 100).toFixed(0)})`;
}

/** @param {Record<string, number>} counts */
function describe(counts) {
  return Object.entries(counts)
    .filter(([k]) => k !== Grade.OK)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(' ') || 'clean';
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { suite: 'local', n: 10, temp: 0.6, model: [], json: '', holdout: false, task: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--holdout') out.holdout = true;
    else if (a === '--suite') out.suite = argv[++i];
    else if (a === '--n') out.n = Number(argv[++i]);
    else if (a === '--temp') out.temp = Number(argv[++i]);
    else if (a === '--model') out.model.push(argv[++i]);
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--task') out.task = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}
