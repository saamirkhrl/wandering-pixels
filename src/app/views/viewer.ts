import './../../ui/viewer.css';
import type { Mount } from '../types';
import { prefersReducedMotion } from '../motion';
import { buildMovie, difference, listCached } from '../data';
import type { DifferenceImage, Detector, Exposure, Frame, Movie, MovieMode, Progress, Target } from '../data';
import { formatDate, createPanel } from '../viewer/panel';
import type { CompareInfo, FrameInfo, PanelModel } from '../viewer/panel';
import { createPlayer } from '../viewer/player';
import { AUTO_REST_LIMIT, FRAME_MB_ESTIMATE, ONCE_ONLY, loadRest, loadViewer } from '../viewer/load';
import type { LiveContext, LoadResult } from '../viewer/load';
import { renderDiverging, renderPixels } from '../viewer/render';
import { createStage, formatDecDeg, formatRaDeg } from '../viewer/stage';
import { hasTarget, readParams, writeParams } from '../viewer/state';

interface Loaded {
  target: Target;
  frames: Frame[];
  det: Detector;
  available: { detector: Detector; count: number }[];
  cached: boolean;
}

const SIGMA_RANGE = 5;
const KNOWN_CODES = ['NOT_FOUND', 'NO_COVERAGE', 'UPSTREAM_BUSY', 'UPSTREAM_ERROR', 'BAD_INPUT'] as const;

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
  let pendingFrame: number | null = params.frame;
  let modeUser = new URLSearchParams(location.search).has('mode');
  let aMjd: number | null = null;
  let bMjd: number | null = null;
  let live: LiveContext | null = null;
  let pairFrames: Frame[] = [];
  let landed: Frame[] = [];
  let remaining: Exposure[] = [];
  let restTotal = 0;
  let restCtrl: AbortController | null = null;
  let ctrl: AbortController | null = null;
  let token = 0;
  let diffCache: { key: string; d: DifferenceImage } | null = null;
  let current: { kind: 'frame'; pixels: Float32Array; w: number } | { kind: 'diff'; d: DifferenceImage } | null = null;

  const rootEl = document.createElement('div');
  rootEl.className = 'viewer';
  rootEl.dataset.state = 'empty';

  const player = createPlayer(() => {
    render();
    if (player.mode === 'stopped') persist();
  }, reduced ? 1 : 2);

  const stage = createStage();
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
      aUser = null;
      bUser = null;
      aMjd = null;
      bMjd = null;
      pendingFrame = null;
      player.stop();
      player.setIndex(0);
      rebuild();
      persist();
    },
    setDet: (d) => {
      if (d === det) return;
      det = d;
      aUser = null;
      bUser = null;
      aMjd = null;
      bMjd = null;
      pendingFrame = null;
      player.stop();
      player.setIndex(0);
      rebuild();
      persist();
    },
    setDiff: (on) => {
      diffOn = on;
      if (on) player.stop();
      render();
      persist();
    },
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
  });

  rootEl.append(stage.el, panel.el);
  root.append(rootEl);

  let pairCache: { key: string; pair: [number, number] } | null = null;

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

  function persist(): void {
    if (disposed || player.mode !== 'stopped') return;
    writeParams({
      mode: mode === 'single' ? 'single' : null,
      det: det !== null ? String(det) : null,
      a: aUser !== null ? String(aUser) : null,
      b: bUser !== null ? String(bUser) : null,
      diff: diffOn ? '1' : null,
      snr: diffOn && snr ? '1' : null,
      frame: player.index > 0 ? String(player.index) : null,
    });
  }

  function rebuild(): void {
    if (!loaded || det === null) return;
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
    const nearest = (mjd: number): number => {
      let best = 0;
      movie?.frames.forEach((f, i) => {
        if (Math.abs(f.mjd - mjd) < Math.abs((movie as Movie).frames[best].mjd - mjd)) best = i;
      });
      return best;
    };
    const last = movie.frames.length - 1;
    if (aUser !== null) {
      if (aMjd === null) aMjd = movie.frames[Math.min(aUser, last)].mjd;
      else aUser = nearest(aMjd);
    }
    if (bUser !== null) {
      if (bMjd === null) bMjd = movie.frames[Math.min(bUser, last)].mjd;
      else bUser = nearest(bMjd);
    }
    player.setCount(movie.frames.length);
    if (pendingFrame !== null && loaded.cached) {
      player.setIndex(Math.min(pendingFrame, movie.frames.length - 1));
      pendingFrame = null;
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

  function getDiff(m: Movie, a: number, b: number): DifferenceImage | null {
    const key = `${mode}|${m.detector}|${a}|${b}|${m.frames.length}|${loaded?.frames.length ?? 0}`;
    if (diffCache && diffCache.key === key) return diffCache.d;
    try {
      const d = difference(m.frames[a], m.frames[b]);
      diffCache = { key, d };
      return d;
    } catch {
      return null;
    }
  }

  function compareInfo(d: DifferenceImage | null, same: boolean): CompareInfo {
    if (same || !d) {
      return {
        rangeText: same ? 'Choose two different images for A and B.' : 'These two images could not be compared.',
        unit: 'MJy/sr',
        warning: null,
        note: '',
      };
    }
    const r = Math.max(Math.abs(d.stretch.lo), Math.abs(d.stretch.hi));
    return {
      rangeText: snr
        ? `Range -${SIGMA_RANGE} to +${SIGMA_RANGE} sigma`
        : `Range -${sig2(r)} to +${sig2(r)} MJy/sr`,
      unit: snr ? 'sigma' : 'MJy/sr',
      warning: d.wavelengthMatched
        ? null
        : `These two visits saw this spot at different wavelengths (${wl(d.wavelengthA)} and ${wl(d.wavelengthB)}). The pair is not like for like: leftovers can come from the star's colour, not from real change.`,
      note: snr
        ? 'Each pixel is the difference divided by its noise. Orange is B above A, blue is A above B.'
        : 'Orange is where B is brighter than A, blue where A is brighter. A star that moved between the two images leaves an orange and blue pair.',
    };
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
      const d = same ? null : getDiff(m, a, b);
      compare = compareInfo(d, same);
      if (d) {
        const rgba = snr
          ? renderDiverging(d.snr, d.w, d.h, SIGMA_RANGE)
          : renderDiverging(d.pixels, d.w, d.h, Math.max(Math.abs(d.stretch.lo), Math.abs(d.stretch.hi)));
        stage.setImage(rgba, d.w, d.h);
        stage.setOverlay(m.grid, m.frames[b].targetXY);
        current = { kind: 'diff', d };
      } else {
        showFrame = m.frames[b];
        paintFrame(m, showFrame);
      }
    } else {
      paintFrame(m, showFrame);
    }

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
      detectors: loaded && loaded.cached ? loaded.available.map((x) => x.detector) : [m.detector],
      compare,
    };
    panel.update(model);
  }

  function paintFrame(m: Movie, f: Movie['frames'][number]): void {
    stage.setImage(renderPixels(f.pixels, f.w, f.h, m.stretch), f.w, f.h);
    stage.setOverlay(f.grid, f.targetXY);
    current = { kind: 'frame', pixels: f.pixels, w: f.w };
  }

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
    if (restCtrl) {
      panel.setRest({ kind: 'loading', done: landed.length, total: restTotal, mb: Math.round(landed.length * FRAME_MB_ESTIMATE) });
    } else if (landed.length > 0) {
      panel.setRest({ kind: 'stopped', n, mb, loaded: landed.length, total: restTotal });
    } else {
      panel.setRest({ kind: 'optin', n, mb });
    }
  }

  function adoptLive(final: boolean): void {
    if (!loaded || !live) return;
    const all = pairFrames.concat(landed);
    if (!modeUser && mode === 'single' && visitsWithTwo(all) >= 2) mode = 'visit-stack';
    adopt({ ...loaded, frames: all });
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

  function startLoad(): void {
    ctrl?.abort();
    restCtrl?.abort();
    restCtrl = null;
    const mine = ++token;
    ctrl = new AbortController();
    const signal = ctrl.signal;
    loaded = null;
    movie = null;
    live = null;
    pairFrames = [];
    landed = [];
    remaining = [];
    diffCache = null;
    pairCache = null;
    player.stop();
    rootEl.dataset.state = 'loading';
    panel.clearStatus();
    panel.setRest(null);
    panel.showControls(false);
    headerFor(null);
    stage.setNote('Loading');

    const isCurrent = () => !disposed && mine === token;

    loadViewer(
      { q: params.q, ra: params.ra, dec: params.dec, det: params.det },
      {
        onStage: (p: Progress) => {
          if (isCurrent()) panel.setProgress(p);
        },
      },
      signal,
    )
      .then((res: LoadResult) => {
        if (!isCurrent()) return;
        panel.setProgress(null);
        live = res.live;
        if (live) {
          pairFrames = res.frames;
          remaining = live.rest.slice();
          if (!modeUser) mode = 'single';
          if (aUser === null && bUser === null && res.frames.length >= 2) {
            aUser = 0;
            bUser = 1;
          }
        }
        adopt({ target: res.target, frames: res.frames, det: res.det, available: res.available, cached: res.cached });
        rootEl.dataset.state = 'ready';
        if (res.failed > 0) {
          panel.setNotice(`${res.failed} of ${res.total} exposures could not be read and were skipped.`);
        }
        if (live) {
          if (remaining.length > 0 && remaining.length <= AUTO_REST_LIMIT) startRest();
          else showRest();
        }
      })
      .catch((e: unknown) => {
        if (!isCurrent()) return;
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
      });
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!movie || diffOn) return;
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
    rootEl.remove();
  };
};
