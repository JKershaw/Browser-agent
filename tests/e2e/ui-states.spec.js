/**
 * UI element and state coverage the scenario suites skim past: the stats bar's
 * live values, the log view's toolbar and ordering, settings clamping and
 * reset, keyboard behaviour, and the loop's confirmation policy as seen from
 * the real UI.
 *
 * Same rules as `agent.spec.js`: model text is asserted loosely, UI state and
 * server receipts strictly.
 *
 * @module tests/e2e/ui-states.spec
 */

import { expect, send, settled, test, toolCall } from './fixtures.js';

/* ------------------------------------------------------------------ *
 * stats bar
 * ------------------------------------------------------------------ */

test('the stats bar reports throughput, tokens and tool latency after a turn', async ({ open, target }) => {
  const page = await open([toolCall({ url: `${target.url}/json` }), 'Fetched it.']);

  // Before anything runs, the placeholders are honest dashes.
  await expect(page.locator('.statsbar')).toContainText('prefill');
  await expect(page.locator('.statsbar')).toContainText('—');

  await send(page, 'fetch it');

  // While the turn runs, the iteration counter is highlighted as live.
  await expect(page.locator('.confirm-card')).toBeVisible();
  await expect(page.locator('.stat-live')).toHaveCount(1);

  await page.locator('.confirm-card .btn-approve').click({ timeout: 5000 });
  await settled(page);

  // The mock engine reports fixed rates, so the numbers are exact.
  const bar = page.locator('.statsbar');
  await expect(bar).toContainText('123 tok/s');
  await expect(bar).toContainText('57 tok/s');
  await expect(bar).not.toContainText('tokens 0');
  await expect(bar.locator('.stat', { hasText: 'last tool' })).toContainText('ms');
  // And the live highlight is gone once the turn ends.
  await expect(page.locator('.stat-live')).toHaveCount(0);
});

/* ------------------------------------------------------------------ *
 * keyboard
 * ------------------------------------------------------------------ */

test('Escape denies an open confirmation card', async ({ open, target }) => {
  const page = await open([toolCall({ url: `${target.url}/json` }), 'Understood.']);

  await send(page, 'fetch it');
  await expect(page.locator('.confirm-card')).toBeVisible();
  await page.keyboard.press('Escape');
  await settled(page);

  // Denied, not cancelled: the model was told and the turn carried on.
  await expect(page.locator('.confirm-card')).toHaveCount(0);
  await expect(page.locator('.tool-card')).toHaveClass(/tool-denied/);
  await expect(page.locator('.msg-assistant').last()).toContainText('Understood');
  expect(target.received()).toHaveLength(0);
});

test('with a sheet open, Escape closes the sheet and leaves the card alone', async ({ open, target }) => {
  const page = await open([toolCall({ url: `${target.url}/json` }), 'done']);

  await send(page, 'fetch it');
  await expect(page.locator('.confirm-card')).toBeVisible();

  await page.locator('#toggle-log').click();
  await expect(page.locator('#log-sheet')).toHaveAttribute('data-open', 'true');

  // First Escape: the sheet. The pending decision must not be consumed by a
  // keystroke aimed at closing a panel.
  await page.keyboard.press('Escape');
  await expect(page.locator('#log-sheet')).toHaveAttribute('data-open', 'false');
  await expect(page.locator('.confirm-card')).toBeVisible();

  // Second Escape: now it means the card.
  await page.keyboard.press('Escape');
  await settled(page);
  await expect(page.locator('.tool-card')).toHaveClass(/tool-denied/);
  expect(target.received()).toHaveLength(0);
});

/* ------------------------------------------------------------------ *
 * confirmation card
 * ------------------------------------------------------------------ */

test('an IP host is shown whole, with no de-emphasised prefix', async ({ open, target }) => {
  // The tail-emphasis rule exists for DNS names, where the registrable domain
  // is the truth. An IP has no registrable domain; muting "127." of
  // 127.0.0.1 would just make the address harder to read.
  const page = await open([toolCall({ url: `${target.url}/json` }), 'done']);

  await send(page, 'fetch it');
  const head = page.locator('.confirm-card .confirm-head strong');
  await expect(head).toHaveText(`127.0.0.1:${target.port}`);
  await expect(head.locator('.host-prefix')).toHaveCount(0);

  await page.locator('.confirm-card .btn-deny').click();
  await settled(page);
});

/* ------------------------------------------------------------------ *
 * confirmation policy, as the UI enforces it
 * ------------------------------------------------------------------ */

test('with confirm-before-send off, a plain GET goes without asking', async ({ open, target }) => {
  const page = await open([toolCall({ url: `${target.url}/json` }), 'Fetched without asking.']);

  await page.locator('#toggle-settings').click();
  await page.getByText('Confirm before sending').click();
  await page.locator('#close-settings').click();

  await send(page, 'fetch it');
  await settled(page);

  // The request went out and no card was ever answered — the tool card went
  // straight from sending to its result.
  expect(target.received()).toHaveLength(1);
  await expect(page.locator('.confirm-card')).toHaveCount(0);
  await expect(page.locator('.tool-card').first()).toHaveClass(/tool-good/);
});

test('a credentialled request still asks, even with confirm-before-send off', async ({ open, target }) => {
  // SPEC: a leaked token cannot be un-leaked, so credentials always ask —
  // this is the one path where the setting must be overridden.
  const page = await open([
    toolCall({ url: `${target.url}/headers`, headers: { Authorization: 'Bearer {{Api}}' } }),
    'Sent with the credential.',
  ]);

  await page.locator('#toggle-settings').click();
  await page.getByText('Confirm before sending').click();
  await page.getByPlaceholder('Name (e.g. GitHub)').fill('Api');
  await page.getByPlaceholder('Secret value').fill('tok_always_ask_1234');
  await page.getByRole('button', { name: 'Add credential' }).click();
  await page.locator('#close-settings').click();

  await send(page, 'call the api');

  const card = page.locator('.confirm-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.confirm-cred')).toContainText('Api');

  await card.locator('.btn-approve').click({ timeout: 5000 });
  await settled(page);
  const hit = target.received().find((r) => r.path === '/headers');
  expect(hit.headers.authorization).toBe('Bearer tok_always_ask_1234');
});

test('a denial does not consume the tool-call budget', async ({ open, target }) => {
  // The cap counts requests sent. With a budget of one, a denied proposal
  // must still leave room for the next one to be offered and dispatched.
  const page = await open([
    toolCall({ url: `${target.url}/json` }),
    toolCall({ url: `${target.url}/echo` }),
    'Done after one real request.',
  ]);

  await page.locator('#toggle-settings').click();
  await page.getByLabel('Max tool calls per message').fill('1');
  await page.locator('#close-settings').click();

  await send(page, 'fetch things');
  await page.locator('.confirm-card').getByRole('button', { name: 'Deny' }).click();

  // A second card appears despite the budget of one.
  await expect(page.locator('.confirm-card')).toBeVisible();
  await page.locator('.confirm-card .btn-approve').click({ timeout: 5000 });
  await settled(page);

  expect(target.received().map((r) => r.path)).toEqual(['/echo']);
  await expect(page.locator('.tool-card')).toHaveCount(2);
  await expect(page.locator('.tool-card').first()).toHaveClass(/tool-denied/);
  await expect(page.locator('.tool-card').last()).toHaveClass(/tool-good/);
});

/* ------------------------------------------------------------------ *
 * streaming
 * ------------------------------------------------------------------ */

test('stopping mid-stream keeps the partial answer, marked interrupted', async ({ open }) => {
  const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
  const page = await open([words]);

  await send(page, 'talk at length');

  // Wait until some text has visibly streamed, then stop.
  const bubble = page.locator('.msg-assistant .msg-body');
  await expect(bubble).toContainText('word5', { timeout: 10_000 });
  await page.locator('#stop').click();
  await settled(page);

  // The partial answer is history now: present, finished, honestly labelled.
  const msg = page.locator('.msg-assistant');
  await expect(msg).toHaveClass(/msg-interrupted/);
  const text = await bubble.innerText();
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toContain('word299');
  await expect(page.locator('.caret')).toHaveCount(0);

  // And the app is ready for the next message.
  await expect(page.locator('#send')).toBeEnabled();
});

/* ------------------------------------------------------------------ *
 * request log
 * ------------------------------------------------------------------ */

test('the log clears, and its buttons disable when empty', async ({ open, target }) => {
  const page = await open([toolCall({ url: `${target.url}/json` }), 'done']);

  // Empty log: both actions are disabled, so they cannot pretend to work.
  await page.locator('#toggle-log').click();
  await expect(page.getByRole('button', { name: 'Export JSON' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Clear' })).toBeDisabled();
  await page.locator('#close-log').click();

  await send(page, 'fetch it');
  await page.locator('.confirm-card .btn-approve').click({ timeout: 5000 });
  await settled(page);

  await page.locator('#toggle-log').click();
  await expect(page.locator('#log-body')).toContainText('1 request');
  await expect(page.locator('.log-entry')).toHaveCount(1);

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('#log-body')).toContainText('No requests yet');
  await expect(page.locator('.log-entry')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export JSON' })).toBeDisabled();
});

test('log entries are newest first, and expand to the full exchange', async ({ open, target }) => {
  const page = await open([
    toolCall({ url: `${target.url}/json` }),
    toolCall({ url: `${target.url}/echo` }),
    'Both done.',
  ]);

  await send(page, 'fetch two things');
  const card = page.locator('.confirm-card');
  await card.getByText(/Auto-approve/).click();
  await card.getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  await page.locator('#toggle-log').click();
  await expect(page.locator('#log-body')).toContainText('2 requests');

  // Newest first: the /echo call came second, so it is the first entry.
  const first = page.locator('.log-entry').first();
  await expect(first).toContainText('/echo');
  await expect(page.locator('.log-entry').last()).toContainText('/json');

  // The disclosure holds the whole exchange, not just the summary line.
  await first.locator('summary').click();
  await expect(first).toContainText('Request');
  await expect(first).toContainText('Response — HTTP 200');
  await expect(first).toContainText(`${target.url}/echo`);
});

/* ------------------------------------------------------------------ *
 * settings
 * ------------------------------------------------------------------ */

test('an out-of-range number is clamped, and the field shows the clamped value', async ({ open, page }) => {
  await open(['hi']);
  await page.locator('#toggle-settings').click();

  const field = page.getByLabel('Max tool calls per message');
  await field.fill('50');
  await field.blur();

  // The store clamps to the documented hard cap, and the sheet re-renders
  // from the store — so the field tells the truth about what will happen.
  await expect(field).toHaveValue('10');
  expect(await page.evaluate(() => globalThis.__agent.settings.get().maxIterations)).toBe(10);
});

test('Reset everything restores defaults and deletes credentials, after asking', async ({ open, page }) => {
  await open(['hi']);
  await page.locator('#toggle-settings').click();

  await page.getByLabel('Temperature').fill('1.5');
  await page.getByLabel('Temperature').blur();
  await page.getByPlaceholder('Name (e.g. GitHub)').fill('Doomed');
  await page.getByPlaceholder('Secret value').fill('to-be-reset');
  await page.getByRole('button', { name: 'Add credential' }).click();
  await expect(page.locator('.cred')).toHaveCount(1);

  // The reset asks first — destructive, and there is no undo.
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Reset everything' }).click();

  await expect(page.getByLabel('Temperature')).toHaveValue('0.6');
  await expect(page.locator('.cred')).toHaveCount(0);
  await expect(page.locator('#settings-body')).toContainText('No credentials stored');
});

test('a declined reset changes nothing', async ({ open, page }) => {
  await open(['hi']);
  await page.locator('#toggle-settings').click();
  await page.getByLabel('Temperature').fill('1.5');
  await page.getByLabel('Temperature').blur();

  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('button', { name: 'Reset everything' }).click();
  await expect(page.getByLabel('Temperature')).toHaveValue('1.5');
});

test('removing an allowlist entry returns the list to allow-everything', async ({ open, page }) => {
  await open(['hi']);
  await page.locator('#toggle-settings').click();

  await page.getByPlaceholder('api.example.com').fill('api.example.com');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.chip')).toContainText('api.example.com');

  await page.getByRole('button', { name: 'Remove api.example.com' }).click();
  await expect(page.locator('.chip')).toHaveCount(0);
  await expect(page.locator('#settings-body')).toContainText('Empty — every domain is allowed.');
});

test('deleting a credential removes it immediately', async ({ open, page }) => {
  await open(['hi']);
  await page.locator('#toggle-settings').click();

  await page.getByPlaceholder('Name (e.g. GitHub)').fill('Gone');
  await page.getByPlaceholder('Secret value').fill('short-lived');
  await page.getByRole('button', { name: 'Add credential' }).click();
  await expect(page.locator('.cred-head')).toContainText('Gone');

  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.cred')).toHaveCount(0);
  await expect(page.locator('#settings-body')).toContainText('No credentials stored');
});

/* ------------------------------------------------------------------ *
 * chrome: toggles and sheets
 * ------------------------------------------------------------------ */

test('the sheet toggles expose their state, and opening one closes the other', async ({ open, page }) => {
  await open(['hi']);
  const settingsBtn = page.locator('#toggle-settings');
  const logBtn = page.locator('#toggle-log');

  await expect(settingsBtn).toHaveAttribute('aria-expanded', 'false');
  await settingsBtn.click();
  await expect(settingsBtn).toHaveAttribute('aria-expanded', 'true');

  // The two sheets are exclusive; the buttons must agree with that.
  await logBtn.click();
  await expect(logBtn).toHaveAttribute('aria-expanded', 'true');
  await expect(settingsBtn).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#settings-sheet')).toHaveAttribute('data-open', 'false');

  // Clicking the open sheet's own toggle closes it again.
  await logBtn.click();
  await expect(logBtn).toHaveAttribute('aria-expanded', 'false');
});

/* ------------------------------------------------------------------ *
 * conversation
 * ------------------------------------------------------------------ */

test('a multi-turn conversation accumulates in order', async ({ open }) => {
  const page = await open(['first answer', 'second answer']);

  await send(page, 'first question');
  await settled(page);
  await send(page, 'second question');
  await settled(page);

  await expect(page.locator('.msg-user')).toHaveCount(2);
  await expect(page.locator('.msg-assistant')).toHaveCount(2);

  // Strict interleaving: question, answer, question, answer.
  const order = await page.$$eval('.msg-user, .msg-assistant', (nodes) =>
    nodes.map((n) => (n.classList.contains('msg-user') ? 'u' : 'a')).join('')
  );
  expect(order).toBe('uaua');
});

/* ------------------------------------------------------------------ *
 * capability gate
 * ------------------------------------------------------------------ */

test('the gate offers a working retry', async ({ page, appServer }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true });
  });
  await page.goto(appServer.url);

  const retry = page.locator('.gate').getByRole('button', { name: 'Check again' });
  await expect(retry).toBeEnabled();

  // WebGPU is still absent after the reload, so the gate returns — the point
  // is that the button re-probes rather than doing nothing.
  await retry.click();
  await expect(page.locator('.gate')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
});
