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

## A second tool, and what describing it cost

The failure distribution from the previous section decided this. Across eleven
failures the article title was right eleven times and the URL around it wrong in
ten. A URL asks the model for scheme, host, path shape and title at once; a
search term asks for the one part it never gets wrong. So `tools/wiki.js` takes
a term and does the rest itself — search resolves it to a real title, the title
fetches the summary — through `executeCurl`, so the allowlist, timeout, byte cap
and redirect checks all still apply, and both hops are logged.

It worked, and then two sentences I wrote about it undid more than it gained.

| | curl only | with wiki, first prompt | after two one-line fixes |
|---|---|---|---|
| `wiki` dev suite | — | 108/140 (77%) | **137/140 (98%)** |
| `local` dev suite | 100% | 91/120 (76%) | **120/120 (100%)** |
| `wiki-turing-open` | 75% | 100% | 100% |
| `wiki-turing-fact` | 70% | 90% | 95% |
| `wiki-no-tool` | 100% | **0%** | 100% |
| `local-no-tool` | 100% | **0%** | 100% |
| `local-get-json-after-3-turns` | 100% | **65%** | 100% |

Pooled over the two tasks where the model chooses its own URL: **29/40 → 39/40,
z = 3.1**, and the intervals do not overlap.

### The two sentences

**"Use `wiki` whenever the answer would be on Wikipedia."** That is
unconditionally true of nearly any question. Asked for the chemical symbol for
gold and told to use no tool, the model searched Wikipedia in twenty samples out
of twenty — and answered "Au" correctly every time. Restraint went from 100% to
0% on *both* suites, and the model was obeying the instruction exactly as
written. Making it conditional — "when you need to look something up" — restored
it. The closing "the tool is optional" line was also pluralised: with two tools,
the singular read as naming curl alone, exempting the easier tool from the only
line that grants restraint.

**Merging two placeholder warnings into one sentence.** The original — "The URL
in that example is a placeholder. Never send it." — became "…and…above are
placeholders. Never send either one." `local-get-json-after-3-turns` fell to 65%,
sending `https://example.com/path` in five samples out of twenty: the exact bug
the original wording exists to prevent, and visible only after three turns of
conversation. Splitting it back into two short sentences recovered all of it.

### The finding

**Adding the tool cost nothing. Describing it cost everything.** Three curl
tasks held at 100% throughout, tool selection never went wrong, and the parser
handled two tools without complaint. Every regression came from prompt wording.

That reframes what a tool costs. The marginal price of the *second* tool was not
its schema or its code; it was that every tool adds prompt surface, and prompt
surface is where this model size breaks. It is an argument for the narrowest
possible interface per tool, and against assuming that a tool which measures
well in isolation is free in combination.

### And the instrument, again

`verdict` compared confidence intervals for overlap. For two proportions that is
about p < 0.005 — far stricter than the 95% the intervals are drawn at — and it
called 15/20 → 20/20 "inconclusive" on the very task a user had reported. It is
a two-proportion z-test now, with non-overlap kept as the stronger `emphatic`
flag. The harness exists to stop us believing noise, not to stop us believing
evidence.

Also fixed: `wiki-turing-recover`'s answer regex wanted "computer scientist" and
the model wrote "father of theoretical computer science", which the article also
says. Seven correct answers were scored wrong. That is the third grader in this
project to mismark a faithful answer, so the rule is now explicit — enumerate
what the source supports by reading the source, never by reading the failures.

### Still open

`wiki-turing-recover` sits at 90% against a baseline of 100% (z = -1.45, not
significant). Both failures are the model retrying the URL it was handed rather
than switching tools. That is the repeat-loop from the previous section, still
unaddressed, and the next thing worth fixing.

## A guardrail that could not be shown to do anything

Six of the eleven failures two sections ago were an identical URL re-sent until
the iteration cap, and the bug a user reported was the same URL sent twice with
a third under way. So the loop was closed: a request that already failed at the
transport layer this turn is not sent again, and the model gets a `NOT SENT`
result ending in the usual closing imperative.

Then it was measured, and it does nothing.

|  | repeated a failed request | wasted requests |
|---|---|---|
| wiki suite, before the guard | 0 / 140 samples | 0 of 237 |
| wiki suite, with the guard | 0 / 140 samples | 0 of 240 |
| unreachable host, before | 0 / 20 samples | 0 of 20 |
| unreachable host, with the guard | 0 / 20 samples | 0 of 20 |

`local-unreachable` was built specifically to trigger it — port 1 refuses the
connection, there is no hint naming a URL that works, and no second tool to fall
back on. Exactly one request per sample, in both arms.

**The wiki tool removed the cause, not the symptom.** The repeats were never
stubbornness; they were what a model does when it has no working alternative and
is asked to try again. Give it one that works and the behaviour disappears.

The guard is kept anyway, and this is a judgement call rather than a result:
fifteen lines, eight tests, no measurable cost, and it bounds the damage on any
host we will never have a tool for. But it is a seatbelt, not an improvement,
and the evidence for removing it is written here should anyone want it.

### What the new task found instead

Asked to fetch an unreachable host and say what happened, the agent reports the
failure honestly **19–20 times out of 20**. It does not invent a response. That
is the property the whole error taxonomy exists to protect, and until now it was
asserted rather than measured.

### The fourth grader bug

Its first answer pattern wanted "fail|error|could not|unable|refus" and marked
four answers wrong for saying *"I cannot use the curl tool"* and *"not being
able to fulfil the request"*. True rate 100%, measured rate 80%.

Four graders in this project have now mismarked correct behaviour, and **all
four erred the same way**: a pattern written from one imagined phrasing, which
the model then declined to use. The rule already recorded — enumerate what the
source supports by reading the source — needs a second half: enumerate how an
answer can be right by reading what the model actually wrote, before believing a
rate that looks bad.

Both arms above are re-graded from saved samples rather than re-run. That the
harness stores every transcript is what made a grader fix cost seconds instead
of GPU minutes.

## Sharpening the instrument

Seven things had cost time repeatedly. Six are now fixed, and the fixes are
listed by the mistake that motivated them rather than by feature.

**Four graders mismarked correct behaviour, all four the same way.** Each was a
pattern written from one imagined phrasing which the model then declined to use,
and fixing one meant re-running the model to re-earn samples already on disk. So
`--regrade <file>` re-scores a saved run against the current task definitions
with no browser, no GPU and no model, and `--show-failures` prints the requests
and answers behind each failure — which is how every one of those bugs was
actually found. The new rule: when a rate looks wrong, read what the model wrote
before believing the number.

**CI's gate is `test:coverage`, not `test`.** PR #9 went red on a threshold that
`npm test` does not check. `npm run check` now runs exactly what CI runs.

**Runs were compared from memory.** Result files recorded suite, n and
temperature, but nothing about the code that produced them — and prompt text
moves these numbers more than anything else. They now carry the git SHA, a dirty
flag and a hash of the system prompt.

**Getting a before-arm meant checking files out over the working tree.**
`git checkout main -- src/agent/loop.js`, rebuild, measure, restore. It worked,
and one slip would have silently compared the wrong things. `--dist <dir>` now
serves a build from anywhere, so the old ref lives in its own worktree beside
the new one.

**`docs/prompts.md` was hand-maintained and drifted inside a single session** —
at one point documenting a hint format (`Article_Title`) the code had already
stopped producing, so the doc confidently described a bug that had been fixed.
`npm run docs:prompts` regenerates it and a unit test fails if they diverge. The
test was checked by breaking the doc on purpose first: a drift test that cannot
detect drift is worse than none.

**Full runs are ~35 minutes**, which is right for a gate and wrong for
iterating. `--quick` takes the first three tasks.

### The seventh: there was no unfitted evidence at all

`local-query` and `local-headers` were spent as holdout back in the
`NEXT STEP` work — a fix was measured on them, so they had been dev tasks in all
but name ever since. Every rate in this log came from tasks that had been
iterated against until they passed.

Six fresh tasks now exist, none ever used for tuning: a PUT with a body, a 429,
reading a different field out of the most-practised response, the Eiffel Tower
in lower case with loose phrasing, and two restraint checks — restraint having
now broken twice as a side effect of editing text about calling tools.

### And the holdout finally ran

**198/200 = 99% (95% CI 96–100%)** across ten tasks, six of which had never been
used for tuning. The dev suites sit at 98% and 100%, so nothing here was fitted
to its tasks — which is the first time this project has been able to say that
with evidence rather than hope.

| | rate |
|---|---|
| `local-put-echo`, `local-status-429`, `local-no-tool-arithmetic` | 100% |
| `wiki-eiffel`, `wiki-no-tool-arithmetic`, `wiki-bristol`, `wiki-marie-curie` | 100% |
| `local-headers`, `local-query` (the previously spent pair) | 100% |
| `local-json-other-field` | 90% |

`wiki-eiffel` matters most of the four wiki tasks: lower case, loosely phrased,
and a subject the tool was never built against. The search hop absorbed it.

The two failures are real rather than another mismarked grader, and both are
worth keeping in view:

- One fetched `/json` four times and hit the iteration cap. The loop breaker
  does not cover this, deliberately: the requests **succeeded**, and refusing to
  repeat a successful request would be the harness overruling the model about
  something it got right. Repetition on success is a different problem.
- One fetched `/json` twice, then searched Wikipedia for `temperatureC` — it had
  the answer in hand and went looking for it elsewhere.

That second one is a genuine tool-selection error, and it corrects a claim made
two sections ago. "Adding the tool cost nothing; describing it cost everything"
was right about where the *regressions* came from, but "tool selection never
went wrong" was too strong: it goes wrong at roughly 1 in 20 on a task whose
data is already in the transcript. Small, real, and only visible because the
holdout contained a task nobody had tuned against.

## Stop the stream from showing what the message never says

The mobile screenshot that started the wiki work showed a second defect that
outlived it: raw `<think>` blocks and tool-call JSON streaming across the
screen. The committed message was always cleaned — `stripThinking` on the text,
a card in place of a tool call — but the *streamed* text was rendered raw, so
for the length of the generation the user watched exactly the content the final
message exists to hide.

The fix is `src/agent/stream-filter.js`: `visibleStreamText(buffer)`, a pure
function the chat pane applies to the whole accumulated buffer on every delta.
Recomputing from scratch each time is what makes it safe — anything held back
because it *might* be the start of a `<think>` tag or a tool call reappears the
moment the next characters prove it is prose. Held back permanently: think
blocks (closed or still open) and any JSON object, bare or fenced, whose first
key is consistent with `"tool"` so far. Held back for a frame or two: a trailing
`<thi`, a fence opener with no content yet. `{{credential}}` placeholders,
`{"data": 1}`, and prose code fences stay visible, and a trailing ``` is only
stripped when fence parity says it is an opener rather than the closer of a
complete block.

While everything so far is suppressed the bubble says *thinking…* instead of
sitting empty behind a caret, and a cancelled think-only stream now leaves no
empty "(interrupted)" husk — settlement judges the stream by what was
*displayed*, not what arrived.

Verification is the part worth recording. The unit tests (25) include
character-by-character replays asserting no *frame* ever leaks a fragment; the
e2e tests (4, `tests/e2e/streaming.spec.js`) install a MutationObserver before
sending and assert over every recorded DOM frame afterwards, so the check is
deterministic rather than a race against 8 ms deltas. And before trusting the
green, the fix was stashed and the suite re-run against the unfixed pane: all
four e2e tests failed, as they should. 737 unit / 82 e2e on the gate.

## Nudge, don't block: repetition on successful requests

The holdout's other lesson, addressed. A sample fetched the same URL four
times, every request a success, and hit the iteration cap instead of answering.
The loop breaker deliberately does not cover this — refusing to repeat a
*successful* request would overrule the model about something it got right, and
a second identical POST can be deliberate. So the fix is a nudge, not a wall:
the repeat is sent, and from the second identical success the tool result ends
with

```text
REPEAT: you have now sent this exact request 2 times. The response above is identical every time.
NEXT STEP: answer the user in plain prose using the response above. Do not send this request again.
```

appended *after* truncation, so however large the response, the instruction is
the last thing the model reads. The success memory is per-turn, like the
failure map: "fetch it again" in a new turn is a fresh instruction, not a loop.

Measurement first, as ever, and it did not go to plan. The harness now counts
`repeat_ok` — samples that re-sent an already-successful request — and
re-grading the saved holdout run reproduced the offline count exactly
(`repeat_ok×8` on `local-json-other-field`, 40%). But two purpose-built dev
twins failed to reproduce the phenomenon: `local-json-conditions` (same ask,
string field) repeated 1/20, and `local-json-humidity` (camelCase numeric
field, added to the payload for the purpose) repeated 0/20. Whatever triggers
the re-fetch, it is not simply the field's shape, and it varies day to day: the
same holdout task that repeated 8/20 in the checkpoint run repeated 2/20 when
re-run before the fix.

So the fix was measured on `local-json-other-field` itself, and that task is
now **spent** — recorded as such in `tasks.js`, with `local-status-418` added
as its fresh replacement. Both arms ran the same day, n=20 each:

| arm | pass | samples repeating | chain lengths |
|---|---|---|---|
| holdout checkpoint (no nudge) | 18/20 | 8 | 2,2,2,2,2,2,3,4 |
| before (no nudge, same day) | 20/20 | 2 | 2,3 |
| after (nudge) | 20/20 | 7 | 2,2,2,2,2,2,2 |

The rates are noise at these n, but the *mechanism* is not: without the nudge,
3 of 10 repeating samples extended their chain past two sends (one to the cap
and a failed turn); with it, 0 of 7 did. Reading the after-arm transcripts:
the nudge fired in 7 samples, and in all 7 the very next assistant message was
a plain answer. It cannot prevent the first repeat — it fires on it — but every
chain it touched ended there.

Unit coverage: five new loop tests (fires from the second success, survives
truncation, silent for distinct requests and post-failure retries, forgets
between turns) and the message's shape pinned in prompts.test.js. The repeat
messages — this one and the loop breaker's — are now documented in
`docs/prompts.md`, which had never mentioned the older of the two.

## Does any of this hold on 1.7B? Mostly — and where it breaks is instructive

Every fix this cycle was tuned on Qwen3-0.6B; "the changes are model-agnostic"
was an assertion. Qwen3-1.7B's pre-fix baseline was 0/40 on the wiki lookup
tasks — every sample fetched the CORS-blocked `/wiki/` article URL — with
restraint at 100%. Re-run on today's main, n=20 per task:

- **wiki dev: 140/140 = 100%, clean.** From zero. The wiki tool, the hint
  recovery path (`wiki-turing-recover` forces the dead URL and it recovered
  every time) and restraint all carry to the larger model unchanged.
- **local dev: 161/180 = 89%** — *worse* than 0.6B's 178/180 on the same
  suite, and the buckets say exactly where:
  - `local-unreachable` 50%: after the transport failure, 1.7B re-emits the
    identical dead call until the pass bound ends the turn (`stopReason: cap`,
    10/10 failures). The loop breaker correctly refuses each repeat, and the
    `NEXT STEP: … tell the user you could not fetch it` imperative that 0.6B
    obeys 100% is simply ignored. Position-beats-content is a 0.6B lesson;
    1.7B argues with the transcript instead.
  - `local-get-json-after-3-turns` 70%, `local-post-body` 85%: a new failure
    shape 0.6B never produced — the model *fabricates* a `TOOL RESULT {...}`
    block in its own voice instead of calling the tool, complete with an
    invented response (`{"city": "London"}` — wrong city). It has learned the
    transcript's format well enough to counterfeit it. One sample also copied
    `https://example.com/` from the schema example — the placeholder lesson is
    not 0.6B-specific.

Verdict: the *tools* generalise up; the *turn discipline* does not — bigger
models fail by confabulation where the small one fails by repetition. Nothing
is being fixed for 1.7B now (0.6B is the product target and 1.7B was never the
tuning target); the numbers are recorded so the next model-size conversation
starts from measurement instead of vibes. Runs saved as `wiki-1.7b-after.json`
and `local-1.7b-after.json` with provenance.

## The probe ladder: where the agent actually breaks now

With the dev suites saturated, the cheapest instrument was informality: seven
scenarios of rising difficulty, three samples each, no grader — just reading
21 transcripts (`probe.mjs`, scratchpad-only). What held: ambiguity resolution
("that famous suspension bridge in Bristol" → Clifton, 2/3), restraint under a
conflicting instruction (3/3, muddled prose aside), and retrieval after a
four-turn preamble (3/3). What broke, in order of importance:

1. **The second hop of a chain is silently dropped.** "GET /json to find the
   city, then look that city up on Wikipedia and tell me its country": all
   three samples fetched the JSON and then answered the Wikipedia half from
   memory. One said *France* — with exactly the confidence of a correct
   answer. The model collapses a two-step plan into one step plus recall, and
   when recall is wrong there is nothing on screen to distinguish it.
2. **"Alan Turing" is the new `example.com`.** Given no referent ("Can you
   look it up for me?") or a hard one, the model searches the system prompt's
   example query: one bridge question searched Alan Turing and then invented
   an "Ashdown Bridge, designed by Robert T. Ashdown". The placeholder lesson
   — anything in an example will be emitted verbatim under pressure — now has
   a fifth instance, and it is the wiki example's query.
3. **One sample answered a question by repeating it verbatim**, and two others
   spiralled into apology ("I was unable to complete the request…") instead of
   reading an answer they already had.

The two gradeable shapes are now dev tasks, and their before-numbers are the
first suite headroom this project has had in a while:

| task | grades | before |
|---|---|---|
| `chain-json-then-wiki` | the *second hop request*, not the fact — a correct answer from recall still fails as `wrong_target` | **3/20 = 15%** |
| `memory-city-recall` | restraint first (any fetch is `spurious`), then naming the city from turn one | 18/20 = 90% |

15% is the number the routing/decomposition experiments now have to beat, and
it is a much better argument for them than the 99% ceiling was: the model
demonstrably cannot hold "fetch, then use the result to fetch again" as a plan
on its own. Baseline landed with no fix, as ever, so whatever moves it next is
measured and not remembered.

## Prompt review against the literature

Before starting the decomposition work, every prompt got a fresh-eyes review
against current research and practice (August 2026), written up in
`docs/research-notes.md`. The satisfying part: three of our hard-won lessons
turn out to be independent replications of documented phenomena — placeholder
copying is "few-shot regurgitation" in the on-device-SLM literature,
position-beats-content is lost-in-the-middle (known to be stronger in small
models), and the whole Phase 3 thesis is the small-model end of
ReWOO/plan-and-execute. Our fixes are the cheap ends of the documented
mitigations, so nothing gets rewritten.

The review found one genuine gap and queued two experiments, none acted on
yet:

- **Gap:** the repair prompt always shows the `curl` example — even repairing
  a failed `wiki` call — and its `https://example.com` carries no placeholder
  warning in scope. Rare path; needs a repro task and a before-number first.
- **Queued:** sampling A/B — we run temp 0.6 with engine-default top-p, which
  matches neither Qwen's thinking recipe (0.6/0.95) nor its non-thinking one
  (0.7/0.8, top-k 20). Nobody has measured our operating point against the
  card's.
- **Queued:** the chain task with thinking mode on, purely to learn the
  ceiling the deterministic decomposition competes against (thinking triples
  round-trip latency, so it is calibration, not a candidate default).

## The chain-driver: hold the plan in code, hand the model one step

`chain-json-then-wiki` measured 3/20: given "fetch X, then look that city
up", the model does hop one and answers hop two from recall. The fix follows
the project thesis (and, it turns out, the plan-and-execute literature — see
`docs/research-notes.md`): the model cannot hold a two-step plan, so nothing
asks it to. `split.js` breaks an explicitly sequenced ask into steps in
deterministic code, and the loop runs each step as its own user turn on the
shared transcript. Step two arrives as a fresh instruction with hop one's
result sitting right there in the transcript — the exact shape
`memory-city-recall` measures at 90%. Zero new prompt text, zero new tokens
on single-step asks.

Design decisions, each with a reason:

- **Splitting is conservative.** Only ", then" / "; then" / ". Then" /
  " and then " between two actions splits. "then tell me…" is a reporting
  clause — the answer format of the current step, not a new hop — and three
  long-standing 100% tasks phrase themselves exactly this way, so it stays
  attached. "if …, then …" is control flow: never split. A bare mid-clause
  "then", more than three steps, or an under-8-character fragment abandons
  the split.
- **All steps share one tool budget**, because the system prompt promises
  "at most N tool calls for one user message" and the harness keeps the
  model's promises for it.
- **Any stop other than a plain text answer ends the whole turn** — a capped
  or cancelled step is not a foundation the next step can build on.
- **The UI shows the user's message once, as typed.** Later steps render as
  a quiet "step 2 of 2" marker: the user did not type that line, so it does
  not get a user bubble.

Measured (n=20 per run, temperature 0.6, Qwen3-0.6B):

| suite / task | before | after |
|---|---|---|
| `chain-json-then-wiki` | 3/20 = 15% | 19/20 = 95%, then 20/20 in the regression run (39/40 pooled) |
| local dev suite | 178/180 = 99% | 214/220 = 97% (two new tasks included) |
| wiki dev suite | 137/140 = 98% | 137/140 = 98% |

z = 5.09 on the headline. Mechanism, not just rate: **all 20 samples made
both hops** — the one failure in the first run made its Wikipedia request but
resolved "that city" to the literal word "City" and searched that. The cost
is one extra generation round per chain: mean per-sample wall clock went
3.6 s → 4.1 s. The regression dips are both pre-existing shapes, not the
splitter: `local-post-body` 18/20 (answers the status instead of the method,
same two-failure count as the previous run; its ", then tell me" phrasing
correctly did not split), and `memory-city-recall` 16/20 against an 18/20
baseline (not significant at this n, and it is the known parrot/apology
failure the splitter never touches).

What did not need building: a planner. ReWOO plans with a second model;
here the user's own sentence is the plan, and the split is a regex. A
planner LLM only becomes worth its latency when asks stop carrying their
structure on their surface — that is the informal-interpreter experiment,
which now has a working substrate to plug into.

## Checkpoint: holdout after the chain-driver, and a documentation pass

With Phase 1–3a all merged, the holdout suites got their checkpoint run from
main (`14cf2ea`): **220/220 = 100%, clean** — all eleven tasks, both suites,
including `local-json-other-field` (the task that spent itself exposing the
repeat bug) and the fresh `local-status-418`. No `repeat_ok` flags anywhere,
consistent with the nudge capping what the model-mood run had let sprawl.
Saved as `holdout-after-chain.json`.

The state of the board, all measured this week at n=20 per task:

| suite | rate |
|---|---|
| local dev (11 tasks, chains included) | 214/220 = 97% |
| wiki dev (7 tasks) | 137/140 = 98% |
| holdout (11 tasks, both suites) | 220/220 = 100% |
| `chain-json-then-wiki` alone | 39/40 pooled, from 3/20 |

The documentation pass that rode along: README's limitations said "one tool"
(two shipped months of work ago) and quoted a 65–95% Wikipedia rate from
before the wiki tool existed (98% now); the api-hints story still described
fail-then-retry as the main lookup path when it has been the fallback since
`wiki` landed; SPEC.md now says on its face that it is the original brief,
kept as written, with README/ARCHITECTURE as current; and the agent-loop
diagram is labelled as one *step*, with the splitter's outer walk described
in prose above it.

Remaining known headroom, in order: `memory-city-recall` 16–18/20 (parrot or
apology instead of reading the transcript), `local-post-body` 18/20 (answers
the status instead of the method), the repair prompt's wrong-tool example
(queued behind a repro), and the two queued sampling/thinking experiments in
`docs/research-notes.md`.

A quick generalization probe of the chain-driver against the two harder
chains from the probe ladder (3 samples each, read as transcripts): the
wiki-then-wiki chain — Marie Curie, find her element, look it up, atomic
number — ran both hops 3/3 and answered 88; the three-step chain — fetch
JSON, look up the city, give a fact — ran all three hops 3/3 inside one
budget. Before the splitter, wiki-then-wiki collapsed to recall in every
sample. One honest caveat that is the next failure shape in line: asked for
the element she discovered *first*, the model picked radium all three times
when the article lists polonium first — the chain executes, but fine-grained
fact selection inside a fetched result is its own weakness, and it would
grade `answer_wrong` if promoted to a task.

## The capability ladder, written down

The steering question — "what should we work on next?" — now has a standing
answer: `docs/capability-ladder.md`, a plain-language ladder of task
complexity from "answer or refrain" (100%) up through explicit chains (95%,
was 15%) to the unbuilt rungs (implicit chains, fan-out, trees with
clarification), each with a measured number and a prompt to type into the
live app by hand. The manual column is policy, not decoration: the suites
grade requests, but only a human notices when something *feels* wrong, and
each kind of check has caught things the other missed.

The design notes for the tree rungs record the agreed direction before any
code exists: calls push a small structured payload (end with the
instruction); children pull the rest by asking their caller, answered from a
throwaway copy of the caller's transcript so the live context never grows —
deterministic-first, because transcript recall is our weakest measured rung;
referents pass explicitly ("look Bristol up", never "that city"); and edges
verify + retry, because 95% per step is 86% at depth three. The lowest
broken or unmeasured rung is the next piece of work, which currently makes
the fan-out baseline (rung 6) and referent substitution the queue.
