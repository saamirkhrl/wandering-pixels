import { describe, expect, it } from 'vitest';
import { gridAt } from '../../lib/spherex';
import type { Frame, Grid } from '../../lib/spherex';
import { plant, simAnchorGrid, simBodyXY, simFrames, simPeak, SIM_MOTION } from './planet-sim';

const base: Grid = { ra0: 269.4485, dec0: 4.7394, w: 65, h: 65, scaleArcsec: 6.15, epochMjd: 60900 };
const T0 = 60912.715;

function frameAt(mjd: number, grid: Grid): Frame {
  const n = grid.w * grid.h;
  const pixels = new Float32Array(n);
  for (let i = 0; i < n; i++) pixels[i] = (i % 97) / 97;
  return {
    exposure: { mjd, id: `e${mjd}`, detector: 2 } as unknown as Frame['exposure'],
    grid,
    pixels,
    variance: new Float32Array(n),
    flags: new Uint8Array(n),
    w: grid.w,
    h: grid.h,
    coverage: 1,
    bytes: 0,
  };
}

describe('simulated body', () => {
  const anchor = simAnchorGrid(base);

  it('sits at the centre of frames tracked at its true distance and motion', () => {
    for (const mjd of [T0, T0 + 201, T0 + 358]) {
      const f = frameAt(mjd, gridAt(anchor, mjd, 500, T0, SIM_MOTION));
      const [x, y] = simBodyXY(f, anchor, T0);
      expect(x).toBeCloseTo(32, 3);
      expect(y).toBeCloseTo(32, 3);
    }
  });

  it('is offset from the centre when tracked at a wrong distance', () => {
    const mjd = T0 + 201;
    const f = frameAt(mjd, gridAt(anchor, mjd, 520, T0, SIM_MOTION));
    const [x, y] = simBodyXY(f, anchor, T0);
    expect(Math.hypot(x - 32, y - 32)).toBeGreaterThan(3);
  });

  it('moves about 19 px in a year on the untracked grid', () => {
    const a = simBodyXY(frameAt(T0, base), anchor, T0);
    const b = simBodyXY(frameAt(T0 + 365.25, base), anchor, T0);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeGreaterThan(15);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThan(23);
  });

  it('plants into a copy and leaves the cached frame untouched', () => {
    const f = frameAt(T0, base);
    const before = f.pixels.slice();
    const out = plant(f, 20, 20, 10);
    expect(f.pixels).toEqual(before);
    expect(out.pixels[20 * 65 + 20] - before[20 * 65 + 20]).toBeCloseTo(10, 5);
    expect(simPeak(6.15)).toBeGreaterThan(40);
    expect(simPeak(6.15)).toBeLessThan(50);
    const [c] = simFrames([f], anchor, T0);
    expect(c).not.toBe(f);
    expect(simFrames([f], anchor, T0)[0]).toBe(c);
  });
});
