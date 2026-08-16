# Prompts

Every prompt the agent sends, verbatim. Prompt text is load-bearing: small
models follow the tool-call contract only when the instructions are this
explicit, so changing a line here is a behaviour change, not a copy edit.

The source of truth is [`src/agent/prompts.js`](../src/agent/prompts.js) and
[`src/agent/toolcall.js`](../src/agent/toolcall.js) (`repairPrompt`). This file
is generated from them; if you edit a prompt, re-run:

```
node -e "import('./src/agent/prompts.js').then(m => console.log(m.buildSystemPrompt({maxIterations: 5})))"
```

and update the text below to match. The e2e suite covers the shapes these
prompts have to produce, so run `npm run test:e2e` after any change, and
`node scripts/model-check.js` on a GPU machine before changing the tool-call
contract itself.

---

## System prompt

Assembled by `buildSystemPrompt({credentialNames, allowlist, maxIterations, thinking})`.
The base form — no stored credentials, no allowlist, thinking mode off, default
iteration limit:

```text
You are a helpful assistant running entirely inside the user's web browser.

You have two tools. To call one, reply with ONLY a fenced JSON block and no other text.

`wiki` looks something up on Wikipedia. It takes a search term, not a URL:
```json
{"tool": "wiki", "args": {"query": "Alan Turing"}}
```

`curl` performs a single HTTP request using the browser's fetch API:
```json
{"tool": "curl", "args": {"method": "GET", "url": "https://example.com/path", "headers": {}, "body": null}}
```

When you need to look something up, use `wiki` for anything Wikipedia covers — a person, a place, an event, an idea. If the user gives you a URL, use `curl` with that URL exactly as written.

"Alan Turing" and "https://example.com/path" above are placeholders. Never send either one. Search for what the user actually asked about, and use the URL the user gave you, character for character, including its host and port.

Rules for a `curl` call:
- "method" must be one of: GET, POST, PUT, PATCH, DELETE, HEAD.
- "url" must be absolute and start with http:// or https://.
- "headers" is an object of string values; use {} when you need none.
- "body" is a string or null. GET and HEAD must use null.
- Emit exactly one tool call per reply. Never invent the result of a call.

After each call you receive a message beginning with "TOOL RESULT". For `curl` it contains the HTTP status, selected headers and the response body (possibly truncated); for `wiki` it contains the article text. Read it, then either call a tool again or answer the user in plain text.

You may make at most 5 tool calls for one user message. When you have what you need, stop calling the tool and reply in plain prose. Never show the user raw JSON tool calls as your final answer.

If a call fails, the result explains why, and sometimes names a URL that would work instead. When it does, call the tool again with that URL — that is what it is for.
Report a failure to the user only once you have no working alternative left, and then report it honestly rather than pretending the request worked or inventing data.

You are in a web page, so requests are subject to CORS. Ordinary web pages meant for humans (HTML) almost always refuse cross-origin requests and are too large to read; JSON APIs almost always permit them and are small. Prefer a site’s JSON API over its HTML pages.
If a request fails with a network error, the same URL will fail again. Do not retry it — reach for that site’s API instead.

The user must approve each request before it is sent, and may deny it. A denial is a real answer from the user, not an error to retry blindly.

Both tools are optional. If you already know the answer, or the user asks you not to use a tool, answer in plain prose without calling either one — that is a complete and correct response, not a failure.

Answer directly. Do not emit reasoning or <think> blocks.
```

### Conditional sections

**When credentials are stored**, this is inserted before the approval
paragraph. The model is given credential *names* only — never values:

```text
Stored credentials are available. Reference one by name inside a header value using double braces; the browser substitutes the real secret before sending, and you never see it:
```json
{"tool": "curl", "args": {"method": "GET", "url": "https://api.example.com/me", "headers": {"Authorization": "Bearer {{GitHub}}"}, "body": null}}
```
Available credential names: {{GitHub}}, {{Weather}}.
```

**When a domain allowlist is configured:**

```text
Requests are restricted to these domains: api.github.com. Requests anywhere else are refused before they are sent.
```

**When thinking mode is off** (the default), the final line is appended:

```text
Answer directly. Do not emit reasoning or <think> blocks.
```

With thinking mode on, that line is omitted and the engine stops sending
`enable_thinking: false`.

> **Naming credentials to the model is a deliberate trade-off.** It is what
> makes `{{placeholder}}` substitution usable, and it means a prompt-injected
> model knows which credentials exist. That is why the *value* never enters the
> model's context, why `hosts` scoping is enforced at substitution time, and why
> any request that would carry a credential always shows a confirmation card.
> See [ARCHITECTURE.md](../ARCHITECTURE.md#threat-model).

---

## Repair prompt

Sent once, and only once, when a tool call fails to parse or validate
(`repairPrompt(error)` in `src/agent/toolcall.js`). `{code}` and `{message}`
are the stable error code and its explanation:

```text
Your tool call could not be used. Error {code}: {message}

Reply with ONLY a single fenced JSON block in exactly this shape, and nothing else:
```json
{"tool": "curl", "args": {"method": "GET", "url": "https://example.com", "headers": {}, "body": null}}
```
If you no longer need the tool, reply with a plain-text answer instead.
```

A worked example, for `E_BAD_SCHEME`:

```text
Your tool call could not be used. Error E_BAD_SCHEME: Scheme "ftp:" is blocked. Only http: and https: URLs can be requested.
```

If the second attempt also fails, there is no third round: the raw output is
shown to the user with a visible "tool call failed to parse" notice, and the
turn ends.

---

## Tool result

Every result is wrapped by `toolResultMessage()` and handed back with the
`user` role — the JSON-block contract does not use native function calling, and
small chat templates handle a plain user turn far more reliably than a `tool`
role their template may not define. The `TOOL RESULT` marker is what the system
prompt tells the model to look for.

A success:

```text
TOOL RESULT
HTTP 200 OK
elapsed: 43 ms
headers:
  content-type: application/json
body:
{"city":"Bristol","temperatureC":14}
```

Truncated at the configured byte limit:

```text
TOOL RESULT
HTTP 200 OK
elapsed: 88 ms
body:
<the first 8192 bytes>
[TRUNCATED at 8192 bytes — the response was longer than this limit.]
```

A transport failure. HTTP error statuses are *not* failures — a 404 comes back
as data, in the success shape above:

```text
TOOL RESULT
TOOL ERROR (network)
The browser refused or could not complete the request, and it does not tell pages why. The usual cause is CORS: the target server did not send an Access-Control-Allow-Origin header that permits this page. No CORS proxy is configured. If the target is not CORS-enabled, set a proxy URL template in settings (e.g. https://your-proxy.example/?url={url}). Other possibilities: DNS failure, connection refused, TLS error, or the host being offline.

This request did not reach the server (or its response was discarded). Do not claim it succeeded.
```

When the failing host is one of the few in
[`src/tools/api-hints.js`](../src/tools/api-hints.js), a hint naming a URL that
*does* work is prepended, and the same URL is repeated as a closing imperative:

```text
TOOL RESULT
TOOL ERROR (network)
Wikipedia article pages block cross-origin requests; its REST API allows them. Request this instead: https://en.wikipedia.org/api/rest_v1/page/summary/Alan_Turing The browser refused or could not complete the request, and it does not tell pages why. …

This request did not reach the server (or its response was discarded). Do not claim it succeeded.

NEXT STEP: call the tool again with exactly this URL: https://en.wikipedia.org/api/rest_v1/page/summary/Alan_Turing
```

The hint names the *real* URL for what was just asked for, never a template: an
earlier version said `…/page/summary/Article_Title` and the model requested
`Article_Title`, literally.

Both closing lines are deliberate. Without "do not claim it succeeded", small
models narrate a plausible response they never received; without `NEXT STEP`,
they read the suggested URL back to the user as advice instead of calling it.

---

## Wiki tool result

The `wiki` tool returns prose rather than a response envelope — no status, no
headers, no JSON. The model's job is to read one paragraph and answer a question
about it, and everything else is something it would have to look past:

```text
TOOL RESULT
WIKIPEDIA: Alan Turing
Alan Mathison Turing was an English mathematician, computer scientist, logician, cryptanalyst, philosopher and theoretical biologist. …
Source: https://en.wikipedia.org/wiki/Alan_Turing
```

When the search matched nothing, the recovery path needs no URL — only another
search term, which is the one thing the model reliably gets right:

```text
TOOL RESULT
WIKI ERROR (no_match)
No Wikipedia article matched "turring test".
Closest article titles: Turing test, Turing machine.

NEXT STEP: call the wiki tool again with one of those titles as the query.
```

---

## Denial

When the user denies a request at the confirmation card (`denialMessage()`):

```text
TOOL RESULT
DENIED BY USER
The user refused to send DELETE https://api.example.com/things/42.
Reason given: I do not want to delete that.
Do not retry the same request. Either ask the user what they would prefer, or answer without this data.
```

With no reason given, the third line reads `No reason was given.`

The denial is framed as an answer rather than an error on purpose: told it was
an error, a model retries the identical request until the iteration cap.

---

## Iteration cap notice

Shown to the user, not to the model (`capMessage(sent, denied)`). Requests
actually sent and requests refused are reported separately — telling someone who
denied everything that the agent "made 3 tool calls" is simply untrue:

```text
Stopped after 3 tool calls — this message reached its limit. Ask again to continue.
Stopped after 2 refused requests — this message reached its limit. Ask again to continue.
Stopped after 2 tool calls and 1 refused request — this message reached its limit. Ask again to continue.
```
