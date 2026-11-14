import './../../ui/viewer.css';
import type { Mount } from '../types';
import { prefersReducedMotion } from '../motion';
import {
  buildMovie,
  difference,
  gaiaCone,
  FLAG_BITS,
  gridToWorld,
  isSimulated,
  HALF_YEAR_PAIR_DAYS,
  YEAR_PAIR_DAYS,
  listCached,
  listPairs,
  loadCachedDetector,
  loadCachedStars,
  loadFrames,
  parallaxOffset,
  trackingTolerance,
  visitDifference,
  liveIsMock,
  positionAt,
  spectrumAt,
  wiseAvailable,
  wiseCone,
} from '../data';
import type {
  CachedPreview,
  CachedSlug,
  CachedTarget,
  DifferenceImage,
  Detector,
  Exposure,
  ExposureUpdateStatus,
  Frame,
  Grid,
  Movie,
  MovieMode,
  Progress,
  Target,
} from '../data';
import { formatDate, createPanel } from '../viewer/panel';
import type { CompareInfo, FrameInfo, PanelModel } from '../viewer/panel';
import { createPlayer } from '../viewer/player';
import { targetNote } from '../viewer/target-notes';
import {
  AUTO_REST_LIMIT,
  DEFAULT_SIZE,
  DET_BANDS,
  FRAME_MB_ESTIMATE,
  ONCE_ONLY,
  findCachedByPosition,
  loadFirst,
  loadRest,
  loadViewer,
  normalizeName,
  refineBest,
  withExposures,
} from '../viewer/load';
import type { DetInfo, LiveContext, LiveSearch, LoadResult } from '../viewer/load';
import {
  HATCH_A,
  asinhNorm,
  diffRange,
  displayStretch,
  divergingColor,
  divergingNorm,
  greyColor,
  renderDiverging,
  renderPixels,
} from '../viewer/render';
import type { Contrast, DiffRange, Rgb, Stretch } from '../viewer/render';
import { toRGBA, upsampleSmooth } from '../viewer/smooth';
import { createStage, formatDecDeg, formatRaDeg } from '../viewer/stage';
import { hasTarget, readParams, writeParams } from '../viewer/state';
import { createSpectrumPanel } from '../viewer/spectrum';
import { createPlanetSection } from '../viewer/planet';
import { bytesFromProgress, loadingLine } from '../viewer/loading';
import type { LoadingBytes } from '../viewer/loading';
import { NO_PAIR_READING, PAIRED_READING } from '../viewer/stack-copy';
import type { DiffSource } from '../viewer/stack-copy';
import { COPY, fill, mjdDate } from '../viewer/distance-copy';
import { ringRadiusPx } from '../viewer/distance';
import { createSimTag, simAnchorGrid, simFrames, SIM_MOTION } from '../viewer/planet-sim';
import { createQualityPanel } from '../viewer/quality';
import {
  describeSource,
  drawMask,
  drawMaskOutline,
  drawSources,
  hitTest,
  MASK_ADVISORY_BITS,
  MASK_BAD_BITS,
  maskFor,
  projectSources,
  sourcesFromGaia,
  sourcesFromWise,
} from '../viewer/overlays';
import type { OverlaySource, ProjectedSource } from '../viewer/overlays';

interface DiffEntry {
  key: string;
  d: DifferenceImage;
  range: number;
  soft: number;
}

interface Loaded {
  target: Target;
  frames: Frame[];
  det: Detector;
  available: DetInfo[];
  cached: boolean;
}

type Layer = 'gaia' | 'wise' | 'masked' | 'adv';

const OVERLAY_LIMIT = 40;
const KNOWN_CODES = ['NOT_FOUND', 'NO_COVERAGE', 'UPSTREAM_BUSY', 'UPSTREAM_ERROR', 'BAD_INPUT'] as const;
const DETECTORS: Detector[] = [1, 2, 3, 4, 5, 6];

function safeCached(): { slug: string; name: string; blurb: string }[] {
  try {
    return listCached();
  } catch {
    return [];
  }
}

function wl(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(2)} um` : 'wavelength unknown';
}

function sig2(v: number): string {
  const a = Math.abs(v);
  if (a >= 100) return a.toFixed(0);
  return Number(a.toPrecision(2)).toString();
}

export const mount: Mount = (root, ctx) => {
  const params = readParams();
  const reduced = prefersReducedMotion();

  let disposed = false;
  let loaded: Loaded | null = null;
  let askedAt: { ra: number; dec: number } | null = null;
  let movie: Movie | null = null;
  let mode: MovieMode = params.mode;
  let det: Detector | null = params.det;
  let aUser: number | null = params.a;
  let bUser: number | null = params.b;
  let diffOn = params.diff;
  let size = params.size ?? DEFAULT_SIZE;
  let pendingFrame: number | null = params.frame;
  let modeUser = new URLSearchParams(location.search).has('mode');
  let aMjd: number | null = null;
  let bMjd: number | null = null;
  let ctrl: AbortController | null = null;
  let token = 0;
  let diffCache: DiffEntry | null = null;
  const stretchCache = new WeakMap<Movie, Map<Contrast, Stretch>>();
  const imgCache = new WeakMap<object, Map<string, Uint8ClampedArray>>();
  let smooth = !params.trueSharp;
  let contrast: Contrast = 'normal';
  let drange: DiffRange = params.drange;
  let planetStep: 0 | 1 | 2 = params.planet;
  let ringsOn = true;
  let simOn = new URLSearchParams(location.search).get('sim') === '1';
  let refineDone = false;
  let simRef: number | null = simOn ? params.ref : null;
  let trackD: number | null = params.dist;
  let trackRef: number | null = params.ref;
  let trackedFrames: Frame[] | null = null;
  let trackCtrl: AbortController | null = null;
  let modeBeforeTrack: MovieMode | null = null;
  let lastPick: [number, number] | null = null;
  let pickWaiting = false;
  let cursor: [number, number] | null = null;
  let shownGrid: Grid | null = null;
  let restoredTrack = false;
  let current: { kind: 'frame'; pixels: Float32Array; w: number } | { kind: 'diff'; d: DifferenceImage } | null = null;

  // live state
  let search: LiveSearch | null = null;
  // live results filling in: latest archive answer, a list that arrived before the view was ready,
  // a counter that retires updates from an older load, and the archive's own abort controller
  let archiveStatus: ExposureUpdateStatus | null = null;
  let pendingList: Exposure[] | null = null;
  let restAgain = false;
  let loadGen = 0;
  let archiveCtrl: AbortController | null = null;
  let cachedData: CachedTarget | null = null;
  let live: LiveContext | null = null;
  let pairFrames: Frame[] = [];
  let landed: Frame[] = [];
  let remaining: Exposure[] = [];
  let restTotal = 0;
  let restCtrl: AbortController | null = null;
  let skyName: string | null = null;
  let abTouched = false;
  let restBase = 0;

  // prepared sets (split cache): the small preview paints first, each detector's exposures follow
  let preview: CachedPreview | null = null;
  let cachedSlug: CachedSlug | null = null;
  const detFrames = new Map<Detector, Frame[]>();
  let detLoad: { det: Detector; ctrl: AbortController; bytes: number; total: number; switchTo: boolean } | null = null;
  let detFailed: Detector | null = null;
  let starsRequested = false;

  // overlays and spectrum
  const ov: Record<Layer, boolean> = {
    gaia: params.overlays.includes('gaia'),
    wise: params.overlays.includes('wise'),
    masked: params.overlays.includes('masked'),
    adv: params.overlays.includes('adv'),
  };
  const ovSources: { gaia: OverlaySource[] | null; wise: OverlaySource[] | null } = { gaia: null, wise: null };
  let ovLoading = '';
  let ovToken = 0;
  let gaiaTotal = 0;
  let wiseTotal = 0;
  let drawGaia: ProjectedSource[] = [];
  let drawWise: ProjectedSource[] = [];
  let drawMaskArr: Uint8Array | null = null;
  let drawMaskW = 0;
  let satMaskArr: Uint8Array | null = null;
  let advMaskArr: Uint8Array | null = null;
  let hasSat = false;
  let qualityKey: { movie: Movie | null; frame: unknown; n: number; diff: string } = { movie: null, frame: null, n: 0, diff: '' };

  const rootEl = document.createElement('div');
  rootEl.className = 'viewer';
  rootEl.dataset.state = 'empty';

  const player = createPlayer(() => {
    render();
    if (player.mode === 'stopped') persist();
  }, reduced ? 1 : 2);

  const stage = createStage();
  const spectrum = createSpectrumPanel();
  const quality = createQualityPanel();
  const planet = createPlanetSection({
    onStep: (s) => setPlanetStep(s),
    onRings: (on) => {
      ringsOn = on;
      stage.redraw();
    },
    onDistance: (d) => {
      if (d === null) {
        stopTracking();
        return;
      }
      startTracked(d, trackRef ?? (movie ? (movie.frames[Math.min(player.index, movie.frames.length - 1)]?.mjd ?? 0) : 0));
    },
    onLoadRest: () => loadTrackRest(),
    onSim: (on) => (on && loaded && pairs().half.length === 0 ? ctx.go('viewer', { q: "Barnard's Star", planet: '2', dist: '500', sim: '1' }) : setSim(on)),
    onExample: () => ctx.go('viewer', { ra: '150.1', dec: '2.2', mock: '1', planet: '2', dist: '500' }),
  });

  const panel = createPanel({
    blink: () => {
      if (player.mode === 'blink') player.stop();
      else {
        const [a, b] = ab();
        player.setAB(a, b);
        player.blink();
      }
    },
    playPause: () => {
      if (player.mode === 'play') player.stop();
      else player.play();
    },
    step: (d) => player.step(d),
    speed: (fps) => player.setFps(fps),
    selectFrame: (i) => {
      player.stop();
      player.setIndex(i);
      persist();
    },
    setMode: (m) => {
      if (m === mode) return;
      if (m === 'single' && !everyReady()) return;
      mode = m;
      modeUser = true;
      resetChoices();
      player.stop();
      player.setIndex(0);
      rebuild();
      showRest();
      persist();
    },
    setDet: (d) => {
      if (d === det) return;
      if (preview) {
        if (d === preview.defaultDetector || detFrames.has(d)) switchDetNow(d);
        else startDetLoad(d, true);
        return;
      }
      if (loaded && !loaded.cached && search) {
        det = d;
        switchLive(d, size);
        return;
      }
      det = d;
      resetTracking();
      resetChoices();
      player.stop();
      player.setIndex(0);
      rebuild();
      persist();
    },
    setDrange: (r) => {
      drange = r;
      render();
      persist();
    },
    setSmooth: (on) => {
      smooth = on;
      render();
      persist();
    },
    setContrast: (c) => {
      contrast = c;
      render();
    },
    setSize: (n) => {
      if (n === size || !search || (loaded && loaded.cached)) return;
      size = n;
      switchLive(det, n);
    },
    setDiff: (on) => setDiff(on),
    setDiffSource: (s) => setDiffSource(s),
    setA: (i) => {
      aUser = i;
      abTouched = true;
      aMjd = movie ? (movie.frames[i]?.mjd ?? null) : null;
      syncAB();
      render();
      persist();
    },
    setB: (i) => {
      bUser = i;
      abTouched = true;
      bMjd = movie ? (movie.frames[i]?.mjd ?? null) : null;
      syncAB();
      render();
      persist();
    },
    retry: () => startLoad(),
    cancel: () => ctrl?.abort(),
    openTarget: (name) => ctx.go('viewer', { q: name }),
    loadRest: () => startRest(),
    stopRest: () => restCtrl?.abort(),
    toggleOverlay: (k) => toggleLayer(k),
    goBack: () => {
      if (params.from) ctx.go(params.from, params.fromParams);
    },
    loadLive: () => {
      const at = askedAt ?? (loaded ? loaded.target : null);
      if (at) ctx.go('viewer', { ra: String(at.ra), dec: String(at.dec) });
    },
    openPrepared: () => {
      if (skyName) ctx.go('viewer', { q: skyName });
    },
  });
  panel.attach(spectrum.el, quality.el, planet.el);
  const simTag = createSimTag();
  stage.el.querySelector('.v-plate')?.appendChild(simTag);
  panel.setBack(params.from === 'sky' ? 'Back to the sky' : params.from === 'globe' ? 'Back to the globe' : null);

  rootEl.append(stage.el, panel.el);
  root.append(rootEl);

  // ---- selection helpers

  let pairCache: { key: string; pair: [number, number] } | null = null;

  function resetChoices(): void {
    aUser = null;
    bUser = null;
    aMjd = null;
    bMjd = null;
    pendingFrame = null;
    pairCache = null;
    abTouched = false;
  }

  function defaultPair(m: Movie): [number, number] {
    const n = m.frames.length;
    const key = `${m.mode}|${m.detector}|${n}|${activeFrames().length}|${trackD ?? 0}`;
    if (pairCache && pairCache.key === key) return pairCache.pair;
    let pair: [number, number] = [0, Math.max(0, n - 1)];
    const cands: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) cands.push([i, j, m.frames[j].mjd - m.frames[i].mjd]);
    }
    cands.sort((x, y) => y[2] - x[2]);
    for (const [i, j] of cands) {
      try {
        if (difference(m.frames[i], m.frames[j]).wavelengthMatched) {
          pair = [i, j];
          break;
        }
      } catch {
        // skip pairs that cannot be differenced
      }
    }
    pairCache = { key, pair };
    return pair;
  }

  function ab(): [number, number] {
    const n = movie ? movie.frames.length : 0;
    if (n === 0 || !movie) return [0, 0];
    const dp = defaultPair(movie);
    const a = Math.min(Math.max(aUser ?? dp[0], 0), n - 1);
    const b = Math.min(Math.max(bUser ?? dp[1], 0), n - 1);
    return [a, b];
  }

  function syncAB(): void {
    const [a, b] = ab();
    player.setAB(a, b);
    if (player.mode === 'blink' && player.index !== a && player.index !== b) player.setIndex(a);
  }

  // Difference source: a wavelength-matched single-exposure pair, or whole-visit stacks.
  let matchedMemo: { key: string; pair: Pair | null } | null = null;

  function matchedPairFor(): Pair | null {
    const ex = loadedExposures();
    const key = `${det}|${ex.length}|${ex[0]?.id ?? ''}|${ex[ex.length - 1]?.id ?? ''}`;
    if (matchedMemo && matchedMemo.key === key) return matchedMemo.pair;
    let pair: Pair | null = null;
    if (det !== null && ex.length >= 2) {
      try {
        pair = listPairs(ex, det).find((p) => p.wavelengthGapChannels <= 1) ?? null;
      } catch {
        pair = null;
      }
    }
    matchedMemo = { key, pair };
    return pair;
  }

  function stackOption(): boolean {
    if (preview) return !!loaded && trackedFrames === null;
    return !!loaded && trackedFrames === null && visitsWithTwo(loaded.frames) >= 2;
  }

  function useMatched(): boolean {
    if (!everyReady()) return false;
    const p = matchedPairFor();
    if (!p || !loaded) return false;
    const prev = mode;
    mode = 'single';
    modeUser = true;
    resetChoices();
    player.stop();
    rebuild();
    const i = frameIndexOf(p.a);
    const j = frameIndexOf(p.b);
    if (i < 0 || j < 0 || i === j) {
      mode = prev;
      resetChoices();
      rebuild();
      return false;
    }
    setPair(Math.min(i, j), Math.max(i, j));
    showRest();
    return true;
  }

  function useStack(): void {
    const m = movie;
    const [ia, ib] = ab();
    const va = m?.frames[ia]?.visitIndex;
    const vb = m?.frames[ib]?.visitIndex;
    mode = 'visit-stack';
    modeUser = true;
    resetChoices();
    player.stop();
    player.setIndex(0);
    rebuild();
    if (movie && va !== undefined && vb !== undefined) {
      const i = movie.frames.findIndex((f) => f.visitIndex === va);
      const j = movie.frames.findIndex((f) => f.visitIndex === vb);
      if (i >= 0 && j >= 0 && i !== j) setPair(i, j);
    }
    showRest();
  }

  function setDiffSource(s: DiffSource): void {
    if (s === 'matched') {
      if (!useMatched()) return;
    } else {
      diffCache = null;
      if (movie && movie.mode !== 'visit-stack') useStack();
    }
    render();
    persist();
  }

  function setDiff(on: boolean): void {
    if (on && !diffOn && !preview && mode === 'visit-stack' && stackOption()) useMatched();
    diffOn = on;
    if (on) player.stop();
    render();
    persist();
  }

  function persist(): void {
    if (disposed || player.mode !== 'stopped') return;
    const layers = (['gaia', 'wise', 'masked', 'adv'] as Layer[]).filter((k) => ov[k]);
    writeParams({
      mode: mode === 'single' ? 'single' : null,
      det: det !== null ? String(det) : null,
      a: aUser !== null ? String(aUser) : null,
      b: bUser !== null ? String(bUser) : null,
      diff: diffOn ? '1' : null,
      frame: player.index > 0 ? String(player.index) : null,
      size: size !== DEFAULT_SIZE ? String(size) : null,
      overlays: layers.length > 0 ? layers.join(',') : null,
      px: smooth ? null : '1',
      drange: drange === 'faint' ? 'f' : drange === 'bright' ? 'h' : null,
      planet: planetStep ? String(planetStep) : null,
      dist: trackedFrames && trackD !== null ? String(trackD) : null,
      ref: trackedFrames && trackRef !== null ? trackRef.toFixed(3) : null,
      sim: simOn ? '1' : null,
    });
  }

  // ---- movie

  // ---- distant bodies: step 1 (compare a year apart) and step 2 (follow at a distance)

  let trackToken = 0;
  let trackAutoPick = false;
  let trackPickAB: [number, number] | null = null;
  let trackPickFrame: number | null = null;

  function shownMjd(): number {
    if (!movie) return 0;
    return movie.frames[Math.min(player.index, movie.frames.length - 1)]?.mjd ?? 0;
  }

  function setPair(i: number, j: number): void {
    if (!movie) return;
    aUser = i;
    bUser = j;
    aMjd = movie.frames[i].mjd;
    bMjd = movie.frames[j].mjd;
    abTouched = true;
    syncAB();
  }

  function gapDays(a: number, b: number): number {
    return Math.round(Math.abs(b - a));
  }

  function loadedExposures(): Exposure[] {
    if (!loaded || det === null) return [];
    return loaded.frames.filter((f) => f.exposure.detector === det).map((f) => f.exposure);
  }

  type Pair = ReturnType<typeof listPairs>[number];
  let pairMemo: { key: string; year: Pair[]; half: Pair[] } | null = null;
  let yearInfo: Pair | null = null;
  let trackPairEx: Exposure[] = [];

  function pairs(): { year: Pair[]; half: Pair[] } {
    const t = loaded?.target;
    const ex = loadedExposures();
    const key = `${det}|${ex.length}|${ex[0]?.id ?? ''}|${ex[ex.length - 1]?.id ?? ''}|${trackD ?? 500}`;
    if (pairMemo && pairMemo.key === key) return pairMemo;
    let year: Pair[] = [];
    let half: Pair[] = [];
    if (t && det !== null && ex.length >= 2) {
      try {
        year = listPairs(ex, det, { gapDays: YEAR_PAIR_DAYS });
        half = listPairs(ex, det, { gapDays: HALF_YEAR_PAIR_DAYS, distanceAu: trackD ?? 500, ra: t.ra, dec: t.dec });
      } catch {
        year = [];
        half = [];
      }
    }
    pairMemo = { key, year, half };
    return pairMemo;
  }

  function frameIndexOf(e: Exposure): number {
    if (!movie) return -1;
    let i = movie.frames.findIndex((f) => f.exposureIds.includes(e.id));
    if (i < 0) i = movie.frames.findIndex((f) => f.visitIndex === e.visitIndex);
    return i;
  }

  function applyYearPair(): void {
    if (!movie) return;
    const best = pairs().year[0];
    if (!best) return;
    const i = frameIndexOf(best.a);
    const j = frameIndexOf(best.b);
    if (i < 0 || j < 0 || i === j) return;
    player.stop();
    setPair(Math.min(i, j), Math.max(i, j));
    yearInfo = best;
    diffOn = true;
  }

  function pxPer(Dau: number, mjdA: number, mjdB: number): number {
    const t = loaded?.target;
    if (!t) return 0;
    try {
      return trackingTolerance(Dau, mjdA, mjdB, t.ra, t.dec).pxPerPercent;
    } catch {
      return 0;
    }
  }

  function bestHalfPair(): Pair | null {
    let best: Pair | null = null;
    for (const p of pairs().half) if (!best || (p.pxPerPercent ?? 0) > (best.pxPerPercent ?? 0)) best = p;
    return best;
  }

  function autoPickTracked(): void {
    if (!movie || trackPairEx.length < 2) return;
    const i = frameIndexOf(trackPairEx[0]);
    const j = frameIndexOf(trackPairEx[1]);
    if (i >= 0 && j >= 0 && i !== j) setPair(Math.min(i, j), Math.max(i, j));
  }

  // Step 2 first loads only the two exposures of the chosen half-year pair. The rest of those two
  // visits is an opt-in (trackFull).
  let trackFull = false;

  function pairVisitExposures(): Exposure[] {
    if (!loaded || det === null || trackPairEx.length < 2) return [];
    const visits = new Set(trackPairEx.map((e) => e.visitIndex));
    const pool = live ? live.detExposures : loadedExposures();
    return pool.filter((e) => e.detector === det && visits.has(e.visitIndex));
  }

  function restOffer(): { n: number; mb: number } | null {
    if (trackedFrames === null || trackFull || trackCtrl !== null) return null;
    const all = pairVisitExposures();
    const have = new Set(trackedFrames.map((f) => f.exposure.id));
    const n = all.filter((e) => !have.has(e.id)).length;
    if (n === 0) return null;
    const withBytes = trackedFrames.filter((f) => f.bytes > 0);
    const per = withBytes.length > 0 ? bytesOf(withBytes) / withBytes.length / 1e6 : FRAME_MB_ESTIMATE;
    return { n, mb: Math.max(1, Math.round(n * per)) };
  }

  function loadTrackRest(): void {
    if (trackD === null || trackRef === null) return;
    trackFull = true;
    trackPickAB = null;
    trackAutoPick = true;
    startTracked(trackD, trackRef);
    render();
  }

  function trackExposures(): Exposure[] {
    if (!loaded || det === null) return [];
    if (trackPairEx.length === 2) {
      const src = trackFull ? pairVisitExposures().concat(trackPairEx) : trackPairEx;
      return Array.from(new Map(src.map((e) => [e.id, e])).values()).sort((x, y) => x.mjd - y.mjd);
    }
    const byVisit = new Map<number, Exposure[]>();
    for (const f of loaded.frames) {
      if (f.exposure.detector !== det) continue;
      const list = byVisit.get(f.exposure.visitIndex) ?? [];
      list.push(f.exposure);
      byVisit.set(f.exposure.visitIndex, list);
    }
    const out: Exposure[] = [];
    byVisit.forEach((list) => {
      const sorted = list.slice().sort((x, y) => x.mjd - y.mjd);
      const n = Math.min(4, sorted.length);
      for (let k = 0; k < n; k++) out.push(sorted[n === 1 ? 0 : Math.round((k * (sorted.length - 1)) / (n - 1))]);
    });
    for (const e of trackPairEx) out.push(e);
    return Array.from(new Map(out.map((e) => [e.id, e])).values()).sort((x, y) => x.mjd - y.mjd);
  }

  function resetTracking(): void {
    trackToken++;
    trackCtrl?.abort();
    trackCtrl = null;
    trackedFrames = null;
    trackFull = false;
    trackD = null;
    trackRef = null;
    planet.control.setValue(null);
    planet.control.setLoading(null);
    if (modeBeforeTrack !== null && !modeUser) mode = modeBeforeTrack;
    modeBeforeTrack = null;
  }

  function stopTracking(): void {
    resetTracking();
    diffCache = null;
    rebuild();
    persist();
  }

  function startTracked(D: number, ref: number): void {
    if (!loaded || det === null) return;
    const base = baseGrid();
    if (!base) return;
    const grid = simOn ? simAnchorGrid(base) : base;
    if (simOn) ref = simAnchorMjd();
    trackCtrl?.abort();
    const rc = new AbortController();
    trackCtrl = rc;
    const mine = ++trackToken;
    trackD = D;
    trackRef = ref;
    const exposures = trackExposures();
    if (exposures.length < 2) return;
    planet.control.setLoading({ done: 0, total: exposures.length });
    const t0 = performance.now();
    const log: string[] = [];
    loadFrames(exposures, grid, {
      distanceAu: D,
      referenceMjd: ref,
      ...(simOn ? { motion: SIM_MOTION } : {}),
      concurrency: 3,
      signal: rc.signal,
      onProgress: (p) => {
        log.push(`${Math.round(performance.now() - t0)}ms ${p.stage} ${p.done}/${p.total} ${p.bytes ?? ''}`);
        if (!disposed && mine === trackToken) planet.control.setLoading({ done: p.done, total: p.total, bytes: p.bytes });
      },
    })
      .then((r) => {
        if (disposed || mine !== trackToken) return;
        planet.control.setLoading(null);
        trackCtrl = null;
        if (r.frames.length < 2) {
          panel.setNotice('Too few images could be re-centred. Try again.');
          return;
        }
        console.info(`[track] ${exposures.length} exposures in ${Math.round(performance.now() - t0)} ms`, log.join(' | '));
        trackedFrames = r.frames.slice().sort((x, y) => x.exposure.mjd - y.exposure.mjd);
        if (modeBeforeTrack === null) modeBeforeTrack = mode;
        if (!modeUser) mode = 'single';
        diffCache = null;
        pairCache = null;
        rebuild();
        if (trackAutoPick) {
          trackAutoPick = false;
          autoPickTracked();
        } else if (trackPickAB && movie) {
          const last = movie.frames.length - 1;
          setPair(Math.min(trackPickAB[0], last), Math.min(trackPickAB[1], last));
        }
        if (trackPickFrame !== null && movie) player.setIndex(Math.min(trackPickFrame, movie.frames.length - 1));
        trackPickAB = null;
        trackPickFrame = null;
        render();
        persist();
      })
      .catch((e: unknown) => {
        if (disposed || mine !== trackToken) return;
        planet.control.setLoading(null);
        if ((e as { code?: string } | null)?.code !== 'ABORTED') {
          panel.setNotice('The images could not be re-centred. The distance setting was not applied.');
        }
      });
  }

  function setPlanetStep(s: 0 | 1 | 2): void {
    planetStep = s;
    if (s === 0) {
      stopTracking();
    } else if (s === 1) {
      resetTracking();
      rebuild();
      applyYearPair();
    } else {
      diffOn = false;
      player.stop();
      const half = bestHalfPair();
      trackPairEx = half ? [half.a, half.b] : [];
      trackAutoPick = true;
      const ref = shownMjd();
      planet.control.setValue(500);
      startTracked(500, ref);
    }
    render();
    persist();
  }

  function restorePlanet(): void {
    if (planetStep === 0 || restoredTrack || !movie) return;
    restoredTrack = true;
    planet.setOpen(true);
    if (planetStep === 1) {
      if (params.a === null && params.b === null) applyYearPair();
    } else if (params.dist !== null) {
      planet.control.setValue(params.dist);
      trackAutoPick = params.a === null && params.b === null;
      if (params.a !== null && params.b !== null) trackPickAB = [params.a, params.b];
      trackPickFrame = params.frame;
      const half = bestHalfPair();
      trackPairEx = half ? [half.a, half.b] : [];
      startTracked(params.dist, params.ref ?? shownMjd());
    }
  }

  function baseGrid(): Grid | null {
    return live ? live.grid : preview ? preview.grid : cachedData ? cachedData.grid : null;
  }

  // The simulated body's anchor date, frozen once chosen: the earlier date of the year pair, so
  // step 1 shows it in both images.
  function simAnchorMjd(): number {
    if (simRef !== null) return simRef;
    const y = pairs().year[0];
    let t = y ? Math.min(y.a.mjd, y.b.mjd) : Infinity;
    if (!y && loaded) for (const f of loaded.frames) if (f.exposure.detector === det && f.exposure.mjd < t) t = f.exposure.mjd;
    if (!Number.isFinite(t)) return 0;
    simRef = t;
    return t;
  }

  function setSim(on: boolean): void {
    simOn = on;
    diffCache = null;
    pairCache = null;
    if (planetStep === 2 && trackD !== null) startTracked(trackD, simAnchorMjd());
    else {
      rebuild();
      render();
    }
    persist();
  }

  function simShown(): boolean {
    return simOn && planetStep !== 0 && baseGrid() !== null;
  }

  function activeFrames(): Frame[] {
    if (!simShown()) return trackedFrames ?? (loaded ? loaded.frames : []);
    const fr = trackedFrames ?? (preview && det !== null ? detFrames.get(det) : undefined) ?? (loaded ? loaded.frames : []);
    return simFrames(fr, simAnchorGrid(baseGrid() as Grid), simAnchorMjd());
  }

  function pickMovie(): Movie | null {
    if (!loaded || det === null) return null;
    if (preview && !trackedFrames && !simShown()) {
      const f = detFrames.get(det);
      if (f && !(mode === 'visit-stack' && det === preview.defaultDetector)) return buildMovie(f, mode, det, loaded.target);
      return det === preview.defaultDetector ? preview.movie : null;
    }
    return buildMovie(activeFrames(), mode, det, loaded.target);
  }

  function mbText(n: number): string {
    return (n / 1e6).toFixed(1);
  }

  function previewBytes(d: Detector): number {
    return preview?.detectors.find((x) => x.detector === d)?.bytes ?? 0;
  }

  function everyReady(): boolean {
    return !preview || det === null || detFrames.has(det);
  }

  function everyReason(): string {
    if (detLoad) {
      const t = detLoad.total;
      const b = Math.min(detLoad.bytes, t > 0 ? t : detLoad.bytes);
      const what = detLoad.det === det ? 'every exposure' : `detector ${detLoad.det}`;
      if (t > 0) return `Loading ${what}, ${mbText(b)} of ${mbText(t)} MB`;
      return b > 0 ? `Loading ${what}, ${mbText(b)} MB so far` : `Loading ${what}`;
    }
    if (everyReady()) return '';
    if (det !== null && detFailed === det) return 'Every exposure could not be loaded for this detector.';
    return 'Every exposure is loading.';
  }

  function switchDetNow(d: Detector): void {
    det = d;
    resetTracking();
    resetChoices();
    player.stop();
    player.setIndex(0);
    rebuild();
    persist();
  }

  function startDetLoad(d: Detector, switchTo: boolean): void {
    if (!preview || !cachedSlug || detFrames.has(d)) return;
    if (detLoad && detLoad.det === d) {
      detLoad.switchTo = detLoad.switchTo || switchTo;
      return;
    }
    detLoad?.ctrl.abort();
    const rc = new AbortController();
    const slug = cachedSlug;
    const pv = preview;
    const mine = token;
    detFailed = null;
    const entry = { det: d, ctrl: rc, bytes: 0, total: previewBytes(d), switchTo };
    detLoad = entry;
    panel.setEveryNote(everyReason());
    loadCachedDetector(slug, d, {
      signal: rc.signal,
      onProgress: (p) => {
        if (disposed || mine !== token || detLoad !== entry) return;
        if (typeof p.bytes === 'number') entry.bytes = p.bytes;
        if (p.total >= 100_000) entry.total = p.total;
        panel.setEveryNote(everyReason());
      },
    })
      .then((r) => {
        if (disposed || mine !== token || pv !== preview) return;
        console.info(`[load] detector ${d} every exposure ready at ${Math.round(performance.now() - loadT0)} ms`);
        const sw = entry.switchTo;
        if (detLoad === entry) detLoad = null;
        detFrames.set(d, r.frames.slice().sort((x, y) => x.exposure.mjd - y.exposure.mjd));
        onDetLanded(d, sw);
        if (pickWaiting && lastPick && everyReady()) onPickAt(lastPick[0], lastPick[1]);
      })
      .catch((e: unknown) => {
        if (disposed || mine !== token) return;
        if (detLoad === entry) detLoad = null;
        if ((e as { code?: string } | null)?.code !== 'ABORTED') {
          detFailed = d;
          panel.setNotice('Every exposure for this detector could not be loaded. The visit stacks still work.');
        }
        render();
      });
  }

  function onDetLanded(d: Detector, switchTo: boolean): void {
    if (!loaded) return;
    let all: Frame[] = [];
    detFrames.forEach((f) => {
      all = all.concat(f);
    });
    loaded = { ...loaded, frames: all };
    pairMemo = null;
    matchedMemo = null;
    diffCache = null;
    pairCache = null;
    qualityKey = { movie: null, frame: null, n: 0, diff: '' };
    if (switchTo) {
      switchDetNow(d);
    } else if (d === det) {
      if (mode === 'single') rebuild();
      else render();
    } else {
      render();
    }
    ensureOverlayData();
    restorePlanet();
  }

  function rebuild(): void {
    if (!loaded || det === null) return;
    const prevMjd = movie && player.mode === 'stopped' ? (movie.frames[player.index]?.mjd ?? null) : null;
    try {
      movie = pickMovie();
    } catch {
      movie = null;
      if (trackedFrames && mode !== 'single') {
        try {
          mode = 'single';
          movie = buildMovie(trackedFrames, mode, det, loaded.target);
        } catch {
          movie = null;
        }
      }
    }
    if (!movie || movie.frames.length === 0) {
      movie = null;
      panel.showControls(false);
      stage.setNote('No images yet');
      return;
    }
    stage.setNote(archiveLine());
    const m = movie;
    const nearest = (mjd: number): number => {
      let best = 0;
      m.frames.forEach((f, i) => {
        if (Math.abs(f.mjd - mjd) < Math.abs(m.frames[best].mjd - mjd)) best = i;
      });
      return best;
    };
    const last = m.frames.length - 1;
    if (aUser !== null) {
      if (aMjd === null) aMjd = m.frames[Math.min(aUser, last)].mjd;
      else aUser = nearest(aMjd);
    }
    if (bUser !== null) {
      if (bMjd === null) bMjd = m.frames[Math.min(bUser, last)].mjd;
      else bUser = nearest(bMjd);
    }
    player.setCount(m.frames.length);
    if (pendingFrame !== null && loaded.cached) {
      player.setIndex(Math.min(pendingFrame, last));
      pendingFrame = null;
    } else if (prevMjd !== null) {
      player.setIndex(nearest(prevMjd));
    }
    syncAB();
    panel.showControls(true);
    render();
  }

  function frameInfos(m: Movie): FrameInfo[] {
    const n = m.frames.length;
    return m.frames.map((f, i) => {
      const label = m.mode === 'visit-stack' ? `Visit ${i + 1}` : `Exposure ${i + 1} of ${n}`;
      const date = formatDate(f.mjd);
      const base = `${label}, ${date}`;
      const caption = `${base}, ${wl(f.wavelength)}`;
      const detail =
        m.mode === 'visit-stack'
          ? f.nExposures <= 3
            ? `${f.nExposures} ${f.nExposures === 1 ? 'image' : 'images'}, noisier`
            : `${f.nExposures} exposures averaged${
                f.wavelengthMax - f.wavelengthMin >= 0.005
                  ? `, ${wl(f.wavelengthMin).replace(' um', '')} to ${wl(f.wavelengthMax)}`
                  : ''
              }`
          : `Detector ${m.detector}`;
      return {
        caption,
        detail,
        tip: base,
        option: caption,
        mjd: f.mjd,
        shortDate: date,
        wavelength: f.wavelength,
        visitIndex: f.visitIndex,
      };
    });
  }

  type MF = Movie['frames'][number];

  // Like-for-like image for two visit stacks: prebuilt in the preview, else built from every exposure.
  function pairedFor(m: Movie, fa: MF, fb: MF): DifferenceImage | null {
    if (m.mode !== 'visit-stack' || trackedFrames) return null;
    if (preview && m === preview.movie && !simShown()) {
      const hit = preview.differences.find((x) => x.visitA === fa.visitIndex && x.visitB === fb.visitIndex);
      if (hit) return hit.image;
    }
    const pool = simShown() ? activeFrames() : preview ? detFrames.get(m.detector) : loaded?.frames;
    if (!pool) return null;
    try {
      const r = visitDifference(pool, m.detector, fa.visitIndex, fb.visitIndex);
      return r.nPairs > 0 ? r : null;
    } catch {
      return null;
    }
  }

  function getDiff(m: Movie, a: number, b: number): DiffEntry | null {
    const fa = m.frames[a];
    const fb = m.frames[b];
    const key = `${detFrames.size}|${trackedFrames ? trackD : 0}|${drange}|${mode}|${m.detector}|${fa?.exposureIds.join(',')}|${fb?.exposureIds.join(',')}|${m.frames.length}|${loaded?.frames.length ?? 0}`;
    if (diffCache && diffCache.key === key) return diffCache;
    try {
      const d = m.mode === 'visit-stack' && !trackedFrames ? pairedFor(m, fa, fb) : difference(m.frames[a], m.frames[b]);
      if (!d) return null;
      const dr = diffRange(d.pixels, drange);
      diffCache = { key, d, range: dr.range, soft: dr.soft };
      return diffCache;
    } catch {
      return null;
    }
  }

  function movieStretch(m: Movie): Stretch {
    let per = stretchCache.get(m);
    if (!per) {
      per = new Map();
      stretchCache.set(m, per);
    }
    let st = per.get(contrast);
    if (!st) {
      st = displayStretch(
        m.frames.map((f) => f.pixels),
        m.stretch,
        contrast,
      );
      per.set(contrast, st);
    }
    return st;
  }

  const SMOOTH_CAP = 1200;

  function smoothK(w: number, h: number): number {
    if (!smooth) return 1;
    return Math.max(1, Math.min(stage.deviceScale(w, h), Math.floor(SMOOTH_CAP / Math.max(w, h))));
  }

  function cached(owner: object, key: string, make: () => Uint8ClampedArray): Uint8ClampedArray {
    let map = imgCache.get(owner);
    if (!map) {
      map = new Map();
      imgCache.set(owner, map);
    }
    const hit = map.get(key);
    if (hit) return hit;
    if (map.size > 12) map.clear();
    const v = make();
    map.set(key, v);
    return v;
  }

  function smoothRgba(
    norm: Float32Array,
    w: number,
    h: number,
    k: number,
    colour: (v: number) => Rgb,
  ): Uint8ClampedArray {
    const up = upsampleSmooth(norm, w, h, k);
    const out = new Uint8ClampedArray(up.length * 4);
    toRGBA(
      up,
      out,
      (v) => {
        const c = colour(v);
        return [c[0], c[1], c[2]];
      },
      [HATCH_A[0], HATCH_A[1], HATCH_A[2]],
    );
    return out;
  }

  function frameImage(m: Movie, f: Movie['frames'][number]): { rgba: Uint8ClampedArray; k: number } {
    const st = movieStretch(m);
    const k = smoothK(f.w, f.h);
    const key = `${k}|${st.lo}|${st.hi}|${st.scale}`;
    const rgba = cached(f.pixels, key, () => {
      if (k === 1) return renderPixels(f.pixels, f.w, f.h, st);
      const norm = new Float32Array(f.pixels.length);
      for (let i = 0; i < norm.length; i++) {
        const p = f.pixels[i];
        norm[i] = Number.isNaN(p) ? NaN : asinhNorm(p, st.lo, st.hi, st.scale);
      }
      return smoothRgba(norm, f.w, f.h, k, (v) => greyColor(Math.min(1, Math.max(0, v))));
    });
    return { rgba, k };
  }

  function diffImage(dr: DiffEntry): { rgba: Uint8ClampedArray; k: number } {
    const d = dr.d;
    const k = smoothK(d.w, d.h);
    const src = d.pixels;
    const range = dr.range;
    const soft = dr.soft;
    const rgba = cached(src, `${k}|${range}|${soft}`, () => {
      if (k === 1) return renderDiverging(src, d.w, d.h, range, soft);
      const norm = new Float32Array(src.length);
      // upsampleSmooth works in 0..1, so carry the signed -1..1 value as 0.5 + v / 2.
      for (let i = 0; i < norm.length; i++) norm[i] = 0.5 + divergingNorm(src[i], range, soft) / 2;
      return smoothRgba(norm, d.w, d.h, k, (v) => divergingColor(v * 2 - 1));
    });
    return { rgba, k };
  }

  function noteFor(d: DifferenceImage, fa: Movie['frames'][number], fb: Movie['frames'][number]): string {
    let text = 'Orange is where B is brighter, blue where A is brighter.';
    if (fa.targetXY && fb.targetXY) {
      const px = Math.hypot(fb.targetXY[0] - fa.targetXY[0], fb.targetXY[1] - fa.targetXY[1]);
      if (px > 0.5) {
        text += ` The target's predicted shift between A and B is ${(px * d.grid.scaleArcsec).toFixed(1)} arcsec.`;
      }
    }
    return text;
  }

  function compareInfo(
    dr: DiffEntry | null,
    same: boolean,
    fa: Movie['frames'][number],
    fb: Movie['frames'][number],
  ): CompareInfo {
    if (same || !dr) {
      return {
        rangeText: same ? 'Choose two different images for A and B.' : 'These two images could not be compared.',
        unit: 'MJy/sr',
        warning: null,
        note: '',
      };
    }
    const d = dr.d;
    return {
      rangeText: `Range -${sig2(dr.range)} to +${sig2(dr.range)} MJy/sr. Faint values are stretched so small residuals show.`,
      unit: 'MJy/sr',
      warning: d.wavelengthMatched
        ? null
        : `These two visits saw this spot at different wavelengths (${wl(d.wavelengthA)} and ${wl(d.wavelengthB)}). The pair is not like for like: leftovers can come from the star's colour, not from real change.`,
      note: noteFor(d, fa, fb),
    };
  }

  function readingLine(m: Movie, a: number, b: number): string {
    let text = 'Orange: brighter in B. Blue: brighter in A.';
    const meth = current && current.kind === 'diff' ? current.d.method : null;
    if (meth === 'paired-stack') text += ` ${PAIRED_READING}`;
    const t = loaded?.target;
    const fa = m.frames[a];
    const fb = m.frames[b];
    if (t && fa && fb && Number.isFinite(t.pmra) && Number.isFinite(t.pmdec) && (t.pmra !== 0 || t.pmdec !== 0)) {
      try {
        const pa = positionAt(t, fa.mjd);
        const pb = positionAt(t, fb.mjd);
        const cosd = Math.cos(((pa.dec + pb.dec) / 2) * (Math.PI / 180));
        const east = (pb.ra - pa.ra) * cosd * 3600;
        const north = (pb.dec - pa.dec) * 3600;
        const arcsec = Math.hypot(east, north);
        if (arcsec / m.grid.scaleArcsec > 0.5) {
          const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
          const ang = (Math.atan2(east, north) * 180) / Math.PI;
          const dir = names[Math.round((((ang % 360) + 360) % 360) / 45) % 8];
          text += ` ${t.name ?? 'The target'} moved ${arcsec.toFixed(1)} arcsec ${dir} between these images.`;
        }
      } catch {
        // position not available
      }
    }
    return text;
  }

  function diffSourceModel(): PanelModel['diffSource'] {
    if (!diffOn || !stackOption() || !movie) return null;
    const meth = current && current.kind === 'diff' ? current.d.method : null;
    const cur: DiffSource = movie.mode === 'single' ? 'matched' : 'paired';
    const ready = everyReady();
    let reason = '';
    if (!ready) reason = 'Single pair, and the like-for-like stack for other visits, need every exposure. Still loading.';
    else if (cur === 'paired' && meth !== 'paired-stack') reason = NO_PAIR_READING;
    return {
      current: cur,
      available: { paired: true, matched: ready && matchedPairFor() !== null },
      reason,
    };
  }

  function detectorList(): PanelModel['detectorList'] {
    const avail = loaded ? loaded.available : [];
    return DETECTORS.map((d) => {
      const info = avail.find((x) => x.detector === d);
      const [lo, hi] = DET_BANDS[d];
      const band = `Detector ${d}, about ${lo.toFixed(1)} to ${hi.toFixed(1)} um`;
      if (!info || info.count === 0) return { detector: d, label: `${band}, no images here`, enabled: false };
      let extra = '';
      if (preview && d !== preview.defaultDetector && !detFrames.has(d)) {
        const bytes = previewBytes(d);
        extra = detLoad && detLoad.det === d ? ', loading' : bytes > 0 ? `, ${mbText(bytes)} MB to load` : '';
      }
      return {
        detector: d,
        label: `${band}, ${info.visits} ${info.visits === 1 ? 'visit' : 'visits'}${extra}`,
        enabled: true,
      };
    });
  }

  function render(): void {
    if (disposed || !movie) return;
    const m = movie;
    const [a, b] = ab();
    const infos = frameInfos(m);
    const idx = Math.min(player.index, m.frames.length - 1);
    let compare: CompareInfo | null = null;
    let showFrame = m.frames[idx];

    if (diffOn) {
      const same = a === b;
      const dr = same ? null : getDiff(m, a, b);
      compare = compareInfo(dr, same, m.frames[a], m.frames[b]);
      if (dr) {
        const d = dr.d;
        const img = diffImage(dr);
        showFrame = m.frames[b];
        shownGrid = showFrame.grid;
        prepareOverlays(m, showFrame, [m.frames[a], m.frames[b]]);
        stage.setImage(img.rgba, d.w, d.h, img.k);
        stage.setOverlay(m.grid, showFrame.targetXY);
        current = { kind: 'diff', d };
      } else {
        showFrame = m.frames[b];
        paintFrame(m, showFrame);
      }
    } else {
      paintFrame(m, showFrame);
    }

    if (qualityKey.movie !== m || qualityKey.frame !== showFrame || qualityKey.diff !== (diffOn ? `${a}|${b}` : '') || qualityKey.n !== activeFrames().length) {
      qualityKey = { movie: m, frame: showFrame, n: activeFrames().length, diff: diffOn ? `${a}|${b}` : '' };
      quality.show(m, showFrame, activeFrames(), diffOn && a !== b ? { a: m.frames[a], b: m.frames[b] } : null);
    }

    const unitRange = diffOn && current && current.kind === 'diff' && diffCache ? diffCache.range : 0;
    stage.setKey({
      ramp:
        diffOn && current && current.kind === 'diff'
          ? { lo: `-${sig2(unitRange)}`, hi: `+${sig2(unitRange)}`, unit: 'MJy/sr' }
          : null,
      saturated: hasSat,
    });
    stage.setReading(diffOn && current && current.kind === 'diff' ? readingLine(m, a, b) : null);

    const tr = trackedFrames !== null && trackD !== null;
    let lowTol = false;
    const fa = m.frames[a];
    const fb = m.frames[b];
    ringState = null;
    if (planetStep === 1 && ringsOn && shownGrid) ringState = { kind: 'year', scaleArcsec: shownGrid.scaleArcsec };
    if (tr && planetStep === 2 && fa && fb && shownGrid) {
      const D = trackD as number;
      const t = loaded?.target;
      const tol = pxPer(D, fa.mjd, fb.mjd);
      let jumpArcsec: number | null = null;
      let jumpPx: number | null = null;
      if (t) {
        try {
          const pa = parallaxOffset(t.ra, t.dec, fa.mjd, D);
          const pb = parallaxOffset(t.ra, t.dec, fb.mjd, D);
          jumpArcsec = Math.hypot((pb.dRa - pa.dRa) * 3600, (pb.dDec - pa.dDec) * 3600);
          jumpPx = jumpArcsec / shownGrid.scaleArcsec;
        } catch {
          jumpArcsec = null;
        }
      }
      const span = Math.abs(fb.mjd - fa.mjd);
      planet.control.setReadout({ pxPerPercent: tol, jumpArcsec, jumpPx, spanDays: span });
      lowTol = tol < 0.3;
      ringState = { kind: 'orbit', radiusPx: ringRadiusPx(D, span, shownGrid.scaleArcsec) };
      panel.setPairMarks(
        m.frames.map((f, i) => (i !== a && pxPer(D, fa.mjd, f.mjd) >= 0.8 ? i : -1)).filter((i) => i >= 0),
      );
    } else {
      panel.setPairMarks([]);
    }
    let gapText: string | null = null;
    if (fa && fb && a !== b) {
      const n = gapDays(fa.mjd, fb.mjd);
      const um = Math.abs(fb.wavelength - fa.wavelength);
      const same =
        yearInfo &&
        Math.abs(Math.abs(yearInfo.b.mjd - yearInfo.a.mjd) - Math.abs(fb.mjd - fa.mjd)) < 20 &&
        (m.mode === 'single' || fa.exposureIds.includes(yearInfo.a.id) || fa.exposureIds.includes(yearInfo.b.id));
      gapText =
        same && yearInfo
          ? fill(COPY.gapFull, {
              n: Math.round(yearInfo.gapDays),
              um: yearInfo.wavelengthGapUm.toFixed(3),
              ch: yearInfo.wavelengthGapChannels.toFixed(1),
            })
          : fill(COPY.gapShort, { n, um: um.toFixed(3) });
    }
    const pr = pairs();
    let jumpAhead: number | null = null;
    const jt = loaded?.target;
    const jx = tr && fa && fb ? [fa.mjd, fb.mjd] : trackPairEx.length === 2 ? [trackPairEx[0].mjd, trackPairEx[1].mjd] : null;
    if (planetStep === 2 && jt && jx && shownGrid) {
      try {
        const D = trackD ?? 500;
        const pa = parallaxOffset(jt.ra, jt.dec, jx[0], D);
        const pb = parallaxOffset(jt.ra, jt.dec, jx[1], D);
        jumpAhead = (Math.hypot(pb.dRa - pa.dRa, pb.dDec - pa.dDec) * 3600) / shownGrid.scaleArcsec;
      } catch {
        jumpAhead = null;
      }
    }
    const simShownNow = simShown();
    simTag.hidden = !simShownNow;
    planet.set({
      simOn: simShownNow,
      listing: !live ? 'complete' : restCtrl !== null || !refineDone ? 'reading' : remaining.length > 0 ? 'more' : 'complete',
      partial: !!live && archiveStatus !== null && !archiveStatus.complete,
      refDate: planetStep === 2 && trackRef !== null ? mjdDate(trackRef) : null,
      jumpPx: jumpAhead,
      step: planetStep,
      ringsOn,
      gapDays: fa && fb && a !== b ? gapDays(fa.mjd, fb.mjd) : null,
      gapText,
      visits: loaded ? (loaded.available.find((x) => x.detector === m.detector)?.visits ?? 0) : 0,
      hasYear: pr.year.length > 0,
      hasHalf: pr.half.length > 0,
      lowTolerance: lowTol,
      restOffer: restOffer(),
    });
    stage.redraw();

    const cached = loaded ? loaded.cached : false;
    const model: PanelModel = {
      frames: infos,
      index: idx,
      a,
      b,
      playMode: player.mode,
      fps: player.fps,
      diff: diffOn,
      mode,
      det: m.detector,
      detectorList: detectorList(),
      size,
      sizeEnabled: !cached && search !== null,
      sizeNote: cached
        ? 'Prepared sets come in one size.'
        : `Bigger patches mean more to download. The pair is about ${Math.round((2 * FRAME_MB_ESTIMATE * size) / DEFAULT_SIZE)} MB at ${size} arcsec.`,
      smooth,
      contrast,
      overlays: { gaia: ov.gaia, wise: ov.wise, masked: ov.masked, adv: ov.adv },
      drange,
      wiseAvailable,
      overlayNote:
        ovLoading ||
        [
          gaiaTotal > OVERLAY_LIMIT ? `Brightest ${OVERLAY_LIMIT} of ${gaiaTotal} Gaia stars shown.` : '',
          wiseTotal > OVERLAY_LIMIT ? `Brightest ${OVERLAY_LIMIT} of ${wiseTotal} WISE sources shown.` : '',
        ]
          .filter(Boolean)
          .join(' '),
      compare,
      diffSource: diffSourceModel(),
      everyReady: everyReady(),
      everyReason: everyReason(),
    };
    panel.update(model);
  }

  function prepareOverlays(m: Movie, f: Movie['frames'][number], fs: Movie['frames'][number][] = [f]): void {
    const pick40 = (src: OverlaySource[] | null, on: boolean): { pts: ProjectedSource[]; total: number } => {
      if (!on || !src) return { pts: [], total: 0 };
      const inside = projectSources(src, f.grid, f.mjd).filter(
        (p) => p.x >= -0.5 && p.y >= -0.5 && p.x <= f.grid.w - 0.5 && p.y <= f.grid.h - 0.5,
      );
      inside.sort((p, q) => (p.src.mag ?? Infinity) - (q.src.mag ?? Infinity));
      return { pts: inside.slice(0, OVERLAY_LIMIT), total: inside.length };
    };
    const g = pick40(ovSources.gaia, ov.gaia);
    const w = pick40(ovSources.wise, ov.wise && wiseAvailable);
    drawGaia = g.pts;
    drawWise = w.pts;
    gaiaTotal = g.total;
    wiseTotal = w.total;
    const fl = activeFrames();
    const union = (bits: number): Uint8Array => {
      const out = new Uint8Array(f.w * f.h);
      for (const fr of fs) {
        const mm = maskFor(fr, fl, bits);
        const n = Math.min(out.length, mm.length);
        for (let i = 0; i < n; i++) if (mm[i]) out[i] = 1;
      }
      return out;
    };
    satMaskArr = union(FLAG_BITS.SATURATED);
    hasSat = satMaskArr.some((x) => x !== 0);
    drawMaskArr = ov.masked ? union(MASK_BAD_BITS) : null;
    advMaskArr = ov.adv ? union(MASK_ADVISORY_BITS) : null;
    drawMaskW = f.w;
  }

  function paintFrame(m: Movie, f: Movie['frames'][number]): void {
    shownGrid = f.grid;
    prepareOverlays(m, f);
    const img = frameImage(m, f);
    stage.setImage(img.rgba, f.w, f.h, img.k);
    stage.setOverlay(f.grid, f.targetXY);
    current = { kind: 'frame', pixels: f.pixels, w: f.w };
  }

  stage.onLayout(() => render());

  stage.setExtraDraw((c, toCanvas, scale, dpr) => {
    if (ringState && shownGrid) drawRings(c, toCanvas, scale, dpr, ringState, shownGrid);
    if (drawMaskArr) drawMask(c, drawMaskArr, drawMaskW, toCanvas, scale);
    if (advMaskArr) {
      drawMaskOutline(c, advMaskArr, drawMaskW, toCanvas, scale, dpr, { colour: '#ffd27a', alpha: 0.5 });
    }
    if (satMaskArr && hasSat) {
      drawMaskOutline(c, satMaskArr, drawMaskW, toCanvas, scale, dpr, { colour: '#e4e9f1', alpha: 0.5, edgeOnly: true });
    }
    if (drawGaia.length > 0) drawSources(c, drawGaia, toCanvas, scale, dpr);
    if (drawWise.length > 0) drawSources(c, drawWise, toCanvas, scale, dpr);
  });

  stage.setHover((gx, gy) => {
    cursor = [gx, gy];
    if (ringState) stage.redraw();
    const hit = hitTest(drawGaia, gx, gy, 1.5) ?? hitTest(drawWise, gx, gy, 1.5);
    return hit ? describeSource(hit.src) : null;
  });

  type RingState = { kind: 'year'; scaleArcsec: number } | { kind: 'orbit'; radiusPx: number };
  let ringState: RingState | null = null;

  function drawRings(
    c: CanvasRenderingContext2D,
    toCanvas: (gx: number, gy: number) => [number, number],
    scale: number,
    dpr: number,
    st: RingState,
    g: Grid,
  ): void {
    const centre: [number, number] =
      st.kind === 'year' ? (lastPick ?? cursor ?? [(g.w - 1) / 2, (g.h - 1) / 2]) : [(g.w - 1) / 2, (g.h - 1) / 2];
    const [cx, cy] = toCanvas(centre[0], centre[1]);
    const rings: { r: number; label: string }[] =
      st.kind === 'year'
        ? [
            { r: 7 * (6.15 / st.scaleArcsec), label: COPY.ring1000 },
            { r: 41 * (6.15 / st.scaleArcsec), label: COPY.ring300 },
          ]
        : [{ r: st.radiusPx, label: COPY.ringLabel }];
    c.save();
    c.font = `${Math.round(11 * dpr)}px 'Atkinson Hyperlegible Next', system-ui, sans-serif`;
    c.lineWidth = Math.max(1, Math.round(dpr));
    c.setLineDash([6 * dpr, 4 * dpr]);
    for (const ring of rings) {
      const rr = ring.r * scale;
      c.strokeStyle = 'rgba(228, 233, 241, 0.6)';
      c.beginPath();
      c.arc(cx, cy, rr, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
      c.textAlign = 'left';
      c.lineJoin = 'round';
      c.lineWidth = 3 * dpr;
      c.strokeStyle = 'rgba(4,6,13,0.85)';
      c.strokeText(ring.label, cx + rr + 4 * dpr, cy - 4 * dpr);
      c.fillStyle = 'rgba(228, 233, 241, 0.9)';
      c.fillText(ring.label, cx + rr + 4 * dpr, cy - 4 * dpr);
      c.lineWidth = Math.max(1, Math.round(dpr));
      c.setLineDash([6 * dpr, 4 * dpr]);
    }
    c.restore();
  }

  function nanText(i: number): string {
    return satMaskArr && satMaskArr[i] ? 'Saturated: no data here' : 'No data here';
  }

  stage.setValueProvider((x, y) => {
    if (!current) return '';
    if (current.kind === 'frame') {
      const v = current.pixels[y * current.w + x];
      return Number.isNaN(v) ? nanText(y * current.w + x) : `${v.toFixed(2)} MJy/sr`;
    }
    const d = current.d;
    const v = d.pixels[y * d.w + x];
    if (Number.isNaN(v)) return nanText(y * d.w + x);
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)} MJy/sr`;
  });

  const onPickAt = (fx: number, fy: number): void => {
    pickWaiting = false;
    if (!loaded || !movie) return;
    const w = gridToWorld(shownGrid ?? movie.grid, fx, fy);
    if (!everyReady()) {
      lastPick = [fx, fy];
      pickWaiting = true;
      stage.setPick([fx, fy]);
      stage.redraw();
      spectrum.wait('The spectrum needs every exposure. It is still loading.');
      return;
    }
    let pts;
    try {
      pts = spectrumAt(loaded.frames, w.ra, w.dec);
    } catch {
      return;
    }
    const dates = new Map<number, number>();
    for (const f of loaded.frames) {
      const prev = dates.get(f.exposure.visitIndex);
      if (prev === undefined || f.exposure.mjd < prev) dates.set(f.exposure.visitIndex, f.exposure.mjd);
    }
    lastPick = [fx, fy];
    stage.setPick([fx, fy]);
    stage.redraw();
    const order = Array.from(new Set(movie.frames.map((f) => f.visitIndex))).sort((x, y) => x - y);
    const visitNo = (vi: number): number => {
      const k = order.indexOf(vi);
      return k >= 0 ? k + 1 : vi + 1;
    };
    spectrum.show(
      pts,
      w,
      (vi) => {
        const mjd = dates.get(vi);
        return `Visit ${visitNo(vi)}${mjd !== undefined ? ', ' + formatDate(mjd) : ''}`;
      },
      visitNo,
      {
        slug: cachedSlug,
        exposures: (live ? live.detExposures : loadedExposures()).filter((e) => e.detector === det),
        gaia: preview?.gaia ?? cachedData?.gaia ?? [],
        pixelArcsec: (shownGrid ?? movie.grid).scaleArcsec,
        target: positionAt(loaded.target, movie.grid.epochMjd),
      },
    );
  };
  stage.onPick(onPickAt);

  function clearPick(): void {
    pickWaiting = false;
    lastPick = null;
    stage.setPick(null);
    spectrum.clear();
  }

  // ---- overlays data

  function toggleLayer(k: Layer): void {
    if (k === 'wise' && !wiseAvailable) return;
    ov[k] = !ov[k];
    if (ov[k]) ensureOverlayData();
    render();
    persist();
  }

  function ensureOverlayData(): void {
    if (!loaded) return;
    if (preview) {
      // The preview carries the brightest stars. The full list loads once, when an overlay is on.
      if (ov.gaia && !ovSources.gaia) ovSources.gaia = sourcesFromGaia(preview.gaia);
      if (ov.wise && !ovSources.wise) ovSources.wise = sourcesFromWise(preview.wise);
      if ((ov.gaia || ov.wise) && !starsRequested && cachedSlug) {
        starsRequested = true;
        const pv = preview;
        const mine = token;
        loadCachedStars(cachedSlug)
          .then((s) => {
            if (disposed || mine !== token || pv !== preview) return;
            ovSources.gaia = sourcesFromGaia(s.gaia);
            ovSources.wise = sourcesFromWise(s.wise);
            render();
          })
          .catch(() => undefined);
      }
      return;
    }
    if (cachedData) {
      if (ov.gaia && !ovSources.gaia) ovSources.gaia = sourcesFromGaia(cachedData.gaia);
      if (ov.wise && !ovSources.wise) ovSources.wise = sourcesFromWise(cachedData.wise);
      return;
    }
    if (!live) return;
    const grid = live.grid;
    const radius = (live.size / 2) * Math.SQRT2;
    const mine = ovToken;
    const need = (kind: 'gaia' | 'wise') => ov[kind] && ovSources[kind] === null && (kind === 'gaia' || wiseAvailable);
    if (need('gaia')) {
      ovLoading = 'Loading Gaia stars';
      gaiaCone(grid.ra0, grid.dec0, radius)
        .then((rows) => {
          if (disposed || mine !== ovToken) return;
          ovSources.gaia = sourcesFromGaia(rows);
          ovLoading = '';
          render();
        })
        .catch(() => {
          if (disposed || mine !== ovToken) return;
          ovSources.gaia = [];
          ovLoading = 'Gaia stars could not be loaded.';
          render();
        });
    }
    if (need('wise')) {
      ovLoading = 'Loading WISE sources';
      wiseCone(grid.ra0, grid.dec0, radius)
        .then((rows) => {
          if (disposed || mine !== ovToken) return;
          ovSources.wise = sourcesFromWise(rows);
          ovLoading = '';
          render();
        })
        .catch(() => {
          if (disposed || mine !== ovToken) return;
          ovSources.wise = [];
          ovLoading = 'WISE sources could not be loaded.';
          render();
        });
    }
  }

  function resetOverlayData(): void {
    ovToken++;
    ovSources.gaia = null;
    ovSources.wise = null;
    ovLoading = '';
  }

  // ---- header

  function headerFor(target: Target | null): void {
    const fallback =
      params.q ?? (params.ra !== null && params.dec !== null ? `${params.ra}, ${params.dec}` : 'Viewer');
    if (!target) {
      panel.setTitleNote(null);
      const nq = normalizeName(params.q ?? '');
      const hit = nq ? listCached().find((c) => normalizeName(c.name) === nq || normalizeName(c.slug) === nq) : undefined;
      panel.setHeader(hit ? hit.name : fallback, hit ? hit.blurb : '');
      return;
    }
    const name = target.name ?? fallback;
    const isWise =
      cachedSlug === 'wise-0855' ||
      cachedData?.slug === 'wise-0855' ||
      normalizeName(`${target.name ?? ''} ${params.q ?? ''}`).includes('wise0855');
    const noteSlug: string | null = cachedSlug ?? cachedData?.slug ?? (isWise ? 'wise-0855' : null);
    const blurb = noteSlug ? listCached().find((c) => c.slug === noteSlug)?.blurb : undefined;
    panel.setTitleNote(targetNote(noteSlug) ?? blurb ?? null);
    panel.setHeader(
      name,
      `RA ${formatRaDeg(target.ra)} deg, Dec ${formatDecDeg(target.dec)} deg${det !== null ? `. Detector ${det}.` : ''}`,
    );
  }

  function adopt(res: Loaded): void {
    if (!res.cached || det === null || !res.available.some((x) => x.detector === det)) det = res.det;
    loaded = res;
    headerFor(res.target);
    rebuild();
  }

  // ---- loading

  function visitsWithTwo(frames: Frame[]): number {
    const counts = new Map<number, number>();
    for (const f of frames) counts.set(f.exposure.visitIndex, (counts.get(f.exposure.visitIndex) ?? 0) + 1);
    let n = 0;
    counts.forEach((c) => {
      if (c >= 2) n++;
    });
    return n;
  }

  function bytesOf(frames: Frame[]): number {
    let t = 0;
    for (const f of frames) t += f.bytes > 0 ? f.bytes : 0;
    return t;
  }

  function showRest(): void {
    if (!live) {
      panel.setRest(null);
      return;
    }
    const n = remaining.length;
    if (n === 0) {
      panel.setRest(null);
      return;
    }
    const all = pairFrames.concat(landed);
    const withBytes = all.filter((f) => f.bytes > 0);
    const perFrame = withBytes.length > 0 ? bytesOf(withBytes) / withBytes.length / 1e6 : FRAME_MB_ESTIMATE;
    const mb = Math.round(n * perFrame);
    const single = mode === 'single';
    const d = det ?? 0;
    if (restCtrl) {
      const real = bytesOf(landed.slice(restBase));
      panel.setRest({
        kind: 'loading',
        done: landed.length,
        total: restTotal,
        mb: real > 0 ? Math.round(real / 1e6) : Math.round(landed.length * FRAME_MB_ESTIMATE),
        exact: real > 0,
      });
    } else if (landed.length > 0) {
      panel.setRest({ kind: 'stopped', n, mb, loaded: landed.length, total: restTotal, single, det: d, exact: false });
    } else {
      panel.setRest({ kind: 'optin', n, mb, single, det: d, exact: false });
    }
  }

  function adoptLive(final: boolean): void {
    if (!loaded || !live) return;
    const all = pairFrames.concat(landed);
    const before = mode;
    if (!modeUser && mode === 'single' && visitsWithTwo(all) >= 2) mode = 'visit-stack';
    adopt({ ...loaded, frames: all });
    if (mode !== before) showRest();
    if (final) persist();
  }

  function startRest(): void {
    if (!live || !loaded || restCtrl || remaining.length === 0) return;
    const mine = ++token;
    const rc = new AbortController();
    restCtrl = rc;
    const toLoad = remaining.slice();
    restTotal = landed.length + toLoad.length;
    const doneBefore = landed.length;
    const baseLanded = landed.slice();
    let landedNow: Frame[] = [];
    restBase = baseLanded.length;
    const isLive = () => !disposed && mine === token;
    showRest();
    loadRest(
      live.grid,
      toLoad,
      {
        onProgress: (done) => {
          if (!isLive()) return;
          const real = bytesOf(landedNow);
          panel.setRest({
            kind: 'loading',
            done: doneBefore + done,
            total: restTotal,
            mb: real > 0 ? Math.round(real / 1e6) : Math.round(done * FRAME_MB_ESTIMATE),
            exact: real > 0,
          });
        },
        onFrames: (got) => {
          if (!isLive()) return;
          landedNow = got;
          landed = baseLanded.concat(got);
          adoptLive(false);
        },
      },
      rc.signal,
    )
      .then((r) => {
        if (!isLive()) return;
        restCtrl = null;
        landed = baseLanded.concat(r.landed);
        const ids = new Set(landed.map((f) => f.exposure.id));
        remaining = remaining.filter((e) => !ids.has(e.id));
        if (r.failed > 0) {
          remaining = [];
          panel.setNotice(`${r.failed} of ${toLoad.length} exposures could not be read and were skipped.`);
        }
        adoptLive(true);
        showRest();
        if (restAgain) {
          restAgain = false;
          if (remaining.length > 0 && remaining.length <= AUTO_REST_LIMIT) startRest();
        }
      })
      .catch(() => {
        if (!isLive()) return;
        restCtrl = null;
        panel.setNotice('Some exposures could not be loaded. What arrived is shown.');
        showRest();
      });
  }

  let loadT0 = performance.now();
  let loadBytes: LoadingBytes = { bytes: null, total: null };

  function loadName(): string {
    return skyName ?? params.q ?? (params.ra !== null && params.dec !== null ? `${params.ra}, ${params.dec}` : '');
  }

  function showLoadingNote(): void {
    stage.setNote(loadingLine(loadName(), loadBytes));
  }

  function archiveLine(): string | null {
    const s = archiveStatus;
    if (!s || s.complete) return null;
    return `${s.answered} of ${s.total} archive collections answered; still asking the rest`;
  }

  function showArchiveLine(): void {
    const line = archiveLine();
    panel.setArchiveLine(line);
    if (movie && rootEl.dataset.state === 'ready') stage.setNote(line);
  }

  // The archive list grew. Visit numbers may have changed, so everything keyed by them is rebuilt
  // from the new list; what is on screen stays until the rebuilt state replaces it.
  function growArchive(list: Exposure[]): void {
    if (!live || !loaded || !search) return;
    const was = new Map(search.exposures.map((e) => [e.id, e.visitIndex]));
    if (list.length === was.size && list.every((e) => was.get(e.id) === e.visitIndex)) return;
    const byId = new Map(list.map((e) => [e.id, e]));
    const d = det ?? loaded.det;
    // the visitor's A and B stay by date while exposures from that date still exist
    const near = (m: number | null) => m !== null && list.some((e) => e.detector === d && Math.abs(e.mjd - m) <= 2);
    if (aMjd !== null && !near(aMjd)) {
      aUser = null;
      aMjd = null;
    }
    if (bMjd !== null && !near(bMjd)) {
      bUser = null;
      bMjd = null;
    }
    const remap = (f: Frame): Frame => {
      const e = byId.get(f.exposure.id);
      return e ? { ...f, exposure: { ...f.exposure, visitIndex: e.visitIndex, inStack: e.inStack } } : f;
    };
    pairFrames = pairFrames.map(remap);
    landed = landed.map(remap);
    search = withExposures(search, list);
    live.detExposures = list.filter((e) => e.detector === d);
    pairMemo = null;
    matchedMemo = null;
    pairCache = null;
    diffCache = null;
    if (refineDone) {
      const have = new Set(pairFrames.concat(landed).map((f) => f.exposure.id));
      remaining = live.detExposures.filter((e) => !have.has(e.id));
      live.rest = remaining;
    }
    loaded = { ...loaded, available: search.available };
    adoptLive(false);
    if (!refineDone) return;
    if (restCtrl) restAgain = true;
    else if (remaining.length > 0 && remaining.length <= AUTO_REST_LIMIT) startRest();
    else showRest();
  }

  function onArchiveUpdate(list: Exposure[], status: ExposureUpdateStatus): void {
    archiveStatus = status;
    showArchiveLine();
    if (!live || !loaded || !search || rootEl.dataset.state !== 'ready') {
      pendingList = list;
      return;
    }
    growArchive(list);
  }

  function onLoadProgress(p: Progress): void {
    const b = bytesFromProgress(p);
    if (b.bytes !== null) loadBytes = b;
    showLoadingNote();
    panel.setProgress(p);
  }

  function resetForLoad(): void {
    ctrl?.abort();
    restCtrl?.abort();
    restCtrl = null;
    detLoad?.ctrl.abort();
    detLoad = null;
    detFailed = null;
    detFrames.clear();
    preview = null;
    cachedSlug = null;
    starsRequested = false;
    loaded = null;
    movie = null;
    live = null;
    pairFrames = [];
    landed = [];
    remaining = [];
    diffCache = null;
    pairCache = null;
    qualityKey = { movie: null, frame: null, n: 0, diff: '' };
    player.stop();
    resetTracking();
    clearPick();
    resetOverlayData();
    rootEl.dataset.state = 'loading';
    panel.clearStatus();
    panel.setRest(null);
    panel.setMatchNote(null);
    panel.setMockLine(false);
    panel.showSkeleton();
    headerFor(null);
    loadBytes = { bytes: null, total: null };
    loadT0 = performance.now();
    showLoadingNote();
  }

  function handleResult(res: LoadResult): void {
    panel.setProgress(null);
    console.info(`[load] ${res.cached ? 'prepared set' : 'first look'} ready at ${Math.round(performance.now() - loadT0)} ms`);
    panel.setArchiveLine(res.cached ? null : archiveLine());
    askedAt = res.asked ?? null;
    panel.setPreparedNote(res.viaPosition && res.preview ? (res.target.name ?? res.cachedSlug ?? '') : null);
    panel.setMockLine(res.cached && res.preview ? isSimulated(res.preview) : liveIsMock);
    search = res.search ?? search;
    cachedData = res.cachedData;
    preview = res.preview;
    cachedSlug = res.cachedSlug;
    detFrames.clear();
    live = res.live;
    if (live) {
      size = live.size;
      pairFrames = res.frames;
      remaining = [];
      if (!modeUser) mode = 'single';
      if (!abTouched && aUser === null && bUser === null && res.frames.length >= 2) {
        aUser = 0;
        bUser = 1;
      }
      panel.setMatchNote(
        res.matched
          ? null
          : 'These two images are not at the same wavelength yet, so brightness differences may be colour, not change.',
      );
    } else {
      panel.setMatchNote(null);
    }
    adopt({
      target: res.target,
      frames: res.frames,
      det: res.det,
      available: res.available,
      cached: res.cached,
    });
    if (preview && movie && !abTouched && aUser === null && bUser === null) {
      const pr = preview.pairs.year ?? preview.pairs.halfYear;
      if (pr) {
        const i = movie.frames.findIndex((f) => f.visitIndex === pr.frames[0].exposure.visitIndex);
        const j = movie.frames.findIndex((f) => f.visitIndex === pr.frames[1].exposure.visitIndex);
        if (i >= 0 && j >= 0 && i !== j) setPair(Math.min(i, j), Math.max(i, j));
      }
    }
    rootEl.dataset.state = 'ready';
    if (res.failed > 0) {
      panel.setNotice(`${res.failed} of ${res.total} exposures could not be read and were skipped.`);
    }
    ensureOverlayData();
    render();
    restorePlanet();
    if (live) startRefine(res);
    if (live && pendingList) {
      const late = pendingList;
      pendingList = null;
      growArchive(late);
    }
    showArchiveLine();
    if (preview) {
      const want = params.det !== null && params.det !== det && res.available.some((x) => x.detector === params.det) ? params.det : null;
      if (want !== null) startDetLoad(want, true);
      else startDetLoad(det as Detector, false);
    }
  }

  function startRefine(res: LoadResult): void {
    if (!live || !ctrl) return;
    const mine = token;
    const signal = ctrl.signal;
    const lv = live;
    const finish = (annotated: Exposure[]) => {
      if (disposed || mine !== token) return;
      const have = new Set(pairFrames.map((f) => f.exposure.id));
      remaining = annotated.filter((e) => !have.has(e.id));
      lv.rest = remaining;
      refineDone = true;
      if (remaining.length > 0 && remaining.length <= AUTO_REST_LIMIT) startRest();
      else showRest();
    };
    refineBest(res.target, search ? search.exposures : lv.detExposures, lv.grid, res.det, signal)
      .then((r) => {
        if (disposed || mine !== token) return;
        console.info(`[load] best pair ready at ${Math.round(performance.now() - loadT0)} ms`);
        const have = new Set(pairFrames.map((f) => f.exposure.id));
        if (r.frames.length >= 2 && !(have.has(r.frames[0].exposure.id) && have.has(r.frames[1].exposure.id))) {
          pairFrames = r.frames;
          if (!abTouched) {
            aUser = 0;
            bUser = 1;
            aMjd = null;
            bMjd = null;
          }
          adoptLive(false);
        }
        if (r.matched) panel.setMatchNote(null);
        finish(lv.detExposures);
      })
      .catch(() => {
        if (disposed || mine !== token) return;
        finish(lv.detExposures);
      });
  }

  function handleError(e: unknown): void {
    console.info(`[load] stopped: ${(e as { code?: string } | null)?.code ?? 'unknown'}`);
    panel.showControls(false);
    const code = (e as { code?: string } | null)?.code;
    if (code === 'ABORTED') {
      panel.setStopped('Loading stopped.', true);
      rootEl.dataset.state = 'error';
      stage.setNote('Loading stopped');
      return;
    }
    const q = params.q ?? (params.ra !== null && params.dec !== null ? `${params.ra} ${params.dec}` : null);
    if (code === 'NO_COVERAGE' && (e as Error).message === ONCE_ONLY) {
      panel.setError('ONCE', q, safeCached());
    } else {
      const known = (KNOWN_CODES as readonly string[]).includes(code ?? '');
      panel.setError(known ? (code as (typeof KNOWN_CODES)[number]) : 'OTHER', q, safeCached());
    }
    rootEl.dataset.state = 'error';
    stage.setNote('No image to show');
  }

  function startLoad(): void {
    console.info('[load] start');
    archiveCtrl?.abort();
    const archive = new AbortController();
    archiveCtrl = archive;
    const gen = ++loadGen;
    archiveStatus = null;
    pendingList = null;
    restAgain = false;
    panel.setArchiveLine(null);
    refineDone = false;
    simRef = simOn ? params.ref : null;
    resetForLoad();
    search = null;
    cachedData = null;
    const mine = ++token;
    ctrl = new AbortController();
    const signal = ctrl.signal;
    const isCurrent = () => !disposed && mine === token;
    // a stopped first load stops the archive too; a later detector switch leaves it running
    signal.addEventListener('abort', () => {
      if (!loaded) archive.abort();
    });

    skyName = null;
    panel.setSkyEntry(null);
    if (params.q === null && params.ra !== null && params.dec !== null) {
      findCachedByPosition(params.ra, params.dec)
        .then((hit) => {
          if (!isCurrent() || !hit) return;
          skyName = hit.name;
          panel.setSkyEntry(hit.name);
        })
        .catch(() => undefined);
    }

    loadViewer(
      { q: params.q, ra: params.ra, dec: params.dec, det: params.det, size: params.size },
      {
        onStage: (p: Progress) => {
          if (isCurrent()) onLoadProgress(p);
        },
        onUpdate: (list, status) => {
          if (!disposed && gen === loadGen && !archive.signal.aborted) onArchiveUpdate(list, status);
        },
        archiveSignal: archive.signal,
      },
      signal,
    )
      .then((res) => {
        if (isCurrent()) handleResult(res);
      })
      .catch((e: unknown) => {
        if (isCurrent()) handleError(e);
      });
  }

  function switchLive(newDet: Detector | null, newSize: number): void {
    if (!search) return;
    const keepSearch = search;
    resetForLoad();
    search = keepSearch;
    const mine = ++token;
    ctrl = new AbortController();
    const isCurrent = () => !disposed && mine === token;
    resetChoices();
    if (!modeUser) mode = 'single';
    loadFirst(
      keepSearch,
      newDet,
      newSize,
      {
        onStage: (p: Progress) => {
          if (isCurrent()) panel.setProgress(p);
        },
      },
      ctrl.signal,
    )
      .then((res) => {
        if (!isCurrent()) return;
        det = res.det;
        handleResult(res);
        persist();
      })
      .catch((e: unknown) => {
        if (isCurrent()) handleError(e);
      });
  }

  // ---- keyboard

  function onKey(ev: KeyboardEvent): void {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (ev.key === 'Escape') {
      if (panel.closeHelp()) ev.preventDefault();
      return;
    }
    if (ev.key === '?') {
      ev.preventDefault();
      panel.toggleHelp();
      return;
    }
    if (!movie) return;
    if (ev.key === 'd' || ev.key === 'D') {
      ev.preventDefault();
      setDiff(!diffOn);
      return;
    }
    if (ev.key === 'g' || ev.key === 'G') {
      ev.preventDefault();
      toggleLayer('gaia');
      return;
    }
    if (diffOn) return;
    if (ev.key === ' ' || ev.code === 'Space') {
      if (tag === 'BUTTON') return;
      ev.preventDefault();
      if (player.mode === 'stopped') syncAB();
      player.toggleMotion();
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      player.step(-1);
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      player.step(1);
    }
  }
  document.addEventListener('keydown', onKey);

  if (hasTarget(params)) {
    startLoad();
  } else {
    rootEl.dataset.state = 'empty';
    stage.setNote('Nothing loaded yet');
    panel.showEmpty(safeCached());
  }

  return () => {
    disposed = true;
    token++;
    archiveCtrl?.abort();
    ctrl?.abort();
    restCtrl?.abort();
    trackCtrl?.abort();
    planet.dispose();
    player.dispose();
    document.removeEventListener('keydown', onKey);
    stage.dispose();
    panel.dispose();
    spectrum.dispose();
    quality.dispose();
    rootEl.remove();
  };
};
