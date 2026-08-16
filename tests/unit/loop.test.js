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

describe('agent loop — repeating a request that already failed', () => {
  const failed = (retryUrl) => ({
    ok: false,
    error: { kind: 'network', message: 'The browser refused it.', ...(retryUrl ? { retryUrl } : {}) },
    elapsedMs: 1,
  });

  it('does not send the same failing request twice', async () => {
    // Six of eleven failures in one measured run were an identical URL re-sent
    // until the iteration cap, and the reported bug from a real user was the
    // same URL sent twice with a third under way.
    const exec = vi.fn(async () => failed());
    const { loop } = makeLoop({
      script: [toolCall('https://blocked.test/page'), toolCall('https://blocked.test/page'), 'giving up'],
      executeTool: exec,
    });

    const r = await loop.run('fetch it');

    expect(exec).toHaveBeenCalledTimes(1);
    expect(r.stopReason).toBe(StopReason.TEXT);
    const notSent = r.transcript.filter((m) => m.role === 'tool' && m.content.includes('NOT SENT'));
    expect(notSent).toHaveLength(1);
  });

  it('names the working URL in the refusal when there is one', async () => {
    const exec = vi.fn(async () => failed('https://en.wikipedia.org/api/rest_v1/page/summary/Alan_Turing'));
    const { loop } = makeLoop({
      script: [toolCall('https://wikipedia.org/wiki/Alan_Turing'), toolCall('https://wikipedia.org/wiki/Alan_Turing'), 'ok'],
      executeTool: exec,
    });

    const r = await loop.run('look it up');
    const message = r.transcript.find((m) => m.role === 'tool' && m.content.includes('NOT SENT'));
    // Last line and imperative, like every other remedy in this project.
    expect(message.content.trim().split('\n').pop()).toBe(
      'NEXT STEP: call the tool again with exactly this URL: https://en.wikipedia.org/api/rest_v1/page/summary/Alan_Turing'
    );
  });

  it('still lets a different URL through after one fails', async () => {
    const exec = vi.fn(async (call) =>
      call.args.url.includes('blocked') ? failed() : okResult('good')
    );
    const { loop } = makeLoop({
      script: [toolCall('https://blocked.test/a'), toolCall('https://fine.test/b'), 'done'],
      executeTool: exec,
    });

    await loop.run('go');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('allows a repeat of a request that succeeded', async () => {
    // Only transport failures are remembered. Re-reading a resource is a
    // legitimate thing to want, and blocking it would be the tool second-
    // guessing the model about something it got right.
    const exec = vi.fn(async () => okResult());
    const { loop } = makeLoop({
      script: [toolCall('https://fine.test/a'), toolCall('https://fine.test/a'), 'done'],
      executeTool: exec,
    });

    await loop.run('go');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('allows a repeat after an HTTP error, which is a real answer', async () => {
    // A 503 clears; a 429 stops rate-limiting. A reachable server saying no is
    // not the same as a request that never arrived.
    const exec = vi.fn(async () => ({ ...okResult('rate limited'), status: 429 }));
    const { loop } = makeLoop({
      script: [toolCall('https://fine.test/a'), toolCall('https://fine.test/a'), 'done'],
      executeTool: exec,
    });

    await loop.run('go');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('does not spend the user\'s iteration budget on a request it refused to send', async () => {
    const exec = vi.fn(async () => failed());
    const { loop } = makeLoop({
      script: [toolCall('https://blocked.test/a'), toolCall('https://blocked.test/a'), 'done'],
      executeTool: exec,
    });

    const r = await loop.run('go');
    // One request was actually sent, so one iteration was actually used.
    expect(r.iterations).toBe(1);
  });

  it('does not ask the user to approve a request it will not send', async () => {
    const confirm = vi.fn(async () => ({ approved: true }));
    const exec = vi.fn(async () => failed());
    const { loop } = makeLoop({
      script: [toolCall('https://blocked.test/a'), toolCall('https://blocked.test/a'), 'done'],
      settings: { confirmBeforeSend: true },
      confirm,
      executeTool: exec,
    });

    await loop.run('go');
    // Spending the user's attention on a decision that cannot matter teaches
    // them to approve without reading.
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('nudges from the second identical success onward, but still sends', async () => {
    // A holdout sample fetched the same URL four times, each a success, and
    // ran out of iterations instead of answering. The repeat is sent — the
    // model may mean it — but from the second success the result ends with the
    // instruction to answer.
    const exec = vi.fn(async () => okResult());
    const { loop } = makeLoop({
      script: [toolCall('https://fine.test/a'), toolCall('https://fine.test/a'), toolCall('https://fine.test/a'), 'done'],
      executeTool: exec,
    });

    const r = await loop.run('go');

    expect(exec).toHaveBeenCalledTimes(3);
    const tools = r.transcript.filter((m) => m.role === 'tool');
    expect(tools[0].content).not.toContain('REPEAT:');
    expect(tools[1].content).toContain('you have now sent this exact request 2 times');
    expect(tools[2].content).toContain('you have now sent this exact request 3 times');
    // Last line and imperative, like every other remedy in this project.
    expect(tools[1].content.trim().split('\n').pop()).toBe(
      'NEXT STEP: answer the user in plain prose using the response above. Do not send this request again.'
    );
  });

  it('places the nudge after truncation, so it survives a huge response', async () => {
    const exec = vi.fn(async () => okResult('x'.repeat(50_000)));
    const { loop } = makeLoop({
      script: [toolCall('https://fine.test/a'), toolCall('https://fine.test/a'), 'done'],
      executeTool: exec,
      settings: { maxBytes: 1000 },
    });

    const r = await loop.run('go');
    const second = r.transcript.filter((m) => m.role === 'tool')[1];
    expect(second.content.trim().split('\n').pop()).toContain('NEXT STEP: answer the user');
  });

  it('does not nudge distinct successes', async () => {
    const { loop } = makeLoop({
      script: [toolCall('https://fine.test/a'), toolCall('https://fine.test/b'), 'done'],
    });

    const r = await loop.run('go');
    for (const m of r.transcript.filter((t) => t.role === 'tool')) {
      expect(m.content).not.toContain('REPEAT:');
    }
  });

  it('does not nudge a retry that follows a failure', async () => {
    // First send fails, second (different URL) succeeds: no nudge anywhere —
    // the success count starts at the first success, not the first attempt.
    const exec = vi.fn(async (call) =>
      call.args.url.includes('dead') ? failed() : okResult()
    );
    const { loop } = makeLoop({
      script: [toolCall('https://dead.test/a'), toolCall('https://fine.test/a'), 'done'],
      executeTool: exec,
    });

    const r = await loop.run('go');
    for (const m of r.transcript.filter((t) => t.role === 'tool')) {
      expect(m.content).not.toContain('REPEAT:');
    }
  });

  it('forgets successes between turns', async () => {
    // "Fetch it again" in a new turn is a fresh instruction from the user, not
    // a loop. The memory is per turn, same as the failure map.
    const { loop } = makeLoop({
      script: [toolCall('https://fine.test/a'), 'done', toolCall('https://fine.test/a'), 'done again'],
    });

    await loop.run('first');
    const r = await loop.run('second');
    for (const m of r.transcript.filter((t) => t.role === 'tool')) {
      expect(m.content).not.toContain('REPEAT:');
    }
  });

  it('forgets failures between turns', async () => {
    // A network that was down a minute ago may be up now. The memory is per
    // turn, because that is the span in which repeating is certainly useless.
    const exec = vi.fn(async () => failed());
    const { loop } = makeLoop({
      script: [toolCall('https://blocked.test/a'), 'gave up', toolCall('https://blocked.test/a'), 'gave up again'],
      executeTool: exec,
    });

    await loop.run('first');
    await loop.run('second');
    expect(exec).toHaveBeenCalledTimes(2);
  });
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

describe('agent loop — multi-step asks (the chain-driver)', () => {
  const CHAIN = 'Fetch http://a.test/one for the city please, then look that city up on Wikipedia please.';

  it('runs a split ask as sequential user turns in one transcript', async () => {
    const { loop, exec } = makeLoop({
      script: [toolCall('http://a.test/one'), 'The city is Bristol.', toolCall('http://a.test/two'), 'It is in the United Kingdom.'],
    });
    const r = await loop.run(CHAIN);

    expect(r.stopReason).toBe(StopReason.TEXT);
    expect(exec).toHaveBeenCalledTimes(2);

    const users = loop.transcript.filter((m) => m.role === 'user' && !m.content.startsWith('TOOL RESULT'));
    expect(users).toHaveLength(2);
    expect(users[0].content).toBe('Fetch http://a.test/one for the city please');
    expect(users[1].content).toBe('look that city up on Wikipedia please.');
    // The final answer is the last message, after both steps.
    expect(loop.transcript.at(-1).content).toBe('It is in the United Kingdom.');
  });

  it('marks each step with its place in the plan and the original text', async () => {
    const { loop } = makeLoop({ script: ['Step one done.', 'Step two done.'] });
    await loop.run(CHAIN);
    const users = loop.transcript.filter((m) => m.role === 'user');
    expect(users[0].meta.step).toEqual({ index: 0, total: 2, original: CHAIN });
    expect(users[1].meta.step).toEqual({ index: 1, total: 2, original: CHAIN });
  });

  it('attaches no step meta to a single-step ask', async () => {
    const { loop } = makeLoop({ script: ['done'] });
    await loop.run('What is the capital of France?');
    const users = loop.transcript.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].meta).toBeUndefined();
  });

  it('shares one tool budget across steps, keeping the system prompt honest', async () => {
    // The system prompt promises "at most N tool calls for one user message";
    // splitting must not quietly raise N. With a budget of 1, the second
    // step's tool call caps the turn.
    const { loop, exec } = makeLoop({
      script: [toolCall('http://a.test/one'), 'one done.', toolCall('http://a.test/two'), 'never reached'],
      settings: { maxIterations: 1 },
    });
    const r = await loop.run(CHAIN);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(r.stopReason).toBe(StopReason.CAP);
  });

  it('does not run later steps after a non-text stop', async () => {
    const engineError = () => {
      throw new Error('engine died');
    };
    const { loop } = makeLoop({ script: [engineError, 'never reached'] });
    const r = await loop.run(CHAIN);
    expect(r.stopReason).toBe(StopReason.ENGINE_ERROR);
    const users = loop.transcript.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
  });

  it('emits onTurnEnd exactly once for a split ask', async () => {
    const ends = [];
    const { loop } = makeLoop({
      script: ['Step one done.', 'Step two done.'],
      hooks: { onTurnEnd: (e) => ends.push(e) },
    });
    await loop.run(CHAIN);
    expect(ends).toHaveLength(1);
    expect(ends[0].stopReason).toBe(StopReason.TEXT);
  });

  it('resets the failed-request memory between steps of one ask', async () => {
    // Per-step, as before the split existed: each step is its own turn from
    // the loop-protection point of view, and a URL that failed in step one
    // may legitimately be retried in step two.
    const exec = vi.fn(async () => ({
      ok: false,
      status: 0,
      error: { code: 'E_NETWORK', message: 'refused' },
      elapsedMs: 1,
    }));
    const { loop } = makeLoop({
      script: [toolCall('http://a.test/one'), 'gave up on one.', toolCall('http://a.test/one'), 'gave up again.'],
      executeTool: exec,
    });
    const r = await loop.run(CHAIN);
    expect(r.stopReason).toBe(StopReason.TEXT);
    // Both sends actually went out — the second step was not blocked by the
    // first step's failure memory.
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
