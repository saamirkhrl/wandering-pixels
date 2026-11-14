import { describe, expect, it } from 'vitest';
import { auToSlider, clampAu, nudgeAu, ringRadiusPx, sliderToAu } from './distance';
import { COPY, fill } from './distance-copy';

describe('ringRadiusPx', () => {
  it('is 9 px at 500 au over six months at 6.15 arcsec per pixel', () => {
    expect(ringRadiusPx(500, 182.6, 6.15)).toBeCloseTo(9, 6);
  });
  it('scales as distance to the power -1.5', () => {
    expect(ringRadiusPx(250, 182.6, 6.15)).toBeCloseTo(9 * Math.pow(2, 1.5), 6);
  });
  it('scales with time span and pixel scale', () => {
    expect(ringRadiusPx(500, 365.2, 6.15)).toBeCloseTo(18, 6);
    expect(ringRadiusPx(500, 182.6, 3.075)).toBeCloseTo(18, 6);
  });
});

describe('slider mapping', () => {
  it('hits the ends and round-trips', () => {
    expect(sliderToAu(0)).toBeCloseTo(100, 6);
    expect(sliderToAu(1000)).toBeCloseTo(2000, 6);
    for (const au of [100, 137, 500, 1234.5, 2000]) expect(sliderToAu(auToSlider(au))).toBeCloseTo(au, 6);
  });
  it('is logarithmic', () => {
    expect(sliderToAu(500)).toBeCloseTo(Math.sqrt(100 * 2000), 6);
  });
});

describe('nudge and clamp', () => {
  it('multiplies by 1 percent and rounds to 0.1', () => {
    expect(nudgeAu(500, 1)).toBe(505);
    expect(nudgeAu(500, -1)).toBe(495);
    expect(nudgeAu(123.4, 1)).toBe(124.6);
  });
  it('clamps to the range', () => {
    expect(nudgeAu(100, -1)).toBe(100);
    expect(nudgeAu(2000, 1)).toBe(2000);
    expect(clampAu(5)).toBe(100);
    expect(clampAu(5000)).toBe(2000);
    expect(clampAu(NaN)).toBe(500);
  });
});

describe('fill', () => {
  it('replaces placeholders and leaves unknown ones', () => {
    expect(fill(COPY.on, { D: 500 })).toContain('a body 500 au away');
    expect(fill(COPY.jump, { arcsec: '12.3', px: '2.0' })).toBe('Stars jump 12.3 arcsec (2.0 px) between A and B.');
    expect(fill('{x} {y}', { x: 1 })).toBe('1 {y}');
  });
});
