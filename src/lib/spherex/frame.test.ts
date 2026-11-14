// Unit tests for loadFrame using a real local Level 2 file served by a fake Range fetch.
// @ts-ignore node types are not installed
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesTransferred, clearHeaderCaches, setFetch, walkHdus } from './fits';
import { clearWaveCache } from './wavelength';
import { loadFrame, loadFrames } from './frame';
import { positionAt } from './wcs';
import type { Exposure, Grid, Target } from './types';
import { BAD_DATA_MASK, FLAG_BITS } from './types';

const DIR = '/Users/samir/Desktop/spaceapps/research/samples/spherex-tests/';
const FILE = DIR + '2025W35_2A_0221_2_D2.fits';
const URL_OK = 'https://test.invalid/a.fits';
const URL_NAN = 'https://test.invalid/nan.fits';

const URL_B = 'https://test.invalid/b.fits';
const oracle = JSON.parse(readFileSync(DIR + 'oracle.json', 'utf8'));
const BARNARD: Target = { ra: 269.45207696, dec: 4.69336497, pmra: -801.551, pmdec: 10362.394, epoch: 2000 };

let data: Uint8Array;
let nanData: Uint8Array;

function rangeFetch(files: Record<string, Uint8Array>): typeof fetch {
  return (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    const buf = files[url];
    if (!buf) return new Response('nf', { status: 404 });
    const range = init?.headers?.['Range'] ?? init?.headers?.['range'] ?? '';
    const suf = /bytes=-(\d+)/.exec(range);
    if (suf) return new Response(buf.slice(Math.max(0, buf.length - Number(suf[1]))) as unknown as BodyInit, { status: 206 });
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if (!m) return new Response(buf as unknown as BodyInit, { status: 200 });
    const a = Number(m[1]);
    const b = Math.min(Number(m[2]) + 1, buf.length);
    return new Response(buf.slice(a, b) as unknown as BodyInit, { status: 206 });
  }) as unknown as typeof fetch;
}

const exposure: Exposure = {
  id: 'x', obsId: 'x', detector: 2, time: '', mjd: 60916.658, visitIndex: 0,
  wavelengthAtTarget: null, bandwidthAtTarget: null, url: URL_OK, release: 'dr1',
};
// Barnard position on this file's detector at pixel (1143.94, 822.84) per astropy.
const grid: Grid = { ra0: 269.44634441, dec0: 4.76722457, w: 21, h: 21, scaleArcsec: 6.15, epochMjd: 60916.658 };

beforeAll(async () => {
  data = new Uint8Array(readFileSync(FILE));
  nanData = data.slice();
  setFetch(rangeFetch({
    [URL_OK]: data, [URL_NAN]: nanData,
    [URL_B]: new Uint8Array(readFileSync(DIR + '2026W34_2A_0233_3_D2.fits')),
  }));
  const hdus = await walkHdus(URL_NAN);
  const img = hdus.find((h) => h.extname === 'IMAGE')!;
  const nx = Number(img.header['NAXIS1']);
  const off = img.dataStart + (823 * nx + 1144) * 4;
  new DataView(nanData.buffer).setUint32(off, 0x7fc00000, false);
});

afterAll(() => setFetch(globalThis.fetch));

describe('loadFrame', () => {
  it('resamples a good window with high coverage and fills the wavelength', async () => {
    const f = await loadFrame(exposure, grid);
    expect(f.w).toBe(21);
    expect(f.coverage).toBeGreaterThan(0.5);
    expect(f.exposure.wavelengthAtTarget).toBeGreaterThan(1.3);
    expect(f.exposure.wavelengthAtTarget).toBeLessThan(1.5);
    expect(exposure.wavelengthAtTarget).toBeNull();
  }, 60000);

  it('grid off the detector gives coverage 0 without throwing', async () => {
    const far: Grid = { ...grid, ra0: 100, dec0: -30 };
    const f = await loadFrame(exposure, far);
    expect(f.coverage).toBe(0);
    expect(f.pixels.every((v) => Number.isNaN(v))).toBe(true);
    expect(f.flags.every((v) => v === FLAG_BITS.NO_DATA)).toBe(true);
  }, 60000);

  it('NaN source pixel gives NaN output with NO_DATA', async () => {
    const f = await loadFrame({ ...exposure, url: URL_NAN }, grid);
    const bad = f.flags.filter((v) => (v & FLAG_BITS.NO_DATA) !== 0).length;
    expect(bad).toBeGreaterThan(0);
    expect(bad).toBeLessThan(10);
    for (let j = 0; j < f.flags.length; j++) {
      if ((f.flags[j] & BAD_DATA_MASK) !== 0) {
        expect(Number.isNaN(f.pixels[j])).toBe(true);
        expect(Number.isNaN(f.variance[j])).toBe(true);
      }
    }
  }, 60000);

  it('loadFrames collects failures and keeps input order', async () => {
    const bad: Exposure = { ...exposure, id: 'bad', url: 'https://test.invalid/missing.fits' };
    const seen: number[] = [];
    const r = await loadFrames([exposure, bad, { ...exposure, url: URL_NAN }], grid, {
      concurrency: 2, onFrame: () => seen.push(1),
    });
    expect(r.frames.length).toBe(2);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0].exposure.id).toBe('bad');
    expect(seen.length).toBe(2);
  }, 60000);

  it('aborted signal rejects with ABORTED', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(loadFrames([exposure], grid, { signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('loadFrame wavelength options', () => {
  // astropy WCS(header, fobj=hdul, key='W'), sip=None, at the detector pixel of each grid pixel
  // (grid x, grid y, detector x, detector y, wavelength um, bandwidth um).
  const astropy: [number, number, number, number, number, number][] = [
    [10, 10, 1143.939570182, 822.837726976, 1.3926888787358678, 0.03332915382438299],
    [0, 0, 1153.778778748, 812.603575449, 1.39562499410736, 0.03337521268843449],
    [20, 20, 1134.101118362, 833.070260801, 1.3898031509222346, 0.03329327635948394],
    [3, 15, 1151.062583884, 827.688907536, 1.391363789041895, 0.03328381430135107],
    [17, 6, 1136.835971504, 818.987062662, 1.393735189024721, 0.03336921145250794],
  ];

  it('leaves the maps undefined unless asked', async () => {
    const f = await loadFrame(exposure, grid);
    expect(f.wavelengthMap).toBeUndefined();
    expect(f.bandwidthMap).toBeUndefined();
  }, 60000);

  it('wavelengthMap matches astropy key W at output pixels', async () => {
    const f = await loadFrame(exposure, grid, { wavelengthMap: true });
    expect(f.wavelengthMap).toBeInstanceOf(Float32Array);
    expect(f.wavelengthMap!.length).toBe(21 * 21);
    expect(f.bandwidthMap!.length).toBe(21 * 21);
    let checked = 0;
    for (const [gx, gy, , , wl, bw] of astropy) {
      const j = gy * 21 + gx;
      if (f.flags[j] !== 0) {
        // masked output pixel (the Barnard star itself is flagged): map is NaN
        expect(Number.isNaN(f.wavelengthMap![j])).toBe(true);
        continue;
      }
      checked++;
      expect(Math.abs(f.wavelengthMap![j] - wl)).toBeLessThan(1e-5);
      expect(Math.abs(f.bandwidthMap![j] - bw)).toBeLessThan(1e-5);
    }
    expect(checked).toBeGreaterThanOrEqual(3);
    for (let j = 0; j < f.flags.length; j++) {
      if ((f.flags[j] & BAD_DATA_MASK) !== 0) {
        expect(Number.isNaN(f.wavelengthMap![j])).toBe(true);
        expect(Number.isNaN(f.bandwidthMap![j])).toBe(true);
      } else {
        expect(Number.isFinite(f.wavelengthMap![j])).toBe(true);
      }
    }
  }, 60000);

  it('wavelengthMap is NaN where the source pixel is NaN, and all NaN off detector', async () => {
    const f = await loadFrame({ ...exposure, url: URL_NAN }, grid, { wavelengthMap: true });
    let masked = 0;
    for (let j = 0; j < f.flags.length; j++) {
      if ((f.flags[j] & BAD_DATA_MASK) !== 0) {
        masked++;
        expect(Number.isNaN(f.wavelengthMap![j])).toBe(true);
      }
    }
    expect(masked).toBeGreaterThan(0);
    const far = await loadFrame(exposure, { ...grid, ra0: 100, dec0: -30 }, { wavelengthMap: true });
    expect(far.wavelengthMap!.every((v) => Number.isNaN(v))).toBe(true);
  }, 60000);

  it('options.target gives the Barnard wavelengths of the astropy oracle', async () => {
    const cases: [string, string][] = [['2025W35_2A_0221_2', URL_OK], ['2026W34_2A_0233_3', URL_B]];
    for (const [obs, url] of cases) {
      const mjd = oracle[obs].mjd as number;
      const c = positionAt(BARNARD, mjd);
      const g: Grid = { ra0: c.ra, dec0: c.dec, w: 21, h: 21, scaleArcsec: 6.15, epochMjd: mjd };
      const e: Exposure = { ...exposure, id: obs, mjd, url };
      const f = await loadFrame(e, g, { target: BARNARD });
      expect(Math.abs(f.exposure.wavelengthAtTarget! - oracle[obs].barnard.wavelength)).toBeLessThan(2e-4);
      expect(Math.abs(f.exposure.bandwidthAtTarget! - oracle[obs].barnard.bandwidth)).toBeLessThan(2e-4);
    }
    // a grid centred elsewhere: the target option, not the centre, sets the value
    const mjd = oracle['2025W35_2A_0221_2'].mjd as number;
    const f = await loadFrame({ ...exposure, mjd }, grid, { target: BARNARD });
    expect(Math.abs(f.exposure.wavelengthAtTarget! - oracle['2025W35_2A_0221_2'].barnard.wavelength)).toBeLessThan(2e-4);
  }, 60000);

  it('loadFrames passes wavelengthMap and target through', async () => {
    const r = await loadFrames([exposure], grid, { wavelengthMap: true, target: BARNARD });
    expect(r.frames[0].wavelengthMap).toBeDefined();
  }, 60000);
});

describe('frame.bytes and progress bytes', () => {
  it('counts every byte a frame read, headers included, and 0 header cost on a repeat', async () => {
    clearHeaderCaches();
    clearWaveCache();
    const seen: (number | undefined)[] = [];
    const b0 = bytesTransferred();
    const f1 = await loadFrame(exposure, grid, { onProgress: (p) => seen.push(p.bytes) });
    const d1 = bytesTransferred() - b0;
    expect(f1.bytes).toBe(d1);
    expect(f1.bytes).toBeGreaterThan(90 * 1024); // headers alone are 93 KB
    expect(seen[0]).toBe(0);
    expect(seen.every((b) => typeof b === 'number')).toBe(true);
    expect(seen[seen.length - 1]).toBe(f1.bytes);
    const b1 = bytesTransferred();
    const f2 = await loadFrame(exposure, grid);
    const d2 = bytesTransferred() - b1;
    expect(f2.bytes).toBe(d2);
    expect(f2.bytes).toBeLessThan(f1.bytes - 80 * 1024); // headers and wave table were cached
  }, 60000);

  it('an off-detector frame still reports the header bytes it read', async () => {
    clearHeaderCaches();
    clearWaveCache();
    const f = await loadFrame(exposure, { ...grid, ra0: 100, dec0: -30 });
    expect(f.coverage).toBe(0);
    expect(f.bytes).toBeGreaterThan(0);
    expect(f.bytes).toBeLessThan(40 * 1024);
  }, 60000);

  it('loadFrames progress carries the cumulative sum, failures included', async () => {
    clearHeaderCaches();
    clearWaveCache();
    const bad: Exposure = { ...exposure, id: 'bad', url: 'https://test.invalid/missing.fits' };
    const prog: (number | undefined)[] = [];
    const b0 = bytesTransferred();
    const r = await loadFrames([exposure, { ...exposure, url: URL_B }, bad], grid, {
      concurrency: 1, onProgress: (p) => prog.push(p.bytes),
    });
    expect(r.frames.length).toBe(2);
    const sum = r.frames.reduce((a, f) => a + f.bytes, 0);
    expect(sum).toBe(bytesTransferred() - b0);
    expect(prog[prog.length - 1]).toBe(sum);
    for (let i = 1; i < prog.length; i++) expect(prog[i]!).toBeGreaterThanOrEqual(prog[i - 1]!);
  }, 60000);
});
