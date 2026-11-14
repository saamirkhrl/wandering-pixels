// Encoder for cache format 'wp-cache-2' (layout documented at the top of cache.ts).
// Pure: no Node APIs, so the build script and the tests share it. The returned `files` map holds
// the file names relative to public/cache/<slug>/ (index.json plus content-hashed files).

import type { Detector, Exposure, Frame, Movie, MovieFrame, PairedDifference } from './types';
import { SpherexError } from './types';
import { floatToHalf } from './f16';
import { buildMovie, summarize, pickBlinkPair, YEAR_PAIR_DAYS, HALF_YEAR_PAIR_DAYS, channelBandwidth, visitDifference } from './movie';
import { CACHE_FORMAT_2 } from './cache';
import type {
  ArrayInfo, CacheFileRef, CacheIndexV2, CacheInput, DifferenceMeta, ExposuresFile, MovieFrameMeta, PairMeta,
  Columns, StarsFile, VisitInfo,
} from './cache';
import type { GaiaStar } from './types';
import type { WiseSource } from './wise';

const HALF_MAX = 65504;
const VAR_CODES = 254;
const TOP_STARS = 150;

export const DEFAULT_DETECTOR_RULE =
  'detector 2; wise-0855 uses detector 6 (the longest-wavelength band, where a cold brown dwarf would be brightest); a target with no detector 2 data uses the detector with the most visits, then the most exposures';

export interface CacheInputV2 extends CacheInput {
  /** Free-form build info stored in index.json. */
  build?: Record<string, unknown>;
  /** Variance quantisation range to reuse (copies format 1 codes exactly). Default: from the data. */
  varianceRange?: { log2Min: number; log2Step: number };
  /** Override the default detector rule. */
  defaultDetector?: Detector;
}

/** FNV-1a 32 bit over bytes, 8 lower-case hex chars. */
export function fnv1a32(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function defaultDetectorFor(slug: string, exposures: Exposure[]): Detector {
  const by = new Map<Detector, { visits: Set<number>; count: number }>();
  for (const e of exposures) {
    let s = by.get(e.detector);
    if (!s) { s = { visits: new Set(), count: 0 }; by.set(e.detector, s); }
    s.visits.add(e.visitIndex);
    s.count++;
  }
  if (by.size === 0) throw new SpherexError('BAD_INPUT', 'no exposures');
  const wanted: Detector = slug === 'wise-0855' ? 6 : 2;
  if (by.has(wanted)) return wanted;
  let best: Detector | null = null;
  for (const d of [...by.keys()].sort((a, b) => a - b)) {
    const s = by.get(d)!;
    const b = best === null ? null : by.get(best)!;
    if (b === null || s.visits.size > b.visits.size || (s.visits.size === b.visits.size && s.count > b.count)) best = d;
  }
  return best as Detector;
}

// ---- array packing -----------------------------------------------------------------------------

interface Part { name: string; type: ArrayInfo['type']; data: Uint8Array; log2Min?: number; log2Step?: number }

function varianceRange(list: ArrayLike<number>[]): { log2Min: number; log2Step: number } {
  let lmin = Infinity;
  let lmax = -Infinity;
  for (const v of list) {
    for (let j = 0; j < v.length; j++) {
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
  return { log2Min: lmin, log2Step: range > 0 ? range / VAR_CODES : 0.1 };
}

function f16Part(name: string, list: ArrayLike<number>[]): Part {
  let n = 0;
  for (const a of list) n += a.length;
  const data = new Uint8Array(n * 2);
  const dv = new DataView(data.buffer);
  let o = 0;
  for (const a of list) {
    for (let j = 0; j < a.length; j++) {
      let p = a[j];
      if (p > HALF_MAX) p = HALF_MAX;
      else if (p < -HALF_MAX) p = -HALF_MAX;
      dv.setUint16(o, floatToHalf(p), true);
      o += 2;
    }
  }
  return { name, type: 'f16', data };
}

function u8logPart(name: string, list: ArrayLike<number>[], range: { log2Min: number; log2Step: number }): Part {
  let n = 0;
  for (const a of list) n += a.length;
  const data = new Uint8Array(n);
  let o = 0;
  for (const a of list) {
    for (let j = 0; j < a.length; j++) {
      const v = a[j];
      let code = 0;
      if (v === v && v !== Infinity && v !== -Infinity) {
        if (v > 0) {
          code = Math.round((Math.log2(v) - range.log2Min) / range.log2Step) + 1;
          if (code < 1) code = 1;
          else if (code > 255) code = 255;
        } else {
          code = 1;
        }
      }
      data[o++] = code;
    }
  }
  return { name, type: 'u8log', data, log2Min: range.log2Min, log2Step: range.log2Step };
}

function u8Part(name: string, list: Uint8Array[]): Part {
  let n = 0;
  for (const a of list) n += a.length;
  const data = new Uint8Array(n);
  let o = 0;
  for (const a of list) { data.set(a, o); o += a.length; }
  return { name, type: 'u8', data };
}

function pack(parts: Part[]): { bin: Uint8Array; arrays: ArrayInfo[] } {
  let total = 0;
  for (const p of parts) total += p.data.length;
  const bin = new Uint8Array(total);
  const arrays: ArrayInfo[] = [];
  let o = 0;
  for (const p of parts) {
    bin.set(p.data, o);
    const info: ArrayInfo = { name: p.name, type: p.type, offset: o, bytes: p.data.length };
    if (p.type === 'u8log') { info.log2Min = p.log2Min; info.log2Step = p.log2Step; }
    arrays.push(info);
    o += p.data.length;
  }
  return { bin, arrays };
}

// ---- helpers -----------------------------------------------------------------------------------

const nn = (x: number): number | null => (Number.isFinite(x) ? x : null);
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const r3 = (x: number): number => Math.round(x * 1e3) / 1e3;
const r2 = (x: number): number => Math.round(x * 1e2) / 1e2;

const enc = new TextEncoder();

function bandwidthOf(e: Exposure): number {
  const bw = e.bandwidthAtTarget;
  if (bw !== null && Number.isFinite(bw)) return bw;
  return channelBandwidth(e.detector, e.wavelengthAtTarget as number);
}

function isMatched(a: Exposure, b: Exposure): boolean {
  const wa = a.wavelengthAtTarget;
  const wb = b.wavelengthAtTarget;
  if (wa === null || wb === null || !Number.isFinite(wa) || !Number.isFinite(wb)) return false;
  return Math.abs(wa - wb) < (bandwidthOf(a) + bandwidthOf(b)) / 2;
}

function movieMeta(m: MovieFrame, saturated: { x: number; y: number; npix: number }[]): MovieFrameMeta {
  const meta: MovieFrameMeta = {
    grid: m.grid, w: m.w, h: m.h, visitIndex: m.visitIndex, detector: m.detector, time: m.time, mjd: m.mjd,
    wavelength: m.wavelength, wavelengthMin: nn(m.wavelengthMin), wavelengthMax: nn(m.wavelengthMax),
    nExposures: m.nExposures, exposureIds: m.exposureIds, targetXY: m.targetXY,
    backgroundLevel: m.backgroundLevel,
    saturated: saturated.map((s) => ({ x: r2(s.x), y: r2(s.y), npix: s.npix })),
  };
  if (m.backgroundFallback !== undefined) meta.backgroundFallback = m.backgroundFallback;
  return meta;
}

function visitsOf(exposures: Exposure[]): VisitInfo[] {
  const m = new Map<number, VisitInfo>();
  for (const e of exposures) {
    let v = m.get(e.visitIndex);
    if (!v) { v = { visitIndex: e.visitIndex, mjdStart: e.mjd, mjdEnd: e.mjd, countByDetector: {} }; m.set(e.visitIndex, v); }
    v.mjdStart = Math.min(v.mjdStart, e.mjd);
    v.mjdEnd = Math.max(v.mjdEnd, e.mjd);
    v.countByDetector[e.detector] = (v.countByDetector[e.detector] ?? 0) + 1;
    if (e.inStack === false) {
      v.outOfStackByDetector ??= {};
      v.outOfStackByDetector[e.detector] = (v.outOfStackByDetector[e.detector] ?? 0) + 1;
    }
  }
  return [...m.values()].sort((a, b) => a.visitIndex - b.visitIndex);
}

/** Columnar form when all rows share the same keys and hold only strings, numbers or null. */
function toColumns<T extends object>(rows: T[]): Columns | T[] {
  if (rows.length === 0) return rows;
  const keys = Object.keys(rows[0]);
  const cols: Columns = {};
  for (const k of keys) cols[k] = [];
  for (const r of rows) {
    const rk = Object.keys(r);
    if (rk.length !== keys.length || rk.some((k, i) => k !== keys[i])) return rows;
    for (const k of keys) {
      const v = (r as Record<string, unknown>)[k];
      if (v !== null && typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) return rows;
      cols[k].push(v as string | number | null);
    }
  }
  return cols;
}

const WISE_NEAR = 20;

function starsFiles(gaia: GaiaStar[], wise: WiseSource[], target: { ra: number; dec: number }): { first: StarsFile; full: StarsFile | null } {
  const g = gaia
    .map((s) => ({
      sourceId: s.sourceId,
      ra: r6(s.ra), dec: r6(s.dec),
      pmra: s.pmra === null ? null : r3(s.pmra),
      pmdec: s.pmdec === null ? null : r3(s.pmdec),
      parallax: s.parallax === null ? null : r3(s.parallax),
      gmag: Number.isFinite(s.gmag) ? r2(s.gmag) : (null as unknown as number),
    }))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ka = a.s.gmag === null ? Infinity : a.s.gmag;
      const kb = b.s.gmag === null ? Infinity : b.s.gmag;
      return ka - kb || a.i - b.i;
    })
    .map((x) => x.s);
  const top = Math.min(TOP_STARS, g.length);
  // First-view wise subset: the brightest in w1mag plus the sources nearest the target.
  let wiseFirst = wise;
  if (wise.length > TOP_STARS + WISE_NEAR) {
    const keep = new Set<number>();
    const mag = (r: WiseSource): number => (typeof r.w1mag === 'number' && Number.isFinite(r.w1mag) ? r.w1mag : Infinity);
    const c = Math.cos((target.dec * Math.PI) / 180);
    const dist = (r: WiseSource): number => Math.hypot((r.ra - target.ra) * c, r.dec - target.dec);
    wise.map((r, i) => ({ i, m: mag(r) })).sort((a, b) => a.m - b.m || a.i - b.i).slice(0, TOP_STARS).forEach((x) => keep.add(x.i));
    wise.map((r, i) => ({ i, d: dist(r) })).sort((a, b) => a.d - b.d || a.i - b.i).slice(0, WISE_NEAR).forEach((x) => keep.add(x.i));
    wiseFirst = wise.filter((_, i) => keep.has(i));
  }
  const truncated = g.length > top || wiseFirst.length < wise.length;
  const first: StarsFile = { gaia: toColumns(g.slice(0, top)), wise: toColumns(wiseFirst), top };
  const full: StarsFile | null = truncated ? { gaia: toColumns(g), wise: toColumns(wise), top } : null;
  return { first, full };
}

function rowCount(x: Columns | unknown[]): number {
  if (Array.isArray(x)) return x.length;
  const k = Object.keys(x)[0];
  return k === undefined ? 0 : x[k].length;
}

function hashedName(prefix: string, content: Uint8Array | string, ext: string): { name: string; bytes: Uint8Array } {
  const bytes = typeof content === 'string' ? enc.encode(content) : content;
  return { name: `${prefix}.${fnv1a32(bytes)}.${ext}`, bytes };
}

// ---- encoder -----------------------------------------------------------------------------------

export function encodeCacheV2(input: CacheInputV2): { files: Record<string, Uint8Array | string>; index: CacheIndexV2 } {
  const { frames, exposures, grid } = input;
  const w = grid.w;
  const h = grid.h;
  const per = w * h;
  if (exposures.length !== frames.length) {
    throw new SpherexError('BAD_INPUT', `exposures (${exposures.length}) and frames (${frames.length}) differ in length`);
  }
  if (frames.length === 0) throw new SpherexError('BAD_INPUT', 'no frames');
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.exposure.id !== exposures[i].id) throw new SpherexError('BAD_INPUT', `frame ${i} does not match exposure ${exposures[i].id}`);
    if (exposures[i].wavelengthAtTarget === null) throw new SpherexError('BAD_INPUT', `exposure ${exposures[i].id} has no wavelength`);
    if (f.w !== w || f.h !== h || f.pixels.length !== per || f.variance.length !== per || f.flags.length !== per) {
      throw new SpherexError('BAD_INPUT', `frame ${i} does not match the grid size ${w}x${h}`);
    }
  }
  const sorted = [...frames].sort((a, b) => a.exposure.mjd - b.exposure.mjd || (a.exposure.id < b.exposure.id ? -1 : a.exposure.id > b.exposure.id ? 1 : 0));
  const range = input.varianceRange ?? varianceRange(sorted.map((f) => f.variance));

  const files: Record<string, Uint8Array | string> = {};

  // Per-detector files.
  const dets = [...new Set(sorted.map((f) => f.exposure.detector))].sort((a, b) => a - b);
  const detectorFiles: CacheIndexV2['detectorFiles'] = [];
  for (const d of dets) {
    const fs = sorted.filter((f) => f.exposure.detector === d);
    const packed = pack([
      f16Part('pixels', fs.map((f) => f.pixels)),
      u8logPart('variance', fs.map((f) => f.variance), range),
      u8Part('flags', fs.map((f) => f.flags)),
    ]);
    const exJson: ExposuresFile = { detector: d, exposures: fs.map((f) => f.exposure), coverage: fs.map((f) => f.coverage) };
    const fb = hashedName(`frames.d${d}`, packed.bin, 'bin');
    const eb = hashedName(`exposures.d${d}`, JSON.stringify(exJson), 'json');
    files[fb.name] = fb.bytes;
    files[eb.name] = JSON.stringify(exJson);
    detectorFiles.push({
      detector: d, nFrames: fs.length,
      exposures: { file: eb.name, bytes: eb.bytes.length },
      frames: { file: fb.name, bytes: fb.bytes.length, arrays: packed.arrays },
    });
  }

  // Preview.
  const defaultDetector = input.defaultDetector ?? defaultDetectorFor(input.slug, sorted.map((f) => f.exposure));
  const movie: Movie = buildMovie(sorted, 'visit-stack', defaultDetector, input.target);
  const byId = new Map<string, Frame>(sorted.map((f) => [f.exposure.id, f]));
  const movieFrames: MovieFrameMeta[] = movie.frames.map((m) => movieMeta(m, m.saturated ?? []));
  const parts: Part[] = [
    f16Part('movie.pixels', movie.frames.map((m) => m.pixels)),
    u8logPart('movie.variance', movie.frames.map((m) => m.variance), varianceRange(movie.frames.map((m) => m.variance))),
  ];

  const detExposures = sorted.map((f) => f.exposure).filter((e) => e.detector === defaultDetector);
  const pairMetas: { year: PairMeta | null; halfYear: PairMeta | null } = { year: null, halfYear: null };
  const addPair = (key: 'year' | 'halfYear', days: [number, number]): void => {
    const p = pickBlinkPair(detExposures, defaultDetector, { gapDays: days });
    if (!p) return;
    const fa = byId.get(p[0].id) as Frame;
    const fb = byId.get(p[1].id) as Frame;
    pairMetas[key] = {
      exposures: [p[0], p[1]],
      coverage: [fa.coverage, fb.coverage],
      matched: isMatched(p[0], p[1]),
      gapDays: Math.abs(p[1].mjd - p[0].mjd),
    };
    parts.push(
      f16Part(`pair.${key}.pixels`, [fa.pixels, fb.pixels]),
      u8logPart(`pair.${key}.variance`, [fa.variance, fb.variance], range),
      u8Part(`pair.${key}.flags`, [fa.flags, fb.flags]),
    );
  };
  addPair('year', YEAR_PAIR_DAYS);
  addPair('halfYear', HALF_YEAR_PAIR_DAYS);

  // Visit differences of the default detector.
  const visitIdx = movie.frames.map((m) => m.visitIndex);
  const combos: [number, number][] = [];
  if (visitIdx.length <= 4) {
    for (let i = 0; i < visitIdx.length; i++) for (let j = i + 1; j < visitIdx.length; j++) combos.push([visitIdx[i], visitIdx[j]]);
  } else {
    for (let i = 0; i + 1 < visitIdx.length; i++) combos.push([visitIdx[i], visitIdx[i + 1]]);
    combos.push([visitIdx[0], visitIdx[visitIdx.length - 1]]);
  }
  const diffMetas: DifferenceMeta[] = [];
  for (const [a, b] of combos) {
    let d: PairedDifference;
    try {
      d = visitDifference(sorted, defaultDetector, a, b);
    } catch (e) {
      if (e instanceof SpherexError && /not implemented/.test(e.message)) throw e;
      continue; // a visit pair with no matched exposures has no difference image
    }
    const i = diffMetas.length;
    parts.push(
      f16Part(`diff.${i}.pixels`, [d.pixels]),
      u8logPart(`diff.${i}.variance`, [d.variance], varianceRange([d.variance])),
    );
    diffMetas.push({
      visitA: a, visitB: b, grid: d.grid, w: d.w, h: d.h,
      wavelengthA: d.wavelengthA, wavelengthB: d.wavelengthB, wavelengthMatched: d.wavelengthMatched,
      stretch: d.stretch, method: d.method, nPairs: d.nPairs, nUnpairedA: d.nUnpairedA, nUnpairedB: d.nUnpairedB,
      pairs: d.pairs,
    });
  }

  const packedPreview = pack(parts);
  const pv = hashedName('preview', packedPreview.bin, 'bin');
  files[pv.name] = pv.bytes;

  const ref = (n: { name: string; bytes: Uint8Array }): CacheFileRef => ({ file: n.name, bytes: n.bytes.length });
  const stars = starsFiles(input.gaia, input.wise, input.target);
  const starsJson = JSON.stringify(stars.first);
  const st = hashedName('stars', starsJson, 'json');
  files[st.name] = starsJson;
  let fullRef: CacheFileRef | null = null;
  if (stars.full) {
    const fj = JSON.stringify(stars.full);
    const fs = hashedName('stars-full', fj, 'json');
    files[fs.name] = fj;
    fullRef = ref(fs);
  }

  const index: CacheIndexV2 = {
    format: CACHE_FORMAT_2,
    slug: input.slug,
    target: input.target,
    grid: input.grid,
    builtAt: input.builtAt,
    build: input.build ?? {},
    defaultDetector,
    defaultDetectorRule: DEFAULT_DETECTOR_RULE,
    detectors: summarize(sorted.map((f) => f.exposure)),
    visits: visitsOf(sorted.map((f) => f.exposure)),
    stars: {
      ...ref(st), gaia: input.gaia.length, wise: input.wise.length, top: stars.first.top,
      gaiaShown: rowCount(stars.first.gaia), wiseShown: rowCount(stars.first.wise), full: fullRef,
    },
    preview: {
      ...ref(pv),
      arrays: packedPreview.arrays,
      movie: { mode: movie.mode, detector: movie.detector, grid: movie.grid, stretch: movie.stretch, frames: movieFrames },
      pairs: pairMetas,
      differences: diffMetas,
    },
    detectorFiles,
  };
  files['index.json'] = JSON.stringify(index);
  return { files, index };
}
