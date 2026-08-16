# Browser Agent

A chat agent that runs **entirely inside your browser** and can make HTTP
requests on your behalf — with your approval, one request at a time.

There is no backend. The language model runs on your GPU via WebGPU, the
requests go out from your browser, and nothing you type is sent anywhere except
in the HTTP calls you explicitly approve. The whole app is a single HTML file
you can host anywhere static.

- **What it is:** a chat window, an in-browser LLM, and two tools — an HTTP
  request builder (`curl`) and a Wikipedia lookup (`wiki`) that takes a search
  term instead of a URL.
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
| **Disk / network** | 0.4–2.5 GB of model weights download on first use, then cached by the browser. Free space matters — see [When the model will not load](#when-the-model-will-not-load). |

If WebGPU is missing you get a screen explaining what that is, why it matters,
and how to turn it on in your browser — never a blank page.

## The first load

The model downloads once. While it does, a card shows the phase in words, the
bytes against the total, the observed rate and an estimate of the time left,
ticking along between the engine's reports rather than freezing between them.

The estimate is deliberately vague — "about 2 minutes left", never a countdown
to the second — because it is extrapolated from a rate that changes minute to
minute. If the download goes quiet for more than twenty seconds, the card says
so rather than leaving you to guess whether it has hung.

---

## Deploy it yourself in two minutes

1. **Fork this repository.**
2. **Settings → Pages → Source: "GitHub Actions".** This step is required and
   cannot be automated — creating a Pages site needs admin rights that a
   workflow token does not have.

   > Picking **"Deploy from a branch"** here looks like it works and does not:
   > it copies the repository root to the site, so visitors get Vite's source
   > `index.html`, whose `/src/main.js` does not exist in a build. The page
   > loads and the app never starts. The deploy workflow checks for exactly
   > this and fails loudly if it happens.

3. **Push anything to `main`**, or run the "Deploy to GitHub Pages" workflow by
   hand. It runs the tests, builds the single file, publishes it, and then
   fetches the live URL to confirm the built artifact is what is actually being
   served.
4. **Open the URL it gives you** — `https://<your-user>.github.io/Browser-agent/`.
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

### The two tools

`curl` makes one HTTP request. Give the agent a URL and it will build the call.

`wiki` looks something up on Wikipedia from a **search term** rather than a URL —
"Alan Turing", not `https://en.wikipedia.org/…`. It resolves the term to a real
article title and fetches the summary, and both of its requests appear on the
confirmation card and in the log like any other.

It exists for a measured reason. Asked to look something up, a 0.6B model gets
the *article title* right almost every time and the URL around it wrong most of
the time — and when handed a working URL to retry with, it tends to graft half
of it onto half of its own. Asking only for the search term removes the part it
cannot do. The [build log](BUILD_LOG.md) has the before-and-after rates and the
failure breakdown behind that claim.

The general lesson, which is the one worth reusing: give a small model the
simplest interface that can express what it wants, and do the rest in code.

### Multi-step asks

"Fetch this, then look that up" is two steps, and a 0.6B model silently drops
the second one (measured: 3 in 20). So the app splits an explicitly sequenced
message in code and walks the model through it one step at a time — you'll see
a quiet "step 2 of 2" marker in the chat when this happens. The same goes for
a fan-out like "GET this and also GET that": the conjunction splits when what
follows is unmistakably a new action (an HTTP method in capitals, "fetch",
"look up"), and each errand runs as its own step. The split is deliberately
conservative: "then tell me…", "if …, then …", plain-English "and" ("War and
Peace", "and get me a coffee") never split. All steps share one tool-call
budget.

### Keyboard

| Key | Does |
|---|---|
| `Enter` | Send (desktop only — on a touch keyboard it inserts a newline) |
| `Shift`+`Enter` | Newline |
| `Esc` | Close the settings or log sheet; with neither open, deny an open confirmation card |

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

For a few sites whose pages are unreachable but whose APIs are not — Wikipedia,
Wikidata, GitHub — a failed request comes back naming the URL that *would* have
worked, for the article or repository you actually asked about, and the agent
retries with it. Since the `wiki` tool landed this is the fallback rather than
the main path — a Wikipedia lookup normally goes straight to the API — but when
the model reaches for a raw article URL anyway, the first request fails in the
open, on a card you can see, and the second one succeeds. That hint list is
deliberately short and always will be: every entry is verified, and a wrong
hint would be worse than none.

### One thing to know about the hosted version

The hosted app is served over **HTTPS**, and browsers refuse to let a secure
page make plain `http://` requests at all — the request is blocked before it
leaves, whatever the target server allows. The app detects this and says so on
the confirmation card, rather than reporting it as a CORS failure.

Use the target's `https://` address if it has one. If you must reach an
`http://` host, an **HTTPS** proxy works (an `http://` one would be blocked the
same way), or run the app locally over `http://`. Requests to `localhost` are
exempt, so pointing the agent at your own dev server works from the hosted site.

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
npm run check          # everything CI runs — use this before pushing
npm test               # unit tests (no browser needed)
npm run test:coverage  # with the 90% coverage gate
npm run test:e2e       # Playwright, against the built dist/index.html
npm run test:e2e:real  # the same, driving the real Qwen3-0.6B model
npm run docs:prompts   # regenerate the prompt mirror in docs/prompts.md
```

**Use `npm run check` before pushing.** CI's gate is `test:coverage`, not
`test`, so a change can add uncovered branches and pass `npm test` while turning
CI red — which is exactly what happened when the wiki tool landed.

Both e2e commands rebuild `dist/index.html` first, because they test the built
artifact rather than the dev server. They start their own local servers, so
`test:e2e` needs no network at all.

`test:e2e:real` needs a working WebGPU device and downloads ~0.4 GB. It is
excluded from CI for that reason.

Two things about it are worth knowing before you run it:

- **It opens a real browser window.** Headless Chromium exposes only a software
  adapter, and that adapter has no `shader-f16` — which every `q4f16_1` build in
  the catalogue needs — so a headless run cannot succeed. If your machine is an
  exception, `REAL_MODEL_HEADLESS=1` opts back in.
- **It serves the app on a fixed port** (43117), because the browser partitions
  the weight cache by origin. On a random port every run is a cold start that
  re-downloads the model and orphans the copy before it.

There is also `node scripts/model-check.js`, which compares tool-call
reliability across the three model tiers. It needs a GPU.

### Measuring reliability

A pass/fail test tells you what the model did once. A small model at
temperature 0.6 is a distribution, so "does the tool contract hold" is a
question about a *rate*:

```bash
npm run eval -- --suite local --n 20     # hermetic: does it build the request it was given?
npm run eval -- --suite wiki  --n 20     # real Wikipedia: can it find something?
npm run eval -- --suite all --holdout    # the tasks not used for tuning
npm run eval -- --suite wiki --quick --show-failures   # fast loop while iterating
npm run eval -- --regrade results.json   # re-score saved samples, no GPU needed
```

It grades the request the model actually built — not merely that it built one —
and reports a success rate with a 95% confidence interval. Tasks come in `dev`
and `holdout` halves: iterate against dev, and check holdout only at
checkpoints, because a prompt tuned until the tasks in front of it pass has been
fitted to those tasks. Needs a GPU, and shares the real-model suite's browser
profile so the weights are downloaded once.

Whether a change is real is decided by a two-proportion z-test, not by eyeballing
the rates. Comparing confidence intervals for overlap — the previous rule — is
about p < 0.005 and threw away findings that were plainly real.

**When a rate looks wrong, suspect the grader first.** Four of them here have
mismarked correct behaviour, and all four did it the same way: an answer pattern
written from one imagined phrasing that the model then declined to use. So:

```bash
npm run eval -- --regrade results.json --show-failures
```

`--show-failures` prints what the model actually wrote; `--regrade` re-scores
saved samples against the current task definitions in seconds, with no browser
and no GPU. Fix the pattern, re-grade, and only re-run the model if the samples
genuinely cannot answer the question. Result files record the git SHA, a dirty
flag and a hash of the system prompt, so two runs can be compared on evidence
rather than recollection.

To measure a change against the code that preceded it, build the old ref into
its own directory and point the harness at it with `--dist`, rather than
checking files out over your working tree:

```bash
git worktree add /tmp/before main && ln -s "$PWD/node_modules" /tmp/before/
(cd /tmp/before && npm run build)
npm run eval -- --suite wiki --task wiki-turing-open --n 20 --dist /tmp/before/dist
npm run eval -- --suite wiki --task wiki-turing-open --n 20   # your build
git worktree remove /tmp/before
```

---

## When the model will not load

Model weights are written into the browser's cache in dozens of pieces, and on a
device that is short of space that write fails. Chrome's own message for it says
nothing about storage:

```
Failed to execute 'add' on 'Cache': Entry was not found.
```

So the app measures rather than guesses. Before the download it checks the space
the browser is offering against the size of the model and warns if it will not
fit. If a load fails it asks again, and the explanation quotes the numbers —
"this site has 307 MB of storage left, and this model needs about 1 GB" — rather
than listing possibilities.

Whatever the cause, the failure card offers what will actually help:

- **Try again.** Pieces already stored are kept, so a retry resumes rather than
  restarting from zero.
- **Choose a smaller model.** Only models genuinely smaller than the one that
  failed are offered; if you are already on the smallest, it says so.
- **Clear stored model data.** A download that stopped two thirds of the way
  through has left two thirds of the weights on the device, and they are worth
  nothing on their own. On a full phone this is often the biggest single thing
  the app can give back.
- **Details for a bug report.** A copyable block with the model, how far it got,
  the storage figures, the device limits and the raw error. That is the right
  thing to attach to an issue.

A few notes on the space itself. Browsers grant a site a *share* of what is
free, not all of it, so freeing a few gigabytes buys back less than that — but
still more than you might expect. The app asks for persistent storage on
startup, which stops the browser evicting the weights under pressure; Chrome
grants this silently based on how often you visit. And if there is plenty of
room free and it still fails, the cache itself is likely damaged: clear this
site's data and reload.

---

## Known limitations

- **No offline operation.** Model weights stream from HuggingFace's CDN on first
  use. After that the browser cache handles it, but the first run needs network.
- **A nearly-full device may not be able to run this at all.** The app explains
  the shortfall and can reclaim what it stored, but it cannot free space it did
  not take.
- **`file://` caching is unreliable.** The app runs, but the model may
  re-download each session. Use a static server.
- **iOS is best-effort.** WebGPU availability and memory limits vary by version
  and device.
- **Two tools.** HTTP requests and Wikipedia lookups, nothing else — no file
  access, no code execution, no other services except what `curl` can reach.
- **Small models make mistakes.** They occasionally produce a malformed tool
  call — the app asks them to correct it once, then shows you the raw output
  rather than pretending. Measured on the tiny tier (Qwen3-0.6B, 20 samples
  per task, latest full run): 97% across the HTTP suite and 98% across the
  Wikipedia suite, with the residual failures being wrong readings of a
  correct response rather than broken calls. `npm run eval` is how those
  numbers are produced, and re-produced after any prompt change.
- **No conversation persistence.** Reload and you start fresh. The request log
  is in-memory only, by design.
- **Plain `http://` targets do not work from the hosted site.** That is the
  browser's mixed-content rule, not a choice this app makes; see
  [CORS and proxies](#cors-and-proxies).

---

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, the engine contract,
the agent-loop sequence, the tool-call schema and the error taxonomy;
[docs/prompts.md](docs/prompts.md) for every prompt verbatim;
[docs/capability-ladder.md](docs/capability-ladder.md) for what the agent can
do, rung by rung, with a prompt to try at each level;
[docs/research-notes.md](docs/research-notes.md) for how our measured prompt
lessons line up with published research; [SPEC.md](SPEC.md)
for the original design brief; and [BUILD_LOG.md](BUILD_LOG.md) for how it was
built, including what the adversarial reviews found.

## Licence

MIT. See [LICENSE](LICENSE).
