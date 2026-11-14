import * as mock from './mock';
import * as real from '../../lib/spherex';
import type { CachedDetectorData, CachedPreview, CachedSlug, CallOptions, Detector } from './types';

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
export const findExposures = live.findExposures;
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
export const listCached = cache.listCached;

// Provisional: previews, per detector loads and paired differences come from the mock helpers,
// built from whatever loadCached returned (real pixels when the real cache loaded). To switch to
// the library once it lands, replace these four lines with `real.` versions.
export const loadCachedPreview = async (
  slug: CachedSlug,
  opts?: CallOptions,
): Promise<CachedPreview> => {
  const c = await loadCached(slug, opts);
  const preview = await mock.previewFromCached(c, opts);
  if (fromMock.has(c)) fromMock.add(preview);
  return preview;
};
export const loadCachedDetector = async (
  slug: CachedSlug,
  detector: Detector,
  opts?: CallOptions,
): Promise<CachedDetectorData> => mock.detectorFromCached(await loadCached(slug, opts), detector, opts);
export const visitDifference = mock.visitDifference;
export const pairedDifference = mock.pairedDifference;
export const asSingle = mock.asSingle;
export const asNaiveStack = mock.asNaiveStack;

export function isSimulated(c: object): boolean {
  return fromMock.has(c);
}
// wiseCone is real (CatWISE2020, radius capped at 300 arcsec).
export const wiseAvailable = true;

// Provisional: the data seat will land the real function; until then the mock is used everywhere.
export const compareVisits = mock.compareVisits;
