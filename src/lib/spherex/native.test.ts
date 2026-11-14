// Pure tests for the native-pixel stamp reader on a synthetic Level 2 file (no network).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearHeaderCaches, setFetch } from './fits';
import { clearWaveCache } from './wavelength';
import { loadNativeStamp, nativeStampsFor, stampWindow, starPosition } from './native';
import { parseWcs, pixToSky } from './wcs';
import { parseHeader } from './fits';
import { SpherexError } from './types';
import type { Exposure } from './types';

const NX = 30;
const NY = 20;
const enc = new TextEncoder();
const card = (s: string): string => s.padEnd(80, ' ').slice(0, 80);
const kv = (k: string, v: string): string => card(k.padEnd(8, ' ') + '= ' + v);
function hdr(cards: string[]): Uint8Array {
  const text = cards.map(card).join('') + card('END');
  return enc.encode(text.padEnd(Math.ceil(text.length / 2880) * 2880, ' '));
}
const padLen = (n: number): number => Math.ceil(n / 2880) * 2880;

const imgVal = (x: number, y: number): number => x + 100 * y;
const flagVal = (x: number, y: number): number => (x === 7 && y === 6 ? 0x80000000 : x * 1000 + y);

function ext(name: string, bitpix: number, f: (x: number, y: number) => number, wcs: boolean): Uint8Array[] {
  const cards = [
    kv('XTENSION', "'IMAGE   '"), kv('BITPIX', String(bitpix)), kv('NAXIS', '2'),
    kv('NAXIS1', String(NX)), kv('NAXIS2', String(NY)), kv('PCOUNT', '0'), kv('GCOUNT', '1'),
    kv('EXTNAME', `'${name}'`),
  ];
  if (wcs) {
    cards.push(
      kv('CTYPE1', "'RA---TAN'"), kv('CTYPE2', "'DEC--TAN'"), kv('CRPIX1', '11'), kv('CRPIX2', '6'),
      kv('CRVAL1', '10'), kv('CRVAL2', '0'), kv('CD1_1', String(-1 / 3600)), kv('CD1_2', '0'),
      kv('CD2_1', '0'), kv('CD2_2', String(1 / 3600)),
    );
  }
  const bp = Math.abs(bitpix) / 8;
  const data = new Uint8Array(padLen(NX * NY * bp));
  const dv = new DataView(data.buffer);
  for (let y = 0; y < NY; y++) {
    for (let x = 0; x < NX; x++) {
      const o = (y * NX + x) * 4;
      if (bitpix === 32) dv.setUint32(o, f(x, y) >>> 0, false);
      else dv.setFloat32(o, f(x, y), false);
    }
  }
  return [hdr(cards), data];
}

function buildFile(): Uint8Array {
  const parts = [
    hdr([kv('SIMPLE', 'T'), kv('BITPIX', '8'), kv('NAXIS', '0'), kv('EXTEND', 'T')]),
    ...ext('IMAGE', -32, imgVal, true),
    ...ext('FLAGS', 32, flagVal, false),
    ...ext('VARIANCE', -32, () => 0.5, false),
    ...ext('ZODI', -32, () => 1, false),
  ];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const URL_OK = 'https://test.invalid/synthetic.fits';
const FILE = buildFile();
const exposure: Exposure = {
  id: 'SYNTH', obsId: 'SYNTH', detector: 2, time: '2026-01-01T00:00:00Z', mjd: 61000, visitIndex: 3,
  wavelengthAtTarget: null, bandwidthAtTarget: null, url: URL_OK, release: 'dr1',
};

const rangeFetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
  if (String(input) !== URL_OK) return new Response('nf', { status: 404 });
  const range = init?.headers?.['Range'] ?? init?.headers?.['range'] ?? '';
  const suf = /bytes=-(\d+)/.exec(range);
  if (suf) return new Response(FILE.slice(Math.max(0, FILE.length - Number(suf[1]))) as unknown as BodyInit, { status: 206 });
  const m = /bytes=(\d+)-(\d+)/.exec(range);
  if (!m) return new Response(FILE as unknown as BodyInit, { status: 200 });
  return new Response(FILE.slice(Number(m[1]), Math.min(Number(m[2]) + 1, FILE.length)) as unknown as BodyInit, { status: 206 });
}) as unknown as typeof fetch;

const wcs = parseWcs(parseHeader(FILE.subarray(2880))!.header);
const skyOf = (x: number, y: number): { ra: number; dec: number } => pixToSky(wcs, x, y);

beforeEach(() => {
  clearHeaderCaches();
  clearWaveCache();
  setFetch(rangeFetch);
});
afterEach(() => setFetch(fetch));

describe('stampWindow', () => {
  it('centres on the nearest pixel with 0-based centre-at-integer coordinates', () => {
    const w = stampWindow(10.3, 5.8, NX, NY, 4);
    expect(w.cx).toBe(10);
    expect(w.cy).toBe(6);
    expect(w.col0).toBe(6);
    expect(w.row0).toBe(2);
    expect(w.x).toBeCloseTo(4.3, 12);
    expect(w.y).toBeCloseTo(3.8, 12);
    // a star exactly on a pixel centre sits at the stamp centre index
    const c = stampWindow(10, 6, NX, NY, 4);
    expect(c.x).toBe(4);
    expect(c.y).toBe(4);
  });
  it('allows -0.5 <= p < n - 0.5 and rejects the rest with NO_COVERAGE', () => {
    expect(stampWindow(-0.5, 0, NX, NY, 2).col0).toBe(-2);
    expect(() => stampWindow(-0.51, 0, NX, NY, 2)).toThrow(SpherexError);
    expect(() => stampWindow(NX - 0.5, 0, NX, NY, 2)).toThrow(/off the detector/);
    expect(() => stampWindow(NaN, 0, NX, NY, 2)).toThrow(SpherexError);
  });
});

describe('loadNativeStamp', () => {
  it('reads an interior stamp: p = IMAGE - ZODI, variance, raw flags, native orientation', async () => {
    const half = 3;
    const s = await loadNativeStamp(exposure, ...(Object.values(skyOf(12.25, 9.4)) as [number, number]), half);
    expect(s.size).toBe(7);
    expect(s.col0).toBe(12 - 3);
    expect(s.row0).toBe(9 - 3);
    expect(s.x).toBeCloseTo(3.25, 5);
    expect(s.y).toBeCloseTo(3.4, 5);
    expect(s.exposureId).toBe('SYNTH');
    expect(s.visitIndex).toBe(3);
    expect(s.detector).toBe(2);
    for (let j = 0; j < 7; j++) {
      for (let i = 0; i < 7; i++) {
        const gx = s.col0 + i, gy = s.row0 + j;
        expect(s.p[j * 7 + i]).toBe(imgVal(gx, gy) - 1);
        expect(s.variance[j * 7 + i]).toBe(0.5);
        expect(s.flags[j * 7 + i]).toBe(flagVal(gx, gy) >>> 0);
      }
    }
    expect(Number.isNaN(s.wavelength)).toBe(true); // no WCS-WAVE in the synthetic file
    expect(s.bytes).toBeGreaterThan(0);
  });

  it('keeps raw 32-bit flag words (bit 31 survives as unsigned)', async () => {
    const s = await loadNativeStamp(exposure, skyOf(7, 6).ra, skyOf(7, 6).dec, 2);
    const k = (6 - s.row0) * s.size + (7 - s.col0);
    expect(s.flags[k]).toBe(0x80000000);
    expect(s.flags[k + 1]).toBeLessThan(0x80000000);
  });

  it('pads off-detector pixels at the corner: p and variance NaN, flags 0', async () => {
    const half = 3;
    const s = await loadNativeStamp(exposure, skyOf(1, 0).ra, skyOf(1, 0).dec, half);
    expect(s.col0).toBe(-2);
    expect(s.row0).toBe(-3);
    expect(s.x).toBeCloseTo(3, 6);
    expect(s.y).toBeCloseTo(3, 6);
    for (let j = 0; j < 7; j++) {
      for (let i = 0; i < 7; i++) {
        const gx = s.col0 + i, gy = s.row0 + j;
        const inside = gx >= 0 && gx < NX && gy >= 0 && gy < NY;
        if (inside) {
          expect(s.p[j * 7 + i]).toBe(imgVal(gx, gy) - 1);
          expect(s.flags[j * 7 + i]).toBe(flagVal(gx, gy) >>> 0);
        } else {
          expect(Number.isNaN(s.p[j * 7 + i])).toBe(true);
          expect(Number.isNaN(s.variance[j * 7 + i])).toBe(true);
          expect(s.flags[j * 7 + i]).toBe(0);
        }
      }
    }
  });

  it('pads at the far corner too', async () => {
    const s = await loadNativeStamp(exposure, skyOf(NX - 1, NY - 1).ra, skyOf(NX - 1, NY - 1).dec, 2);
    expect(s.col0).toBe(NX - 3);
    expect(s.row0).toBe(NY - 3);
    expect(Number.isNaN(s.p[0])).toBe(false);
    expect(Number.isNaN(s.p[4])).toBe(true); // stamp col 4 is native col NX + 1
  }, 10000);

  it('off-detector star -> NO_COVERAGE', async () => {
    const p = skyOf(NX + 5, 5);
    await expect(loadNativeStamp(exposure, p.ra, p.dec, 2)).rejects.toMatchObject({ code: 'NO_COVERAGE' });
  });

  it('validates halfSizePx', async () => {
    const p = skyOf(10, 10);
    for (const bad of [0, -1, 51, 2.5, NaN, Infinity]) {
      await expect(loadNativeStamp(exposure, p.ra, p.dec, bad)).rejects.toMatchObject({ code: 'BAD_INPUT' });
    }
    await expect(loadNativeStamp(exposure, NaN, 0, 2)).rejects.toMatchObject({ code: 'BAD_INPUT' });
    const s = await loadNativeStamp(exposure, p.ra, p.dec, 1);
    expect(s.size).toBe(3);
  });
});

describe('nativeStampsFor', () => {
  it('collects stamps and failures with progress', async () => {
    const bad: Exposure = { ...exposure, id: 'BAD', url: 'https://test.invalid/missing.fits' };
    const far = skyOf(NX + 5, 5);
    const good = skyOf(10, 10);
    const exps = [exposure, bad, { ...exposure, id: 'FAR' }];
    const msgs: string[] = [];
    const r = await nativeStampsFor(
      exps, (e) => (e.id === 'FAR' ? far : good), 2,
      { concurrency: 2, onProgress: (p) => { msgs.push(`${p.stage}:${p.message}`); } },
    );
    expect(r.stamps.map((s) => s.exposureId)).toEqual(['SYNTH']);
    expect(r.failed.map((f) => f.exposure.id).sort()).toEqual(['BAD', 'FAR']);
    expect(r.failed.find((f) => f.exposure.id === 'FAR')!.error.code).toBe('NO_COVERAGE');
    expect(msgs).toHaveLength(3);
    expect(msgs[2]).toBe('pixels:Read 3 of 3 stamps');
  });
  it('rejects a bad halfSizePx up front', async () => {
    await expect(nativeStampsFor([exposure], () => skyOf(10, 10), 0)).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});

describe('starPosition', () => {
  it('applies proper motion at the exposure mjd', () => {
    const f = starPosition({ ra: 10, dec: 0, pmra: 1000, pmdec: 0, epoch: 2000 });
    const a = f({ ...exposure, mjd: 51544.5 });
    const b = f({ ...exposure, mjd: 51544.5 + 365.25 * 10 });
    expect(a.ra).toBeCloseTo(10, 9);
    expect((b.ra - a.ra) * 3600).toBeCloseTo(10, 2); // 1000 mas/yr * 10 yr = 10 arcsec
  });
});
