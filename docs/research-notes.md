# Research notes: our prompt practice vs. the literature

A review of every prompt decision in this project against published research
and current practice (August 2026). Two purposes: check whether anything we
learned the hard way has a better-known answer, and check whether anything the
field recommends is missing here. Each section ends with a verdict — *keep*,
*queued experiment*, or *gap*.

The prompts under review are in [`docs/prompts.md`](prompts.md); every number
cited from our own work is in [`BUILD_LOG.md`](../BUILD_LOG.md) with a saved
run behind it.

---

## Placeholder copying is a documented phenomenon, and our fix is the cheap one

What we measured five separate times — `https://example.com/path`,
`Article_Title`, and "Alan Turing" all emitted verbatim when the model is
under pressure — has a name in the literature: **few-shot regurgitation**.
[Work on on-device PII substitution with small models](https://arxiv.org/html/2605.13538)
found exactly our failure ("values are often verbatim copies from the few-shot
demonstration, regardless of the input") and mitigates it by *rotating* the
demonstrations so no single literal is always present. Related writing on
[few-shot collapse](https://dev.to/shuntarookuma/when-more-examples-make-your-llm-worse-discovering-few-shot-collapse-106i)
documents the broader class: examples added to help can dominate the output.

Rotating examples would work here but costs prompt-hash stability — every
session would carry a different system prompt, and A/B provenance would lose
its anchor. Our per-placeholder warning ("The URL in that example is a
placeholder. Never send it.") measured 95%+ and keeps one hash.

**Verdict: keep.** One residual gap is recorded below under *Repair prompt*.

## Position effects: our five instances are a replication, not a quirk

"Position beats content" — the same sentence dead mid-prompt and near-perfect
as a closing imperative, measured five times — is consistent with the
[lost-in-the-middle literature](https://arxiv.org/abs/2307.03172) (models use
the start and end of a context far better than the middle), and the effect is
known to be stronger in smaller models. Our practice of putting the granting
line last in the system prompt and every remedy as a final `NEXT STEP:`
imperative is what current agent-prompting guides recommend; we simply have
local numbers for it.

**Verdict: keep.** Every future remedial instruction goes at the end of its
message, never the middle. This is now standing policy, not a per-case
discovery.

## Strict output contract + one repair round matches current practice

The JSON-fence contract with schema validation and a single repair turn is the
shape the field converged on for models without reliable native function
calling: [guided structured templates](https://arxiv.org/html/2509.18076)
report the same finding (explicit rigid formats reduce error rates in
function calling), and commercial "strict mode" APIs are the same idea
enforced server-side. Sending tool results back as `user`-role messages rather
than a `tool` role the chat template may not define is likewise standard for
small open models.

**Verdict: keep.**

## Sampling parameters: we are in an unmeasured middle ground

The [Qwen3 model card](https://huggingface.co/Qwen/Qwen3-0.6B) recommends, for
**non-thinking** mode (ours): temperature 0.7, top-p 0.8, top-k 20, min-p 0 —
and warns against greedy decoding. We send temperature 0.6 and let WebLLM's
model config supply the rest. So we match neither the thinking recipe
(0.6/0.95) nor the non-thinking one; nobody has measured our actual operating
point against the recommended one.

**Verdict: queued experiment.** Same-day `--dist` A/B, current settings vs.
the card's non-thinking recipe, on the full dev suite. Not urgent — the suite
sits at 99% under current sampling — but the chain and recall tasks have
headroom where sampling could matter. The card also suggests
`presence_penalty` 0–2 against endless repetition; our repetition guards are
deterministic and measured working, so that stays in reserve.

## Thinking mode is the documented remedy for exactly our worst failure

Qwen positions thinking mode for "complex logical reasoning" and multi-step
work; our worst number (`chain-json-then-wiki`, 15%) is a planning failure.
We disable thinking because reasoning tokens roughly triple every tool
round-trip (SPEC §4.2), which is the right default for a chat UI. But nobody
has measured the chain task with thinking on.

**Verdict: queued experiment.** Run the chain task with thinking enabled to
learn the ceiling — if thinking solves chains, that bounds how much the
deterministic decomposition work can win and what it competes against on
latency. The deterministic route is still preferred (zero extra tokens), so
this measurement is for calibration, not a candidate default.

## Decomposition-in-code has a name: plan-and-execute / ReWOO

Our Phase 3 thesis — keep the model's view simple, hold the plan in
deterministic code — is the small-model end of an established line:
[ReWOO](https://arxiv.org/pdf/2305.18323) decouples planning from execution
(plan once with placeholders, workers execute without replanning), and
[plan-and-execute agents](https://blog.langchain.com/planning-agents/) plan
upfront then execute stepwise, replanning only on failure. Both report the
same motivation we measured: interleaved reason-act loops lose the plan.

The 0.6B twist is that the model cannot be the planner either — it *drops*
the second step of a plan it just read (15%). So the first rung uses the
user's own sentence as the plan: deterministic code splits "do X, then do Y"
and feeds the model one step at a time. The transcript holds the plan; the
model only ever holds one step. This is ReWOO with the user as planner and
the harness as worker-scheduler.

**Verdict: this is the design basis for the chain-driver experiment**, judged
against the 15% baseline.

## Review findings in our own prompts (fresh-eyes pass)

Reading every prompt end-to-end against the above:

1. **The repair prompt always shows the `curl` shape** — even when the failed
   call was a `wiki` attempt — and its example URL is `https://example.com`
   with no placeholder warning in scope. Both known risks (tool-flipping,
   placeholder copying) in a message that only appears when the model is
   already confused. Rare path (repairs are a one-shot), so: *queued* — needs
   a repro task and a before-number first, per
   [measure-before-fixing]. Candidate fix: show the shape of the tool that
   was attempted, or both shapes.
2. **No prompt text addresses multi-step asks.** Deliberate: the surface-cost
   lesson says a sentence about chains would tax every single-step turn, and
   the middle of the prompt is where instructions go to die. Chains are being
   fixed in code (above), not prose. *Keep.*
3. **Everything else already embodies the practices the literature
   recommends** — minimal tool surface, conditional selection rules, closing
   imperatives, per-placeholder warnings, honest failure framing. No further
   gaps found.

---

*Review date: 2026-08-16. Re-run this review when the model, the prompt hash,
or the tool count changes.*
