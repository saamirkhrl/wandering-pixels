import { describe, expect, it } from 'vitest';
import vectors from '../../../docs/algorithm_test_vectors.json';
import {
  ANNULUS_INNER,
  ANNULUS_OUTER,
  APERTURE_RADIUS,
  BAD_DATA_BITS,
  BAD_DATA_MASK,
  FLUX_ERROR_FLOOR,
  SATURATED_BITS,
  SATURATED_MASK,
  circlePixelOverlap,
  isPixelBad,
  measureStamp,
} from './photometry';

interface StampVector {
  x: number;
  y: number;
  P: number[][];
  V: number[][];
  FLAGS: number[][];
  expected: { ok: boolean; flux: number; var_raw: number; var: number; bkg: number; s_bkg: number; n_bkg: number; saturated: boolean };
}
const V = vectors as unknown as {
  constants: { aperture_radius_px: number; annulus_px: number[]; flux_floor: number; bad_data_bits: number[]; saturated_bits: number[] };
  stars: Array<{ stamp: StampVector }>;
};

function close(a: number, b: number, rel = 1e-3): void {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.abs(b));
}

describe('constants', () => {
  it('match the vector file', () => {
    const c = V.constants;
    expect(APERTURE_RADIUS).toBe(c.aperture_radius_px);
    expect([ANNULUS_INNER, ANNULUS_OUTER]).toEqual(c.annulus_px);
    expect(FLUX_ERROR_FLOOR).toBe(c.flux_floor);
    expect([...BAD_DATA_BITS]).toEqual(c.bad_data_bits);
    expect([...SATURATED_BITS]).toEqual(c.saturated_bits);
    expect(BAD_DATA_MASK).toBe(c.bad_data_bits.reduce((m, b) => m + 2 ** b, 0));
    expect(SATURATED_MASK).toBe(2 ** 1 + 2 ** 15 + 2 ** 26);
  });
});

describe('circlePixelOverlap', () => {
  it('is 1 for a pixel fully inside and 0 for one fully outside', () => {
    expect(circlePixelOverlap(0, 0, 2, 0, 0)).toBeCloseTo(1, 12);
    expect(circlePixelOverlap(0.2, -0.1, 3, 1, 1)).toBeCloseTo(1, 12);
    expect(circlePixelOverlap(0, 0, 2, 5, 0)).toBe(0);
    expect(circlePixelOverlap(0, 0, 2, 0, -4)).toBe(0);
    expect(circlePixelOverlap(0.3, 0.3, 2, 3, 3)).toBe(0);
  });

  it('sums over a grid to pi r^2 for several radii and offsets', () => {
    for (const r of [0.3, 0.5, 1, 2, 2.7, 4.123]) {
      for (const [cx, cy] of [[0, 0], [0.5, 0.5], [0.31, -0.77], [10.2, 7.9], [-3.49, 0.01]] as const) {
        let sum = 0;
        const m = Math.ceil(r) + 2;
        for (let j = Math.round(cy) - m; j <= Math.round(cy) + m; j++) {
          for (let i = Math.round(cx) - m; i <= Math.round(cx) + m; i++) {
            const a = circlePixelOverlap(cx, cy, r, i, j);
            expect(a).toBeGreaterThanOrEqual(0);
            expect(a).toBeLessThanOrEqual(1);
            sum += a;
          }
        }
        expect(Math.abs(sum - Math.PI * r * r)).toBeLessThan(1e-9);
      }
    }
  });

  it('is symmetric under reflection and swap of axes', () => {
    const r = 2;
    for (const [cx, cy] of [[0.3, 0.1], [0.45, -0.2]] as const) {
      for (let j = -3; j <= 3; j++) {
        for (let i = -3; i <= 3; i++) {
          const a = circlePixelOverlap(cx, cy, r, i, j);
          expect(circlePixelOverlap(-cx, cy, r, -i, j)).toBeCloseTo(a, 12);
          expect(circlePixelOverlap(cx, -cy, r, i, -j)).toBeCloseTo(a, 12);
          expect(circlePixelOverlap(cy, cx, r, j, i)).toBeCloseTo(a, 12);
        }
      }
    }
  });

  it('matches a half-pixel known case: unit-radius circle on a pixel corner', () => {
    // circle radius 0.5 centred on a pixel centre lies wholly inside: area pi/4
    expect(circlePixelOverlap(0, 0, 0.5, 0, 0)).toBeCloseTo(Math.PI / 4, 12);
    // circle centred on a pixel edge midpoint, radius 0.5: half inside each neighbour
    expect(circlePixelOverlap(0.5, 0, 0.5, 0, 0)).toBeCloseTo(Math.PI / 8, 12);
  });
});

describe('steps 1 and 2: stamp vector', () => {
  const sv = V.stars[0]!.stamp;
  const flat = (a: number[][]) => a.flat();
  const stamp = {
    size: sv.P.length,
    x: sv.x,
    y: sv.y,
    p: flat(sv.P),
    variance: flat(sv.V),
    flags: flat(sv.FLAGS),
  };

  it('reproduces flux, variances, background and counts', () => {
    const m = measureStamp(stamp);
    const e = sv.expected;
    expect(m.ok).toBe(e.ok);
    expect(m.reason).toBe('ok');
    expect(m.saturated).toBe(e.saturated);
    close(m.flux, e.flux);
    close(m.varRaw, e.var_raw);
    close(m.variance, e.var);
    close(m.bkg, e.bkg);
    close(m.sBkg, e.s_bkg);
    expect(m.nBkg).toBe(e.n_bkg);
  });

  it('accepts typed arrays', () => {
    const m = measureStamp({
      ...stamp,
      p: Float32Array.from(stamp.p),
      variance: Float32Array.from(stamp.variance),
      flags: Uint32Array.from(stamp.flags),
    });
    expect(m.ok).toBe(true);
    close(m.flux, sv.expected.flux);
  });

  it('rejects with the named reasons', () => {
    expect(measureStamp({ ...stamp, x: -1 }).reason).toBe('outside_cutout');
    expect(measureStamp({ ...stamp, x: 1.2 }).reason).toBe('edge');
    const flags = stamp.flags.slice();
    flags[Math.round(stamp.y) * stamp.size + Math.round(stamp.x)] = 1 << 15;
    const masked = measureStamp({ ...stamp, flags });
    expect(masked.reason).toBe('masked_aperture');
    expect(masked.saturated).toBe(true);
    const v2 = stamp.variance.slice();
    v2[Math.round(stamp.y) * stamp.size + Math.round(stamp.x)] = 0;
    expect(measureStamp({ ...stamp, variance: v2 }).reason).toBe('masked_aperture');
    // wipe the annulus: every pixel with r >= 4 flagged bad
    const fl2 = stamp.flags.slice();
    for (let j = 0; j < stamp.size; j++) {
      for (let i = 0; i < stamp.size; i++) {
        if (Math.hypot(i - stamp.x, j - stamp.y) >= 3) fl2[j * stamp.size + i] = 1;
      }
    }
    expect(measureStamp({ ...stamp, flags: fl2 }).reason).toBe('annulus_few');
  });

  it('does not mask bit 1, and masks the document bits', () => {
    expect(isPixelBad(1, 1, 1 << 1)).toBe(false);
    for (const b of [17, 20, 25, 28, 29]) expect(isPixelBad(1, 1, 2 ** b)).toBe(false);
    for (const b of BAD_DATA_BITS) expect(isPixelBad(1, 1, 2 ** b)).toBe(true);
    expect(isPixelBad(NaN, 1, 0)).toBe(true);
    expect(isPixelBad(1, 0, 0)).toBe(true);
  });
});
