// Precomputed target cache: encoder, decoder and browser loader.
//
// Layout on the site: <baseUrl><slug>/manifest.json and <baseUrl><slug>/frames.bin
// (default baseUrl '/cache/'). Two requests, both on the site's own origin.
//
// manifest.json (JSON):
//   { format: 'wp-cache-1', slug, target, grid, exposures, gaia, wise, builtAt,
//     layout: { w, h, nFrames, coverage: number[nFrames],
//       arrays: [ {name:'pixels',   type:'f16',   offset, bytes},
//                 {name:'variance', type:'u8log', offset, bytes, log2Min, log2Step},
//                 {name:'flags',    type:'u8',    offset, bytes} ] } }
//   exposures are in frame order and wavelengthAtTarget is never null. wise is an
//   opaque list of JSON objects, round-tripped untouched.
//
// frames.bin: three planar blocks (offsets in the manifest), each nFrames*w*h values,
//   frame-major then row-major (row 0 = north edge, as in Frame.pixels).
//   pixels:   IEEE half, little-endian uint16. NaN is kept. Finite values beyond
//             +-65504 (and +-Infinity) are clamped to +-65504.
//   variance: uint8 log2 code. 0 = NaN / no data. Code k >= 1 decodes to
//             2^(log2Min + (k-1)*log2Step). Zero or negative variance -> code 1.
//   flags:    uint8 as given.
// 4 bytes per pixel: 300 frames of 65 x 65 = 5,070,000 bytes (about 5.07 MB).
//
// Precision loss:
//   pixels: half has 11 significant bits, so relative error is at most 2^-11
//     (about 0.049 percent) for |v| >= 2^-14 (6.1e-5); below that the absolute
//     error is at most 2^-25 (3e-8 MJy/sr). Largest value 65504 MJy/sr.
//   variance: log2Min is the log2 of the smallest finite positive variance and
//     log2Step = (log2Max - log2Min) / 254, so the 254 codes span the data range.
//     Rounding error is at most half a step: relative error in variance of
//     2^(step/2) - 1 and in sigma of 2^(step/4) - 1. Example: a range of 25 octaves
//     (7.5 decades of variance) gives step 0.0984, sigma error at most 1.7 percent.
//     A range of 12 octaves gives step 0.047 and sigma error 0.8 percent.
//     Values at the very minimum or maximum are exact to the step grid.
//   flags: lossless. On decode, a pixel with any BAD_DATA_MASK bit is forced to NaN (the
//     library's masking rule). A NaN pixel with no BAD_DATA bit gets FLAG_BITS.NO_DATA added.
//     Advisory bits (ADVISORY_MASK) never blank a pixel: its value and variance round-trip.
//
// encodeCache uses no Node APIs, so a Node build script and the browser share it.

import type {
  CachedSlug, CachedTarget, CallOptions, Exposure, Frame, GaiaStar, Grid, Target,
} from './types';
import { BAD_DATA_MASK, FLAG_BITS, SpherexError } from './types';
import { floatToHalf, halfToFloat } from './f16';
import type { WiseSource } from './wise';

export const CACHE_FORMAT = 'wp-cache-1';
const HALF_MAX = 65504;
const VAR_CODES = 254; // codes 1..255 -> 254 steps between code 1 and code 255

interface ArrayInfo {
  name: string;
  type: 'f16' | 'u8log' | 'u8';
  offset: number;
  bytes: number;
  log2Min?: number;
  log2Step?: number;
}

export interface CacheManifest {
  format: typeof CACHE_FORMAT;
  slug: CachedSlug;
  target: Target;
  grid: Grid;
  exposures: Exposure[];
  gaia: GaiaStar[];
  wise: WiseSource[];
  builtAt: string;
  layout: {
    w: number;
    h: number;
    nFrames: number;
    coverage: number[];
    arrays: ArrayInfo[];
  };
}

export type CacheInput = Omit<CachedTarget, 'frames'> & { frames: Frame[] };

export function encodeCache(
  input: CacheInput,
): { manifest: CacheManifest; manifestJson: string; bin: Uint8Array } {
  const { frames, exposures, grid } = input;
  const w = grid.w;
  const h = grid.h;
  const n = frames.length;
  const per = w * h;
  if (exposures.length !== n) {
    throw new SpherexError('BAD_INPUT', `exposures (${exposures.length}) and frames (${n}) differ in length`);
  }
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    if (f.exposure.id !== exposures[i].id) {
      throw new SpherexError('BAD_INPUT', `frame ${i} does not match exposure ${exposures[i].id}`);
    }
    if (exposures[i].wavelengthAtTarget === null) {
      throw new SpherexError('BAD_INPUT', `exposure ${exposures[i].id} has no wavelength`);
    }
    if (f.w !== w || f.h !== h || f.pixels.length !== per || f.variance.length !== per || f.flags.length !== per) {
      throw new SpherexError('BAD_INPUT', `frame ${i} does not match the grid size ${w}x${h}`);
    }
  }

  // Variance range from finite positive values.
  let lmin = Infinity;
  let lmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = frames[i].variance;
    for (let j = 0; j < per; j++) {
      const x = v[j];
      if (x > 0 && x < Infinity) {
        const l = Math.log2(x);
        if (l < lmin) lmin = l;
        if (l > lmax) lmax = l;
      }
    }
  }
  if (lmin === Infinity) { lmin = 0; lmax = 0; }
  const range = lmax - lmin;
  const log2Step = range > 0 ? range / VAR_CODES : 0.1;
  const log2Min = lmin;

  const total = n * per;
  const bin = new Uint8Array(total * 4);
  const dv = new DataView(bin.buffer);
  const pxOff = 0;
  const varOff = total * 2;
  const flagOff = total * 3;

  const coverage: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    coverage.push(f.coverage);
    const base = i * per;
    for (let j = 0; j < per; j++) {
      let p = f.pixels[j];
      if (p > HALF_MAX) p = HALF_MAX;
      else if (p < -HALF_MAX) p = -HALF_MAX;
      dv.setUint16(pxOff + (base + j) * 2, floatToHalf(p), true);

      const v = f.variance[j];
      let code = 0;
      if (v === v && v !== Infinity && v !== -Infinity) {
        if (v > 0) {
          code = Math.round((Math.log2(v) - log2Min) / log2Step) + 1;
          if (code < 1) code = 1;
          else if (code > 255) code = 255;
        } else {
          code = 1;
        }
      }
      bin[varOff + base + j] = code;
      bin[flagOff + base + j] = f.flags[j];
    }
  }

  const manifest: CacheManifest = {
    format: CACHE_FORMAT,
    slug: input.slug,
    target: input.target,
    grid: input.grid,
    exposures: input.exposures,
    gaia: input.gaia,
    wise: input.wise,
    builtAt: input.builtAt,
    layout: {
      w, h, nFrames: n, coverage,
      arrays: [
        { name: 'pixels', type: 'f16', offset: pxOff, bytes: total * 2 },
        { name: 'variance', type: 'u8log', offset: varOff, bytes: total, log2Min, log2Step },
        { name: 'flags', type: 'u8', offset: flagOff, bytes: total },
      ],
    },
  };
  return { manifest, manifestJson: JSON.stringify(manifest), bin };
}

function findArray(m: CacheManifest, name: string): ArrayInfo {
  const a = m.layout.arrays.find((x) => x.name === name);
  if (!a) throw new SpherexError('UPSTREAM_ERROR', `cache manifest has no '${name}' array`);
  return a;
}

export function decodeCache(manifest: CacheManifest, bin: Uint8Array): CachedTarget {
  if (!manifest || manifest.format !== CACHE_FORMAT) {
    throw new SpherexError('UPSTREAM_ERROR', 'unknown cache format');
  }
  const { w, h, nFrames, coverage } = manifest.layout;
  const per = w * h;
  const total = nFrames * per;
  const px = findArray(manifest, 'pixels');
  const va = findArray(manifest, 'variance');
  const fl = findArray(manifest, 'flags');
  if (px.bytes !== total * 2 || va.bytes !== total || fl.bytes !== total
    || px.offset + px.bytes > bin.length || va.offset + va.bytes > bin.length
    || fl.offset + fl.bytes > bin.length || manifest.exposures.length !== nFrames) {
    throw new SpherexError('UPSTREAM_ERROR', 'cache file is truncated or inconsistent');
  }
  const log2Min = va.log2Min ?? 0;
  const log2Step = va.log2Step ?? 0.1;
  const lut = new Float32Array(256);
  lut[0] = NaN;
  for (let k = 1; k < 256; k++) lut[k] = Math.pow(2, log2Min + (k - 1) * log2Step);

  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const frames: Frame[] = [];
  for (let i = 0; i < nFrames; i++) {
    const pixels = new Float32Array(per);
    const variance = new Float32Array(per);
    const flags = new Uint8Array(per);
    const base = i * per;
    for (let j = 0; j < per; j++) {
      let p = halfToFloat(dv.getUint16(px.offset + (base + j) * 2, true));
      let f = bin[fl.offset + base + j];
      if ((f & BAD_DATA_MASK) !== 0) p = NaN;
      else if (p !== p) f |= FLAG_BITS.NO_DATA;
      pixels[j] = p;
      flags[j] = f;
      variance[j] = lut[bin[va.offset + base + j]];
    }
    frames.push({
      exposure: manifest.exposures[i],
      grid: manifest.grid,
      bytes: 0,
      pixels, variance, flags, w, h,
      coverage: coverage[i],
    });
  }
  return {
    slug: manifest.slug,
    target: manifest.target,
    grid: manifest.grid,
    exposures: manifest.exposures,
    frames,
    gaia: manifest.gaia,
    wise: manifest.wise,
    builtAt: manifest.builtAt,
  };
}

export interface LoadCachedOptions extends CallOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError');
}

export async function loadCached(slug: CachedSlug, opts: LoadCachedOptions = {}): Promise<CachedTarget> {
  if (!CACHED.some((c) => c.slug === slug)) {
    throw new SpherexError('NOT_FOUND', `no cached target '${slug}'`);
  }
  let base = opts.baseUrl ?? '/cache/';
  if (!base.endsWith('/')) base += '/';
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const { signal, onProgress } = opts;

  const get = async (name: string): Promise<Response> => {
    let res: Response;
    try {
      res = await fetchFn(`${base}${slug}/${name}`, { signal });
    } catch (e) {
      if (isAbort(e, signal)) throw new SpherexError('ABORTED', 'cache load aborted', { cause: e });
      throw new SpherexError('UPSTREAM_ERROR', `could not fetch ${name}`, { cause: e });
    }
    if (res.status === 404) throw new SpherexError('NOT_FOUND', `cache file ${slug}/${name} not found`);
    if (!res.ok) throw new SpherexError('UPSTREAM_ERROR', `cache file ${slug}/${name}: HTTP ${res.status}`);
    return res;
  };

  try {
    onProgress?.({ stage: 'pixels', done: 0, total: 2, message: 'Reading cached target' });
    const mres = await get('manifest.json');
    let manifest: CacheManifest;
    try {
      manifest = (await mres.json()) as CacheManifest;
    } catch (e) {
      if (isAbort(e, signal)) throw new SpherexError('ABORTED', 'cache load aborted', { cause: e });
      throw new SpherexError('UPSTREAM_ERROR', 'cache manifest is not valid JSON', { cause: e });
    }
    onProgress?.({ stage: 'pixels', done: 1, total: 2, message: 'Reading cached frames' });
    const bres = await get('frames.bin');
    const bin = new Uint8Array(await bres.arrayBuffer());
    onProgress?.({ stage: 'pixels', done: 2, total: 2, message: 'Cached frames ready' });
    return decodeCache(manifest, bin);
  } catch (e) {
    if (e instanceof SpherexError) throw e;
    if (isAbort(e, signal)) throw new SpherexError('ABORTED', 'cache load aborted', { cause: e });
    throw new SpherexError('UPSTREAM_ERROR', 'cache load failed', { cause: e });
  }
}

const CACHED: { slug: CachedSlug; name: string; blurb: string }[] = [
  { slug: 'barnards-star', name: "Barnard's Star", blurb: 'Red dwarf about 6 light years away with the largest known proper motion of any star.' },
  { slug: 'eps-indi-b', name: 'Epsilon Indi B', blurb: 'Nearby brown dwarf, one of a close pair (Ba and Bb) orbiting the star Epsilon Indi A.' },
  { slug: 'wise-0855', name: 'WISE 0855-0714', blurb: 'Coldest known brown dwarf (roughly 250 to 285 K), a near neighbour of the Sun that is very faint in the infrared.' },
  { slug: 'rw-aur', name: 'RW Aurigae', blurb: 'Young, variable star with a circumstellar disk, in the Taurus-Auriga star-forming region.' },
  { slug: 'r-dra', name: 'R Draconis', blurb: 'Mira variable: a pulsating red giant whose brightness changes by several magnitudes over about 245 days.' },
];

export function listCached(): { slug: CachedSlug; name: string; blurb: string }[] {
  return CACHED.map((c) => ({ ...c }));
}
