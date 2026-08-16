/**
 * Deterministic decomposition of an explicitly sequenced ask.
 *
 * The measured failure this exists for: given "fetch X, then use it to look up
 * Y", Qwen3-0.6B does the first hop and answers the second from recall — the
 * plan collapses to one step (`chain-json-then-wiki`, 3/20 before this
 * module). The model cannot hold a two-step plan, but it does not need to:
 * the user's own sentence *is* the plan, and code can walk it. Each step is
 * fed to the model as its own user turn, so the model only ever holds one
 * step and the transcript holds the rest — plan-and-execute with the user as
 * planner and the loop as scheduler.
 *
 * The same collapse happens on fan-out ("GET X and also GET Y",
 * `fanout-local-two-gets`, 0/20 unaided): one response in view reads as
 * "done" and the second errand is silently dropped. A conjunction whose next
 * word is unmistakably a new action splits the same way — fan-out run as a
 * chain, since parallel dispatch would only buy latency.
 *
 * Splitting is deliberately conservative, because every existing suite runs
 * through it:
 *
 * - Only an explicit sequencing "then" splits — `", then "`, `"; then "`,
 *   `". Then "`, `" and then "`. A bare mid-clause "then" never does.
 * - An "and" splits only when what follows opens with an action verb — an
 *   HTTP method in capitals, "fetch", "curl", "look up". Plain English "and"
 *   never does: "War and Peace" stays a title, "and get me a coffee" stays a
 *   clause (lowercase "get" is ambiguous, so it does not count).
 * - A marker that merely introduces the answer format — "then tell me what
 *   the server said" — is not a second hop, and splitting it would spend a
 *   generation on nothing: the step stays attached. (Three long-standing
 *   suite tasks at 100% phrase themselves exactly this way.)
 * - A "then" preceded by a conditional ("if the request fails, then…") is
 *   control flow, not sequencing: no split.
 * - Anything that produces more than three steps, or a fragment shorter than
 *   eight characters, abandons the split entirely.
 *
 * @module agent/split
 */

/**
 * Sequencing markers that may separate steps. A comma or semicolon before
 * "then" is consumed (a step should not end with a dangling comma); a full
 * stop is kept with its sentence via the lookbehind.
 */
const SEQUENCE = /[,;]\s+(?:and\s+)?then\s+|(?<=\.)\s+(?:and\s+)?then\s+|\s+and\s+then\s+/gi;

/**
 * A conjunction that starts a new errand rather than continuing a clause:
 * "and (also)" followed by an unmistakable action verb. Case matters — `GET`
 * is a tool instruction, "get" is everyday English — so this pattern has no
 * `i` flag and runs as a second pass alongside {@link SEQUENCE}.
 */
const FANOUT = /,?\s+and\s+(?:also\s+)?(?=(?:GET|POST|PUT|DELETE|HEAD|PATCH|[Ff]etch|[Cc]url|[Ll]ook\s+up)\b)/g;

/**
 * A clause that reports or formats the answer rather than doing new work.
 * "then tell me the method" is the tail of the current step, not a new one.
 */
const REPORTING = /^(?:and\s+)?(?:tell|say|report|answer|give|show|let\s+me\s+know|read|summari[sz]e|explain)\b/i;

/** A conditional in the preceding clause makes its "then" control flow. */
const CONDITIONAL = /\b(?:if|when|whenever|unless|once)\b/i;

const MAX_STEPS = 3;
const MIN_STEP_LENGTH = 8;

/**
 * Split a user message into sequential steps.
 *
 * Returns the original text as a single step whenever splitting is not
 * clearly safe — the caller needs no special case for "no split".
 *
 * @param {string} text
 * @returns {string[]} One or more steps, each trimmed and non-empty.
 */
export function splitSteps(text) {
  const s = String(text ?? '').trim();
  if (!s) return [s];

  const cuts = [];
  for (const re of [SEQUENCE, FANOUT]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) cuts.push({ index: m.index, end: re.lastIndex });
  }
  cuts.sort((a, b) => a.index - b.index);

  const parts = [];
  let last = 0;
  for (const cut of cuts) {
    // The two patterns can in principle claim overlapping text; the earlier
    // cut wins and a cut inside consumed text is dropped.
    if (cut.index < last) continue;
    const before = s.slice(last, cut.index);
    const after = s.slice(cut.end);
    if (REPORTING.test(after)) continue;
    if (CONDITIONAL.test(before)) continue;
    parts.push(before);
    last = cut.end;
  }
  if (last === 0) return [s];
  parts.push(s.slice(last));

  const steps = parts.map((p) => p.trim());
  if (steps.length < 2 || steps.length > MAX_STEPS) return [s];
  if (steps.some((p) => p.length < MIN_STEP_LENGTH)) return [s];
  return steps;
}
