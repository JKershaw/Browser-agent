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
