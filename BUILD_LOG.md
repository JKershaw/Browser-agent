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
