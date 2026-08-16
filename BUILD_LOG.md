# Build log

Chronological record of building the project described in [`SPEC.md`](SPEC.md).
Each milestone ends with an adversarial review whose findings are recorded here
and fixed before the milestone is closed.

---

## M1 — Core loop headless

**Goal (SPEC §11.1):** engine interface + WebLLM implementation, tool-call
parser, curl tool, agent loop; unit tests green; bare debug page.

### Built

| Module | Purpose |
|---|---|
| `src/agent/toolcall.js` | Extract, validate, normalise and repair model tool calls. Pure. |
| `src/agent/prompts.js` | System / repair / denial / cap prompt text. |
| `src/agent/loop.js` | Iteration loop, cap enforcement, confirmation policy, repair round. |
| `src/tools/curl.js` | `fetch` wrapper: proxy, credentials, timeout, byte-capped streaming read, error taxonomy. |
| `src/llm/engine.js` | Engine contract + `detectCapabilities` (WebGPU/memory gate). |
| `src/llm/webllm.js` | WebLLM implementation, model tiers, default-model selection. |
| `src/llm/mock.js` | Scripted engine for unit tests and GPU-less e2e. |
| `src/state/settings.js` | localStorage-backed settings, session-only credentials, migrations. |
| `src/state/log.js` | In-memory request log with masking and JSON export. |
| `src/app.js` | Composition root (no DOM). |
| `src/debug.js` + `index.html` | Bare debug page. |

### Verification

- **289 unit tests pass** (`npm test`).
- **Coverage: 97.7% statements, 94.0% branches** against a 90% gate.
- `npx vite build` produces a single self-contained `dist/index.html` (6.1 MB, 2.2 MB gzip) with no sibling assets.

### Decisions and deviations from the spec

1. **Tool results are fed back as `user`-role messages**, not a `tool` role.
   The JSON-block contract (§5.1) does not use native function calling, and
   small chat templates handle a plain user turn far more reliably. The
   `TOOL RESULT` marker is named in the system prompt so the model can see the
   boundary.
2. **Credentials use `{{name}}` placeholders.** The model writes the
   placeholder; `curl.js` substitutes the secret immediately before dispatch.
   The consequence is that a stored secret never enters the model's context,
   which is stronger than §7 requires.
3. **Spec §4.1 is now stale.** It justifies Qwen3 on the grounds that
   "Qwen3.5/Gemma 4 [are] not yet compiled". As of `@mlc-ai/web-llm` 0.2.84 the
   catalog *does* contain `Qwen3.5-2B/4B/9B`. The spec'd Qwen3 tiers remain the
   defaults (they are what the tier table was written against, and all three are
   flagged `low_resource_required`), and the Qwen3.5 builds are offered in the
   picker as an opt-in.
4. **Object bodies are accepted and serialised** rather than rejected. Models
   routinely emit `"body": {...}` instead of a string; burning a repair round on
   it helps nobody.
5. **`GET`/`HEAD` with a non-null body is rejected** (`E_BODY_NOT_ALLOWED`)
   rather than silently stripped, so the repair round can correct the model's
   intent instead of hiding it.

### Bugs found and fixed during M1

- **Cancelling with a confirmation card open hung the turn forever.** The loop
  awaited the UI's promise unconditionally; a user pressing stop left `running`
  true and the app wedged. Fixed by racing the confirmation against the abort
  signal (`abortedDecision()`), with a regression test.
- **Body-cap truncation flag was wrong on a chunk boundary.** Caught by test;
  the implementation was correct and the test expectation was fixed.

---

## M1 adversarial review

Three independent reviewers, each told to break the code rather than praise it:
a **security** pass (threat model: the model's output is untrusted and may be
prompt-injected by fetched content), a **correctness** pass, and a
**spec-compliance** audit. All three proved their findings by executing code.
The 319 tests passing at the time caught none of them.

### Critical — fixed

1. **A stored credential could be exfiltrated to any host.**
   `applyCredentials` matched credentials by name only, ignoring the `hosts`
   scope that `attachHostCredentials` enforced — and the system prompt hands the
   model every credential *name*. An injected page could therefore make the
   model emit `{"headers": {"X-Z": "{{github}}"}}` pointed at an attacker and the
   token went with it. `hosts` is now enforced on both paths; a withheld
   credential is reported as `credentialsBlocked` and shown on the card.

2. **`stripThinking` could delete the entire reply.** A stray `</think>` — which
   Qwen3 produces routinely by doubling its closing tag — caused everything
   before it to be dropped. The user got a blank bubble; a tool call in that
   reply vanished with no repair round and no notice. Stray closers now have the
   tag removed and all content kept.

3. **An illustrative code fence was dispatched as a real request.** The fence
   scanner skipped a ```js block, then the raw-text fallback found the `{`
   *inside the block it had just rejected*. A model explicitly declining to make
   a request ("You would write: … But I will not do that.") had that request
   proposed anyway. Fence spans are now excluded from the fallback scan.

### High — fixed

4. **Response headers were never masked**, so a server reflecting a credential
   into a header (`Location: /next?leak=<token>`) fed it to the model, the chat
   card, the log and the export. Masked in all four now.

5. **A cross-host redirect carried credentials off-site.** The redirect check ran
   only when an allowlist was configured — which is not the default — and the
   browser strips only `Authorization`/`Cookie`, so an author-set `X-Api-Key`
   followed the redirect. Any credentialled request redirected to a different
   host is now discarded with an explanation that says to rotate the credential.

6. **Auto-approving a host auto-approved credentialled requests to it.** The
   natural flow — read an attacker's page, approve once, tick "auto-approve" —
   let injected instructions attach a stored token to a follow-up with no
   prompt. A request that would use a credential now always shows the card.

7. **Denials never reached the log.** `app.js` looked for "the last pending
   entry", but a denied call is refused *before* dispatch, so no entry existed;
   with a stale pending entry it marked the *wrong* request denied. The entry is
   now opened when a call is proposed and settled, denied or released explicitly.

### Medium / low — fixed

8. Auto-attached credentials were invisible at confirmation time; the card now
   names them via `describeCredentialUse`.
9. The confirmation card masked `{{placeholders}}` — hiding exactly the
   information needed to judge a request, and specifically for `Authorization`.
   `previewHeaders` now shows placeholders and masks only real secrets.
10. An allowlist plus a proxy failed *every* request as `blocked_redirect`
    (the observed final URL is the proxy's), pushing users to disable the
    allowlist. The post-hoc check is skipped when proxied.
11. The proxy template — which often carries the user's own proxy API key —
    was echoed into the model's context and the log. Now redacted.
12. Plaintext secrets rode along in the result object; `JSON.stringify` of a
    hook payload or transcript entry leaked everything. `headers` and `body` on
    the result are pre-masked and the raw values are non-enumerable.
13. Session-only credentials could be written to disk two ways: round-tripping
    `get().credentials` through `set()`, and a patch key explicitly set to
    `undefined`. The invariant is now enforced in `sanitize` itself.
14. `totalTokens` double-counted whenever a stream carried no usage chunk, and
    never reset across model switches.
15. **The thinking-mode toggle did nothing.** It reached the prompt text but not
    `engine.generate`, so reasoning was always disabled. Plumbed through the
    engine contract.
16. A throw from the tool or the confirmation handler ended a turn with no
    `stopReason` and no `onTurnEnd`; both are now caught as `TOOL_ERROR`.
17. One abort listener leaked per confirmation card.
18. Refusals consumed the tool-call budget and the cap notice then claimed the
    agent "made 3 tool calls" when it had sent none. Refusals are counted
    separately and reported honestly.
19. An unparseable numeric setting reset the preference to its factory default
    instead of keeping the current value.
20. `clampIterations(0)` returned 5; it now clamps into range.
21. SPEC §5.3 truncation was only enforced inside the tool, not on the tool
    *result*; `truncateForModel` now bounds what reaches the transcript.

### Accepted, not changed

- `generate` streams via an `onDelta` callback and returns the final string,
  rather than being an async iterator. §4.3 says "streaming" without fixing the
  shape; the callback form is what the UI needs.
- Very short secrets (< 3 characters) are documented as unmaskable rather than
  half-masked — masking them would replace ordinary substrings everywhere.

**50 regression tests** covering every finding above live in
`tests/unit/security.test.js`, named after the finding they pin down.

---

## M2 — UI

Chat pane, settings sheet, stats bar, request log and the confirmation flow, in
vanilla JS with no framework.

- **No `innerHTML` anywhere in `src/ui/`.** Model output, response bodies and
  header values are all attacker-influenceable, so `ui/dom.js` is the only
  element factory and it sets text via `textContent` exclusively.
- Mobile-first CSS: the phone layout is the base, and one `min-width: 60rem`
  breakpoint promotes the settings and log sheets into a permanent side rail.
- Successful tool cards collapse to their summary line; failures stay open.
  Response headers show the notable ones with the rest behind a disclosure.
- Confirmation cards are full-width and thumb-sized on a phone, name any
  credential the request would carry, and show placeholders rather than masking
  them.

### Verification

- **371 unit tests**, 12 Playwright scenarios green against the built artifact.
- Screenshots checked at 1280×860 (light and dark) and 390×844 (mobile).

---

## M3 — Hardening

Spec §11.3 items, most of which landed during the M1 review fix pass. What M3
added on top:

- **`scripts/model-check.js`** — the tool-call reliability comparison SPEC §11.1
  asks for, as a runnable harness. It drives the built artifact in a real
  browser across the three tiers and reports first-try calls, repairs, hard
  failures and spurious calls. **It has not been run:** WebLLM is WebGPU-only
  and this build machine has no GPU adapter, so the script exits with a clear
  error rather than reporting zeros. The unverified "best tool-calling
  reliability" claim has been removed from the tier table until someone runs it
  on a GPU.
- **`scripts/serve-dist.js`** — `npm run serve:dist` was advertised in
  `package.json` and did not exist.
- **The mock engine announces itself.** `?mockEngine=1` ships in the artifact so
  the e2e suite can drive the real deliverable; it now posts a warning notice so
  scripted replies can never be mistaken for the model.
- **Coverage gate is honest and green.** `app.js` had no tests at all while the
  gate claimed to cover it; 20 tests later the thresholds pass for real
  (96.8% statements, 90.4% branches, exit code 0).
- `readBodyCapped` reports `bytes: null` rather than a magic `-1` when a
  truncated read genuinely does not know the size.

### Bugs found by the M3 e2e suite

1. **The app shell rendered behind the WebGPU capability gate.** `#app[hidden]`
   stayed visible because `.app { display: flex }` outranks the UA's
   `[hidden] { display: none }`. The gate is supposed to replace the app, and
   instead it stacked with it — exactly the "never a blank page or a
   console-only failure" case §2.2 calls out. Fixed with an explicit
   `[hidden] { display: none !important }`.
2. **Buttons inside composite settings groups had garbage accessible names.**
   `field()` wrapped the whole credentials block in a `<label>`, so the first
   control in it — the "Reveal" button — was announced as the entire section
   including the plaintext-storage warning. Composite groups now use
   `role="group"` with `aria-labelledby` instead of an implicit label.
3. **Tap-outside-to-close was impossible on a phone.** The sheet was full-width,
   putting the scrim entirely behind it, so the only exit was the Close button.
   Sheets now stop 3rem short of the edge — the standard nav-drawer affordance.

### Verification

- 393 unit tests; coverage gate green.
- 30 Playwright scenarios across two device profiles (desktop 1280px, Pixel 7),
  all against the built single-file artifact.

---

## M3 adversarial review — UI and injection

A reviewer told to break the UI layer, with hostile model output injected via
the scripted-engine URL flag and hostile HTTP responses from the test server.

### Critical — fixed

1. **The confirmation gate could be defeated by the user's own Enter key.** The
   card auto-focused **Approve**, and it appears a few hundred ms after Enter
   sent the message — so the reflex second Enter, or a key repeat, dispatched a
   request nobody looked at. Proved with a `DELETE`: the request reached the
   server, status 200, without the user aiming at anything. The
   always-confirm-because-irreversible case had the irreversible action on the
   default-focused button.
   Fixed two ways: **Deny** now takes focus, so a stray keystroke does the
   reversible thing, and Approve stays disabled for 600 ms after the card opens.

### High — fixed

2. **The card lied about where a request and its credential were going.** With a
   CORS proxy configured, the URL is rewritten *after* approval, and the card
   named only the target host: "Approve only if you trust example.invalid with
   it" — while the proxy host received the full URL and the token in plaintext.
   The card now names the proxy and says explicitly that it sees every header.
3. **Host spoofing at the decision point.** `.confirm-head strong` had no
   `overflow-wrap`, so `https://api.github.com<200 chars>.evil.example` rendered
   2290px wide in a 1280px viewport: the reassuring prefix visible, the
   registrable domain off-screen, no clipping cue. Now wraps.

### Medium / low — fixed

4. A cancelled call left its chat card reading "sending…" forever while the log
   correctly said "denied" — the two surfaces contradicting each other about
   whether a request had been sent. `onTurnEnd` now settles any open card.
5. "Auto-approve this host" ignored scheme and port, so approving
   `https://example.com` silently authorised `http://example.com` (a plaintext
   downgrade) and `http://example.com:8080/admin`. Keyed on full origin now.
6. Streaming bubbles were orphaned by a repair round, a cancellation or an
   engine error — left with a live blinking caret implying generation was still
   running — and the *next* user message then retroactively deleted the partial
   answer from the history. `settleStream()` finalises a bubble in place; an
   interrupted reply is marked as such instead of being silently rewritten.
7. The settings sheet rebuilt itself on any change, destroying half-typed input
   (including a pasted API token), scroll position and focus. Drafts, scroll and
   caret position now survive a re-render.
8. Reloading the model mid-turn hid the Stop button and re-enabled the composer
   while the turn was still running, leaving no way to cancel and running
   `engine.load()` underneath an in-flight `generate()`. It now cancels first.
9. Enter bypassed the disabled Send button, so a turn could be started during
   the multi-minute first model download.
10. A response header literally named `__proto__` was invisible in the log, the
    export and the model's transcript — a free "hide one header from the audit
    trail" primitive against a log that claims to hold the full story. Header
    maps are now null-prototype. (No pollution was possible; the value was
    simply dropped.)

### Held up under attack

The reviewer's executed sweep — hostile model prose, hostile final answers,
hostile response bodies and hostile response headers, all carrying
`<img onerror>`, `<script>` and `javascript:` payloads, viewed in both the chat
and the log — produced zero injected nodes. The "no `innerHTML` in `src/ui/`"
claim holds, `el()` is not attribute-injectable, and a `Location: javascript:…`
header renders as inert text. Confirmation double-resolve and stale approval
were both unreachable; number inputs cannot produce `NaN` or wedge a value.

### Also changed

The confirmation card now de-emphasises everything but the last three labels of
a hostname. A deceptive prefix reads as trustworthy left-to-right, and
left-to-right is how people read; pulling the eye to the tail is where the truth
is. It is emphasis, not truncation — the full host is always rendered, and the
split rule is a pure function so it is tested without a DOM.

### Verification

- 419 unit tests, 39 Playwright scenarios, coverage gate green
  (97.6% statements, 91.4% branches).
- Nine new e2e regressions cover the Enter bypass, the Approve arming delay,
  proxy disclosure, sub-domain wrapping, the cancelled-card contradiction, caret
  orphaning, history preservation, settings-draft survival and the pre-load
  Enter guard.

---

## M4 adversarial review — test quality

The most useful review of the four. A reviewer ran ~100 targeted mutations
against `src/`, checking whether the suite that was passing would actually
notice each one. Its verdict on the core was reassuring — all 18 mutations to
`curl.js`'s security logic died, as did all 16 to `toolcall.js`, the
`shouldConfirm` policy and the iteration cap — and the shuffle/isolation runs
found no order-dependence. The weaknesses were all at the edges.

### Tests that could not fail

Four tests were structurally incapable of failing, and one asserted the
opposite of its own name:

1. **`sanitize` "fills every default"** compared the function's output against
   the very constant it copies, so it passed for *any* value of `DEFAULTS`.
   This single tautology is why seven default-value mutations survived —
   including flipping **confirm-before-send to off**, the spec's headline
   security default. Replaced with a literal, spelled-out expectation.
2. **`clampIterations`** used the constants as its own expected values. Now
   literal, with the spec's numbers pinned separately.
3. **"does not leak an abort listener per confirmation"** watched for Node's
   `MaxListeners` warning, which fires at 10 — with five confirmations it could
   never trigger, leak or no leak. Now counts `addEventListener`/
   `removeEventListener` on `AbortSignal` directly and asserts they balance.
4. **"does not remember a host it cannot parse"** used a perfectly valid URL and
   asserted the success path. Deleted: the branch it named is covered directly
   by `originOf`, and there is no honest way to reach it through the loop.
5. **"tolerates a confirm handler returning undefined"** asserted only that
   nothing was sent — it stayed green when the loop threw a `TypeError` and
   ended the turn as `tool_error`. Now asserts the turn completes normally and
   the model is told it was denied.

Two e2e tests were similarly hollow: the log-export test asserted only the
*filename* — never that the file was JSON, never that anything was masked, and
it configured no credential so there was nothing to mask; and the `file://`
notice test never loaded a `file://` origin, asserting only that the notice
stays hidden over HTTP. Both now do the thing their names claim.

### Mutations that survived the entire apparatus

Seven changes passed both the unit suite and all 30 e2e scenarios. Four were in
`app.js` — the composition root, where every setting meets the tool, sitting at
48% branch coverage behind `toolcall.js`'s 99%:

- **The CORS proxy could be disconnected entirely** and everything stayed green.
  `curl.js`'s proxy logic was well tested in isolation; that the *setting*
  reached it was tested by nothing.
- **The abort signal could be dropped**, so Stop could not cancel an in-flight
  request. Every cancellation test cancelled at the confirmation card, never
  mid-fetch.
- The timeout, byte cap and credential list could all be disconnected the same way.

`app.js` now has tests asserting each setting reaches `executeCurl` — verified
against a spy `fetchImpl`, including one that hangs the request so cancellation
is exercised where it actually matters.

### Also closed

- **Per-file coverage thresholds.** The 90% gate was global-only, which is what
  let `app.js` hide. Now `perFile: true`; `app.js` is at 100% statements / 80%
  branches.
- **Error message text is asserted for all 11 `CurlError` classes**, not just
  the `kind`. Five previously asserted only the code, so the prose SPEC §6.3
  makes a first-class requirement could be replaced with `'x'` unnoticed. Doing
  this surfaced that the `cancelled` message really was too terse to be useful;
  it now says the request may or may not have reached the server.
- **Prompt text has its own test file.** SPEC §10 calls it load-bearing, and it
  was untested: the iteration budget, the allowlist disclosure and the
  "do not emit reasoning" line could each be deleted silently.
- **`POST` with a body and both redirect defences are now exercised in a real
  browser.** The redirect rules rest on `response.url` being populated after a
  followed 302 — an assumption about browser behaviour that unit tests could
  only assert against a hand-rolled fake. The test server had a `/redirect`
  route that no e2e test used.
- The `readBodyCapped` "unknown size" contract, `log.requestBody`, the live
  iteration counter, the post-request abort check, and settings being re-read
  each pass all now have assertions.

### Verification

- **474 unit tests, 43 Playwright scenarios**, per-file coverage gate green
  (97.9% statements, 92.4% branches overall).
- Every mutation the reviewer proved survivable was re-run against the new
  suite. All now fail the build.


---

## Final state

All four milestones from SPEC §11 are built, reviewed and verified.

| | |
|---|---|
| Unit tests | 474, per-file coverage gate green (97.9% statements, 92.4% branches) |
| End-to-end | 43 Playwright scenarios, desktop 1280px and Pixel 7, against the built artifact |
| Build | one self-contained `dist/index.html`, 6.1 MB (2.2 MB gzipped) |
| CI | unit suite gates the build; the single-file property is asserted, not assumed |

### What the reviews cost and bought

Four adversarial rounds found **44 real defects** across security, correctness,
spec compliance, UI and the test suite itself. Not one was caught by the tests
passing at the time. The pattern is worth recording:

- **The bugs clustered at the seams**, not inside modules. Credential scoping
  was enforced on one code path and not its twin; the proxy setting was
  well-tested and so was the proxy code, but not the wiring between them;
  `curl.js` masked bodies and not headers. Every module was individually
  defensible.
- **The security decision point attracted the worst of them.** The confirmation
  card auto-focused Approve so the reflex second Enter dispatched a `DELETE`;
  it masked the `{{placeholder}}` the user needed to see while showing the
  literal token it should have hidden; it named the target host while the data
  went to a proxy; and a long sub-domain pushed the real domain off-screen.
- **A test suite is not evidence until something has tried to break it.** 474
  tests and a 90% gate coexisted with a tautology that made the spec's headline
  security default unassertable, and with `app.js` — where every setting meets
  the tool — at 48% branch coverage.

### Not verified

Two things are written, wired and unrun, because this machine has no GPU:

- **`npm run test:e2e:real`** — the real-model suite against Qwen3-0.6B. It
  skips with an explicit reason rather than passing vacuously, distinguishing
  "no WebGPU adapter" from "cannot reach the model CDN".
- **`node scripts/model-check.js`** — SPEC §11.1's tool-call reliability
  comparison across the three tiers. The unsubstantiated "best tool-calling
  reliability" claim has been removed from the tier table until someone runs it.

Everything green above was run against the built single-file artifact, not the
dev server.

---

## Post-release: the first real failure on a real phone

The deployed app was tried on an Android phone that was nearly full. It reached
about 65% and then showed:

> The model could not be loaded: Failed to execute 'add' on 'Cache': Entry was
> not found.. Check the model id in settings, your connection, and that this
> device has enough memory.

Two separate failures of the app, neither of them in the code that broke.

**The message named none of the three things it listed.** "Entry was not found"
is Chromium's wording for a cache entry that disappeared while it was being
written into — which happens when the device runs out of room and the browser
evicts what it has just stored. The app had `navigator.storage.estimate()`
available the whole time and never asked it. It could have said "this site has
307 MB left and this model needs about 1 GB"; instead it offered three
possibilities and committed to none, which is barely better than silence. The
doubled full stop, from interpolating a message that already ended in one, was
the least of it.

**Sixty-five per cent of what?** WebLLM's progress fraction runs 0 → 1 three
times — downloading, uploading to the GPU, compiling shaders — and the app was
rendering it straight into a corner of the stats bar. So the number was
ambiguous, the bar it was not attached to would have snapped back to empty
twice, and there was no rate, no total and no estimate. On a phone, on mobile
data, with several minutes to wait, that is the entire user experience.

### What changed

`llm/progress.js` parses WebLLM's progress sentences, maps the three passes onto
one monotonic bar with adaptive weighting, and derives the total, the rate and
the estimate from the byte counts. `ui/loading.js` renders that as a card with
the phase in words, bytes against total, MB/s, time left and time so far,
ticking on a 250 ms timer between the engine's per-shard reports.

`llm/storage.js` measures the quota, requests persistent storage, and checks
headroom *before* the download rather than after it fails. `llm/load-error.js`
classifies the failure and quotes the measurement back. The failure card offers
retry (which resumes), a smaller model (only ones actually smaller), clearing
the dead partial download, and a copyable debug report.

### What the reviews found

Five defects, three of them mine from this change, none caught by the tests that
were passing at the time:

- **The bar was full before anything downloaded.** `baseFor(PHASE.INIT)` fell
  through its loop and returned the sum of every weight — 1.0. "Start to fetch
  params", the first thing WebLLM says, therefore filled the bar, and the entire
  download then ran behind a bar reading 100%. Sixteen unit tests covered the
  tracker and every one of them started from a phase that was not `init`. The
  e2e suite caught it on its first run, which is the argument for having one.
- **The advice suggested the model that had just failed.** With Qwen3 1.7B
  failing, the card said "choose a smaller model — Qwen3 1.7B needs about 1 GB".
  The advice was a hardcoded sentence rather than a function of the situation.
- **The decisive sentence was last.** The explanation opened with two sentences
  about Chromium's cache internals and closed with the storage figures. On a
  phone that puts the only sentence that answers "why did this happen" below
  where anyone reads to. It now leads when it is decisive, and stays second when
  the measurement exonerates storage.
- **Switching model mid-download interleaved two loads into one card.** The
  composer is disabled while loading; the settings sheet is not. The first
  load's callbacks kept firing into the card the second had built. Fixed with a
  sequence guard.
- **A stalled estimate lied indefinitely.** The countdown floored at zero, so a
  download that stopped showed "a few seconds left" for as long as you cared to
  watch. It is now withdrawn on overrun, and a silence over twenty seconds is
  reported as a silence.

The pattern from the earlier rounds held: the bugs were at the seams — between
the tracker and the phase it started in, between the advice and the model it was
advising about, between two loads that were never meant to overlap.

### Verified

- 604 unit tests; per-file coverage gate met.
- 58 Playwright scenarios against the built artifact, including twelve for the
  loading card and the failure report, and two on a Pixel 7 profile.
- The reported error is reproduced verbatim — name, message and all — through
  `?mockLoadFail=cache`, so the diagnosis is tested against the real string
  rather than a paraphrase of it.

Still unverified, unchanged from before: nothing here has been exercised against
a real GPU. The failure path was reproduced from the error text, not from a
device that ran out of space.

---

## Post-release: the first run on a real GPU

The previous entry closed with "nothing here has been exercised against a real
GPU". This one is that run. Everything below was found on the way to a green
`npm run test:e2e:real` on an Apple M-series machine, and none of it was in the
product: the app behaved correctly at every step, including turning a CDN
failure into an honest skip. All four defects were in the suite meant to test
it.

### Why it had never passed anywhere

**Headless Chromium cannot run these models at all.** It exposes a WebGPU
adapter, so the suite's `requestAdapter()` check said yes — but the adapter is
SwiftShader, and SwiftShader has no `shader-f16`. Every `q4f16_1` build in the
catalogue needs that feature, so the run could only ever fail from somewhere
deep inside WebLLM, and the skip guard that existed to prevent exactly that
outcome waved it through. Measured on this machine:

```
headless  {"adapter":true,"arch":"swiftshader","f16":false}
headed    {"adapter":true,"arch":"metal-3",   "f16":true}
```

The suite now runs headed, and the probe asks for the feature rather than for
the API.

**The 15-minute allowance never applied to the download.**
`test.describe.configure({timeout})` governs tests, not hooks — and the hook is
where the 0.4 GB download happens. It ran under the config's 60 s and was killed
mid-load every time. `test.setTimeout()` inside the hook is the fix.

**The suite loaded one model while the app downloaded another.** Setup
navigated to the page and then called `engine.load('Qwen3-0.6B')` directly. But
`boot()` had already started loading whatever tier this device would pick by
default — 4B, 2.5 GB — and `modelLoaded` is UI state that only `main.js` sets,
so the composer stayed disabled no matter which load finished. The symptom was a
blank page, a dead Send button and 2 GB of traffic for a model nobody asked for.
`probe()` already honours a persisted `modelId`, so the fix is to seed
`localStorage` before the page boots and let the app load its own model through
its own path — then wait for the outcome the user would see: a live composer, or
the failure card.

**The persistent profile was never reused.** `startStaticServer()` binds an
ephemeral port, and browsers partition the weight cache by origin. Every run was
therefore a new origin, a cold cache, another 0.4 GB, and an orphaned copy of
the last one — `.playwright-profile` had reached 2.7 GB of weights that nothing
could ever read again. The suite now pins the app to port 43117.

### What the run then found

With the suite fixed, two consecutive runs of the same commit disagreed. In one,
the model was asked for `http://127.0.0.1:<port>/json` and proposed
`https://example.com/path` — verbatim the example URL from the system prompt's
schema block. In the next, all five scenarios passed.

Both results are true. A 0.6B model at temperature 0.6 is a distribution, and
one sample per behaviour measures a draw from it rather than the behaviour. The
suite is still worth having — it proves the contract *can* hold end to end,
which is what an e2e test is for — but "does the tool contract hold" is a
question about a rate, and answering it needs a different instrument.

Which also exposed a gap in the instrument we have. `scripts/model-check.js`
scores a sample as a first-try success on `result.iterations > 0` — it never
looks at the request the model built. The exact failure above (well-formed JSON,
valid schema, wrong URL) counts as a clean pass.

### And one more, found by fixing the last one

Pinning the port made runs repeatable, and a repeatable run promptly failed
twice in the same place: the dead-port scenario, where the turn simply never
ended. After the request to the dead port fails, the model quite reasonably
proposes another one — within its iteration cap — and the test approved exactly
one card. The second card sat there unanswered, the loop waited on a promise
nobody would settle, and the failure surfaced 120 seconds later as "Stop is
still visible", which says nothing about what happened.

How many requests a model makes for one message is not a contract we can
assert. The scenarios now answer every card the turn raises and let the cap end
it, and the dead-port assertion checks that *every* failed attempt carries the
explanation rather than that there was exactly one.

### Verified

- 640 unit tests.
- `npm run test:e2e:real`: five scenarios green against a real Qwen3-0.6B on
  Metal — cold start, a tool round-trip whose request the test server confirms
  receiving, a denial that sends nothing, the CORS explanation on a dead port,
  and non-zero throughput stats.
- The origin fix, measured: 9.4 minutes cold, 2.2 minutes warm, on runs that
  before it were 4.7 minutes *every* time.

---

## Post-release: measuring the model instead of guessing at it

Two runs of the same commit disagreed about whether the model builds the right
request. That is not a flaky test, it is a badly posed question: a 0.6B model at
temperature 0.6 is a distribution, and one sample is a draw from it. "Does the
tool contract hold" has to be answered as a rate.

`scripts/model-check.js` could not answer it either. It scores a sample on
`iterations > 0` and never looks at the request the model built, so a
well-formed, schema-valid call to the wrong host counts as a first-try success —
which is exactly the failure that had been observed.

### The instrument

`scripts/tool-eval.js` grades the request that was actually built and the answer
actually given, in eight buckets, and reports a rate with a Wilson interval.
Overlapping intervals are called inconclusive, which is a stricter bar than a
significance test and the right one when every accepted change ships in a
prompt. Task sets are split `dev`/`holdout`. The grading rules are pure and
unit-tested; only the driving needs a GPU.

**It was wrong twice before it was right, both times in the model's favour.**

- `wiki-telephone` asked who invented the telephone and pointed at the
  "Telephone" article, whose summary never mentions Bell. Twenty correct fetches
  scored as twenty wrong answers.
- `wiki-clifton` asked which engineer designed the bridge. The source says
  Barlow and Hawkshaw, "based on an earlier design by Brunel"; the model
  answered Barlow and Hawkshaw and was marked wrong six times out of six.

Hence `oracleUrl` and `scripts/eval/verify-tasks.js`, which fetches each task's
source and prints the sentence the expected answer sits in. Presence is not
sufficiency, and no automated check can decide that — but a human reading one
sentence can.

### What it found

**Handing it a URL is not the problem.** Given one, the model reproduces it,
fetches it, reads the JSON and answers: 100% across the hermetic tasks, and 20
out of 20 on a Wikipedia REST endpoint.

**Finding a URL was.** Asked to look something up on Wikipedia, Qwen3-0.6B
fetched the article page — which browsers refuse cross-origin — 0 out of 20.
Qwen3-1.7B did the same, 0 out of 20, more consistently. Three times the
parameters, identical failure: not a capability gap, a missing fact.

Four changes, each measured:

| Change | Effect |
|---|---|
| Tell it CORS blocks HTML, prefer JSON APIs | 0% → 0%. Failure moved: it stopped fetching articles and started inventing endpoints |
| Supply the endpoint in the failure message | 0% → 0%. It reported the failure instead — obeying "report the failure honestly", which was the only instruction on the subject |
| Lead with the remedy; say to act on it first | 5% → 15%. Intervals overlapped: inconclusive |
| End the message with `NEXT STEP: call the tool again with exactly this URL: <url>` | **0% → 90%** |

The last one is the finding. It can copy a URL out of the user's message at
~100%; it could not find one inside a paragraph of English in a tool result.
What was missing was not a better sentence but an instruction, as a value rather
than as prose, in the position the model attends to — the same reason "Do not
claim it succeeded." was put last and works.

The first version of that hint said "…/page/summary/Article_Title", and the
model requested `Article_Title`, literally. A placeholder in front of a small
model is something to copy.

### What the holdout found

`local-query` — "fetch {base}/status/503", never used while iterating — scored
5%. In 17 samples out of 20 the model sent `https://example.com/status/503`:
the URL from our own schema example. The dev set contained only "GET
{base}/status/404", which scores 100%; one word of phrasing separated a
perfect task from a broken one, and only the holdout could see it.

That is the same substitution that produced the first failure the real-model
suite ever showed. The lesson had been learned earlier in the same session and
applied to the hint text, and never applied to the prompt that taught it. One
sentence — *the URL in that example is a placeholder, never send it* — took it
from 5% to 95%.

### What the regression check found

Everything above is about making tool calls, and it showed. Asked "what is the
capital of France? Do not use any tool", the model began answering "none of the
provided tools can be used to answer the question" — 100% → 50%. Nothing in the
prompt had ever said the tool was optional, and once enough of the prompt was
about calling it, a plain answer stopped looking like a legal move.

Stating the other half of the contract near the top of the prompt did not fix
it: 50% → 55%, intervals overlapping, which is the harness's word for nothing
happened. Moving the same sentence to the end of the prompt fixed it
completely: **55% → 100%**. Identical words, different position.

That is the third time in this section that position beat content, after the
`NEXT STEP` line and the hint that was ignored as prose in the middle of a
message. For a model this size, where an instruction sits appears to matter more
than how it is phrased — which is worth knowing before writing the next one.

### And one ablation that changed the conclusion

The CORS paragraph measured 0% → 0% when it was added, and was kept on
reasoning rather than evidence. Removing it once `NEXT STEP` existed:

| | with the paragraph | without |
|---|---|---|
| `wiki-telephone` | 70% | 35% |
| `wiki-clifton` | 100% | 35% |

Worthless alone, load-bearing in combination. Neither the decision to keep it
nor the decision to drop it could have been made from the first measurement,
and both would have been made confidently.

Three of the five defects in this section were found by measurement rather than
by reading, and two of them were in the measuring instrument.

## What using it on a phone found

The 90% was real, and it was not the number that mattered. Asked "Look up Alan
Turing on Wikipedia and tell me about his life", the deployed app fetched
`https://wikipedia.org/wiki/Alan_Turing`, was handed the working REST URL by the
failure hint, and re-sent the identical broken URL — twice, then a third time.

Three tasks were added to reproduce it before anything was changed. The middle
one is the user's message verbatim; the third forces the failing URL so that
every sample exercises the recovery path rather than waiting for the model to
choose a doomed URL on its own.

| task | what it isolates | rate (n=20) |
|---|---|---|
| `wiki-turing-recover` | hint fires, model only has to obey it | **100%** |
| `wiki-turing-open` | the user's phrasing; model picks the URL | **75%** |
| `wiki-turing-fact` | house phrasing; model picks the URL | **70%** |

The first hypothesis — that the suite's phrasing was kinder than a real user's —
is wrong. House phrasing scored slightly *worse*, with overlapping intervals.

### The eleven failures

- **6** re-sent an identical unfetchable URL until the iteration cap.
- **2** took the hint's *path* and kept their own host, producing
  `https://www.wikipedia.org/api/rest_v1/page/summary/Alan_Turing` — a real
  HTTP 500, because the portal has no article API.
- **2** took the hint's *host* and kept their own `/wiki/` path. One then
  invented `api.wikipidia.com`.
- **1** fetched the right URL, got a clean 200, and answered wrong.

So ten of eleven failures are URL construction and one is comprehension. The
middle four are the finding: the model does not copy the recommended URL, it
**recombines** it — grafting the hint's host onto its own path, or its own host
onto the hint's path. Both halves of a correct URL, assembled wrong. No wording
of the hint addresses that, because the model is not failing to read it.

Set against what it got right: the article title was correct in **11 out of 11**
failures, `api.wikipidia.com/wiki/Alan_Turing` included. The tool asks the model
to get scheme, host, path shape and title right simultaneously, and it reliably
gets exactly one of them right — the one a search tool would ask for on its own.

### A gap the taxonomy exposed

Hints fire on `NETWORK` failures only. The `www` case returns HTTP 500, which is
a successful round-trip, so those samples were given no hint at all — which is
why they repeated too.
