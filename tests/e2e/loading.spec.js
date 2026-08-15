/**
 * The loading card and the failure report it becomes.
 *
 * These cover the part of the app a first-time visitor spends the most time
 * looking at, and the part they see when it goes wrong. Both are driven by the
 * scripted engine, which replays WebLLM's real progress wording — including the
 * detail that its percentage restarts three times — and can be told to fail
 * with a specific browser error.
 *
 * @module tests/e2e/loading.spec
 */

import { expect, test } from './fixtures.js';

/** Load the app with the mock engine, without waiting for it to finish loading. */
async function openLoading(page, appServer, params = {}) {
  const qs = new URLSearchParams({ mockEngine: '1', mockScript: JSON.stringify(['ok']), ...params });
  await page.goto(`${appServer.url}/?${qs}`);
  return page;
}

test('the loading card names the phase, the bytes and the time left', async ({ page, appServer }) => {
  await openLoading(page, appServer, { mockLoadMs: '9000' });

  const card = page.locator('.loading-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.loading-phase')).toHaveText('Downloading the model');
  await expect(card.locator('.loading-model')).toContainText('Qwen3');

  // Bytes, not just a percentage: "612 MB of 1.00 GB" is what tells someone
  // whether staying on this connection is worth it.
  await expect(card.locator('.loading-facts')).toContainText(/\d+ MB of /);
  await expect(card.locator('.loading-facts')).toContainText(/MB\/s/);

  // An estimate, once there is enough evidence for one.
  await expect(card.locator('.loading-timing')).toContainText(/left/, { timeout: 20_000 });
  await expect(card.locator('.loading-timing')).toContainText(/so far/);
});

test('the elapsed time ticks along between the engine’s reports', async ({ page, appServer }) => {
  // WebLLM speaks once per shard. A card that only moves when spoken to looks
  // frozen for most of a real download.
  await openLoading(page, appServer, { mockLoadMs: '20000' });

  const timing = page.locator('.loading-card .loading-timing');
  await expect(timing).toContainText(/so far/);
  const first = await timing.textContent();

  await page.waitForTimeout(1500);
  await expect(timing).not.toHaveText(first);
});

test('the bar only ever moves forward, across all three passes', async ({ page, appServer }) => {
  await openLoading(page, appServer, { mockLoadMs: '6000' });

  const values = [];
  const phases = new Set();
  const bar = page.locator('.loading-bar');

  // Sample until the card goes away, which is when the load has finished.
  for (let i = 0; i < 120; i += 1) {
    if ((await bar.count()) === 0) break;
    const now = await bar.getAttribute('aria-valuenow').catch(() => null);
    const phase = await page.locator('.loading-phase').textContent().catch(() => null);
    if (now !== null) values.push(Number(now));
    if (phase) phases.add(phase);
    await page.waitForTimeout(100);
  }

  expect(values.length).toBeGreaterThan(5);
  for (let i = 1; i < values.length; i += 1) {
    // The engine's own fraction drops back to zero twice during this. The bar
    // must not, or the app looks like it has restarted itself.
    expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
  }
  expect(values.at(-1)).toBeGreaterThan(values[0]);
  expect([...phases]).toContain('Downloading the model');
  expect(phases.size).toBeGreaterThan(1);
});

test('the card is announced to a screen reader without narrating every tick', async ({ page, appServer }) => {
  await openLoading(page, appServer, { mockLoadMs: '8000' });

  const bar = page.locator('.loading-bar');
  await expect(bar).toHaveAttribute('role', 'progressbar');
  await expect(bar).toHaveAttribute('aria-valuemin', '0');
  await expect(bar).toHaveAttribute('aria-valuemax', '100');
  await expect(bar).toHaveAttribute('aria-valuetext', /per cent/);

  // The live region carries the phase, not the number: a region that fires four
  // times a second is unusable.
  const live = page.locator('.loading-card [role="status"]');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(live).toHaveText(/Downloading the model/);
});

test('the card gives way to a working app when the load finishes', async ({ page, appServer }) => {
  await openLoading(page, appServer, { mockLoadMs: '1500' });

  await expect(page.locator('.loading-card')).toBeVisible();
  await expect(page.locator('.loading-card')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('#messages')).toContainText('is ready');
});

test('a storage failure is explained and evidenced, not just reported', async ({ page, appServer }) => {
  // The exact error from the bug report: Chrome's wording says nothing about
  // storage, which is why the app has to.
  await openLoading(page, appServer, { mockLoadMs: '1200', mockLoadFail: 'cache' });

  const card = page.locator('.loading-card-failed');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveAttribute('role', 'alert');
  await expect(card.locator('.loading-fail-title')).toHaveText(/could not store the model/i);
  // Asserted on the mechanism, not on the storage numbers: how much room the
  // CI runner has is not this test's business, and the paragraph leads with
  // whichever of the two is the more informative on the day.
  await expect(card.locator('.loading-fail-explain')).toContainText('disappeared underneath it');
  await expect(card.locator('.loading-fail-explain')).toContainText('what failed was storing it');
  await expect(card.locator('.loading-advice li')).not.toHaveCount(0);

  // It failed part-way, so the numbers describing where are real ones.
  await card.locator('.loading-details > summary').click();
  const debug = card.locator('.loading-debug');
  await expect(debug).toContainText("Failed to execute 'add' on 'Cache': Entry was not found.");
  await expect(debug).toContainText('Category:  cache-write');
  await expect(debug).toContainText(/Model:\s+Qwen3/);
  await expect(debug).toContainText(/Failed at: Downloading the model/);
  await expect(debug).toContainText(/Storage:/);
  await expect(debug).toContainText(/Browser:\s+Mozilla/);

  // And the app is honest about not being usable.
  await expect(page.locator('#send')).toBeDisabled();
});

test('the failure report can be copied in one tap', async ({ page, appServer, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openLoading(page, appServer, { mockLoadMs: '1200', mockLoadFail: 'cache' });

  const card = page.locator('.loading-card-failed');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.locator('.loading-details > summary').click();
  await card.getByRole('button', { name: 'Copy details' }).click();

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('Browser Agent — model load failure');
  expect(copied).toContain("Failed to execute 'add' on 'Cache'");
});

test('the failure offers actions, and retrying really restarts the load', async ({ page, appServer }) => {
  await openLoading(page, appServer, { mockLoadMs: '1200', mockLoadFail: 'cache' });

  const card = page.locator('.loading-card-failed');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByRole('button', { name: 'Choose a smaller model' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Clear stored model data' })).toBeVisible();

  await card.getByRole('button', { name: 'Try again' }).click();
  // Back to a live progress bar rather than a dead card.
  await expect(page.locator('.loading-bar')).toBeVisible();
  await expect(page.locator('.loading-card-failed')).toBeVisible({ timeout: 20_000 });
});

test('"choose a smaller model" opens the settings sheet', async ({ page, appServer }) => {
  await openLoading(page, appServer, { mockLoadMs: '1200', mockLoadFail: 'cache' });

  const card = page.locator('.loading-card-failed');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Choose a smaller model' }).click();
  await expect(page.locator('#settings-sheet')).toHaveAttribute('data-open', 'true');
});

test('clearing stored data says what it actually removed', async ({ page, appServer }) => {
  await openLoading(page, appServer, { mockLoadMs: '1200', mockLoadFail: 'cache' });

  const card = page.locator('.loading-card-failed');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Clear stored model data' }).click();

  // The scripted engine caches nothing, so the honest answer is "there was
  // nothing to remove" — not a fabricated amount of space reclaimed.
  await expect(page.locator('.notice').last()).toContainText('no stored model data to remove');
});

test('a network failure is not blamed on storage', async ({ page, appServer }) => {
  await openLoading(page, appServer, { mockLoadMs: '1200', mockLoadFail: 'network' });

  const card = page.locator('.loading-card-failed');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.locator('.loading-fail-title')).toHaveText(/did not finish/i);
  await expect(card.locator('.loading-fail-explain')).toContainText('connection');
  await expect(card.getByRole('button', { name: 'Clear stored model data' })).toHaveCount(0);
});

test('a GPU memory failure points at the model picker', async ({ page, appServer }) => {
  await openLoading(page, appServer, { mockLoadMs: '1200', mockLoadFail: 'gpu' });

  const card = page.locator('.loading-card-failed');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.locator('.loading-fail-title')).toHaveText(/GPU memory/i);
  await expect(card.getByRole('button', { name: 'Choose a smaller model' })).toBeVisible();
});
