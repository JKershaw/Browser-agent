import { describe, it, expect, vi } from 'vitest';
import {
  CHATS_KEY,
  MAX_CHATS,
  TITLE_MAX,
  buildChatRecord,
  collectSecrets,
  countUserMessages,
  createChatStore,
  newChatId,
  redactEntry,
  sanitizeChat,
  titleFor,
} from '../../src/state/chats.js';
import { createMemoryStorage } from '../../src/state/settings.js';
import { MASK } from '../../src/tools/curl.js';
import { createApp } from '../../src/app.js';
import { createMockEngine } from '../../src/llm/mock.js';

const user = (content, meta) => ({ role: 'user', content, ...(meta ? { meta } : {}) });
const assistant = (content, meta) => ({ role: 'assistant', content, ...(meta ? { meta } : {}) });

/** A record as the app would build it, with a controllable timestamp. */
const record = (id, updatedAt, text = `question ${id}`) => buildChatRecord({
  id,
  createdAt: updatedAt,
  updatedAt,
  transcript: [user(text), assistant(`answer ${id}`)],
});

/** A live curl result, with its secrets attached non-enumerably as curl.js does. */
function liveResult({ body, headers = {}, secrets = [], truncated = false }) {
  const request = { method: 'GET', url: 'https://api.test/x', headers: {} };
  Object.defineProperty(request, 'secrets', { value: secrets, enumerable: false });
  Object.defineProperty(request, 'rawHeaders', { value: { Authorization: `Bearer ${secrets[0]}` }, enumerable: false });
  return { ok: true, status: 200, statusText: 'OK', headers, body, truncated, maxBytes: 8192, elapsedMs: 5, request };
}

describe('titleFor', () => {
  it('uses the first user message, on one line', () => {
    expect(titleFor([user('what is\n  the   weather?'), assistant('rain')])).toBe('what is the weather?');
  });

  it('uses the message as typed for a split multi-step ask', () => {
    const original = 'fetch A, then fetch B';
    expect(titleFor([user('fetch A', { step: { index: 0, total: 2, original } })])).toBe(original);
  });

  it('cuts long titles with an ellipsis', () => {
    const t = titleFor([user('x'.repeat(500))]);
    expect(t).toHaveLength(TITLE_MAX);
    expect(t.endsWith('…')).toBe(true);
  });

  it('names an empty or blank chat', () => {
    expect(titleFor([])).toBe('Empty chat');
    expect(titleFor([user('   ')])).toBe('Untitled chat');
  });
});

describe('countUserMessages', () => {
  it('counts what the user typed, not the steps the agent split it into', () => {
    const original = 'a, then b';
    expect(countUserMessages([
      user('a', { step: { index: 0, total: 2, original } }),
      assistant('ok'),
      user('b', { step: { index: 1, total: 2, original } }),
      assistant('ok'),
      user('thanks'),
    ])).toBe(2);
  });
});

describe('newChatId', () => {
  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newChatId()));
    expect(ids.size).toBe(200);
  });
});

describe('redaction before storage', () => {
  it('collects the secrets live results carry, including each wiki hop', () => {
    const wiki = { ok: true, tool: 'wiki', requests: [liveResult({ body: '', secrets: ['hop-secret'] })] };
    expect(collectSecrets([
      { role: 'tool', content: 'x', meta: { result: liveResult({ body: '', secrets: ['abc123'] }) } },
      { role: 'tool', content: 'y', meta: { result: wiki } },
      user('no result here'),
    ])).toEqual(['abc123', 'hop-secret']);
  });

  it('masks a secret echoed in a response body, and drops the non-enumerable fields', () => {
    const SECRET = 'tok_live_must_not_persist';
    const entry = {
      role: 'tool',
      content: 'TOOL RESULT …',
      meta: { result: liveResult({ body: `{"auth":"Bearer ${SECRET}"}`, secrets: [SECRET] }) },
    };
    const clean = redactEntry(entry, [SECRET]);
    const json = JSON.stringify(clean);
    expect(json).not.toContain(SECRET);
    expect(clean.meta.result.body).toContain(MASK);
    expect(json).not.toContain('rawHeaders');
    expect(clean.meta.result.request.secrets).toBeUndefined();
  });

  it('masks sensitive response headers by name, whatever they hold', () => {
    const clean = redactEntry({
      role: 'tool',
      content: '',
      meta: { result: liveResult({ body: '', headers: { 'set-cookie': 'session=zzz', 'content-type': 'text/plain' } }) },
    }, []);
    expect(clean.meta.result.headers['set-cookie']).toBe(MASK);
    expect(clean.meta.result.headers['content-type']).toBe('text/plain');
  });

  it('cuts a partial secret at the end of a truncated body', () => {
    const SECRET = 'abcdefghijkl';
    const clean = redactEntry({
      role: 'tool',
      content: '',
      meta: { result: liveResult({ body: 'data: abcdefg', secrets: [SECRET], truncated: true }) },
    }, [SECRET]);
    expect(clean.meta.result.body).not.toContain('abcdefg');
  });

  it('masks every stored credential value anywhere in the record, title included', () => {
    const rec = buildChatRecord({
      id: 'c1',
      createdAt: 1,
      updatedAt: 2,
      transcript: [user('my token is sess-only-value, keep it'), assistant('noted sess-only-value')],
      credentials: [{ name: 'S', value: 'sess-only-value', sessionOnly: true }],
    });
    const json = JSON.stringify(rec);
    expect(json).not.toContain('sess-only-value');
    expect(rec.title).toContain(MASK);
  });

  it('copies only JSON-safe values', () => {
    const clean = redactEntry({ role: 'user', content: 'x', meta: { n: Infinity, f: () => 1, u: undefined, ok: true } }, []);
    expect(clean.meta).toEqual({ n: null, ok: true });
  });
});

describe('sanitizeChat', () => {
  it('rejects what cannot be a chat', () => {
    expect(sanitizeChat(null)).toBeNull();
    expect(sanitizeChat({ id: '', transcript: [] })).toBeNull();
    expect(sanitizeChat({ id: 'x', transcript: 'nope' })).toBeNull();
    expect(sanitizeChat({ id: 'x', transcript: [{ role: 'system', content: 'evil' }] })).toBeNull();
  });

  it('keeps valid entries, drops invalid ones, and fills in what is missing', () => {
    const c = sanitizeChat({
      id: 'x',
      transcript: [user('hi'), { role: 'user', content: 42 }, assistant('yo', ['not', 'an', 'object'])],
    });
    expect(c.transcript).toEqual([user('hi'), assistant('yo')]);
    expect(c.title).toBe('hi');
    expect(c.modelId).toBeNull();
    expect(c.updatedAt).toBe(0);
  });
});

describe('createChatStore', () => {
  it('saves, lists newest first, and reads a chat back', () => {
    const store = createChatStore({ storage: createMemoryStorage() });
    store.save(record('a', 100));
    store.save(record('b', 200));
    expect(store.list().map((c) => c.id)).toEqual(['b', 'a']);
    expect(store.list()[0]).toMatchObject({ title: 'question b', messageCount: 1 });
    expect(store.get('a').transcript[1].content).toBe('answer a');
    expect(store.get('missing')).toBeNull();
  });

  it('replaces a chat saved again under the same id', () => {
    const store = createChatStore({ storage: createMemoryStorage() });
    store.save(record('a', 100, 'first'));
    store.save(record('a', 300, 'first, longer now'));
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].title).toBe('first, longer now');
  });

  it('survives a reload', () => {
    const storage = createMemoryStorage();
    createChatStore({ storage }).save(record('a', 100));
    expect(createChatStore({ storage }).list().map((c) => c.id)).toEqual(['a']);
  });

  it('hands out copies, so editing a restored transcript cannot edit the store', () => {
    const store = createChatStore({ storage: createMemoryStorage() });
    store.save(record('a', 100));
    store.get('a').transcript.push(user('sneaky'));
    expect(store.get('a').transcript).toHaveLength(2);
  });

  it('keeps only the newest MAX_CHATS', () => {
    const store = createChatStore({ storage: createMemoryStorage(), maxChats: 3 });
    for (let i = 1; i <= 5; i += 1) store.save(record(`c${i}`, i));
    expect(store.list().map((c) => c.id)).toEqual(['c5', 'c4', 'c3']);
    expect(MAX_CHATS).toBeGreaterThanOrEqual(10);
  });

  it('removes one chat, or all of them', () => {
    const storage = createMemoryStorage();
    const store = createChatStore({ storage });
    store.save(record('a', 1));
    store.save(record('b', 2));
    store.remove('a');
    expect(store.list().map((c) => c.id)).toEqual(['b']);
    store.clear();
    expect(store.list()).toEqual([]);
    expect(storage.getItem(CHATS_KEY)).toBeNull();
  });

  it('refuses a record that is not a chat', () => {
    const store = createChatStore({ storage: createMemoryStorage() });
    expect(store.save({ id: 'x', transcript: [] })).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('notifies subscribers on every change', () => {
    const store = createChatStore({ storage: createMemoryStorage() });
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.save(record('a', 1));
    store.remove('a');
    store.clear();
    store.refresh();
    expect(fn).toHaveBeenCalledTimes(4);
    off();
    store.save(record('b', 2));
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('treats corrupt storage as empty instead of failing to start', () => {
    const storage = createMemoryStorage();
    storage.setItem(CHATS_KEY, '{not json');
    expect(createChatStore({ storage }).list()).toEqual([]);
  });

  it('does not lose a chat another tab saved in the meantime', () => {
    // Two tabs share one storage. Writing either tab's in-memory copy back
    // wholesale would drop the other's chat.
    const storage = createMemoryStorage();
    const tabA = createChatStore({ storage });
    const tabB = createChatStore({ storage });
    tabA.save(record('from-a', 1));
    tabB.save(record('from-b', 2));
    expect(tabB.list().map((c) => c.id).sort()).toEqual(['from-a', 'from-b']);
    tabA.save(record('from-a', 3));
    expect(tabA.list().map((c) => c.id).sort()).toEqual(['from-a', 'from-b']);
  });

  it('does not resurrect a chat another tab deleted', () => {
    const storage = createMemoryStorage();
    const tabA = createChatStore({ storage });
    tabA.save(record('doomed', 1));
    const tabB = createChatStore({ storage });
    tabA.remove('doomed');
    tabB.save(record('other', 2));
    expect(tabB.list().map((c) => c.id)).toEqual(['other']);
  });

  it('picks up another tab\'s changes on refresh', () => {
    const storage = createMemoryStorage();
    const tabA = createChatStore({ storage });
    const tabB = createChatStore({ storage });
    tabA.save(record('a', 1));
    expect(tabB.list()).toEqual([]);
    tabB.refresh();
    expect(tabB.list().map((c) => c.id)).toEqual(['a']);
  });

  it('drops the oldest chats, never the new one, when storage is full', () => {
    const inner = createMemoryStorage();
    let limit = Infinity;
    const storage = {
      getItem: (k) => inner.getItem(k),
      removeItem: (k) => inner.removeItem(k),
      setItem: (k, v) => {
        if (v.length > limit) throw new Error('QuotaExceededError');
        inner.setItem(k, v);
      },
    };
    const onPruned = vi.fn();
    const store = createChatStore({ storage, onPruned });
    store.save(record('old', 1));
    store.save(record('mid', 2));
    limit = inner.getItem(CHATS_KEY).length + 10; // room for two, not three
    store.save(record('new', 3));
    expect(store.list().map((c) => c.id)).toEqual(['new', 'mid']);
    expect(onPruned).toHaveBeenCalledWith(expect.stringContaining('oldest saved chat was removed'));
    expect(createChatStore({ storage }).list().map((c) => c.id)).toEqual(['new', 'mid']);
  });

  it('keeps a chat in memory, and says so once, when even it alone cannot be saved', () => {
    const storage = { getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error('QuotaExceededError'); } };
    const onStorageError = vi.fn();
    const store = createChatStore({ storage, onStorageError });
    store.save(record('a', 1));
    store.save(record('b', 2));
    expect(store.list().map((c) => c.id)).toEqual(['b', 'a']);
    expect(store.get('a')).not.toBeNull();
    expect(store.storageWorking()).toBe(false);
    expect(onStorageError).toHaveBeenCalledTimes(1);
    expect(onStorageError.mock.calls[0][0]).toContain('kept until you close the tab');
  });

  it('works on memory alone when storage cannot even be read', () => {
    const storage = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); }, removeItem: () => { throw new Error('SecurityError'); } };
    const store = createChatStore({ storage, onStorageError: () => {} });
    store.save(record('a', 1));
    expect(store.list().map((c) => c.id)).toEqual(['a']);
    store.clear();
    expect(store.list()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * the app's conversation lifecycle
 * ------------------------------------------------------------------ */

const okResponse = (body = '{"ok":true}') => ({
  status: 200,
  statusText: 'OK',
  url: '',
  redirected: false,
  headers: { forEach(fn) { fn('application/json', 'content-type'); } },
  async text() { return body; },
});

function makeApp({ script = ['hello'], storage = createMemoryStorage(), fetchImpl, confirm, hooks, now } = {}) {
  const engine = createMockEngine({ script });
  const app = createApp({
    storage,
    engine,
    fetchImpl: fetchImpl || (async () => okResponse()),
    confirm: confirm || (async () => ({ approved: true })),
    hooks,
    now,
  });
  return { app, engine, storage };
}

describe('createApp — chats', () => {
  it('saves the conversation after every turn', async () => {
    const { app } = makeApp({ script: ['one', 'two'] });
    await app.loop.run('first');
    expect(app.chats.list()).toHaveLength(1);
    expect(app.chats.list()[0]).toMatchObject({ id: app.currentChatId(), title: 'first', messageCount: 1 });
    await app.loop.run('second');
    expect(app.chats.list()).toHaveLength(1);
    expect(app.chats.list()[0].messageCount).toBe(2);
  });

  it('records the model in use', async () => {
    const { app } = makeApp();
    await app.engine.load('Qwen3-0.6B-q4f16_1-MLC');
    await app.loop.run('hi');
    expect(app.chats.list()[0].modelId).toBe('Qwen3-0.6B-q4f16_1-MLC');
  });

  it('starts a new chat with an empty transcript, keeping the old one saved', async () => {
    const { app } = makeApp();
    await app.loop.run('first');
    const firstId = app.currentChatId();

    const { savedPrevious } = await app.newChat();
    expect(savedPrevious).toBe(true);
    expect(app.loop.transcript).toHaveLength(0);
    expect(app.currentChatId()).not.toBe(firstId);
    expect(app.chats.list().map((c) => c.id)).toEqual([firstId]);
  });

  it('does not save an empty chat', async () => {
    const { app } = makeApp();
    expect((await app.newChat()).savedPrevious).toBe(false);
    expect(app.chats.list()).toEqual([]);
  });

  it('forgets auto-approved hosts when a new chat starts', async () => {
    const toolCall = '```json\n' + JSON.stringify({ tool: 'curl', args: { method: 'GET', url: 'https://api.test/x', headers: {}, body: null } }) + '\n```';
    const { app } = makeApp({ script: [toolCall, 'done'], confirm: async () => ({ approved: true, rememberHost: true }) });
    await app.loop.run('go');
    expect(app.loop.getState().autoApprovedHosts).toEqual(['https://api.test']);
    await app.newChat();
    expect(app.loop.getState().autoApprovedHosts).toEqual([]);
  });

  it('reopens a saved chat, and the model sees it on the next message', async () => {
    const { app, engine } = makeApp({ script: ['answer'] });
    await app.loop.run('remember the word kumquat');
    const firstId = app.currentChatId();
    await app.newChat();
    await app.loop.run('unrelated');

    const rec = await app.openChat(firstId);
    expect(rec.title).toBe('remember the word kumquat');
    expect(app.currentChatId()).toBe(firstId);
    expect(app.loop.transcript.map((m) => m.content)).toEqual(['remember the word kumquat', 'answer']);
    // The chat left behind was saved on the way out.
    expect(app.chats.list()).toHaveLength(2);

    await app.loop.run('what was the word?');
    const sent = engine.calls.at(-1).messages.map((m) => m.content).join('\n');
    expect(sent).toContain('kumquat');
    expect(sent).not.toContain('unrelated');
    // Carrying on updates the reopened chat rather than creating another.
    expect(app.chats.list()).toHaveLength(2);
    expect(app.chats.list()[0]).toMatchObject({ id: firstId, messageCount: 2 });
  });

  it('returns null for a chat that is gone, and leaves the conversation alone', async () => {
    const { app } = makeApp();
    await app.loop.run('keep me');
    expect(await app.openChat('nope')).toBeNull();
    expect(app.loop.transcript).toHaveLength(2);
  });

  it('cancels a running turn before switching, so its events land on the old chat', async () => {
    let release;
    const { app } = makeApp();
    app.engine.generate = (_m, opts) => new Promise((resolve, reject) => {
      release = resolve;
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
    const turn = app.loop.run('slow one');
    await Promise.resolve();
    expect(app.loop.getState().running).toBe(true);

    const { savedPrevious } = await app.newChat();
    expect(savedPrevious).toBe(true);
    expect(app.loop.getState().running).toBe(false);
    expect(app.loop.transcript).toHaveLength(0);
    expect((await turn).stopReason).toBe('cancelled');
    // Nothing from the cancelled turn leaked into the new conversation.
    expect(app.loop.transcript).toHaveLength(0);
    expect(app.chats.list()[0].title).toBe('slow one');
    expect(release).toBeTypeOf('function');
  });

  it('deleting the chat on screen clears it, so the next turn does not save it again', async () => {
    const { app } = makeApp();
    await app.loop.run('delete me');
    const id = app.currentChatId();
    const { wasCurrent } = await app.deleteChat(id);
    expect(wasCurrent).toBe(true);
    expect(app.loop.transcript).toHaveLength(0);
    expect(app.currentChatId()).not.toBe(id);
    await app.loop.run('fresh');
    expect(app.chats.list().map((c) => c.title)).toEqual(['fresh']);
  });

  it('deleting another chat leaves the one on screen alone', async () => {
    const { app } = makeApp();
    await app.loop.run('old');
    const oldId = app.currentChatId();
    await app.newChat();
    await app.loop.run('current');
    expect((await app.deleteChat(oldId)).wasCurrent).toBe(false);
    expect(app.loop.transcript).toHaveLength(2);
    expect(app.chats.list().map((c) => c.title)).toEqual(['current']);
  });

  it('deletes every chat, including the one on screen', async () => {
    const { app } = makeApp();
    await app.loop.run('a');
    await app.newChat();
    await app.loop.run('b');
    await app.deleteAllChats();
    expect(app.chats.list()).toEqual([]);
    expect(app.loop.transcript).toHaveLength(0);
  });

  it('persists chats in the storage it was given', async () => {
    const storage = createMemoryStorage();
    const { app } = makeApp({ storage });
    await app.loop.run('survive a reload');
    const again = makeApp({ storage }).app;
    expect(again.chats.list().map((c) => c.title)).toEqual(['survive a reload']);
  });

  it('never writes a credential to storage, even when the response echoes it back', async () => {
    const SECRET = 'tok_echoed_back_by_the_server';
    const SESSION = 'session_only_value_xyz';
    const call = '```json\n' + JSON.stringify({
      tool: 'curl',
      args: { method: 'GET', url: 'https://api.test/headers', headers: { Authorization: 'Bearer {{Tok}}', 'X-S': '{{Sess}}' }, body: null },
    }) + '\n```';
    // An endpoint like httpbin's /headers: the request's own headers, returned.
    const fetchImpl = async (_url, init) => ({
      status: 200,
      statusText: 'OK',
      url: '',
      redirected: false,
      headers: { forEach(fn) { fn(`token=${init.headers.Authorization}`, 'set-cookie'); fn('application/json', 'content-type'); } },
      async text() { return JSON.stringify({ headers: init.headers }); },
    });
    const storage = createMemoryStorage();
    const { app } = makeApp({ script: [call, 'done'], storage, fetchImpl });
    app.settings.addCredential({ name: 'Tok', value: SECRET });
    app.settings.addCredential({ name: 'Sess', value: SESSION, sessionOnly: true });

    await app.loop.run('show me my headers');

    const stored = storage.getItem(CHATS_KEY);
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(SESSION);
    // The record is still useful: the reopened card has the response.
    const rec = app.chats.get(app.currentChatId());
    const tool = rec.transcript.find((m) => m.role === 'tool');
    expect(tool.meta.result.status).toBe(200);
    expect(tool.meta.result.body).toContain(MASK);
    expect(tool.meta.result.headers['set-cookie']).toBe(MASK);
  });

  it('reports a chat that could not be saved as a notice in the conversation', async () => {
    const onNotice = vi.fn();
    const storage = {
      getItem: () => null,
      removeItem: () => {},
      setItem: (k) => { if (k === CHATS_KEY) throw new Error('QuotaExceededError'); },
    };
    const { app } = makeApp({ storage, hooks: { onNotice } });
    await app.loop.run('hi');
    expect(onNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning', text: expect.stringContaining('Chats could not be saved') }));
    // Still reopenable for this session.
    expect(app.chats.list()).toHaveLength(1);
  });

  it('puts chat-store problems in the start-up notices when there are no hooks', async () => {
    const storage = { getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error('nope'); } };
    const app = createApp({ storage, engine: createMockEngine({ script: ['x'] }) });
    await app.loop.run('hi');
    expect(app.notices.some((n) => n.text.includes('Chats could not be saved'))).toBe(true);
  });

  it('stamps saved chats with the injected clock', async () => {
    let t = 1_000;
    const { app } = makeApp({ now: () => t });
    await app.loop.run('hi');
    t = 5_000;
    await app.loop.run('again');
    expect(app.chats.list()[0]).toMatchObject({ createdAt: 1_000, updatedAt: 5_000 });
  });
});
