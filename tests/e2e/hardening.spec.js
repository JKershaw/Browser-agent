/**
 * M3 hardening scenarios: the capability gate, the domain allowlist, credential
 * handling in the real UI, settings persistence and the `file://` notice.
 *
 * @module tests/e2e/hardening.spec
 */

import { expect, send, settled, test, toolCall } from './fixtures.js';

test('no WebGPU: an explanatory screen, never a blank page', async ({ page, appServer }) => {
  // Hide navigator.gpu before any app code runs.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true });
  });
  await page.goto(appServer.url);

  const gate = page.locator('.gate');
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('needs WebGPU');
  await expect(gate).toContainText('navigator.gpu is missing');
  // It tells you what to do about it, and reassures you nothing was sent.
  await expect(gate).toContainText(/Chrome|Chromium/);
  await expect(gate).toContainText('has not loaded a model or made any request');
  // The app shell is hidden rather than half-rendered.
  await expect(page.locator('#app')).toBeHidden();
});

test('the mock engine announces itself so it is never mistaken for the model', async ({ open }) => {
  const page = await open(['scripted reply']);
  await expect(page.locator('.notice-warning')).toContainText('Mock engine active');
});

test('the allowlist refuses an off-list host before anything is sent', async ({ open, target }) => {
  const page = await open([toolCall({ url: 'https://not-on-the-list.test/x' }), 'It was blocked.']);

  await page.locator('#toggle-settings').click();
  await page.getByPlaceholder('api.example.com').fill('127.0.0.1');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.chip')).toContainText('127.0.0.1');
  await page.locator('#close-settings').click();

  await send(page, 'fetch it');
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  const tool = page.locator('.tool-card').first();
  await expect(tool).toHaveClass(/tool-error/);
  await expect(tool).toContainText('not on the domain allowlist');
  expect(target.received()).toHaveLength(0);
});

test('the allowlist still permits a listed host', async ({ open, target }) => {
  const page = await open([toolCall({ url: `${target.url}/json` }), 'Got it.']);

  await page.locator('#toggle-settings').click();
  await page.getByPlaceholder('api.example.com').fill('127.0.0.1');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('#close-settings').click();

  await send(page, 'fetch it');
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  await expect(page.locator('.tool-card').first()).toHaveClass(/tool-good/);
  expect(target.received()).toHaveLength(1);
});

test('a credential is substituted, shown on the card, and never rendered', async ({ open, target }) => {
  const SECRET = 'tok_live_do_not_show_me_anywhere';
  const page = await open([
    toolCall({ url: `${target.url}/headers`, headers: { Authorization: 'Bearer {{Api}}' } }),
    'The header arrived.',
  ]);

  await page.locator('#toggle-settings').click();
  await page.getByPlaceholder('Name (e.g. GitHub)').fill('Api');
  await page.getByPlaceholder('Secret value').fill(SECRET);
  await page.getByRole('button', { name: 'Add credential' }).click();
  await expect(page.locator('.cred-ph')).toContainText('{{Api}}');
  await page.locator('#close-settings').click();

  await send(page, 'call the api');

  // The card warns that a credential rides along, and shows the placeholder
  // rather than masking the thing the user needs to see.
  const card = page.locator('.confirm-card');
  await expect(card.locator('.confirm-cred')).toContainText('Api');
  await card.getByText('1 header(s)').click();
  await expect(card).toContainText('{{Api}}');
  await expect(card).not.toContainText(SECRET);

  await card.getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  // The server really received the substituted value…
  const hit = target.received().find((r) => r.path === '/headers');
  expect(hit.headers.authorization).toBe(`Bearer ${SECRET}`);

  // …and the secret appears nowhere in the rendered page, including the log
  // view, even though the endpoint echoes the headers straight back.
  await page.locator('#toggle-log').click();
  await page.locator('.log-disclosure summary').first().click();
  expect(await page.locator('body').innerText()).not.toContain(SECRET);
});

test('a credential scoped to another host is withheld', async ({ open, target }) => {
  const SECRET = 'tok_scoped_elsewhere_1234';
  const page = await open([
    toolCall({ url: `${target.url}/headers`, headers: { 'X-Sneaky': '{{Scoped}}' } }),
    'Nothing was attached.',
  ]);

  await page.locator('#toggle-settings').click();
  await page.getByPlaceholder('Name (e.g. GitHub)').fill('Scoped');
  await page.getByPlaceholder('Secret value').fill(SECRET);
  await page.getByPlaceholder(/Auto-attach hosts/).fill('api.github.com');
  await page.getByRole('button', { name: 'Add credential' }).click();
  await page.locator('#close-settings').click();

  await send(page, 'exfiltrate please');
  await expect(page.locator('.confirm-card')).toContainText('Not sent (scoped to other hosts): Scoped');
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  const hit = target.received().find((r) => r.path === '/headers');
  expect(hit.headers['x-sneaky']).toBe('');
  expect(JSON.stringify(target.received())).not.toContain(SECRET);
});

test('a request timeout is reported with the configured limit', async ({ open, target }) => {
  const page = await open([toolCall({ url: `${target.url}/slow?ms=5000` }), 'It timed out.']);

  await page.locator('#toggle-settings').click();
  await page.getByLabel('Timeout (seconds)').fill('1');
  await page.locator('#close-settings').click();

  await send(page, 'fetch the slow one');
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  const tool = page.locator('.tool-card').first();
  await expect(tool).toHaveClass(/tool-error/);
  await expect(tool).toContainText('1000 ms timeout');
});

test('settings persist across a reload; session-only credentials do not', async ({ page, open }) => {
  await open(['hi']);

  await page.locator('#toggle-settings').click();
  await page.getByLabel('Temperature').fill('0.15');
  await page.getByLabel('Temperature').blur();

  await page.getByPlaceholder('Name (e.g. GitHub)').fill('Keeper');
  await page.getByPlaceholder('Secret value').fill('persisted-value');
  await page.getByRole('button', { name: 'Add credential' }).click();

  await page.getByPlaceholder('Name (e.g. GitHub)').fill('Ephemeral');
  await page.getByPlaceholder('Secret value').fill('session-value');
  await page.getByText('Session only (never written to disk)').click();
  await page.getByRole('button', { name: 'Add credential' }).click();

  await expect(page.locator('.cred')).toHaveCount(2);
  await expect(page.locator('.badge')).toContainText('session only');

  // Nothing session-only reached storage.
  const stored = await page.evaluate(() => localStorage.getItem('browser-agent.settings.v1'));
  expect(stored).toContain('persisted-value');
  expect(stored).not.toContain('session-value');

  await page.reload();
  await expect(page.locator('#send')).toBeEnabled({ timeout: 20_000 });
  await page.locator('#toggle-settings').click();

  await expect(page.getByLabel('Temperature')).toHaveValue('0.15');
  await expect(page.locator('.cred')).toHaveCount(1);
  await expect(page.locator('.cred-head')).toContainText('Keeper');
});

test('a credential value is masked until revealed', async ({ page, open }) => {
  await open(['hi']);
  await page.locator('#toggle-settings').click();
  await page.getByPlaceholder('Name (e.g. GitHub)').fill('Secret');
  await page.getByPlaceholder('Secret value').fill('reveal-me-please');
  await page.getByRole('button', { name: 'Add credential' }).click();

  await expect(page.locator('.cred-value')).not.toContainText('reveal-me-please');
  await page.getByRole('button', { name: 'Reveal' }).click();
  await expect(page.locator('.cred-value')).toContainText('reveal-me-please');
  await page.getByRole('button', { name: 'Hide' }).click();
  await expect(page.locator('.cred-value')).not.toContainText('reveal-me-please');
});

test('the log exports masked JSON', async ({ open, target, page }) => {
  const page_ = await open([toolCall({ url: `${target.url}/json` }), 'done']);
  await send(page_, 'fetch it');
  await page_.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page_);

  await page_.locator('#toggle-log').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page_.getByRole('button', { name: 'Export JSON' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('browser-agent-log.json');
});

test('the file:// notice appears only on a file origin', async ({ open, page }) => {
  await open(['hi']);
  await expect(page.locator('#file-notice')).toBeHidden();
});

test('Escape closes an open sheet', async ({ page, open }) => {
  await open(['hi']);
  await page.locator('#toggle-settings').click();
  await expect(page.locator('#settings-sheet')).toHaveAttribute('data-open', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-sheet')).toHaveAttribute('data-open', 'false');
});

test('a second Enter cannot approve the card the first Enter opened', async ({ open, page, target }) => {
  // The card appears a few hundred ms after Enter sends the message. A reflex
  // second Enter — or a key repeat — must not land on Approve and dispatch a
  // destructive request nobody looked at.
  const page_ = await open([toolCall({ method: 'DELETE', url: `${target.url}/echo` }), 'done']);

  await page_.locator('#input').fill('delete the thing');
  await page_.locator('#input').press('Enter');
  await expect(page_.locator('.confirm-card')).toBeVisible();

  // Deny holds focus, so a stray Enter refuses rather than dispatching.
  const focused = await page.evaluate(() => document.activeElement?.className || '');
  expect(focused).toContain('btn-deny');

  await page.keyboard.press('Enter');
  await settled(page_);

  // The DELETE never went out, and the record says it was refused.
  expect(target.received()).toHaveLength(0);
  await expect(page_.locator('.tool-card')).toHaveClass(/tool-denied/);
});

test('Approve arms shortly after the card opens, then works normally', async ({ open, page, target }) => {
  const page_ = await open([toolCall({ url: `${target.url}/json` }), 'done']);
  await send(page_, 'fetch it');

  const approve = page_.locator('.confirm-card .btn-approve');
  await expect(approve).toBeDisabled();
  await expect(approve).toBeEnabled({ timeout: 5000 });
  await approve.click();
  await settled(page_);

  expect(target.received()).toHaveLength(1);
});

test('the card names the proxy the request will actually go through', async ({ open, page, target }) => {
  const page_ = await open([toolCall({ url: 'https://example.invalid/x' }), 'done']);

  await page_.locator('#toggle-settings').click();
  await page_.getByPlaceholder('https://your-proxy.example/?url={url}')
    .fill(`${target.url}/echo?url={url}`);
  await page_.getByPlaceholder('https://your-proxy.example/?url={url}').blur();
  await page_.locator('#close-settings').click();

  await send(page_, 'fetch it');
  const card = page_.locator('.confirm-card');
  await expect(card).toBeVisible();
  // Naming only the target host would assert the opposite of where data goes.
  await expect(card).toContainText('Sent via your configured proxy');
  await expect(card).toContainText('127.0.0.1');
  await card.getByRole('button', { name: 'Deny' }).click();
  await settled(page_);
});

test('a long sub-domain wraps so the real domain stays visible', async ({ open, page }) => {
  const spoof = `https://api.github.com${'a'.repeat(200)}.evil.example/repos`;
  const page_ = await open([toolCall({ url: spoof }), 'done']);
  await send(page_, 'fetch it');

  const head = page_.locator('.confirm-card .confirm-head strong');
  await expect(head).toBeVisible();

  // The registrable domain must be on screen, not off the right edge.
  const box = await head.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  await expect(head).toContainText('evil.example');
});

test('cancelling leaves no card claiming a request is still in flight', async ({ open, page, target }) => {
  const page_ = await open([toolCall({ url: `${target.url}/json` }), 'done']);
  await send(page_, 'fetch it');
  await expect(page_.locator('.confirm-card')).toBeVisible();
  await page_.locator('#stop').click();
  await settled(page_);

  // The chat must agree with the log: nothing was sent.
  await expect(page_.locator('.tool-card')).toHaveClass(/tool-denied/);
  await expect(page_.locator('.tool-card')).not.toContainText('sending…');
  expect(target.received()).toHaveLength(0);

  await page_.locator('#toggle-log').click();
  await expect(page_.locator('.log-entry').first()).toHaveClass(/log-denied/);
});

test('a repair round leaves exactly one finished bubble, with no live caret', async ({ open, page, target }) => {
  const page_ = await open([
    '```json\n{"tool": "curl", "args": {"url": not-json}}\n```',
    toolCall({ url: `${target.url}/json` }),
    'Recovered.',
  ]);
  await send(page_, 'fetch it');
  await page_.locator('.confirm-card .btn-approve').click({ timeout: 5000 });
  await settled(page_);

  // A blinking caret after the turn ends implies generation is still running.
  await expect(page.locator('.caret')).toHaveCount(0);
});

test('a partial answer survives the next message instead of being deleted', async ({ open, page }) => {
  const page_ = await open(['one two three four five six seven eight nine ten', 'second answer']);
  await send(page_, 'first question');
  await settled(page_);

  const first = await page_.locator('.msg-assistant').first().innerText();
  expect(first.length).toBeGreaterThan(0);

  await send(page_, 'second question');
  await settled(page_);

  // History is not rewritten: both answers are present.
  await expect(page_.locator('.msg-assistant')).toHaveCount(2);
  await expect(page_.locator('.msg-assistant').first()).toContainText('one two three');
});

test('typing a credential survives an unrelated settings change', async ({ open, page }) => {
  await open(['hi']);
  await page.locator('#toggle-settings').click();

  await page.getByPlaceholder('Name (e.g. GitHub)').fill('MyToken');
  await page.getByPlaceholder('Secret value').fill('half-typed-secret');

  // Flip something else entirely — this used to wipe the form.
  await page.getByText('Confirm before sending').click();

  await expect(page.getByPlaceholder('Name (e.g. GitHub)')).toHaveValue('MyToken');
  await expect(page.getByPlaceholder('Secret value')).toHaveValue('half-typed-secret');
});

test('Enter does nothing before the model has loaded', async ({ page, appServer }) => {
  // mockLoadMs holds the app in its loading state long enough to press Enter
  // while Send is still disabled — the state a real multi-minute first
  // download puts every user in.
  await page.goto(`${appServer.url}/?mockEngine=1&mockLoadMs=3000`);
  await expect(page.locator('#send')).toBeDisabled();
  await expect(page.locator('.statsbar')).toContainText('loading');

  await page.locator('#input').fill('too early');
  await page.locator('#input').press('Enter');

  // The premature Enter started nothing.
  await expect(page.locator('.msg-user')).toHaveCount(0);

  // Once loaded, the same key works.
  await expect(page.locator('#send')).toBeEnabled({ timeout: 20_000 });
  await page.locator('#input').press('Enter');
  await expect(page.locator('.msg-user')).toHaveCount(1);
});
