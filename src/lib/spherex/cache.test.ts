// Tests only: node typings are not installed, so these three imports are untyped.
// @ts-ignore
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
// @ts-ignore
import { tmpdir } from 'node:os';
// @ts-ignore
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeCache, encodeCache, listCached, loadCached } from './cache';
import type { CacheInput } from './cache';
import type { Exposure, Frame, Grid } from './types';
import { FLAG_BITS, SpherexError } from './types';

const W = 65;
const H = 65;
const N = 300;
const PER = W * H;

function makeInput(): CacheInput {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const grid: Grid = { ra0: 269.45, dec0: 4.69, w: W, h: H, scaleArcsec: 6.15, epochMjd: 60000 };
  const exposures: Exposure[] = [];
  const frames: Frame[] = [];
  for (let i = 0; i < N; i++) {
    const exposure: Exposure = {
      id: `OBS${i}D${(i % 6) + 1}`, obsId: `OBS${i}`, detector: ((i % 6) + 1) as Exposure['detector'],
      time: '2025-07-01T00:00:00Z', mjd: 60000 + i, visitIndex: Math.floor(i / 50),
      wavelengthAtTarget: 0.75 + i * 0.015, bandwidthAtTarget: 0.02,
      url: 'https://example.invalid/x.fits', release: 'dr1',
    };
    exposures.push(exposure);
    const pixels = new Float32Array(PER);
    const variance = new Float32Array(PER);
    const flags = new Uint8Array(PER);
    let good = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const j = y * W + x;
        const r2 = (x - 32 - i * 0.01) ** 2 + (y - 32) ** 2;
        pixels[j] = 800 * Math.exp(-r2 / (2 * 0.36)) + (rnd() - 0.5) * 0.6;
        variance[j] = 0.01 * Math.exp(rnd() * 8) + pixels[j] * 1e-4 * (pixels[j] > 0 ? 1 : 0);
        if (x === 0 || (x === 10 && y === 10)) {
          pixels[j] = NaN; variance[j] = NaN; flags[j] = FLAG_BITS.NO_DATA;
        } else good++;
      }
    }
    if (i === 3) { pixels[500] = 1e6; flags[500] = 0; variance[500] = 0; }
    if (i === 4) { pixels[501] = -1e6; }
    frames.push({ exposure, grid, pixels, variance, flags, w: W, h: H, coverage: good / PER, bytes: 0 });
  }
  return {
    slug: 'barnards-star',
    target: { ra: 269.45, dec: 4.69, pmra: -798, pmdec: 10328, epoch: 2000, name: "Barnard's Star", source: 'cache' },
    grid, exposures, frames,
    gaia: [{ sourceId: '1', ra: 269.4, dec: 4.7, pmra: 1, pmdec: 2, parallax: 3, gmag: 9.5 }],
    wise: [{ id: 'w1', note: 'opaque', nested: { a: [1, 2, 3] } }] as never,
    builtAt: '2026-11-14T12:00:00Z',
  };
}

describe('encode/decode', () => {
  const input = makeInput();
  const enc = encodeCache(input);

  it('has the documented size', () => {
    expect(enc.bin.length).toBe(N * PER * 4);
    expect(enc.bin.length).toBe(5_070_000);
    expect(enc.bin.length).toBeLessThan(6_000_000);
    expect(enc.manifest.layout.arrays.map((a) => a.offset)).toEqual([0, N * PER * 2, N * PER * 3]);
  });

  it('round-trips within the stated error bounds', { timeout: 30000 }, () => {
    const m = JSON.parse(enc.manifestJson);
    const out = decodeCache(m, enc.bin);
    expect(out.frames.length).toBe(N);
    expect(out.gaia).toEqual(input.gaia);
    expect(out.wise).toEqual(input.wise);
    expect(out.builtAt).toBe(input.builtAt);
    expect(out.exposures).toEqual(input.exposures);
    const va = m.layout.arrays[1];
    const sigmaBound = 2 ** (va.log2Step / 4) - 1 + 1e-6;
    let maxSigma = 0;
    let maxRel = 0;
    let bad = 0;
    for (let i = 0; i < N; i++) {
      const a = input.frames[i];
      const b = out.frames[i];
      expect(b.coverage).toBe(a.coverage);
      expect(b.w).toBe(W);
      expect(b.exposure.id).toBe(a.exposure.id);
      for (let j = 0; j < PER; j++) {
        const p = a.pixels[j];
        const q = b.pixels[j];
        if (Number.isNaN(p)) {
          if (!(Number.isNaN(q) && b.flags[j] !== 0 && Number.isNaN(b.variance[j]))) bad++;
          continue;
        }
        if (Math.abs(p) > 65504) { if (q !== (p > 0 ? 65504 : -65504)) bad++; continue; }
        if (Math.abs(q - p) > Math.abs(p) * 2 ** -11 + 2 ** -25) bad++;
        if (Math.abs(p) > 1e-3) maxRel = Math.max(maxRel, Math.abs(q - p) / Math.abs(p));
        if (b.flags[j] !== a.flags[j]) bad++;
        const v = a.variance[j];
        if (v > 0) {
          const s = Math.abs(Math.sqrt(b.variance[j] / v) - 1);
          maxSigma = Math.max(maxSigma, s);
          if (s > sigmaBound) bad++;
        } else if (!(b.variance[j] > 0)) bad++;
      }
    }
    expect(bad).toBe(0);
    expect(maxRel).toBeLessThanOrEqual(2 ** -11);
    console.log('max sigma err', maxSigma, 'max pixel rel err', maxRel, 'log2Step', va.log2Step);
    expect(maxSigma).toBeLessThan(0.03);
  });

  it('advisory-flagged pixel keeps its value and variance; bad-data pixel is NaN', () => {
    const inp = makeInput();
    const f = inp.frames[0];
    f.pixels[100] = 12.5; f.variance[100] = 0.25; f.flags[100] = FLAG_BITS.CROSSTALK | FLAG_BITS.HALO;
    f.pixels[101] = 7; f.variance[101] = 0.25; f.flags[101] = FLAG_BITS.STREAK | FLAG_BITS.SATURATED;
    const e = encodeCache(inp);
    const out = decodeCache(JSON.parse(e.manifestJson), e.bin).frames[0];
    expect(out.pixels[100]).toBe(12.5);
    expect(out.variance[100]).toBeGreaterThan(0.2);
    expect(out.variance[100]).toBeLessThan(0.3);
    expect(out.flags[100]).toBe(FLAG_BITS.CROSSTALK | FLAG_BITS.HALO);
    expect(Number.isNaN(out.pixels[101])).toBe(true);
    expect(out.flags[101]).toBe(FLAG_BITS.STREAK | FLAG_BITS.SATURATED);
    // a NaN pixel with only advisory bits gets NO_DATA added
    const inp2 = makeInput();
    inp2.frames[0].pixels[200] = NaN; inp2.frames[0].variance[200] = NaN; inp2.frames[0].flags[200] = FLAG_BITS.PERSIST;
    const e2 = encodeCache(inp2);
    const o2 = decodeCache(JSON.parse(e2.manifestJson), e2.bin).frames[0];
    expect(o2.flags[200]).toBe(FLAG_BITS.PERSIST | FLAG_BITS.NO_DATA);
  });

  it('round-trips Exposure.inStack (true, false, absent)', () => {
    const inp = makeInput();
    inp.exposures[0] = { ...inp.exposures[0], inStack: true };
    inp.exposures[1] = { ...inp.exposures[1], inStack: false };
    inp.frames[0].exposure = inp.exposures[0];
    inp.frames[1].exposure = inp.exposures[1];
    const e = encodeCache(inp);
    const out = decodeCache(JSON.parse(e.manifestJson), e.bin);
    expect(out.exposures[0].inStack).toBe(true);
    expect(out.exposures[1].inStack).toBe(false);
    expect('inStack' in out.exposures[2]).toBe(false);
    expect(out.frames[1].exposure.inStack).toBe(false);
  });

  it('rejects null wavelengths and mismatched frames', () => {
    const bad = makeInput();
    bad.exposures[0] = { ...bad.exposures[0], wavelengthAtTarget: null };
    bad.frames[0].exposure = bad.exposures[0];
    expect(() => encodeCache(bad)).toThrow(SpherexError);
    const bad2 = makeInput();
    bad2.frames.pop();
    expect(() => encodeCache(bad2)).toThrow(SpherexError);
  });

  it('rejects truncated data', () => {
    expect(() => decodeCache(enc.manifest, enc.bin.subarray(0, 1000))).toThrow(SpherexError);
  });
});

describe('loadCached', () => {
  let dir: string;
  let expected: ReturnType<typeof encodeCache>;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wp-cache-test-'));
    mkdirSync(join(dir, 'barnards-star'));
    expected = encodeCache(makeInput());
    writeFileSync(join(dir, 'barnards-star', 'manifest.json'), expected.manifestJson);
    writeFileSync(join(dir, 'barnards-star', 'frames.bin'), expected.bin);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const fsFetch = ((root: string) => async (url: string | URL | Request) => {
    const u = String(url);
    const path = join(root, u.replace(/^https?:\/\/[^/]+\/cache\//, ''));
    if (!existsSync(path)) return new Response('nope', { status: 404 });
    return new Response(readFileSync(path), { status: 200 });
  });

  it('loads manifest and bin and reports progress', async () => {
    const urls: string[] = [];
    const f = fsFetch(dir);
    const stages: string[] = [];
    const c = await loadCached('barnards-star', {
      baseUrl: 'http://site.test/cache',
      fetchFn: (async (u: string | URL | Request, i?: RequestInit) => { urls.push(String(u)); return f(u); }) as typeof fetch,
      onProgress: (p) => stages.push(p.stage),
    });
    expect(urls).toEqual(['http://site.test/cache/barnards-star/manifest.json', 'http://site.test/cache/barnards-star/frames.bin']);
    expect(c.frames.length).toBe(N);
    expect(new Set(stages)).toEqual(new Set(['pixels']));
    expect(c.target.name).toBe("Barnard's Star");
  });

  it('maps 404 to NOT_FOUND', async () => {
    await expect(loadCached('r-dra', { baseUrl: 'http://site.test/cache/', fetchFn: fsFetch(dir) as typeof fetch }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps 500 and network errors to UPSTREAM_ERROR', async () => {
    await expect(loadCached('r-dra', { fetchFn: (async () => new Response('x', { status: 500 })) as typeof fetch }))
      .rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    await expect(loadCached('r-dra', { fetchFn: (async () => { throw new TypeError('down'); }) as typeof fetch }))
      .rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('maps abort to ABORTED', async () => {
    const ac = new AbortController();
    ac.abort();
    const f: typeof fetch = async (_u, init) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response('x');
    };
    await expect(loadCached('r-dra', { fetchFn: f, signal: ac.signal }))
      .rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('listCached', () => {
  it('lists the five targets', () => {
    const l = listCached();
    expect(l.map((x) => x.slug)).toEqual(['barnards-star', 'eps-indi-b', 'wise-0855', 'rw-aur', 'r-dra']);
    for (const x of l) { expect(x.name.length).toBeGreaterThan(0); expect(x.blurb).toMatch(/^[\x20-\x7e]+$/); }
  });
});
