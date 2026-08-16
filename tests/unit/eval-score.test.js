/**
 * Tests for the evaluation harness's grading rules.
 *
 * The harness measures the model; these tests measure the harness. A scorer
 * that flatters the model is worse than no measurement, because it produces
 * numbers people act on.
 */

import { describe, expect, it } from 'vitest';
import { Grade, grade, matchesTarget, significance, summarise, verdict, wilson } from '../../scripts/eval/score.js';

/** A request as `state/log.js` records it, reduced to what the scorer reads. */
function req(url, over = {}) {
  return { method: 'GET', url, status: 'ok', httpStatus: 200, ...over };
}

const TASK = {
  expectTool: true,
  expect: { host: 'en.wikipedia.org', pathIncludes: 'telephone' },
  answer: /bell/i,
};

describe('matchesTarget', () => {
  it('compares host exactly', () => {
    expect(matchesTarget({ host: 'en.wikipedia.org' }, req('https://en.wikipedia.org/x'))).toBe(true);
    expect(matchesTarget({ host: 'en.wikipedia.org' }, req('https://de.wikipedia.org/x'))).toBe(false);
    // A host that merely ends the right way is a different host.
    expect(matchesTarget({ host: 'wikipedia.org' }, req('https://en.wikipedia.org/x'))).toBe(false);
  });

  it('matches path and query as substrings, case-insensitively', () => {
    const r = req('https://en.wikipedia.org/api/rest_v1/page/summary/Telephone');
    expect(matchesTarget({ pathIncludes: 'telephone' }, r)).toBe(true);
    expect(matchesTarget({ pathIncludes: ['summary', 'telephone'] }, r)).toBe(true);
    expect(matchesTarget({ pathIncludes: 'telegraph' }, r)).toBe(false);
  });

  it('reads percent-encoded paths as the text they encode', () => {
    const r = req('https://en.wikipedia.org/w/index.php?search=Alexander%20Graham%20Bell');
    expect(matchesTarget({ pathIncludes: 'alexander graham bell' }, r)).toBe(true);
  });

  it('compares method case-insensitively', () => {
    expect(matchesTarget({ method: 'POST' }, req('https://x.test/', { method: 'post' }))).toBe(true);
    expect(matchesTarget({ method: 'POST' }, req('https://x.test/'))).toBe(false);
  });

  it('rejects a request whose URL will not parse', () => {
    expect(matchesTarget({ host: 'x.test' }, req('not a url'))).toBe(false);
  });

  it('matches anything when the task states no expectation', () => {
    expect(matchesTarget(undefined, req('https://anywhere.test/'))).toBe(true);
  });
});

describe('grade', () => {
  it('passes a correct request with a correct answer', () => {
    const sample = {
      requests: [req('https://en.wikipedia.org/api/rest_v1/page/summary/Telephone')],
      answer: 'Alexander Graham Bell invented it.',
    };
    expect(grade(TASK, sample)).toBe(Grade.OK);
  });

  it('scores a well-formed call to the wrong place as wrong_target, not success', () => {
    // The regression this whole module exists for: valid JSON, valid schema,
    // the example URL from the system prompt.
    const sample = {
      requests: [req('https://example.com/path')],
      answer: 'Alexander Graham Bell.',
    };
    expect(grade(TASK, sample)).toBe(Grade.WRONG_TARGET);
  });

  it('separates a right request from a wrong answer', () => {
    const sample = {
      requests: [req('https://en.wikipedia.org/api/rest_v1/page/summary/Telephone')],
      answer: 'It was invented by Thomas Edison.',
    };
    expect(grade(TASK, sample)).toBe(Grade.ANSWER_WRONG);
  });

  it('separates a refused server from a failed request', () => {
    const url = 'https://en.wikipedia.org/api/rest_v1/page/summary/Telephone';
    expect(grade(TASK, { requests: [req(url, { httpStatus: 404 })], answer: '' })).toBe(Grade.HTTP_ERROR);
    expect(grade(TASK, { requests: [req(url, { status: 'error' })], answer: '' })).toBe(Grade.REQUEST_FAILED);
  });

  it('grades a task about an error status on the answer, not the status', () => {
    const task = {
      expectTool: true,
      expect: { host: 'x.test', pathIncludes: '/status/404' },
      allowHttpError: true,
      answer: /404/,
    };
    const requests = [req('https://x.test/status/404', { httpStatus: 404 })];
    expect(grade(task, { requests, answer: 'It returned 404.' })).toBe(Grade.OK);
    expect(grade(task, { requests, answer: 'It worked fine.' })).toBe(Grade.ANSWER_WRONG);
  });

  it('counts a denied request as failed rather than on-target', () => {
    const url = 'https://en.wikipedia.org/api/rest_v1/page/summary/Telephone';
    expect(grade(TASK, { requests: [req(url, { status: 'denied' })], answer: '' })).toBe(Grade.REQUEST_FAILED);
  });

  it('credits the on-target request when the model also tried elsewhere', () => {
    const sample = {
      requests: [
        req('https://example.com/path'),
        req('https://en.wikipedia.org/api/rest_v1/page/summary/Telephone'),
      ],
      answer: 'Alexander Graham Bell.',
    };
    expect(grade(TASK, sample)).toBe(Grade.OK);
  });

  it('distinguishes silence from unparseable output', () => {
    expect(grade(TASK, { requests: [], stopReason: 'text', answer: 'I cannot.' })).toBe(Grade.NO_CALL);
    expect(grade(TASK, { requests: [], stopReason: 'unparseable', answer: '' })).toBe(Grade.MALFORMED);
  });

  it('grades a no-tool task on restraint before content', () => {
    const task = { expectTool: false, answer: /paris/i };
    expect(grade(task, { requests: [], answer: 'Paris.' })).toBe(Grade.OK);
    expect(grade(task, { requests: [], answer: 'Berlin.' })).toBe(Grade.ANSWER_WRONG);
    // Right answer, but it sent a request it was told not to send.
    expect(grade(task, { requests: [req('https://example.com/')], answer: 'Paris.' })).toBe(Grade.SPURIOUS);
  });

  it('accepts a plain string as the answer expectation', () => {
    const task = { expectTool: false, answer: 'Paris' };
    expect(grade(task, { requests: [], answer: 'The capital is paris.' })).toBe(Grade.OK);
  });

  it('passes on the request alone when the task states no answer expectation', () => {
    const task = { expectTool: true, expect: { host: 'x.test' } };
    expect(grade(task, { requests: [req('https://x.test/a')], answer: '' })).toBe(Grade.OK);
  });
});

describe('wilson', () => {
  it('never reports certainty from a small sample', () => {
    const { rate, low, high } = wilson(10, 10);
    expect(rate).toBe(1);
    expect(low).toBeLessThan(1);
    expect(high).toBe(1);
    // Ten out of ten is not 100% — the normal approximation would say it is.
    expect(low).toBeLessThan(0.8);
  });

  it('stays inside [0, 1] at the bottom too', () => {
    const { low, high } = wilson(0, 10);
    expect(low).toBe(0);
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
  });

  it('narrows as the sample grows', () => {
    const small = wilson(8, 10);
    const large = wilson(80, 100);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it('returns zeroes rather than NaN for no samples', () => {
    expect(wilson(0, 0)).toEqual({ rate: 0, low: 0, high: 0, successes: 0, n: 0 });
  });
});

describe('summarise', () => {
  it('counts every grade and passes only on ok', () => {
    const s = summarise([
      { grade: Grade.OK },
      { grade: Grade.OK },
      { grade: Grade.WRONG_TARGET },
      { grade: Grade.ANSWER_WRONG },
    ]);
    expect(s.n).toBe(4);
    expect(s.passes).toBe(2);
    expect(s.counts[Grade.WRONG_TARGET]).toBe(1);
    expect(s.rate).toBe(0.5);
  });
});

describe('verdict', () => {
  it('calls a small change on a small sample inconclusive', () => {
    expect(verdict(wilson(6, 10), wilson(8, 10))).toBe('inconclusive');
  });

  it('calls a large improvement better', () => {
    expect(verdict(wilson(10, 50), wilson(45, 50))).toBe('better');
  });

  it('calls a large regression worse', () => {
    expect(verdict(wilson(45, 50), wilson(10, 50))).toBe('worse');
  });

  it('no longer rejects a real effect for missing a bar it never needed', () => {
    // 15/20 -> 20/20. The intervals overlap by four tenths of a percentage
    // point, and the old non-overlap rule called this nothing. It is p < 0.02.
    expect(verdict(wilson(15, 20), wilson(20, 20))).toBe('better');
    // The regression that prompted this: 20/20 -> 13/20.
    expect(verdict(wilson(20, 20), wilson(13, 20))).toBe('worse');
  });

  it('still refuses to read a difference into identical arms', () => {
    expect(verdict(wilson(20, 20), wilson(20, 20))).toBe('inconclusive');
    expect(verdict(wilson(0, 20), wilson(0, 20))).toBe('inconclusive');
  });

  it('falls back to the interval check when counts are absent', () => {
    // An older caller passing bare {low, high} must not silently get a verdict
    // computed from undefined counts.
    expect(verdict({ low: 0.1, high: 0.3 }, { low: 0.5, high: 0.8 })).toBe('better');
    expect(verdict({ low: 0.5, high: 0.8 }, { low: 0.1, high: 0.3 })).toBe('worse');
    expect(verdict({ low: 0.1, high: 0.6 }, { low: 0.4, high: 0.9 })).toBe('inconclusive');
  });
});

describe('significance', () => {
  it('separates a significant result from an emphatic one', () => {
    const near = significance(wilson(15, 20), wilson(20, 20));
    expect(near.significant).toBe(true);
    // Non-overlapping intervals is the stronger claim, and this is not it.
    expect(near.emphatic).toBe(false);

    const wide = significance(wilson(10, 50), wilson(45, 50));
    expect(wide.significant).toBe(true);
    expect(wide.emphatic).toBe(true);
  });

  it('signs the statistic by direction of change', () => {
    expect(significance(wilson(5, 20), wilson(15, 20)).z).toBeGreaterThan(0);
    expect(significance(wilson(15, 20), wilson(5, 20)).z).toBeLessThan(0);
  });

  it('returns null rather than a number it cannot justify', () => {
    expect(significance({ low: 0, high: 1 }, wilson(5, 10))).toBeNull();
    expect(significance(wilson(0, 0), wilson(5, 10))).toBeNull();
  });
});
