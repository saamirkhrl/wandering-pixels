import { describe, expect, it } from 'vitest';
import { clampCenter, layoutMarks, nearestIndex, PAD, pickLabelIndexes, ticksFor } from './timeline';

describe('layoutMarks', () => {
  it('is monotonic with date and inside the padded range', () => {
    const mjds = [61000, 61001, 61010, 61100, 61365];
    const xs = layoutMarks(mjds, 358);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
    expect(xs[0]).toBeCloseTo(PAD);
    expect(xs[xs.length - 1]).toBeCloseTo(358 - PAD);
    expect(xs[2] - xs[1]).toBeCloseTo(((xs[4] - xs[0]) * 9) / 365, 5);
  });
  it('centres a single date and handles none', () => {
    expect(layoutMarks([5], 200)).toEqual([100]);
    expect(layoutMarks([], 200)).toEqual([]);
  });
});

describe('pickLabelIndexes', () => {
  it('returns a non-overlapping subset with first and last', () => {
    const xs = Array.from({ length: 60 }, (_, i) => 24 + i * 5.5);
    const idx = pickLabelIndexes(xs, 50);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(59);
    for (let i = 1; i < idx.length; i++) expect(xs[idx[i]] - xs[idx[i - 1]]).toBeGreaterThanOrEqual(50);
  });
  it('keeps everything when there is room', () => {
    expect(pickLabelIndexes([10, 100, 200], 50)).toEqual([0, 1, 2]);
  });
  it('drops the last when it cannot fit', () => {
    expect(pickLabelIndexes([10, 20], 50)).toEqual([0]);
  });
});

describe('ticksFor', () => {
  const MIN = 61000;
  for (const [span, width] of [
    [60, 358],
    [400, 358],
    [900, 358],
    [3000, 358],
    [120, 1000],
  ] as const) {
    it(`does not collide for ${span} days at ${width}px`, () => {
      const ticks = ticksFor(MIN, MIN + span, width);
      expect(ticks.length).toBeGreaterThan(0);
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i].mjd).toBeGreaterThan(ticks[i - 1].mjd);
        expect(ticks[i].x - ticks[i - 1].x).toBeGreaterThanOrEqual(56);
      }
      for (const t of ticks) {
        expect(t.x).toBeGreaterThanOrEqual(PAD - 1e-6);
        expect(t.x).toBeLessThanOrEqual(width - PAD + 1e-6);
      }
    });
  }
  it('returns nothing for an empty span', () => {
    expect(ticksFor(5, 5, 300)).toEqual([]);
  });
});

describe('nearestIndex', () => {
  it('snaps to the closest mark', () => {
    expect(nearestIndex([10, 50, 90], 60)).toBe(1);
    expect(nearestIndex([10, 50, 90], 200)).toBe(2);
  });
});

describe('clampCenter', () => {
  it('keeps a label box inside the container', () => {
    expect(clampCenter(24, 70, 358)).toBe(35);
    expect(clampCenter(340, 70, 358)).toBe(323);
    expect(clampCenter(180, 70, 358)).toBe(180);
  });
});
