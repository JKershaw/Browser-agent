import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_MAX_ITERATIONS,
  HARD_MAX_ITERATIONS,
  StopReason,
  clampIterations,
  createAgentLoop,
  shouldConfirm,
  toEngineMessages,
} from '../../src/agent/loop.js';
import { createMockEngine } from '../../src/llm/mock.js';

const toolCall = (url = 'https://api.test/x', method = 'GET') =>
  '```json\n' + JSON.stringify({ tool: 'curl', args: { method, url, headers: {}, body: null } }) + '\n```';

const okResult = (body = 'RESULT BODY') => ({
  ok: true, status: 200, statusText: 'OK', headers: {}, body, truncated: false, elapsedMs: 1,
});

/**
 * Build a loop with sensible defaults; every dep is overridable.
 */
function makeLoop({ script = ['done'], settings = {}, confirm, executeTool, hooks = {}, session } = {}) {
  const engine = createMockEngine({ script });
  const merged = {
    confirmBeforeSend: false,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    temperature: 0.6,
    credentials: [],
    allowlist: [],
    ...settings,
  };
  const exec = executeTool || vi.fn(async () => okResult());
  const loop = createAgentLoop({
    engine,
    executeTool: exec,
    formatResult: (r) => (r.ok ? `HTTP ${r.status}\n${r.body}` : `TOOL ERROR\n${r.error.message}`),
    getSettings: () => merged,
    confirm,
    hooks,
    session,
  });
  return { loop, engine, exec, settings: merged };
}

describe('clampIterations', () => {
  // Literal expectations. Using DEFAULT_MAX_ITERATIONS/HARD_MAX_ITERATIONS as
  // the expected values would make the table pass for any value they held.
  it('pins the limits the spec names', () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(5);
    expect(HARD_MAX_ITERATIONS).toBe(10);
  });

  it.each([
    [1, 1],
    [5, 5],
    [10, 10],
    [11, 10],
    [999, 10],
    [0, 1],
    [-3, 1],
    ['4', 4],
    ['abc', 5],
    [undefined, 5],
    [NaN, 5],
    [3.9, 3],
  ])('clampIterations(%s) === %s', (input, expected) => {
    expect(clampIterations(input)).toBe(expected);
  });
});

describe('shouldConfirm', () => {
  const call = (method, url = 'https://api.test/x') => ({ args: { method, url } });

  it('skips confirmation when the setting is off', () => {
    expect(shouldConfirm(call('GET'), { confirmBeforeSend: false })).toBe(false);
  });

  it('confirms every call when the setting is on', () => {
    expect(shouldConfirm(call('GET'), { confirmBeforeSend: true })).toBe(true);
  });

  it('skips confirmation for an auto-approved host', () => {
    const session = { autoApprovedHosts: new Set(['https://api.test']) };
    expect(shouldConfirm(call('GET'), { confirmBeforeSend: true }, session)).toBe(false);
  });

  it('does not extend auto-approval to other hosts', () => {
    const session = { autoApprovedHosts: new Set(['https://api.test']) };
    expect(shouldConfirm(call('GET', 'https://other.test/x'), { confirmBeforeSend: true }, session)).toBe(true);
  });

  it('always confirms DELETE, even when confirmation is off', () => {
    expect(shouldConfirm(call('DELETE'), { confirmBeforeSend: false })).toBe(true);
  });

  it('always confirms DELETE on an auto-approved host', () => {
    const session = { autoApprovedHosts: new Set(['https://api.test']) };
    expect(shouldConfirm(call('DELETE'), { confirmBeforeSend: true }, session)).toBe(true);
  });

  it('confirms when the URL cannot be parsed', () => {
    expect(shouldConfirm(call('GET', 'nonsense'), { confirmBeforeSend: true }, { autoApprovedHosts: new Set() })).toBe(true);
  });

  it('tolerates missing settings and session', () => {
    expect(shouldConfirm(call('GET'), undefined)).toBe(false);
    expect(shouldConfirm({}, { confirmBeforeSend: true })).toBe(true);
  });
});

describe('toEngineMessages', () => {
  it('prepends the system prompt and maps tool results to user turns', () => {
    const msgs = toEngineMessages(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'call' },
        { role: 'tool', content: 'TOOL RESULT\nHTTP 200' },
      ],
      'SYS'
    );
    expect(msgs).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'call' },
      { role: 'user', content: 'TOOL RESULT\nHTTP 200' },
    ]);
  });
});

describe('agent loop — termination', () => {
  it('ends the turn on a plain-text reply without touching the tool', async () => {
    const { loop, exec } = makeLoop({ script: ['Paris is the capital of France.'] });
    const r = await loop.run('capital of france?');
    expect(r.stopReason).toBe(StopReason.TEXT);
    expect(r.iterations).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(loop.transcript.at(-1)).toMatchObject({ role: 'assistant', content: 'Paris is the capital of France.' });
  });

  it('runs one tool call then answers', async () => {
    const { loop, exec } = makeLoop({ script: [toolCall(), 'The API returned 200.'] });
    const r = await loop.run('check the api');
    expect(r.stopReason).toBe(StopReason.TEXT);
    expect(r.iterations).toBe(1);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(loop.transcript.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('feeds the formatted tool result back to the model', async () => {
    const { loop, engine } = makeLoop({
      script: [toolCall(), 'ok'],
      executeTool: async () => okResult('{"temp":21}'),
    });
    await loop.run('go');
    const secondCallMessages = engine.calls[1].messages;
    expect(secondCallMessages.at(-1)).toEqual({ role: 'user', content: 'TOOL RESULT\nHTTP 200\n{"temp":21}' });
  });

  it('rejects a concurrent run', async () => {
    const { loop } = makeLoop({ script: [toolCall(), 'ok'], confirm: () => new Promise(() => {}), settings: { confirmBeforeSend: true } });
    const first = loop.run('a');
    await new Promise((r) => setTimeout(r, 5));
    await expect(loop.run('b')).rejects.toThrow('already running');
    loop.cancel();
    expect((await first).stopReason).toBe(StopReason.CANCELLED);
  });

  it('unblocks a confirmation card that the UI never settles when cancelled', async () => {
    const { loop, exec } = makeLoop({
      script: [toolCall(), 'ok'],
      settings: { confirmBeforeSend: true },
      confirm: () => new Promise(() => {}), // card opened, user never answers
    });
    const run = loop.run('go');
    await new Promise((r) => setTimeout(r, 5));
    loop.cancel();
    expect((await run).stopReason).toBe(StopReason.CANCELLED);
    expect(exec).not.toHaveBeenCalled();
    expect(loop.getState().running).toBe(false);
    expect(loop.getState().pendingConfirmation).toBeNull();
  });
});

describe('agent loop — iteration cap', () => {
  it('halts at the configured cap when the model never stops calling', async () => {
    const notices = [];
    const { loop, exec } = makeLoop({
      script: [toolCall()], // mock repeats the last entry forever
      settings: { maxIterations: 3 },
      hooks: { onNotice: (n) => notices.push(n) },
    });
    const r = await loop.run('loop forever');
    expect(r.stopReason).toBe(StopReason.CAP);
    expect(r.iterations).toBe(3);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(notices.some((n) => /Stopped after 3 tool calls/.test(n.text))).toBe(true);
  });

  it('enforces the hard cap over an oversized setting', async () => {
    const { loop, exec } = makeLoop({ script: [toolCall()], settings: { maxIterations: 50 } });
    const r = await loop.run('go');
    expect(r.iterations).toBe(HARD_MAX_ITERATIONS);
    expect(exec).toHaveBeenCalledTimes(HARD_MAX_ITERATIONS);
  });

  it('gives the model a final pass to speak after its last allowed call', async () => {
    const { loop } = makeLoop({
      script: [toolCall(), 'Here is the answer.'],
      settings: { maxIterations: 1 },
    });
    const r = await loop.run('go');
    expect(r.stopReason).toBe(StopReason.TEXT);
    expect(r.iterations).toBe(1);
  });
});

describe('agent loop — confirmation and denial', () => {
  it('asks for confirmation and sends on approval', async () => {
    const confirm = vi.fn(async () => ({ approved: true }));
    const { loop, exec } = makeLoop({ script: [toolCall(), 'ok'], settings: { confirmBeforeSend: true }, confirm });
    await loop.run('go');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('returns a structured denial to the model and does not send', async () => {
    const confirm = vi.fn(async () => ({ approved: false, reason: 'looks sketchy' }));
    const denied = [];
    const { loop, exec, engine } = makeLoop({
      script: [toolCall(), 'Understood, I will not send that.'],
      settings: { confirmBeforeSend: true },
      confirm,
      hooks: { onToolDenied: (d) => denied.push(d) },
    });
    const r = await loop.run('go');
    expect(exec).not.toHaveBeenCalled();
    expect(denied).toHaveLength(1);
    const fedBack = engine.calls[1].messages.at(-1).content;
    expect(fedBack).toContain('DENIED BY USER');
    expect(fedBack).toContain('looks sketchy');
    expect(fedBack).toContain('Do not retry the same request');
    expect(r.stopReason).toBe(StopReason.TEXT);
  });

  it('does not charge a refusal against the tool-call budget', async () => {
    // Denying suggestions must not silently exhaust a budget meant for
    // requests that were actually sent; the pass loop still bounds the turn.
    const notices = [];
    const { loop, exec } = makeLoop({
      script: [toolCall()],
      settings: { confirmBeforeSend: true, maxIterations: 2 },
      confirm: async () => ({ approved: false }),
      hooks: { onNotice: (n) => notices.push(n) },
    });
    const r = await loop.run('go');
    expect(r.stopReason).toBe(StopReason.CAP);
    expect(r.iterations).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(loop.getState().denials).toBe(3);
    // …and the notice tells the truth about what happened.
    const capNotice = notices.at(-1).text;
    expect(capNotice).toContain('3 refused requests');
    expect(capNotice).not.toMatch(/\d+ tool calls/);
  });

  it('remembers an auto-approved host for the rest of the session', async () => {
    const confirm = vi.fn(async () => ({ approved: true, rememberHost: true }));
    const { loop, exec } = makeLoop({
      script: [toolCall(), toolCall(), 'done'],
      settings: { confirmBeforeSend: true },
      confirm,
    });
    await loop.run('go');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(loop.getState().autoApprovedHosts).toEqual(['https://api.test']);
  });

  it('still confirms DELETE on an auto-approved host', async () => {
    const confirm = vi.fn(async () => ({ approved: true, rememberHost: true }));
    const { loop } = makeLoop({
      script: [toolCall('https://api.test/x', 'GET'), toolCall('https://api.test/x', 'DELETE'), 'done'],
      settings: { confirmBeforeSend: true },
      confirm,
    });
    await loop.run('go');
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('denies safely when confirmation is required but no handler is wired', async () => {
    const { loop, exec, engine } = makeLoop({
      script: [toolCall(), 'ok'],
      settings: { confirmBeforeSend: true },
      confirm: undefined,
    });
    await loop.run('go');
    expect(exec).not.toHaveBeenCalled();
    expect(engine.calls[1].messages.at(-1).content).toContain('DENIED BY USER');
  });

  it('exposes the pending call while the card is open', async () => {
    let seen = null;
    let release;
    const gate = new Promise((r) => { release = r; });
    const { loop } = makeLoop({
      script: [toolCall(), 'ok'],
      settings: { confirmBeforeSend: true },
      confirm: async () => { seen = loop.getState().pendingConfirmation; release(); return { approved: true }; },
    });
    const run = loop.run('go');
    await gate;
    expect(seen.args.url).toBe('https://api.test/x');
    await run;
    expect(loop.getState().pendingConfirmation).toBeNull();
  });

  it('treats a confirm handler returning undefined as a denial, not a crash', async () => {
    const { loop, exec, engine } = makeLoop({
      script: [toolCall(), 'I will not send that.'],
      settings: { confirmBeforeSend: true },
      confirm: async () => undefined,
    });
    const r = await loop.run('go');
    expect(exec).not.toHaveBeenCalled();
    // The turn must complete normally and the model must be told it was denied
    // — an exception here would end the turn as tool_error instead.
    expect(r.stopReason).toBe(StopReason.TEXT);
    expect(engine.calls[1].messages.at(-1).content).toContain('DENIED BY USER');
  });

  it('remembers the full origin, scheme and port included', async () => {
    const session = { autoApprovedHosts: new Set() };
    const { loop } = makeLoop({
      script: [toolCall(), 'ok'],
      settings: { confirmBeforeSend: true },
      confirm: async () => ({ approved: true, rememberHost: true }),
      session,
    });
    await loop.run('go');
    expect([...session.autoApprovedHosts]).toEqual(['https://api.test']);
  });

  it('a plain Approve does not silently auto-approve the host', async () => {
    // "Approve" and "auto-approve this domain" are two distinct choices
    // (SPEC §7). Collapsing them would mean one approval quietly authorising
    // every later request to that host for the session.
    const confirm = vi.fn(async () => ({ approved: true }));
    const { loop, exec } = makeLoop({
      script: [toolCall(), toolCall(), 'done'],
      settings: { confirmBeforeSend: true },
      confirm,
    });
    await loop.run('go');
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(loop.getState().autoApprovedHosts).toEqual([]);
  });

  // The "URL that cannot be parsed" branch of the remember path is covered
  // directly by originOf() in security.test.js; the loop only ever sees calls
  // the parser has already validated, so there is no honest way to drive it
  // from here without a fake that proves nothing.
});

describe('agent loop — malformed tool calls', () => {
  it('repairs a malformed call on the first retry', async () => {
    const notices = [];
    const { loop, exec, engine } = makeLoop({
      script: ['```json\n{"tool": "curl", "args": {"url": broken}}\n```', toolCall(), 'ok'],
      hooks: { onNotice: (n) => notices.push(n) },
    });
    const r = await loop.run('go');
    expect(r.stopReason).toBe(StopReason.TEXT);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(notices.some((n) => /asking the model to correct it/.test(n.text))).toBe(true);
    // repair prompt was sent as an extra user turn
    expect(engine.calls[1].messages.at(-1).content).toContain('E_JSON_PARSE');
  });

  it('surfaces the raw output after a second failure and stops', async () => {
    const notices = [];
    const bad = '```json\n{"tool": "curl", "args": {"url": "ftp://nope"}}\n```';
    const { loop, exec } = makeLoop({
      script: [bad, bad],
      hooks: { onNotice: (n) => notices.push(n) },
    });
    const r = await loop.run('go');
    expect(r.stopReason).toBe(StopReason.UNPARSEABLE);
    expect(exec).not.toHaveBeenCalled();
    expect(loop.transcript.at(-1).meta.parseError.code).toBe('E_BAD_SCHEME');
    expect(notices.some((n) => n.kind === 'warning' && /could not be parsed/.test(n.text))).toBe(true);
  });

  it('accepts a repair that gives up and answers in prose', async () => {
    const { loop, exec } = makeLoop({
      script: ['```json\n{"tool": "curl", "args": {"method": "TRACE", "url": "https://a.test"}}\n```', 'I cannot do that.'],
    });
    const r = await loop.run('go');
    expect(r.stopReason).toBe(StopReason.TEXT);
    expect(exec).not.toHaveBeenCalled();
  });

  it('counts repairs in inspectable state', async () => {
    const { loop } = makeLoop({ script: ['{"tool": "curl", "args": {"url": nope}}', 'giving up'] });
    await loop.run('go');
    expect(loop.getState().repairs).toBe(1);
  });
});

describe('agent loop — cancellation and engine failure', () => {
  it('reports an engine error without crashing the turn', async () => {
    const notices = [];
    const engine = createMockEngine();
    engine.generate = async () => { throw new Error('WebGPU device lost'); };
    const loop = createAgentLoop({
      engine,
      executeTool: vi.fn(),
      formatResult: () => '',
      getSettings: () => ({ confirmBeforeSend: false, maxIterations: 5 }),
      hooks: { onNotice: (n) => notices.push(n) },
    });
    const r = await loop.run('go');
    expect(r.stopReason).toBe(StopReason.ENGINE_ERROR);
    expect(notices.at(-1).text).toContain('WebGPU device lost');
  });

  it('stops when cancelled mid-generation', async () => {
    const engine = createMockEngine({ script: ['one two three four five'], deltaMs: 20 });
    const loop = createAgentLoop({
      engine,
      executeTool: vi.fn(),
      formatResult: () => '',
      getSettings: () => ({ confirmBeforeSend: false, maxIterations: 5 }),
    });
    const run = loop.run('go');
    setTimeout(() => loop.cancel(), 25);
    expect((await run).stopReason).toBe(StopReason.CANCELLED);
  });

  it('stops before executing the tool when cancelled at the confirmation card', async () => {
    const exec = vi.fn();
    const { loop } = makeLoop({
      script: [toolCall(), 'ok'],
      settings: { confirmBeforeSend: true },
      confirm: async () => { loop.cancel(); return { approved: true }; },
      executeTool: exec,
    });
    expect((await loop.run('go')).stopReason).toBe(StopReason.CANCELLED);
    expect(exec).not.toHaveBeenCalled();
  });

  it('can run again after a cancellation', async () => {
    const engine = createMockEngine({ script: ['a b c d e'], deltaMs: 20 });
    const loop = createAgentLoop({
      engine,
      executeTool: vi.fn(),
      formatResult: () => '',
      getSettings: () => ({ confirmBeforeSend: false, maxIterations: 5 }),
    });
    const run = loop.run('go');
    setTimeout(() => loop.cancel(), 25);
    await run;
    engine.setScript(['second answer']);
    expect((await loop.run('again')).stopReason).toBe(StopReason.TEXT);
  });
});

describe('agent loop — observability', () => {
  it('emits the documented event sequence', async () => {
    const events = [];
    const record = (name) => (p) => events.push([name, p]);
    const { loop } = makeLoop({
      script: [toolCall(), 'done'],
      hooks: {
        onMessage: record('message'),
        onToolCall: record('toolCall'),
        onToolResult: record('toolResult'),
        onTurnEnd: record('turnEnd'),
        onGenerationStart: record('genStart'),
        onDelta: record('delta'),
      },
    });
    await loop.run('go');
    const names = events.map((e) => e[0]);
    expect(names.filter((n) => n === 'genStart')).toHaveLength(2);
    expect(names).toContain('delta');
    expect(names.indexOf('toolCall')).toBeLessThan(names.indexOf('toolResult'));
    expect(names.at(-1)).toBe('turnEnd');
    expect(events.at(-1)[1]).toEqual({ stopReason: StopReason.TEXT, iterations: 1 });
  });

  it('publishes state changes', async () => {
    const states = [];
    const { loop } = makeLoop({ script: [toolCall(), 'done'], hooks: { onStateChange: (s) => states.push(s) } });
    await loop.run('go');
    expect(states[0].running).toBe(true);
    expect(states.at(-1).running).toBe(false);
    expect(states.some((s) => s.iteration === 1)).toBe(true);
  });

  it('passes the abort signal and settings through to the tool executor', async () => {
    const exec = vi.fn(async () => okResult());
    const { loop } = makeLoop({ script: [toolCall(), 'ok'], executeTool: exec, settings: { timeoutMs: 1234 } });
    await loop.run('go');
    const ctx = exec.mock.calls[0][1];
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.settings.timeoutMs).toBe(1234);
  });

  it('includes credential names and the allowlist in the system prompt', async () => {
    const { loop, engine } = makeLoop({
      script: ['ok'],
      settings: { credentials: [{ name: 'GitHub', value: 'x' }], allowlist: ['api.test'] },
    });
    await loop.run('go');
    const sys = engine.calls[0].messages[0].content;
    expect(sys).toContain('{{GitHub}}');
    expect(sys).toContain('api.test');
  });

  it('reset clears the transcript and auto-approvals', async () => {
    const { loop } = makeLoop({
      script: [toolCall(), 'done'],
      settings: { confirmBeforeSend: true },
      confirm: async () => ({ approved: true, rememberHost: true }),
    });
    await loop.run('go');
    expect(loop.transcript.length).toBeGreaterThan(0);
    loop.reset();
    expect(loop.transcript).toHaveLength(0);
    expect(loop.getState().autoApprovedHosts).toEqual([]);
  });
});

describe('agent loop — the model is told names, never values', () => {
  it('passes credential names only into the system prompt', async () => {
    const { loop, engine } = makeLoop({
      script: ['ok'],
      settings: {
        credentials: [
          { name: 'GitHub', value: 'ghp_this_must_never_appear' },
          { name: 'Weather', value: 'wk_also_never' },
        ],
      },
    });
    await loop.run('go');
    const sys = engine.calls[0].messages[0].content;
    expect(sys).toContain('{{GitHub}}');
    expect(sys).toContain('{{Weather}}');
    expect(sys).not.toContain('ghp_this_must_never_appear');
    expect(sys).not.toContain('wk_also_never');
  });

  it('reports an accurate live iteration number on each tool call', async () => {
    // SPEC §8.3's live counter: the stats bar reads this directly.
    const seen = [];
    const { loop } = makeLoop({
      script: [toolCall(), toolCall(), toolCall(), 'done'],
      hooks: { onToolCall: ({ iteration }) => seen.push(iteration) },
    });
    await loop.run('go');
    expect(seen).toEqual([1, 2, 3]);
  });

  it('stops after a tool call that completed while the turn was cancelled', async () => {
    // Cancelling during the request must not let the loop carry on with the
    // result and start another iteration.
    let cancelDuring = null;
    const exec = vi.fn(async () => {
      cancelDuring?.();
      return okResult();
    });
    const { loop } = makeLoop({ script: [toolCall(), toolCall(), 'done'], executeTool: exec });
    cancelDuring = () => loop.cancel();
    const r = await loop.run('go');
    expect(r.stopReason).toBe(StopReason.CANCELLED);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
