/**
 * M1 debug harness: the smallest thing that exercises the whole core loop in a
 * real browser. Superseded by `src/main.js` in M2; kept because it is the
 * fastest way to reproduce an engine or tool bug without the UI in the way.
 *
 * @module debug
 */

import { createApp } from './app.js';

const $ = (id) => document.getElementById(id);
const out = $('out');
const logEl = $('log');

const app = createApp({
  // Auto-approve everything: the confirmation UI is an M2 concern.
  confirm: async (call) => {
    const ok = globalThis.confirm(`Send ${call.args.method} ${call.args.url}?`);
    return { approved: ok, reason: ok ? undefined : 'Denied at the debug prompt.' };
  },
  hooks: {
    onMessage: (m) => append(`[${m.role}] ${m.content}`),
    onNotice: (n) => append(`[notice:${n.kind}] ${n.text}`),
    onTurnEnd: (e) => append(`[end] ${e.stopReason} after ${e.iterations} tool call(s)`),
  },
});

app.log.subscribe((entries) => {
  logEl.textContent = JSON.stringify(entries, null, 2);
});

function append(line) {
  out.textContent += `${line}\n\n`;
}

async function boot() {
  const { caps, model } = await app.probe();
  append(`[caps] webgpu=${caps.webgpu} ${caps.reason || ''}`);
  append(`[model] ${model.id} ${model.reason}`);
  if (app.isFileOrigin()) append('[notice] Running from file:// — model caching is unreliable here.');

  try {
    await app.engine.load(model.id, (p) => {
      out.textContent = `loading ${Math.round((p.progress || 0) * 100)}% — ${p.text}\n`;
    });
    append('[ready] model loaded');
  } catch (e) {
    append(`[error] model load failed: ${e?.message || e}`);
  }
}

$('send').addEventListener('click', async () => {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  await app.loop.run(text);
});

$('cancel').addEventListener('click', () => app.loop.cancel());

boot();
