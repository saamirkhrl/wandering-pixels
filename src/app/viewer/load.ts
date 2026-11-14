import {
  SpherexError,
  annotateWavelengths,
  findExposures,
  listCached,
  loadCached,
  loadFrames,
  makeGrid,
  pickBlinkPair,
  resolveTarget,
  summarize,
} from '../data';
import type { CachedSlug, Detector, Exposure, Frame, Grid, Progress, Target } from '../data';

export interface LoadRequest {
  q: string | null;
  ra: number | null;
  dec: number | null;
  det: Detector | null;
}

export interface LoadCallbacks {
  onStage: (p: Progress) => void;
}

export interface LiveContext {
  grid: Grid;
  rest: Exposure[];
}

export const ONCE_ONLY = 'ONCE_ONLY';
export const FRAME_MB_ESTIMATE = 2.0;
export const AUTO_REST_LIMIT = 20;

export interface LoadResult {
  live: LiveContext | null;
  target: Target;
  frames: Frame[];
  det: Detector;
  available: { detector: Detector; count: number }[];
  failed: number;
  total: number;
  cached: boolean;
}

export const STAGE_WORDS: Record<Progress['stage'], string> = {
  resolve: 'Finding the star',
  search: 'Searching the archive',
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

async function matchCachedPosition(ra: number, dec: number): Promise<CachedSlug | null> {
  for (const c of listCached()) {
    try {
      const t = await resolveTarget(c.name);
      if (sepArcsec(ra, dec, t.ra, t.dec) <= 60) return c.slug;
    } catch {
      // a cached name failing to resolve just means no match
    }
  }
  return null;
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

function availableOf(exposures: Exposure[]): { detector: Detector; count: number }[] {
  return summarize(exposures)
    .map((s) => ({ detector: s.detector, count: s.count }))
    .sort((x, y) => x.detector - y.detector);
}

function abortedError(): SpherexError {
  return new SpherexError('ABORTED', 'Loading stopped');
}

export async function loadViewer(req: LoadRequest, cb: LoadCallbacks, signal: AbortSignal): Promise<LoadResult> {
  const check = () => {
    if (signal.aborted) throw abortedError();
  };

  let slug: CachedSlug | null = null;
  if (req.q) slug = matchCachedName(req.q);
  else if (req.ra !== null && req.dec !== null) slug = await matchCachedPosition(req.ra, req.dec);
  check();

  if (slug) {
    const c = await loadCached(slug, { signal });
    check();
    const available = availableOf(c.exposures);
    const det = chooseDetector(available, req.det);
    const frames = c.frames.filter((f) => f.exposure.detector === det);
    return {
      live: null,
      target: c.target,
      frames: c.frames,
      det,
      available,
      failed: 0,
      total: frames.length,
      cached: true,
    };
  }

  const stage = (s: Progress['stage'], message: string, done = 0, total = 0) =>
    cb.onStage({ stage: s, done, total, message });

  let target: Target;
  if (req.q) {
    stage('resolve', 'Looking up the name');
    target = await resolveTarget(req.q, { signal, onProgress: cb.onStage });
  } else {
    target = { ra: req.ra as number, dec: req.dec as number, source: 'coordinates' };
  }
  check();

  stage('search', 'Asking the archive which images cover this spot');
  const exposures = await findExposures(target.ra, target.dec, { signal, onProgress: cb.onStage });
  check();
  if (exposures.length === 0) throw new SpherexError('NO_COVERAGE', 'No images cover this position');

  const grid = makeGrid(target, exposures, 400);
  const available = availableOf(exposures);
  const det = chooseDetector(available, req.det);

  const annotated = await annotateWavelengths(
    exposures.filter((e) => e.detector === det),
    target.ra,
    target.dec,
    { signal, onProgress: cb.onStage },
  );
  check();
  const pair = pickBlinkPair(annotated, det);
  if (!pair) throw new SpherexError('NO_COVERAGE', ONCE_ONLY);

  stage('pixels', 'Downloading two images to compare', 0, 2);
  const got: Frame[] = [];
  const result = await loadFrames([...pair], grid, {
    signal,
    onProgress: cb.onStage,
    onFrame: (f) => {
      got.push(f);
      stage('pixels', 'Downloading two images to compare', got.length, 2);
    },
  });
  check();
  if (result.frames.length === 0) throw new SpherexError('UPSTREAM_ERROR', 'None of the exposures could be read');
  const frames = [...result.frames].sort((x, y) => x.exposure.mjd - y.exposure.mjd);
  const pairIds = new Set(pair.map((e) => e.id));
  return {
    live: { grid, rest: annotated.filter((e) => !pairIds.has(e.id)) },
    target,
    frames,
    det,
    available,
    failed: result.failed.length,
    total: 2,
    cached: false,
  };
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
