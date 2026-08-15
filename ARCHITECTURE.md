# Architecture

How the app is put together, and why. For what it does and how to run it, see
[README.md](README.md); for the original design brief see [SPEC.md](SPEC.md).

## Shape of the thing

There is no backend. The build produces one `index.html` containing the
application, its stylesheet and the entire WebLLM runtime. At runtime the only
things it fetches are the model weights (from HuggingFace's CDN, cached by the
browser) and whatever HTTP requests the user approves.

That constraint drives most of the design: no server means no place to hide a
secret, no proxy of our own, and no way to see why a cross-origin request
failed. The app's job is to be honest about all three.

## Module map

```
src/
  agent/
    toolcall.js     Parse, validate and normalise model output. Pure.
    prompts.js      All prompt text (mirrored in docs/prompts.md).
    loop.js         Iteration loop, cap, confirmation policy, repair round.
  tools/
    curl.js         fetch wrapper: proxy, credentials, timeout, capped read,
                    error taxonomy, masking.
  llm/
    engine.js       The engine contract + WebGPU/memory capability detection.
    webllm.js       WebLLM implementation, model tiers, default-model choice.
    mock.js         Scripted engine for tests and GPU-less e2e.
    progress.js     Parses WebLLM's progress text; one monotonic bar, rate, ETA.
    storage.js      navigator.storage estimate, persistence, headroom check.
    load-error.js   Classifies a failed load and builds the debug report.
    format.js       Sizes, rates and durations for humans. Pure.
  state/
    settings.js     localStorage-backed settings, session-only credentials.
    log.js          In-memory request log, masked, JSON-exportable.
  ui/
    dom.js          The only element factory. textContent only, no innerHTML.
    chat.js         Messages, streaming, tool cards, confirmation cards.
    settings.js     Settings sheet.
    logview.js      Request log view.
    stats.js        Stats bar.
    gate.js         WebGPU capability screen.
    loading.js      Loading card, and the failure report it becomes.
    styles.css      One stylesheet, mobile-first.
  app.js            Composition root. No DOM.
  main.js           DOM wiring. No decisions.
  debug.js          Bare harness from M1; kept for reproducing engine bugs.
```

Two rules keep this honest:

- **`app.js` contains no DOM code and `main.js` contains no decisions.** The
  whole application can therefore be driven headlessly, which is what the unit
  tests and `scripts/model-check.js` do.
- **Only `src/llm/webllm.js` imports `@mlc-ai/web-llm`.** Everything else talks
  to the interface in `engine.js`.

## The engine contract

```js
capabilities()                    -> Promise<{id, label, available, reason?, streaming, needsDownload}>
load(modelId, onProgress?)        -> Promise<void>
generate(messages, options?)      -> Promise<string>   // streams via options.onDelta
stats()                           -> {prefillTokensPerSecond, decodeTokensPerSecond, totalTokens, modelId}
unload()                          -> Promise<void>
```

`assertEngine()` enforces it at wiring time, so a partial engine fails at
startup rather than three screens into a conversation.

`generate` streams by calling `options.onDelta(chunk)` and resolving with the
complete text, rather than returning an async iterator. Both satisfy
"streaming"; the callback form is what the UI actually needs, and it keeps the
final-text-vs-streamed-text distinction (thinking-mode preambles are stripped
from the former) in one place.

WebLLM adds two methods beyond the contract — `catalog()` and `isCached()` —
used only by the settings sheet, which degrades gracefully without them.

Documented but unbuilt alternatives: Transformers.js v4 (broader catalog, but
would need cross-origin isolation headers and so would cost the single-file
static-hosting guarantee) and Chrome's built-in Prompt API (zero download,
Chrome-only).

## Agent loop sequence

```
user message
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ for pass in 0..maxIterations                                │
│                                                             │
│   engine.generate(system + transcript)  ──── onDelta ──▶ UI │
│         │                                                   │
│         ▼                                                   │
│   parseToolCall(raw)                                        │
│         │                                                   │
│    ┌────┴───────────────┬──────────────────────┐            │
│    ▼                    ▼                      ▼            │
│  text               error                  tool_call        │
│    │                  │                        │            │
│    │            one repair round               │            │
│    │            (re-prompt with the            │            │
│    │             specific error)               │            │
│    │                  │                        │            │
│    │            still bad? show raw            │            │
│    │            + warning, end turn            │            │
│    ▼                                           ▼            │
│  end turn                         iteration >= cap? ──▶ end │
│  (stopReason:                                  │            │
│   TEXT)                                        ▼            │
│                                    shouldConfirm(call)?     │
│                                          │         │        │
│                                        yes         no       │
│                                          │         │        │
│                                  confirmation      │        │
│                                  card (races       │        │
│                                  cancellation)     │        │
│                                          │         │        │
│                              ┌───────────┴───┐     │        │
│                            deny          approve   │        │
│                              │               │     │        │
│                    structured denial          ▼    ▼        │
│                    → transcript          executeCurl        │
│                    (costs no iteration)       │             │
│                              │                ▼             │
│                              │      result → truncate →     │
│                              │      transcript             │
│                              └───────┬───────┘              │
│                                      ▼                      │
│                                  next pass                  │
└─────────────────────────────────────────────────────────────┘
```

Notes on the parts that are easy to get wrong:

- **The cap counts requests sent, not passes.** A refusal costs no iteration —
  denying three suggestions must not exhaust a budget meant for requests that
  actually went out. The `pass` bound still terminates the turn.
- **There is one extra pass** beyond `maxIterations`, so the model can speak
  after its last tool result rather than the turn ending on silence.
- **Exactly one repair round**, ever. No repair loops.
- **The confirmation card races the abort signal.** A user pressing Stop while a
  card is open must not leave the turn awaiting a promise the UI will never
  settle.
- **Tool results are truncated twice**: `curl.js` caps the HTTP body, and the
  loop caps the assembled result message. The second exists because the status
  line, headers and truncation marker are added on top of the first, and because
  a different tool executor might not cap at all.

## Tool-call contract

The model requests a call by emitting a single fenced JSON block:

```json
{"tool": "curl", "args": {"method": "GET", "url": "https://example.com", "headers": {}, "body": null}}
```

Schema, as enforced by `validateToolCall`:

| Field | Type | Rules |
|---|---|---|
| `tool` | string | Must be `"curl"`. |
| `args.method` | string | One of GET, POST, PUT, PATCH, DELETE, HEAD. Case-insensitive, upper-cased. Defaults to GET if absent. |
| `args.url` | string | Absolute, `http:` or `https:` only. Normalised via `new URL()`. |
| `args.headers` | object | String values. Numbers and booleans are coerced; anything else is rejected. Names are trimmed and must be non-empty. |
| `args.body` | string \| null | An object is accepted and JSON-serialised. Must be null for GET and HEAD. |

Extraction is deliberately forgiving of everything *except* the schema:

- Thinking-mode preambles are stripped. A stray `</think>` has the tag removed
  and all content kept — deleting the text around it throws away the answer.
- A fenced block is preferred; ` ```json `, ` ```tool ` and unlabelled fences
  qualify. Fences in other languages are skipped **and their spans are excluded
  from the fallback scan**, so an illustrative ` ```js ` block showing a request
  the model declined to make is never dispatched.
- Failing that, every balanced `{…}` in the text is tried, preferring one that
  mentions a `"tool"` key — prose routinely contains braces, including the
  `{{credential}}` placeholders the system prompt teaches the model to write.
- JSON that parses but has no `tool` key is **text, not a broken call**. A model
  answering a question *about* JSON must not trigger a repair round.

### Parse error codes

Stable, surfaced to the user, and fed verbatim into the repair prompt.

| Code | Meaning |
|---|---|
| `E_JSON_PARSE` | Looked like a call (mentions `"tool"`) but is not valid JSON. |
| `E_NOT_OBJECT` | Top level is not a JSON object. |
| `E_UNKNOWN_TOOL` | `tool` is not `"curl"`. |
| `E_MISSING_ARGS` | No `args` object. |
| `E_BAD_METHOD` | Method missing from the whitelist, or not a string. |
| `E_BAD_URL` | Not a non-empty string, or not an absolute URL. |
| `E_BAD_SCHEME` | Scheme is not `http:` or `https:`. |
| `E_BAD_HEADERS` | Not an object, or a value that cannot be a header. |
| `E_BAD_BODY` | Body is neither string, object nor null. |
| `E_BODY_NOT_ALLOWED` | Non-null body on GET or HEAD. |

## Tool error taxonomy

Every failure mode gets its own explanation, in both the tool result the model
sees and the log the user reads. Nothing collapses into "request failed".

| Kind | When | What the user is told |
|---|---|---|
| `invalid_url` | Not an absolute URL | The URL, and that a scheme is required. |
| `blocked_scheme` | Not http(s) | Which scheme was blocked and what is allowed. |
| `blocked_domain` | Allowlist configured, host not on it | The host and the current allowlist. |
| `blocked_redirect` | Redirected off the allowlist | The final host; the response was discarded. |
| `credential_redirect` | Credentialled request redirected cross-host | Both hosts, and advice to rotate the credential. |
| `bad_method` | Method outside the whitelist | The allowed methods. |
| `bad_proxy` | Proxy template yields an invalid URL | The template, **redacted** — it often carries the user's proxy key. |
| `timeout` | `AbortController` fired | The configured limit, and where to change it. |
| `mixed_content` | Secure page, plain `http://` target | That the browser blocks it before sending, whatever the server allows, and that only an *HTTPS* proxy helps. |
| `cancelled` | User pressed Stop | Nothing more. |
| `network` | `fetch` threw | That the browser hides the reason; that CORS is the usual cause; whether a proxy is configured; what else it could be. |
| `read_failed` | Body stream broke mid-read | The underlying message. |

HTTP error statuses are **not** in this table. A 404 or 500 is data: it reaches
the model with its status and body, and the model decides what to do.

`mixed_content` is the one failure the browser hides that we can nonetheless
identify with certainty, so it is checked *before* dispatch and surfaced on the
confirmation card as well as in the result. Left to `fetch`, it arrives as the
same opaque `TypeError` a CORS failure gives — and blaming CORS there is worse
than saying nothing, because the target may be perfectly CORS-enabled and the
suggested fix (a proxy) only works if the proxy is itself HTTPS. Localhost and
other potentially-trustworthy origins are exempt, exactly as browsers exempt
them, so pointing the agent at a local dev server still works from the hosted
site.

## Loading a model, and failing to

WebLLM reports load progress as a fraction plus a sentence, and the fraction
runs 0 → 1 **three times**: once downloading the weights, once reading them back
onto the GPU, once compiling shaders. `progress.js` parses the sentence to find
out which pass is running, weights the three onto one monotonic bar, and pulls
the byte counts out so the rate and the estimate are measured rather than
guessed. The weighting adapts: a cached model has no download pass at all, and
`isCached()` is only a hint — a partly populated cache fetches the rest — so the
tracker reweights from what actually happens.

The estimate is deliberately conservative. It is withheld for the first few
seconds, quoted only to a granularity it can defend ("about 2 minutes left"),
counted down between reports so it does not look frozen, and **withdrawn**
rather than floored at zero once the load overruns it. A silence longer than
20 s is reported as a silence, because a card that says nothing for half a
minute is otherwise indistinguishable from a hung one.

### Load error taxonomy

The failure that prompted this was `Failed to execute 'add' on 'Cache': Entry
was not found.` — Chromium's wording for a cache entry that vanished mid-write,
which says nothing about storage even though storage is nearly always the cause.
So the app measures instead of guessing: `navigator.storage.estimate()` supplies
the free quota, and the diagnosis quotes it.

| Kind | Recognised by | What the user is told |
|---|---|---|
| `storage-full` | `QuotaExceededError`, "quota exceeded" | The browser refused more data, with the measured numbers. |
| `cache-write` | "Entry was not found", `on 'Cache'` | The download worked and storing it did not; leads with the measurement when the measurement settles it. |
| `network` | "Failed to fetch", "Network response was not ok", `ERR_*` | The connection dropped; the retry resumes. |
| `gpu-memory` | "out of memory", "exceeds the max buffer size" | It downloaded but will not fit; switch model. |
| `device-lost` | `DeviceLostError` | The GPU was taken away; reload in the foreground. |
| `model-unknown` | `ModelNotFoundError` and friends | The id is not in WebLLM's catalogue. |
| `webgpu-missing` | `WebGPUNotAvailableError` | WebGPU went away mid-session. |
| `aborted` | `AbortError` | It was cancelled. |
| `unknown` | anything else | Verbatim, with everything measured at the time. |

Order matters in that table. WebLLM's IndexedDB backend wraps fetch failures in
a *"Failed to store …"* message, so a message mentioning storage can be a
network failure; the network patterns are tested first, and reading it the other
way would send someone deleting files to fix their wifi.

Two properties the diagnosis is written to keep:

- **It never advises what it cannot deliver.** The smaller-model advice names
  only tiers actually smaller than the one that failed, and the button is
  withheld when there are none — suggesting a switch to the model that has just
  failed discredits everything around it.
- **The same error gets different conclusions from different evidence.** A
  `cache-write` on a device with 300 MB free is a storage problem; the identical
  error with 59 GB free is a damaged cache, and is described as one.

Everything measured goes into a copyable report — model, phase and byte position
at the moment of failure, storage, device limits, browser, and a bounded stack.
The page URL is included as origin and path only: the report is written to be
pasted into a public tracker, and the app cannot vouch for what is in a query
string.

## Threat model

The model's output is untrusted. It can be steered by any web page the agent
fetches, so "the model asked for it" is never a reason to do something. Three
things follow.

**A secret never enters the model's context.** The model writes
`{{credential name}}`; `curl.js` substitutes the value immediately before
`fetch`. Response bodies, response *headers*, final URLs, the request echo in
the log and the JSON export are all masked. The plaintext exists in the `fetch`
init and in non-enumerable fields on the result object, so serialising a hook
payload or a transcript entry cannot leak it.

**Scope is enforced where the secret is used, not where it is configured.** A
credential with `hosts` set is withheld on both the auto-attach and the
placeholder path; the confirmation card reports what was withheld and why.

**Irreversible actions always ask.** DELETE, and any request that would carry a
stored credential, show a confirmation card regardless of the
confirm-before-send setting or an auto-approved host. A leaked long-lived token
cannot be un-leaked, so it is treated like a destructive method rather than
riding on general trust in a host.

Redirects get special handling because the browser follows them before we get a
say: the check is after the fact and the remedy is to discard the response. A
cross-origin redirect strips `Authorization` and `Cookie` but *not* an
author-set `X-Api-Key`, so a credentialled request that lands on a different
host is always refused.

Known and accepted limits:

- Secrets shorter than 3 characters are not masked; masking them would replace
  ordinary substrings everywhere.
- Masking is literal. A server that base64s or re-encodes a credential before
  reflecting it defeats it.
- `localStorage` is plaintext. This is stated in the settings sheet, and
  "session only" credentials exist for anything that matters.
- The app is same-origin with every other page on its host. On GitHub Pages that
  means every other project on `<user>.github.io`. Use a dedicated host, or
  session-only credentials, if that matters to you.

## UI

Vanilla JS, no framework, one stylesheet.

`ui/dom.js` is the only element factory and it sets text exclusively via
`textContent`. There is no `innerHTML` path anywhere under `src/ui/`, because
model output, response bodies and header values are all attacker-influenceable.

Layout is mobile-first: the base rules give the phone layout (chat full-screen,
settings and log as slide-over sheets stopping 3rem short of the edge so
tap-outside-to-close works), and a single `min-width: 60rem` breakpoint promotes
the sheets into a permanent side rail. Colours are tokens redefined under
`prefers-color-scheme`.

## Testing strategy

- **Unit (Vitest, no browser).** Every module outside `src/ui/` and `main.js`.
  Dependency injection throughout — `fetchImpl`, `storage`, `navigator`,
  `importWebLLM`, `now` — so nothing needs a browser or a network. A 90%
  coverage gate on statements, branches, functions and lines.
- **`tests/unit/security.test.js`** pins every finding from the adversarial
  reviews, named after the finding, so a regression fails with an obvious
  message rather than a puzzling one.
- **E2E (Playwright).** Runs against the built `dist/index.html`, not the dev
  server, so what is tested is what ships. A local server with permissive CORS
  is the tool's target and keeps a receipt log, so assertions can prove a
  request really arrived. Two device profiles: desktop 1280px and Pixel 7.
- **Real-model e2e** (`npm run test:e2e:real`) drives the actual Qwen3-0.6B
  through WebLLM. Excluded from CI: it needs a working WebGPU device.

The e2e suite scripts the model via `?mockEngine=1&mockScript=[…]`. That flag
ships in the artifact, which is a deliberate trade-off — it is the only way to
test the real single file — and the app posts a visible warning whenever it is
active.
