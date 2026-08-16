import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { END, START, replaceMirror } from '../../scripts/sync-prompt-docs.js';
import { buildSystemPrompt, capMessage, denialMessage, repeatedCallMessage, toolResultMessage } from '../../src/agent/prompts.js';

/**
 * SPEC §10 calls prompt text load-bearing, and it is: small models follow the
 * tool-call contract only when told this explicitly. These assert the clauses
 * that carry weight, so a well-meaning tidy-up cannot silently delete one.
 */
describe('buildSystemPrompt', () => {
  const base = () => buildSystemPrompt({ maxIterations: 5 });

  it('states the tool-call contract exactly', () => {
    const p = base();
    expect(p).toContain('{"tool": "curl", "args": {"method": "GET", "url": "https://example.com/path", "headers": {}, "body": null}}');
    expect(p).toContain('```json');
    expect(p).toMatch(/reply with ONLY a fenced JSON block/i);
  });

  it('lists every permitted method and the URL rule', () => {
    const p = base();
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) expect(p).toContain(m);
    expect(p).toMatch(/must be absolute and start with http:\/\/ or https:\/\//);
    expect(p).toMatch(/GET and HEAD must use null/);
  });

  it('names the iteration budget it was given', () => {
    // A missing or wrong budget lets the model plan work it will never finish.
    expect(buildSystemPrompt({ maxIterations: 3 })).toContain('at most 3 tool calls');
    expect(buildSystemPrompt({ maxIterations: 10 })).toContain('at most 10 tool calls');
  });

  it('tells the model to report failures rather than invent data', () => {
    expect(base()).toMatch(/Never invent the result of a call/);
    expect(base()).toMatch(/rather than pretending the request worked or inventing data/);
  });

  it('says the tool is optional, so a plain answer is not a failure', () => {
    // Without this the model answered "none of the provided tools can be used
    // to answer the question" when asked for the capital of France.
    const p = buildSystemPrompt();
    // Plural: with two tools, "the tool is optional" read as naming curl
    // alone, leaving the easier one exempt from the only line granting
    // restraint.
    expect(p).toMatch(/Both tools are optional/i);
    expect(p).toMatch(/plain prose/);
  });

  it('forbids sending either example value, which models copy', () => {
    // 17 samples out of 20 sent https://example.com/... instead of the URL
    // they were given, and the first real-model e2e failure was the same
    // substitution. The wiki example is a person's name rather than an
    // obvious template, which makes it likelier to be copied, not less.
    const p = buildSystemPrompt();
    expect(p).toMatch(/placeholder\. Never send it/);
    expect(p).toMatch(/"Alan Turing" is a placeholder too/);
    expect(p).toMatch(/character for character/);
    expect(p).toMatch(/Search for what the user actually asked about/);
  });

  it('offers the wiki tool first and says when to pick it', () => {
    const p = buildSystemPrompt();
    // A model that reads no further than the first example should have found
    // the one-argument tool.
    expect(p.indexOf('"tool": "wiki"')).toBeLessThan(p.indexOf('"tool": "curl"'));
    expect(p).toMatch(/takes a search term, not a URL/);
    expect(p).toMatch(/If the user gives you a URL, use `curl` with that URL/);
  });

  it('makes the lookup rule conditional on needing a lookup', () => {
    // Measured: "Use `wiki` whenever the answer would be on Wikipedia" is
    // unconditionally true of almost any question, and took restraint on
    // "answer without using a tool" from 100% to 0% in 20 samples out of 20.
    const p = buildSystemPrompt();
    expect(p).toMatch(/When you need to look something up/);
    expect(p).not.toMatch(/whenever the answer would be on Wikipedia/);
  });

  it('warns that HTML pages are unreachable and APIs are not', () => {
    // Not decoration: without this the 0.6B model reached for the article URL
    // on every Wikipedia lookup, which the browser refuses cross-origin.
    const p = buildSystemPrompt();
    expect(p).toMatch(/CORS/);
    expect(p).toMatch(/JSON API/i);
    expect(p).toMatch(/do not retry it/i);
  });

  it('explains the TOOL RESULT marker it will receive', () => {
    expect(base()).toContain('TOOL RESULT');
  });

  it('frames a denial as a real answer, not an error to retry', () => {
    expect(base()).toMatch(/A denial is a real answer from the user, not an error to retry blindly/);
  });

  it('suppresses reasoning unless thinking mode is on', () => {
    // SPEC §4.2: thinking off by default, because it triples tool-loop latency.
    expect(buildSystemPrompt({ thinking: false })).toMatch(/Do not emit reasoning or <think> blocks/);
    expect(buildSystemPrompt({ thinking: true })).not.toMatch(/Do not emit reasoning/);
  });

  it('discloses the allowlist when one is configured, and not otherwise', () => {
    const withList = buildSystemPrompt({ allowlist: ['api.github.com', 'api.test'] });
    expect(withList).toContain('api.github.com');
    expect(withList).toMatch(/restricted to these domains/i);
    expect(base()).not.toMatch(/restricted to these domains/i);
  });

  it('teaches the placeholder syntax only when credentials exist', () => {
    const withCreds = buildSystemPrompt({ credentialNames: ['GitHub', 'Weather'] });
    expect(withCreds).toContain('{{GitHub}}');
    expect(withCreds).toContain('{{Weather}}');
    expect(withCreds).toMatch(/you never see it/);
    expect(base()).not.toContain('{{');
  });

  it('cannot leak a credential value, because it is never given one', () => {
    // The model gets names only; the browser substitutes the value at send
    // time. Passing a whole credential object must not smuggle the value in.
    const p = buildSystemPrompt({ credentialNames: ['GitHub'] });
    expect(p).toContain('{{GitHub}}');
    expect(p).not.toContain('ghp_');
  });
});

describe('docs/prompts.md', () => {
  it('mirrors the built prompt verbatim', () => {
    // The doc claims to be verbatim, and a mirror maintained by hand drifts:
    // it once carried a stale hint example (`Article_Title`) describing
    // behaviour the code had already stopped producing. Run
    // `npm run docs:prompts` to fix a failure here.
    const doc = readFileSync(new URL('../../docs/prompts.md', import.meta.url), 'utf8');
    expect(doc).toContain(buildSystemPrompt());
  });

  it('has the anchors the sync script needs', () => {
    // A rename that broke these would make the sync script throw rather than
    // silently write a doc with the prompt missing — but better to fail here.
    const doc = readFileSync(new URL('../../docs/prompts.md', import.meta.url), 'utf8');
    expect(doc).toContain(START);
    expect(doc).toContain(END);
    expect(replaceMirror(doc, 'REPLACED')).toContain('REPLACED');
  });
});

describe('toolResultMessage', () => {
  it('leads with the marker the system prompt names', () => {
    expect(toolResultMessage('HTTP 200')).toBe('TOOL RESULT\nHTTP 200');
  });
});

describe('denialMessage', () => {
  const call = { method: 'DELETE', url: 'https://api.example.com/things/42' };

  it('states what was refused and forbids a blind retry', () => {
    const m = denialMessage(call, 'I do not want to delete that.');
    expect(m).toContain('DENIED BY USER');
    expect(m).toContain('DELETE https://api.example.com/things/42');
    expect(m).toContain('I do not want to delete that.');
    expect(m).toMatch(/Do not retry the same request/);
  });

  it('is explicit when no reason was given', () => {
    expect(denialMessage(call)).toContain('No reason was given.');
  });
});

describe('repeatedCallMessage', () => {
  const call = { method: 'GET', url: 'https://wikipedia.org/wiki/Alan_Turing' };

  it('says nothing was sent, and why repeating cannot help', () => {
    const m = repeatedCallMessage(call);
    expect(m).toContain('NOT SENT');
    expect(m).toContain('GET https://wikipedia.org/wiki/Alan_Turing');
    expect(m).toMatch(/will not be different/);
  });

  it('ends with the working URL when one is known', () => {
    const m = repeatedCallMessage(call, 'https://en.wikipedia.org/api/rest_v1/page/summary/Alan_Turing');
    expect(m.trim().split('\n').pop()).toBe(
      'NEXT STEP: call the tool again with exactly this URL: https://en.wikipedia.org/api/rest_v1/page/summary/Alan_Turing'
    );
  });

  it('offers a way forward even when no URL is known', () => {
    // A dead end with no next step is how the model ends up narrating a
    // response it never received.
    const last = repeatedCallMessage(call).trim().split('\n').pop();
    expect(last).toMatch(/^NEXT STEP:/);
    expect(last).toMatch(/wiki tool with a plain search term/);
  });
});

describe('capMessage', () => {
  it('counts sent requests and refusals separately', () => {
    // Telling a user who denied everything that the agent "made 3 tool calls"
    // is simply untrue.
    expect(capMessage(3, 0)).toContain('3 tool calls');
    expect(capMessage(3, 0)).not.toContain('refused');
    expect(capMessage(0, 2)).toContain('2 refused requests');
    expect(capMessage(0, 2)).not.toMatch(/\d+ tool calls/);
    expect(capMessage(2, 1)).toContain('2 tool calls and 1 refused request');
  });

  it('uses singular forms correctly', () => {
    expect(capMessage(1, 0)).toContain('1 tool call —');
    expect(capMessage(0, 1)).toContain('1 refused request');
  });

  it('says something sensible when nothing completed', () => {
    expect(capMessage(0, 0)).toContain('no completed tool calls');
  });
});
