#!/usr/bin/env node
/**
 * Tool-call evaluation harness: how *often* does the agent do the job?
 *
 *     npm run build
 *     node scripts/tool-eval.js --suite local --n 10
 *     node scripts/tool-eval.js --suite wiki --n 20 --model Qwen3-1.7B-q4f16_1-MLC
 *     node scripts/tool-eval.js --suite all --holdout --json before.json
 *     node scripts/tool-eval.js --suite wiki --quick --show-failures
 *     node scripts/tool-eval.js --regrade before.json
 *
 * Flags beyond the obvious:
 *
 * - `--regrade <file>` re-scores a saved run against the *current* task
 *   definitions, with no browser, no GPU and no model. Four graders in this
 *   project have mismarked correct behaviour; this turns fixing one from minutes
 *   of GPU time into seconds, and it is the right first move whenever a rate
 *   looks wrong.
 * - `--show-failures` prints the requests and answers behind each failure. Every
 *   grader bug here was found by reading what the model actually wrote.
 * - `--quick` takes the first three tasks of the suite, for iterating. The full
 *   suite stays the gate.
 * - `--dist <dir>` serves a build from somewhere other than `dist/`, which is
 *   what makes an honest before/after possible: build an older ref into its own
 *   directory and measure both arms without checking files out over your work.
 *
 * Result files record the git SHA, whether the tree was dirty, and a hash of the
 * system prompt, because comparing two runs from memory is how a wrong
 * conclusion becomes a recorded fact.
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
import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { startStaticServer, startTargetServer } from '../tests/e2e/test-server.js';
import { STORAGE_KEY } from '../src/state/settings.js';
import { Grade, grade, summarise, wilson } from './eval/score.js';
import { suite as pickSuite } from './eval/tasks.js';
import { buildSystemPrompt } from '../src/agent/prompts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(HERE, '..', '.playwright-profile');
/** Shared with `tests/e2e/real-model.spec.js`, deliberately: same cache. */
const APP_PORT = 43117;

const args = parseArgs(process.argv.slice(2));
const MODELS = args.model.length ? args.model : ['Qwen3-0.6B-q4f16_1-MLC'];

// Re-scoring saved samples needs no browser, no GPU and no model. Four graders
// in this project have mismarked correct behaviour; each fix used to mean
// re-running the model for minutes to re-earn samples we already had.
if (args.regrade) {
  await regrade(args.regrade);
  process.exit(0);
}

const app = await startStaticServer(APP_PORT, args.dist || undefined);
const target = await startTargetServer();
const tasks = (() => {
  const s = pickSuite(args.suite, target.url);
  const chosen = args.holdout ? s.holdout : s.dev;
  if (args.task) return chosen.filter((t) => t.id === args.task);
  // A tight loop for iterating; the full suite stays the gate.
  return args.quick ? chosen.slice(0, 3) : chosen;
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
      console.log(`  ${task.id.padEnd(28)} ${pct(s)}  ${describe(s.counts)}`);
      if (args.showFailures) showFailures(task.id, graded);
    }

    await page.close();
  }

  report(results);

  if (args.json) {
    await writeFile(
      args.json,
      JSON.stringify(
        {
          suite: args.suite,
          holdout: args.holdout,
          n: args.n,
          temp: args.temp,
          // Which code produced this. Without it, two result files are two sets
          // of numbers with no way to tell what differed — and comparing runs
          // from memory is exactly how a wrong conclusion becomes a fact.
          ...provenance(),
          // Local tasks embed the target server's ephemeral port in their
          // expectations, so re-grading needs the base URL this run used.
          base: target.url,
          results,
        },
        null,
        2
      )
    );
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
      // What the model was actually handed, so "it ignored the hint" and "the
      // hint never arrived" can be told apart without guessing.
      transcript: transcript.map((m) => ({ role: m.role, content: String(m.content).slice(0, 1200) })),
    };
  }, [ask, preamble]);
}

/**
 * The code this run measured: git commit, whether the tree was dirty, and a
 * hash of the system prompt.
 *
 * The prompt hash is separate from the SHA on purpose. Prompt text is the thing
 * that moves these numbers most, and a hash makes "did the prompt change between
 * these two files?" a comparison rather than a recollection.
 *
 * @returns {{gitSha: string, dirty: boolean, promptHash: string, at: string}}
 */
function provenance() {
  const git = (cmd) => {
    try {
      return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return '';
    }
  };
  return {
    gitSha: git('git rev-parse --short HEAD') || 'unknown',
    dirty: git('git status --porcelain') !== '',
    promptHash: createHash('sha256').update(buildSystemPrompt()).digest('hex').slice(0, 12),
    at: new Date().toISOString(),
  };
}

/**
 * Print the answers behind the failures for one task.
 *
 * Every grader bug in this project was found by reading what the model actually
 * wrote, and each time that meant a throwaway script. A rate says a task failed;
 * only the text says whether the model or the pattern was wrong.
 *
 * @param {string} taskId
 * @param {Array<{grade: string, sample: object}>} graded
 * @param {number} [limit]
 */
function showFailures(taskId, graded, limit = 3) {
  const bad = graded.filter((g) => g.grade !== Grade.OK).slice(0, limit);
  for (const { grade: g, sample } of bad) {
    console.log(`    ── ${taskId} · ${g}`);
    for (const q of sample.requests || []) {
      console.log(`       ${q.method} ${decodeURIComponent(q.url).slice(0, 100)} -> ${q.status}${q.httpStatus ? ' ' + q.httpStatus : ''}`);
    }
    console.log(`       answer: ${JSON.stringify(String(sample.answer || '').slice(0, 200))}`);
  }
}

/**
 * Re-score a saved result file against the current task definitions.
 *
 * @param {string} file
 */
async function regrade(file) {
  const saved = JSON.parse(await readFile(file, 'utf8'));
  if (!saved.base) {
    console.error(
      `\n${file} predates provenance recording and has no target base URL.\n` +
        'Local tasks embed an ephemeral port in their expectations, so they cannot be\n' +
        're-graded from it. Wiki tasks are unaffected; re-run to get a stampable file.\n'
    );
  }
  const s = pickSuite(saved.suite, saved.base || 'http://127.0.0.1:0');
  const byId = new Map([...s.dev, ...s.holdout].map((t) => [t.id, t]));

  console.log(
    `\nre-grading ${file}\n` +
      `  recorded as: suite "${saved.suite}"${saved.holdout ? ' HOLDOUT' : ''}, n=${saved.n}, temp ${saved.temp}` +
      `${saved.gitSha ? `, ${saved.gitSha}${saved.dirty ? '-dirty' : ''}, prompt ${saved.promptHash}` : ''}\n`
  );

  const rows = [];
  for (const r of saved.results) {
    const task = byId.get(r.task);
    if (!task) {
      console.log(`  ${r.task.padEnd(28)} SKIPPED — no task with this id any more`);
      continue;
    }
    const graded = r.samples.map((x) => ({ grade: grade(task, x.sample), sample: x.sample }));
    const now = summarise(graded);
    const was = { passes: r.passes, n: r.n };
    const moved = now.passes !== was.passes ? `  (was ${was.passes}/${was.n})` : '';
    console.log(`  ${r.task.padEnd(28)} ${pct(now)}  ${describe(now.counts)}${moved}`);
    if (args.showFailures) showFailures(r.task, graded);
    rows.push({ modelId: r.modelId, task: r.task, ...now, samples: graded });
  }
  report(rows);
}

/** @param {object[]} rows */
function report(rows) {
  if (rows.length === 0) return;
  console.log('\n=== Tool-call success rate ===\n');
  console.log('model                       task                  n   pass   rate  95% CI');
  for (const r of rows) {
    console.log(
      `${r.modelId.padEnd(27)} ${r.task.padEnd(28)} ${String(r.n).padStart(2)}  ${String(r.passes).padStart(4)}  ` +
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
  const out = {
    suite: 'local', n: 10, temp: 0.6, model: [], json: '', holdout: false, task: '',
    regrade: '', showFailures: false, quick: false, dist: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--holdout') out.holdout = true;
    else if (a === '--suite') out.suite = argv[++i];
    else if (a === '--n') out.n = Number(argv[++i]);
    else if (a === '--temp') out.temp = Number(argv[++i]);
    else if (a === '--model') out.model.push(argv[++i]);
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--task') out.task = argv[++i];
    else if (a === '--regrade') out.regrade = argv[++i];
    else if (a === '--show-failures') out.showFailures = true;
    else if (a === '--quick') out.quick = true;
    else if (a === '--dist') out.dist = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}
