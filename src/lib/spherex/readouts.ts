// Per-star matched readouts of the cached targets ("Has it changed between visits?", docs/algorithm.md).
//
// scripts/build-readouts.ts measures the target star and up to 40 Gaia stars of each cached
// target on the default detector, runs compareVisits for every pair of visits, and stores the
// trimmed result as public/cache/<slug>/readouts.d<N>.<8 hex>.json (8 hex = FNV-1a 32 of the file
// bytes, so the file can be served immutable). index.json names it in a top-level `readouts` entry:
//   { file, bytes, detector, count }       count = number of (star, visit pair) results in the file.
// loadCachedReadouts reads index.json, then that file. It uses the same baseUrl / fetchFn /
// signal / onProgress options as the cache loaders in cache.ts.
//
// File layout (format 'wp-readouts-1'): see the CachedReadouts interface below. Numbers are rounded
// (4 significant figures for fluxes, differences and errors, 3 decimals for z, 4 for wavelengths);
// NaN is stored as null.
import { listCached } from './cache';
import { SpherexError } from './types';
import type { CachedSlug, CallOptions, Detector } from './types';
import type { Verdict, MatchedFlag } from './matched';

export const READOUTS_FORMAT = 'wp-readouts-1';

/** The `readouts` entry of index.json. */
export interface ReadoutsRef {
  file: string;
  bytes: number;
  detector: Detector;
  /** Number of (star, visit pair) results in the file. */
  count: number;
}

/** One visit of the detector that took part (in-stack exposures only). */
export interface ReadoutVisit {
  visit: number;
  /** Mid time of the visit's exposures, (first + last) / 2, MJD. */
  mjd: number;
  /** In-stack exposures of this visit on the detector (before any star's rejections). */
  n: number;
}

/** One selected evaluation wavelength of a pair: [w0 um, D, sigma, z]. D and sigma in MJy/sr summed over native pixels, D = F_A - F_B. */
export type WavelengthReadout = [w0: number, D: number | null, sigma: number | null, z: number | null];

/** Combined value over the used w0 (steps 5 and 6). frac = D / mean flux. */
export interface CombinedReadout {
  D: number | null;
  sigma: number | null;
  z: number | null;
  frac: number | null;
}

export interface PairedStackReadout extends CombinedReadout {
  /** Number of exposure pairs. */
  n: number;
}

/** The result for one star and one visit pair (visit a earlier, b later). */
export interface PairReadout {
  /** Visit indices (see CachedReadouts.visits). */
  a: number;
  b: number;
  /** Mid times of the two visits, MJD. */
  tA: number;
  tB: number;
  /** Accepted exposures of the star in visit a and b. */
  nA: number;
  nB: number;
  /** Selected, non-skipped wavelengths (the matched result). */
  w: WavelengthReadout[];
  /** Wavelengths skipped (too few samples or no bracket). */
  nSkipped: number;
  /** Matched combined result; all null when verdict is 'no result'. */
  D: number | null;
  sigma: number | null;
  z: number | null;
  frac: number | null;
  /** Plain best pair, combined over the same wavelengths; null with no result. */
  plain: CombinedReadout | null;
  /** Paired stack (n 0 and null values when nothing pairs). */
  ps: PairedStackReadout;
  flags: MatchedFlag[];
  verdict: Verdict;
  /** False when the result should be shown with a warning, see readoutReliability. */
  reliable: boolean;
  /** Short plain reasons, empty when reliable. */
  unreliableReasons: string[];
}

/** One measured star. Pairs only holds visit pairs where both visits have at least 8 accepted exposures. */
export interface StarReadout {
  /** Gaia DR3 source id, or 'target' for the cached target when it has no Gaia match. */
  id: string;
  /** Position at the Gaia epoch 2016.0 (the target: its table position at its own epoch), degrees. */
  ra: number;
  dec: number;
  /** Gaia G magnitude, null when unknown. */
  gmag: number | null;
  isTarget: boolean;
  /** A Gaia source with G < BRIGHT_NEIGHBOUR_GMAG lies within BRIGHT_NEIGHBOUR_ARCSEC (absent in old files = false). */
  brightNeighbour?: boolean;
  /**
   * Gaia DR3 phot_variable_flag: true when catalogued 'VARIABLE', false for 'NOT_AVAILABLE', null
   * when unknown (no Gaia id or no answer). Information only, not a reliability reason.
   */
  variable: boolean | null;
  pairs: PairReadout[];
}

/** Field-star check of one visit pair, see fieldPairsOf. */
export interface FieldPairReadout {
  /** Visit indices (a earlier). */
  a: number;
  b: number;
  /** Fraction of the field stars' results for this pair with verdict 'changed' (0 when nField is 0). */
  fieldChangedFraction: number;
  /** fieldChangedFraction <= FIELD_CHANGED_LIMIT. */
  fieldReliable: boolean;
  /** Field-star results counted: non-target stars with a verdict other than 'no result'. */
  nField: number;
}

export interface CachedReadouts {
  format: typeof READOUTS_FORMAT;
  slug: CachedSlug;
  detector: Detector;
  builtAt: string;
  visits: ReadoutVisit[];
  /** The target first, then Gaia stars brightest first. */
  stars: StarReadout[];
  /** One entry per visit pair that has a result for any star (older files: computed on load). */
  fieldPairs: FieldPairReadout[];
}

/**
 * Largest fraction of field stars allowed to read 'changed' in one visit pair. The science team
 * measured about 1 percent false alarms on steady stars; over 10 percent changing means the pair
 * has a systematic offset (all stars shift together), as R Dra shows.
 */
export const FIELD_CHANGED_LIMIT = 0.10;

/** A Gaia source brighter than this (G < BRIGHT_NEIGHBOUR_GMAG) within BRIGHT_NEIGHBOUR_ARCSEC makes a star's result unreliable. */
export const BRIGHT_NEIGHBOUR_GMAG = 9;
export const BRIGHT_NEIGHBOUR_ARCSEC = 180;
/** A Gaia entry closer than this to the star is taken to be the star itself. */
const SAME_STAR_ARCSEC = 1;

export interface GaiaNeighbour { sourceId?: string; ra: number; dec: number; gmag: number | null }

function sepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d2r = Math.PI / 180;
  const p1 = dec1 * d2r, p2 = dec2 * d2r;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((ra2 - ra1) * d2r) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) * (180 / Math.PI) * 3600;
}

/**
 * True when a Gaia source with G < BRIGHT_NEIGHBOUR_GMAG lies within BRIGHT_NEIGHBOUR_ARCSEC of the
 * star. The star itself is excluded (same sourceId, or closer than 1 arcsec). Sources without a
 * magnitude never count.
 */
export function hasBrightNeighbour(
  star: { ra: number; dec: number; sourceId?: string }, gaia: readonly GaiaNeighbour[],
): boolean {
  for (const g of gaia) {
    if (g.gmag === null || !Number.isFinite(g.gmag) || !(g.gmag < BRIGHT_NEIGHBOUR_GMAG)) continue;
    if (star.sourceId !== undefined && g.sourceId === star.sourceId) continue;
    const d = sepArcsec(star.ra, star.dec, g.ra, g.dec);
    if (d < SAME_STAR_ARCSEC) continue;
    if (d <= BRIGHT_NEIGHBOUR_ARCSEC) return true;
  }
  return false;
}

/**
 * Reliability of one matched result. It is NOT reliable (reliable false) when any of:
 *  - flags include 'saturated', 'blended' or 'partial_visit';
 *  - ctx.brightNeighbour is true, or ctx.star and ctx.gaia are given and hasBrightNeighbour finds a
 *    Gaia source with G < 9 within 180 arcsec of the star (the star itself excluded);
 *  - fewer than 2 common wavelengths were used (perWavelengthCount < 2);
 *  - ctx.fieldReliable is false (a systematic offset in the visit pair).
 * Reasons are short plain-ASCII strings in this order: 'saturated', 'blended', 'partial_visit',
 * 'bright_neighbour', 'fewer than 2 wavelengths', 'field offset'.
 */
export function readoutReliability(
  flags: readonly MatchedFlag[], perWavelengthCount: number,
  ctx?: {
    fieldReliable?: boolean;
    star?: { ra: number; dec: number; sourceId?: string };
    gaia?: readonly GaiaNeighbour[];
    /** Precomputed hasBrightNeighbour of the star (used by the cached files). */
    brightNeighbour?: boolean;
  },
): { reliable: boolean; unreliableReasons: string[] } {
  const unreliableReasons: string[] = [];
  for (const f of ['saturated', 'blended', 'partial_visit'] as const) {
    if (flags.includes(f)) unreliableReasons.push(f);
  }
  const bright = ctx?.brightNeighbour ?? (ctx?.star && ctx.gaia ? hasBrightNeighbour(ctx.star, ctx.gaia) : false);
  if (bright) unreliableReasons.push('bright_neighbour');
  if (perWavelengthCount < 2) unreliableReasons.push('fewer than 2 wavelengths');
  if (ctx?.fieldReliable === false) unreliableReasons.push('field offset');
  return { reliable: unreliableReasons.length === 0, unreliableReasons };
}

/**
 * Per visit pair, the share of field stars (stars that are not the target) whose result is
 * 'changed'. Denominator: field results with a verdict other than 'no result'. With no such
 * result the fraction is 0 and the pair counts as reliable (nothing to judge by).
 */
export function fieldPairsOf(stars: readonly StarReadout[]): FieldPairReadout[] {
  const acc = new Map<string, { a: number; b: number; n: number; changed: number }>();
  for (const s of stars) {
    for (const p of s.pairs) {
      const key = `${p.a}:${p.b}`;
      let e = acc.get(key);
      if (!e) { e = { a: p.a, b: p.b, n: 0, changed: 0 }; acc.set(key, e); }
      if (s.isTarget || p.verdict === 'no result') continue;
      e.n++;
      if (p.verdict === 'changed') e.changed++;
    }
  }
  return [...acc.values()]
    .sort((x, y) => x.a - y.a || x.b - y.b)
    .map((e) => {
      const fieldChangedFraction = e.n > 0 ? Number((e.changed / e.n).toFixed(4)) : 0;
      return { a: e.a, b: e.b, fieldChangedFraction, fieldReliable: fieldChangedFraction <= FIELD_CHANGED_LIMIT, nField: e.n };
    });
}

/** Set reliable / unreliableReasons on every pair from the pair's flags, wavelengths and field context. */
export function applyReliability(stars: readonly StarReadout[], fieldPairs: readonly FieldPairReadout[]): void {
  const ctx = new Map(fieldPairs.map((f) => [`${f.a}:${f.b}`, f]));
  for (const s of stars) {
    for (const p of s.pairs) {
      Object.assign(p, readoutReliability(p.flags, p.w.length, {
        fieldReliable: ctx.get(`${p.a}:${p.b}`)?.fieldReliable, brightNeighbour: s.brightNeighbour === true,
      }));
    }
  }
}

export interface LoadReadoutsOptions extends CallOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError');
}

async function getJson<T>(
  fetchFn: typeof fetch, url: string, label: string, signal: AbortSignal | undefined, onBytes: (n: number) => void,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, { signal });
  } catch (e) {
    if (isAbort(e, signal)) throw new SpherexError('ABORTED', 'readouts load aborted', { cause: e });
    throw new SpherexError('UPSTREAM_ERROR', `could not fetch ${label}`, { cause: e });
  }
  if (res.status === 404) throw new SpherexError('NOT_FOUND', `cache file ${label} not found`);
  if (!res.ok) throw new SpherexError('UPSTREAM_ERROR', `cache file ${label}: HTTP ${res.status}`);
  try {
    const buf = new Uint8Array(await res.arrayBuffer());
    onBytes(buf.length);
    return JSON.parse(new TextDecoder().decode(buf)) as T;
  } catch (e) {
    if (isAbort(e, signal)) throw new SpherexError('ABORTED', 'readouts load aborted', { cause: e });
    throw new SpherexError('UPSTREAM_ERROR', `cache file ${label} is not valid JSON`, { cause: e });
  }
}

/**
 * Load the per-star matched readouts of a cached target (index.json, then the file it names).
 * Throws NOT_FOUND when the target is unknown, has no index, or the index has no `readouts` entry.
 */
export async function loadCachedReadouts(slug: CachedSlug, opts: LoadReadoutsOptions = {}): Promise<CachedReadouts> {
  if (!listCached().some((c) => c.slug === slug)) {
    throw new SpherexError('NOT_FOUND', `no cached target '${slug}'`);
  }
  let base = opts.baseUrl ?? '/cache/';
  if (!base.endsWith('/')) base += '/';
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  let bytes = 0;
  const emit = (message: string, total: number): void => {
    opts.onProgress?.({ stage: 'pixels', done: total > 0 ? Math.min(bytes, total) : bytes, total, message, bytes });
  };
  const onBytes = (n: number): void => { bytes += n; };

  emit('Reading cache index', 0);
  const idx = await getJson<{ readouts?: ReadoutsRef }>(fetchFn, `${base}${slug}/index.json`, `${slug}/index.json`, opts.signal, onBytes);
  const ref = idx.readouts;
  if (!ref || typeof ref.file !== 'string') {
    throw new SpherexError('NOT_FOUND', `cache ${slug} has no readouts`);
  }
  emit('Reading readouts', bytes + ref.bytes);
  const out = await getJson<CachedReadouts>(fetchFn, `${base}${slug}/${ref.file}`, `${slug}/${ref.file}`, opts.signal, onBytes);
  if (!out || out.format !== READOUTS_FORMAT || !Array.isArray(out.stars)) {
    throw new SpherexError('UPSTREAM_ERROR', `cache file ${slug}/${ref.file} is not a ${READOUTS_FORMAT} file`);
  }
  // files written before the reliability fields existed: compute them from the results
  for (const st of out.stars) if (st.variable === undefined) st.variable = null;
  if (!Array.isArray(out.fieldPairs)) out.fieldPairs = fieldPairsOf(out.stars);
  if (out.stars.some((st) => st.pairs.some((p) => typeof p.reliable !== 'boolean'))) applyReliability(out.stars, out.fieldPairs);
  emit('Readouts ready', bytes);
  return out;
}
