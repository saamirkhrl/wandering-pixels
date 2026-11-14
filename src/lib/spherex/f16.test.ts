import { describe, expect, it } from 'vitest';
import { floatToHalf, halfToFloat } from './f16';

describe('f16', () => {
  it('encodes known patterns', () => {
    expect(floatToHalf(0)).toBe(0x0000);
    expect(floatToHalf(-0)).toBe(0x8000);
    expect(floatToHalf(1)).toBe(0x3c00);
    expect(floatToHalf(-2)).toBe(0xc000);
    expect(floatToHalf(65504)).toBe(0x7bff);
    expect(floatToHalf(Infinity)).toBe(0x7c00);
    expect(floatToHalf(-Infinity)).toBe(0xfc00);
    expect(floatToHalf(0.333251953125)).toBe(0x3555);
    expect(floatToHalf(2 ** -24)).toBe(0x0001);
    expect(floatToHalf(2 ** -14)).toBe(0x0400);
  });
  it('handles NaN, overflow and underflow', () => {
    expect(Number.isNaN(halfToFloat(floatToHalf(NaN)))).toBe(true);
    expect(floatToHalf(65520)).toBe(0x7c00); // rounds up to Infinity
    expect(floatToHalf(65519)).toBe(0x7bff);
    expect(floatToHalf(1e10)).toBe(0x7c00);
    expect(floatToHalf(2 ** -25)).toBe(0); // tie to even -> 0
    expect(floatToHalf(2 ** -25 * 1.01)).toBe(1);
    expect(floatToHalf(1e-12)).toBe(0);
    expect(Object.is(halfToFloat(0x8000), -0)).toBe(true);
  });
  it('ties to even', () => {
    // 1 + 2^-11 is halfway between 1 and 1+2^-10: even is 1
    expect(floatToHalf(1 + 2 ** -11)).toBe(0x3c00);
    // 1 + 3*2^-11 is halfway between 1+2^-10 and 1+2^-9: even is 1+2^-9
    expect(floatToHalf(1 + 3 * 2 ** -11)).toBe(0x3c02);
  });
  it('round-trips every half pattern', () => {
    for (let h = 0; h < 65536; h++) {
      const f = halfToFloat(h);
      if (Number.isNaN(f)) {
        expect(Number.isNaN(halfToFloat(floatToHalf(f)))).toBe(true);
      } else {
        expect(floatToHalf(f)).toBe(h);
      }
    }
  });
  it('relative error stays within 2^-11 for normal range', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 20000; i++) {
      const v = Math.exp((rnd() * 2 - 1) * 9) * (rnd() < 0.5 ? -1 : 1) * 1.0; // ~1e-4..8e3
      const r = halfToFloat(floatToHalf(v));
      expect(Math.abs(r - v)).toBeLessThanOrEqual(Math.abs(v) * 2 ** -11 + 1e-12);
    }
  });
});
