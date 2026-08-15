# Spec v2: Browser-Native AI Agent with HTTP Tool

## 1. Overview

A single-page web application providing a chat interface to an in-browser LLM (WebLLM / WebGPU) acting as an agent with exactly one tool: an HTTP request tool ("curl") built on the browser's `fetch` API. Everything runs client-side; there is no backend. The deliverable is a **single self-contained HTML file** suitable for hosting on GitHub Pages or any static host, and openable on desktop and mobile browsers.

**Goals:** trivially deployable (one file, static hosting), usable on a phone, transparent about what it's doing (requests, errors, stats), test-driven, well-documented.

**Non-goals (v1):** offline operation (model weights stream from HuggingFace CDN at runtime and are cached by the browser), multi-tool support, conversation persistence across sessions, non-WebGPU fallback inference.

## 2. Deployment & environment

### 2.1 Serving
- **Primary: static HTTPS hosting** (GitHub Pages or equivalent). The built `index.html` requires no headers, no server config, no companion files. Specifically: no COOP/COEP / cross-origin-isolation requirements (a reason WebGPU-only WebLLM is chosen over WASM-threaded alternatives).
- **Local dev:** `npm run dev` (Vite) and `npx serve dist/` both work.
- **`file://` (double-click): best-effort.** The app must load and run, but browser model caching is unreliable on file origins and the model may re-download per session. The UI shows a one-line notice when running from `file://` recommending a static server or the hosted URL.

### 2.2 Browsers & devices
- **Desktop:** Chromium 113+ (Chrome/Edge) fully supported. Firefox/Safari: run if their WebGPU works; not test targets for v1.
- **Mobile:** Android Chrome (WebGPU stable) supported with the small-model profile (§4.2). iOS Safari: best-effort (WebGPU availability and memory limits vary; capability check governs).
- **Capability gate:** on load, detect WebGPU + estimate available memory (`navigator.deviceMemory`, adapter limits). If WebGPU is missing, show an explanatory screen (what it is, how to enable, which browsers work) — never a blank page or console-only failure. If memory looks tight, pre-select a smaller model and say why.
- **Responsive UI is a requirement, not a nicety:** the chat, confirmation cards, settings, and log must be fully usable on a phone screen (§8).

## 3. Architecture

```
src/
  agent/loop.js          # agent iteration loop, tool dispatch, cap enforcement
  agent/toolcall.js      # tool-call parsing, validation, repair
  tools/curl.js          # fetch wrapper: headers, auth, proxy, timeouts, errors
  llm/engine.js          # engine interface (see 4.3)
  llm/webllm.js          # WebLLM implementation of the interface
  state/settings.js      # settings store (localStorage-backed)
  state/log.js           # request/response log
  ui/                    # DOM components (chat, settings, stats bar, log)
index.html               # built artifact: single file, everything inlined
```

- Modules are pure/DI-friendly where possible so they unit-test without a browser.
- Build: Vite + single-file plugin producing one self-contained `index.html`. Web workers inlined via blob URLs. No runtime dependencies beyond the WebLLM package (bundled) and the model CDN.

## 4. Model layer

### 4.1 Engine
- Backend: **WebLLM** (`@mlc-ai/web-llm`). Rationale (researched Aug 2026): purpose-built for in-browser LLM chat, OpenAI-compatible API with streaming and JSON-mode, fastest decode among browser runtimes, curated MLC model catalog, and no cross-origin-isolation requirement — which keeps single-file static hosting trivial.
- Known limitation accepted for v1: WebLLM's catalog lags the newest architectures (e.g. Qwen3.5/Gemma 4 not yet compiled); the Qwen3 line it does have is sufficient.

### 4.2 Models
One model family across all tiers so chat template and tool-calling behavior stay consistent:

| Tier | Model | Approx. download | Used for |
|---|---|---|---|
| Default (desktop) | Qwen3-4B-Instruct (MLC, q4) | ~2.5 GB | primary UX |
| Small (mobile / low-mem) | Qwen3-1.7B (MLC, q4) | ~1 GB | auto-suggested on constrained devices |
| Tiny (tests) | Qwen3-0.6B (MLC, q4) | ~0.4 GB | e2e suite; selectable by users who just want fast |

- Model picker in settings lists these three plus any WebLLM prebuilt the user pins by ID (free-text advanced field).
- Qwen3 hybrid thinking mode: disabled by default via chat-template flag (`/no_think` or generation config) to keep tool loops fast; a settings toggle exposes it.
- First-run download progress (percent + MB) is prominent; cache status ("cached, loads in seconds") shown per model.

### 4.3 Engine interface (future-proofing)
`engine.js` defines the contract: `capabilities()`, `load(modelId, onProgress)`, `generate(messages, options)` (streaming), `stats()`, `unload()`. WebLLM is the only v1 implementation. Documented-but-unbuilt future implementations: Transformers.js v4 (broader model catalog; would require revisiting the no-isolation-headers guarantee) and Chrome's built-in Prompt API (zero-download Gemini Nano; Chrome-only, quality TBD). The agent loop and UI depend only on the interface.

## 5. Tool calling

### 5.1 Contract
Tool calls are requested via system prompt instructing the model to emit a single fenced JSON block:

```json
{"tool": "curl", "args": {"method": "GET", "url": "https://...", "headers": {}, "body": null}}
```

WebLLM's native function calling is still WIP upstream; the JSON-block contract is the required path for v1 and the abstraction native calling would normalize into later.

### 5.2 Parsing & repair (`toolcall.js`)
- Extract candidate JSON (fenced block preferred; fallback to first balanced `{...}`); strip any thinking-mode preamble.
- Validate against schema: method whitelist, well-formed http(s) URL, headers as string→string map, body string|null.
- On failure: one automatic repair retry re-prompting the model with the specific error. On second failure, surface raw output as a normal message plus a visible "tool call failed to parse" notice.
- Pure module (string in → result object out); the primary unit-test target (~100% branch coverage).

### 5.3 Agent loop (`loop.js`)
- Max tool iterations per user message: configurable, default 5, hard cap 10.
- Iteration: generate → if tool call, execute (subject to confirmation §7) → append result → continue; plain text ends the turn.
- Tool results truncated to a configurable byte limit (default 8 KB) with an explicit "truncated" marker.
- Loop state (iteration count, pending confirmation) is inspectable for tests.

## 6. The curl tool

### 6.1 Capabilities
- Methods: GET, POST, PUT, PATCH, DELETE, HEAD.
- Custom headers including `Authorization` (credential handling §7).
- Body: raw string (model JSON-encodes; UI pretty-prints JSON).
- Timeout via `AbortController`: configurable, default 30 s.
- Result to model: status, status text, selected response headers, truncated body, elapsed ms.

### 6.2 CORS & proxy
- Direct `fetch` by default. Optional **CORS proxy URL template** in settings, e.g. `https://myproxy.example/?url={url}`; when set, requests are rewritten through it. Off by default. No bundled proxy in v1.

### 6.3 Error surfacing (first-class requirement)
Every failure mode produces a distinct, human-readable explanation in both the tool result (for the model) and the log (for the user):
- **Network/CORS failure** (`fetch` TypeError): explain this is usually CORS, state whether a proxy is configured, suggest one if not; be honest that the browser hides the true cause.
- **Timeout:** show the configured limit.
- **HTTP error status:** passed through as data, not treated as tool failure.
- **Invalid URL / blocked scheme:** only `http:`/`https:`; rejected before dispatch.
Errors are never swallowed; the model receives a structured error object it can react to.

## 7. Security & auth

- **Confirm-before-send: ON by default.** Each tool call renders a card (method, full URL, headers with credential values masked, body) with Approve / Deny / "auto-approve this domain this session." DELETE always requires confirmation even on auto-approved domains. Deny returns a structured "user denied" result to the model.
- **Credentials:** named entries (name → header name + value) in settings. Stored in `localStorage` with a permanent plaintext-storage warning; per-credential "session only" option keeps it in memory. Masked everywhere with click-to-reveal.
- Optional domain allowlist (off by default; when non-empty, out-of-list requests auto-denied).
- Note in docs: on a public GitHub Pages URL the app is same-origin for everyone; credentials still never leave the visitor's own browser except in the HTTP calls they approve.

## 8. UI

Single screen, responsive (desktop three-region layout; phone: chat full-screen, settings and log as slide-over sheets):
1. **Chat pane:** streaming messages; tool calls as collapsible cards (request → status → response preview); errors visually distinct. Confirmation cards are thumb-friendly on mobile.
2. **Settings sheet:** model picker + download progress + cache status, thinking-mode toggle, temperature, max iterations, timeout, truncation size, proxy URL, credentials, allowlist, confirm-before-send toggle.
3. **Stats bar:** current model, prefill/decode tok/s (from WebLLM), tokens this conversation, last tool latency, live iteration counter.
4. **Request log:** chronological, full detail (credentials masked), exportable JSON.

Design: clean, minimal, keyboard-friendly on desktop (Enter to send, Esc closes sheets); dark/light via `prefers-color-scheme`. Vanilla JS or a micro-library; no framework requirement.

## 9. Testing

### 9.1 Unit (Vitest, no browser)
- `toolcall.js`: valid calls, malformed JSON, prose- and thinking-wrapped JSON, schema violations, repair flow.
- `curl.js`: mocked `fetch` — header assembly, credential injection, proxy rewriting, timeout abort, each error class → its message.
- `loop.js`: fake engine — iteration cap, denial handling, truncation, termination.
- `settings.js`: persistence, session-only credentials, defaults/migrations.

### 9.2 E2E (Playwright, local, real model)
- Runs against the built `index.html` served by a local static server, in Chromium, **with the real Qwen3-0.6B via WebLLM** — effectively free, just slow. Invoked via `npm run test:e2e`; excluded from default CI.
- Model cache persisted between runs via a persistent browser profile.
- The harness starts a local HTTP test server (permissive CORS) as the tool's target — deterministic, no external dependencies.
- Scenarios:
  1. Cold start: model loads (download or cache), chat answers "hello."
  2. Tool round-trip: prompt induces a GET to the test server; confirmation card appears; approve; response reaches chat and log.
  3. Denial path: deny; model receives and acknowledges the structured denial.
  4. Error surfacing: request to a dead port → network/CORS explanation rendered.
  5. Iteration cap: server that keeps prompting follow-ups → loop halts at cap with visible notice.
  6. Mobile viewport smoke: scenario 2 repeated at a phone-sized viewport; confirmation card usable.
- Assertions on model text are loose (shape/presence); assertions on UI state, log entries, and test-server receipts are strict.

### 9.3 TDD expectation
Modules in §3 are written test-first; commits pair tests with implementation; unit suite gates the build.

## 10. Documentation

- `README.md`: what it is; browser/device requirements; the two-minute deploy (fork → enable Pages → open URL, including on a phone); local quickstart; settings reference; the CORS story and proxy setup; security notes (plaintext storage, what never leaves the browser); running unit and e2e tests; known limitations (no offline, `file://` caching caveat, iOS best-effort).
- `ARCHITECTURE.md`: module map, engine interface contract, agent-loop sequence diagram, tool-call JSON schema verbatim, error taxonomy.
- `docs/prompts.md`: system prompt and repair prompt verbatim — prompt text is load-bearing.
- JSDoc on all exported functions.

## 11. Milestones

1. **M1 — Core loop headless:** engine interface + WebLLM impl, toolcall parser, curl tool, agent loop; unit tests green; bare debug page. Includes a quick tool-call reliability check of Qwen3-4B vs 1.7B vs 0.6B to validate the tier table.
2. **M2 — UI:** chat, settings, stats, log, confirmation flow; responsive layouts.
3. **M3 — Hardening:** full error taxonomy, truncation, allowlist, session credentials, capability gate, `file://` notice.
4. **M4 — E2E + ship:** Playwright suite, single-file build, GitHub Pages deploy workflow, README/ARCHITECTURE.

## 12. Open questions

- Whether to auto-select the small model on mobile silently vs. always asking (lean: pre-select + one-line explanation, user can override).
- Log retention: in-memory only vs. persisted (lean in-memory for v1).
- Whether the advanced free-text model-ID field ships in v1 or M-next (lean v1; it's cheap and useful).
