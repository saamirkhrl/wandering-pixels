import { describe, it, expect, vi } from 'vitest';
import type { Frame, Grid, Exposure, Detector } from './types';
import { SpherexError, BAD_DATA_MASK, FLAG_BITS } from './types';

vi.mock('./wcs', () => ({
  positionAt: (t: { ra: number; dec: number }) => ({ ra: t.ra, dec: t.dec }),
  // Grids with epochMjd === 1 use a simple linear tangent-plane stand-in; all others return [ra, dec].
  worldToGrid: (g: { ra0: number; dec0: number; w: number; h: number; scaleArcsec: number; epochMjd: number }, ra: number, dec: number) =>
    g.epochMjd === 1
      ? [(g.w - 1) / 2 - ((ra - g.ra0) * 3600) / g.scaleArcsec, (g.h - 1) / 2 - ((dec - g.dec0) * 3600) / g.scaleArcsec]
      : [ra, dec],
}));

import { worldToGrid } from './wcs';
import { buildMovie, difference, summarize, channelBandwidth, pickBlinkPair, frameBackground } from './movie';

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
    const m = buildMovie([a, b], 'visit-stack', 2, { ra: 30, dec: 31 }, { background: 'none' });
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
    const m = buildMovie([a, b], 'visit-stack', 2, undefined, { background: 'none' });
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

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function noisy(e: Exposure, offset: number, seed: number): Frame {
  const f = frame(e, 0, 0.0001);
  const r = rng(seed);
  for (let i = 0; i < f.pixels.length; i++) {
    // sum of 4 uniforms, roughly gaussian, sd ~0.01
    f.pixels[i] = offset + (r() + r() + r() + r() - 2) * 0.017;
  }
  star(f, 20, 20, 5);
  star(f, 40, 30, 3);
  star(f, 10, 50, 8);
  return f;
}

describe('background removal', () => {
  const mk = () => [
    noisy(exp('a', 2, 0, 60000, 1.0), 0.05, 1),
    noisy(exp('b', 2, 0, 60000.1, 1.0), 0.11, 2),
  ];

  it('median subtraction brings stacked background near zero and reports the level', () => {
    const [a, b] = mk();
    const m = buildMovie([a, b], 'visit-stack', 2);
    const f = m.frames[0];
    const sorted = Array.from(f.pixels).sort((x, y) => x - y);
    expect(Math.abs(sorted[Math.floor(sorted.length / 2)])).toBeLessThan(0.005);
    expect(f.backgroundLevel).toBeGreaterThan(0.07);
    expect(f.backgroundLevel).toBeLessThan(0.09);
    const single = buildMovie([a, b], 'single', 2);
    expect(single.frames[0].backgroundLevel).toBeCloseTo(0.05, 2);
    expect(single.frames[1].backgroundLevel).toBeCloseTo(0.11, 2);
    for (const sf of single.frames) {
      const s2 = Array.from(sf.pixels).sort((x, y) => x - y);
      expect(Math.abs(s2[Math.floor(s2.length / 2)])).toBeLessThan(0.005);
    }
  });

  it('does not mutate inputs', () => {
    const fs = mk();
    const copies = fs.map((f) => ({ p: f.pixels.slice(), v: f.variance.slice(), g: f.flags.slice() }));
    buildMovie(fs, 'visit-stack', 2);
    buildMovie(fs, 'single', 2);
    fs.forEach((f, i) => {
      expect(Array.from(f.pixels)).toEqual(Array.from(copies[i].p));
      expect(Array.from(f.variance)).toEqual(Array.from(copies[i].v));
      expect(Array.from(f.flags)).toEqual(Array.from(copies[i].g));
    });
  });

  it("'none' reproduces the plain inverse-variance stack bit for bit", () => {
    const fs = mk();
    fs[0].variance.fill(0.0004);
    fs[1].variance.fill(0.0009);
    fs[1].flags[7] = 4;
    fs[0].pixels[9] = NaN;
    const m = buildMovie(fs, 'visit-stack', 2, undefined, { background: 'none' });
    const f = m.frames[0];
    expect(f.backgroundLevel).toBe(0);
    for (let i = 0; i < 65 * 65; i++) {
      let sw = 0;
      let swx = 0;
      for (const fr of fs) {
        const p = fr.pixels[i];
        const v = fr.variance[i];
        if ((fr.flags[i] & BAD_DATA_MASK) !== 0 || !Number.isFinite(p) || !Number.isFinite(v) || !(v > 0)) continue;
        sw += 1 / v;
        swx += (1 / v) * p;
      }
      const ep = sw > 0 ? Math.fround(swx / sw) : NaN;
      const ev = sw > 0 ? Math.fround(1 / sw) : NaN;
      if (Number.isNaN(ep)) expect(Number.isNaN(f.pixels[i])).toBe(true);
      else {
        expect(f.pixels[i]).toBe(ep);
        expect(f.variance[i]).toBe(ev);
      }
    }
  });

  it('stacks advisory-flagged pixels with normal weight', () => {
    const a = frame(exp('a', 2, 0, 60000, 1), 10, 1);
    const b = frame(exp('b', 2, 0, 60001, 1), 20, 1);
    b.flags[5] = FLAG_BITS.HALO;
    b.flags[6] = FLAG_BITS.HALO | FLAG_BITS.STREAK;
    b.flags[7] = FLAG_BITS.SATURATED;
    const m = buildMovie([a, b], 'visit-stack', 2, undefined, { background: 'none' });
    expect(m.frames[0].pixels[5]).toBe(15);
    expect(m.frames[0].variance[5]).toBe(0.5);
    expect(m.frames[0].pixels[6]).toBe(15);
    expect(m.frames[0].pixels[7]).toBe(10);
  });

  it('subtracts 0 when fewer than 100 usable pixels', () => {
    const a = frame(exp('a', 2, 0, 60000, 1), 3, 1);
    a.flags.fill(1);
    for (let i = 0; i < 99; i++) a.flags[i] = 0;
    const m = buildMovie([a], 'single', 2);
    expect(m.frames[0].backgroundLevel).toBe(0);
    expect(m.frames[0].pixels[0]).toBe(3);
    a.flags[99] = 0; // now exactly 100 usable
    const m2 = buildMovie([a], 'single', 2);
    expect(m2.frames[0].backgroundLevel).toBe(3);
    expect(m2.frames[0].pixels[0]).toBe(0);
  });
});

describe('difference', () => {
  it('computes b - a with symmetric stretch and snr', () => {
    const fa = frame(exp('a', 2, 0, 60000, 1.393), 0, 1);
    const fb = frame(exp('b', 2, 1, 60100, 1.394), 0, 3);
    star(fa, 20, 20, 50);
    star(fb, 22, 20, 50);
    const m = buildMovie([fa, fb], 'visit-stack', 2, undefined, { background: 'none' });
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

describe('summarize outOfStack', () => {
  it('counts inStack === false per detector', () => {
    const a = exp('a', 2, 0, 1, 1);
    const b = { ...exp('b', 2, 1, 2, 1), inStack: false };
    const c = { ...exp('c', 3, 1, 2, 1), inStack: true };
    expect(summarize([a, b, c])).toEqual([
      { detector: 2, visits: [0, 1], count: 2, outOfStack: 1 },
      { detector: 3, visits: [1], count: 1, outOfStack: 0 },
    ]);
  });
});

describe('inStack', () => {
  it('visit-stack skips inStack false, single keeps them', () => {
    const a = frame(exp('a', 2, 0, 60000, 1), 5, 1);
    const b = frame({ ...exp('b', 2, 0, 60001, 1), inStack: false }, 7, 1);
    const c = frame({ ...exp('c', 2, 1, 60100, 1), inStack: false }, 9, 1);
    const m = buildMovie([a, b, c], 'visit-stack', 2, undefined, { background: 'none' });
    expect(m.frames).toHaveLength(1);
    expect(m.frames[0].exposureIds).toEqual(['a']);
    expect(m.frames[0].pixels[10]).toBe(5);
    const s = buildMovie([a, b, c], 'single', 2, undefined, { background: 'none' });
    expect(s.frames.map((f) => f.exposureIds[0])).toEqual(['a', 'b', 'c']);
    const none = buildMovie([c], 'visit-stack', 2);
    expect(none.frames).toEqual([]);
  });
});

describe('frameBackground (masked)', () => {
  it('ignores a saturated blob wing and a bright source that plain median would feel', () => {
    const f = frame(exp('a', 2, 0, 60000, 1), 0.1, 1);
    const r = rng(5);
    for (let i = 0; i < f.pixels.length; i++) f.pixels[i] = 0.1 + (r() - 0.5) * 0.02;
    // broad skirt around a saturated core: elevated pixels within ~8 px
    for (let y = 0; y < 65; y++)
      for (let x = 0; x < 65; x++) {
        const d = Math.hypot(x - 30, y - 30);
        if (d < 8) f.pixels[y * 65 + x] += 0.02;
      }
    f.flags[30 * 65 + 30] = 2;
    f.pixels[30 * 65 + 30] = NaN;
    const bg = frameBackground(f);
    expect(bg.fallback).toBe(false);
    expect(bg.level).toBeGreaterThan(0.095);
    expect(bg.level).toBeLessThan(0.105);
    expect(bg.plain).toBeGreaterThan(0.095);
    expect(bg.nUsed).toBeLessThan(65 * 65 - 150);
  });

  it('masks a bright unsaturated source with its 3 px dilation', () => {
    const f = frame(exp('a', 2, 0, 60000, 1), 0, 1);
    const r = rng(9);
    for (let i = 0; i < f.pixels.length; i++) f.pixels[i] = (r() - 0.5) * 0.02;
    f.pixels[20 * 65 + 20] = 100;
    const bg = frameBackground(f);
    expect(bg.nUsed).toBe(65 * 65 - 49);
  });

  it('falls back to the plain median when the zones leave < 100 pixels', () => {
    const f = frame(exp('a', 2, 0, 60000, 1), 0.2, 1);
    f.flags[32 * 65 + 32] = 2;
    // huge blob: radius = max(8, 3*sqrt(npix/pi)) covers the whole frame
    for (let y = 10; y < 55; y++) for (let x = 10; x < 55; x++) f.flags[y * 65 + x] = 2;
    for (let y = 0; y < 65; y++) for (let x = 0; x < 65; x++) if (f.flags[y * 65 + x] === 0) f.pixels[y * 65 + x] = 0.2;
    const hasData = f.flags.filter((v) => v === 0).length;
    expect(hasData).toBeGreaterThan(100);
    const bg = frameBackground(f);
    expect(bg.fallback).toBe(true);
    expect(bg.level).toBeCloseTo(0.2, 6);
    const m = buildMovie([f], 'single', 2);
    expect(m.frames[0].backgroundFallback).toBe(true);
    expect(buildMovie([f], 'single', 2, undefined, { background: 'none' }).frames[0].backgroundFallback).toBeUndefined();
  });
});

describe('summarize', () => {
  it('groups by detector', () => {
    const r = summarize([
      exp('a', 3, 1, 1, 1), exp('b', 2, 0, 1, 1), exp('c', 2, 2, 1, 1), exp('d', 2, 0, 1, 1),
    ]);
    expect(r).toEqual([
      { detector: 2, visits: [0, 2], count: 3, outOfStack: 0 },
      { detector: 3, visits: [1], count: 1, outOfStack: 0 },
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

// ---------------------------------------------------------------------------------------------
// Tracked (co-moving) frames and clipped combine
// ---------------------------------------------------------------------------------------------

function trackedFrame(e: Exposure, g: Grid, fill: number, varFill: number, au: number | undefined): Frame {
  const f = frame(e, fill, varFill);
  f.grid = g;
  if (au !== undefined) f.trackingDistanceAu = au;
  return f;
}

function centroid(f: { pixels: Float32Array; w: number; h: number }, cx: number, cy: number, r: number): [number, number] {
  let s = 0, sx = 0, sy = 0;
  for (let j = Math.max(0, Math.round(cy) - r); j <= Math.min(f.h - 1, Math.round(cy) + r); j++)
    for (let i = Math.max(0, Math.round(cx) - r); i <= Math.min(f.w - 1, Math.round(cx) + r); i++) {
      const v = f.pixels[j * f.w + i];
      s += v; sx += v * i; sy += v * j;
    }
  return [sx / s, sy / s];
}

describe('clipped combine', () => {
  function sixMembers(au: number | undefined): Frame[] {
    const fs: Frame[] = [];
    for (let k = 0; k < 6; k++) fs.push(trackedFrame(exp('m' + k, 2, 0, 60000 + k * 0.1, 1), grid, 0, 1, au));
    star(fs[2], 30, 30, 100);
    return fs;
  }

  it('rejects a bright source in 1 of 6 members; mean keeps it', () => {
    const fs = sixMembers(5);
    const i = 30 * 65 + 30;
    const clipped = buildMovie(fs, 'visit-stack', 2, undefined, { background: 'none', combine: 'clipped' });
    const mean = buildMovie(fs, 'visit-stack', 2, undefined, { background: 'none', combine: 'mean' });
    expect(clipped.frames[0].pixels[i]).toBeCloseTo(0, 6);
    expect(clipped.frames[0].variance[i]).toBeCloseTo(1 / 5, 6);
    expect(mean.frames[0].pixels[i]).toBeCloseTo(100 / 6, 4);
  });

  it('defaults to clipped for tracked frames and mean for untracked', () => {
    const i = 30 * 65 + 30;
    const t = buildMovie(sixMembers(5), 'visit-stack', 2, undefined, { background: 'none' });
    const u = buildMovie(sixMembers(undefined), 'visit-stack', 2, undefined, { background: 'none' });
    expect(t.frames[0].pixels[i]).toBeCloseTo(0, 6);
    expect(u.frames[0].pixels[i]).toBeCloseTo(100 / 6, 4);
    expect(t.trackingDistanceAu).toBe(5);
    expect('trackingDistanceAu' in u).toBe(false);
  });

  it('uses the plain inverse-variance mean with fewer than 3 members', () => {
    const a = trackedFrame(exp('a', 2, 0, 60000, 1), grid, 10, 1, 5);
    const b = trackedFrame(exp('b', 2, 0, 60000.2, 1), grid, 20, 4, 5);
    const m = buildMovie([a, b], 'visit-stack', 2, undefined, { background: 'none' });
    expect(m.frames[0].pixels[100]).toBeCloseTo(12, 5);
    expect(m.frames[0].variance[100]).toBeCloseTo(0.8, 5);
  });

  it('falls back to the variance scale when the MAD is zero', () => {
    const fs: Frame[] = [];
    for (let k = 0; k < 5; k++) fs.push(trackedFrame(exp('z' + k, 2, 0, 60000 + k, 1), grid, 2, 0.25, 5));
    fs[4].pixels[7] = 50;
    const m = buildMovie(fs, 'visit-stack', 2, undefined, { background: 'none' });
    expect(m.frames[0].pixels[7]).toBeCloseTo(2, 6);
    expect(m.frames[0].variance[7]).toBeCloseTo(0.25 / 4, 6);
  });

  it('300 frames of 65x65 combine in under 1 s', () => {
    const fs: Frame[] = [];
    for (let k = 0; k < 300; k++) {
      const f = trackedFrame(exp('t' + k, 2, 0, 60000 + k * 0.01, 1), grid, 0, 1, 5);
      for (let i = 0; i < f.pixels.length; i++) f.pixels[i] = Math.sin(k * 7919 + i * 31) * 0.5;
      fs.push(f);
    }
    const t0 = performance.now();
    buildMovie(fs, 'visit-stack', 2, undefined, { background: 'none' });
    const dt = performance.now() - t0;
    console.log('clipped 300x65x65 ms', Math.round(dt));
    expect(dt).toBeLessThan(1000);
  });
});

describe('tracked movies', () => {
  const gA: Grid = { ra0: 100, dec0: 20, w: 65, h: 65, scaleArcsec: 6.15, epochMjd: 1 };
  const gB: Grid = { ra0: 100.01, dec0: 20.005, w: 65, h: 65, scaleArcsec: 6.15, epochMjd: 1 };
  const starRa = 100.002, starDec = 20.02;

  function visit(g: Grid, vi: number, mjd0: number, au: number | undefined): Frame[] {
    const out: Frame[] = [];
    for (let k = 0; k < 3; k++) {
      const f = trackedFrame(exp(`v${vi}k${k}`, 2, vi, mjd0 + k * 0.1, 1), g, 0, 1, au);
      star(f, 32, 32, 100); // co-moving source at the cutout centre
      const [sx, sy] = worldToGrid(f.grid, starRa, starDec);
      star(f, sx, sy, 80); // fixed star
      out.push(f);
    }
    return out;
  }

  it('builds with different centres, nearest-member grid, targetXY at the centre', () => {
    const near: Grid = { ...gA, ra0: 100.0002 };
    const a = trackedFrame(exp('a', 2, 0, 60000, 1), gA, 0, 1, 5);
    const b = trackedFrame(exp('b', 2, 0, 60000.1, 1), near, 0, 1, 5);
    const c = trackedFrame(exp('c', 2, 0, 60000.5, 1), gB, 0, 1, 5);
    // mean mjd = 60000.2, nearest is b
    const m = buildMovie([a, b, c], 'visit-stack', 2, { ra: 1, dec: 2 }, { background: 'none' });
    expect(m.frames[0].grid).toBe(near);
    expect(m.grid).toBe(near);
    expect(m.frames[0].targetXY).toEqual([32, 32]);
    expect(m.trackingDistanceAu).toBe(5);
  });

  it('throws BAD_INPUT on mismatched trackingDistanceAu or shape', () => {
    const a = trackedFrame(exp('a', 2, 0, 60000, 1), gA, 0, 1, 5);
    const b = trackedFrame(exp('b', 2, 0, 60001, 1), gA, 0, 1, 6);
    const c = trackedFrame(exp('c', 2, 0, 60001, 1), gA, 0, 1, undefined);
    const d = { ...trackedFrame(exp('d', 2, 0, 60001, 1), gA, 0, 1, 5), w: 64 };
    for (const bad of [b, c, d]) {
      try {
        buildMovie([a, bad], 'visit-stack', 2);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(SpherexError);
        expect((e as SpherexError).code).toBe('BAD_INPUT');
      }
    }
  });

  it('difference works on tracked frames with different centres and returns b.grid', () => {
    const m = buildMovie([...visit(gA, 0, 60000, 5), ...visit(gB, 1, 60100, 5)], 'visit-stack', 2, undefined, { background: 'none' });
    const d = difference(m.frames[0], m.frames[1]);
    expect(d.grid).toBe(m.frames[1].grid);
    expect(d.grid.ra0).toBe(gB.ra0);
    expect(d.w).toBe(65);
  });

  it('co-moving source stays at the centre; the fixed star moves by the grid-centre shift', () => {
    const m = buildMovie([...visit(gA, 0, 60000, 5), ...visit(gB, 1, 60100, 5)], 'visit-stack', 2, undefined, { background: 'none' });
    expect(m.frames).toHaveLength(2);
    for (const f of m.frames) {
      const [cx, cy] = centroid(f, 32, 32, 3);
      expect(Math.hypot(cx - 32, cy - 32)).toBeLessThan(0.2);
    }
    const [ax, ay] = worldToGrid(gA, starRa, starDec);
    const [bx, by] = worldToGrid(gB, starRa, starDec);
    const ca = centroid(m.frames[0], ax, ay, 4);
    const cb = centroid(m.frames[1], bx, by, 4);
    expect(cb[0] - ca[0]).toBeCloseTo(bx - ax, 1);
    expect(cb[1] - ca[1]).toBeCloseTo(by - ay, 1);
    expect(Math.abs(bx - ax)).toBeGreaterThan(5); // the shift is real
  });

  it('untracked shared grid with a moving source shows it far off-centre', () => {
    const mk = (vi: number, mjd0: number, x: number) =>
      [0, 1, 2].map((k) => {
        const f = frame(exp(`u${vi}${k}`, 2, vi, mjd0 + k * 0.1, 1), 0, 1);
        star(f, x, 32, 100);
        return f;
      });
    const m = buildMovie([...mk(0, 60000, 32), ...mk(1, 60100, 44)], 'visit-stack', 2, undefined, { background: 'none' });
    const [cx0] = centroid(m.frames[0], 32, 32, 4);
    const [cx1] = centroid(m.frames[1], 44, 32, 4);
    expect(Math.abs(cx0 - 32)).toBeLessThan(0.2);
    expect(Math.abs(cx1 - 32)).toBeGreaterThan(10);
  });
});
