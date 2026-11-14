import { describe, it, expect, vi } from 'vitest';
import type { Frame, Grid, Exposure, Detector } from './types';
import { SpherexError } from './types';

vi.mock('./wcs', () => ({
  positionAt: (t: { ra: number; dec: number }) => ({ ra: t.ra, dec: t.dec }),
  worldToGrid: (_g: unknown, ra: number, dec: number) => [ra, dec],
}));

import { buildMovie, difference, summarize, channelBandwidth, pickBlinkPair } from './movie';

const grid: Grid = { ra0: 10, dec0: 10, w: 65, h: 65, scaleArcsec: 6.15, epochMjd: 60000 };

function exp(id: string, detector: Detector, visitIndex: number, mjd: number, wl: number | null): Exposure {
  return {
    id, obsId: id, detector, time: '', mjd, visitIndex,
    wavelengthAtTarget: wl, bandwidthAtTarget: wl === null ? null : wl / 41,
    url: '', release: 'dr1',
  };
}

function frame(e: Exposure, fill: number, varFill: number): Frame {
  const n = 65 * 65;
  return {
    exposure: e, grid, w: 65, h: 65, coverage: 1, bytes: 0,
    pixels: new Float32Array(n).fill(fill),
    variance: new Float32Array(n).fill(varFill),
    flags: new Uint8Array(n),
  };
}

function star(f: Frame, x: number, y: number, amp: number, sigma = 0.6) {
  for (let j = 0; j < 65; j++)
    for (let i = 0; i < 65; i++)
      f.pixels[j * 65 + i] += amp * Math.exp(-((i - x) ** 2 + (j - y) ** 2) / (2 * sigma * sigma));
}

describe('buildMovie', () => {
  it('handles empty input', () => {
    const m = buildMovie([], 'single', 2);
    expect(m.frames).toEqual([]);
    expect(m.stretch).toEqual({ lo: 0, hi: 1 });
  });

  it('stacks with inverse-variance weights', () => {
    const a = frame(exp('a', 2, 0, 60000, 1.0), 10, 1);
    const b = frame(exp('b', 2, 0, 60000.2, 1.2), 20, 4);
    const m = buildMovie([a, b], 'visit-stack', 2, { ra: 30, dec: 31 });
    expect(m.frames).toHaveLength(1);
    const f = m.frames[0];
    // weights 1 and 0.25 -> (10 + 5) / 1.25 = 12
    expect(f.pixels[100]).toBeCloseTo(12, 5);
    expect(f.variance[100]).toBeCloseTo(0.8, 5);
    expect(f.nExposures).toBe(2);
    expect(f.wavelength).toBeCloseTo(1.1, 6);
    expect(f.wavelengthMin).toBe(1.0);
    expect(f.wavelengthMax).toBe(1.2);
    expect(f.mjd).toBeCloseTo(60000.1, 6);
    expect(f.time).toBe(new Date((60000.1 - 40587) * 86400000).toISOString());
    expect(f.targetXY).toEqual([30, 31]);
  });

  it('skips NaN, flagged and bad-variance pixels; NaN where none', () => {
    const a = frame(exp('a', 2, 0, 60000, 1), 10, 1);
    const b = frame(exp('b', 2, 0, 60001, 1), 20, 1);
    a.pixels[0] = NaN;
    b.flags[1] = 1; // b masked at 1
    a.flags[2] = 4; b.variance[2] = 0; // none contributes at 2
    a.variance[3] = NaN;
    const m = buildMovie([a, b], 'visit-stack', 2);
    const p = m.frames[0].pixels;
    expect(p[0]).toBeCloseTo(20);
    expect(p[1]).toBeCloseTo(10);
    expect(Number.isNaN(p[2])).toBe(true);
    expect(p[3]).toBeCloseTo(20);
    expect(m.frames[0].targetXY).toBeNull();
  });

  it('single mode, detector filter, sorted by mjd, null wavelengths', () => {
    const a = frame(exp('a', 2, 1, 60010, null), 1, 1);
    const b = frame(exp('b', 2, 0, 60000, 1.4), 1, 1);
    const c = frame(exp('c', 3, 0, 60000, 1.4), 1, 1);
    const m = buildMovie([a, b, c], 'single', 2);
    expect(m.frames.map((f) => f.exposureIds[0])).toEqual(['b', 'a']);
    expect(Number.isNaN(m.frames[1].wavelength)).toBe(true);
  });

  it('visit-stack groups by visit and stretch widens for flat data', () => {
    const fs = [
      frame(exp('a', 2, 0, 60000, 1), 5, 1),
      frame(exp('b', 2, 1, 60100, 1), 5, 1),
    ];
    const m = buildMovie(fs, 'visit-stack', 2);
    expect(m.frames).toHaveLength(2);
    expect(m.stretch.hi).toBeGreaterThan(m.stretch.lo);
  });
});

describe('difference', () => {
  it('computes b - a with symmetric stretch and snr', () => {
    const fa = frame(exp('a', 2, 0, 60000, 1.393), 0, 1);
    const fb = frame(exp('b', 2, 1, 60100, 1.394), 0, 3);
    star(fa, 20, 20, 50);
    star(fb, 22, 20, 50);
    const m = buildMovie([fa, fb], 'visit-stack', 2);
    const d = difference(m.frames[0], m.frames[1]);
    const i = 20 * 65 + 22;
    const expected = 50 - 50 * Math.exp(-4 / (2 * 0.36));
    expect(d.pixels[i]).toBeCloseTo(expected, 3);
    expect(d.variance[i]).toBeCloseTo(4, 5);
    expect(d.snr[i]).toBeCloseTo(expected / 2, 3);
    expect(d.stretch.lo).toBe(-d.stretch.hi);
    expect(d.stretch.hi).toBeGreaterThan(0);
    expect(d.wavelengthMatched).toBe(true);
  });

  it('wavelengthMatched false for 1.30 vs 1.40', () => {
    const m = buildMovie(
      [frame(exp('a', 2, 0, 60000, 1.3), 0, 1), frame(exp('b', 2, 1, 60100, 1.4), 0, 1)],
      'visit-stack', 2,
    );
    const d = difference(m.frames[0], m.frames[1]);
    expect(d.wavelengthMatched).toBe(false);
    expect(d.stretch).toEqual({ lo: -1, hi: 1 });
  });

  it('propagates NaN and throws on size mismatch', () => {
    const m = buildMovie(
      [frame(exp('a', 2, 0, 60000, 1.3), 0, 1), frame(exp('b', 2, 1, 60100, 1.4), 0, 1)],
      'visit-stack', 2,
    );
    m.frames[0].pixels[5] = NaN;
    expect(Number.isNaN(difference(m.frames[0], m.frames[1]).pixels[5])).toBe(true);
    const bad = { ...m.frames[1], w: 64 };
    expect(() => difference(m.frames[0], bad)).toThrow(SpherexError);
    try { difference(m.frames[0], bad); } catch (e) { expect((e as SpherexError).code).toBe('BAD_INPUT'); }
  });
});

describe('channelBandwidth', () => {
  it('uses R by detector', () => {
    expect(channelBandwidth(1, 0.78)).toBeCloseTo(0.02, 6);
    expect(channelBandwidth(2, 1.23)).toBeCloseTo(0.03, 6);
    expect(channelBandwidth(5, 11.2)).toBeCloseTo(0.1, 6);
    expect(channelBandwidth(6, 12.8)).toBeCloseTo(0.1, 6);
  });
});

describe('summarize', () => {
  it('groups by detector', () => {
    const r = summarize([
      exp('a', 3, 1, 1, 1), exp('b', 2, 0, 1, 1), exp('c', 2, 2, 1, 1), exp('d', 2, 0, 1, 1),
    ]);
    expect(r).toEqual([
      { detector: 2, visits: [0, 2], count: 3 },
      { detector: 3, visits: [1], count: 1 },
    ]);
    expect(summarize([])).toEqual([]);
  });
});

describe('pickBlinkPair', () => {
  it('picks the closest wavelengths across visits', () => {
    const r = pickBlinkPair([exp('a', 2, 0, 1, 1.0), exp('b', 2, 1, 2, 1.5), exp('c', 2, 2, 3, 1.01)]);
    expect(r!.map((e) => e.id)).toEqual(['a', 'c']);
  });
  it('ties prefer the larger time gap', () => {
    const list = [exp('a', 2, 0, 10, 1.0), exp('b', 2, 1, 11, 1.1), exp('c', 2, 2, 10, 5.0), exp('d', 2, 3, 90, 5.1)];
    expect(pickBlinkPair(list)!.map((e) => e.id)).toEqual(['c', 'd']);
    expect(pickBlinkPair([...list].reverse())!.map((e) => e.id)).toEqual(['c', 'd']);
  });
  it('excludes same-visit pairs', () => {
    const r = pickBlinkPair([exp('a', 2, 0, 1, 1.0), exp('b', 2, 0, 2, 1.001), exp('c', 2, 1, 3, 1.2)]);
    expect(r!.map((e) => e.id)).toEqual(['b', 'c']);
    expect(pickBlinkPair([exp('a', 2, 0, 1, 1.0), exp('b', 2, 0, 2, 1.1)])).toBeNull();
  });
  it('ignores null and non-finite wavelengths', () => {
    const r = pickBlinkPair([exp('a', 2, 0, 1, null), exp('b', 2, 1, 2, NaN), exp('c', 2, 2, 3, 1), exp('d', 2, 3, 4, 2)]);
    expect(r!.map((e) => e.id)).toEqual(['c', 'd']);
  });
  it('filters by detector', () => {
    const list = [exp('a', 2, 0, 1, 1.0), exp('b', 3, 1, 2, 1.0), exp('c', 2, 2, 3, 1.5), exp('d', 3, 3, 4, 1.9)];
    expect(pickBlinkPair(list, 2)!.map((e) => e.id)).toEqual(['a', 'c']);
    expect(pickBlinkPair(list, 3)!.map((e) => e.id)).toEqual(['b', 'd']);
    expect(pickBlinkPair(list)!.map((e) => e.id)).toEqual(['a', 'b']);
    expect(pickBlinkPair(list, 4)).toBeNull();
  });
  it('returns null for fewer than 2', () => {
    expect(pickBlinkPair([])).toBeNull();
    expect(pickBlinkPair([exp('a', 2, 0, 1, 1)])).toBeNull();
  });
  it('orders the pair by time', () => {
    const r = pickBlinkPair([exp('late', 2, 1, 99, 1.0), exp('early', 2, 0, 5, 1.0)]);
    expect(r!.map((e) => e.id)).toEqual(['early', 'late']);
  });
});
