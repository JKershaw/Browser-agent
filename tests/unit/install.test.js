import { describe, expect, it, vi } from 'vitest';
import {
  SERVICE_WORKER_URL,
  canRegisterServiceWorker,
  createInstallPrompt,
  isStandalone,
  registerServiceWorker,
} from '../../src/pwa/install.js';

const https = { protocol: 'https:' };
const withSW = (register = vi.fn(async () => ({}))) => ({ serviceWorker: { register } });

describe('canRegisterServiceWorker', () => {
  it('allows http and https pages with service worker support', () => {
    expect(canRegisterServiceWorker({ location: https, navigator: withSW() })).toEqual({ ok: true });
    expect(canRegisterServiceWorker({ location: { protocol: 'http:' }, navigator: withSW() })).toEqual({ ok: true });
  });

  it('refuses on the dev server, where it would cache code mid-edit', () => {
    expect(canRegisterServiceWorker({ location: https, navigator: withSW(), dev: true })).toEqual({ ok: false, reason: 'dev-server' });
  });

  it('refuses file:// and other non-http origins', () => {
    expect(canRegisterServiceWorker({ location: { protocol: 'file:' }, navigator: withSW() }).reason).toBe('origin');
    expect(canRegisterServiceWorker({ navigator: withSW() }).reason).toBe('origin');
  });

  it('refuses where the API is missing', () => {
    expect(canRegisterServiceWorker({ location: https, navigator: {} }).reason).toBe('unsupported');
    expect(canRegisterServiceWorker({ location: https, navigator: { serviceWorker: {} } }).reason).toBe('unsupported');
    expect(canRegisterServiceWorker({ location: https }).reason).toBe('unsupported');
    expect(canRegisterServiceWorker().reason).toBe('origin');
  });
});

describe('registerServiceWorker', () => {
  it('registers the worker without the HTTP cache in the way', async () => {
    const register = vi.fn(async () => ({}));
    const out = await registerServiceWorker({ location: https, navigator: withSW(register) });
    expect(out).toEqual({ registered: true });
    expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL, { updateViaCache: 'none' });
  });

  it('does not try where it cannot', async () => {
    const register = vi.fn();
    const out = await registerServiceWorker({ location: { protocol: 'file:' }, navigator: withSW(register) });
    expect(out).toEqual({ registered: false, reason: 'origin' });
    expect(register).not.toHaveBeenCalled();
  });

  it('swallows a failed registration: the page must work without it', async () => {
    const register = vi.fn(async () => {
      throw new TypeError('bad MIME type');
    });
    const out = await registerServiceWorker({ location: https, navigator: withSW(register) });
    expect(out.registered).toBe(false);
    expect(out.reason).toContain('bad MIME type');
  });

  it('reports a non-Error rejection too', async () => {
    const register = vi.fn(() => Promise.reject('nope'));
    const out = await registerServiceWorker({ location: https, navigator: withSW(register) });
    expect(out.reason).toBe('failed: nope');
  });
});

describe('isStandalone', () => {
  const media = (matching) => (q) => ({ matches: matching.some((m) => q.includes(m)) });

  it('detects the installed display modes', () => {
    expect(isStandalone({ matchMedia: media(['standalone']) })).toBe(true);
    expect(isStandalone({ matchMedia: media(['window-controls-overlay']) })).toBe(true);
  });

  it('is false in an ordinary tab', () => {
    expect(isStandalone({ matchMedia: media([]) })).toBe(false);
    expect(isStandalone()).toBe(false);
  });

  it('understands iOS home-screen apps', () => {
    expect(isStandalone({ navigator: { standalone: true } })).toBe(true);
  });

  it('treats a throwing matchMedia as not installed', () => {
    const matchMedia = () => {
      throw new Error('no');
    };
    expect(isStandalone({ matchMedia })).toBe(false);
  });
});

describe('createInstallPrompt', () => {
  /** A beforeinstallprompt stand-in. */
  function installEvent(outcome = 'accepted') {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = vi.fn(async () => {});
    event.userChoice = Promise.resolve({ outcome });
    return event;
  }

  it('is unavailable until the browser offers it', async () => {
    const target = new EventTarget();
    const ctl = createInstallPrompt({ target });
    expect(ctl.available()).toBe(false);
    expect(await ctl.prompt()).toBe('unavailable');
  });

  it('defers the browser prompt and shows the button', () => {
    const target = new EventTarget();
    const onChange = vi.fn();
    const ctl = createInstallPrompt({ target, onChange });
    const event = installEvent();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(ctl.available()).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith({ available: true });
  });

  it('prompts once, then hides the button', async () => {
    const target = new EventTarget();
    const onChange = vi.fn();
    const ctl = createInstallPrompt({ target, onChange });
    const event = installEvent('accepted');
    target.dispatchEvent(event);

    expect(await ctl.prompt()).toBe('accepted');
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(ctl.available()).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith({ available: false });
    expect(await ctl.prompt()).toBe('unavailable');
  });

  it('reports a dismissal, and comes back when the browser offers again', async () => {
    const target = new EventTarget();
    const ctl = createInstallPrompt({ target });
    target.dispatchEvent(installEvent('dismissed'));
    expect(await ctl.prompt()).toBe('dismissed');
    target.dispatchEvent(installEvent());
    expect(ctl.available()).toBe(true);
  });

  it('treats a prompt that throws as dismissed', async () => {
    const target = new EventTarget();
    const ctl = createInstallPrompt({ target });
    const event = installEvent();
    event.prompt = vi.fn(async () => {
      throw new Error('already shown');
    });
    target.dispatchEvent(event);
    expect(await ctl.prompt()).toBe('dismissed');
  });

  it('treats an event without prompt() as unavailable', async () => {
    const target = new EventTarget();
    const ctl = createInstallPrompt({ target });
    target.dispatchEvent(new Event('beforeinstallprompt'));
    expect(await ctl.prompt()).toBe('unavailable');
  });

  it('hides the button and says so when installed by any route', () => {
    const target = new EventTarget();
    const onChange = vi.fn();
    const onInstalled = vi.fn();
    const ctl = createInstallPrompt({ target, onChange, onInstalled });
    target.dispatchEvent(installEvent());
    target.dispatchEvent(new Event('appinstalled'));
    expect(ctl.available()).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith({ available: false });
    expect(onInstalled).toHaveBeenCalledOnce();
  });

  it('stops listening when disposed', () => {
    const target = new EventTarget();
    const onChange = vi.fn();
    const ctl = createInstallPrompt({ target, onChange });
    ctl.dispose();
    target.dispatchEvent(installEvent());
    expect(onChange).not.toHaveBeenCalled();
  });
});
