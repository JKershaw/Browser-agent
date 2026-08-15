import { describe, it, expect } from 'vitest';
import {
  ALLOWED_METHODS,
  ParseError,
  extractJsonCandidate,
  parseToolCall,
  repairPrompt,
  stripThinking,
  validateToolCall,
} from '../../src/agent/toolcall.js';

const call = (args) => JSON.stringify({ tool: 'curl', args });

describe('stripThinking', () => {
  it('returns empty string for non-strings', () => {
    expect(stripThinking(null)).toBe('');
    expect(stripThinking(undefined)).toBe('');
    expect(stripThinking(42)).toBe('');
  });

  it('removes closed think blocks', () => {
    expect(stripThinking('<think>hmm, let me plan</think>Hello')).toBe('Hello');
    expect(stripThinking('<thinking>a</thinking>X<thinking>b</thinking>Y')).toBe('XY');
  });

  it('removes an unterminated think block and everything after it', () => {
    expect(stripThinking('Answer first.<think>then I trail off')).toBe('Answer first.');
  });

  it('drops content before a stray closing tag', () => {
    expect(stripThinking('leftover reasoning</think>the answer')).toBe('the answer');
  });

  it('leaves ordinary text untouched', () => {
    expect(stripThinking('  plain answer  ')).toBe('plain answer');
  });
});

describe('extractJsonCandidate', () => {
  it('returns null when there is no object at all', () => {
    expect(extractJsonCandidate('just prose')).toBeNull();
    expect(extractJsonCandidate('')).toBeNull();
    expect(extractJsonCandidate(null)).toBeNull();
  });

  it('prefers a fenced json block and keeps surrounding prose', () => {
    const text = 'I will fetch it.\n```json\n{"tool":"curl"}\n```\nDone.';
    const got = extractJsonCandidate(text);
    expect(got.json).toBe('{"tool":"curl"}');
    expect(got.prose).toBe('I will fetch it.\n\nDone.');
  });

  it('accepts an unlabelled fence', () => {
    expect(extractJsonCandidate('```\n{"tool":"curl"}\n```').json).toBe('{"tool":"curl"}');
  });

  it('skips fences of other languages', () => {
    const text = '```python\nprint({"tool": 1})\n```\n```json\n{"tool":"curl"}\n```';
    expect(extractJsonCandidate(text).json).toBe('{"tool":"curl"}');
  });

  it('handles an unterminated fence from a truncated stream', () => {
    expect(extractJsonCandidate('```json\n{"tool":"curl"').json).toBe('{"tool":"curl"');
  });

  it('falls back to the first balanced object in bare prose', () => {
    const got = extractJsonCandidate('sure: {"tool":"curl","args":{"url":"https://a.test"}} ok');
    expect(JSON.parse(got.json).args.url).toBe('https://a.test');
    expect(got.prose).toBe('sure:  ok');
  });

  it('ignores braces inside JSON strings when balancing', () => {
    const got = extractJsonCandidate('{"tool":"curl","args":{"body":"}{ \\" }"}}');
    expect(JSON.parse(got.json).args.body).toBe('}{ " }');
  });

  it('returns the remainder when braces never balance', () => {
    expect(extractJsonCandidate('text {"tool":"curl"').json).toBe('{"tool":"curl"');
  });

  it('skips a fence with no object inside', () => {
    expect(extractJsonCandidate('```json\nnot an object\n```\n{"tool":"curl"}').json).toBe('{"tool":"curl"}');
  });
});

describe('validateToolCall', () => {
  it('accepts a minimal GET and normalises defaults', () => {
    const r = validateToolCall({ tool: 'curl', args: { url: 'https://example.com' } });
    expect(r.ok).toBe(true);
    expect(r.call.args).toEqual({
      method: 'GET',
      url: 'https://example.com/',
      headers: {},
      body: null,
    });
  });

  it('upper-cases the method and trims header names', () => {
    const r = validateToolCall({
      tool: 'curl',
      args: { method: ' post ', url: 'https://a.test/x', headers: { ' X-A ': 'v' }, body: 'hi' },
    });
    expect(r.call.args.method).toBe('POST');
    expect(r.call.args.headers).toEqual({ 'X-A': 'v' });
  });

  it.each(ALLOWED_METHODS)('accepts method %s', (method) => {
    const args = { method, url: 'https://a.test' };
    if (!['GET', 'HEAD'].includes(method)) args.body = 'x';
    expect(validateToolCall({ tool: 'curl', args }).ok).toBe(true);
  });

  it.each([
    [null, ParseError.NOT_OBJECT],
    ['a string', ParseError.NOT_OBJECT],
    [[1, 2], ParseError.NOT_OBJECT],
  ])('rejects non-object %s', (input, code) => {
    expect(validateToolCall(input).error.code).toBe(code);
  });

  it('rejects an unknown tool', () => {
    const r = validateToolCall({ tool: 'shell', args: {} });
    expect(r.error.code).toBe(ParseError.UNKNOWN_TOOL);
    expect(r.error.message).toContain('curl');
  });

  it.each([undefined, null, 'nope', [1]])('rejects args=%s', (args) => {
    expect(validateToolCall({ tool: 'curl', args }).error.code).toBe(ParseError.MISSING_ARGS);
  });

  it.each([
    ['TRACE', ParseError.BAD_METHOD],
    ['OPTIONS', ParseError.BAD_METHOD],
    ['', ParseError.BAD_METHOD],
  ])('rejects method %s', (method, code) => {
    expect(validateToolCall({ tool: 'curl', args: { method, url: 'https://a.test' } }).error.code).toBe(code);
  });

  it('rejects a non-string method', () => {
    expect(validateToolCall({ tool: 'curl', args: { method: 7, url: 'https://a.test' } }).error.code)
      .toBe(ParseError.BAD_METHOD);
  });

  it.each([undefined, null, '', '   ', 42, {}])('rejects url=%s', (url) => {
    expect(validateToolCall({ tool: 'curl', args: { url } }).error.code).toBe(ParseError.BAD_URL);
  });

  it('rejects a relative url with a helpful message', () => {
    const r = validateToolCall({ tool: 'curl', args: { url: '/api/things' } });
    expect(r.error.code).toBe(ParseError.BAD_URL);
    expect(r.error.message).toContain('absolute');
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi', 'ftp://a.test/x'])(
    'rejects blocked scheme %s',
    (url) => {
      expect(validateToolCall({ tool: 'curl', args: { url } }).error.code).toBe(ParseError.BAD_SCHEME);
    }
  );

  it('rejects non-object headers', () => {
    expect(validateToolCall({ tool: 'curl', args: { url: 'https://a.test', headers: 'X: 1' } }).error.code)
      .toBe(ParseError.BAD_HEADERS);
    expect(validateToolCall({ tool: 'curl', args: { url: 'https://a.test', headers: ['X'] } }).error.code)
      .toBe(ParseError.BAD_HEADERS);
  });

  it('rejects a header with a null or object value', () => {
    expect(validateToolCall({ tool: 'curl', args: { url: 'https://a.test', headers: { A: null } } }).error.message)
      .toContain('null');
    expect(validateToolCall({ tool: 'curl', args: { url: 'https://a.test', headers: { A: {} } } }).error.code)
      .toBe(ParseError.BAD_HEADERS);
  });

  it('coerces numeric and boolean header values', () => {
    const r = validateToolCall({
      tool: 'curl',
      args: { url: 'https://a.test', headers: { 'Content-Length': 12, 'X-Flag': true } },
    });
    expect(r.call.args.headers).toEqual({ 'Content-Length': '12', 'X-Flag': 'true' });
  });

  it('rejects an empty header name', () => {
    expect(validateToolCall({ tool: 'curl', args: { url: 'https://a.test', headers: { '  ': 'v' } } }).error.code)
      .toBe(ParseError.BAD_HEADERS);
  });

  it('serialises an object body instead of failing', () => {
    const r = validateToolCall({ tool: 'curl', args: { method: 'POST', url: 'https://a.test', body: { a: 1 } } });
    expect(r.call.args.body).toBe('{"a":1}');
  });

  it('rejects a non-string, non-object body', () => {
    expect(validateToolCall({ tool: 'curl', args: { method: 'POST', url: 'https://a.test', body: 5 } }).error.code)
      .toBe(ParseError.BAD_BODY);
  });

  it.each(['GET', 'HEAD'])('rejects a body on %s', (method) => {
    const r = validateToolCall({ tool: 'curl', args: { method, url: 'https://a.test', body: 'x' } });
    expect(r.error.code).toBe(ParseError.BODY_NOT_ALLOWED);
  });

  it('allows an explicit null body on GET', () => {
    expect(validateToolCall({ tool: 'curl', args: { method: 'GET', url: 'https://a.test', body: null } }).ok).toBe(true);
  });
});

describe('parseToolCall', () => {
  it('parses a fenced call', () => {
    const r = parseToolCall('Let me look.\n```json\n' + call({ method: 'GET', url: 'https://a.test/x' }) + '\n```');
    expect(r.kind).toBe('tool_call');
    expect(r.call.args.url).toBe('https://a.test/x');
    expect(r.prose).toBe('Let me look.');
  });

  it('parses a call wrapped in thinking mode output', () => {
    const raw = '<think>The user wants the time. I should call curl.</think>\n```json\n' + call({ url: 'https://a.test' }) + '\n```';
    expect(parseToolCall(raw).kind).toBe('tool_call');
  });

  it('parses a bare (unfenced) call', () => {
    expect(parseToolCall(call({ url: 'https://a.test' })).kind).toBe('tool_call');
  });

  it('treats a plain answer as text', () => {
    const r = parseToolCall('The capital of France is Paris.');
    expect(r).toMatchObject({ kind: 'text', text: 'The capital of France is Paris.' });
  });

  it('treats JSON that is not a tool call as text, not a broken call', () => {
    const r = parseToolCall('Here is an example object: {"name": "ada", "age": 36}');
    expect(r.kind).toBe('text');
  });

  it('treats malformed JSON without a tool key as text', () => {
    expect(parseToolCall('smiley {: not json').kind).toBe('text');
  });

  it('reports malformed JSON that was clearly meant to be a call', () => {
    const r = parseToolCall('```json\n{"tool": "curl", "args": {"url": https://a.test}}\n```');
    expect(r.kind).toBe('error');
    expect(r.error.code).toBe(ParseError.JSON_PARSE);
    expect(r.candidate).toContain('"tool"');
  });

  it('reports schema violations with the raw text preserved', () => {
    const raw = '```json\n' + call({ method: 'TRACE', url: 'https://a.test' }) + '\n```';
    const r = parseToolCall(raw);
    expect(r.kind).toBe('error');
    expect(r.error.code).toBe(ParseError.BAD_METHOD);
    expect(r.raw).toBe(raw);
  });

  it('handles an array at top level as text', () => {
    expect(parseToolCall('[1,2,3]').kind).toBe('text');
  });
});

describe('repairPrompt', () => {
  it('embeds the code and message and shows the required shape', () => {
    const p = repairPrompt({ code: ParseError.BAD_URL, message: 'args.url must be a non-empty string.' });
    expect(p).toContain(ParseError.BAD_URL);
    expect(p).toContain('args.url must be a non-empty string.');
    expect(p).toContain('"tool": "curl"');
  });
});
