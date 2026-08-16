/**
 * Scoring for the tool-call evaluation harness.
 *
 * Kept pure and separate from the browser driver so the grading rules — the
 * part that decides what "worked" means — can be unit-tested without a GPU.
 *
 * The distinction this module exists to make is between *called the tool* and
 * *called it correctly*. `scripts/model-check.js` scores a sample on
 * `iterations > 0`, which counts a well-formed request to the wrong host as a
 * clean success. That is not a hypothetical: a 0.6B model asked for
 * `http://127.0.0.1:41234/json` has been observed proposing
 * `https://example.com/path` — the example URL from the system prompt's schema
 * block — and the old scoring called it a first-try pass.
 *
 * @module scripts/eval/score
 */

/**
 * Outcomes, ordered roughly from best to worst. One sample gets exactly one.
 */
export const Grade = Object.freeze({
  /** Right request, request succeeded, answer contains what was asked for. */
  OK: 'ok',
  /** Right request, real response, but the answer missed what was in it. */
  ANSWER_WRONG: 'answer_wrong',
  /** Right host and path, and the server refused: 4xx or 5xx. */
  HTTP_ERROR: 'http_error',
  /** Right target, but the request never completed (CORS, timeout, refused). */
  REQUEST_FAILED: 'request_failed',
  /** A well-formed call to somewhere other than what was asked for. */
  WRONG_TARGET: 'wrong_target',
  /** A call was needed and none was made. */
  NO_CALL: 'no_call',
  /** Never produced a parseable call, repair round included. */
  MALFORMED: 'malformed',
  /** Called the tool on a prompt that said not to. */
  SPURIOUS: 'spurious',
});

/** The grades that mean the agent did the job. */
export const PASSING = Object.freeze([Grade.OK]);

/**
 * Does one recorded request match what the task asked for?
 *
 * Host is compared exactly, because "close enough" is the failure mode being
 * measured. Path and query are substring checks: there is usually more than one
 * legitimate URL for the same lookup, and pinning the whole string would score
 * correct behaviour as failure.
 *
 * @param {{host?: string, pathIncludes?: string|string[], method?: string}} expect
 * @param {{method?: string, url?: string}} request
 * @returns {boolean}
 */
export function matchesTarget(expect, request) {
  if (!expect) return true;
  let url;
  try {
    url = new URL(request?.url || '');
  } catch {
    return false;
  }
  if (expect.host && url.host !== expect.host) return false;
  if (expect.method && String(request.method || '').toUpperCase() !== expect.method.toUpperCase()) {
    return false;
  }
  const needles = expect.pathIncludes
    ? [expect.pathIncludes].flat()
    : [];
  const haystack = decodeURIComponent(`${url.pathname}${url.search}`).toLowerCase();
  return needles.every((n) => haystack.includes(String(n).toLowerCase()));
}

/**
 * Grade one sample.
 *
 * @param {object} task Task definition; see `scripts/eval/tasks.js`.
 * @param {object} sample Recorded outcome of one run.
 * @returns {string} A {@link Grade}.
 */
export function grade(task, sample) {
  const requests = sample?.requests || [];

  // A task that must not call the tool is graded on restraint first: an answer
  // that happens to contain the right word is no consolation for having sent a
  // request it was told not to send.
  if (task.expectTool === false) {
    if (requests.length > 0) return Grade.SPURIOUS;
    return answerMatches(task, sample) ? Grade.OK : Grade.ANSWER_WRONG;
  }

  if (requests.length === 0) {
    return sample?.stopReason === 'unparseable' ? Grade.MALFORMED : Grade.NO_CALL;
  }

  // A fan-out task lists one expectation per required request (`expectEach`),
  // and every one of them must be met — "look up A and B" with only A fetched
  // is the fan-out not happening, and it lands in wrong_target exactly as a
  // chain task's missing hop does. A task with a single `expect` is the
  // one-element case of the same rule.
  const expects = task.expectEach || [task.expect];
  const hitsPer = expects.map((e) => requests.filter((r) => matchesTarget(e, r)));
  if (hitsPer.some((hits) => hits.length === 0)) return Grade.WRONG_TARGET;

  if (hitsPer.some((hits) => !hits.some((r) => r.status === 'ok'))) {
    // Some tasks are about what the agent does when a request *cannot* succeed
    // — an unreachable host, a refused connection. There the failure is the
    // premise, not the outcome, and the thing being graded is whether the agent
    // reported it honestly instead of inventing a response or looping.
    if (!task.allowRequestFailure) return Grade.REQUEST_FAILED;
    return answerMatches(task, sample) ? Grade.OK : Grade.ANSWER_WRONG;
  }

  // `status: 'ok'` means the round-trip happened, not that the server agreed.
  // A 404 is data the model is entitled to reason about, but for a lookup task
  // it almost always means it guessed a title that does not exist, and that is
  // worth seeing separately from a wrong answer. Tasks whose whole point is an
  // error status say so and are graded on the answer instead.
  if (!task.allowHttpError) {
    const answered = (hits) => hits.some((r) => r.status === 'ok' && (r.httpStatus ?? 200) < 400);
    if (!hitsPer.every(answered)) return Grade.HTTP_ERROR;
  }

  return answerMatches(task, sample) ? Grade.OK : Grade.ANSWER_WRONG;
}

/**
 * @param {object} task
 * @param {object} sample
 * @returns {boolean}
 */
function answerMatches(task, sample) {
  if (!task.answer) return true;
  const text = String(sample?.answer ?? '');
  return task.answer instanceof RegExp
    ? task.answer.test(text)
    : text.toLowerCase().includes(String(task.answer).toLowerCase());
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * The normal approximation is useless at the sample sizes and rates this
 * harness works at — it produces intervals reaching past 1 for a 9/10, and a
 * zero-width interval for a 10/10, which would report "100%, certainly" from
 * ten draws. Wilson stays inside [0, 1] and keeps a sane width at the extremes,
 * which is the whole reason for quoting an interval at all.
 *
 * @param {number} successes
 * @param {number} total
 * @param {number} [z] 1.96 for 95%.
 * @returns {{rate: number, low: number, high: number}}
 */
export function wilson(successes, total, z = 1.96) {
  if (total <= 0) return { rate: 0, low: 0, high: 0, successes: 0, n: 0 };
  const p = successes / total;
  const d = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    rate: p,
    low: Math.max(0, (centre - spread) / d),
    high: Math.min(1, (centre + spread) / d),
    // Carried so `verdict` can run a real test rather than inspect the bars.
    successes,
    n: total,
  };
}

/**
 * How many requests in this sample repeated an identical, already-successful
 * request — same method, same URL, both completing.
 *
 * Separate from the pass/fail grades because it usually is not a failure: the
 * model re-fetches, gets the same bytes, and still answers correctly. It is
 * wasted budget that occasionally becomes a capped turn (a holdout sample
 * fetched the same URL four times and ran out of iterations), and it was
 * invisible in the rates until a holdout failure exposed it.
 *
 * @param {Array<{method?: string, url?: string, status?: string}>} requests
 * @returns {number} Count of redundant successful sends (0 when none).
 */
export function countRepeatedOk(requests) {
  const seen = new Map();
  let repeats = 0;
  for (const r of requests || []) {
    if (r?.status !== 'ok') continue;
    const key = `${String(r.method || '').toUpperCase()} ${r.url}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) repeats += 1;
  }
  return repeats;
}

/**
 * Roll a list of graded samples up into counts and a pass rate.
 *
 * `repeatOk` — how many samples repeated an already-successful request — rides
 * along so the waste is visible in every run, not only when it costs a pass.
 *
 * @param {Array<{grade: string, sample?: object}>} graded
 * @returns {{n: number, passes: number, counts: Record<string, number>, repeatOk: number, rate: number, low: number, high: number}}
 */
export function summarise(graded) {
  const counts = {};
  for (const g of graded) counts[g.grade] = (counts[g.grade] || 0) + 1;
  const passes = graded.filter((g) => PASSING.includes(g.grade)).length;
  const repeatOk = graded.filter((g) => countRepeatedOk(g.sample?.requests) > 0).length;
  return { n: graded.length, passes, counts, repeatOk, ...wilson(passes, graded.length) };
}

/**
 * Is the difference between two measured rates worth acting on?
 *
 * This used to ask whether the two confidence intervals failed to overlap. That
 * is not a significance test: for two proportions it corresponds to roughly
 * p < 0.005, so it rejected real effects as "inconclusive" and sent us off to
 * spend GPU hours collecting samples to prove things we had already shown. It
 * called 75% -> 100% at n=20 a non-result.
 *
 * So the bar is now the standard two-proportion z-test at 95%, and the
 * non-overlap check is kept only as the stronger `emphatic` flag. The point of
 * the harness is to stop us believing noise, not to stop us believing evidence.
 *
 * @param {{low: number, high: number, successes?: number, n?: number}} before
 * @param {{low: number, high: number, successes?: number, n?: number}} after
 * @returns {'better'|'worse'|'inconclusive'}
 */
export function verdict(before, after) {
  const test = significance(before, after);
  if (test === null) {
    // No counts (an older caller passing bare intervals): fall back to the
    // interval check rather than guess.
    if (after.low > before.high) return 'better';
    if (after.high < before.low) return 'worse';
    return 'inconclusive';
  }
  if (!test.significant) return 'inconclusive';
  return test.z > 0 ? 'better' : 'worse';
}

/**
 * Two-proportion z-test. Returns null when either side carries no counts.
 *
 * @param {{successes?: number, n?: number}} before
 * @param {{successes?: number, n?: number}} after
 * @param {number} [z] Critical value; 1.96 for 95%.
 * @returns {{z: number, significant: boolean, emphatic: boolean}|null}
 */
export function significance(before, after, z = 1.96) {
  if (!Number.isFinite(before?.n) || !Number.isFinite(after?.n)) return null;
  if (before.n <= 0 || after.n <= 0) return null;

  const p1 = before.successes / before.n;
  const p2 = after.successes / after.n;
  const pooled = (before.successes + after.successes) / (before.n + after.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / before.n + 1 / after.n));
  // Both arms identical and at a boundary (0/20 vs 0/20, 20/20 vs 20/20): no
  // difference to detect, and the ratio would be 0/0.
  if (se === 0) return { z: 0, significant: false, emphatic: false };

  const stat = (p2 - p1) / se;
  return {
    z: stat,
    significant: Math.abs(stat) > z,
    emphatic: after.low > before.high || after.high < before.low,
  };
}
