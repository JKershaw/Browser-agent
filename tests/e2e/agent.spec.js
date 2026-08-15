/**
 * End-to-end scenarios from SPEC §9.2, run against the built single-file
 * artifact with the scripted engine.
 *
 * Assertions on model *text* are loose; assertions on UI state, log entries and
 * test-server receipts are strict — the point is to prove the plumbing, not the
 * model's prose.
 *
 * @module tests/e2e/agent.spec
 */

import { expect, send, settled, test, toolCall } from './fixtures.js';

test('cold start: the app loads and answers a plain message', async ({ open }) => {
  const page = await open(['Hello! I am running entirely in your browser.']);

  await expect(page.locator('.statsbar')).toContainText('model');
  await send(page, 'hello');
  await settled(page);

  await expect(page.locator('.msg-user').last()).toHaveText('hello');
  await expect(page.locator('.msg-assistant').last()).toContainText('running entirely in your browser');
  // No tool call means no log entry.
  await page.locator('#toggle-log').click();
  await expect(page.locator('#log-body')).toContainText('No requests yet');
});

test('tool round-trip: confirm, approve, response reaches chat and log', async ({ open, target }) => {
  const page = await open([
    toolCall({ url: `${target.url}/json` }, 'Let me look that up.'),
    'It is 14°C and raining lightly in Bristol.',
  ]);

  await send(page, 'what is the weather?');

  // A confirmation card appears and nothing has been sent yet.
  const card = page.locator('.confirm-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('127.0.0.1');
  expect(target.received()).toHaveLength(0);

  await card.getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  // The request really happened.
  const hits = target.received().filter((r) => r.path === '/json');
  expect(hits).toHaveLength(1);
  expect(hits[0].method).toBe('GET');

  // The response is in the chat as a tool card…
  const tool = page.locator('.tool-card').first();
  await expect(tool).toHaveClass(/tool-good/);
  await expect(tool).toContainText('200');
  await expect(tool).toContainText('Bristol');

  // …the model's answer follows…
  await expect(page.locator('.msg-assistant').last()).toContainText('Bristol');

  // …and the log has a matching entry.
  await page.locator('#toggle-log').click();
  const entry = page.locator('.log-entry').first();
  await expect(entry).toHaveClass(/log-ok/);
  await expect(entry).toContainText('/json');
});

test('denial path: the model is told and does not send', async ({ open, target }) => {
  const page = await open([
    toolCall({ url: `${target.url}/json` }),
    'Understood — I did not send that request.',
  ]);

  await send(page, 'fetch the weather');
  await page.locator('.confirm-card').getByRole('button', { name: 'Deny' }).click();
  await settled(page);

  expect(target.received()).toHaveLength(0);
  await expect(page.locator('.tool-card').first()).toHaveClass(/tool-denied/);
  await expect(page.locator('.msg-assistant').last()).toContainText('did not send');

  await page.locator('#toggle-log').click();
  await expect(page.locator('.log-entry').first()).toHaveClass(/log-denied/);
});

test('error surfacing: a dead port renders the network/CORS explanation', async ({ open }) => {
  // Port 1 is reserved and nothing listens there.
  const page = await open([toolCall({ url: 'http://127.0.0.1:1/nope' }), 'That request failed.']);

  await send(page, 'fetch it');
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  const tool = page.locator('.tool-card').first();
  await expect(tool).toHaveClass(/tool-error/);
  await expect(tool).toContainText('CORS');
  await expect(tool).toContainText('No CORS proxy is configured');
});

test('HTTP error statuses are data, not tool failures', async ({ open, target }) => {
  const page = await open([
    toolCall({ url: `${target.url}/status/404` }),
    'The endpoint returned 404.',
  ]);

  await send(page, 'check it');
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  const tool = page.locator('.tool-card').first();
  await expect(tool).toHaveClass(/tool-bad/);
  await expect(tool).not.toHaveClass(/tool-error/);
  await expect(tool).toContainText('404');
});

test('iteration cap: a model that never stops is halted with a visible notice', async ({ open, target }) => {
  // The script's last entry repeats, so the model calls the tool forever.
  const page = await open([toolCall({ url: `${target.url}/json` })]);

  await page.locator('#toggle-settings').click();
  await page.getByLabel('Max tool calls per message').fill('2');
  await page.locator('#close-settings').click();

  await send(page, 'keep going');

  // Approve every card that appears until the loop stops.
  for (let i = 0; i < 2; i += 1) {
    await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
    await expect(page.locator('.tool-card')).toHaveCount(i + 1);
  }
  await settled(page);

  await expect(page.locator('.notice').last()).toContainText('Stopped after 2 tool calls');
  await expect(page.locator('.tool-card')).toHaveCount(2);
  expect(target.received().filter((r) => r.path === '/json')).toHaveLength(2);
});

test('auto-approve remembers the host for the session', async ({ open, target }) => {
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

  // Only one card was ever shown, but both requests went out.
  await expect(page.locator('.confirm-card')).toHaveCount(0);
  await expect(page.locator('.tool-card')).toHaveCount(2);
  expect(target.received().map((r) => r.path)).toEqual(['/json', '/echo']);
});

test('DELETE always asks, even on an auto-approved host', async ({ open, target }) => {
  const page = await open([
    toolCall({ url: `${target.url}/json` }),
    toolCall({ method: 'DELETE', url: `${target.url}/echo` }),
    'Done.',
  ]);

  await send(page, 'get then delete');
  const first = page.locator('.confirm-card');
  await first.getByText(/Auto-approve/).click();
  await first.getByRole('button', { name: 'Approve' }).click();

  // A second card appears despite the auto-approval.
  const second = page.locator('.confirm-card');
  await expect(second).toBeVisible();
  await expect(second).toHaveClass(/confirm-danger/);
  await expect(second).toContainText('DELETE always asks');
  await second.getByRole('button', { name: 'Deny' }).click();
  await settled(page);

  expect(target.received().map((r) => r.method)).toEqual(['GET']);
});

test('a malformed tool call triggers exactly one repair round', async ({ open, target }) => {
  const page = await open([
    '```json\n{"tool": "curl", "args": {"url": not-json}}\n```',
    toolCall({ url: `${target.url}/json` }),
    'Recovered and fetched it.',
  ]);

  await send(page, 'fetch it');
  await expect(page.locator('.notice').last()).toContainText('asking the model to correct it');
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  expect(target.received()).toHaveLength(1);
  await expect(page.locator('.msg-assistant').last()).toContainText('Recovered');
});

test('two failed parses surface the raw output with a warning', async ({ open }) => {
  const bad = '```json\n{"tool": "curl", "args": {"url": "ftp://nope.test"}}\n```';
  const page = await open([bad, bad]);

  await send(page, 'fetch it');
  await settled(page);

  await expect(page.locator('.msg-tag-warn')).toContainText('tool call failed to parse');
  await expect(page.locator('.notice').last()).toContainText('could not be parsed');
});

test('the response body is truncated at the configured limit', async ({ open, target }) => {
  const page = await open([toolCall({ url: `${target.url}/big?n=50000` }), 'That was a big response.']);

  await page.locator('#toggle-settings').click();
  await page.getByLabel(/Response size limit/).fill('1024');
  await page.locator('#close-settings').click();

  await send(page, 'fetch the big one');
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  await expect(page.locator('.tool-card').first()).toContainText('Truncated at 1024 bytes');
});

test('stop cancels a turn and closes an open confirmation card', async ({ open, target }) => {
  const page = await open([toolCall({ url: `${target.url}/json` }), 'done']);

  await send(page, 'fetch it');
  await expect(page.locator('.confirm-card')).toBeVisible();
  await page.locator('#stop').click();
  await settled(page);

  await expect(page.locator('.confirm-card')).toHaveCount(0);
  expect(target.received()).toHaveLength(0);
  // The app is usable again.
  await expect(page.locator('#send')).toBeEnabled();
});

test('a POST carries its body and headers to the server', async ({ open, target }) => {
  // Only GET was ever exercised through the real UI; a body never left the
  // browser in any e2e scenario.
  const page = await open([
    toolCall({
      method: 'POST',
      url: `${target.url}/echo`,
      headers: { 'Content-Type': 'application/json' },
      body: '{"hello":"world"}',
    }),
    'Posted.',
  ]);

  await send(page, 'post it');
  await page.locator('.confirm-card .btn-approve').click({ timeout: 5000 });
  await settled(page);

  const hit = target.received().find((r) => r.path === '/echo');
  expect(hit.method).toBe('POST');
  expect(hit.body).toBe('{"hello":"world"}');
  expect(hit.headers['content-type']).toContain('application/json');
  await expect(page.locator('.tool-card').first()).toHaveClass(/tool-good/);
});

test('a redirect is followed and reported, in a real browser', async ({ open, target }) => {
  // Both redirect defences rest on response.url being populated after a
  // followed 302 — an assumption about browser behaviour that unit tests can
  // only assert against a hand-rolled fake.
  const page = await open([
    toolCall({ url: `${target.url}/redirect?to=${encodeURIComponent(`${target.url}/json`)}` }),
    'Followed it.',
  ]);

  await send(page, 'fetch it');
  await page.locator('.confirm-card .btn-approve').click({ timeout: 5000 });
  await settled(page);

  const tool = page.locator('.tool-card').first();
  await expect(tool).toHaveClass(/tool-good/);
  await tool.locator('.tool-details > summary').click();
  await expect(tool).toContainText('redirected to');
  await expect(tool).toContainText('Bristol');
  expect(target.received().map((r) => r.path)).toEqual(
    expect.arrayContaining([expect.stringContaining('/redirect'), '/json'])
  );
});

test('a credentialled request redirected off-host is discarded, in a real browser', async ({ open, page, target }) => {
  // The 302 points at a *different* host, which is where the browser's
  // Authorization-stripping stops mattering and ours has to take over.
  const elsewhere = `http://localhost:${target.port}/json`;
  const page_ = await open([
    toolCall({
      url: `${target.url}/redirect?to=${encodeURIComponent(elsewhere)}`,
      headers: { 'X-Api-Key': '{{Red}}' },
    }),
    'It was blocked.',
  ]);

  await page_.locator('#toggle-settings').click();
  await page_.getByPlaceholder('Name (e.g. GitHub)').fill('Red');
  await page_.getByPlaceholder('Secret value').fill('tok_redirect_guard_1234');
  await page_.getByRole('button', { name: 'Add credential' }).click();
  await page_.locator('#close-settings').click();

  await send(page_, 'fetch it');
  await page_.locator('.confirm-card .btn-approve').click({ timeout: 5000 });
  await settled(page_);

  const tool = page_.locator('.tool-card').first();
  await expect(tool).toHaveClass(/tool-error/);
  await expect(tool).toContainText('rotate it');
  // The attacker-side body must never be shown.
  await expect(tool).not.toContainText('Bristol');
});
