import { describe, it, expect, vi } from 'vitest';
import type { Frame, Grid } from './types';
import { FLAG_BITS } from './types';

vi.mock('./wcs', () => ({
  positionAt: (t: { ra: number; dec: number }) => ({ ra: t.ra, dec: t.dec }),
  worldToGrid: (_g: unknown, ra: number, dec: number) => [ra, dec],
}));

import { spectrumAt } from './spectrum';

const grid: Grid = { ra0: 0, dec0: 0, w: 65, h: 65, scaleArcsec: 6.15, epochMjd: 60000 };
const FACTOR = (6.15 / 206264.806247) ** 2 * 1e9;

function mk(id: string, wl: number | null, bkg: number, amp: number, sigma = 0.6): Frame {
  const n = 65 * 65;
  const pixels = new Float32Array(n).fill(bkg);
  for (let j = 0; j < 65; j++)
    for (let i = 0; i < 65; i++)
      pixels[j * 65 + i] += (amp / (2 * Math.PI * sigma * sigma)) * Math.exp(-((i - 32) ** 2 + (j - 32) ** 2) / (2 * sigma * sigma));
  return {
    exposure: {
      id, obsId: id, detector: 2, time: '2026-01-01T00:00:00.000Z', mjd: 61000, visitIndex: 0,
      wavelengthAtTarget: wl, bandwidthAtTarget: wl === null ? null : 0.03, url: '', release: 'dr1',
    },
    grid, w: 65, h: 65, coverage: 1, bytes: 0,
    pixels, variance: new Float32Array(n).fill(0.01), flags: new Uint8Array(n),
  };
}

describe('spectrumAt', () => {
  it('recovers injected flux and removes a flat background', () => {
    const amp = 100; // MJy/sr summed over pixels
    const f = mk('a', 1.4, 5, amp);
    const [p] = spectrumAt([f], 32, 32, 3 * 6.15);
    expect(p.flux / (amp * FACTOR)).toBeGreaterThan(0.98);
    expect(p.flux / (amp * FACTOR)).toBeLessThan(1.02);
    expect(p.flagged).toBe(false);
    expect(p.fluxErr).toBeGreaterThan(0);
    expect(p.wavelength).toBe(1.4);
    expect(p.bandwidth).toBe(0.03);
  });

  it('default aperture is 2 px, flat field gives zero flux', () => {
    const f = mk('a', 1.4, 7, 0);
    const [p] = spectrumAt([f], 32, 32);
    expect(Math.abs(p.flux)).toBeLessThan(1e-9);
  });

  it('flags NaN and masked pixels, skips off-grid, sorts by wavelength', () => {
    const a = mk('a', 2.0, 0, 10);
    const b = mk('b', 1.0, 0, 10);
    b.pixels[32 * 65 + 32] = NaN;
    const c = mk('c', 1.5, 0, 10);
    c.flags[32 * 65 + 33] = FLAG_BITS.BAD_PIXEL;
    const r = spectrumAt([a, b, c], 32, 32, 3 * 6.15);
    expect(r.map((x) => x.exposureId)).toEqual(['b', 'c', 'a']);
    expect(r.map((x) => x.flagged)).toEqual([true, true, false]);
    expect(Number.isFinite(r[0].flux)).toBe(true);
    expect(spectrumAt([a], 200, 200)).toEqual([]);
  });

  it('advisory bits set advisory but not flagged, and keep the pixel in flux and background', () => {
    const a = mk('a', 1.0, 0, 10);
    const base = spectrumAt([a], 32, 32, 3 * 6.15)[0];
    const b = mk('b', 1.0, 0, 10);
    b.flags[32 * 65 + 33] = FLAG_BITS.CROSSTALK | FLAG_BITS.HALO; // aperture pixel
    b.flags[32 * 65 + 40] = FLAG_BITS.STREAK; // annulus pixel
    const [p] = spectrumAt([b], 32, 32, 3 * 6.15);
    expect(p.flagged).toBe(false);
    expect(p.advisory).toBe(true);
    expect(p.flux).toBeCloseTo(base.flux, 12);
    expect(base.advisory).toBe(false);
  });

  it('bad-data bits set flagged and are excluded from the annulus', () => {
    const b = mk('b', 1.0, 3, 0);
    // aperture radius 3 px, annulus 6..10 px
    for (let x = 37; x <= 41; x++) b.pixels[32 * 65 + x] = 1000;
    const [dirty] = spectrumAt([b], 32, 32, 3 * 6.15);
    for (let x = 37; x <= 41; x++) b.flags[32 * 65 + x] = FLAG_BITS.SATURATED;
    const [masked] = spectrumAt([b], 32, 32, 3 * 6.15);
    expect(Math.abs(masked.flux)).toBeLessThan(1e-9);
    expect(masked.flagged).toBe(false); // bad pixels are in the annulus only
    expect(Number.isFinite(dirty.flux)).toBe(true);
    b.flags[32 * 65 + 32] = FLAG_BITS.BAD_PIXEL;
    expect(spectrumAt([b], 32, 32, 3 * 6.15)[0].flagged).toBe(true);
  });

  it('null wavelength gives NaN', () => {
    const [p] = spectrumAt([mk('a', null, 0, 1)], 32, 32);
    expect(Number.isNaN(p.wavelength)).toBe(true);
  });
});
