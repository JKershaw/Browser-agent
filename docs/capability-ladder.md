# The capability ladder

What the agent can do, in plain language, in order of difficulty — with a
prompt you can type into the live app to feel each level for yourself, and
the measured number behind it. This is the steering document: the lowest
rung that is broken or unmeasured is the next piece of work.

Numbers are Qwen3-0.6B at temperature 0.6, n=20 per task unless noted.
When a rung moves, update this file in the same PR.

## The shape of a call

Everything below composes out of one unit cell, which every measurement this
project has made points at:

> **One step, stated last, narrowest interface, answer already in view.**

The model is near-perfect when it gets a single instruction at the end of its
context, one action expected, and a referent it can resolve from what it can
see. Every mechanism in the codebase — the splitter, the repeat nudge,
`NOT SENT`, hints with closing `NEXT STEP` lines — is code keeping the model
inside that envelope. Larger structures (chains, trees, fan-out) are built by
connecting these cells with deterministic edges, never by asking the model to
hold the structure itself.

## The rungs

| # | Capability | Try it yourself | Measured |
|---|---|---|---|
| 0 | **Answer or refrain.** Knows when *not* to fetch. | "What is 9 plus 5?" — no tool card should appear | 100% |
| 1 | **One hop.** Fetch a URL or look something up; answer from the result. | "Look up the Clifton Suspension Bridge on Wikipedia — who designed it?" | 97–100% |
| 2 | **Read within a result.** Pick the right field or fact out of a response. | "GET a JSON API and tell me one specific field" | 90–100%, with a known weakness: fine-grained selection ("the element she discovered *first*") can pick the wrong fact confidently |
| 3 | **Recall across turns.** Use something fetched earlier without refetching. | Fetch something, chat a bit, then: "what city was that for again?" | 80–90% — the weakest measured rung; failures parrot or apologise instead of reading the transcript |
| 4 | **Explicit chain.** "Do X, then do Y." | "GET this JSON to find the city, then look that city up on Wikipedia" — watch for the "step 2 of 2" marker | 95%+ (was 15% before the chain-driver; the residual failure is rung 3 wearing a trench coat: "that city" → "City") |
| 5 | **Implicit chain.** Steps the user didn't spell out. | "What country is this weather API talking about?" (needs fetch → resolve → look up, unprompted) | Unmeasured; expected near zero unaided. Needs the interpreter. |
| 6 | **Fan-out and compare.** "Look up A and B; which is older?" | — | Unmeasured. **Rule: land the baseline before building the mechanism.** |
| 7 | **Tree with clarification.** Sub-sessions that can ask their caller questions. | — | Design stage; see below. |

The manual column is not decoration. Run it on the deployed app when a rung
changes: the suites grade requests and answers, but only a human notices that
something *feels* wrong — a weird tone, a hesitation, an ugly transcript.
Both kinds of check have caught things the other missed.

## Design notes for rungs 5–7 (agreed direction, not yet built)

**Calls carry a payload, small and structured.** A parent calling a
sub-session pushes what the child obviously needs: the ask, the relevant
facts extracted so far, constraints. The hard cap is the model's context
window and is generous; the *useful* cap for 0.6B is far lower — everything
measured here (lost-in-the-middle, prompt-surface cost) says keep the payload
short, structured, and end it with the instruction. Measure before relying on
a bigger payload.

**Children can ask their caller — without growing the caller's context.**
When a child hits a gap, it asks a question. The harness answers it from a
*throwaway copy* of the caller's transcript plus the question: one
generation, and the caller's live context is never amended. Push covers the
predictable needs; pull covers the rest, so neither side has to guess
perfectly. One caution from our own numbers: answering from a transcript is
rung 3, our weakest shape — so the edge is deterministic-first. Try to answer
the child from the structured payload and the request log in code; spend an
LLM generation only when that fails.

**Referents pass explicitly, not by anaphora.** Both residual chain failures
are the model failing to resolve "that city" / "the first element". The
parent should substitute the actual answer into the next step's text ("look
**Bristol** up"), which needs a small answer-extraction step — the first
place a focused second LLM call earns its latency.

**Errors multiply on the edges.** 95% per step is 86% at depth three. Trees
need verification on the edges — code checking each step's output (request
went out? status ok? answer matches the expected shape?) and retrying
cheaply — not higher ambitions for the nodes.

## The improvement loop

The process that produced every number above, and the one any future rung
goes through:

1. **Probe informally** at the frontier — increasingly hard prompts, read the
   transcripts.
2. **Distill** each gradeable failure into an oracle-verified eval task; land
   the before-number as its own PR.
3. **Change one thing.** Judge it with a two-proportion z-test, never by
   eyeballing.
4. **Check the holdout at checkpoints**; a consulted holdout is spent —
   declare it and replace it.
5. **Update the docs in the same PR**, including this file.

Standing rules that keep it honest: suspect the grader before the model;
grade the mechanism, not just the rate; give model-mood failures
deterministic guards, not prompt text tuned to a moving target; and prefer
complexity in code to complexity in context — every level of indirection is
lossy, so add one only when measured to pay.
