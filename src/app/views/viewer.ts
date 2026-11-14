import './../../ui/viewer.css';
import type { Mount } from '../types';
import { prefersReducedMotion } from '../motion';
import {
  buildMovie,
  difference,
  gaiaCone,
  gridToWorld,
  listCached,
  saturatedSources,
  spectrumAt,
  wiseAvailable,
  wiseCone,
} from '../data';
import type {
  CachedTarget,
  DifferenceImage,
  Detector,
  Exposure,
  Frame,
  Movie,
  MovieMode,
  Progress,
  Target,
} from '../data';
import { formatDate, createPanel } from '../viewer/panel';
import type { CompareInfo, FrameInfo, PanelModel } from '../viewer/panel';
import { createPlayer } from '../viewer/player';
import {
  AUTO_REST_LIMIT,
  DEFAULT_SIZE,
  DET_BANDS,
  FRAME_MB_ESTIMATE,
  ONCE_ONLY,
  findCachedByPosition,
  loadPair,
  loadRest,
  loadViewer,
} from '../viewer/load';
import type { DetInfo, LiveContext, LiveSearch, LoadResult } from '../viewer/load';
import { renderDiverging, renderPixels, robustSigma } from '../viewer/render';
import { createStage, formatDecDeg, formatRaDeg } from '../viewer/stage';
import { hasTarget, readParams, writeParams } from '../viewer/state';
import { createSpectrumPanel } from '../viewer/spectrum';
import { createQualityPanel } from '../viewer/quality';
import {
  describeSource,
  drawMask,
  drawSaturated,
  drawSources,
  hitTest,
  maskFor,
  projectSources,
  sourcesFromGaia,
  sourcesFromWise,
} from '../viewer/overlays';
import type { OverlaySource, ProjectedSource } from '../viewer/overlays';

interface Loaded {
  target: Target;
  frames: Frame[];
  det: Detector;
  available: DetInfo[];
  cached: boolean;
}

type Layer = 'gaia' | 'wise' | 'masked';

const SIGMA_RANGE = 5;
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
  let movie: Movie | null = null;
  let mode: MovieMode = params.mode;
  let det: Detector | null = params.det;
  let aUser: number | null = params.a;
  let bUser: number | null = params.b;
  let diffOn = params.diff;
  let snr = params.snr;
  let size = params.size ?? DEFAULT_SIZE;
  let pendingFrame: number | null = params.frame;
  let modeUser = new URLSearchParams(location.search).has('mode');
  let aMjd: number | null = null;
  let bMjd: number | null = null;
  let ctrl: AbortController | null = null;
  let token = 0;
  let diffCache: { key: string; d: DifferenceImage; range: number } | null = null;
  let current: { kind: 'frame'; pixels: Float32Array; w: number } | { kind: 'diff'; d: DifferenceImage } | null = null;

  // live state
  let search: LiveSearch | null = null;
  let cachedData: CachedTarget | null = null;
  let live: LiveContext | null = null;
  let pairFrames: Frame[] = [];
  let landed: Frame[] = [];
  let remaining: Exposure[] = [];
  let restTotal = 0;
  let restCtrl: AbortController | null = null;
  let skyName: string | null = null;

  // overlays and spectrum
  const ov: Record<Layer, boolean> = {
    gaia: params.overlays.includes('gaia'),
    wise: params.overlays.includes('wise'),
    masked: params.overlays.includes('masked'),
  };
  const ovSources: { gaia: OverlaySource[] | null; wise: OverlaySource[] | null } = { gaia: null, wise: null };
  let ovLoading = '';
  let ovToken = 0;
  let drawGaia: ProjectedSource[] = [];
  let drawWise: ProjectedSource[] = [];
  let drawMaskArr: Uint8Array | null = null;
  let drawMaskW = 0;
  let drawSat: { x: number; y: number }[] = [];
  let qualityKey: { movie: Movie | null; frame: unknown; n: number } = { movie: null, frame: null, n: 0 };

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
      if (loaded && !loaded.cached && search) {
        det = d;
        switchLive(d, size);
        return;
      }
      det = d;
      resetChoices();
      player.stop();
      player.setIndex(0);
      rebuild();
      persist();
    },
    setSize: (n) => {
      if (n === size || !search || (loaded && loaded.cached)) return;
      size = n;
      switchLive(det, n);
    },
    setDiff: (on) => setDiff(on),
    setSnr: (on) => {
      snr = on;
      render();
      persist();
    },
    setA: (i) => {
      aUser = i;
      aMjd = movie ? (movie.frames[i]?.mjd ?? null) : null;
      syncAB();
      render();
      persist();
    },
    setB: (i) => {
      bUser = i;
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
    openPrepared: () => {
      if (skyName) ctx.go('viewer', { q: skyName });
    },
  });
  panel.attach(spectrum.el, quality.el);
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
  }

  function defaultPair(m: Movie): [number, number] {
    const n = m.frames.length;
    const key = `${m.mode}|${m.detector}|${n}|${loaded?.frames.length ?? 0}`;
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

  function setDiff(on: boolean): void {
    diffOn = on;
    if (on) player.stop();
    render();
    persist();
  }

  function persist(): void {
    if (disposed || player.mode !== 'stopped') return;
    const layers = (['gaia', 'wise', 'masked'] as Layer[]).filter((k) => ov[k]);
    writeParams({
      mode: mode === 'single' ? 'single' : null,
      det: det !== null ? String(det) : null,
      a: aUser !== null ? String(aUser) : null,
      b: bUser !== null ? String(bUser) : null,
      diff: diffOn ? '1' : null,
      snr: diffOn && snr ? '1' : null,
      frame: player.index > 0 ? String(player.index) : null,
      size: size !== DEFAULT_SIZE ? String(size) : null,
      overlays: layers.length > 0 ? layers.join(',') : null,
    });
  }

  // ---- movie

  function rebuild(): void {
    if (!loaded || det === null) return;
    const prevMjd = movie && player.mode === 'stopped' ? (movie.frames[player.index]?.mjd ?? null) : null;
    try {
      movie = buildMovie(loaded.frames, mode, det, loaded.target);
    } catch {
      movie = null;
    }
    if (!movie || movie.frames.length === 0) {
      movie = null;
      panel.showControls(false);
      stage.setNote('No images yet');
      return;
    }
    stage.setNote(null);
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
          ? f.nExposures > 1
            ? `${f.nExposures} exposures averaged${
                f.wavelengthMax - f.wavelengthMin >= 0.005
                  ? `, ${wl(f.wavelengthMin).replace(' um', '')} to ${wl(f.wavelengthMax)}`
                  : ''
              }`
            : '1 exposure'
          : `Detector ${m.detector}`;
      return { caption, detail, tip: base, option: caption, mjd: f.mjd };
    });
  }

  function getDiff(m: Movie, a: number, b: number): { d: DifferenceImage; range: number } | null {
    const key = `${mode}|${m.detector}|${a}|${b}|${m.frames.length}|${loaded?.frames.length ?? 0}`;
    if (diffCache && diffCache.key === key) return diffCache;
    try {
      const d = difference(m.frames[a], m.frames[b]);
      const smax = Math.max(Math.abs(d.stretch.lo), Math.abs(d.stretch.hi));
      const sigma = robustSigma(d.pixels);
      const range = sigma > 0 ? Math.min(SIGMA_RANGE * sigma, smax > 0 ? smax : Infinity) : smax;
      diffCache = { key, d, range: range > 0 ? range : 1 };
      return diffCache;
    } catch {
      return null;
    }
  }

  function noteFor(d: DifferenceImage, fa: Movie['frames'][number], fb: Movie['frames'][number]): string {
    let text =
      'Orange is where B is brighter, blue where A is brighter. Bright stars often leave a two-toned smudge even when nothing moved; a real mover leaves a pair offset along its path.';
    if (fa.targetXY && fb.targetXY) {
      const px = Math.hypot(fb.targetXY[0] - fa.targetXY[0], fb.targetXY[1] - fa.targetXY[1]);
      if (px > 0.5) {
        text += ` The target's predicted shift between A and B is ${(px * d.grid.scaleArcsec).toFixed(1)} arcsec.`;
      }
    }
    return text;
  }

  function compareInfo(
    dr: { d: DifferenceImage; range: number } | null,
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
      rangeText: snr
        ? `Range -${SIGMA_RANGE} to +${SIGMA_RANGE} sigma`
        : `Range -${sig2(dr.range)} to +${sig2(dr.range)} MJy/sr, about five times the background noise`,
      unit: snr ? 'sigma' : 'MJy/sr',
      warning: d.wavelengthMatched
        ? null
        : `These two visits saw this spot at different wavelengths (${wl(d.wavelengthA)} and ${wl(d.wavelengthB)}). The pair is not like for like: leftovers can come from the star's colour, not from real change.`,
      note: noteFor(d, fa, fb),
    };
  }

  function detectorList(): PanelModel['detectorList'] {
    const avail = loaded ? loaded.available : [];
    return DETECTORS.map((d) => {
      const info = avail.find((x) => x.detector === d);
      const [lo, hi] = DET_BANDS[d];
      const band = `Detector ${d}, ${lo.toFixed(2)} to ${hi.toFixed(2)} um`;
      if (!info || info.count === 0) return { detector: d, label: `${band}, no images here`, enabled: false };
      return {
        detector: d,
        label: `${band}, ${info.visits} ${info.visits === 1 ? 'visit' : 'visits'}`,
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
        const rgba = snr
          ? renderDiverging(d.snr, d.w, d.h, SIGMA_RANGE)
          : renderDiverging(d.pixels, d.w, d.h, dr.range);
        showFrame = m.frames[b];
        prepareOverlays(m, showFrame);
        stage.setImage(rgba, d.w, d.h);
        stage.setOverlay(m.grid, showFrame.targetXY);
        current = { kind: 'diff', d };
      } else {
        showFrame = m.frames[b];
        paintFrame(m, showFrame);
      }
    } else {
      paintFrame(m, showFrame);
    }

    if (qualityKey.movie !== m || qualityKey.frame !== showFrame || qualityKey.n !== (loaded?.frames.length ?? 0)) {
      qualityKey = { movie: m, frame: showFrame, n: loaded?.frames.length ?? 0 };
      quality.show(m, showFrame, loaded ? loaded.frames : []);
    }

    const cached = loaded ? loaded.cached : false;
    const model: PanelModel = {
      frames: infos,
      index: idx,
      a,
      b,
      playMode: player.mode,
      fps: player.fps,
      diff: diffOn,
      snr,
      mode,
      det: m.detector,
      detectorList: detectorList(),
      size,
      sizeEnabled: !cached && search !== null,
      sizeNote: cached
        ? 'Prepared sets come in one size.'
        : `Bigger patches mean more to download. The pair is about ${Math.round((2 * FRAME_MB_ESTIMATE * size) / DEFAULT_SIZE)} MB at ${size} arcsec.`,
      overlays: { gaia: ov.gaia, wise: ov.wise, masked: ov.masked },
      wiseAvailable,
      overlayNote: ovLoading,
      compare,
    };
    panel.update(model);
  }

  function prepareOverlays(m: Movie, f: Movie['frames'][number]): void {
    drawGaia = ov.gaia && ovSources.gaia ? projectSources(ovSources.gaia, m.grid, f.mjd) : [];
    drawWise = ov.wise && wiseAvailable && ovSources.wise ? projectSources(ovSources.wise, m.grid, f.mjd) : [];
    if (ov.masked && loaded) {
      drawMaskArr = maskFor(f, loaded.frames);
      drawMaskW = f.w;
      const ids = new Set(f.exposureIds);
      drawSat = [];
      for (const fr of loaded.frames) {
        if (!ids.has(fr.exposure.id)) continue;
        try {
          for (const s of saturatedSources(fr)) drawSat.push({ x: s.x, y: s.y });
        } catch {
          // no saturation info for this frame
        }
      }
    } else {
      drawMaskArr = null;
      drawSat = [];
    }
  }

  function paintFrame(m: Movie, f: Movie['frames'][number]): void {
    prepareOverlays(m, f);
    stage.setImage(renderPixels(f.pixels, f.w, f.h, m.stretch), f.w, f.h);
    stage.setOverlay(f.grid, f.targetXY);
    current = { kind: 'frame', pixels: f.pixels, w: f.w };
  }

  stage.setExtraDraw((c, toCanvas, scale, dpr) => {
    if (drawMaskArr) drawMask(c, drawMaskArr, drawMaskW, toCanvas, scale);
    if (drawSat.length > 0) drawSaturated(c, drawSat, toCanvas, scale, dpr);
    if (drawGaia.length > 0) drawSources(c, drawGaia, toCanvas, scale, dpr);
    if (drawWise.length > 0) drawSources(c, drawWise, toCanvas, scale, dpr);
  });

  stage.setHover((gx, gy) => {
    const hit = hitTest(drawGaia, gx, gy, 1.5) ?? hitTest(drawWise, gx, gy, 1.5);
    return hit ? describeSource(hit.src) : null;
  });

  stage.setValueProvider((x, y) => {
    if (!current) return '';
    if (current.kind === 'frame') {
      const v = current.pixels[y * current.w + x];
      return Number.isNaN(v) ? 'No data here' : `${v.toFixed(2)} MJy/sr`;
    }
    const d = current.d;
    const v = snr ? d.snr[y * d.w + x] : d.pixels[y * d.w + x];
    if (Number.isNaN(v)) return 'No data here';
    return snr ? `${v >= 0 ? '+' : ''}${v.toFixed(1)} sigma` : `${v >= 0 ? '+' : ''}${v.toFixed(2)} MJy/sr`;
  });

  stage.onPick((fx, fy) => {
    if (!loaded || !movie) return;
    const w = gridToWorld(movie.grid, fx, fy);
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
    stage.setPick([fx, fy]);
    spectrum.show(pts, w, (v) => {
      const mjd = dates.get(v);
      return `Visit ${v + 1}${mjd !== undefined ? ', ' + formatDate(mjd) : ''}`;
    });
  });

  function clearPick(): void {
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
      panel.setHeader(fallback, '');
      return;
    }
    const name = target.name ?? fallback;
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
    const mb = Math.round(n * FRAME_MB_ESTIMATE);
    const single = mode === 'single';
    if (restCtrl) {
      panel.setRest({
        kind: 'loading',
        done: landed.length,
        total: restTotal,
        mb: Math.round(landed.length * FRAME_MB_ESTIMATE),
      });
    } else if (landed.length > 0) {
      panel.setRest({ kind: 'stopped', n, mb, loaded: landed.length, total: restTotal, single });
    } else {
      panel.setRest({ kind: 'optin', n, mb, single });
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
    const isLive = () => !disposed && mine === token;
    showRest();
    loadRest(
      live.grid,
      toLoad,
      {
        onProgress: (done) => {
          if (!isLive()) return;
          panel.setRest({
            kind: 'loading',
            done: doneBefore + done,
            total: restTotal,
            mb: Math.round(done * FRAME_MB_ESTIMATE),
          });
        },
        onFrames: (got) => {
          if (!isLive()) return;
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
      })
      .catch(() => {
        if (!isLive()) return;
        restCtrl = null;
        panel.setNotice('Some exposures could not be loaded. What arrived is shown.');
        showRest();
      });
  }

  function resetForLoad(): void {
    ctrl?.abort();
    restCtrl?.abort();
    restCtrl = null;
    loaded = null;
    movie = null;
    live = null;
    pairFrames = [];
    landed = [];
    remaining = [];
    diffCache = null;
    pairCache = null;
    qualityKey = { movie: null, frame: null, n: 0 };
    player.stop();
    clearPick();
    resetOverlayData();
    rootEl.dataset.state = 'loading';
    panel.clearStatus();
    panel.setRest(null);
    panel.showControls(false);
    headerFor(null);
    stage.setNote('Loading');
  }

  function handleResult(res: LoadResult): void {
    panel.setProgress(null);
    search = res.search ?? search;
    cachedData = res.cachedData;
    live = res.live;
    if (live) {
      size = live.size;
      pairFrames = res.frames;
      remaining = live.rest.slice();
      if (!modeUser) mode = 'single';
      if (aUser === null && bUser === null && res.frames.length >= 2) {
        aUser = 0;
        bUser = 1;
      }
    }
    adopt({
      target: res.target,
      frames: res.frames,
      det: res.det,
      available: res.available,
      cached: res.cached,
    });
    rootEl.dataset.state = 'ready';
    if (res.failed > 0) {
      panel.setNotice(`${res.failed} of ${res.total} exposures could not be read and were skipped.`);
    }
    ensureOverlayData();
    render();
    if (live) {
      if (remaining.length > 0 && remaining.length <= AUTO_REST_LIMIT) startRest();
      else showRest();
    }
  }

  function handleError(e: unknown): void {
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
    resetForLoad();
    search = null;
    cachedData = null;
    const mine = ++token;
    ctrl = new AbortController();
    const signal = ctrl.signal;
    const isCurrent = () => !disposed && mine === token;

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
          if (isCurrent()) panel.setProgress(p);
        },
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
    loadPair(
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
    ctrl?.abort();
    restCtrl?.abort();
    player.dispose();
    document.removeEventListener('keydown', onKey);
    stage.dispose();
    panel.dispose();
    spectrum.dispose();
    quality.dispose();
    rootEl.remove();
  };
};
