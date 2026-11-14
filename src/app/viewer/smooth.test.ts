import { describe, expect, it } from 'vitest';
import { toRGBA, upsampleSmooth } from './smooth';

describe('upsampleSmooth', () => {
  it('keeps a constant field constant', () => {
    const src = new Float32Array(25).fill(0.37);
    const out = upsampleSmooth(src, 5, 5, 7);
    expect(out).toHaveLength(35 * 35);
    for (const v of out) expect(v).toBeCloseTo(0.37, 6);
  });

  it('keeps a NaN pixel as exactly its own square and does not disturb neighbours', () => {
    const w = 5;
    const src = new Float32Array(25).fill(0.5);
    src[12] = NaN;
    const s = 6;
    const out = upsampleSmooth(src, w, w, s);
    const W = w * s;
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const inSquare = Math.floor(x / s) === 2 && Math.floor(y / s) === 2;
        const v = out[y * W + x];
        if (inSquare) expect(Number.isNaN(v)).toBe(true);
        else expect(v).toBeCloseTo(0.5, 6);
      }
    }
  });

  it('is monotone between two pixel centres and clamps at the edges', () => {
    const out = upsampleSmooth(new Float32Array([0.2, 0.8]), 2, 1, 10);
    expect(out[0]).toBeCloseTo(0.2, 6);
    expect(out[4]).toBeCloseTo(0.2, 6);
    expect(out[19]).toBeCloseTo(0.8, 6);
    for (let i = 5; i < 15; i++) expect(out[i + 1]).toBeGreaterThanOrEqual(out[i] - 1e-7);
    expect(out[10]).toBeGreaterThan(0.2);
    expect(out[9]).toBeLessThan(0.8);
  });

  it('renormalises over finite neighbours only', () => {
    const src = new Float32Array([0.2, NaN, 0.8, 0.8]);
    const out = upsampleSmooth(src, 2, 2, 4);
    const W = 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const v = out[y * W + x];
        if (x >= 4 && y < 4) expect(Number.isNaN(v)).toBe(true);
        else {
          expect(v).toBeGreaterThanOrEqual(0.2 - 1e-6);
          expect(v).toBeLessThanOrEqual(0.8 + 1e-6);
        }
      }
    }
  });

  it('handles 65x65 at scale 13', () => {
    const src = new Float32Array(65 * 65);
    for (let i = 0; i < src.length; i++) src[i] = i % 7 === 0 ? NaN : (i % 100) / 100;
    const out = upsampleSmooth(src, 65, 65, 13);
    expect(out).toHaveLength(845 * 845);
  }, 60000);
});

describe('toRGBA', () => {
  it('maps values and missing pixels', () => {
    const out = new Uint8ClampedArray(8);
    toRGBA(new Float32Array([0.5, NaN]), out, (v) => [Math.round(v * 200), 1, 2], [9, 8, 7]);
    expect(Array.from(out)).toEqual([100, 1, 2, 255, 9, 8, 7, 255]);
  });
});
