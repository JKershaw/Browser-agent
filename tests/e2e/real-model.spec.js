/**
 * End-to-end against the **real** Qwen3-0.6B model through WebLLM (SPEC §9.2).
 *
 *     npm run build && npm run test:e2e:real
 *
 * Excluded from the default run and from CI: it needs a working WebGPU device
 * and downloads ~0.4 GB on first use. The model cache is persisted in a
 * browser profile under `.playwright-profile/` so repeat runs are fast.
 *
 * Assertions on model *text* are loose — a 0.6B model's prose is not a stable
 * contract. Assertions on UI state, log entries and test-server receipts are
 * strict: those are ours, and the point of running the real model is to prove
 * the tool-call contract survives contact with an actual model rather than a
 * scripted one.
 *
 * @module tests/e2e/real-model.spec
 */

import { chromium, expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORAGE_KEY as SETTINGS_KEY } from '../../src/state/settings.js';
import { startStaticServer, startTargetServer } from './test-server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(HERE, '..', '..', '.playwright-profile');
const MODEL = 'Qwen3-0.6B-q4f16_1-MLC';

/**
 * A *fixed* port for the app, which the rest of the suite does not need and
 * this one cannot do without. Weight caches are partitioned by origin, so an
 * ephemeral port gives every run a new origin and a cold cache — the persistent
 * profile then re-downloads 0.4 GB each time and orphans the previous copy.
 */
const APP_PORT = 43117;

// Loading weights dominates: generous once, not per-assertion.
test.describe.configure({ mode: 'serial', timeout: 15 * 60_000 });

/** @type {import('@playwright/test').BrowserContext} */
let context;
let page;
let app;
let target;
/** Null until probed; false means this machine cannot run the suite at all. */
let hasGpu = null;
/** Set when setup could not complete for an environmental reason. */
let unavailable = null;

// `test.skip()` cannot be called from beforeAll, so setup records why it could
// not proceed and each test consults it. A machine that simply cannot run this
// suite reports a clean, explained skip rather than a raw "Failed to fetch"
// from somewhere inside WebLLM.
test.beforeEach(() => {
  test.skip(
    hasGpu === false,
    'No WebGPU adapter with shader-f16 here; run this on a machine with a real GPU.'
  );
  test.skip(Boolean(unavailable), unavailable || '');
});

test.beforeAll(async () => {
  // `describe.configure({timeout})` governs tests, not hooks, and this hook is
  // where the 0.4 GB download happens — without this it runs under the config's
  // 60 s and a cold cache never finishes.
  test.setTimeout(15 * 60_000);

  app = await startStaticServer(APP_PORT);
  target = await startTargetServer();

  // Headed by default: headless Chromium falls back to SwiftShader, whose
  // adapter has no `shader-f16` — every q4f16_1 model in the catalog needs it,
  // so a headless run can only ever fail deep inside WebLLM. Set
  // `REAL_MODEL_HEADLESS=1` on a box whose headless browser has a real adapter.
  context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    headless: Boolean(process.env.REAL_MODEL_HEADLESS),
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
  });
  // Pin the tiny tier *before* any page script runs. `app.probe()` honours a
  // persisted modelId, so this makes the app's own boot load the model we want
  // — the only path that marks the model loaded and enables the composer.
  // Setting it after navigation is too late twice over: boot has already
  // started downloading whatever tier this device would pick by default (2.5 GB
  // on a desktop GPU), and a bare `engine.load()` leaves the UI none the wiser.
  await context.addInitScript(
    ([key, modelId]) => {
      localStorage.setItem(
        key,
        JSON.stringify({ modelId, confirmBeforeSend: true, maxIterations: 3 })
      );
    },
    [SETTINGS_KEY, MODEL]
  );

  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[page error] ${m.text()}`);
  });

  await page.goto(app.url);

  // A present navigator.gpu is not enough — a headless or virtualised GPU
  // exposes the API and then refuses to grant an adapter. Nor is an adapter
  // enough: a software adapter grants one and then lacks `shader-f16`, which
  // the q4f16_1 weights need, so require the feature rather than the API.
  hasGpu = await page.evaluate(async () => {
    if (!navigator.gpu) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      return Boolean(adapter?.features.has('shader-f16'));
    } catch {
      return false;
    }
  });
  if (!hasGpu) return;

  // Boot is now downloading the weights. Wait for whichever comes first: a
  // composer that has come alive, or the card turning into a failure report.
  const outcome = await page
    .waitForFunction(
      () => {
        if (document.querySelector('.loading-card-failed')) return 'failed';
        const send = document.querySelector('#send');
        return send && !send.disabled ? 'ready' : false;
      },
      null,
      { timeout: 14 * 60_000 }
    )
    .then((handle) => handle.jsonValue());

  if (outcome === 'failed') {
    const report = (await page.locator('.loading-card-failed').innerText()).replace(/\s+/g, ' ');
    // A blocked or offline CDN is an environment problem, not a product bug,
    // and must not masquerade as either a pass or a mysterious failure. Any
    // other diagnosis is the app telling us something true, so let it fail.
    if (/connection|network|offline|could not be downloaded/i.test(report)) {
      unavailable =
        `Could not download ${MODEL} weights from the model CDN (${report.slice(0, 160)}). ` +
        'This suite needs outbound access to huggingface.co from the browser.';
      return;
    }
    throw new Error(`The model failed to load:\n${report}`);
  }

  await expect(page.locator('#send')).toBeEnabled();
});

test.afterAll(async () => {
  await context?.close();
  await app?.close();
  await target?.close();
});

/** Send a message through the real UI. */
async function ask(text) {
  await page.locator('#input').fill(text);
  await page.locator('#send').click();
}

test('cold start: the model loads and answers a plain question', async () => {
  await ask('Say hello in one short sentence.');
  await expect(page.locator('#stop')).toBeHidden({ timeout: 120_000 });

  const reply = await page.locator('.msg-assistant').last().innerText();
  expect(reply.trim().length).toBeGreaterThan(0);
  // Loose on content, strict on shape: the final answer is never a raw call.
  expect(reply).not.toContain('"tool"');
});

test('tool round-trip: the model builds a real request and reads the response', async () => {
  await ask(
    `Use the curl tool to GET ${target.url}/json and then tell me the value of "city" from the response.`
  );

  const card = page.locator('.confirm-card');
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card).toContainText('127.0.0.1');
  await card.getByRole('button', { name: 'Approve' }).click();

  await expect(page.locator('#stop')).toBeHidden({ timeout: 120_000 });

  // Strict: the request really happened, and the log recorded it.
  const hits = target.received().filter((r) => r.path === '/json');
  expect(hits.length).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.tool-card').first()).toHaveClass(/tool-good/);

  // Loose: the model saw the data. A 0.6B model may or may not phrase it well.
  await expect(page.locator('.msg-assistant').last()).toContainText(/Bristol/i);
});

test('denial: the model is told and does not send', async () => {
  const before = target.received().length;
  await ask(`Use the curl tool to GET ${target.url}/echo`);

  const card = page.locator('.confirm-card');
  await expect(card).toBeVisible({ timeout: 120_000 });
  await card.getByRole('button', { name: 'Deny' }).click();
  await expect(page.locator('#stop')).toBeHidden({ timeout: 120_000 });

  expect(target.received().length).toBe(before);
  await expect(page.locator('.tool-card').last()).toHaveClass(/tool-denied/);
});

test('error surfacing: a dead port produces the network explanation', async () => {
  await ask('Use the curl tool to GET http://127.0.0.1:1/nope');

  const card = page.locator('.confirm-card');
  await expect(card).toBeVisible({ timeout: 120_000 });
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('#stop')).toBeHidden({ timeout: 120_000 });

  const tool = page.locator('.tool-card').last();
  await expect(tool).toHaveClass(/tool-error/);
  await expect(tool).toContainText('CORS');
});

test('reports throughput once the model has generated', async () => {
  const stats = await page.evaluate(() => window.__agent.engine.stats());
  expect(stats.modelId).toBe(MODEL);
  expect(stats.totalTokens).toBeGreaterThan(0);
  expect(stats.decodeTokensPerSecond).toBeGreaterThan(0);
});
