// @ts-ignore node types are not installed
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { setFetch, getHdu, readHduData, clearHeaderCaches, bytesTransferred } from './fits';
import { annotateWavelengths, clearWaveCache, parseWaveTable, readWaveTable, waveAt } from './wavelength';
import type { Exposure, Target } from './types';

import { SPHEREX_TESTS_DIR } from './testdata';
const DIR = SPHEREX_TESTS_DIR + '/';
const keys = JSON.parse(readFileSync(DIR + 'keys.json', 'utf8'));
const oracle = JSON.parse(readFileSync(DIR + 'oracle.json', 'utf8'));
const OBS = ['2025W35_2A_0221_2', '2026W34_2A_0233_3'];
const fileOf: Record<string, Uint8Array> = {};
let requests = 0;

beforeAll(() => {
  for (const o of OBS) fileOf[keys[o].url] = readFileSync(DIR + keys[o].file);
  setFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    const buf = fileOf[String(input)];
    if (!buf) return new Response('nope', { status: 404 });
    const range = new Headers(init?.headers).get('Range');
    const suf = range ? /bytes=-(\d+)/.exec(range) : null;
    if (suf) {
      const a = Math.max(0, buf.length - Number(suf[1]));
      return new Response(new Uint8Array(buf.subarray(a)), {
        status: 206,
        headers: { 'Content-Range': `bytes ${a}-${buf.length - 1}/${buf.length}` },
      });
    }
    const m = range ? /bytes=(\d+)-(\d+)/.exec(range) : null;
    if (!m) return new Response(new Uint8Array(buf), { status: 200 });
    const a = Number(m[1]);
    const b = Math.min(Number(m[2]) + 1, buf.length);
    return new Response(new Uint8Array(buf.subarray(a, b)), {
      status: 206,
      headers: { 'Content-Range': `bytes ${a}-${b - 1}/${buf.length}` },
    });
  }) as typeof fetch);
});

describe('wavelength vs astropy-derived oracle', () => {
  for (const o of OBS) {
    it(`waveAt matches oracle test points (${o})`, async () => {
      const url = keys[o].url;
      const img = await getHdu(url, 'IMAGE');
      const wave = await getHdu(url, 'WCS-WAVE');
      const t = parseWaveTable(img.header, wave, await readHduData(url, wave));
      expect(t.n1).toBe(11);
      expect(t.idx[0][0]).toBe(1);
      expect(t.idx[0][10]).toBe(2040);
      for (const p of oracle[o].testPoints) {
        const r = waveAt(t, p.x, p.y);
        expect(r.wavelength).toBeCloseTo(p.wavelength, 9);
        expect(r.bandwidth).toBeCloseTo(p.bandwidth, 9);
      }
      // the two swapped-axis points differ, so X/Y order is pinned
      const a = waveAt(t, 203, 204).wavelength;
      const b = waveAt(t, 204, 203).wavelength;
      expect(Math.abs(a - b)).toBeGreaterThan(1e-4);
    });

    it(`clamps outside the table (${o})`, async () => {
      const t = await readWaveTable(keys[o].url);
      expect(waveAt(t, -50, -50)).toEqual(waveAt(t, 0, 0));
      expect(waveAt(t, 5000, 5000)).toEqual(waveAt(t, 2039, 2039));
    });
  }

  it('readWaveTable caches per URL', async () => {
    await readWaveTable(keys[OBS[0]].url);
    const n = requests;
    await readWaveTable(keys[OBS[0]].url);
    expect(requests).toBe(n);
  });

  it('annotateWavelengths gives the Barnard wavelengths and null off detector', async () => {
    const mk = (o: string): Exposure => ({
      id: o + 'D2', obsId: o, detector: 2, time: '', mjd: oracle[o].mjd, visitIndex: 0,
      wavelengthAtTarget: null, bandwidthAtTarget: null, url: keys[o].url, release: keys[o].release,
    });
    const exps = OBS.map(mk);
    exps.push({ ...mk(OBS[0]), id: 'bad', url: 'https://example.invalid/none.fits' });
    const stages: string[] = [];
    const res = await annotateWavelengths(exps, 269.4545, 4.7686, {
      onProgress: (p) => stages.push(p.stage),
    });
    expect(res[0].wavelengthAtTarget).toBeCloseTo(oracle[OBS[0]].barnard.wavelength, 2);
    expect(res[0].bandwidthAtTarget).toBeCloseTo(oracle[OBS[0]].barnard.bandwidth, 3);
    expect(res[1].wavelengthAtTarget).toBeCloseTo(oracle[OBS[1]].barnard.wavelength, 2);
    expect(res[2].wavelengthAtTarget).toBeNull();
    expect(exps[0].wavelengthAtTarget).toBeNull(); // input not mutated
    expect(new Set(stages)).toEqual(new Set(['headers']));
    const far = await annotateWavelengths([exps[0]], 10, -40);
    expect(far[0].wavelengthAtTarget).toBeNull();
  });

  it('annotateWavelengths with a target uses positionAt per exposure and ignores ra/dec', async () => {
    const barnard: Target = { ra: 269.45207696, dec: 4.69336497, pmra: -801.551, pmdec: 10362.394, epoch: 2000 };
    const exps: Exposure[] = OBS.map((o) => ({
      id: o + 'D2', obsId: o, detector: 2, time: '', mjd: oracle[o].mjd, visitIndex: 0,
      wavelengthAtTarget: null, bandwidthAtTarget: null, url: keys[o].url, release: keys[o].release,
    }));
    const res = await annotateWavelengths(exps, 10, -40, { target: barnard });
    expect(Math.abs((res[0].wavelengthAtTarget as number) - oracle[OBS[0]].barnard.wavelength)).toBeLessThan(2e-4);
    expect(Math.abs((res[1].wavelengthAtTarget as number) - oracle[OBS[1]].barnard.wavelength)).toBeLessThan(2e-4);
  });

  it('uses two small requests per exposure and reports cumulative bytes', async () => {
    clearHeaderCaches();
    clearWaveCache();
    const exps: Exposure[] = OBS.map((o) => ({
      id: o + 'D2', obsId: o, detector: 2, time: '', mjd: oracle[o].mjd, visitIndex: 0,
      wavelengthAtTarget: null, bandwidthAtTarget: null, url: keys[o].url, release: keys[o].release,
    }));
    const r0 = requests;
    const b0 = bytesTransferred();
    const seen: (number | undefined)[] = [];
    const res = await annotateWavelengths(exps, 269.4545, 4.7686, { onProgress: (p) => seen.push(p.bytes) });
    expect(requests - r0).toBe(4); // first 32 KB + suffix per exposure
    const total = bytesTransferred() - b0;
    expect(total).toBeLessThan(2 * 50 * 1024);
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(total);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(res[0].wavelengthAtTarget).toBeCloseTo(oracle[OBS[0]].barnard.wavelength, 2);
    // second call: everything cached, zero bytes
    const again: (number | undefined)[] = [];
    await annotateWavelengths(exps, 269.4545, 4.7686, { onProgress: (p) => again.push(p.bytes) });
    expect(again.every((b) => b === 0)).toBe(true);
    expect(requests - r0).toBe(4);
  });

  it('throws ABORTED when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(annotateWavelengths([], 0, 0, { signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
