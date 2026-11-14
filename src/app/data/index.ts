import * as mock from './mock';
import * as real from '../../lib/spherex';
import type { CachedDetectorData, CachedPreview, CachedSlug, CallOptions, Detector, Exposure, FindExposuresOptions } from './types';

// Flip each half to the real library in one line.
const LIVE_REAL = true;
const CACHE_REAL = true;

type Lib = Pick<
  typeof real,
  | 'resolveTarget'
  | 'positionAt'
  | 'findExposures'
  | 'makeGrid'
  | 'loadFrame'
  | 'loadFrames'
  | 'annotateWavelengths'
  | 'pickBlinkPair'
  | 'loadFirstLook'
  | 'loadBestPair'
  | 'saturatedSources'
  | 'buildMovie'
  | 'difference'
  | 'spectrumAt'
  | 'gaiaCone'
  | 'wiseCone'
  | 'worldToGrid'
  | 'gridToWorld'
  | 'summarize'
  | 'parallaxOffset'
  | 'positionAtDistance'
  | 'gridAt'
  | 'trackingTolerance'
  | 'listPairs'
  | 'motionFromPair'
>;
type CacheLib = Pick<typeof real, 'loadCached' | 'listCached'>;

const forceMock = new URLSearchParams(location.search).get('mock') === '1';
const live: Lib = forceMock || !LIVE_REAL ? mock : real;
const cache: CacheLib = forceMock || !CACHE_REAL ? mock : real;

export * from './types';

export const liveIsMock = live === (mock as unknown);
export const cacheIsMock = cache === (mock as unknown);
export const isMock = liveIsMock && cacheIsMock;

export const resolveTarget = live.resolveTarget;
export { matchCachedTarget } from '../../lib/spherex';
export const positionAt = live.positionAt;
// Passes onUpdate through to the live source; a source that ignores it just never calls it.
// The wait budget is passed explicitly so the viewer's own final-state timer can use the same number.
export const archiveMaxWaitMs: number = forceMock ? mock.archiveWaitMs() : 60000;
export const findExposures = (ra: number, dec: number, opts: FindExposuresOptions = {}): Promise<Exposure[]> =>
  (live.findExposures as unknown as (ra: number, dec: number, opts: FindExposuresOptions) => Promise<Exposure[]>)(
    ra,
    dec,
    { maxWaitMs: archiveMaxWaitMs, ...opts },
  );
export const makeGrid = live.makeGrid;
export const loadFrame = live.loadFrame;
export const loadFrames = live.loadFrames;
export const annotateWavelengths = live.annotateWavelengths;
export const pickBlinkPair = live.pickBlinkPair;
export const loadFirstLook = live.loadFirstLook;
export const loadBestPair = live.loadBestPair;
export const saturatedSources = live.saturatedSources;
export const buildMovie = live.buildMovie;
export const difference = live.difference;
export const spectrumAt = live.spectrumAt;
export const gaiaCone = live.gaiaCone;
export const wiseCone = live.wiseCone;
export const worldToGrid = live.worldToGrid;
export const gridToWorld = live.gridToWorld;
export const summarize = live.summarize;
export const parallaxOffset = live.parallaxOffset;
export const positionAtDistance = live.positionAtDistance;
export const gridAt = live.gridAt;
export const trackingTolerance = live.trackingTolerance;
export const listPairs = live.listPairs;
export const motionFromPair = live.motionFromPair;
export { YEAR_PAIR_DAYS, HALF_YEAR_PAIR_DAYS } from '../../lib/spherex';
const fromMock = new WeakSet<object>();

// Real prepared sets when present; any failure (missing files, bad data) falls back to the mock
// for that target, and isSimulated() then reports it so the viewer can say so.
export const loadCached: CacheLib['loadCached'] = async (slug: CachedSlug, opts?: CallOptions) => {
  if (cache === (mock as unknown)) {
    const c = await mock.loadCached(slug, opts);
    fromMock.add(c);
    return c;
  }
  try {
    return await cache.loadCached(slug, opts);
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'ABORTED') throw err;
    const c = await mock.loadCached(slug, opts);
    fromMock.add(c);
    return c;
  }
};
// The app words the example's description itself, so it reads the same whichever source answers.
const EXAMPLE_BLURBS: Record<string, string> = {
  'v391-oph':
    "An eclipsing binary star near Barnard's Star: the readout catches it dimmed by eclipse in some SPHEREx exposures, while a steady neighbour of the same brightness shows no change.",
};
export const listCached: CacheLib['listCached'] = () =>
  cache.listCached().map((c) => (EXAMPLE_BLURBS[c.slug] ? { ...c, blurb: EXAMPLE_BLURBS[c.slug] } : c));

// Real split-cache loaders (format 2). ?mock=1 keeps the mock path, built from loadCached. Any
// failure (files missing, bad data) falls back to the mock for that target and isSimulated() then
// reports it so the viewer can say so.
function normalizePreview(p: real.CachedPreview): CachedPreview {
  const per = p.totalBytes.perDetector;
  const dflt = p.defaultDetector;
  return {
    target: p.target,
    grid: p.grid,
    defaultDetector: p.defaultDetector,
    movie: p.movie,
    pairs: p.pairs,
    differences: p.differences,
    visits: p.visits.map((v) => ({
      visitIndex: v.visitIndex,
      mjd: v.mjdStart,
      time: '',
      nExposures: v.countByDetector[dflt] ?? 0,
    })),
    gaia: p.gaia,
    wise: p.wise,
    detectors: p.detectors.map((d) => ({ ...d, bytes: per[d.detector] ?? 0 })),
    totalBytes: Object.values(per).reduce((s, n) => s + n, 0),
  };
}

export const loadCachedPreview = async (slug: CachedSlug, opts?: CallOptions): Promise<CachedPreview> => {
  if (cache !== (mock as unknown)) {
    try {
      return normalizePreview(await real.loadCachedPreview(slug, opts));
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ABORTED') throw err;
    }
  }
  const c = await loadCached(slug, opts);
  const preview = await mock.previewFromCached(c, opts);
  fromMock.add(preview);
  return preview;
};
export const loadCachedDetector = async (
  slug: CachedSlug,
  detector: Detector,
  opts?: CallOptions,
): Promise<CachedDetectorData> => {
  if (cache !== (mock as unknown)) {
    try {
      return await real.loadCachedDetector(slug, detector, opts);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ABORTED') throw err;
    }
  }
  return mock.detectorFromCached(await loadCached(slug, opts), detector, opts);
};
export const loadCachedStars = async (slug: CachedSlug, opts?: CallOptions) => {
  if (cache !== (mock as unknown)) {
    try {
      return await real.loadCachedStars(slug, opts);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ABORTED') throw err;
    }
  }
  const c = await loadCached(slug, opts);
  return { gaia: c.gaia, wise: c.wise };
};
export const visitDifference = live === (mock as unknown) ? mock.visitDifference : real.visitDifference;
export const pairedDifference = live === (mock as unknown) ? mock.pairedDifference : real.pairedDifference;
export const asSingle = mock.asSingle;
export const asNaiveStack = mock.asNaiveStack;

export function isSimulated(c: object): boolean {
  return fromMock.has(c);
}
// wiseCone is real (CatWISE2020, radius capped at 300 arcsec).
export const wiseAvailable = true;

// Provisional: the data seat will land the real function; until then the mock is used everywhere.
export const compareVisits = mock.compareVisits;
