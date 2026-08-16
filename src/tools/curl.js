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
import { apiHintFor } from './api-hints.js';

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
  CREDENTIAL_REDIRECT: 'credential_redirect',
  BAD_METHOD: 'bad_method',
  BAD_PROXY: 'bad_proxy',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  MIXED_CONTENT: 'mixed_content',
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
 * A credential that declares `hosts` is **only** substituted for a matching
 * host. Without that check the `hosts` field would scope the auto-attach path
 * while the placeholder path silently ignored it, so a prompt-injected model
 * could name any stored credential and post it anywhere.
 *
 * @param {Object<string,string>} headers
 * @param {Array<{name: string, value: string, hosts?: string[]}>} credentials
 * @param {string} [host] Target hostname, lower-case. Omit only where no
 *   request is being built (previews); omitting it enforces nothing.
 * @returns {{headers: Object<string,string>, used: string[], missing: string[],
 *            blocked: string[], secrets: string[]}}
 */
export function applyCredentials(headers, credentials = [], host = null) {
  const byName = new Map(credentials.map((c) => [String(c.name).trim().toLowerCase(), c]));
  // Null-prototype: assigning a header literally named `__proto__` to a plain
  // object hits the prototype setter and silently discards it, which would let
  // a server hide a header from the log that claims to hold the full story.
  /** @type {Object<string,string>} */
  const out = Object.create(null);
  const used = [];
  const missing = [];
  const blocked = [];
  const secrets = [];

  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = String(v).replace(CREDENTIAL_RE, (whole, rawName) => {
      const cred = byName.get(String(rawName).trim().toLowerCase());
      if (!cred) {
        if (!missing.includes(rawName)) missing.push(rawName);
        return whole;
      }
      if (host !== null && cred.hosts?.length && !cred.hosts.some((p) => hostMatches(host, p))) {
        if (!blocked.includes(cred.name)) blocked.push(cred.name);
        return '';
      }
      if (!used.includes(cred.name)) used.push(cred.name);
      if (cred.value) secrets.push(cred.value);
      return cred.value ?? '';
    });
  }
  return { headers: out, used, missing, blocked, secrets };
}

/**
 * Which credentials would this call actually use, and why?
 *
 * Computed *before* the confirmation card is shown, so approving a request is
 * an informed decision: auto-attached credentials are otherwise invisible until
 * after the user has already said yes.
 *
 * @param {{url: string, headers?: Object<string,string>}} args
 * @param {Array<object>} credentials
 * @returns {{used: string[], blocked: string[], missing: string[], host: string}}
 */
export function describeCredentialUse(args, credentials = [], proxyTemplate = '') {
  const proxyHost = proxyHostFor(proxyTemplate);
  let host = '';
  try {
    host = new URL(args.url).hostname.toLowerCase();
  } catch {
    return { used: [], blocked: [], missing: [], host: '', proxyHost };
  }
  const attached = attachHostCredentials(args.headers || {}, host, credentials);
  const substituted = applyCredentials(attached.headers, credentials, host);
  return {
    host,
    proxyHost,
    used: [...new Set([...attached.used, ...substituted.used])],
    blocked: substituted.blocked,
    missing: substituted.missing,
  };
}

/**
 * The host a configured proxy would send through, for disclosure at the
 * confirmation card.
 *
 * A proxy sees the full target URL and every header, credentials included, so
 * a card naming only the target host is actively misleading about where the
 * data goes.
 *
 * @param {string} proxyTemplate
 * @returns {string} Empty when no usable proxy is configured.
 */
export function proxyHostFor(proxyTemplate) {
  const t = String(proxyTemplate || '').trim();
  if (t === '') return '';
  try {
    return new URL(t.replace('{url}', 'URL')).host;
  } catch {
    return t.split(/[?#/]/)[0].slice(0, 60);
  }
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
 * Is this URL a "potentially trustworthy" origin in the W3C sense?
 *
 * Browsers exempt these from mixed-content blocking, so a secure page *can*
 * reach `http://localhost`. Getting this wrong in either direction would be
 * worse than not checking: refusing a request the browser would have allowed,
 * or promising one it will block.
 *
 * @param {URL} url
 * @returns {boolean}
 */
export function isPotentiallyTrustworthy(url) {
  if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
  const host = url.hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host.startsWith('127.') ||
    host === '[::1]' ||
    host === '::1'
  );
}

/**
 * Would the browser block this request as mixed content?
 *
 * A secure page cannot fetch plain `http://`, and when it refuses, `fetch`
 * rejects with the same opaque TypeError a CORS failure produces. Blaming CORS
 * there is actively misleading: the target may be perfectly CORS-enabled, and
 * the suggested fix — a proxy — only helps if the proxy itself is HTTPS.
 *
 * This is knowable before dispatch, so it is worth knowing.
 *
 * @param {URL|string} target
 * @param {string} [pageProtocol] Defaults to the current page's protocol.
 * @returns {boolean}
 */
export function isMixedContent(target, pageProtocol = globalThis.location?.protocol) {
  if (pageProtocol !== 'https:') return false;
  try {
    const url = typeof target === 'string' ? new URL(target) : target;
    return !isPotentiallyTrustworthy(url);
  } catch {
    return false;
  }
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
  const sorted = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= MIN_MASKABLE))]
    .sort((a, b) => b.length - a.length);
  for (const s of sorted) out = out.split(s).join(MASK);
  return out;
}

/**
 * Shortest secret worth masking. Below this, masking would replace ordinary
 * substrings of unrelated text and make output unreadable, so very short
 * secrets are documented as unmaskable rather than half-handled.
 */
export const MIN_MASKABLE = 3;

/**
 * Remove a trailing *partial* occurrence of a secret.
 *
 * Truncation happens at a byte boundary, so a secret straddling the limit
 * leaves an unmasked prefix that `maskSecrets` cannot match. Anything ending in
 * a prefix of a known secret is cut.
 *
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
export function stripPartialSecretTail(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < MIN_MASKABLE) continue;
    // Longest prefix first: cut as much as possible.
    for (let len = Math.min(s.length - 1, out.length); len >= MIN_MASKABLE; len -= 1) {
      if (out.endsWith(s.slice(0, len))) {
        out = `${out.slice(0, out.length - len)}${MASK}`;
        break;
      }
    }
  }
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
  const out = Object.create(null);
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? MASK : maskSecrets(v, secrets);
  }
  return out;
}

/**
 * Header rendering for the **confirmation card**, which sees the model's
 * headers *before* substitution.
 *
 * The difference from `maskHeaders` matters: there, a value is a real secret
 * and must be hidden. Here a value is usually a `{{placeholder}}`, which is not
 * a secret — hiding it would destroy exactly the information the user needs to
 * judge the request, and would do so for `Authorization` specifically, the
 * header an exfiltration attempt would use.
 *
 * So: placeholders are shown verbatim; literal values of sensitive headers are
 * masked; known secret values are masked wherever they appear.
 *
 * @param {Object<string,string>} headers Pre-substitution headers.
 * @param {string[]} secrets
 * @returns {Object<string,string>}
 */
export function previewHeaders(headers, secrets = []) {
  /** @type {Object<string,string>} */
  const out = Object.create(null);
  for (const [k, v] of Object.entries(headers || {})) {
    const value = String(v);
    const hasPlaceholder = CREDENTIAL_RE.test(value);
    CREDENTIAL_RE.lastIndex = 0; // the regex is global; reset before reuse
    if (hasPlaceholder) {
      out[k] = maskSecrets(value, secrets);
    } else if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
      out[k] = MASK;
    } else {
      out[k] = maskSecrets(value, secrets);
    }
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
 * Reduce a proxy template to something safe to show.
 *
 * A template such as `https://proxy.example/?apikey=SECRET&url={url}` carries
 * the user's own proxy key, which is not a registered credential and so is in
 * no `secrets` list. Only origin and path survive.
 *
 * @param {string} template
 * @returns {string}
 */
export function redactTemplate(template) {
  const t = String(template || '').trim();
  if (t === '') return '(none)';
  try {
    const u = new URL(t.replace('{url}', 'URL'));
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    // Not parseable — which is usually why we are here. Show only the scheme
    // and host-ish prefix, never the query string.
    return `${t.split(/[?#]/)[0].slice(0, 60)}${/[?#]/.test(t) ? '?…' : ''}`;
  }
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
      bytes: encoded.length,   // the fallback path did read it all, so this is known
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
  // `bytes` is the true size only when the whole body was read; a truncated
  // read genuinely does not know it, and null says so rather than encoding
  // "unknown" as a magic -1 that a caller might render or sum.
  return { text: new TextDecoder().decode(merged), truncated, bytes: truncated ? null : total };
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
      return 'The request was cancelled before it completed. It may or may not have reached the server, so treat its effect as unknown rather than assuming nothing happened.';
    case CurlError.MIXED_CONTENT:
      return `This page is served over HTTPS, and browsers refuse to let a secure page make plain http:// requests — the request is blocked before it is sent, whatever the target server allows. Use the https:// address of ${ctx.host} if it has one, or route the request through an HTTPS CORS proxy (an http:// proxy would be blocked in exactly the same way). Running this app over http:// locally also lifts the restriction.`;
    case CurlError.NETWORK:
      return [
        'The browser refused or could not complete the request, and it does not tell pages why.',
        'The usual cause is CORS: the target server did not send an Access-Control-Allow-Origin header that permits this page.',
        ctx.proxyConfigured
          ? 'A CORS proxy is configured and was used, so the proxy itself may be down or may not allow this target.'
          : 'No CORS proxy is configured. If the target is not CORS-enabled, set a proxy URL template in settings (e.g. https://your-proxy.example/?url={url}).',
        'Other possibilities: DNS failure, connection refused, TLS error, or the host being offline.',
        // Everything above tells you what went wrong; a model cannot act on any
        // of it. This is the only part that names a URL that would work, and it
        // appears only for hosts we have actually verified.
        apiHintFor(ctx.host),
      ]
        .filter(Boolean)
        .join(' ');
    case CurlError.INVALID_URL:
      return `"${ctx.url}" is not a valid absolute URL. Include the scheme, e.g. https://example.com/path.`;
    case CurlError.BLOCKED_SCHEME:
      return `The scheme "${ctx.scheme}" is not allowed. Only ${ALLOWED_SCHEMES.join(' and ')} URLs can be requested.`;
    case CurlError.BLOCKED_DOMAIN:
      return `The host "${ctx.host}" is not on the domain allowlist (${ctx.allowlist.join(', ')}). Add it in settings to allow this request.`;
    case CurlError.BLOCKED_REDIRECT:
      return `The request was redirected to "${ctx.host}", which is not on the domain allowlist. The response was discarded.`;
    case CurlError.CREDENTIAL_REDIRECT:
      return `This request carried a stored credential to "${ctx.host}", but the server redirected it to "${ctx.finalHost}" — a different host, which the credential was not approved for. The response was discarded. Treat the credential as potentially exposed to ${ctx.finalHost} and rotate it if the target is not one you trust.`;
    case CurlError.BAD_METHOD:
      return `Method "${ctx.method}" is not supported. Use one of: ${ALLOWED_METHODS.join(', ')}.`;
    case CurlError.BAD_PROXY:
      return `The configured CORS proxy template (${ctx.template}) produced an invalid URL. Check the proxy setting — it must be an absolute http(s) URL, e.g. https://your-proxy.example/?url={url}.`;
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
 * @param {string} [opts.pageProtocol] The page's own protocol, for the
 *   mixed-content check. Defaults to the real one.
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
    pageProtocol = globalThis.location?.protocol,
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

  // Checked before the allowlist so the more specific, more actionable
  // explanation wins when both would apply.
  if (isMixedContent(target, pageProtocol)) {
    return failure(CurlError.MIXED_CONTENT, { host }, elapsed(), {
      request: { method, url: target.href },
    });
  }

  const list = (allowlist || []).map((s) => String(s).trim()).filter(Boolean);
  if (!isHostAllowed(host, list)) {
    return failure(CurlError.BLOCKED_DOMAIN, { host, allowlist: list }, elapsed(), {
      request: { method, url: target.href },
    });
  }

  // Credentials: host-attached first, then explicit {{placeholders}}. Both
  // paths enforce each credential's `hosts` scope.
  const attached = attachHostCredentials(args?.headers || {}, host, credentials);
  const substituted = applyCredentials(attached.headers, credentials, host);
  const secrets = [...attached.secrets, ...substituted.secrets];
  const outgoingHeaders = substituted.headers;

  const requestUrl = applyProxy(target.href, proxyTemplate);
  const proxied = requestUrl !== target.href;
  try {
    // eslint-disable-next-line no-new
    new URL(requestUrl);
  } catch {
    // Only the template's shape is reported, never its expansion: proxy
    // templates routinely carry the user's own proxy API key, and this message
    // reaches the model's context and the log export.
    return failure(CurlError.BAD_PROXY, { template: redactTemplate(proxyTemplate) }, elapsed(), {
      request: { method, url: target.href },
    });
  }

  /**
   * Metadata attached to every outcome so the log always has the full story.
   * `secrets` is non-enumerable: it must be reachable by the maskers but must
   * never appear in `JSON.stringify` of a result, a hook payload or a
   * transcript entry.
   */
  const request = {
    method,
    url: target.href,
    requestUrl: proxied ? redactTemplate(proxyTemplate) : target.href,
    // Already masked. The substituted plaintext exists only in the `fetch`
    // init and in the non-enumerable fields below, so serialising a result —
    // a hook payload, a transcript entry, a log export — cannot leak a secret
    // even if the consumer does no masking of its own.
    headers: maskHeaders(outgoingHeaders, secrets),
    body: maskSecrets(args?.body ?? '', secrets) || null,
    proxied,
    credentialsUsed: [...new Set([...attached.used, ...substituted.used])],
    credentialsMissing: substituted.missing,
    credentialsBlocked: substituted.blocked,
  };
  Object.defineProperty(request, 'secrets', { value: secrets, enumerable: false });
  Object.defineProperty(request, 'rawHeaders', { value: outgoingHeaders, enumerable: false });

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
        { proxyConfigured: request.proxied, host },
        elapsed(),
        { request, detail: String(e?.message || e) }
      );
    }

    // Redirects can walk somewhere the user never approved. The browser follows
    // them before we get a say, so the check is after the fact and the remedy
    // is to discard the response rather than hand it over.
    //
    // Two rules, and the first applies even with no allowlist configured
    // (the default), because a cross-origin redirect only strips
    // Authorization/Cookie — an author-set `X-Api-Key` is forwarded to the
    // redirect target:
    //   1. credentials were sent and the final host is not the approved host;
    //   2. an allowlist is configured and the final host is not on it.
    // Skipped when proxied: `response.url` is then the proxy's URL, which is
    // never the target and would otherwise fail every proxied request.
    if (!proxied && response.url) {
      try {
        const finalHost = new URL(response.url).hostname.toLowerCase();
        if (finalHost !== host && secrets.length > 0) {
          return failure(CurlError.CREDENTIAL_REDIRECT, { host, finalHost }, elapsed(), { request });
        }
        if (list.length > 0 && !isHostAllowed(finalHost, list)) {
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
    const responseHeaders = Object.create(null);
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
    // Response headers are attacker-controlled and can reflect a credential we
    // sent (a `Location` echoing the request, say), so they are masked exactly
    // like the body.
    for (const [k, v] of shown) lines.push(`  ${k}: ${maskSecrets(v, secrets)}`);
  }

  lines.push('body:');
  lines.push(stripPartialSecretTail(maskSecrets(result.body || '', secrets), secrets));
  if (result.truncated) {
    lines.push(`[TRUNCATED at ${result.maxBytes} bytes — the response was longer than this limit.]`);
  }
  return lines.join('\n');
}
