import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULTS,
  SCHEMA_VERSION,
  STORAGE_KEY,
  createMemoryStorage,
  createSettingsStore,
  migrate,
  sanitize,
  sanitizeCredential,
} from '../../src/state/settings.js';

const store = (storage = createMemoryStorage(), opts = {}) => createSettingsStore({ storage, ...opts });

describe('DEFAULTS', () => {
  // Deliberately literal. Comparing against DEFAULTS itself would pass for any
  // value it happened to hold, which is how a mutated "confirm before sending:
  // false" default slipped past the whole suite.
  it('matches the values the spec requires, spelled out', () => {
    expect(DEFAULTS).toEqual({
      schemaVersion: 1,
      modelId: '',
      thinking: false,          // SPEC §4.2: hybrid thinking off by default
      temperature: 0.6,
      maxTokens: 1024,
      maxIterations: 5,         // SPEC §5.3
      timeoutMs: 30_000,        // SPEC §6.1
      maxBytes: 8 * 1024,       // SPEC §5.3
      proxyTemplate: '',        // SPEC §6.2: off by default
      allowlist: [],            // SPEC §7: off by default
      confirmBeforeSend: true,  // SPEC §7: ON by default
      credentials: [],
    });
  });

  it('is frozen, so nothing can mutate the defaults at runtime', () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
  });
});

describe('sanitize', () => {
  it('fills every default', () => {
    expect(sanitize({})).toEqual({ ...DEFAULTS, schemaVersion: SCHEMA_VERSION });
  });

  it('handles non-object input', () => {
    expect(sanitize(null).maxIterations).toBe(DEFAULTS.maxIterations);
    expect(sanitize('nope').timeoutMs).toBe(DEFAULTS.timeoutMs);
  });

  it('drops unknown keys', () => {
    expect(sanitize({ evil: true })).not.toHaveProperty('evil');
  });

  it.each([
    ['temperature', 5, 2],
    ['temperature', -1, 0],
    ['maxIterations', 99, 10],
    ['maxIterations', 0, 1],
    ['timeoutMs', 1, 1000],
    ['timeoutMs', 10 ** 9, 300_000],
    ['maxBytes', 1, 256],
    ['maxTokens', 1, 64],
  ])('clamps %s=%s to %s', (key, input, expected) => {
    expect(sanitize({ [key]: input })[key]).toBe(expected);
  });

  it('ignores non-numeric values for numeric fields', () => {
    expect(sanitize({ temperature: 'hot' }).temperature).toBe(DEFAULTS.temperature);
  });

  it('coerces booleans', () => {
    expect(sanitize({ confirmBeforeSend: 0 }).confirmBeforeSend).toBe(false);
    expect(sanitize({ thinking: 'yes' }).thinking).toBe(true);
  });

  it('normalises the allowlist: trimmed, lower-cased, de-duplicated', () => {
    expect(sanitize({ allowlist: [' API.test ', 'api.test', '', 'b.test'] }).allowlist)
      .toEqual(['api.test', 'b.test']);
  });

  it('resets a non-array allowlist', () => {
    expect(sanitize({ allowlist: 'api.test' }).allowlist).toEqual([]);
  });

  it('always stamps the current schema version', () => {
    expect(sanitize({ schemaVersion: 99 }).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('coerces string fields', () => {
    expect(sanitize({ proxyTemplate: null }).proxyTemplate).toBe('');
    expect(sanitize({ modelId: 42 }).modelId).toBe('42');
  });
});

describe('sanitizeCredential', () => {
  it('rejects entries without a name', () => {
    expect(sanitizeCredential(null)).toBeNull();
    expect(sanitizeCredential({})).toBeNull();
    expect(sanitizeCredential({ name: '   ' })).toBeNull();
  });

  it('fills defaults and assigns an id', () => {
    const c = sanitizeCredential({ name: 'GH', value: 'v' });
    expect(c).toMatchObject({ name: 'GH', value: 'v', headerName: '', hosts: [], sessionOnly: false });
    expect(c.id).toBeTruthy();
  });

  it('normalises hosts', () => {
    expect(sanitizeCredential({ name: 'A', hosts: [' API.test ', 'api.test', ''] }).hosts).toEqual(['api.test']);
  });

  it('gives unique ids to distinct credentials', () => {
    const a = sanitizeCredential({ name: 'A' });
    const b = sanitizeCredential({ name: 'B' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('migrate', () => {
  it('stamps a version onto pre-versioned data and keeps its fields', () => {
    expect(migrate({ temperature: 0.1 })).toEqual({ temperature: 0.1, schemaVersion: 1 });
  });

  it('passes current-version data through', () => {
    expect(migrate({ schemaVersion: 1, modelId: 'x' })).toEqual({ schemaVersion: 1, modelId: 'x' });
  });

  it('handles junk', () => {
    expect(migrate(null)).toEqual({ schemaVersion: 1 });
  });
});

describe('createSettingsStore — persistence', () => {
  it('starts from defaults with empty storage', () => {
    expect(store().get().maxIterations).toBe(DEFAULTS.maxIterations);
  });

  it('persists a change and reloads it', () => {
    const storage = createMemoryStorage();
    store(storage).set({ temperature: 0.1, proxyTemplate: 'https://p.test/?url={url}' });
    const reloaded = store(storage).get();
    expect(reloaded.temperature).toBe(0.1);
    expect(reloaded.proxyTemplate).toBe('https://p.test/?url={url}');
  });

  it('clamps on the way in', () => {
    expect(store().set({ maxIterations: 99 }).maxIterations).toBe(10);
  });

  it('recovers from corrupt stored JSON', () => {
    const storage = createMemoryStorage();
    storage.setItem(STORAGE_KEY, '{not json');
    expect(store(storage).get().maxIterations).toBe(DEFAULTS.maxIterations);
  });

  it('migrates pre-versioned stored settings', () => {
    const storage = createMemoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ temperature: 0.9 }));
    const s = store(storage).get();
    expect(s.temperature).toBe(0.9);
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('keeps working, and warns once, when storage writes throw', () => {
    const onStorageError = vi.fn();
    const storage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); }, removeItem: () => {} };
    const s = store(storage, { onStorageError });
    s.set({ temperature: 0.2 });
    s.set({ temperature: 0.3 });
    expect(s.get().temperature).toBe(0.3);
    expect(s.get().storageWorking).toBe(false);
    expect(onStorageError).toHaveBeenCalledTimes(1);
    expect(onStorageError.mock.calls[0][0]).toContain('QuotaExceeded');
  });

  it('falls back to defaults when reads throw', () => {
    const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => {}, removeItem: () => {} };
    expect(store(storage).get().temperature).toBe(DEFAULTS.temperature);
  });

  it('reset clears storage and returns to defaults', () => {
    const storage = createMemoryStorage();
    const s = store(storage);
    s.set({ temperature: 0.1 });
    s.addCredential({ name: 'A', value: 'v' });
    s.reset();
    expect(s.get().temperature).toBe(DEFAULTS.temperature);
    expect(s.get().credentials).toEqual([]);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('reset survives a storage that throws on removeItem', () => {
    const storage = { getItem: () => null, setItem: () => {}, removeItem: () => { throw new Error('nope'); } };
    expect(() => store(storage).reset()).not.toThrow();
  });
});

describe('createSettingsStore — credentials', () => {
  it('adds and exposes a persistent credential', () => {
    const storage = createMemoryStorage();
    const s = store(storage);
    s.addCredential({ name: 'GitHub', value: 'ghp_x' });
    expect(s.get().credentials).toHaveLength(1);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)).credentials[0].value).toBe('ghp_x');
  });

  it('never writes a session-only credential to storage', () => {
    const storage = createMemoryStorage();
    const s = store(storage);
    s.addCredential({ name: 'Temp', value: 'super-secret', sessionOnly: true });
    expect(s.get().credentials).toHaveLength(1);
    expect(storage.getItem(STORAGE_KEY) || '').not.toContain('super-secret');
    expect(JSON.parse(storage.getItem(STORAGE_KEY) || '{"credentials":[]}').credentials).toEqual([]);
  });

  it('loses session-only credentials on reload but keeps persistent ones', () => {
    const storage = createMemoryStorage();
    const s1 = store(storage);
    s1.addCredential({ name: 'Keep', value: 'k' });
    s1.addCredential({ name: 'Drop', value: 'd', sessionOnly: true });
    const s2 = store(storage);
    expect(s2.get().credentials.map((c) => c.name)).toEqual(['Keep']);
  });

  it('rejects an unnamed credential', () => {
    const s = store();
    expect(s.addCredential({ value: 'x' })).toBeNull();
    expect(s.get().credentials).toEqual([]);
  });

  it('updates a credential in place', () => {
    const s = store();
    const c = s.addCredential({ name: 'A', value: 'v1' });
    s.updateCredential(c.id, { value: 'v2' });
    expect(s.get().credentials[0].value).toBe('v2');
    expect(s.get().credentials).toHaveLength(1);
  });

  it('moves a credential from persistent to session-only', () => {
    const storage = createMemoryStorage();
    const s = store(storage);
    const c = s.addCredential({ name: 'A', value: 'secret-value' });
    s.updateCredential(c.id, { sessionOnly: true });
    expect(s.get().credentials).toHaveLength(1);
    expect(s.get().sessionCredentials).toHaveLength(1);
    expect(storage.getItem(STORAGE_KEY)).not.toContain('secret-value');
  });

  it('moves a credential from session-only to persistent', () => {
    const storage = createMemoryStorage();
    const s = store(storage);
    const c = s.addCredential({ name: 'A', value: 'v', sessionOnly: true });
    s.updateCredential(c.id, { sessionOnly: false });
    expect(s.get().persistedCredentials).toHaveLength(1);
    expect(storage.getItem(STORAGE_KEY)).toContain('"name":"A"');
  });

  it('returns null updating an unknown id', () => {
    expect(store().updateCredential('nope', { value: 'x' })).toBeNull();
  });

  it('returns null when an update would invalidate the credential', () => {
    const s = store();
    const c = s.addCredential({ name: 'A', value: 'v' });
    expect(s.updateCredential(c.id, { name: '  ' })).toBeNull();
  });

  it('removes credentials of both kinds', () => {
    const s = store();
    const a = s.addCredential({ name: 'A', value: 'v' });
    const b = s.addCredential({ name: 'B', value: 'v', sessionOnly: true });
    expect(s.removeCredential(a.id)).toBe(true);
    expect(s.removeCredential(b.id)).toBe(true);
    expect(s.removeCredential('missing')).toBe(false);
    expect(s.get().credentials).toEqual([]);
  });

  it('replaces rather than duplicates when adding the same id twice', () => {
    const s = store();
    const c = s.addCredential({ name: 'A', value: 'v1' });
    s.addCredential({ ...c, value: 'v2' });
    expect(s.get().credentials).toHaveLength(1);
    expect(s.get().credentials[0].value).toBe('v2');
  });
});

describe('createSettingsStore — subscriptions', () => {
  it('notifies on set, credential changes and reset', () => {
    const s = store();
    const fn = vi.fn();
    s.subscribe(fn);
    s.set({ temperature: 0.2 });
    const c = s.addCredential({ name: 'A', value: 'v' });
    s.updateCredential(c.id, { value: 'w' });
    s.removeCredential(c.id);
    s.reset();
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('unsubscribes', () => {
    const s = store();
    const fn = vi.fn();
    s.subscribe(fn)();
    s.set({ temperature: 0.2 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('hands subscribers the merged snapshot', () => {
    const s = store();
    let seen;
    s.subscribe((v) => { seen = v; });
    s.addCredential({ name: 'A', value: 'v', sessionOnly: true });
    expect(seen.credentials).toHaveLength(1);
  });
});

describe('createMemoryStorage', () => {
  it('behaves like Storage for the operations we use', () => {
    const m = createMemoryStorage();
    expect(m.getItem('a')).toBeNull();
    m.setItem('a', 1);
    expect(m.getItem('a')).toBe('1');
    m.removeItem('a');
    expect(m.getItem('a')).toBeNull();
  });
});
