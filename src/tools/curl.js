/**
 * The one tool the agent has: an HTTP request built on `fetch`.
 *
 * Everything the browser can hide from us (the real reason a cross-origin
 * request failed, for instance) is surfaced honestly rather than guessed at.
 * The module is dependency-injected — pass `fetchImpl` — so it unit-tests
 * without a browser.
 *
 * @module tools/curl
 */

import { ALLOWED_METHODS, ALLOWED_SCHEMES } from '../agent/toolcall.js';

/**
 * Distinct failure modes. Each maps to its own user-facing explanation; see
 * §6.3 of the spec — errors are never collapsed into a generic "request
 * failed".
 * @enum {string}
 */
export const CurlError = Object.freeze({
  INVALID_URL: 'invalid_url',
  BLOCKED_SCHEME: 'blocked_scheme',
  BLOCKED_DOMAIN: 'blocked_domain',
  BLOCKED_REDIRECT: 'blocked_redirect',
  BAD_METHOD: 'bad_method',
  BAD_PROXY: 'bad_proxy',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  NETWORK: 'network',
  READ_FAILED: 'read_failed',
});

/** The mask shown in place of a secret. */
export const MASK = '••••••••';

/** Placeholder syntax for credentials: `{{credential name}}`. */
const CREDENTIAL_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BYTES = 8 * 1024;

/**
 * Does `host` satisfy an allowlist `pattern`?
 *
 * - `example.com` matches `example.com` and any sub-domain of it.
 * - `*.example.com` matches sub-domains only.
 * - `*` matches everything.
 *
 * @param {string} host Lower-case hostname.
 * @param {string} pattern
 * @returns {boolean}
 */
export function hostMatches(host, pattern) {
  const p = String(pattern || '').trim().toLowerCase();
  if (p === '') return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return base !== '' && host.endsWith(`.${base}`);
  }
  return host === p || host.endsWith(`.${p}`);
}

/**
 * @param {string} host
 * @param {string[]} allowlist Empty/absent means "allow everything".
 * @returns {boolean}
 */
export function isHostAllowed(host, allowlist) {
  const list = (allowlist || []).map((s) => String(s).trim()).filter(Boolean);
  if (list.length === 0) return true;
  return list.some((p) => hostMatches(host, p));
}

/**
 * Replace `{{name}}` placeholders in header values with stored secrets.
 *
 * Keeping secrets out of the model's context is the point: the model writes
 * the placeholder, this function writes the value, and nothing ever puts the
 * value back into a message.
 *
 * @param {Object<string,string>} headers
 * @param {Array<{name: string, value: string}>} credentials
 * @returns {{headers: Object<string,string>, used: string[], missing: string[], secrets: string[]}}
 */
export function applyCredentials(headers, credentials = []) {
  const byName = new Map(credentials.map((c) => [String(c.name).trim().toLowerCase(), c]));
  /** @type {Object<string,string>} */
  const out = {};
  const used = [];
  const missing = [];
  const secrets = [];

  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = String(v).replace(CREDENTIAL_RE, (whole, rawName) => {
      const cred = byName.get(String(rawName).trim().toLowerCase());
      if (!cred) {
        if (!missing.includes(rawName)) missing.push(rawName);
        return whole;
      }
      if (!used.includes(cred.name)) used.push(cred.name);
      if (cred.value) secrets.push(cred.value);
      return cred.value ?? '';
    });
  }
  return { headers: out, used, missing, secrets };
}

/**
 * Auto-attached credentials: entries with a `headerName` and a matching
 * `hosts` pattern are added to every request to those hosts, unless the model
 * already set that header.
 *
 * @param {Object<string,string>} headers
 * @param {string} host
 * @param {Array<{name: string, headerName?: string, value: string, hosts?: string[]}>} credentials
 * @returns {{headers: Object<string,string>, used: string[], secrets: string[]}}
 */
export function attachHostCredentials(headers, host, credentials = []) {
  const out = { ...headers };
  const present = new Set(Object.keys(out).map((k) => k.toLowerCase()));
  const used = [];
  const secrets = [];
  for (const cred of credentials) {
    if (!cred.headerName || !cred.hosts || cred.hosts.length === 0) continue;
    if (!cred.hosts.some((p) => hostMatches(host, p))) continue;
    if (present.has(cred.headerName.toLowerCase())) continue;
    out[cred.headerName] = cred.value ?? '';
    if (cred.value) secrets.push(cred.value);
    used.push(cred.name);
  }
  return { headers: out, used, secrets };
}

/**
 * Redact every known secret from an arbitrary string (URL, header value, log
 * line). Longest-first so overlapping secrets mask cleanly.
 *
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
export function maskSecrets(text, secrets = []) {
  let out = String(text);
  const sorted = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4))]
    .sort((a, b) => b.length - a.length);
  for (const s of sorted) out = out.split(s).join(MASK);
  return out;
}

/**
 * Header names whose values are always masked in the UI and log, even when the
 * value is a literal the user typed rather than a stored credential.
 */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
]);

/**
 * @param {Object<string,string>} headers
 * @param {string[]} secrets
 * @returns {Object<string,string>} Copy safe to render.
 */
export function maskHeaders(headers, secrets = []) {
  /** @type {Object<string,string>} */
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? MASK : maskSecrets(v, secrets);
  }
  return out;
}

/**
 * Rewrite a target URL through the configured CORS proxy.
 *
 * `{url}` in the template is replaced with the percent-encoded target. A
 * template without `{url}` is treated as a prefix (the `https://proxy/` +
 * `https://target/` convention some proxies use).
 *
 * @param {string} url
 * @param {string} template
 * @returns {string}
 */
export function applyProxy(url, template) {
  const t = String(template || '').trim();
  if (t === '') return url;
  if (t.includes('{url}')) return t.split('{url}').join(encodeURIComponent(url));
  return t + url;
}

/**
 * Read a response body, stopping once `maxBytes` have been collected.
 *
 * Streaming rather than `text()` means a hostile or merely enormous response
 * cannot exhaust memory: we cancel the stream at the cap.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<{text: string, truncated: boolean, bytes: number}>}
 */
export async function readBodyCapped(response, maxBytes) {
  const cap = Math.max(0, Number(maxBytes) || 0);
  const body = response.body;

  if (!body || typeof body.getReader !== 'function') {
    // Test doubles and HEAD responses land here.
    const text = typeof response.text === 'function' ? await response.text() : '';
    const encoded = new TextEncoder().encode(text);
    if (encoded.length <= cap) return { text, truncated: false, bytes: encoded.length };
    return {
      text: new TextDecoder().decode(encoded.slice(0, cap)),
      truncated: true,
      bytes: encoded.length,
    };
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      total += value.length;
      if (total > cap) {
        const keep = cap - (total - value.length);
        if (keep > 0) chunks.push(value.slice(0, keep));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (truncated) {
      try {
        await reader.cancel();
      } catch {
        /* stream already closed; nothing to do */
      }
    }
  }

  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return { text: new TextDecoder().decode(merged), truncated, bytes: truncated ? -1 : total };
}

/**
 * Human-readable explanation for each failure kind. These strings go to the
 * user *and* into the tool result the model sees, so they explain rather than
 * just label.
 *
 * @param {string} kind
 * @param {object} ctx
 * @returns {string}
 */
function explain(kind, ctx) {
  switch (kind) {
    case CurlError.TIMEOUT:
      return `The request did not complete within the ${ctx.timeoutMs} ms timeout and was aborted. The server may be slow or unreachable; try again or raise the timeout in settings.`;
    case CurlError.CANCELLED:
      return 'The request was cancelled.';
    case CurlError.NETWORK:
      return [
        'The browser refused or could not complete the request, and it does not tell pages why.',
        'The usual cause is CORS: the target server did not send an Access-Control-Allow-Origin header that permits this page.',
        ctx.proxyConfigured
          ? 'A CORS proxy is configured and was used, so the proxy itself may be down or may not allow this target.'
          : 'No CORS proxy is configured. If the target is not CORS-enabled, set a proxy URL template in settings (e.g. https://your-proxy.example/?url={url}).',
        'Other possibilities: DNS failure, connection refused, TLS error, or the host being offline.',
      ].join(' ');
    case CurlError.INVALID_URL:
      return `"${ctx.url}" is not a valid absolute URL. Include the scheme, e.g. https://example.com/path.`;
    case CurlError.BLOCKED_SCHEME:
      return `The scheme "${ctx.scheme}" is not allowed. Only ${ALLOWED_SCHEMES.join(' and ')} URLs can be requested.`;
    case CurlError.BLOCKED_DOMAIN:
      return `The host "${ctx.host}" is not on the domain allowlist (${ctx.allowlist.join(', ')}). Add it in settings to allow this request.`;
    case CurlError.BLOCKED_REDIRECT:
      return `The request was redirected to "${ctx.host}", which is not on the domain allowlist. The response was discarded.`;
    case CurlError.BAD_METHOD:
      return `Method "${ctx.method}" is not supported. Use one of: ${ALLOWED_METHODS.join(', ')}.`;
    case CurlError.BAD_PROXY:
      return `The configured CORS proxy template produced an invalid URL ("${ctx.proxied}"). Check the proxy setting.`;
    case CurlError.READ_FAILED:
      return `The response started but the body could not be read: ${ctx.detail}`;
    default:
      return 'The request failed for an unknown reason.';
  }
}

/**
 * @param {string} kind
 * @param {object} ctx
 * @param {number} elapsedMs
 * @param {object} meta
 */
function failure(kind, ctx, elapsedMs, meta = {}) {
  return {
    ok: false,
    error: { kind, message: explain(kind, ctx) },
    elapsedMs,
    ...meta,
  };
}

/**
 * Execute one HTTP request.
 *
 * Never throws for an expected failure: every outcome is a plain object the
 * agent loop can serialise straight into the conversation.
 *
 * @param {{method: string, url: string, headers?: Object<string,string>, body?: string|null}} args
 *        Validated tool-call args (see `agent/toolcall.js`).
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] Injected `fetch`.
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxBytes] Body cap in bytes.
 * @param {string} [opts.proxyTemplate]
 * @param {string[]} [opts.allowlist]
 * @param {Array<object>} [opts.credentials]
 * @param {AbortSignal} [opts.signal] External cancellation (user pressed stop).
 * @param {() => number} [opts.now] Injectable clock for deterministic tests.
 * @returns {Promise<object>} Result object; `ok` distinguishes success.
 */
export async function executeCurl(args, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    proxyTemplate = '',
    allowlist = [],
    credentials = [],
    signal,
    now = () => Date.now(),
  } = opts;

  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  const method = String(args?.method || 'GET').toUpperCase();

  if (!ALLOWED_METHODS.includes(method)) {
    return failure(CurlError.BAD_METHOD, { method }, elapsed(), { request: { method, url: args?.url } });
  }

  let target;
  try {
    target = new URL(String(args?.url ?? ''));
  } catch {
    return failure(CurlError.INVALID_URL, { url: args?.url }, elapsed(), { request: { method, url: args?.url } });
  }
  if (!ALLOWED_SCHEMES.includes(target.protocol)) {
    return failure(CurlError.BLOCKED_SCHEME, { scheme: target.protocol }, elapsed(), {
      request: { method, url: target.href },
    });
  }

  const host = target.hostname.toLowerCase();
  const list = (allowlist || []).map((s) => String(s).trim()).filter(Boolean);
  if (!isHostAllowed(host, list)) {
    return failure(CurlError.BLOCKED_DOMAIN, { host, allowlist: list }, elapsed(), {
      request: { method, url: target.href },
    });
  }

  // Credentials: host-attached first, then explicit {{placeholders}}.
  const attached = attachHostCredentials(args?.headers || {}, host, credentials);
  const substituted = applyCredentials(attached.headers, credentials);
  const secrets = [...attached.secrets, ...substituted.secrets];
  const outgoingHeaders = substituted.headers;

  const requestUrl = applyProxy(target.href, proxyTemplate);
  try {
    // eslint-disable-next-line no-new
    new URL(requestUrl);
  } catch {
    return failure(CurlError.BAD_PROXY, { proxied: requestUrl }, elapsed(), {
      request: { method, url: target.href },
    });
  }

  /** Metadata attached to every outcome so the log always has the full story. */
  const request = {
    method,
    url: target.href,
    requestUrl,
    headers: outgoingHeaders,
    body: args?.body ?? null,
    proxied: requestUrl !== target.href,
    credentialsUsed: [...new Set([...attached.used, ...substituted.used])],
    credentialsMissing: substituted.missing,
    secrets,
  };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const init = {
      method,
      headers: outgoingHeaders,
      signal: controller.signal,
      redirect: 'follow',
      // Never attach the visitor's ambient cookies to a model-chosen URL.
      credentials: 'omit',
    };
    if (args?.body !== null && args?.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.body = args.body;
    }

    let response;
    try {
      response = await fetchImpl(requestUrl, init);
    } catch (e) {
      if (timedOut) return failure(CurlError.TIMEOUT, { timeoutMs }, elapsed(), { request });
      if (signal?.aborted || e?.name === 'AbortError') {
        return failure(CurlError.CANCELLED, {}, elapsed(), { request });
      }
      return failure(
        CurlError.NETWORK,
        { proxyConfigured: request.proxied },
        elapsed(),
        { request, detail: String(e?.message || e) }
      );
    }

    // Redirects can walk out of the allowlist; the browser follows them before
    // we get a say, so we discard the result rather than hand it over.
    if (list.length > 0 && response.url) {
      try {
        const finalHost = new URL(response.url).hostname.toLowerCase();
        if (!isHostAllowed(finalHost, list)) {
          return failure(CurlError.BLOCKED_REDIRECT, { host: finalHost }, elapsed(), { request });
        }
      } catch {
        /* opaque or relative response.url: nothing to check */
      }
    }

    let bodyResult = { text: '', truncated: false, bytes: 0 };
    if (method !== 'HEAD') {
      try {
        bodyResult = await readBodyCapped(response, maxBytes);
      } catch (e) {
        if (timedOut) return failure(CurlError.TIMEOUT, { timeoutMs }, elapsed(), { request });
        if (signal?.aborted || e?.name === 'AbortError') {
          return failure(CurlError.CANCELLED, {}, elapsed(), { request });
        }
        return failure(CurlError.READ_FAILED, { detail: String(e?.message || e) }, elapsed(), { request });
      }
    }

    /** @type {Object<string,string>} */
    const responseHeaders = {};
    if (response.headers && typeof response.headers.forEach === 'function') {
      response.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });
    }

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText || '',
      headers: responseHeaders,
      body: bodyResult.text,
      truncated: bodyResult.truncated,
      bytes: bodyResult.bytes,
      maxBytes,
      redirected: Boolean(response.redirected),
      finalUrl: response.url || target.href,
      elapsedMs: elapsed(),
      request,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Render a curl result as the text the model sees.
 *
 * HTTP error statuses are data, not tool failures — the model gets the status
 * and body and decides what to do. Only transport-level problems become an
 * `ERROR` block.
 *
 * @param {object} result Output of `executeCurl`.
 * @returns {string}
 */
export function formatResultForModel(result) {
  if (!result.ok) {
    return [
      `TOOL ERROR (${result.error.kind})`,
      result.error.message,
      '',
      'This request did not reach the server (or its response was discarded). Do not claim it succeeded.',
    ].join('\n');
  }

  const secrets = result.request?.secrets || [];
  const lines = [
    `HTTP ${result.status} ${result.statusText}`.trim(),
    `elapsed: ${result.elapsedMs} ms`,
  ];
  if (result.redirected && result.finalUrl) lines.push(`final URL: ${maskSecrets(result.finalUrl, secrets)}`);

  const interesting = ['content-type', 'content-length', 'location', 'retry-after', 'x-ratelimit-remaining'];
  const shown = Object.entries(result.headers || {}).filter(([k]) => interesting.includes(k.toLowerCase()));
  if (shown.length > 0) {
    lines.push('headers:');
    for (const [k, v] of shown) lines.push(`  ${k}: ${v}`);
  }

  lines.push('body:');
  lines.push(maskSecrets(result.body || '', secrets));
  if (result.truncated) {
    lines.push(`[TRUNCATED at ${result.maxBytes} bytes — the response was longer than this limit.]`);
  }
  return lines.join('\n');
}
