import { describe, expect, it } from 'vitest';
import { visibleStreamText } from '../../src/agent/stream-filter.js';

/**
 * Simulate streaming: feed the text in character-sized deltas and assert that
 * no intermediate render ever shows the forbidden substring. This is the real
 * contract — the bug was what appeared *mid-stream*, not at the end.
 */
function everyPrefix(text) {
  const out = [];
  for (let i = 1; i <= text.length; i += 1) out.push(visibleStreamText(text.slice(0, i)));
  return out;
}

describe('visibleStreamText', () => {
  it('passes plain prose through', () => {
    expect(visibleStreamText('The answer is 42.')).toBe('The answer is 42.');
  });

  it('returns empty for empty and non-string input', () => {
    expect(visibleStreamText('')).toBe('');
    expect(visibleStreamText(undefined)).toBe('');
    expect(visibleStreamText(null)).toBe('');
  });

  describe('think blocks', () => {
    it('removes a complete block and keeps the answer', () => {
      expect(visibleStreamText('<think>reasoning here</think>The answer.')).toBe('The answer.');
    });

    it('shows nothing while a block is still open', () => {
      expect(visibleStreamText('<think>still reasoning')).toBe('');
    });

    it('holds back a partial opening tag', () => {
      expect(visibleStreamText('<')).toBe('');
      expect(visibleStreamText('<thi')).toBe('');
      expect(visibleStreamText('<thinkin')).toBe('');
    });

    it('holds back a partial closing tag after prose', () => {
      expect(visibleStreamText('<think>x</think>Answer</thi')).toBe('Answer');
    });

    it('never leaks any fragment of the tag while streaming character by character', () => {
      for (const frame of everyPrefix('<think>secret plan</think>Turing was born in 1912.')) {
        expect(frame).not.toContain('<think');
        expect(frame).not.toContain('secret');
      }
    });

    it('leaves a genuine less-than comparison alone', () => {
      expect(visibleStreamText('3 < 5 is true')).toBe('3 < 5 is true');
    });

    it('removes a stray closing tag but keeps the content', () => {
      expect(visibleStreamText('</think>The answer.')).toBe('The answer.');
    });
  });

  describe('bare tool-call JSON', () => {
    it('removes a balanced call and keeps surrounding prose', () => {
      expect(
        visibleStreamText('Let me check. {"tool": "curl", "args": {"url": "https://x.test"}} Done.')
      ).toBe('Let me check.  Done.');
    });

    it('removes a call still forming at the end of the buffer', () => {
      expect(visibleStreamText('{"tool": "curl", "args": {"url": "ht')).toBe('');
    });

    it('holds back a lone opening brace that could still become a call', () => {
      expect(visibleStreamText('{')).toBe('');
      expect(visibleStreamText('{"t')).toBe('');
      expect(visibleStreamText('{ "tool')).toBe('');
    });

    it('never leaks any fragment of a call while streaming character by character', () => {
      const reply = 'On it.\n{"tool": "wiki", "args": {"query": "Alan Turing"}}';
      for (const frame of everyPrefix(reply)) {
        expect(frame).not.toContain('"tool"');
        expect(frame).not.toContain('wiki');
        expect(frame).not.toContain('Turing');
      }
    });

    it('shows JSON whose first key is not "tool"', () => {
      expect(visibleStreamText('{"data": 1}')).toBe('{"data": 1}');
    });

    it('shows a key that merely starts with tool', () => {
      expect(visibleStreamText('{"toolbox": 1}')).toBe('{"toolbox": 1}');
    });

    it('shows {{credential}} placeholders in prose', () => {
      expect(visibleStreamText('Send it with {{api_key}} in the header.')).toBe(
        'Send it with {{api_key}} in the header.'
      );
    });

    it('removes every tool object, not just the first', () => {
      expect(
        visibleStreamText('{"tool": "curl", "args": {}} and {"tool": "wiki", "args": {}}')
      ).toBe('and');
    });
  });

  describe('fenced tool calls', () => {
    it('removes a complete fenced call', () => {
      expect(visibleStreamText('Sure.\n```json\n{"tool": "curl", "args": {}}\n```')).toBe('Sure.');
    });

    it('holds back a fence opener with no content yet', () => {
      expect(visibleStreamText('Sure.\n```')).toBe('Sure.');
      expect(visibleStreamText('Sure.\n```json')).toBe('Sure.');
      expect(visibleStreamText('Sure.\n```json\n')).toBe('Sure.');
    });

    it('removes an unterminated fence whose content is a forming call', () => {
      expect(visibleStreamText('Sure.\n```json\n{"to')).toBe('Sure.');
    });

    it('never leaks any fragment of a fenced call while streaming character by character', () => {
      const reply = 'Fetching.\n```json\n{"tool": "curl", "args": {"url": "https://x.test"}}\n```';
      for (const frame of everyPrefix(reply)) {
        expect(frame).not.toContain('"tool"');
        expect(frame).not.toContain('x.test');
      }
    });

    it('leaves a non-JSON code fence visible', () => {
      const text = '```python\nprint(1)\n```';
      expect(visibleStreamText(text)).toBe(text);
    });

    it('leaves a JSON fence with non-tool content visible', () => {
      const text = '```json\n{"a": 1}\n```';
      expect(visibleStreamText(text)).toBe(text);
    });
  });

  it('handles thinking followed by a tool call: shows nothing at any point', () => {
    const reply = '<think>need the article</think>{"tool": "wiki", "args": {"query": "Bristol"}}';
    for (const frame of everyPrefix(reply)) {
      expect(frame).toBe('');
    }
  });

  it('temporarily holds a trailing inline-code backtick, then restores it', () => {
    // Mid-stream the closing backtick may vanish for one frame; it must be
    // back as soon as the next character proves it was inline code.
    expect(visibleStreamText('use `curl` for this')).toBe('use `curl` for this');
  });
});
