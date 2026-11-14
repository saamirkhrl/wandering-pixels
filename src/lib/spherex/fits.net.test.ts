import { beforeAll, describe, expect, it } from 'vitest';
import {
  bytesTransferred, clearHeaderCaches, getHdu, readHduData, readImageBlock, readWaveTail, setFetch, walkHdus,
} from './fits';
import { parseWaveTable, waveAt } from './wavelength';

const URL =
  'https://nasa-irsa-spherex.s3.amazonaws.com/dr1/level2/2025W35_2A/l2b-v27-2026-231/2/' +
  'level2_2025W35_2A_0221_2D2_spx_l2b-v27-2026-231.fits';

let requests = 0;

beforeAll(() => {
  setFetch(((input: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    return fetch(input, init);
  }) as typeof fetch);
});

describe('real SPHEREx Level 2 file', () => {
  it('walks the 7 HDUs with few requests', async () => {
    const b0 = bytesTransferred();
    const r0 = requests;
    const hdus = await walkHdus(URL);
    console.log(
      `walkHdus: ${requests - r0} requests, ${bytesTransferred() - b0} bytes; offsets`,
      hdus.map((h) => `${h.extname || 'PRIMARY'}@${h.headerStart}/${h.dataStart}`).join(' '),
    );
    expect(hdus.map((h) => h.extname)).toEqual(['', 'IMAGE', 'FLAGS', 'VARIANCE', 'ZODI', 'EPSF', 'WCS-WAVE']);
    const img = hdus[1];
    expect(img.header.NAXIS1).toBe(2040);
    expect(img.header.NAXIS2).toBe(2040);
    expect(img.header.BITPIX).toBe(-32);
    expect(img.dataBytes).toBe(2040 * 2040 * 4);
    expect(hdus.map((h) => h.dataStart)).toEqual([2880, 28800, 16692480, 23316480, 39974400, 56626560, 60491520]);
    expect(hdus.map((h) => h.headerStart)).toEqual([0, 2880, 16675200, 23304960, 39962880, 56620800, 60488640]);
    expect((await getHdu(URL, 'WCS-WAVE')).index).toBe(6);
  }, 60000);

  it('reads a 10x10 IMAGE block matching astropy', async () => {
    const img = await getHdu(URL, 'IMAGE');
    const blk = await readImageBlock(URL, img, 995, 1005, 995, 1005);
    expect(blk.length).toBe(100);
    // Oracle: astropy, d[995:1005, 995:1005] (row index first)
    expect(blk[0]).toBeCloseTo(0.2965598404407501, 6);
    expect(blk[1]).toBeCloseTo(0.25609782338142395, 6);
    expect(blk[2]).toBeCloseTo(0.23566213250160217, 6);
    expect(blk[3]).toBeCloseTo(0.2906528115272522, 6);
    expect(blk[9 * 10 + 6]).toBeCloseTo(0.25278106331825256, 6);
    expect(blk[9 * 10 + 7]).toBeCloseTo(0.267187237739563, 6);
    expect(blk[9 * 10 + 8]).toBeCloseTo(0.4436109662055969, 6);
    expect(blk[9 * 10 + 9]).toBeCloseTo(0.4851783514022827, 6);
    expect(blk[5 * 10 + 5]).toBeCloseTo(0.25687161087989807, 6);
    let sum = 0;
    for (const v of blk) sum += v;
    expect(sum).toBeCloseTo(52.5025397837162, 3);
  }, 60000);
});

const S3 = 'https://nasa-irsa-spherex.s3.amazonaws.com/';
// Different releases (dr1, qr2, qr3) and detectors (D1, D2, D4, D6); qr2 has a plain int32 FLAGS and PSF.
const SAMPLE = [
  'dr1/level2/2025W35_2A/l2b-v27-2026-231/2/level2_2025W35_2A_0221_2D2_spx_l2b-v27-2026-231.fits',
  'dr1/level2/2025W30_1B/l2b-v27-2026-220/1/level2_2025W30_1B_0001_1D1_spx_l2b-v27-2026-220.fits',
  'dr1/level2/2025W30_1B/l2b-v27-2026-220/4/level2_2025W30_1B_0001_1D4_spx_l2b-v27-2026-220.fits',
  'qr2/level2/2025W30_1B/l2b-v20-2025-262/1/level2_2025W30_1B_0001_1D1_spx_l2b-v20-2025-262.fits',
  'qr2/level2/2025W30_1B/l2b-v20-2025-262/6/level2_2025W30_1B_0001_1D6_spx_l2b-v20-2025-262.fits',
  'qr3/level2/2026W22_1A/l2b-v27-2026-269/4/level2_2026W22_1A_0001_1D4_spx_l2b-v27-2026-269.fits',
  'qr3/level2/2026W34_2A/l2b-v27-2026-243/2/level2_2026W34_2A_0233_3D2_spx_l2b-v27-2026-243.fits',
].map((k) => S3 + k);

describe('fast header path against the full walk on real files', () => {
  for (const url of SAMPLE) {
    it(`matches walkHdus: ${url.split('/').pop()}`, async () => {
      clearHeaderCaches();
      // fast path first (the walk cache would short-circuit it)
      const r0 = requests;
      const b0 = bytesTransferred();
      const fast: Record<string, Awaited<ReturnType<typeof getHdu>>> = {};
      for (const n of ['IMAGE', 'FLAGS', 'VARIANCE', 'ZODI']) fast[n] = await getHdu(url, n);
      const tail = await readWaveTail(url);
      const fastReq = requests - r0;
      const fastBytes = bytesTransferred() - b0;
      console.log(`${url.split('/').pop()}: fast path ${fastReq} requests, ${fastBytes} bytes`);
      expect(fastReq).toBeLessThanOrEqual(6); // 1 image + 1 flags + 2 var/zodi + 1 tail
      expect(fastBytes).toBeLessThan(120 * 1024);

      const walk = await walkHdus(url);
      for (const n of ['IMAGE', 'FLAGS', 'VARIANCE', 'ZODI']) {
        expect(fast[n]).toEqual(walk.find((h) => h.extname === n));
      }
      const wave = walk.find((h) => h.extname === 'WCS-WAVE')!;
      expect(wave).toBe(walk[walk.length - 1]);
      expect({ ...tail.hdu, index: wave.index }).toEqual(wave);
      expect(tail.fileSize).toBe(wave.dataStart + Math.ceil(wave.dataBytes / 2880) * 2880);
      const data = await readHduData(url, wave);
      expect(Array.from(tail.data)).toEqual(Array.from(data));
      const tFast = parseWaveTable(fast['IMAGE'].header, tail.hdu, tail.data);
      const tWalk = parseWaveTable(walk[1].header, wave, data);
      expect(tFast).toEqual(tWalk);
      expect(waveAt(tFast, 1000, 1000)).toEqual(waveAt(tWalk, 1000, 1000));
    }, 90000);
  }
});
