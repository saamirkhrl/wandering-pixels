import { describe, expect, it } from 'vitest';
import {
  asinhNorm,
  divergingColor,
  HATCH_A,
  HATCH_B,
  hatchColor,
  integerScale,
  renderDiverging,
  renderPixels,
} from './render';

const stretch = { lo: -0.5, hi: 400 };

describe('asinh stretch', () => {
  it('is monotonic', () => {
    let prev = -1;
    for (let x = -5; x <= 500; x += 2.5) {
      const v = asinhNorm(x, stretch.lo, stretch.hi);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('is clamped to 0..1', () => {
    expect(asinhNorm(-1000, stretch.lo, stretch.hi)).toBe(0);
    expect(asinhNorm(1e9, stretch.lo, stretch.hi)).toBe(1);
    expect(asinhNorm(stretch.lo, stretch.lo, stretch.hi)).toBe(0);
    expect(asinhNorm(stretch.hi, stretch.lo, stretch.hi)).toBeCloseTo(1, 10);
  });

  it('gives the same output for the same value in different frames', () => {
    const a = new Float32Array([0, 12.5, 300, 1, 0, 0]);
    const b = new Float32Array([5, 0, 0, 12.5, 300, 1]);
    const ra = renderPixels(a, 3, 2, stretch);
    const rb = renderPixels(b, 3, 2, stretch);
    const px = (r: Uint8ClampedArray, i: number) => Array.from(r.slice(i * 4, i * 4 + 4));
    expect(px(ra, 1)).toEqual(px(rb, 3));
    expect(px(ra, 2)).toEqual(px(rb, 4));
    expect(px(ra, 3)).toEqual(px(rb, 5));
  });
});

describe('NaN pixels', () => {
  it('map to the hatch colour, never black', () => {
    const out = renderPixels(new Float32Array([NaN, NaN, 0, NaN]), 2, 2, stretch);
    for (const i of [0, 1, 3]) {
      const rgb = [out[i * 4], out[i * 4 + 1], out[i * 4 + 2]];
      const x = i % 2;
      const y = Math.floor(i / 2);
      expect(rgb).toEqual(Array.from(hatchColor(x, y)));
      expect(rgb[0] + rgb[1] + rgb[2]).toBeGreaterThan(60);
    }
    expect(HATCH_A).not.toEqual(HATCH_B);
  });

  it('are distinct from a sky pixel at the low end', () => {
    const out = renderPixels(new Float32Array([NaN, -9]), 2, 1, stretch);
    expect(out[0]).toBeGreaterThan(out[4]);
  });
});

describe('diverging map', () => {
  it('maps zero to near-black', () => {
    const [r, g, b] = divergingColor(0);
    expect(Math.max(r, g, b)).toBeLessThan(20);
  });

  it('maps positive to orange and negative to blue', () => {
    const [pr, , pb] = divergingColor(0.7);
    const [nr, , nb] = divergingColor(-0.7);
    expect(pr).toBeGreaterThan(pb);
    expect(nb).toBeGreaterThan(nr);
  });

  it('is symmetric in brightness and clamps outside the range', () => {
    expect(divergingColor(5)).toEqual(divergingColor(1));
    expect(divergingColor(-5)).toEqual(divergingColor(-1));
  });

  it('renders NaN as hatch', () => {
    const out = renderDiverging(new Float32Array([NaN, 0]), 2, 1, 3);
    expect([out[0], out[1], out[2]]).toEqual(Array.from(hatchColor(0, 0)));
    expect(out[4] + out[5] + out[6]).toBeLessThan(60);
  });
});

describe('integerScale', () => {
  it('picks the largest integer that fits', () => {
    expect(integerScale(65, 65, 800, 700)).toBe(10);
    expect(integerScale(65, 65, 30, 30)).toBe(1);
  });
});
