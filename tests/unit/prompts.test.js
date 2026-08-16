import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, capMessage, denialMessage, toolResultMessage } from '../../src/agent/prompts.js';

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
