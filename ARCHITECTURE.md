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
    stream-filter.js What the streaming bubble may show: holds back <think>
                    blocks and forming tool-call JSON. Pure, stateless.
  tools/
    curl.js         fetch wrapper: proxy, credentials, timeout, capped read,
                    error taxonomy, masking.
    api-hints.js    For the few hosts whose HTML is unreachable but whose API
                    is not: the URL that would have worked.
    wiki.js         Wikipedia lookup that takes a search term, not a URL.
                    Resolves term -> title -> summary through curl.js.
    wiki-urls.js    Wikipedia URL construction. Pure leaf, no imports, so
                    toolcall.js can derive a call's URL without a cycle.
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

The model requests a call by emitting a single fenced JSON block, naming one of
two tools:

```json
{"tool": "curl", "args": {"method": "GET", "url": "https://example.com", "headers": {}, "body": null}}
{"tool": "wiki", "args": {"query": "Alan Turing"}}
```

Schema, as enforced by `validateToolCall`:

| Field | Type | Rules |
|---|---|---|
| `tool` | string | `"curl"` or `"wiki"`. |
| `args.query` | string | **wiki only.** Non-empty search term. `q`, `search`, `term` and `title` are accepted as aliases. |
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
- For `wiki` only, `{"tool":"wiki","args":"Alan Turing"}` and
  `{"tool":"wiki","query":"Alan Turing"}` are accepted. Both say unambiguously
  what the model wants, and a repair round is another chance to get the shape
  wrong. `curl`'s validation is left strict on purpose, so that a change in the
  curl task rates can only be caused by the prompt and not by the parser.

### Why there is a second tool

Measured on Qwen3-0.6B asked to look something up (n=20, and see BUILD_LOG):
across eleven failures the **article title was correct eleven times** and the
scheme, host and path around it were wrong in ten. Four recombined a suggested
URL with their own — right host, wrong path, or the reverse.

A URL asks the model to get four things right at once. A search term asks for
the one it never gets wrong, and `wiki.js` does the rest: search resolves the
term to a real title, and the title fetches the article. The ambiguous title,
the `www` portal that answers the article API with a 500, and the redirect are
all handled where the model cannot see them.

The tool still runs its requests through `executeCurl`, so the allowlist,
timeout, byte cap, proxy and redirect checks apply exactly as they do to a
model-built request. It is a narrower interface to the same tool, not a way
around its rules. Both of its requests are logged: a tool that reached the
network more often than the log admitted would be a worse bargain than the
failure it fixes.

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

### Recovering from a network failure

"The usual cause is CORS" is true, and no model can act on it. Measured on
Qwen3-0.6B and Qwen3-1.7B, asked to look something up on Wikipedia: both
fetched the article URL, both failed, 0 out of 20 each. Told in the system
prompt that HTML is unreachable, the 0.6B stopped fetching articles and started
inventing endpoints instead. Knowing what will fail does not tell you what will
work.

So a `network` failure on a host in `api-hints.js` carries a remedy, and the
shape of that remedy is the whole finding:

- **It names a real URL, not a template.** The first version said
  "…/page/summary/Article_Title" and the model requested `Article_Title`,
  literally — the same failure as the `example.com/path` in our own schema
  block. A hint is a function of the URL that failed, so it can name the
  article that was actually asked for.
- **It ends the message.** Told the same thing in prose, the model rewrote the
  hostname, or read the URL back to the user as advice, and never called the
  tool: 0 out of 20. As a closing imperative — `NEXT STEP: call the tool again
  with exactly this URL: …` — 18 out of 20. It can copy a URL out of the user's
  message at ~100%; what it could not do was find one inside a paragraph.
- **It is withheld when it would be a guess.** `retryUrlFor()` yields an
  instruction only when the advice names one concrete endpoint. A confident
  instruction pointing at a guessed title is worse than none.
- **It costs a round-trip, deliberately.** The agent discovers the endpoint by
  trying and failing, in the open, on cards the user can see — rather than a
  hidden lookup that quietly redirects a request the user approved.

The list is small and always will be. Every entry is verified to send
`Access-Control-Allow-Origin`; the alternative is pretending to know the whole
web, and a wrong hint is worse than no hint.

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
  through WebLLM. Excluded from CI: it needs a working WebGPU device, and a
  *real* one — headless Chromium's software adapter lacks `shader-f16`, so the
  suite runs headed and its capability probe checks for the feature rather than
  for the API. It pins the model by seeding `localStorage` before the page
  boots, because `probe()` honours a persisted `modelId`; loading a model
  behind the UI's back would leave the composer disabled and let boot download
  a second, larger tier at the same time. The app is served on a fixed port so
  the origin — and therefore the weight cache — survives between runs.

- **Reliability measurement** (`npm run eval`, `scripts/tool-eval.js`) is not a
  test and has no pass/fail: it runs each task many times and reports a success
  rate with a confidence interval. It grades the *request the model built* and
  the answer it gave, in eight buckets — the distinction that matters most being
  `wrong_target`, a well-formed schema-valid call to somewhere nobody asked for,
  which `model-check.js` scores as a first-try success. The grading rules are
  pure and unit-tested in `tests/unit/eval-score.test.js`; only the driving
  needs a GPU. Task sets are split `dev`/`holdout` so a prompt cannot be tuned
  until the tasks in front of it pass without that showing up.

  Three properties exist because of specific mistakes, and are worth keeping:

  - **Every sample is stored**, so `--regrade` re-scores a saved run against the
    current task definitions with no GPU. Four graders here have mismarked
    correct behaviour, all four by imagining a phrasing the model then declined
    to use, and each fix used to cost minutes of GPU time to re-earn samples we
    already had. `--show-failures` prints what the model actually wrote, which
    is how every one of those bugs was found.
  - **Results record their provenance** — git SHA, dirty flag, and a hash of the
    system prompt. Prompt text moves these numbers more than anything else, so
    "did the prompt differ between these two files?" should be a comparison
    rather than a recollection.
  - **`--dist` serves a build from anywhere**, so measuring a change against its
    predecessor means building an old ref beside your work rather than checking
    files out over the top of it.

  A change counts as real when a two-proportion z-test says so. The earlier rule
  — non-overlapping confidence intervals — is roughly p < 0.005 and rejected
  effects that were plainly real; it survives as the stronger `emphatic` flag.

- **Prompt documentation is generated, not written.** `docs/prompts.md` mirrors
  `buildSystemPrompt()` verbatim, `npm run docs:prompts` regenerates it, and a
  unit test fails if they diverge. Maintained by hand it drifted within a single
  session, at one point describing a hint format the code had already stopped
  producing.

The e2e suite scripts the model via `?mockEngine=1&mockScript=[…]`, with
`mockLoadMs`, `mockLoadFail` and `mockCached` to hold, fail or shortcut the
simulated load. That flag
ships in the artifact, which is a deliberate trade-off — it is the only way to
test the real single file — and the app posts a visible warning whenever it is
active.
