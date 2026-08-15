/**
 * Settings store, backed by `localStorage`.
 *
 * Two deliberate properties:
 * - **Session-only credentials never touch storage.** They live in a memory
 *   map and vanish on reload; that is the whole point of the option.
 * - **Storage failures are non-fatal.** Private-mode Safari and full quotas
 *   throw on `setItem`; the app must keep working with in-memory settings
 *   rather than dying on a preference write.
 *
 * @module state/settings
 */

export const STORAGE_KEY = 'browser-agent.settings.v1';

/** Bump when the persisted shape changes, and add a step to `migrate`. */
export const SCHEMA_VERSION = 1;

/** @type {Readonly<object>} */
export const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  modelId: '',            // '' means "decide from device capability on first load"
  thinking: false,
  temperature: 0.6,
  maxTokens: 1024,
  maxIterations: 5,
  timeoutMs: 30_000,
  maxBytes: 8 * 1024,
  proxyTemplate: '',
  allowlist: [],
  confirmBeforeSend: true,
  credentials: [],        // persistent credentials only; see sessionCredentials
});

/** Numeric settings and their permitted range. Values outside are clamped. */
const NUMERIC_BOUNDS = Object.freeze({
  temperature: [0, 2],
  maxTokens: [64, 8192],
  maxIterations: [1, 10],
  timeoutMs: [1000, 300_000],
  maxBytes: [256, 1024 * 1024],
});

let idCounter = 0;
/** Monotonic id that does not depend on crypto being available. */
function nextId(prefix = 'cred') {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/**
 * Coerce arbitrary stored/user input into a valid settings object.
 * Unknown keys are dropped; out-of-range numbers are clamped rather than
 * rejected, so a bad value can never wedge the app.
 *
 * @param {object} input
 * @returns {object}
 */
export function sanitize(input) {
  const src = input && typeof input === 'object' ? input : {};
  /** @type {any} */
  const out = { ...DEFAULTS };

  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in src)) continue;
    const value = src[key];

    if (key in NUMERIC_BOUNDS) {
      const [lo, hi] = NUMERIC_BOUNDS[key];
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = Math.min(hi, Math.max(lo, n));
      continue;
    }
    if (typeof DEFAULTS[key] === 'boolean') {
      out[key] = Boolean(value);
      continue;
    }
    if (key === 'allowlist') {
      out.allowlist = Array.isArray(value)
        ? [...new Set(value.map((v) => String(v).trim().toLowerCase()).filter(Boolean))]
        : [];
      continue;
    }
    if (key === 'credentials') {
      out.credentials = Array.isArray(value) ? value.map(sanitizeCredential).filter(Boolean) : [];
      continue;
    }
    if (key === 'schemaVersion') continue;
    out[key] = String(value ?? '');
  }

  out.schemaVersion = SCHEMA_VERSION;
  return out;
}

/**
 * @param {object} c
 * @returns {object|null} Null when the entry has no usable name.
 */
export function sanitizeCredential(c) {
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name ?? '').trim();
  if (name === '') return null;
  return {
    id: String(c.id || nextId()),
    name,
    headerName: String(c.headerName ?? '').trim(),
    hosts: Array.isArray(c.hosts)
      ? [...new Set(c.hosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean))]
      : [],
    value: String(c.value ?? ''),
    sessionOnly: Boolean(c.sessionOnly),
  };
}

/**
 * Upgrade a persisted blob to the current schema.
 * v1 is the first version, so this only stamps the version onto pre-versioned
 * data; the switch is the extension point for later migrations.
 *
 * @param {object} raw
 * @returns {object}
 */
export function migrate(raw) {
  let data = raw && typeof raw === 'object' ? { ...raw } : {};
  const from = Number(data.schemaVersion) || 0;
  switch (from) {
    case 0:
      // Pre-versioned settings: fields we did not have simply fall back to
      // defaults via sanitize().
      data = { ...data, schemaVersion: 1 };
    // falls through
    default:
      break;
  }
  return data;
}

/** In-memory storage stand-in, used when `localStorage` is unavailable. */
export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

/**
 * Create the settings store.
 *
 * @param {object} [opts]
 * @param {Storage} [opts.storage] Defaults to `localStorage`, or an in-memory
 *   shim when that is unavailable or throws.
 * @param {(msg: string) => void} [opts.onStorageError] Notified once per failed write.
 * @returns {object}
 */
export function createSettingsStore(opts = {}) {
  const storage = opts.storage ?? safeLocalStorage();
  const onStorageError = opts.onStorageError;

  /** Session-only credentials: never serialised. */
  let sessionCredentials = [];
  /** @type {Set<Function>} */
  const listeners = new Set();
  let persistBroken = false;

  let current = load();

  function load() {
    let raw = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      return { ...DEFAULTS };
    }
    if (!raw) return { ...DEFAULTS };
    try {
      return sanitize(migrate(JSON.parse(raw)));
    } catch {
      // Corrupt JSON: start clean rather than refusing to boot.
      return { ...DEFAULTS };
    }
  }

  function persist() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(current));
      persistBroken = false;
    } catch (e) {
      if (!persistBroken) {
        persistBroken = true;
        onStorageError?.(
          `Settings could not be saved (${e?.message || e}). They will apply for this session only.`
        );
      }
    }
  }

  function notify() {
    const snapshot = get();
    for (const fn of listeners) fn(snapshot);
  }

  /**
   * Current settings, with session-only credentials merged in. This is what
   * the agent loop and curl tool consume.
   */
  function get() {
    return {
      ...current,
      credentials: [...current.credentials, ...sessionCredentials],
      persistedCredentials: current.credentials,
      sessionCredentials,
      storageWorking: !persistBroken,
    };
  }

  return {
    get,

    /** @returns {object} The saved (persistable) settings only. */
    getPersisted: () => ({ ...current }),

    /**
     * Merge a patch. Unknown keys are ignored; numbers are clamped.
     * @param {object} patch
     */
    set(patch) {
      current = sanitize({ ...current, ...patch });
      persist();
      notify();
      return get();
    },

    /**
     * @param {object} cred `{name, value, headerName?, hosts?, sessionOnly?}`
     * @returns {object|null} The stored credential, or null if invalid.
     */
    addCredential(cred) {
      const clean = sanitizeCredential({ ...cred, id: cred?.id || nextId() });
      if (!clean) return null;
      if (clean.sessionOnly) {
        sessionCredentials = [...sessionCredentials.filter((c) => c.id !== clean.id), clean];
      } else {
        current = { ...current, credentials: [...current.credentials.filter((c) => c.id !== clean.id), clean] };
        persist();
      }
      notify();
      return clean;
    },

    /**
     * Update in place, moving between session and persistent storage if the
     * `sessionOnly` flag changed.
     * @param {string} id
     * @param {object} patch
     */
    updateCredential(id, patch) {
      const existing = [...current.credentials, ...sessionCredentials].find((c) => c.id === id);
      if (!existing) return null;
      const clean = sanitizeCredential({ ...existing, ...patch, id });
      if (!clean) return null;
      sessionCredentials = sessionCredentials.filter((c) => c.id !== id);
      current = { ...current, credentials: current.credentials.filter((c) => c.id !== id) };
      if (clean.sessionOnly) sessionCredentials = [...sessionCredentials, clean];
      else current = { ...current, credentials: [...current.credentials, clean] };
      persist();
      notify();
      return clean;
    },

    /** @param {string} id */
    removeCredential(id) {
      const before = current.credentials.length + sessionCredentials.length;
      sessionCredentials = sessionCredentials.filter((c) => c.id !== id);
      current = { ...current, credentials: current.credentials.filter((c) => c.id !== id) };
      persist();
      notify();
      return current.credentials.length + sessionCredentials.length < before;
    },

    /** Restore defaults and drop every credential, session or not. */
    reset() {
      current = { ...DEFAULTS };
      sessionCredentials = [];
      try {
        storage.removeItem(STORAGE_KEY);
      } catch {
        /* storage unavailable; in-memory reset still applies */
      }
      notify();
      return get();
    },

    /**
     * @param {(settings: object) => void} fn
     * @returns {() => void} Unsubscribe.
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** `localStorage` if it works, an in-memory shim otherwise. */
function safeLocalStorage() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return createMemoryStorage();
    const probe = '__ba_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return createMemoryStorage();
  }
}
