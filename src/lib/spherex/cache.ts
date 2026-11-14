// Precomputed target cache: encoders, decoders and browser loaders for two formats.
//
// ===== Format 'wp-cache-2' (current) =====
// Layout on the site, default baseUrl '/cache/', all on the site's own origin:
//   <slug>/index.json                      small, short cache (about 5 minutes)
//   <slug>/preview.<h>.bin                 first-view arrays (below)
//   <slug>/stars.<h>.json                  { gaia, wise, top }
//   <slug>/exposures.d<N>.<h>.json         { detector, exposures, coverage } for detector N
//   <slug>/frames.d<N>.<h>.bin             the frames of detector N
// <h> is 8 hex chars, FNV-1a 32 of the file bytes, so every file except index.json can be served
// immutable for a year. index.json lists the exact names and byte sizes.
//
// index.json (CacheIndexV2): format, slug, target, grid, builtAt, build (free-form build info; a
//   converted cache records convertedFrom and convertedAt), defaultDetector, defaultDetectorRule,
//   detectors (summarize()-style: detector, visits, count, outOfStack), visits (per visit over all
//   detectors: mjd range and counts by detector), stars {file, bytes, gaia, wise, top},
//   preview {file, bytes, arrays, movie, pairs, differences}, detectorFiles [{detector, nFrames,
//   exposures {file, bytes}, frames {file, bytes, arrays}}].
// Default detector rule: 2, except wise-0855 which gets 6 (the longest-wavelength band, where a cold brown dwarf would be brightest);
//   a target with no detector 2 data gets the detector with the most visits (then most exposures).
//
// preview.bin: planar arrays listed in index.preview.arrays (name, type, offset, bytes, and
//   log2Min/log2Step for u8log). Element order is frame-major then row-major, as below.
//   movie.pixels (f16), movie.variance (u8log): the prebuilt visit-stack Movie of the default
//     detector, buildMovie(frames, 'visit-stack', det, target) with library defaults (background
//     'median'). Everything else of Movie and MovieFrame is in index.preview.movie.
//   pair.year.* and pair.halfYear.* (pixels f16, variance u8log, flags u8), two Frames each: the
//     in-stack cross-visit pair with the smallest wavelength gap whose time gap lies in
//     YEAR_PAIR_DAYS / HALF_YEAR_PAIR_DAYS. Same quantisation as the detector files. null when no
//     pair qualifies. Exposures, coverage, matched and gapDays are in index.preview.pairs.
//   diff.<i>.pixels (f16), diff.<i>.variance (u8log, own range): visit differences of the default
//     detector (all visit pairs when there are 4 visits or fewer, else consecutive visits plus
//     first-last). scatter and scatterUnits are computed on decode (see decodePreview).
// stars.json: gaia sorted brightest first (gmag ascending, NaN last) and rounded (ra, dec 1e-6 deg;
//   pm and parallax 1e-3 mas; gmag 0.01; NaN gmag is stored as null and restored on load); wise is
//   untouched; wise keeps its catalogue order. Both lists are columnar ({sourceId: [...], ra: [...], ...}) when every row has the
//   same keys with plain values, else plain rows; the loader rebuilds the row objects.
//   When a list is longer than the first view needs, stars.json holds a subset (gaia: the 150
//   brightest; wise: the 150 brightest in w1mag plus the 20 nearest the target) and the whole
//   lists are in stars-full.<h>.json (same shape), named in index.stars.full. loadCachedPreview
//   returns the subset; loadCached and loadCachedStars return the full lists. top = number of leading gaia entries that make up the 150 brightest (the whole list
//   when shorter), so a first view can draw gaia.slice(0, top).
// frames.d<N>.bin: exactly the per-frame layout of format 1 for the frames of one detector in
//   mjd order (see below): pixels f16, variance u8log with one log2Min/log2Step per file, flags u8.
//   Converting from format 1 copies the codes, so decoded frames equal format 1 exactly.
// exposures.d<N>.json: the detector's exposures in the same order, plus per-frame coverage.
// Loaders: loadCachedPreview (index + preview + stars), loadCachedDetector, loadCached (everything;
//   frames ordered by detector then mjd; falls back to format 1 when index.json is absent).
//   Progress.done and total are bytes (total 0 while unknown) and bytes is the running total.
//
// ===== Format 'wp-cache-1' (still readable) =====
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
  CachedSlug, CachedTarget, CallOptions, Detector, Exposure, Frame, GaiaStar, Grid, Movie, MovieFrame,
  PairedDifference, Target,
} from './types';
import { BAD_DATA_MASK, FLAG_BITS, SpherexError } from './types';
import { floatToHalf, halfToFloat } from './f16';
import { movieFrameExclusion, differenceScatter, clippedDifferenceScatter } from './movie';
import type { WiseSource } from './wise';

export const CACHE_FORMAT = 'wp-cache-1';
export const CACHE_FORMAT_2 = 'wp-cache-2';
const HALF_MAX = 65504;
const VAR_CODES = 254; // codes 1..255 -> 254 steps between code 1 and code 255

export interface ArrayInfo {
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
  const frames = readFrames(bin, px, va, fl, nFrames, w, h, manifest.exposures, coverage, manifest.grid);
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

// ---- shared decoding helpers -------------------------------------------------------------------

function varianceLut(log2Min: number, log2Step: number): Float32Array {
  const lut = new Float32Array(256);
  lut[0] = NaN;
  for (let k = 1; k < 256; k++) lut[k] = Math.pow(2, log2Min + (k - 1) * log2Step);
  return lut;
}

/** Frame-major planar decode shared by formats 1 and 2 (pixels f16, variance u8log, flags u8). */
function readFrames(
  bin: Uint8Array, px: ArrayInfo, va: ArrayInfo, fl: ArrayInfo, n: number, w: number, h: number,
  exposures: Exposure[], coverage: number[], grid: Grid,
): Frame[] {
  const per = w * h;
  const lut = varianceLut(va.log2Min ?? 0, va.log2Step ?? 0.1);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const frames: Frame[] = [];
  for (let i = 0; i < n; i++) {
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
      exposure: exposures[i], grid, bytes: 0, pixels, variance, flags, w, h, coverage: coverage[i],
    });
  }
  return frames;
}

/** Plain half-float array (no flag rules), elements [start, start + count). */
function readF16(bin: Uint8Array, a: ArrayInfo, start: number, count: number): Float32Array {
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = new Float32Array(count);
  for (let j = 0; j < count; j++) out[j] = halfToFloat(dv.getUint16(a.offset + (start + j) * 2, true));
  return out;
}

function readU8Log(bin: Uint8Array, a: ArrayInfo, start: number, count: number): Float32Array {
  const lut = varianceLut(a.log2Min ?? 0, a.log2Step ?? 0.1);
  const out = new Float32Array(count);
  for (let j = 0; j < count; j++) out[j] = lut[bin[a.offset + start + j]];
  return out;
}

function arr(arrays: ArrayInfo[], name: string): ArrayInfo {
  const a = arrays.find((x) => x.name === name);
  if (!a) throw new SpherexError('UPSTREAM_ERROR', `cache index has no '${name}' array`);
  return a;
}

function fitsIn(a: ArrayInfo, elems: number, bytesPer: number, len: number): boolean {
  return a.bytes === elems * bytesPer && a.offset >= 0 && a.offset + a.bytes <= len;
}

// ---- format 2 types ----------------------------------------------------------------------------

export interface CacheFileRef { file: string; bytes: number }

export type DetectorSummary = { detector: Detector; visits: number[]; count: number; outOfStack: number };

/** MovieFrame without its arrays; NaN is stored as null. */
export interface MovieFrameMeta {
  grid: Grid;
  w: number; h: number;
  visitIndex: number;
  detector: Detector;
  time: string; mjd: number;
  wavelength: number;
  wavelengthMin: number | null; wavelengthMax: number | null;
  nExposures: number;
  exposureIds: string[];
  targetXY: [number, number] | null;
  backgroundFallback?: boolean;
  backgroundLevel: number;
  saturated?: { x: number; y: number; npix: number }[];
}

export interface PairMeta {
  exposures: [Exposure, Exposure];
  coverage: [number, number];
  matched: boolean;
  gapDays: number;
}

export interface DifferenceMeta {
  visitA: number; visitB: number;
  grid: Grid;
  w: number; h: number;
  wavelengthA: number; wavelengthB: number;
  wavelengthMatched: boolean;
  stretch: { lo: number; hi: number };
  method: PairedDifference['method'];
  nPairs: number; nUnpairedA: number; nUnpairedB: number;
  pairs: PairedDifference['pairs'];
}

export interface VisitInfo {
  visitIndex: number;
  mjdStart: number; mjdEnd: number;
  countByDetector: Record<number, number>;
  outOfStackByDetector?: Record<number, number>;
}

export interface CacheIndexV2 {
  format: typeof CACHE_FORMAT_2;
  slug: CachedSlug;
  target: Target;
  grid: Grid;
  builtAt: string;
  build: Record<string, unknown>;
  defaultDetector: Detector;
  defaultDetectorRule: string;
  detectors: DetectorSummary[];
  visits: VisitInfo[];
  /** gaia and wise are the full counts; first-view counts are gaiaShown and wiseShown. full is present when stars.json holds only a subset. */
  stars: CacheFileRef & { gaia: number; wise: number; top: number; gaiaShown: number; wiseShown: number; full: CacheFileRef | null };
  preview: CacheFileRef & {
    arrays: ArrayInfo[];
    movie: { mode: Movie['mode']; detector: Detector; grid: Grid; stretch: { lo: number; hi: number }; frames: MovieFrameMeta[] };
    pairs: { year: PairMeta | null; halfYear: PairMeta | null };
    differences: DifferenceMeta[];
  };
  detectorFiles: {
    detector: Detector;
    nFrames: number;
    exposures: CacheFileRef;
    frames: CacheFileRef & { arrays: ArrayInfo[] };
  }[];
}

export interface PairEntry { frames: [Frame, Frame]; matched: boolean; gapDays: number }

export interface CachedPreview {
  slug: CachedSlug;
  target: Target;
  grid: Grid;
  builtAt: string;
  defaultDetector: Detector;
  defaultDetectorRule: string;
  movie: Movie;
  pairs: { year: PairEntry | null; halfYear: PairEntry | null };
  differences: { visitA: number; visitB: number; image: PairedDifference }[];
  visits: VisitInfo[];
  detectors: DetectorSummary[];
  gaia: GaiaStar[];
  wise: WiseSource[];
  /** Raw bytes. preview = index.json + preview.bin + stars.json; perDetector = exposures + frames files. */
  totalBytes: { preview: number; perDetector: Record<number, number> };
}

/** Rows stored as one array per key (columnar), or as plain rows when they are not uniform. */
export type Columns = Record<string, (string | number | null)[]>;
export interface StarsFile { gaia: Columns | GaiaStar[]; wise: Columns | WiseSource[]; top: number }

function fromColumns<T>(x: Columns | T[]): T[] {
  if (Array.isArray(x)) return x;
  const keys = Object.keys(x);
  const n = keys.length ? x[keys[0]].length : 0;
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const row: Record<string, string | number | null> = {};
    for (const k of keys) row[k] = x[k][i];
    out.push(row as unknown as T);
  }
  return out;
}
export interface ExposuresFile { detector: Detector; exposures: Exposure[]; coverage: number[] }

// ---- loaders -----------------------------------------------------------------------------------

export interface LoadCachedOptions extends CallOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError');
}

function assertSlug(slug: CachedSlug): void {
  if (!CACHED.some((c) => c.slug === slug)) {
    throw new SpherexError('NOT_FOUND', `no cached target '${slug}'`);
  }
}

function parseJson<T>(buf: Uint8Array, name: string, signal?: AbortSignal): T {
  try {
    return JSON.parse(new TextDecoder().decode(buf)) as T;
  } catch (e) {
    if (isAbort(e, signal)) throw new SpherexError('ABORTED', 'cache load aborted', { cause: e });
    throw new SpherexError('UPSTREAM_ERROR', `cache file ${name} is not valid JSON`, { cause: e });
  }
}

/** Fetch helpers bound to one load: URL building, error mapping, streamed reads, byte progress. */
class Session {
  readonly base: string;
  readonly fetchFn: typeof fetch;
  readonly signal?: AbortSignal;
  bytes = 0;
  total = 0; // expected bytes, 0 = not known yet
  private readonly onProgress?: CallOptions['onProgress'];
  constructor(readonly slug: CachedSlug, opts: LoadCachedOptions) {
    let base = opts.baseUrl ?? '/cache/';
    if (!base.endsWith('/')) base += '/';
    this.base = base;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.signal = opts.signal;
    this.onProgress = opts.onProgress;
  }

  emit(message: string): void {
    this.onProgress?.({
      stage: 'pixels',
      done: this.total > 0 ? Math.min(this.bytes, this.total) : this.bytes,
      total: this.total,
      message,
      bytes: this.bytes,
    });
  }

  /** Response, or null for a 404 when allowMissing. */
  async request(name: string, allowMissing = false): Promise<Response | null> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${this.slug}/${name}`, { signal: this.signal });
    } catch (e) {
      if (isAbort(e, this.signal)) throw new SpherexError('ABORTED', 'cache load aborted', { cause: e });
      throw new SpherexError('UPSTREAM_ERROR', `could not fetch ${name}`, { cause: e });
    }
    if (res.status === 404) {
      if (allowMissing) return null;
      throw new SpherexError('NOT_FOUND', `cache file ${this.slug}/${name} not found`);
    }
    if (!res.ok) throw new SpherexError('UPSTREAM_ERROR', `cache file ${this.slug}/${name}: HTTP ${res.status}`);
    return res;
  }

  /** Read the whole body, counting bytes as they arrive when the body is streamable. */
  async read(res: Response, message: string): Promise<Uint8Array> {
    try {
      const reader = res.body?.getReader?.();
      if (!reader) {
        const buf = new Uint8Array(await res.arrayBuffer());
        this.bytes += buf.length;
        this.emit(message);
        return buf;
      }
      const chunks: Uint8Array[] = [];
      let len = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        len += value.length;
        this.bytes += value.length;
        this.emit(message);
      }
      const out = new Uint8Array(len);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    } catch (e) {
      if (e instanceof SpherexError) throw e;
      if (isAbort(e, this.signal)) throw new SpherexError('ABORTED', 'cache load aborted', { cause: e });
      throw new SpherexError('UPSTREAM_ERROR', 'cache download failed', { cause: e });
    }
  }

  async bin(name: string, message: string): Promise<Uint8Array> {
    const res = (await this.request(name)) as Response;
    return this.read(res, message);
  }

  async json<T>(name: string, message: string): Promise<T> {
    return parseJson<T>(await this.bin(name, message), name, this.signal);
  }

  /** index.json, or null when the target has no format 2 files (404, not JSON, other format). */
  async index(): Promise<CacheIndexV2 | null> {
    this.emit('Reading cache index');
    const res = await this.request('index.json', true);
    if (!res) return null;
    const buf = await this.read(res, 'Reading cache index');
    let idx: CacheIndexV2;
    try {
      idx = JSON.parse(new TextDecoder().decode(buf)) as CacheIndexV2;
    } catch {
      return null; // a dev server may answer a missing file with its HTML shell
    }
    if (!idx || idx.format !== CACHE_FORMAT_2) return null;
    return idx;
  }
}

function wrapLoad<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return fn().catch((e) => {
    if (e instanceof SpherexError) throw e;
    if (isAbort(e, signal)) throw new SpherexError('ABORTED', 'cache load aborted', { cause: e });
    throw new SpherexError('UPSTREAM_ERROR', 'cache load failed', { cause: e });
  });
}

const orNaN = (x: number | null | undefined): number => (x === null || x === undefined ? NaN : x);

function normGaia(g: GaiaStar[]): GaiaStar[] {
  return g.map((s) => ({ ...s, gmag: orNaN(s.gmag as number | null) }));
}

function decodePair(
  meta: PairMeta | null, arrays: ArrayInfo[], key: string, bin: Uint8Array, grid: Grid, w: number, h: number,
): PairEntry | null {
  if (!meta) return null;
  const per = w * h;
  const px = arr(arrays, `pair.${key}.pixels`);
  const va = arr(arrays, `pair.${key}.variance`);
  const fl = arr(arrays, `pair.${key}.flags`);
  if (!fitsIn(px, 2 * per, 2, bin.length) || !fitsIn(va, 2 * per, 1, bin.length) || !fitsIn(fl, 2 * per, 1, bin.length)) {
    throw new SpherexError('UPSTREAM_ERROR', 'cache preview is truncated or inconsistent');
  }
  const frames = readFrames(bin, px, va, fl, 2, w, h, meta.exposures, meta.coverage, grid);
  return { frames: [frames[0], frames[1]], matched: meta.matched, gapDays: meta.gapDays };
}

function decodePreview(idx: CacheIndexV2, bin: Uint8Array, stars: StarsFile): CachedPreview {
  const p = idx.preview;
  const { w, h } = idx.grid;
  const per = w * h;
  if (bin.length !== p.bytes) throw new SpherexError('UPSTREAM_ERROR', 'cache preview is truncated or inconsistent');
  const nm = p.movie.frames.length;
  const mpx = arr(p.arrays, 'movie.pixels');
  const mva = arr(p.arrays, 'movie.variance');
  if (!fitsIn(mpx, nm * per, 2, bin.length) || !fitsIn(mva, nm * per, 1, bin.length)) {
    throw new SpherexError('UPSTREAM_ERROR', 'cache preview is truncated or inconsistent');
  }
  const frames: MovieFrame[] = p.movie.frames.map((m, i) => ({
    ...m,
    wavelengthMin: orNaN(m.wavelengthMin),
    wavelengthMax: orNaN(m.wavelengthMax),
    pixels: readF16(bin, mpx, i * per, per),
    variance: readU8Log(bin, mva, i * per, per),
  }));
  const movie: Movie = { mode: p.movie.mode, detector: p.movie.detector, grid: p.movie.grid, frames, stretch: p.movie.stretch };

  const differences = p.differences.map((d, i) => {
    const dpx = arr(p.arrays, `diff.${i}.pixels`);
    const dva = arr(p.arrays, `diff.${i}.variance`);
    const n = d.w * d.h;
    if (!fitsIn(dpx, n, 2, bin.length) || !fitsIn(dva, n, 1, bin.length)) {
      throw new SpherexError('UPSTREAM_ERROR', 'cache preview is truncated or inconsistent');
    }
    const pixels = readF16(bin, dpx, 0, n);
    const variance = readU8Log(bin, dva, 0, n);
    // Scatter at decode time (no rebuild): exclusion zones from the visit stacks of the two visits
    // when both are in the preview movie, else a sigma-clipped MAD of the difference image alone.
    const sa = movie.frames.find((f) => f.visitIndex === d.visitA && f.w === d.w && f.h === d.h);
    const sb = movie.frames.find((f) => f.visitIndex === d.visitB && f.w === d.w && f.h === d.h);
    let sc: { scatter: number; scatterUnits: Float32Array };
    if (sa && sb) {
      const ma = movieFrameExclusion(sa);
      const mb = movieFrameExclusion(sb);
      const mask = new Uint8Array(n);
      for (let j = 0; j < n; j++) mask[j] = (ma && ma[j]) || (mb && mb[j]) ? 1 : 0;
      sc = differenceScatter(pixels, d.w, d.h, mask);
    } else sc = clippedDifferenceScatter(pixels, d.w, d.h);
    const image: PairedDifference = {
      grid: d.grid, pixels, variance, scatter: sc.scatter, scatterUnits: sc.scatterUnits, w: d.w, h: d.h,
      wavelengthA: d.wavelengthA, wavelengthB: d.wavelengthB, wavelengthMatched: d.wavelengthMatched,
      stretch: d.stretch, method: 'paired-stack',
      nPairs: d.nPairs, nUnpairedA: d.nUnpairedA, nUnpairedB: d.nUnpairedB, pairs: d.pairs,
    };
    return { visitA: d.visitA, visitB: d.visitB, image };
  });

  const perDetector: Record<number, number> = {};
  for (const f of idx.detectorFiles) perDetector[f.detector] = f.exposures.bytes + f.frames.bytes;
  return {
    slug: idx.slug, target: idx.target, grid: idx.grid, builtAt: idx.builtAt,
    defaultDetector: idx.defaultDetector, defaultDetectorRule: idx.defaultDetectorRule,
    movie,
    pairs: {
      year: decodePair(p.pairs.year, p.arrays, 'year', bin, idx.grid, w, h),
      halfYear: decodePair(p.pairs.halfYear, p.arrays, 'halfYear', bin, idx.grid, w, h),
    },
    differences,
    visits: idx.visits,
    detectors: idx.detectors,
    gaia: normGaia(fromColumns<GaiaStar>(stars.gaia)),
    wise: fromColumns<WiseSource>(stars.wise),
    totalBytes: { preview: 0, perDetector }, // preview is filled in by the loader (needs the index.json size)
  };
}

async function loadDetectorFiles(
  s: Session, idx: CacheIndexV2, detector: Detector,
): Promise<{ exposures: Exposure[]; frames: Frame[] }> {
  const ent = idx.detectorFiles.find((f) => f.detector === detector);
  if (!ent) throw new SpherexError('NOT_FOUND', `cache ${idx.slug} has no detector ${detector}`);
  const [ex, bin] = await Promise.all([
    s.json<ExposuresFile>(ent.exposures.file, `Reading detector ${detector} exposures`),
    s.bin(ent.frames.file, `Reading detector ${detector} frames`),
  ]);
  const { w, h } = idx.grid;
  const n = ent.nFrames;
  const px = arr(ent.frames.arrays, 'pixels');
  const va = arr(ent.frames.arrays, 'variance');
  const fl = arr(ent.frames.arrays, 'flags');
  const total = n * w * h;
  if (ex.exposures.length !== n || ex.coverage.length !== n || bin.length !== ent.frames.bytes
    || !fitsIn(px, total, 2, bin.length) || !fitsIn(va, total, 1, bin.length) || !fitsIn(fl, total, 1, bin.length)) {
    throw new SpherexError('UPSTREAM_ERROR', 'cache file is truncated or inconsistent');
  }
  return { exposures: ex.exposures, frames: readFrames(bin, px, va, fl, n, w, h, ex.exposures, ex.coverage, idx.grid) };
}

/**
 * First view of a target: index.json, then preview.bin and stars.json in parallel.
 * Progress: done and total are bytes (total is 0 until index.json is read); bytes is the running total.
 */
export async function loadCachedPreview(slug: CachedSlug, opts: LoadCachedOptions = {}): Promise<CachedPreview> {
  assertSlug(slug);
  const s = new Session(slug, opts);
  return wrapLoad(async () => {
    const idx = await s.index();
    if (!idx) throw new SpherexError('NOT_FOUND', `cache ${slug} has no ${CACHE_FORMAT_2} index`);
    const indexBytes = s.bytes;
    s.total = indexBytes + idx.preview.bytes + idx.stars.bytes;
    s.emit('Reading preview');
    const [bin, stars] = await Promise.all([
      s.bin(idx.preview.file, 'Reading preview'),
      s.json<StarsFile>(idx.stars.file, 'Reading stars'),
    ]);
    const out = decodePreview(idx, bin, stars);
    out.totalBytes.preview = s.total;
    s.emit('Preview ready');
    return out;
  }, opts.signal);
}

/** Full Gaia (brightest first) and WISE lists; the preview carries only a first-view subset when the lists are long. */
export async function loadCachedStars(
  slug: CachedSlug, opts: LoadCachedOptions = {},
): Promise<{ gaia: GaiaStar[]; wise: WiseSource[] }> {
  assertSlug(slug);
  const s = new Session(slug, opts);
  return wrapLoad(async () => {
    const idx = await s.index();
    if (!idx) throw new SpherexError('NOT_FOUND', `cache ${slug} has no ${CACHE_FORMAT_2} index`);
    const ref = idx.stars.full ?? idx.stars;
    s.total = s.bytes + ref.bytes;
    const st = await s.json<StarsFile>(ref.file, 'Reading stars');
    s.emit('Stars ready');
    return { gaia: normGaia(fromColumns<GaiaStar>(st.gaia)), wise: fromColumns<WiseSource>(st.wise) };
  }, opts.signal);
}

/** Exposures and frames of one detector. */
export async function loadCachedDetector(
  slug: CachedSlug, detector: Detector, opts: LoadCachedOptions = {},
): Promise<{ exposures: Exposure[]; frames: Frame[] }> {
  assertSlug(slug);
  const s = new Session(slug, opts);
  return wrapLoad(async () => {
    const idx = await s.index();
    if (!idx) throw new SpherexError('NOT_FOUND', `cache ${slug} has no ${CACHE_FORMAT_2} index`);
    const ent = idx.detectorFiles.find((f) => f.detector === detector);
    if (ent) s.total = s.bytes + ent.exposures.bytes + ent.frames.bytes;
    const r = await loadDetectorFiles(s, idx, detector);
    s.emit('Detector ready');
    return r;
  }, opts.signal);
}

/**
 * Whole target. Format 2 when index.json exists (frames ordered by detector, then mjd), otherwise
 * format 1 (manifest.json + frames.bin, mjd order).
 */
export async function loadCached(slug: CachedSlug, opts: LoadCachedOptions = {}): Promise<CachedTarget> {
  assertSlug(slug);
  const s = new Session(slug, opts);
  return wrapLoad(async () => {
    const idx = await s.index();
    if (idx) {
      s.total = s.bytes + (idx.stars.full ?? idx.stars).bytes
        + idx.detectorFiles.reduce((a, f) => a + f.exposures.bytes + f.frames.bytes, 0);
      s.emit('Reading cached target');
      const dets = [...idx.detectorFiles].sort((a, b) => a.detector - b.detector);
      const [stars, parts] = await Promise.all([
        s.json<StarsFile>((idx.stars.full ?? idx.stars).file, 'Reading stars'),
        Promise.all(dets.map((d) => loadDetectorFiles(s, idx, d.detector))),
      ]);
      const exposures: Exposure[] = [];
      const frames: Frame[] = [];
      for (const p of parts) { exposures.push(...p.exposures); frames.push(...p.frames); }
      s.emit('Cached frames ready');
      return {
        slug: idx.slug, target: idx.target, grid: idx.grid, exposures, frames,
        gaia: normGaia(fromColumns<GaiaStar>(stars.gaia)), wise: fromColumns<WiseSource>(stars.wise), builtAt: idx.builtAt,
      };
    }
    // Format 1 fallback.
    const progress = opts.onProgress;
    progress?.({ stage: 'pixels', done: 0, total: 2, message: 'Reading cached target', bytes: s.bytes });
    const manifest = await s.json<CacheManifest>('manifest.json', 'Reading cached target');
    progress?.({ stage: 'pixels', done: 1, total: 2, message: 'Reading cached frames', bytes: s.bytes });
    const bin = await s.bin('frames.bin', 'Reading cached frames');
    progress?.({ stage: 'pixels', done: 2, total: 2, message: 'Cached frames ready', bytes: s.bytes });
    return decodeCache(manifest, bin);
  }, opts.signal);
}

const CACHED: { slug: CachedSlug; name: string; blurb: string }[] = [
  { slug: 'barnards-star', name: "Barnard's Star", blurb: 'Red dwarf with the fastest proper motion of any star, 10.4 arcsec per year; its saturated core is masked and it moves about 1.7 px per year across the frame.' },
  { slug: 'eps-indi-b', name: 'Epsilon Indi B', blurb: 'Nearby pair of brown dwarfs (Ba and Bb, unresolved here) that is clearly visible and moves between visits.' },
  { slug: 'wise-0855', name: 'WISE 0855-0714', blurb: 'This very cold brown dwarf is too faint for single SPHEREx images and is not detected here; the faint source at the marker is a background star (Gaia DR3 5756956644387831296).' },
  { slug: 'rw-aur', name: 'RW Aurigae', blurb: 'Young variable star whose brightness changes between visits; it is not a fast mover.' },
  { slug: 'r-dra', name: 'R Draconis', blurb: 'R Draconis is a bright variable star in the continuously observed north deep field, and 300 of about 2500 exposures are cached. R Draconis itself is saturated, but nearby stars appear to brighten and fade together between visits, most strongly close to it, as its glow changes.' },
  { slug: 'v391-oph', name: 'V391 Ophiuchi', blurb: 'An eclipsing binary star near Barnard\'s Star on the sky whose brightness differs between visits because some exposures caught an eclipse; the change is within a visit, not a trend.' },
];

export function listCached(): { slug: CachedSlug; name: string; blurb: string }[] {
  return CACHED.map((c) => ({ ...c }));
}
