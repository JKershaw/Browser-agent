import { describe, it, expect } from 'vitest';
import { splitSteps } from '../../src/agent/split.js';

describe('splitSteps', () => {
  it('splits an explicit two-hop chain on ", then "', () => {
    const steps = splitSteps(
      'Use the curl tool to GET http://127.0.0.1:9/json to find out which city the weather is for, then look that city up on Wikipedia and tell me which country it is in.'
    );
    expect(steps).toEqual([
      'Use the curl tool to GET http://127.0.0.1:9/json to find out which city the weather is for',
      'look that city up on Wikipedia and tell me which country it is in.',
    ]);
  });

  it('splits on " and then " when the next clause is an action', () => {
    expect(splitSteps('Look up Marie Curie on Wikipedia and then look up radium too.')).toEqual([
      'Look up Marie Curie on Wikipedia',
      'look up radium too.',
    ]);
  });

  it('splits on a sentence-initial "Then"', () => {
    expect(splitSteps('Fetch http://a.test/one for me. Then fetch http://a.test/two as well.')).toEqual([
      'Fetch http://a.test/one for me.',
      'fetch http://a.test/two as well.',
    ]);
  });

  it('splits a three-step chain', () => {
    expect(
      splitSteps('Fetch http://a.test/one please, then fetch http://a.test/two please, then look up Bristol on Wikipedia.')
    ).toHaveLength(3);
  });

  it('does not split before a reporting clause', () => {
    const ask = 'Use the curl tool to POST the JSON {"hello":"world"} to http://a.test/echo, then tell me what method the server said it received.';
    expect(splitSteps(ask)).toEqual([ask]);
  });

  it.each(['tell', 'say', 'report', 'answer', 'give', 'show', 'summarise', 'explain'])(
    'treats "then %s…" as the same step',
    (verb) => {
      const ask = `Fetch http://a.test/json for me, then ${verb} me everything about the result please.`;
      expect(splitSteps(ask)).toEqual([ask]);
    }
  );

  it('does not split "and then tell me" either', () => {
    const ask = 'GET https://en.wikipedia.org/api/rest_v1/page/summary/Clifton_Suspension_Bridge and then tell me in which year it opened.';
    expect(splitSteps(ask)).toEqual([ask]);
  });

  it('does not split a conditional "if …, then …"', () => {
    const ask = 'If the response is an error, then fetch http://a.test/fallback instead.';
    expect(splitSteps(ask)).toEqual([ask]);
  });

  it('does not split a bare mid-clause "then"', () => {
    const ask = 'What happened then to the Roman empire?';
    expect(splitSteps(ask)).toEqual([ask]);
  });

  it('abandons the split when a fragment is too short', () => {
    const ask = 'Do it, then go.';
    expect(splitSteps(ask)).toEqual([ask]);
  });

  it('abandons the split past three steps', () => {
    const ask = 'Fetch page one please, then fetch page two please, then fetch page three please, then fetch page four please.';
    expect(splitSteps(ask)).toEqual([ask]);
  });

  it('returns single-step asks untouched', () => {
    expect(splitSteps('What is the capital of France?')).toEqual(['What is the capital of France?']);
  });

  it('handles empty and nullish input without throwing', () => {
    expect(splitSteps('')).toEqual(['']);
    expect(splitSteps(null)).toEqual(['']);
    expect(splitSteps(undefined)).toEqual(['']);
  });
});
