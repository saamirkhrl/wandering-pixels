import * as mock from './mock';
import * as real from '../../lib/spherex';

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
const fromMock = new WeakSet<object>();

// Real prepared sets when present; any failure (missing files, bad data) falls back to the mock
// for that target, and isSimulated() then reports it so the viewer can say so.
export const loadCached: CacheLib['loadCached'] = async (slug, opts) => {
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

export function isSimulated(c: object): boolean {
  return fromMock.has(c);
}
// wiseCone is real (CatWISE2020, radius capped at 300 arcsec).
export const wiseAvailable = true;
