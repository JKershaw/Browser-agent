/**
 * Installing the app, and keeping its shell available offline.
 *
 * Two jobs, both optional extras on top of a page that works without them:
 *
 * - **Register the service worker** (`public/sw.js`) so the page itself is
 *   cached. The model weights are already cached by WebLLM, so together that
 *   means a model downloaded once can be chatted with offline.
 * - **Offer an Install button** when the browser says the app is installable.
 *   Chromium-based browsers (Chrome and Edge on desktop, Chrome on Android)
 *   announce this with a `beforeinstallprompt` event; the button replays it on
 *   a click. Browsers that never fire it (Safari, Firefox) simply never show
 *   the button, and their own "Add to Home Screen" menus still work.
 *
 * `dist/index.html` must keep working with none of this — opened from disk,
 * or hosted without the sidecar files — so every failure here is swallowed
 * and reported as "not available" rather than thrown.
 *
 * No DOM: the window, navigator and location are passed in.
 *
 * @module pwa/install
 */

/** The worker script, relative to the page. */
export const SERVICE_WORKER_URL = './sw.js';

/**
 * Should this page register the service worker?
 *
 * @param {object} env
 * @param {Location|{protocol: string}} [env.location]
 * @param {Navigator|object} [env.navigator]
 * @param {boolean} [env.dev] Vite dev server: a worker caching the page there
 *   would serve stale code after every edit.
 * @returns {{ok: boolean, reason?: string}}
 */
export function canRegisterServiceWorker({ location, navigator, dev = false } = {}) {
  if (dev) return { ok: false, reason: 'dev-server' };
  const protocol = String(location?.protocol || '');
  if (protocol !== 'https:' && protocol !== 'http:') return { ok: false, reason: 'origin' };
  if (!navigator?.serviceWorker || typeof navigator.serviceWorker.register !== 'function') {
    return { ok: false, reason: 'unsupported' };
  }
  return { ok: true };
}

/**
 * Register the service worker if this page can.
 *
 * @param {object} env See {@link canRegisterServiceWorker}.
 * @returns {Promise<{registered: boolean, reason?: string}>}
 */
export async function registerServiceWorker(env = {}) {
  const verdict = canRegisterServiceWorker(env);
  if (!verdict.ok) return { registered: false, reason: verdict.reason };
  try {
    // updateViaCache: 'none' — always ask the server for sw.js itself, so a
    // fixed worker reaches users on their next visit, not after the HTTP
    // cache's idea of freshness expires.
    await env.navigator.serviceWorker.register(SERVICE_WORKER_URL, { updateViaCache: 'none' });
    return { registered: true };
  } catch (e) {
    // A host serving only index.html answers sw.js with HTML (or a 404), and
    // registration rejects. The page is unaffected; it just is not cached.
    return { registered: false, reason: `failed: ${e?.message || e}` };
  }
}

/**
 * Is the page already running as an installed app?
 *
 * @param {object} env
 * @param {Function} [env.matchMedia]
 * @param {object} [env.navigator]
 * @returns {boolean}
 */
export function isStandalone({ matchMedia, navigator } = {}) {
  try {
    if (typeof matchMedia === 'function') {
      for (const mode of ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay']) {
        if (matchMedia(`(display-mode: ${mode})`).matches) return true;
      }
    }
  } catch {
    /* treat an unanswerable query as "not installed" */
  }
  // iOS Safari's home-screen apps report it this way instead.
  return navigator?.standalone === true;
}

/**
 * Turn the browser's install events into a button's state.
 *
 * `onChange({available})` fires whenever the button should appear or vanish;
 * `onInstalled()` fires once the browser reports the app installed, however
 * that happened (our button, or the browser's own menu).
 *
 * @param {object} opts
 * @param {EventTarget} opts.target Usually `window`.
 * @param {(state: {available: boolean}) => void} [opts.onChange]
 * @param {() => void} [opts.onInstalled]
 * @returns {{available: () => boolean, prompt: () => Promise<'accepted'|'dismissed'|'unavailable'>, dispose: () => void}}
 */
export function createInstallPrompt({ target, onChange = () => {}, onInstalled = () => {} }) {
  /** The deferred `beforeinstallprompt` event; usable for one prompt only. */
  let deferred = null;

  const set = (event) => {
    deferred = event;
    onChange({ available: Boolean(deferred) });
  };

  const onBeforeInstall = (event) => {
    // Without this Chrome may show its own mini-infobar as well, and the user
    // gets two install offers for one app.
    event.preventDefault?.();
    set(event);
  };
  const onAppInstalled = () => {
    set(null);
    onInstalled();
  };

  target.addEventListener('beforeinstallprompt', onBeforeInstall);
  target.addEventListener('appinstalled', onAppInstalled);

  return {
    available: () => Boolean(deferred),

    async prompt() {
      const event = deferred;
      if (!event || typeof event.prompt !== 'function') return 'unavailable';
      // The event can be prompted once. Hide the button now; if the user
      // dismisses the dialog, Chrome fires a fresh beforeinstallprompt later
      // and the button comes back by itself.
      set(null);
      try {
        await event.prompt();
        const choice = await event.userChoice;
        return choice?.outcome === 'accepted' ? 'accepted' : 'dismissed';
      } catch {
        return 'dismissed';
      }
    },

    dispose() {
      target.removeEventListener('beforeinstallprompt', onBeforeInstall);
      target.removeEventListener('appinstalled', onAppInstalled);
    },
  };
}
