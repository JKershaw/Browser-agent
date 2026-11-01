/**
 * Service worker: keeps the app shell available offline, and nothing else.
 *
 * What it caches is deliberately tiny — the page, the manifest and the icons.
 * The model weights are not its business: WebLLM already stores those in its
 * own Cache API buckets (`webllm/model`, `webllm/wasm`, `webllm/config`) and
 * reads them cache-first, so once a model has been downloaded it loads with no
 * network at all. All this worker adds is a copy of the page to load it into.
 *
 * Rules that keep it from getting in the way:
 *
 * - **It only answers for the shell.** Every other request — model downloads,
 *   and above all the agent's own curl and wiki requests — is left alone: the
 *   handler returns without calling `respondWith`, so the browser handles it
 *   exactly as it would with no worker installed. The worker never sees a
 *   credential substituted into a request body, and never caches a response
 *   the user approved.
 * - **The page is network-first.** Online, you always get the version that is
 *   deployed now, so there is no "stuck on an old build" problem and no update
 *   prompt to design. Offline — or when the network has not answered within a
 *   few seconds — the last good copy is served instead.
 * - **Cleanup only touches its own caches.** Deleting every cache not named
 *   here is the usual pattern, and on this origin it would delete the model
 *   weights the user waited several minutes for.
 *
 * Plain script, not a module, and not processed by Vite: service workers must
 * be a same-origin file, so this one is copied into `dist/` as-is.
 */

/* eslint-env serviceworker */

const PREFIX = 'browser-agent-shell-';
const CACHE = `${PREFIX}v1`;

/** How long a navigation waits for the network before using the cached page. */
const NETWORK_TIMEOUT_MS = 3500;

const SCOPE = new URL(self.registration.scope);
const PAGE = new URL('./', SCOPE).href;
const SHELL = [
  PAGE,
  new URL('manifest.webmanifest', SCOPE).href,
  new URL('icons/icon-192.png', SCOPE).href,
  new URL('icons/icon-512.png', SCOPE).href,
  new URL('icons/icon-maskable-512.png', SCOPE).href,
  new URL('icons/apple-touch-icon.png', SCOPE).href,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `cache: 'reload'` skips the HTTP cache, so the copy stored for offline
      // use is the deployed one rather than whatever the browser had lying
      // around.
      await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n))
      );
      // Take over the tab that installed us, so it works offline from now on
      // rather than from the next visit.
      await self.clients.claim();
    })()
  );
});

/** Is this a request for the page itself (with any query string)? */
function isPage(url) {
  return url.origin === SCOPE.origin && (url.pathname === SCOPE.pathname || url.pathname === `${SCOPE.pathname}index.html`);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate' && isPage(url)) {
    event.respondWith(networkFirstPage(event));
    return;
  }

  // The manifest and icons: cache-first, they change only with the artwork.
  url.search = '';
  if (SHELL.includes(url.href) && url.href !== PAGE) {
    event.respondWith(caches.match(url.href).then((hit) => hit || fetch(request)));
  }
  // Anything else: no respondWith, so the browser handles it untouched.
});

/**
 * Race the network against a timeout; refresh the stored copy whenever the
 * network wins, even if it wins after the cached copy has been served.
 *
 * @param {FetchEvent} event
 * @returns {Promise<Response>}
 */
async function networkFirstPage(event) {
  const cache = await caches.open(CACHE);
  const network = fetch(event.request).then(async (response) => {
    if (response.ok && response.type === 'basic') {
      await cache.put(PAGE, response.clone());
    }
    return response;
  });
  // A late network answer still refreshes the cache after we have replied.
  event.waitUntil(network.catch(() => {}));

  const timedOut = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));
  const first = await Promise.race([network.catch(() => null), timedOut]);
  if (first) return first;

  const cached = await cache.match(PAGE);
  if (cached) return cached;
  // Nothing cached yet (first visit, offline): let the network error through,
  // or wait out a slow connection rather than fail a page that may yet load.
  return network;
}
