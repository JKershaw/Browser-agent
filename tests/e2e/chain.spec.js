/**
 * The chain-driver end to end: a "do X, then do Y" message runs as two
 * sequential steps (agent/split.js) through the real UI, against the built
 * artifact with the scripted engine.
 *
 * @module tests/e2e/chain.spec
 */

import { expect, send, settled, test, toolCall } from './fixtures.js';

test('a two-step ask shows one user bubble, a step marker, and both tool calls', async ({ open, target }) => {
  const page = await open([
    toolCall({ url: `${target.url}/json` }),
    'The city is Bristol.',
    toolCall({ url: `${target.url}/status/200` }),
    'All done: it is in the United Kingdom.',
  ]);

  const ask = `GET ${target.url}/json to find the city please, then GET ${target.url}/status/200 for me as well.`;
  await send(page, ask);
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  // The user's message appears once, exactly as typed — not split into pieces.
  await expect(page.locator('.msg-user')).toHaveCount(1);
  await expect(page.locator('.msg-user')).toHaveText(ask);

  // The second step is narrated as a step marker, not a fake user bubble.
  const step = page.locator('.msg-step');
  await expect(step).toHaveCount(1);
  await expect(step.locator('.msg-tag')).toHaveText('step 2 of 2');
  await expect(step.locator('.msg-body')).toContainText('/status/200');

  // Both requests really went out, in order.
  await expect(page.locator('.tool-card')).toHaveCount(2);
  const paths = target.received().map((r) => r.path);
  expect(paths).toEqual(['/json', '/status/200']);

  // The final answer follows the second step.
  await expect(page.locator('.msg-assistant').last()).toContainText('United Kingdom');
});

test('an "and also" fan-out runs as two steps through the UI', async ({ open, target }) => {
  const page = await open([
    toolCall({ url: `${target.url}/json` }),
    'The city is Bristol.',
    toolCall({ url: `${target.url}/status/202` }),
    'The city is Bristol and the status code was 202.',
  ]);

  await send(
    page,
    `GET ${target.url}/json and also GET ${target.url}/status/202, and tell me both the city and the status code.`
  );
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  await expect(page.locator('.msg-step .msg-tag')).toHaveText('step 2 of 2');
  await expect(page.locator('.tool-card')).toHaveCount(2);
  expect(target.received().map((r) => r.path)).toEqual(['/json', '/status/202']);
  await expect(page.locator('.msg-assistant').last()).toContainText('202');
});

test('a single-step ask renders no step marker', async ({ open }) => {
  const page = await open(['Paris is the capital of France.']);
  await send(page, 'What is the capital of France?');
  await settled(page);

  await expect(page.locator('.msg-step')).toHaveCount(0);
  await expect(page.locator('.msg-user')).toHaveCount(1);
});

test('a "then tell me" ask stays one step', async ({ open, target }) => {
  const page = await open([
    toolCall({ url: `${target.url}/json` }),
    'The server said the city is Bristol.',
  ]);

  await send(page, `GET ${target.url}/json for me, then tell me which city it names.`);
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  await expect(page.locator('.msg-step')).toHaveCount(0);
  await expect(page.locator('.tool-card')).toHaveCount(1);
  await expect(page.locator('.msg-assistant').last()).toContainText('Bristol');
});
