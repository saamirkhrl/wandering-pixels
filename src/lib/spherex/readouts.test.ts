import { describe, it, expect } from 'vitest';
import { readoutReliability, hasBrightNeighbour, fieldPairsOf, BRIGHT_NEIGHBOUR_GMAG, BRIGHT_NEIGHBOUR_ARCSEC } from './readouts';
import type { StarReadout, PairReadout } from './readouts';

describe('readoutReliability', () => {
  it('is reliable with no flags and 2 wavelengths', () => {
    expect(readoutReliability([], 2)).toEqual({ reliable: true, unreliableReasons: [] });
  });
  it.each(['saturated', 'blended', 'partial_visit'] as const)('flags %s make it unreliable', (f) => {
    expect(readoutReliability([f], 5)).toEqual({ reliable: false, unreliableReasons: [f] });
  });
  it('fewer than 2 wavelengths', () => {
    expect(readoutReliability([], 1).unreliableReasons).toEqual(['fewer than 2 wavelengths']);
  });
  it('field offset', () => {
    expect(readoutReliability([], 3, { fieldReliable: false }).unreliableReasons).toEqual(['field offset']);
    expect(readoutReliability([], 3, { fieldReliable: true }).reliable).toBe(true);
  });
  it('bright neighbour from a Gaia list, star itself excluded', () => {
    const star = { ra: 10, dec: 20, sourceId: '1' };
    const self = { sourceId: '1', ra: 10, dec: 20, gmag: 5 };
    expect(readoutReliability([], 3, { star, gaia: [self] }).reliable).toBe(true);
    const near = { sourceId: '2', ra: 10, dec: 20 + 100 / 3600, gmag: 8.5 };
    expect(readoutReliability([], 3, { star, gaia: [self, near] }).unreliableReasons).toEqual(['bright_neighbour']);
  });
  it('combines reasons', () => {
    const r = readoutReliability(['saturated'], 0, { fieldReliable: false, brightNeighbour: true });
    expect(r.unreliableReasons).toEqual(['saturated', 'bright_neighbour', 'fewer than 2 wavelengths', 'field offset']);
  });
});

describe('hasBrightNeighbour', () => {
  const star = { ra: 0, dec: 0 };
  it('uses the G and distance limits', () => {
    expect(BRIGHT_NEIGHBOUR_GMAG).toBe(9);
    expect(BRIGHT_NEIGHBOUR_ARCSEC).toBe(180);
    expect(hasBrightNeighbour(star, [{ ra: 0, dec: 170 / 3600, gmag: 8.9 }])).toBe(true);
    expect(hasBrightNeighbour(star, [{ ra: 0, dec: 190 / 3600, gmag: 8.9 }])).toBe(false);
    expect(hasBrightNeighbour(star, [{ ra: 0, dec: 100 / 3600, gmag: 9 }])).toBe(false);
    expect(hasBrightNeighbour(star, [{ ra: 0, dec: 100 / 3600, gmag: null }])).toBe(false);
  });
});

describe('fieldPairsOf', () => {
  const pair = (verdict: PairReadout['verdict']): PairReadout => ({ a: 0, b: 1, verdict } as PairReadout);
  const star = (isTarget: boolean, verdict: PairReadout['verdict']): StarReadout =>
    ({ id: 'x', ra: 0, dec: 0, gmag: 10, isTarget, variable: null, pairs: [pair(verdict)] });
  it('ignores the target and no-result rows', () => {
    const f = fieldPairsOf([star(true, 'changed'), star(false, 'changed'), star(false, 'no significant change'), star(false, 'no result')]);
    expect(f).toEqual([{ a: 0, b: 1, fieldChangedFraction: 0.5, fieldReliable: false, nField: 2 }]);
  });
});
