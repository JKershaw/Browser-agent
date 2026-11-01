/**
 * Local HTTP servers for the e2e suite.
 *
 * Two of them:
 * - a **static server** for the built `dist/index.html`, so tests run against
 *   the real shipped artifact rather than the dev server;
 * - a **target server** the agent's curl tool calls, with permissive CORS and a
 *   receipt log so assertions can prove a request actually arrived.
 *
 * No external network dependency: every e2e scenario is deterministic.
 *
 * @module tests/e2e/test-server
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

/**
 * Start the tool-target server.
 *
 * Routes:
 * - `GET  /json`            small JSON document
 * - `GET  /big?n=`          `n` bytes of filler (for truncation tests)
 * - `GET  /slow?ms=`        delays before responding (for timeout tests)
 * - `GET  /status/:code`    responds with that status
 * - `GET  /headers`         echoes the request headers it received
 * - `GET  /redirect?to=`    302 to an absolute URL
 * - `ANY  /echo`            echoes method, headers and body
 * - `GET  /_received`       every request this server has seen (test receipts)
 * - `POST /_reset`          clear the receipt log
 *
 * @param {number} [port] 0 picks a free port.
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>, received: () => Array<object>}>}
 */
export async function startTargetServer(port = 0) {
  /** @type {Array<object>} */
  const received = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const body = await readBody(req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    if (url.pathname !== '/_received') {
      received.push({
        method: req.method,
        path: url.pathname + url.search,
        headers: req.headers,
        body,
      });
    }

    const send = (status, payload, extraHeaders = {}) => {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      res.writeHead(status, {
        'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
        ...CORS,
        ...extraHeaders,
      });
      res.end(req.method === 'HEAD' ? undefined : text);
    };

    switch (true) {
      case url.pathname === '/json':
        send(200, { city: 'Bristol', temperatureC: 14, conditions: 'light rain', humidityPct: 87 });
        return;

      case url.pathname === '/big': {
        const n = Math.min(Number(url.searchParams.get('n')) || 100_000, 5_000_000);
        send(200, 'x'.repeat(n));
        return;
      }

      case url.pathname === '/slow': {
        const ms = Math.min(Number(url.searchParams.get('ms')) || 1000, 60_000);
        setTimeout(() => send(200, { slow: true, ms }), ms);
        return;
      }

      case url.pathname.startsWith('/status/'): {
        const code = Number(url.pathname.split('/')[2]) || 500;
        send(code, { status: code, note: 'deliberate status for testing' });
        return;
      }

      case url.pathname === '/headers':
        send(200, { received: req.headers });
        return;

      case url.pathname === '/redirect': {
        const to = url.searchParams.get('to') || '/json';
        res.writeHead(302, { Location: to, ...CORS });
        res.end();
        return;
      }

      case url.pathname === '/echo':
        send(200, { method: req.method, headers: req.headers, body });
        return;

      case url.pathname === '/_received':
        send(200, received);
        return;

      case url.pathname === '/_reset':
        received.length = 0;
        send(200, { ok: true });
        return;

      default:
        send(404, { error: 'no such route', path: url.pathname });
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address().port;

  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    received: () => received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * The installable-app sidecar files the build emits next to `index.html`, and
 * the types they must be served with (a service worker served as anything but
 * JavaScript is refused). Mirrors the allowlist in `.github/workflows/ci.yml`.
 */
export const PWA_FILES = Object.freeze({
  '/manifest.webmanifest': 'application/manifest+json',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/icons/icon-192.png': 'image/png',
  '/icons/icon-512.png': 'image/png',
  '/icons/icon-maskable-512.png': 'image/png',
  '/icons/apple-touch-icon.png': 'image/png',
});

/**
 * Serve the built artifact.
 *
 * Deliberately minimal: every path answers with `dist/index.html`, except the
 * fixed list of installable-app files in {@link PWA_FILES}. If the build ever
 * emits a further file the app needs, these tests fail rather than silently
 * passing. With `pwa: false` the sidecar files 404, which is how the suite
 * proves `index.html` still works entirely on its own.
 *
 * @param {number} [port]
 * @param {string} [distDir]
 * @param {{pwa?: boolean}} [options]
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>, stop: () => Promise<void>}>}
 */
export async function startStaticServer(port = 0, distDir = DIST, { pwa = true } = {}) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      if (Object.hasOwn(PWA_FILES, path)) {
        if (!pwa) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not served in this test');
          return;
        }
        const body = await readFile(join(distDir, path.slice(1)));
        res.writeHead(200, { 'Content-Type': PWA_FILES[path] });
        res.end(body);
        return;
      }
      const html = await readFile(join(distDir, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`${path} is missing from dist/ — run "npm run build" first. (${e.message})`);
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address().port;
  let stopped = false;
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    /**
     * Take the server away mid-test, keep-alive connections included, so the
     * next request fails the way it would with no network at all.
     */
    stop: () => {
      stopped = true;
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    close: () => (stopped ? Promise.resolve() : new Promise((resolve) => server.close(resolve))),
  };
}

/** @param {import('node:http').IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}
