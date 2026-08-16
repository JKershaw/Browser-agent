/**
 * What the streaming bubble shows while the model is still talking.
 *
 * The committed message was always cleaned; the *streamed* text was rendered
 * raw, which put `<think>` blocks and tool-call JSON on a real user's screen.
 * These tests watch every DOM mutation during a turn — not just the final
 * state — so a one-frame leak fails the suite.
 *
 * @module tests/e2e/streaming.spec
 */

import { expect, send, settled, test, toolCall } from './fixtures.js';

/**
 * Record the text of every assistant-bubble frame for the rest of the page's
 * life. Installed before sending, read back after the turn settles, so the
 * assertion covers the whole stream rather than whatever Playwright's polling
 * happened to catch.
 *
 * @param {import('@playwright/test').Page} page
 */
async function watchFrames(page) {
  await page.evaluate(() => {
    globalThis.__frames = [];
    const messages = document.querySelector('#messages');
    new MutationObserver(() => {
      for (const body of messages.querySelectorAll('.msg-assistant .msg-body')) {
        globalThis.__frames.push(body.textContent);
      }
    }).observe(messages, { childList: true, characterData: true, subtree: true });
  });
}

const frames = (page) => page.evaluate(() => globalThis.__frames);

test('a <think> block never appears on screen, and the answer does', async ({ open }) => {
  const page = await open([
    '<think>The user wants the year. Turing was born in 1912.</think>Alan Turing was born in 1912.',
  ]);
  await watchFrames(page);

  await send(page, 'when was Turing born?');
  await settled(page);

  await expect(page.locator('.msg-assistant').last()).toHaveText('Alan Turing was born in 1912.');
  for (const frame of await frames(page)) {
    expect(frame).not.toContain('<think');
    expect(frame).not.toContain('wants the year');
  }
});

test('tool-call JSON never appears on screen, fenced or bare', async ({ open, target }) => {
  const page = await open([
    toolCall({ url: `${target.url}/json` }, 'Let me look that up.'),
    `<think>now answer</think>{"tool": "curl", "args": {"method": "GET", "url": "${target.url}/json", "headers": {}, "body": null}}`,
    'It is raining in Bristol.',
  ]);
  await watchFrames(page);

  await send(page, 'what is the weather?');
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await page.locator('.confirm-card').getByRole('button', { name: 'Approve' }).click();
  await settled(page);

  for (const frame of await frames(page)) {
    expect(frame).not.toContain('"tool"');
    expect(frame).not.toContain('```');
  }
});

test('while everything is held back the bubble says it is thinking', async ({ open }) => {
  // A long think block, so the held-back state is on screen for many frames.
  const page = await open([
    `<think>${'considering the question carefully. '.repeat(20)}</think>Done thinking.`,
  ]);

  await send(page, 'think hard');
  // Mid-stream: the bubble is in its thinking state rather than sitting empty.
  await expect(page.locator('.msg-assistant.msg-thinking')).toBeVisible();
  await settled(page);

  // And the state is cleared once the answer lands.
  await expect(page.locator('.msg-assistant.msg-thinking')).toHaveCount(0);
  await expect(page.locator('.msg-assistant').last()).toHaveText('Done thinking.');
});

test('a cancelled think-only stream leaves no empty bubble behind', async ({ open }) => {
  const page = await open([
    `<think>${'this reasoning never ends. '.repeat(40)}`,
    'Second turn answer.',
  ]);

  await send(page, 'first');
  await expect(page.locator('.msg-assistant.msg-thinking')).toBeVisible();
  await page.locator('#stop').click();
  await settled(page);

  // Nothing visible ever arrived, so no interrupted husk is left in history.
  await expect(page.locator('.msg-assistant')).toHaveCount(0);
});
