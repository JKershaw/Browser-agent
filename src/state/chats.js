/**
 * Saved conversations, backed by `localStorage`.
 *
 * A chat is saved after every turn, so starting a new one — or closing the tab
 * — never loses the old one. The properties that matter:
 *
 * - **Nothing secret reaches storage.** A transcript holds tool results, and a
 *   tool result holds a response body that may echo a credential back (a
 *   `/headers` endpoint does exactly that). The live result object masks such
 *   values at render time, from a list it carries non-enumerably; serialising
 *   it would drop that list and keep the plaintext. So a record is redacted
 *   *before* it is written, against that list and every credential the user
 *   has stored — session-only ones included, because "never written to disk"
 *   is the promise those make.
 * - **Every write is read-modify-write.** Two tabs open on the app each hold a
 *   copy of the list; writing a whole in-memory copy back would silently drop
 *   whatever the other tab saved, or resurrect what it deleted. Each change is
 *   applied to what storage holds *now*.
 * - **A full quota costs the oldest chats, not the newest.** When a write is
 *   refused, the oldest saved chats are dropped until it fits. If even the
 *   chat being saved cannot fit on its own, it is kept in memory for the
 *   session and the user is told — the same contract as settings.
 *
 * @module state/chats
 */

import { maskHeaders, maskSecrets, stripPartialSecretTail } from '../tools/curl.js';
import { safeLocalStorage } from './settings.js';

export const CHATS_KEY = 'browser-agent.chats.v1';

/** Bump when the persisted shape changes. */
export const CHATS_VERSION = 1;

/**
 * How many chats are kept. Old ones fall off the end. A transcript with a few
 * tool results is tens of kilobytes at the default response limit, so fifty
 * fits comfortably inside a typical 5 MB origin quota with room for settings.
 */
export const MAX_CHATS = 50;

/** Longest title shown in the list before it is cut with an ellipsis. */
export const TITLE_MAX = 80;

const ROLES = new Set(['user', 'assistant', 'tool']);

let idCounter = 0;

/** @returns {string} A chat id unique within this browser. */
export function newChatId() {
  idCounter += 1;
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `chat-${Date.now().toString(36)}-${idCounter}-${random}`;
}

/**
 * A chat's title: the first thing the user asked, on one line.
 *
 * A split multi-step ask stores each step as its own user entry; the title is
 * the message as typed, not its first fragment.
 *
 * @param {Array<{role: string, content: string, meta?: object}>} transcript
 * @returns {string}
 */
export function titleFor(transcript) {
  const first = (transcript || []).find((m) => m?.role === 'user');
  if (!first) return 'Empty chat';
  const text = String(first.meta?.step?.original ?? first.content ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return 'Untitled chat';
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

/**
 * How many messages the user typed. Steps after the first of a split ask are
 * the agent working through one message, not new ones.
 *
 * @param {Array<{role: string, meta?: object}>} transcript
 * @returns {number}
 */
export function countUserMessages(transcript) {
  return (transcript || []).filter((m) => m?.role === 'user' && !(m.meta?.step?.index > 0)).length;
}

/**
 * Every secret value a transcript's live tool results know about.
 *
 * `executeCurl` attaches the substituted plaintext to `result.request.secrets`
 * non-enumerably. It is readable here, on the live objects, and nowhere once
 * they have been serialised — which is why redaction has to happen first.
 *
 * @param {Array<object>} transcript
 * @returns {string[]}
 */
export function collectSecrets(transcript) {
  const out = [];
  const take = (r) => {
    const s = r?.request?.secrets;
    if (Array.isArray(s)) out.push(...s.filter((v) => typeof v === 'string'));
  };
  for (const m of transcript || []) {
    const r = m?.meta?.result;
    if (!r) continue;
    take(r);
    if (Array.isArray(r.requests)) r.requests.forEach(take);
  }
  return out;
}

/**
 * A JSON-safe copy of `value` with every secret masked out of every string.
 *
 * Only own enumerable properties are copied, so the non-enumerable `secrets`
 * and `rawHeaders` on a curl result are dropped rather than written.
 *
 * @param {unknown} value
 * @param {string[]} secrets
 * @param {number} [depth]
 * @returns {unknown}
 */
function deepMask(value, secrets, depth = 0) {
  if (depth > 16) return null;
  if (typeof value === 'string') return maskSecrets(value, secrets);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => deepMask(v, secrets, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (v === undefined || typeof v === 'function') continue;
      out[key] = deepMask(v, secrets, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * Response-specific masking on top of `deepMask`: headers that are sensitive
 * by name (`Set-Cookie`) are masked whatever their value, and a body cut at
 * the byte limit loses any trailing *partial* secret, which a whole-string
 * match cannot see.
 *
 * @param {object} r A redacted curl result (mutated).
 * @param {string[]} secrets
 */
function maskResponse(r, secrets) {
  if (!r || typeof r !== 'object') return;
  if (r.headers && typeof r.headers === 'object') r.headers = { ...maskHeaders(r.headers, secrets) };
  if (r.truncated && typeof r.body === 'string') r.body = stripPartialSecretTail(r.body, secrets);
}

/**
 * A transcript entry as it may be written to storage.
 *
 * @param {{role: string, content: string, meta?: object}} entry
 * @param {string[]} secrets
 * @returns {{role: string, content: string, meta?: object}}
 */
export function redactEntry(entry, secrets) {
  const clean = /** @type {any} */ (deepMask(entry, secrets));
  const r = clean?.meta?.result;
  if (r) {
    maskResponse(r, secrets);
    if (Array.isArray(r.requests)) r.requests.forEach((hop) => maskResponse(hop, secrets));
  }
  return clean;
}

/**
 * Build the record to save for a conversation.
 *
 * @param {object} chat
 * @param {string} chat.id
 * @param {number} chat.createdAt
 * @param {number} chat.updatedAt
 * @param {string|null} [chat.modelId]
 * @param {Array<object>} chat.transcript The loop's live transcript.
 * @param {Array<{value?: string}>} [chat.credentials] Every stored credential,
 *   session-only included.
 * @returns {object}
 */
export function buildChatRecord({ id, createdAt, updatedAt, modelId = null, transcript, credentials = [] }) {
  const secrets = [
    ...collectSecrets(transcript),
    ...credentials.map((c) => c?.value).filter((v) => typeof v === 'string'),
  ];
  return {
    id: String(id),
    title: maskSecrets(titleFor(transcript), secrets),
    createdAt,
    updatedAt,
    modelId: modelId ? String(modelId) : null,
    transcript: transcript.map((m) => redactEntry(m, secrets)),
  };
}

/**
 * Coerce a stored record into a valid one, or null.
 *
 * Storage is shared by every script on the origin and survives across
 * versions of the app, so nothing read back is trusted to have the right
 * shape. Rendering is text-only regardless (see `ui/dom.js`).
 *
 * @param {unknown} raw
 * @returns {object|null}
 */
export function sanitizeChat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {any} */ (raw);
  if (typeof r.id !== 'string' || r.id === '') return null;
  if (!Array.isArray(r.transcript)) return null;

  const transcript = r.transcript
    .filter((m) => m && typeof m === 'object' && ROLES.has(m.role) && typeof m.content === 'string')
    .map((m) => (m.meta && typeof m.meta === 'object' && !Array.isArray(m.meta)
      ? { role: m.role, content: m.content, meta: m.meta }
      : { role: m.role, content: m.content }));
  if (transcript.length === 0) return null;

  const time = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  const updatedAt = time(r.updatedAt, time(r.createdAt, 0));
  return {
    id: r.id,
    title: typeof r.title === 'string' && r.title !== '' ? r.title : titleFor(transcript),
    createdAt: time(r.createdAt, updatedAt),
    updatedAt,
    modelId: typeof r.modelId === 'string' && r.modelId !== '' ? r.modelId : null,
    transcript,
  };
}

/**
 * The list view of a record: everything but the transcript.
 * @param {object} c
 */
function summarise(c) {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    modelId: c.modelId,
    messageCount: countUserMessages(c.transcript),
  };
}

/** Newest first. */
const byRecency = (a, b) => b.updatedAt - a.updatedAt;

/**
 * Create the chat store.
 *
 * @param {object} [opts]
 * @param {Storage} [opts.storage] Defaults to `localStorage`, or memory.
 * @param {number} [opts.maxChats]
 * @param {(msg: string) => void} [opts.onStorageError] Told once per failure run.
 * @param {(msg: string) => void} [opts.onPruned] Told when old chats were
 *   dropped to make room.
 * @returns {object}
 */
export function createChatStore(opts = {}) {
  const storage = opts.storage ?? safeLocalStorage();
  const maxChats = Math.max(1, Math.floor(opts.maxChats ?? MAX_CHATS));
  const onStorageError = opts.onStorageError;
  const onPruned = opts.onPruned;

  /** @type {Set<Function>} */
  const listeners = new Set();
  /** Set once a write has failed outright; cleared by the next success. */
  let broken = false;
  /** @type {Array<object>} Last known list, newest first. */
  let chats = read() ?? [];

  /**
   * What storage holds right now, or null when it cannot be read — in which
   * case the in-memory list is the only copy and is used as-is.
   * @returns {Array<object>|null}
   */
  function read() {
    let raw;
    try {
      raw = storage.getItem(CHATS_KEY);
    } catch {
      return null;
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.chats) ? parsed.chats : [];
      return list.map(sanitizeChat).filter(Boolean).sort(byRecency).slice(0, maxChats);
    } catch {
      // Corrupt JSON: treat as empty rather than refusing to boot. The next
      // save overwrites it.
      return [];
    }
  }

  /**
   * Write `list`, dropping the oldest entries until it fits. `keepId` is the
   * chat just saved, which is never the one sacrificed.
   *
   * @param {Array<object>} list Newest first.
   * @returns {Array<object>} What is now the authoritative list.
   */
  function write(list, keepId) {
    let attempt = list;
    for (;;) {
      try {
        storage.setItem(CHATS_KEY, JSON.stringify({ version: CHATS_VERSION, chats: attempt }));
        broken = false;
        const dropped = list.length - attempt.length;
        if (dropped > 0) {
          onPruned?.(`Browser storage is full, so the ${dropped === 1 ? 'oldest saved chat was' : `${dropped} oldest saved chats were`} removed to make room.`);
        }
        return attempt;
      } catch (e) {
        // Only a save prunes. A removal that fails has nothing to gain from
        // deleting more, and must not turn into deleting everything.
        const droppable = keepId === null ? [] : attempt.filter((c) => c.id !== keepId);
        if (droppable.length === 0) {
          if (!broken) {
            broken = true;
            onStorageError?.(`Chats could not be saved (${e?.message || e}). This one is kept until you close the tab.`);
          }
          // Memory keeps everything; storage keeps whatever it last accepted.
          return list;
        }
        const oldest = droppable[droppable.length - 1];
        attempt = attempt.filter((c) => c !== oldest);
      }
    }
  }

  /**
   * Apply a change to the current stored list and save it.
   * @param {(list: Array<object>) => Array<object>} change
   * @param {string|null} [keepId]
   */
  function mutate(change, keepId = null) {
    const base = broken ? chats : (read() ?? chats);
    const next = change([...base]).sort(byRecency).slice(0, maxChats);
    chats = write(next, keepId);
    notify();
  }

  function notify() {
    for (const fn of listeners) fn();
  }

  return {
    /** @returns {Array<object>} Summaries, newest first. */
    list: () => chats.map(summarise),

    /**
     * @param {string} id
     * @returns {object|null} The full record, transcript included.
     */
    get(id) {
      const found = chats.find((c) => c.id === id) ?? (read() ?? []).find((c) => c.id === id);
      return found ? structuredCloneSafe(found) : null;
    },

    /**
     * Insert or replace a chat.
     * @param {object} record Output of `buildChatRecord`.
     * @returns {boolean} Whether it was accepted.
     */
    save(record) {
      const clean = sanitizeChat(record);
      if (!clean) return false;
      mutate((list) => [clean, ...list.filter((c) => c.id !== clean.id)], clean.id);
      return true;
    },

    /** @param {string} id */
    remove(id) {
      mutate((list) => list.filter((c) => c.id !== id));
    },

    /** Delete every saved chat. */
    clear() {
      try {
        storage.removeItem(CHATS_KEY);
        broken = false;
      } catch {
        /* storage unavailable; the in-memory clear still applies */
      }
      chats = [];
      notify();
    },

    /** Re-read storage — after another tab changed it. */
    refresh() {
      const fresh = read();
      if (fresh) chats = fresh;
      notify();
    },

    /** Whether the last write reached storage. */
    storageWorking: () => !broken,

    /**
     * @param {() => void} fn
     * @returns {() => void} Unsubscribe.
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** A deep copy, so a caller mutating a restored transcript cannot edit the store. */
function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}
