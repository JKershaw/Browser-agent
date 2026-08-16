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

  const onTarget = requests.filter((r) => matchesTarget(task.expect, r));
  if (onTarget.length === 0) return Grade.WRONG_TARGET;

  const delivered = onTarget.filter((r) => r.status === 'ok');
  if (delivered.length === 0) return Grade.REQUEST_FAILED;

  // `status: 'ok'` means the round-trip happened, not that the server agreed.
  // A 404 is data the model is entitled to reason about, but for a lookup task
  // it almost always means it guessed a title that does not exist, and that is
  // worth seeing separately from a wrong answer. Tasks whose whole point is an
  // error status say so and are graded on the answer instead.
  if (!task.allowHttpError) {
    const answered = delivered.filter((r) => (r.httpStatus ?? 200) < 400);
    if (answered.length === 0) return Grade.HTTP_ERROR;
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
  if (total <= 0) return { rate: 0, low: 0, high: 0 };
  const p = successes / total;
  const d = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    rate: p,
    low: Math.max(0, (centre - spread) / d),
    high: Math.min(1, (centre + spread) / d),
  };
}

/**
 * Roll a list of graded samples up into counts and a pass rate.
 *
 * @param {Array<{grade: string}>} graded
 * @returns {{n: number, passes: number, counts: Record<string, number>, rate: number, low: number, high: number}}
 */
export function summarise(graded) {
  const counts = {};
  for (const g of graded) counts[g.grade] = (counts[g.grade] || 0) + 1;
  const passes = graded.filter((g) => PASSING.includes(g.grade)).length;
  return { n: graded.length, passes, counts, ...wilson(passes, graded.length) };
}

/**
 * Is the difference between two measured rates worth acting on?
 *
 * Deliberately conservative: it asks whether the intervals fail to overlap,
 * which is a stricter bar than a significance test and the right one for a loop
 * where every "improvement" is a change to a prompt that ships. Non-overlapping
 * intervals at n=30 is a real effect; anything less is noise wearing a number.
 *
 * @param {{low: number, high: number}} before
 * @param {{low: number, high: number}} after
 * @returns {'better'|'worse'|'inconclusive'}
 */
export function verdict(before, after) {
  if (after.low > before.high) return 'better';
  if (after.high < before.low) return 'worse';
  return 'inconclusive';
}
