# Browser Agent

A chat agent that runs **entirely inside your browser** and can make HTTP
requests on your behalf — with your approval, one request at a time.

There is no backend. The language model runs on your GPU via WebGPU, the
requests go out from your browser, and nothing you type is sent anywhere except
in the HTTP calls you explicitly approve. The whole app is a single HTML file
you can host anywhere static.

- **What it is:** a chat window, an in-browser LLM, and exactly one tool — an
  HTTP request builder ("curl").
- **What it is for:** poking at APIs, fetching things, and seeing precisely what
  an agent is doing while it does it.
- **What it is not:** a general assistant. The models that fit in a browser are
  small. Keep the asks concrete.

---

## Requirements

| | |
|---|---|
| **Desktop** | Chrome or Edge 113+. Fully supported. |
| **Android** | Chrome with WebGPU (121+), on a reasonably recent device. Supported with the small model. |
| **Firefox / Safari** | Run if their WebGPU works. Not test targets. |
| **iOS Safari** | Best-effort. WebGPU availability and memory limits vary. |
| **Disk / network** | 0.4–2.5 GB of model weights download on first use, then cached by the browser. |

If WebGPU is missing you get a screen explaining what that is, why it matters,
and how to turn it on in your browser — never a blank page.

---

## Deploy it yourself in two minutes

1. **Fork this repository.**
2. **Settings → Pages → Source: GitHub Actions.** The included workflow builds
   and publishes on every push to `main`.
3. **Open the URL it gives you** — `https://<your-user>.github.io/Browser-agent/`.
   It works the same on a phone.

The first load downloads the model. Subsequent loads are seconds.

Prefer to host it elsewhere? `npm ci && npm run build` produces
`dist/index.html`. That one file is the entire app: drop it on any static host,
or open it directly from disk.

> Opening the file from `file://` works, but browsers do not cache model weights
> reliably on file origins, so the model may re-download every session. The app
> shows a notice when it detects this.

---

## Local development

```bash
npm ci
npm run dev            # Vite dev server
npm test               # unit tests
npm run test:coverage  # unit tests + coverage gate
npm run build          # produces the single-file dist/index.html
npm run serve:dist     # serve that file, exactly as it will be hosted
```

Running the tests is covered in [Testing](#testing) below.

---

## Using it

Type what you want. If the agent needs to fetch something, it proposes a
request and you get a card showing the method, the full URL, any headers and the
body. Approve it, deny it, or tick "auto-approve this domain for this session".

Each request appears in the chat as a card you can expand, and in the **request
log** with full detail. The log exports as JSON — with credentials masked — which
is the right thing to attach to a bug report.

The **stats bar** shows the current model, prefill and decode speed, tokens used,
the last request's latency, and a live iteration counter.

### Keyboard

| Key | Does |
|---|---|
| `Enter` | Send (desktop only — on a touch keyboard it inserts a newline) |
| `Shift`+`Enter` | Newline |
| `Esc` | Close the settings or log sheet |

---

## Settings reference

| Setting | Default | What it does |
|---|---|---|
| **Model** | Qwen3 4B, or 1.7B on a constrained device | Which model to load. Download size and cache status are shown per model. |
| **Advanced: model id** | — | Pin any model from WebLLM's prebuilt catalog by id. |
| **Thinking mode** | off | Lets Qwen3 reason before answering. Roughly triples the latency of every tool round-trip. |
| **Temperature** | 0.6 | Sampling temperature, 0–2. |
| **Max tokens per reply** | 1024 | Generation limit per reply. |
| **Max tool calls per message** | 5 | How many requests the agent may send for one message. Hard-capped at 10. |
| **Timeout** | 30 s | Per-request timeout. |
| **Response size limit** | 8 kB | Responses are cut here and the model is told they were truncated. |
| **CORS proxy URL template** | empty | See [CORS](#cors-and-proxies). |
| **Confirm before sending** | **on** | Show an approve/deny card for every request. |
| **Domain allowlist** | empty | When non-empty, requests to any other host are refused before being sent. |
| **Credentials** | none | Named secrets. See [Credentials](#credentials). |

Settings are saved in your browser's `localStorage`. If that is unavailable
(private mode, full quota) the app keeps working and tells you the settings
apply for this session only.

---

## CORS and proxies

Most of the internet will refuse a request from a web page it does not know.
That is CORS, it is the browser enforcing it, and **the browser deliberately
does not tell the page why a request failed**. The app is honest about this
rather than guessing: a failed request explains that CORS is the usual cause,
says whether a proxy is configured, and lists the other possibilities.

APIs that send `Access-Control-Allow-Origin` work directly, with no setup.

For anything else you need a CORS proxy. **None is bundled** — a proxy sees every
request you send through it, so which one to trust is your call, not ours. Set
the template in settings:

```
https://your-proxy.example/?url={url}
```

`{url}` is replaced with the percent-encoded target. A template with no `{url}`
is treated as a prefix (`https://proxy.example/` + `https://target/`), which is
the convention some proxies use.

---

## Credentials

Store a secret once and let the model use it without ever seeing it.

1. Add a credential in settings: a **name**, a **value**, and optionally a header
   name plus hosts to attach it to automatically.
2. The model is told the *name* only. It writes a placeholder:

   ```json
   {"headers": {"Authorization": "Bearer {{GitHub}}"}}
   ```

3. Your browser substitutes the real value immediately before sending.

Some deliberate properties:

- **The model never sees a secret** — only the placeholder.
- **A credential with hosts set is withheld everywhere else**, and the
  confirmation card tells you when that happened.
- **Any request carrying a credential always asks first**, even with
  confirm-before-send off and even on an auto-approved domain. Leaking a
  long-lived token is as irreversible as a DELETE.
- **Credentials are masked everywhere** — the confirmation card, the chat, the
  log, the export — with click-to-reveal in settings.

### Security notes, plainly

- **Persistent credentials are stored in `localStorage` in plain text.** Anyone
  with access to this browser profile can read them. Use **session only** for
  anything sensitive: those live in memory and vanish when you close the tab.
- **Nothing leaves your browser except the requests you approve.** No telemetry,
  no analytics, no backend.
- **On a public URL, the app is same-origin with every other page on that host.**
  On GitHub Pages that means every other project on `<user>.github.io`. Your
  credentials still never leave your own browser, but if that shared origin
  bothers you, host it somewhere dedicated or use session-only credentials.
- **The model's output is untrusted.** Anything the agent fetches can try to
  steer it — this is prompt injection, it is real, and it is why the
  confirmation card exists and why credential scope is enforced at send time.
  Read the card before approving.

---

## Testing

```bash
npm test               # unit tests (no browser needed)
npm run test:coverage  # with the 90% coverage gate
npm run test:e2e       # Playwright, against the built dist/index.html
npm run test:e2e:real  # the same, driving the real Qwen3-0.6B model
```

`npm run test:e2e` builds nothing itself — run `npm run build` first. It starts
its own local servers and needs no network.

`test:e2e:real` needs a working WebGPU device and downloads ~0.4 GB. It is
excluded from CI for that reason.

There is also `node scripts/model-check.js`, which compares tool-call
reliability across the three model tiers. It needs a GPU.

---

## Known limitations

- **No offline operation.** Model weights stream from HuggingFace's CDN on first
  use. After that the browser cache handles it, but the first run needs network.
- **`file://` caching is unreliable.** The app runs, but the model may
  re-download each session. Use a static server.
- **iOS is best-effort.** WebGPU availability and memory limits vary by version
  and device.
- **One tool.** HTTP requests, nothing else.
- **Small models make mistakes.** They occasionally produce a malformed tool
  call — the app asks them to correct it once, then shows you the raw output
  rather than pretending.
- **No conversation persistence.** Reload and you start fresh. The request log
  is in-memory only, by design.

---

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, the engine contract,
the agent-loop sequence, the tool-call schema and the error taxonomy;
[docs/prompts.md](docs/prompts.md) for every prompt verbatim; [SPEC.md](SPEC.md)
for the original design brief; and [BUILD_LOG.md](BUILD_LOG.md) for how it was
built, including what the adversarial reviews found.

## Licence

MIT. See [LICENSE](LICENSE).
