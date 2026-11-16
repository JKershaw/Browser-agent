/**
 * Switching models from the settings sheet, and starting, reopening and
 * deleting saved chats.
 *
 * @module tests/e2e/chats-models.spec
 */

import { expect, send, settled, test, toolCall } from './fixtures.js';

const TINY = { id: 'Qwen3-0.6B-q4f16_1-MLC', label: 'Qwen3 0.6B (tiny, fastest)' };
const SMALL = { id: 'Qwen3-1.7B-q4f16_1-MLC', label: 'Qwen3 1.7B (small)' };

/** @param {import('@playwright/test').Page} page */
async function openSettings(page) {
  if ((await page.locator('#settings-sheet').getAttribute('data-open')) !== 'true') {
    await page.locator('#toggle-settings').click();
  }
}

/** @param {import('@playwright/test').Page} page @param {string} id */
const row = (page, id) => page.locator(`.model-row[data-model-id="${id}"]`);

/** @param {import('@playwright/test').Page} page @param {string} id */
async function waitReady(page, id) {
  await expect(page.locator('#messages')).toContainText(`${id} is ready.`, { timeout: 20_000 });
  await expect(page.locator('#send')).toBeEnabled();
}

test('the settings sheet lists models, shows which is in use, and switches between them', async ({ page, open }) => {
  // Long enough for each load's card to be seen, short enough to stay quick.
  await open(['ok'], { mockLoadMs: '800' });
  await openSettings(page);

  // The default tier loaded at start-up is the one in use; the rest are not
  // downloaded yet.
  const active = page.locator('.model-row-active');
  await expect(active).toHaveCount(1);
  const firstId = await active.getAttribute('data-model-id');
  await expect(active.locator('.model-badge')).toHaveText('In use');
  await expect(row(page, TINY.id).locator('.model-badge')).toHaveText('Not downloaded');
  await expect(page.locator('.model-summary')).toContainText('1 downloaded');

  // Switch to a model that has to download first.
  await page.getByRole('button', { name: `Download and switch to ${TINY.label}` }).click();
  await expect(page.locator('.loading-card')).toBeVisible();
  await waitReady(page, TINY.id);
  await expect(page.locator('.statsbar')).toContainText(TINY.id);

  await openSettings(page);
  await expect(row(page, TINY.id)).toHaveClass(/model-row-active/);
  await expect(row(page, firstId).locator('.model-badge')).toHaveText('Downloaded');
  await expect(page.locator('.model-summary')).toContainText('In use: Qwen3 0.6B');
  await expect(page.locator('.model-summary')).toContainText('2 downloaded');

  // Switching back is the cached path: no download.
  await row(page, firstId).getByRole('button', { name: /^Switch to / }).click();
  await expect(page.locator('.loading-note')).toContainText('Already downloaded');
  await waitReady(page, firstId);

  // The choice is remembered: a reload loads the model last switched to.
  await openSettings(page);
  await row(page, TINY.id).getByRole('button', { name: /^Switch to / }).click();
  await waitReady(page, TINY.id);
  await page.reload();
  await expect(page.locator('#send')).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator('.statsbar')).toContainText(TINY.id);
});

test('a downloaded model can be deleted from the list', async ({ page, open }) => {
  await open(['ok'], { mockCached: '1' });
  await openSettings(page);

  const small = row(page, SMALL.id);
  await expect(small.locator('.model-badge')).toHaveText('Downloaded');
  page.once('dialog', (d) => d.accept());
  await small.getByRole('button', { name: `Delete the download of ${SMALL.label}` }).click();
  await expect(small.locator('.model-badge')).toHaveText('Not downloaded');
  await expect(small.getByRole('button', { name: `Download and switch to ${SMALL.label}` })).toBeVisible();

  // The model in use has no delete button: it is on the GPU right now.
  await expect(page.locator('.model-row-active').getByRole('button', { name: /^Delete/ })).toHaveCount(0);
});

test('the advanced field loads any model id, which then appears in the list', async ({ page, open }) => {
  await open(['ok']);
  await openSettings(page);
  const custom = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
  await page.getByPlaceholder('e.g. Llama-3.2-1B-Instruct-q4f16_1-MLC').fill(custom);
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await waitReady(page, custom);

  await openSettings(page);
  await expect(row(page, custom)).toHaveClass(/model-row-active/);
});

test('New chat clears the conversation, and the old one can be reopened and continued', async ({ page, open }) => {
  await open(['First answer.', 'Second answer.', 'Third answer.']);

  await send(page, 'first question');
  await settled(page);
  await expect(page.locator('.msg-assistant').last()).toContainText('First answer.');

  await page.locator('#new-chat').click();
  await expect(page.locator('.msg-user')).toHaveCount(0);
  await expect(page.locator('.msg-assistant')).toHaveCount(0);
  await expect(page.locator('#messages')).toContainText('The previous one is saved under Settings → Chats.');
  await expect(page.locator('#input')).toBeFocused();

  await send(page, 'second question');
  await settled(page);

  await openSettings(page);
  const rows = page.locator('.chat-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('second question');
  await expect(rows.nth(0)).toContainText('open now');
  await expect(rows.nth(1)).toContainText('first question');

  await page.getByRole('button', { name: 'Open chat: first question' }).click();
  await expect(page.locator('.msg-user')).toHaveText(['first question']);
  await expect(page.locator('.msg-assistant')).toHaveText(['First answer.']);
  await expect(page.locator('#messages')).toContainText('Reopened “first question”');

  // Carrying on: the model is sent the reopened conversation, not the other.
  await send(page, 'and a follow-up');
  await settled(page);
  const sent = await page.evaluate(() => globalThis.__agent.engine.calls.at(-1).messages.map((m) => m.content).join('\n'));
  expect(sent).toContain('first question');
  expect(sent).not.toContain('second question');

  // Saved across a reload; the reopened chat is now the most recent.
  await page.reload();
  await expect(page.locator('#send')).toBeEnabled({ timeout: 20_000 });
  await openSettings(page);
  await expect(page.locator('.chat-row')).toHaveCount(2);
  await expect(page.locator('.chat-row').first()).toContainText('first question');
  await expect(page.locator('.chat-row').first()).toContainText('2 messages');
});

test('a reopened chat shows its tool cards as they were', async ({ page, open, target }) => {
  await open([toolCall({ url: `${target.url}/json` }, 'Looking.'), 'It is raining in Bristol.', 'ok']);
  await send(page, 'weather?');
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  await page.locator('#new-chat').click();
  await openSettings(page);
  await page.getByRole('button', { name: 'Open chat: weather?' }).click();

  const card = page.locator('.tool-card');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveClass(/tool-good/);
  await expect(card).toContainText('200');
  // Collapsed, as a successful card is live, with the response inside.
  await expect(card).toContainText('Bristol');
  await expect(page.locator('.msg-assistant').last()).toContainText('raining in Bristol');
});

test('a saved chat never contains a credential, even one the server echoed back', async ({ page, open, target }) => {
  const SECRET = 'tok_saved_chat_must_not_contain_me';
  await open([
    toolCall({ url: `${target.url}/headers`, headers: { Authorization: 'Bearer {{Echo}}' } }),
    'done',
  ]);
  await page.evaluate((value) => globalThis.__agent.settings.addCredential({ name: 'Echo', value, sessionOnly: true }), SECRET);

  await send(page, 'echo my headers');
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  // The server really did get, and return, the secret…
  const hit = target.received().find((r) => r.path === '/headers');
  expect(hit.headers.authorization).toBe(`Bearer ${SECRET}`);

  // …and none of it reached storage.
  const stored = await page.evaluate(() => localStorage.getItem('browser-agent.chats.v1'));
  expect(stored).toContain('echo my headers');
  expect(stored).not.toContain(SECRET);
});

test('starting a new chat mid-turn cancels it first', async ({ page, open, target }) => {
  await open([toolCall({ url: `${target.url}/json` }), 'never reached']);
  await send(page, 'go');
  await expect(page.locator('.confirm-card')).toBeVisible();

  await page.locator('#new-chat').click();
  await expect(page.locator('.confirm-card')).toHaveCount(0);
  await expect(page.locator('#stop')).toBeHidden();
  await expect(page.locator('.msg-user')).toHaveCount(0);
  expect(target.received().filter((r) => r.path === '/json')).toHaveLength(0);

  // The composer works again straight away.
  await expect(page.locator('#send')).toBeEnabled();
});

test('chats can be deleted one at a time or all at once', async ({ page, open }) => {
  await open(['ok']);
  await send(page, 'alpha');
  await settled(page);
  await page.locator('#new-chat').click();
  await send(page, 'beta');
  await settled(page);

  await openSettings(page);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete chat: alpha' }).click();
  await expect(page.locator('.chat-row')).toHaveCount(1);
  // Deleting another chat leaves the one on screen alone.
  await expect(page.locator('.msg-user')).toHaveText(['beta']);

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete all chats' }).click();
  await expect(page.locator('.chat-row')).toHaveCount(0);
  await expect(page.locator('#settings-body')).toContainText('No saved chats yet');
  await expect(page.locator('.msg-user')).toHaveCount(0);
});

test('a download in progress survives starting a new chat', async ({ page, appServer }) => {
  const qs = new URLSearchParams({ mockEngine: '1', mockScript: '["ok"]', mockLoadMs: '4000' });
  await page.goto(`${appServer.url}/?${qs}`);
  await expect(page.locator('.loading-card')).toBeVisible();

  await page.locator('#new-chat').click();
  // The card is put back, still live, and the load still completes.
  await expect(page.locator('.loading-card')).toBeVisible();
  await expect(page.locator('#send')).toBeEnabled({ timeout: 20_000 });
});
