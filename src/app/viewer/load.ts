import {
  SpherexError,
  loadBestPair,
  loadFirstLook,
  findExposures,
  listCached,
  loadCachedPreview,
  loadFrames,
  makeGrid,
  resolveTarget,
  summarize,
} from '../data';
import type {
  CachedPreview,
  CachedSlug,
  CachedTarget,
  Detector,
  Exposure,
  ExposureUpdateStatus,
  Frame,
  Grid,
  Progress,
  Target,
} from '../data';

export interface LoadRequest {
  q: string | null;
  ra: number | null;
  dec: number | null;
  det: Detector | null;
  size: number | null;
}

export interface LoadCallbacks {
  onStage: (p: Progress) => void;
  // The archive list grew after the first answer; the exposures are the whole merged list.
  onUpdate?: (exposures: Exposure[], status: ExposureUpdateStatus) => void;
  // Keeps the archive asking alive when the load signal is replaced (a detector or size switch).
  archiveSignal?: AbortSignal;
  // The archive question is about to be asked / has just got its first answer.
  onSearching?: () => void;
  onFound?: () => void;
}

export interface DetInfo {
  detector: Detector;
  count: number;
  visits: number;
}

export interface LiveSearch {
  target: Target;
  exposures: Exposure[];
  available: DetInfo[];
}

export interface LiveContext {
  grid: Grid;
  rest: Exposure[];
  size: number;
  detExposures: Exposure[];
}

export const ONCE_ONLY = 'ONCE_ONLY';
export const FRAME_MB_ESTIMATE = 2.0;
export const AUTO_REST_LIMIT = 20;
export const DEFAULT_SIZE = 400;

export interface LoadResult {
  live: LiveContext | null;
  search: LiveSearch | null;
  cachedData: CachedTarget | null;
  // prepared sets: the small first-view bundle, plus which prepared target it is
  preview: CachedPreview | null;
  cachedSlug: CachedSlug | null;
  target: Target;
  frames: Frame[];
  det: Detector;
  available: DetInfo[];
  failed: number;
  total: number;
  cached: boolean;
  matched: boolean;
  // true when a prepared set was chosen because the query sits at a prepared target, not by its name
  viaPosition: boolean;
  // the position the visitor asked for, when it routed to a prepared set
  asked?: { ra: number; dec: number };
}

export const DET_BANDS: Record<Detector, [number, number]> = {
  1: [0.75, 1.09],
  2: [1.1, 1.62],
  3: [1.63, 2.42],
  4: [2.42, 3.82],
  5: [3.82, 4.42],
  6: [4.42, 5.0],
};

export const STAGE_WORDS: Record<Progress['stage'], string> = {
  resolve: 'Finding the star',
  search: 'Finding exposures',
  headers: 'Reading image headers',
  pixels: 'Downloading images',
  reproject: 'Lining up the images',
  stack: 'Combining visits',
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchCachedName(q: string): CachedSlug | null {
  const n = normalize(q);
  if (!n) return null;
  for (const c of listCached()) {
    if (normalize(c.name) === n || normalize(c.slug) === n) return c.slug;
  }
  return null;
}

// Sky click offer: the library checks today's, catalogue-epoch and J2000 positions within 60 arcsec
// when it reads coordinates, and reports a prepared target as cachedSlug (no network needed).
export async function findCachedByPosition(
  ra: number,
  dec: number,
): Promise<{ slug: CachedSlug; name: string } | null> {
  try {
    const t = await resolveTarget(`${ra} ${dec}`);
    if (!t.cachedSlug) return null;
    const hit = listCached().find((c) => c.slug === t.cachedSlug);
    return hit ? { slug: hit.slug, name: hit.name } : null;
  } catch {
    return null;
  }
}

export function normalizeName(s: string): string {
  return normalize(s);
}

export function chooseDetector(
  available: { detector: Detector; count: number }[],
  preferred: Detector | null,
): Detector {
  if (preferred && available.some((a) => a.detector === preferred)) return preferred;
  if (available.some((a) => a.detector === 2)) return 2;
  let best = available[0];
  for (const a of available) if (a.count > best.count) best = a;
  return best.detector;
}

function availableOf(exposures: Exposure[]): DetInfo[] {
  return summarize(exposures)
    .map((x) => ({ detector: x.detector, count: x.count, visits: x.visits.length }))
    .sort((x, y) => x.detector - y.detector);
}

// The same search with a grown exposure list (live results filling in).
export function withExposures(search: LiveSearch, exposures: Exposure[]): LiveSearch {
  return { ...search, exposures, available: availableOf(exposures) };
}

function abortedError(): SpherexError {
  return new SpherexError('ABORTED', 'Loading stopped');
}

export async function searchLive(
  req: LoadRequest,
  cb: LoadCallbacks,
  signal: AbortSignal,
  resolved: Target | null = null,
): Promise<LiveSearch> {
  const stage = (s: Progress['stage'], message: string) => cb.onStage({ stage: s, done: 0, total: 0, message });
  let target: Target;
  if (resolved) {
    target = resolved;
  } else if (req.q) {
    stage('resolve', 'Looking up the name');
    target = await resolveTarget(req.q, { signal, onProgress: cb.onStage });
  } else {
    target = { ra: req.ra as number, dec: req.dec as number, source: 'coordinates' };
  }
  if (signal.aborted) throw abortedError();
  stage('search', 'Asking the archive which images cover this spot');
  const archive = cb.archiveSignal ?? signal;
  cb.onSearching?.();
  const exposures = await findExposures(target.ra, target.dec, {
    signal: archive,
    onProgress: cb.onStage,
    onUpdate: (list, status) => {
      if (!archive.aborted) cb.onUpdate?.(list, status);
    },
  });
  cb.onFound?.();
  if (signal.aborted) throw abortedError();
  if (exposures.length === 0) throw new SpherexError('NO_COVERAGE', 'No images cover this position');
  return { target, exposures, available: availableOf(exposures) };
}

export async function loadFirst(
  search: LiveSearch,
  preferred: Detector | null,
  size: number,
  cb: LoadCallbacks,
  signal: AbortSignal,
): Promise<LoadResult> {
  const { target, exposures, available } = search;
  const grid = makeGrid(target, exposures, size);
  const det = chooseDetector(available, preferred);
  cb.onStage({ stage: 'pixels', done: 0, total: 2, message: 'Downloading two images to compare' });
  const first = await loadFirstLook(target, exposures, grid, {
    signal,
    onProgress: cb.onStage,
    detector: det,
  });
  if (signal.aborted) throw abortedError();
  if (first.frames.length < 2) throw new SpherexError('NO_COVERAGE', ONCE_ONLY);
  const frames = [...first.frames].sort((x, y) => x.exposure.mjd - y.exposure.mjd);
  return {
    live: { grid, rest: [], size, detExposures: exposures.filter((e) => e.detector === first.detector) },
    search,
    cachedData: null,
    preview: null,
    cachedSlug: null,
    target,
    frames,
    det: first.detector,
    available,
    failed: 0,
    total: 2,
    cached: false,
    matched: first.matched,
    viaPosition: false,
  };
}

// Background step after the first look: look for a better wavelength-matched pair.
export async function refineBest(
  target: Target,
  exposures: Exposure[],
  grid: Grid,
  det: Detector,
  signal: AbortSignal,
): Promise<{ frames: Frame[]; matched: boolean }> {
  const r = await loadBestPair(target, exposures, grid, { detector: det, target, signal });
  if (signal.aborted) throw abortedError();
  return { frames: [...r.frames].sort((x, y) => x.exposure.mjd - y.exposure.mjd), matched: r.matched };
}

export async function loadFrameSet(
  exposures: Exposure[],
  grid: Grid,
  signal: AbortSignal,
): Promise<Frame[]> {
  const r = await loadFrames(exposures, grid, { signal });
  if (signal.aborted) throw abortedError();
  return [...r.frames].sort((x, y) => x.exposure.mjd - y.exposure.mjd);
}

export async function loadViewer(req: LoadRequest, cb: LoadCallbacks, signal: AbortSignal): Promise<LoadResult> {
  let slug = req.q ? matchCachedName(req.q) : null;
  let viaPosition = false;
  let resolved: Target | null = null;
  if (!slug && req.q) {
    // A name or coordinates within about a minute of a prepared target (J2000 or proper-motion
    // corrected) goes straight to the prepared set. The library reports the match as cachedSlug.
    cb.onStage({ stage: 'resolve', done: 0, total: 0, message: 'Looking up the name' });
    resolved = await resolveTarget(req.q, { signal, onProgress: cb.onStage });
    if (signal.aborted) throw abortedError();
    if (resolved.cachedSlug) {
      slug = resolved.cachedSlug;
      viaPosition = true;
    }
  }
  if (slug) {
    const pv = await loadCachedPreview(slug, { signal, onProgress: cb.onStage });
    if (signal.aborted) throw abortedError();
    const available: DetInfo[] = pv.detectors
      .map((d) => ({ detector: d.detector, count: d.count, visits: d.visits.length }))
      .sort((x, y) => x.detector - y.detector);
    const det = chooseDetector(available, pv.defaultDetector);
    // Seed the pair frames the preview carries so pair lists work before any detector file lands.
    const seeded = new Map<string, Frame>();
    for (const p of [pv.pairs.year, pv.pairs.halfYear]) {
      if (p) for (const f of p.frames) seeded.set(f.exposure.id, f);
    }
    return {
      live: null,
      search: null,
      cachedData: null,
      preview: pv,
      cachedSlug: slug,
      target: pv.target,
      frames: Array.from(seeded.values()),
      det,
      available,
      failed: 0,
      total: seeded.size,
      cached: true,
      matched: true,
      viaPosition,
      asked: resolved ? { ra: resolved.ra, dec: resolved.dec } : undefined,
    };
  }
  const search = await searchLive(req, cb, signal, resolved);
  return loadFirst(search, req.det, req.size ?? DEFAULT_SIZE, cb, signal);
}

export async function loadRest(
  grid: Grid,
  exposures: Exposure[],
  cb: { onProgress: (done: number, total: number) => void; onFrames: (landed: Frame[]) => void },
  signal: AbortSignal,
): Promise<{ landed: Frame[]; failed: number }> {
  const landed: Frame[] = [];
  let last = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const emit = () => {
    if (pending !== null) clearTimeout(pending);
    pending = null;
    last = performance.now();
    cb.onFrames([...landed]);
  };
  let failed = 0;
  try {
    const r = await loadFrames(exposures, grid, {
      signal,
      onFrame: (f) => {
        landed.push(f);
        cb.onProgress(landed.length, exposures.length);
        const wait = 250 - (performance.now() - last);
        if (wait <= 0) emit();
        else if (pending === null) pending = setTimeout(emit, wait);
      },
    });
    failed = r.failed.length;
  } catch (e) {
    if (!signal.aborted) {
      emit();
      throw e;
    }
  }
  emit();
  return { landed, failed };
}
