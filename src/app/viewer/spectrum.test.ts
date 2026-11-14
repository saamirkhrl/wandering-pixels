import { describe, expect, it } from 'vitest';
import type { SpectrumPoint } from '../data';
import { isUsablePoint, spectrumCsv } from './spectrum';

const pt = (i: number, flagged: boolean): SpectrumPoint => ({
  exposureId: `OBS${i}D1`,
  wavelength: 1.64 + i,
  bandwidth: 0.02,
  flux: 12.3,
  fluxErr: 0.4,
  time: '2026-08-21T01:02:03Z',
  mjd: 61273.04,
  visitIndex: i,
  detector: 1,
  flagged,
});

describe('spectrumCsv', () => {
  it('writes a header and one row per point with 10 columns', () => {
    const lines = spectrumCsv([pt(0, false), pt(1, true)]).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      'exposure_id,wavelength_um,bandwidth_um,flux_mJy,flux_err_mJy,time_utc,mjd,visit,detector,flagged',
    );
    for (const l of lines) expect(l.split(',')).toHaveLength(10);
    expect(lines[1].endsWith(',0')).toBe(true);
    expect(lines[2].endsWith(',1')).toBe(true);
  });

  it('writes the 1-based visit number in the visit column', () => {
    const col = (csv: string) => csv.trim().split('\n').slice(1).map((l) => l.split(',')[7]);
    expect(col(spectrumCsv([pt(0, false), pt(2, false)]))).toEqual(['1', '3']);
    expect(col(spectrumCsv([pt(0, false), pt(2, false)], (v) => v * 10 + 5))).toEqual(['5', '25']);
  });

  it('returns only the header for no points', () => {
    expect(spectrumCsv([]).trim().split('\n')).toHaveLength(1);
  });
});

describe('non-finite points', () => {
  it('flags unusable points and writes empty CSV cells', () => {
    const bad = { ...pt(0, true), flux: NaN, fluxErr: NaN };
    expect(isUsablePoint(bad)).toBe(false);
    expect(isUsablePoint(pt(1, false))).toBe(true);
    const row = spectrumCsv([bad]).trim().split('\n')[1].split(',');
    expect(row).toHaveLength(10);
    expect(row[3]).toBe('');
    expect(row[4]).toBe('');
  });
});
