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
  pairs: PairReadout[];
}

export interface CachedReadouts {
  format: typeof READOUTS_FORMAT;
  slug: CachedSlug;
  detector: Detector;
  builtAt: string;
  visits: ReadoutVisit[];
  /** The target first, then Gaia stars brightest first. */
  stars: StarReadout[];
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
  emit('Readouts ready', bytes);
  return out;
}
