import { describe, expect, it } from 'vitest';
import { formatDuration, formatEta, formatRate, formatSize } from '../../src/llm/format.js';

describe('formatSize', () => {
  it('scales through the units', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2 kB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatSize(612 * 1024 * 1024)).toBe('612 MB');
    expect(formatSize(2.5 * 1024 ** 3)).toBe('2.50 GB');
    expect(formatSize(64 * 1024 ** 3)).toBe('64.0 GB');
  });

  it('says so rather than inventing a number', () => {
    expect(formatSize(null)).toBe('—');
    expect(formatSize(undefined)).toBe('—');
    expect(formatSize(NaN)).toBe('—');
    expect(formatSize(-1)).toBe('—');
  });
});

describe('formatRate', () => {
  it('appends a per-second suffix', () => {
    expect(formatRate(4.2 * 1024 * 1024)).toBe('4.2 MB/s');
  });

  it('refuses zero and nonsense, which would read as a stalled download', () => {
    expect(formatRate(0)).toBe('—');
    expect(formatRate(-5)).toBe('—');
    expect(formatRate(null)).toBe('—');
    expect(formatRate(Infinity)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('is precise, because it describes something that has happened', () => {
    expect(formatDuration(900)).toBe('1 s');
    expect(formatDuration(48_000)).toBe('48 s');
    expect(formatDuration(108_000)).toBe('1 m 48 s');
    expect(formatDuration(3_840_000)).toBe('1 h 04 m');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('formatEta', () => {
  it('is vague, because it describes a prediction', () => {
    expect(formatEta(4000)).toBe('a few seconds left');
    expect(formatEta(42_000)).toBe('about 40 seconds left');
    expect(formatEta(140_000)).toBe('about 2 minutes left');
    expect(formatEta(3_600_000)).toBe('about 1 hour left');
    expect(formatEta(4_500_000)).toBe('about 1 h 15 m left');
  });

  it('rounds to tens of seconds, never to a promise', () => {
    // 37s and 43s both become "about 40 seconds": the underlying rate is not
    // accurate to a second, so quoting one would overstate what is known.
    expect(formatEta(37_000)).toBe(formatEta(43_000));
  });

  it('returns null when there is nothing to claim', () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(NaN)).toBeNull();
    expect(formatEta(-1)).toBeNull();
  });
});
