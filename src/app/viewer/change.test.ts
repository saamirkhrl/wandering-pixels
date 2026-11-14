import { describe, expect, it } from 'vitest';
import type { ComparisonFlag, PairComparison } from '../data';
import { fmtPercent, verdict, Z_CHANGED, Z_POSSIBLE } from './change';

const row = (z: number, flags: ComparisonFlag[] = [], percent = 2.1, sigma = 1.4): PairComparison => ({
  visitA: 0,
  visitB: 2,
  plain: { deltaMjy: 1, percent: 1, sigma: 1, z: 1, wavelengthA: 1.36, wavelengthB: 1.38, gapChannels: 0.7 },
  paired: { deltaMjy: 1, percent: 1, sigma: 1, z: 1, nPairs: 3 },
  matched: { deltaMjy: percent, percent, sigma, z, commonWavelength: 1.37, pointsA: 6, pointsB: 7 },
  flags,
});

describe('verdict', () => {
  it('uses the matched z thresholds', () => {
    expect(Z_POSSIBLE).toBe(3);
    expect(Z_CHANGED).toBe(5);
    expect(verdict(row(2.99)).kind).toBe('none');
    expect(verdict(row(-2.99)).text).toBe('No change above noise');
    expect(verdict(row(3)).kind).toBe('possible');
    expect(verdict(row(-4.9)).text).toBe('Possible change');
    expect(verdict(row(5)).kind).toBe('changed');
    expect(verdict(row(6, [], -7.25, 1.2)).text).toBe('Changed by -7.3 +/- 1.2 percent');
  });

  it('is unreliable with reasons in words when flagged', () => {
    const v = verdict(row(9, ['saturated', 'blended']));
    expect(v.kind).toBe('unreliable');
    expect(v.text).toContain('Not reliable here');
    expect(v.text).toContain('the star is saturated');
    expect(v.text).toContain('a neighbour sits inside the aperture');
    expect(verdict(row(0, ['too_few_samples'])).text).toContain('too few points at some colours');
    expect(verdict(row(0, ['partial_visit'])).text).toContain('a visit has only a few images here');
    expect(verdict(row(0, ['no_bracket'])).text).toContain('some colours fall outside the range sampled in a visit');
  });
});

describe('fmtPercent', () => {
  it('formats with sign, one decimal and +/-', () => {
    expect(fmtPercent(2.1, 1.4)).toBe('+2.1 +/- 1.4 percent');
    expect(fmtPercent(-0.04, 1.44)).toBe('+0.0 +/- 1.4 percent');
    expect(fmtPercent(0, 2)).toBe('+0.0 +/- 2.0 percent');
  });
});
