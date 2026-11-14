import * as mock from './mock';
// Switch to the real library by changing this one line to: import * as real from '../../lib/spherex';
import * as real from './mock';

const useMock = new URLSearchParams(location.search).get('mock') === '1';
const lib: typeof mock = useMock ? mock : real;

export * from './types';

export const isMock = useMock || (real as unknown) === (mock as unknown);

export const resolveTarget = lib.resolveTarget;
export const positionAt = lib.positionAt;
export const findExposures = lib.findExposures;
export const makeGrid = lib.makeGrid;
export const loadFrame = lib.loadFrame;
export const loadFrames = lib.loadFrames;
export const annotateWavelengths = lib.annotateWavelengths;
export const pickBlinkPair = lib.pickBlinkPair;
export const loadFirstLook = lib.loadFirstLook;
export const saturatedSources = lib.saturatedSources;
export const buildMovie = lib.buildMovie;
export const difference = lib.difference;
export const spectrumAt = lib.spectrumAt;
export const loadCached = lib.loadCached;
export const listCached = lib.listCached;
export const gaiaCone = lib.gaiaCone;
export const wiseCone = lib.wiseCone;
// wiseCone is real (CatWISE2020, radius capped at 300 arcsec).
export const wiseAvailable = true;
export const worldToGrid = lib.worldToGrid;
export const gridToWorld = lib.gridToWorld;
export const summarize = lib.summarize;
