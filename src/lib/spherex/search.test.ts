import { afterEach, describe, expect, it, vi } from 'vitest';
import { assignVisits, findExposures, mjdToIso, rowsToExposures } from './search';
import type { ExposureRow } from './search';
import type { Exposure } from './types';

const row = (obsId: string, t: number, release: ExposureRow['release'] = 'dr1', detector = 2): ExposureRow => ({
  obsId, detector, tMin: t - 0.001, tMax: t + 0.001, url: `https://s3/${obsId}/${release}`, release,
});

afterEach(() => vi.unstubAllGlobals());

describe('mjdToIso', () => {
  it('converts MJD to UTC ISO', () => {
    // MJD 40587 is 1970-01-01, so 60902.5 is 20315.5 days later: 2025-08-15T12:00Z.
    expect(mjdToIso(60902.5)).toBe('2025-08-15T12:00:00.000Z');
    expect(mjdToIso(60907.5)).toBe('2025-08-20T12:00:00.000Z');
    expect(mjdToIso(40587)).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('assignVisits', () => {
  const mk = (mjd: number): Exposure => ({
    id: String(mjd), obsId: 'o', detector: 1, time: '', mjd, visitIndex: 0,
    wavelengthAtTarget: null, bandwidthAtTarget: null, url: '', release: 'dr1',
  });
  it('starts a new visit after a 31 day gap', () => {
    expect(assignVisits([mk(60000), mk(60031)]).map((e) => e.visitIndex)).toEqual([0, 1]);
  });
  it('splits a continuous run longer than 45 days into 30-day bins', () => {
    const days = [0, 10, 29.9, 30, 50, 59, 61, 100, 140];
    expect(assignVisits(days.map((d) => mk(60000 + d))).map((e) => e.visitIndex))
      .toEqual([0, 0, 0, 1, 1, 1, 2, 3, 4]);
  });
  it('does not split a 45 day run, and bins restart after a real gap', () => {
    expect(assignVisits([mk(60000), mk(60025), mk(60045)]).map((e) => e.visitIndex)).toEqual([0, 0, 0]);
    expect(assignVisits([mk(60000), mk(60020), mk(60046), mk(60100), mk(60110)]).map((e) => e.visitIndex))
      .toEqual([0, 0, 1, 2, 2]);
  });
  it('sorts unsorted input', () => {
    expect(assignVisits([mk(60040), mk(60000)]).map((e) => e.mjd)).toEqual([60000, 60040]);
  });
  it('keeps a 29 day gap in the same visit', () => {
    expect(assignVisits([mk(60000), mk(60029)]).map((e) => e.visitIndex)).toEqual([0, 0]);
  });
});

describe('rowsToExposures', () => {
  it('dedupes preferring dr1 > qr3 > qr2 and sorts by mjd', () => {
    const out = rowsToExposures([
      row('B', 60100, 'qr2'), row('B', 60100, 'qr3'), row('B', 60100, 'qr2'),
      row('A', 60000, 'qr2'), row('A', 60000, 'dr1'),
    ]);
    expect(out.map((e) => e.id)).toEqual(['AD2', 'BD2']);
    expect(out[0].release).toBe('dr1');
    expect(out[1].release).toBe('qr3');
    expect(out[0].wavelengthAtTarget).toBeNull();
    expect(out[1].visitIndex).toBe(1);
  });
});

describe('findExposures', () => {
  it('throws NO_COVERAGE on empty and reports search progress', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ra: 1, dec: 2, count: 0, partial: [], exposures: [] }), { status: 200 })));
    await expect(findExposures(1, 2)).rejects.toMatchObject({ code: 'NO_COVERAGE' });
  });
  it('rejects bad input', async () => {
    await expect(findExposures(NaN, 0)).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(findExposures(10, 95)).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
  it('returns exposures with start and end progress', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ exposures: [row('A', 60000)] }), { status: 200 })));
    const seen: string[] = [];
    const out = await findExposures(1, 2, { onProgress: (p) => seen.push(p.stage) });
    expect(out).toHaveLength(1);
    expect(seen).toEqual(['search', 'search']);
  });
});
