import {
  SpherexError,
  loadBestPair,
  loadFirstLook,
  findExposures,
  listCached,
  loadCached,
  loadFrames,
  makeGrid,
  resolveTarget,
  summarize,
} from '../data';
import type { CachedSlug, CachedTarget, Detector, Exposure, Frame, Grid, Progress, Target } from '../data';

export interface LoadRequest {
  q: string | null;
  ra: number | null;
  dec: number | null;
  det: Detector | null;
  size: number | null;
}

export interface LoadCallbacks {
  onStage: (p: Progress) => void;
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
  target: Target;
  frames: Frame[];
  det: Detector;
  available: DetInfo[];
  failed: number;
  total: number;
  cached: boolean;
  matched: boolean;
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
  search: 'Asking the SPHEREx archive',
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

function sepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const r = Math.PI / 180;
  const d1 = dec1 * r;
  const d2 = dec2 * r;
  const dr = (ra1 - ra2) * r;
  const c = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(dr);
  return Math.acos(Math.min(1, Math.max(-1, c))) * (180 / Math.PI) * 3600;
}

export async function findCachedByPosition(
  ra: number,
  dec: number,
): Promise<{ slug: CachedSlug; name: string } | null> {
  for (const c of listCached()) {
    try {
      const t = await resolveTarget(c.name);
      if (sepArcsec(ra, dec, t.ra, t.dec) <= 60) return { slug: c.slug, name: c.name };
    } catch {
      // a cached name failing to resolve just means no match
    }
  }
  return null;
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

function abortedError(): SpherexError {
  return new SpherexError('ABORTED', 'Loading stopped');
}

export async function searchLive(req: LoadRequest, cb: LoadCallbacks, signal: AbortSignal): Promise<LiveSearch> {
  const stage = (s: Progress['stage'], message: string) => cb.onStage({ stage: s, done: 0, total: 0, message });
  let target: Target;
  if (req.q) {
    stage('resolve', 'Looking up the name');
    target = await resolveTarget(req.q, { signal, onProgress: cb.onStage });
  } else {
    target = { ra: req.ra as number, dec: req.dec as number, source: 'coordinates' };
  }
  if (signal.aborted) throw abortedError();
  stage('search', 'Asking the archive which images cover this spot');
  const exposures = await findExposures(target.ra, target.dec, { signal, onProgress: cb.onStage });
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
    target,
    frames,
    det: first.detector,
    available,
    failed: 0,
    total: 2,
    cached: false,
    matched: first.matched,
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
  const slug = req.q ? matchCachedName(req.q) : null;
  if (slug) {
    const c = await loadCached(slug, { signal });
    if (signal.aborted) throw abortedError();
    const available = availableOf(c.exposures);
    const det = chooseDetector(available, req.det ?? (slug === 'wise-0855' ? 6 : null));
    return {
      live: null,
      search: null,
      cachedData: c,
      target: c.target,
      frames: c.frames,
      det,
      available,
      failed: 0,
      total: c.frames.length,
      cached: true,
      matched: true,
    };
  }
  const search = await searchLive(req, cb, signal);
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
