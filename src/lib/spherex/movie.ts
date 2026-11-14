import type { Frame, Grid, MovieMode, Detector, Target, Movie, MovieFrame, DifferenceImage, Exposure, PairedDifference } from './types';
import { SpherexError, BAD_DATA_MASK } from './types';
import { positionAt, worldToGrid } from './wcs';
import { robustPercentiles, sigmaClippedStats } from './stats';
import { saturatedSources } from './saturation';
import { trackingTolerance } from './parallax';

const MJD_UNIX_EPOCH = 40587;

function mjdToIso(mjd: number): string {
  return new Date((mjd - MJD_UNIX_EPOCH) * 86400000).toISOString();
}

/** Approximate channel width (um) = wavelength / R, R by SPHEREx detector. */
export function channelBandwidth(detector: Detector, wavelength: number): number {
  const R: Record<Detector, number> = { 1: 39, 2: 41, 3: 41, 4: 35, 5: 112, 6: 128 };
  return wavelength / R[detector];
}

function meanOf(v: number[]): number {
  if (v.length === 0) return NaN;
  let s = 0;
  for (const x of v) s += x;
  return s / v.length;
}

export interface BuildMovieOptions {
  /** 'median' (default): subtract each frame's sigma-clipped median before stacking. 'none': leave pixels as is. */
  background?: 'median' | 'none';
  /**
   * How members of one stack are combined per pixel. 'mean': inverse-variance mean. 'clipped':
   * iterative 3-sigma rejection about the median (up to 3 rounds, needs >= 3 usable members),
   * then the inverse-variance mean of the survivors. Default: 'clipped' when the frames carry
   * trackingDistanceAu (co-moving frames, where passing stars and stray sources must be rejected),
   * else 'mean'.
   */
  combine?: 'mean' | 'clipped';
}

const BG_MAX_SAMPLES = 20000;
const BG_MIN_PIXELS = 100;
const BG_DILATE = 3;

function subsample(values: number[]): number[] {
  const stride = Math.max(1, Math.ceil(values.length / BG_MAX_SAMPLES));
  if (stride === 1) return values;
  const out: number[] = [];
  for (let i = 0; i < values.length; i += stride) out.push(values[i]);
  return out;
}

/**
 * Background level of one frame (MJy/sr).
 * plain: sigma-clipped median (3 iterations, 3 sigma, sigma = 1.4826*MAD) of finite pixels with
 * flags == 0. level: the same estimator over those pixels minus two exclusion zones:
 *   zone 1: Euclidean distance <= max(8, 3*sqrt(npix/pi)) px from each saturatedSources blob centre;
 *   zone 2: pixels brighter than plain + 10 * robust sigma, dilated by 3 px (Chebyshev, 7x7 square).
 * Fewer than 100 pixels left -> level = plain, fallback = true. Fewer than 100 usable pixels
 * at all -> level = plain = 0. Inputs of > 20000 pixels are subsampled with a deterministic stride.
 * nUsed is the number of pixels (before subsampling) that fed `level`.
 */
export function frameBackground(frame: Frame): { level: number; fallback: boolean; plain: number; nUsed: number } {
  const { w, h, pixels, flags } = frame;
  const n = w * h;
  const usableVals: number[] = [];
  for (let i = 0; i < n; i++) if ((flags[i] & BAD_DATA_MASK) === 0 && Number.isFinite(pixels[i])) usableVals.push(pixels[i]);
  if (usableVals.length < BG_MIN_PIXELS) return { level: 0, fallback: false, plain: 0, nUsed: 0 };
  const plainStats = sigmaClippedStats(subsample(usableVals), 3, 3);
  const plain = plainStats.median;
  const excluded = new Uint8Array(n);
  for (const s of saturatedSources(frame)) {
    const r = Math.max(8, 3 * Math.sqrt(s.npix / Math.PI));
    const x0 = Math.max(0, Math.floor(s.x - r));
    const x1 = Math.min(w - 1, Math.ceil(s.x + r));
    const y0 = Math.max(0, Math.floor(s.y - r));
    const y1 = Math.min(h - 1, Math.ceil(s.y + r));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if ((x - s.x) ** 2 + (y - s.y) ** 2 <= r * r) excluded[y * w + x] = 1;
  }
  const thr = plain + 10 * plainStats.sigma;
  const bright = new Uint8Array(n);
  for (let i = 0; i < n; i++) if ((flags[i] & BAD_DATA_MASK) === 0 && pixels[i] > thr) bright[i] = 1;
  const rowPass = new Uint8Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!bright[y * w + x]) continue;
      for (let xx = Math.max(0, x - BG_DILATE); xx <= Math.min(w - 1, x + BG_DILATE); xx++) rowPass[y * w + xx] = 1;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!rowPass[y * w + x]) continue;
      for (let yy = Math.max(0, y - BG_DILATE); yy <= Math.min(h - 1, y + BG_DILATE); yy++) excluded[yy * w + x] = 1;
    }
  const kept: number[] = [];
  for (let i = 0; i < n; i++) if (!excluded[i] && (flags[i] & BAD_DATA_MASK) === 0 && Number.isFinite(pixels[i])) kept.push(pixels[i]);
  if (kept.length < BG_MIN_PIXELS) return { level: plain, fallback: true, plain, nUsed: usableVals.length };
  const level = sigmaClippedStats(subsample(kept), 3, 3).median;
  return { level, fallback: false, plain, nUsed: kept.length };
}

/** Median of the first n entries of a (scratch) array; reorders them. */
function medianOfFirst(a: Float64Array, n: number): number {
  const s = a.subarray(0, n).sort();
  return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

const CLIP_SIGMA = 3;
const CLIP_ITERATIONS = 3;

function stackFrames(
  members: Frame[],
  visitIndex: number,
  detector: Detector,
  target: Target | undefined,
  background: 'median' | 'none',
  combine: 'mean' | 'clipped',
  tracked: boolean,
): MovieFrame {
  const first = members[0];
  const { w, h } = first;
  const n = w * h;
  const pixels = new Float32Array(n);
  const variance = new Float32Array(n);
  // Per-member pixel source: the input array for 'none', otherwise a background-subtracted copy.
  const bgs = members.map((f) => (background === 'median' ? frameBackground(f) : null));
  const levels = bgs.map((b) => (b ? b.level : 0));
  const srcs: ArrayLike<number>[] = members.map((f, k) => {
    if (background !== 'median') return f.pixels;
    const c = new Float32Array(f.pixels.length);
    const lv = levels[k];
    for (let i = 0; i < c.length; i++) c[i] = f.pixels[i] - lv;
    return c;
  });
  if (combine === 'mean') {
    for (let i = 0; i < n; i++) {
      let sw = 0;
      let swx = 0;
      for (let k = 0; k < members.length; k++) {
        const f = members[k];
        const p = srcs[k][i];
        const v = f.variance[i];
        if ((f.flags[i] & BAD_DATA_MASK) !== 0 || !Number.isFinite(p) || !Number.isFinite(v) || !(v > 0)) continue;
        const wt = 1 / v;
        sw += wt;
        swx += wt * p;
      }
      if (sw > 0) {
        pixels[i] = swx / sw;
        variance[i] = 1 / sw;
      } else {
        pixels[i] = NaN;
        variance[i] = NaN;
      }
    }
  } else {
    const K = members.length;
    const val = new Float64Array(K);
    const vr = new Float64Array(K);
    const alive = new Uint8Array(K);
    const scratch = new Float64Array(K);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let k = 0; k < K; k++) {
        const f = members[k];
        const p = srcs[k][i];
        const v = f.variance[i];
        if ((f.flags[i] & BAD_DATA_MASK) !== 0 || !Number.isFinite(p) || !Number.isFinite(v) || !(v > 0)) continue;
        val[m] = p;
        vr[m] = v;
        alive[m] = 1;
        m++;
      }
      if (m >= 3) {
        for (let it = 0; it < CLIP_ITERATIONS; it++) {
          let c = 0;
          for (let j = 0; j < m; j++) if (alive[j]) scratch[c++] = val[j];
          if (c < 3) break;
          const med = medianOfFirst(scratch, c);
          c = 0;
          for (let j = 0; j < m; j++) if (alive[j]) scratch[c++] = Math.abs(val[j] - med);
          let sigma = 1.4826 * medianOfFirst(scratch, c);
          if (!(sigma > 0)) {
            c = 0;
            for (let j = 0; j < m; j++) if (alive[j]) scratch[c++] = vr[j];
            sigma = Math.sqrt(medianOfFirst(scratch, c));
          }
          if (!(sigma > 0)) break;
          const lim = CLIP_SIGMA * sigma;
          let rejected = false;
          for (let j = 0; j < m; j++) {
            if (alive[j] && Math.abs(val[j] - med) > lim) {
              alive[j] = 0;
              rejected = true;
            }
          }
          if (!rejected) break;
        }
      }
      let sw = 0;
      let swx = 0;
      for (let j = 0; j < m; j++) {
        if (!alive[j]) continue;
        const wt = 1 / vr[j];
        sw += wt;
        swx += wt * val[j];
      }
      if (sw > 0) {
        pixels[i] = swx / sw;
        variance[i] = 1 / sw;
      } else {
        pixels[i] = NaN;
        variance[i] = NaN;
      }
    }
  }
  const mjd = meanOf(members.map((f) => f.exposure.mjd));
  const waves = members
    .map((f) => f.exposure.wavelengthAtTarget)
    .filter((x): x is number => x !== null && Number.isFinite(x));
  const wavelength = meanOf(waves);
  // Grid of the member nearest the stack's mean time (the first one on a tie).
  let near = first;
  for (const f of members) if (Math.abs(f.exposure.mjd - mjd) < Math.abs(near.exposure.mjd - mjd)) near = f;
  const grid = near.grid;
  // Tracked frames are cut out around the target: it sits at the cutout centre.
  const targetXY: [number, number] | null = tracked
    ? [(w - 1) / 2, (h - 1) / 2]
    : target
      ? (() => {
          const p = positionAt(target, mjd);
          return worldToGrid(grid, p.ra, p.dec);
        })()
    : null;
  const saturated = mergeSaturated(members);
  return {
    grid,
    pixels,
    variance,
    w,
    h,
    visitIndex,
    detector,
    time: mjdToIso(mjd),
    mjd,
    wavelength,
    wavelengthMin: waves.length ? Math.min(...waves) : NaN,
    wavelengthMax: waves.length ? Math.max(...waves) : NaN,
    nExposures: members.length,
    exposureIds: members.map((f) => f.exposure.id),
    targetXY,
    backgroundLevel: background === 'median' ? meanOf(levels) : 0,
    // Omitted (not []) when no member has a saturated pixel.
    ...(saturated.length ? { saturated } : {}),
    ...(background === 'median' ? { backgroundFallback: bgs.some((b) => b !== null && b.fallback) } : {}),
  };
}

/**
 * Union of the members' saturatedSources, merged when centroids are closer than 2 px (to the running
 * npix-weighted centroid of a group). Merged x, y = npix-weighted mean; merged npix = the largest
 * member count, so a source seen in N exposures is not counted N times. Largest first.
 */
function mergeSaturated(members: Frame[]): { x: number; y: number; npix: number }[] {
  const groups: { sw: number; sx: number; sy: number; max: number }[] = [];
  for (const f of members) {
    for (const s of saturatedSources(f)) {
      let g: (typeof groups)[number] | undefined;
      let best = 2;
      for (const c of groups) {
        const d = Math.hypot(c.sx / c.sw - s.x, c.sy / c.sw - s.y);
        if (d < best) {
          best = d;
          g = c;
        }
      }
      if (g) {
        g.sw += s.npix;
        g.sx += s.npix * s.x;
        g.sy += s.npix * s.y;
        g.max = Math.max(g.max, s.npix);
      } else groups.push({ sw: s.npix, sx: s.npix * s.x, sy: s.npix * s.y, max: s.npix });
    }
  }
  return groups.map((g) => ({ x: g.sx / g.sw, y: g.sy / g.sw, npix: g.max })).sort((a, b) => b.npix - a.npix);
}

function widen(lo: number, hi: number): { lo: number; hi: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 };
  if (hi > lo) return { lo, hi };
  const d = Math.max(Math.abs(lo) * 0.1, 1e-3);
  return { lo: lo - d, hi: hi + d };
}

export function buildMovie(
  frames: Frame[],
  mode: MovieMode,
  detector: Detector,
  target?: Target,
  opts: BuildMovieOptions = {},
): Movie {
  const background = opts.background ?? 'median';
  const sel = frames.filter((f) => f.exposure.detector === detector);
  // Selected frames may differ in grid centre (tracked frames) but not in shape or tracking distance.
  const motionKey = (f: Frame): string =>
    f.trackingMotion ? `${f.trackingMotion.dRaArcsecPerYr},${f.trackingMotion.dDecArcsecPerYr}` : '';
  for (const f of sel) {
    if (
      f.w !== sel[0].w || f.h !== sel[0].h || f.trackingDistanceAu !== sel[0].trackingDistanceAu ||
      motionKey(f) !== motionKey(sel[0])
    ) {
      throw new SpherexError(
        'BAD_INPUT',
        `buildMovie: frames differ in shape, trackingDistanceAu or trackingMotion (${f.exposure.id} vs ${sel[0].exposure.id})`,
      );
    }
  }
  const trackingDistanceAu = sel.length ? sel[0].trackingDistanceAu : undefined;
  const tracked = trackingDistanceAu !== undefined;
  const combine = opts.combine ?? (tracked ? 'clipped' : 'mean');
  const grid = sel.length ? sel[0].grid : frames.length ? frames[0].grid : { ra0: 0, dec0: 0, w: 0, h: 0, scaleArcsec: 6.15, epochMjd: 0 };
  if (sel.length === 0) {
    return { mode, detector, grid, frames: [], stretch: { lo: 0, hi: 1 } };
  }
  const out: MovieFrame[] = [];
  if (mode === 'single') {
    for (const f of sel) out.push(stackFrames([f], f.exposure.visitIndex, detector, target, background, combine, tracked));
  } else {
    const groups = new Map<number, Frame[]>();
    for (const f of sel) {
      if (f.exposure.inStack === false) continue;
      const g = groups.get(f.exposure.visitIndex);
      if (g) g.push(f);
      else groups.set(f.exposure.visitIndex, [f]);
    }
    for (const [vi, members] of groups) out.push(stackFrames(members, vi, detector, target, background, combine, tracked));
  }
  out.sort((a, b) => a.mjd - b.mjd);
  const [lo, hi] = robustPercentiles(out.map((m) => m.pixels), [1, 99.5]);
  // Movie.grid is the grid of the first (earliest) movie frame; tracked frames each carry their own.
  return {
    mode,
    detector,
    grid: out.length ? out[0].grid : grid,
    frames: out,
    stretch: widen(lo, hi),
    ...(tracked ? { trackingDistanceAu } : {}),
    ...(sel[0].trackingMotion ? { trackingMotion: { ...sel[0].trackingMotion } } : {}),
  };
}

/** b minus a. Frames need the same w and h, not the same grid centre. Result grid = b.grid. */
export function difference(a: MovieFrame, b: MovieFrame): DifferenceImage {
  if (a.w !== b.w || a.h !== b.h) {
    throw new SpherexError('BAD_INPUT', `difference: grid size mismatch ${a.w}x${a.h} vs ${b.w}x${b.h}`);
  }
  const n = a.w * a.h;
  const pixels = new Float32Array(n);
  const variance = new Float32Array(n);
  const snr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = b.pixels[i] - a.pixels[i];
    const v = a.variance[i] + b.variance[i];
    pixels[i] = d;
    variance[i] = v;
    snr[i] = d / Math.sqrt(v);
  }
  const [s] = robustPercentiles([pixels], [99.5], Math.abs);
  const sym = Number.isFinite(s) && s > 0 ? s : 1;
  const bw = (channelBandwidth(a.detector, a.wavelength) + channelBandwidth(b.detector, b.wavelength)) / 2;
  return {
    grid: b.grid,
    pixels,
    variance,
    snr,
    w: a.w,
    h: a.h,
    wavelengthA: a.wavelength,
    wavelengthB: b.wavelength,
    wavelengthMatched: Math.abs(a.wavelength - b.wavelength) < bw,
    stretch: { lo: -sym, hi: sym },
    method: a.nExposures === 1 && b.nExposures === 1 ? 'single' : 'naive-stack',
  };
}

export function summarize(
  exposures: Exposure[],
): { detector: Detector; visits: number[]; count: number; outOfStack: number }[] {
  const m = new Map<Detector, { visits: Set<number>; count: number; outOfStack: number }>();
  for (const e of exposures) {
    let r = m.get(e.detector);
    if (!r) {
      r = { visits: new Set(), count: 0, outOfStack: 0 };
      m.set(e.detector, r);
    }
    r.visits.add(e.visitIndex);
    r.count++;
    if (e.inStack === false) r.outOfStack++;
  }
  return [...m.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([detector, r]) => ({
      detector,
      visits: [...r.visits].sort((a, b) => a - b),
      count: r.count,
      outOfStack: r.outOfStack,
    }));
}

/** Time separation (days) that puts the two frames about one year apart (parallax-dominated). */
export const YEAR_PAIR_DAYS: [number, number] = [330, 400];
/** Time separation (days) that puts the two frames about half a year apart. */
export const HALF_YEAR_PAIR_DAYS: [number, number] = [150, 215];

export interface PairOptions {
  /** Keep only pairs whose |mjd difference| lies in [lo, hi] days (inclusive). */
  gapDays?: [number, number];
  /** Skip exposures with inStack === false. Default true. */
  requireInStack?: boolean;
  /** listPairs only: with distanceAu and a position (ra and dec, or target), items carry pxPerPercent. */
  distanceAu?: number;
  ra?: number;
  dec?: number;
  target?: Target;
}

export interface ListedPair {
  a: Exposure;
  b: Exposure;
  gapDays: number;
  wavelengthGapUm: number;
  /** Wavelength gap over the mean of the two bandwidthAtTarget values; NaN if either is unknown. */
  wavelengthGapChannels: number;
  /** trackingTolerance(distanceAu, a.mjd, b.mjd, ra, dec).pxPerPercent; only when asked for via opts. */
  pxPerPercent?: number;
}

const PAIR_TIE = 1e-9;
const LIST_PAIRS_CAP = 50;

function pairCandidates(exposures: Exposure[], detector: Detector | undefined, opts: PairOptions): Exposure[] {
  const requireInStack = opts.requireInStack ?? true;
  return exposures
    .filter(
      (e) =>
        e.wavelengthAtTarget !== null &&
        Number.isFinite(e.wavelengthAtTarget) &&
        Number.isFinite(e.mjd) &&
        (detector === undefined || e.detector === detector) &&
        !(requireInStack && e.inStack === false),
    )
    .sort((a, b) => (a.wavelengthAtTarget as number) - (b.wavelengthAtTarget as number));
}

function gapOk(gap: number, range: [number, number] | undefined): boolean {
  return range === undefined || (gap >= range[0] && gap <= range[1]);
}

export function pickBlinkPair(
  exposures: Exposure[],
  detector?: Detector,
  opts: PairOptions = {},
): [Exposure, Exposure] | null {
  const c = pairCandidates(exposures, detector, opts);
  let best: [Exposure, Exposure] | null = null;
  let bestD = Infinity;
  let bestGap = -1;
  for (let i = 0; i < c.length; i++) {
    const wi = c[i].wavelengthAtTarget as number;
    for (let j = i + 1; j < c.length; j++) {
      const d = (c[j].wavelengthAtTarget as number) - wi;
      if (d > bestD + PAIR_TIE) break; // sorted: no later j can tie or beat the best
      if (c[i].visitIndex === c[j].visitIndex) continue;
      const gap = Math.abs(c[j].mjd - c[i].mjd);
      if (!gapOk(gap, opts.gapDays)) continue;
      if (d < bestD - PAIR_TIE || (Math.abs(d - bestD) <= PAIR_TIE && gap > bestGap)) {
        best = [c[i], c[j]];
        bestD = Math.min(d, bestD);
        bestGap = gap;
      }
    }
  }
  if (!best) return null;
  return best[0].mjd <= best[1].mjd ? best : [best[1], best[0]];
}

/**
 * Cross-visit pairs that pass the same filters as pickBlinkPair, best first: ascending wavelength
 * gap (ties: larger time gap), at most 50. a is the earlier exposure.
 */
export function listPairs(
  exposures: Exposure[],
  detector?: Detector,
  opts: PairOptions = {},
): ListedPair[] {
  const c = pairCandidates(exposures, detector, opts);
  const out: ListedPair[] = [];
  for (let i = 0; i < c.length; i++) {
    const wi = c[i].wavelengthAtTarget as number;
    for (let j = i + 1; j < c.length; j++) {
      if (c[i].visitIndex === c[j].visitIndex) continue;
      const gapDays = Math.abs(c[j].mjd - c[i].mjd);
      if (!gapOk(gapDays, opts.gapDays)) continue;
      const [a, b] = c[i].mjd <= c[j].mjd ? [c[i], c[j]] : [c[j], c[i]];
      const wavelengthGapUm = (c[j].wavelengthAtTarget as number) - wi;
      out.push({ a, b, gapDays, wavelengthGapUm, wavelengthGapChannels: NaN });
    }
  }
  out.sort((p, q) => p.wavelengthGapUm - q.wavelengthGapUm || q.gapDays - p.gapDays);
  const top = out.slice(0, LIST_PAIRS_CAP);
  const pos = opts.target ? { ra: opts.target.ra, dec: opts.target.dec } : opts.ra !== undefined && opts.dec !== undefined ? { ra: opts.ra, dec: opts.dec } : null;
  for (const p of top) {
    const ba = p.a.bandwidthAtTarget;
    const bb = p.b.bandwidthAtTarget;
    p.wavelengthGapChannels =
      ba !== null && bb !== null && Number.isFinite(ba) && Number.isFinite(bb) ? p.wavelengthGapUm / ((ba + bb) / 2) : NaN;
    if (opts.distanceAu !== undefined && pos) {
      p.pxPerPercent = trackingTolerance(opts.distanceAu, p.a.mjd, p.b.mjd, pos.ra, pos.dec).pxPerPercent;
    }
  }
  return top;
}

export interface PairedDifferenceOptions {
  /** Pairing tolerance in mean bandwidths of the two exposures. Default 1.0 (docs/algorithm.md step 6). */
  toleranceChannels?: number;
  /**
   * Fractional flux error floor, default 0.02. docs/algorithm.md specifies a flux floor of 0.02 (fraction
   * of F, added in quadrature) for aperture photometry. Here it is applied per pixel,
   * var = varA + varB + (f*|pA|)^2 + (f*|pB|)^2, on background-subtracted values of the resampled
   * grid. That per-pixel variant is not validated.
   */
  errorFloor?: number;
  /** 'median' (default): subtract each frame's own frameBackground level first. 'none': use pixels as is. */
  background?: 'median' | 'none';
}

function bandwidthOf(f: Frame): number {
  const b = f.exposure.bandwidthAtTarget;
  if (b !== null && Number.isFinite(b) && b > 0) return b;
  return channelBandwidth(f.exposure.detector, f.exposure.wavelengthAtTarget as number);
}

function eligible(f: Frame): boolean {
  const l = f.exposure.wavelengthAtTarget;
  return f.exposure.inStack !== false && l !== null && Number.isFinite(l);
}

/**
 * Visit difference built from wavelength-matched exposure pairs (docs/algorithm.md step 6, PS).
 * All frames need one detector and one w x h (else BAD_INPUT); the grid centre may differ (tracked
 * frames). Frames with inStack === false or a non-finite wavelengthAtTarget are ignored.
 * Candidate pairs have |lamA - lamB| <= tol * 0.5 * (bwA + bwB); they are sorted by |lam gap|, then
 * |mjd gap|, then ids (A id, then B id) and accepted greedily, each exposure once. Per pair the
 * difference is B - A of background-subtracted pixels with variance
 * varA + varB + (f*|pA|)^2 + (f*|pB|)^2; pairs are combined per pixel by inverse-variance mean
 * (variance 1/sum(w), NaN where no pair has both pixels usable). Result grid = B frame of the first pair.
 * pairs[].wavelengthGapUm is lamB - lamA (signed) and gapChannels that over the mean bandwidth.
 * No qualifying pair: all-NaN image, nPairs 0, wavelengthMatched false (no throw).
 */
export function pairedDifference(
  framesA: Frame[],
  framesB: Frame[],
  opts: PairedDifferenceOptions = {},
): PairedDifference {
  const tol = opts.toleranceChannels ?? 1.0;
  const floor = opts.errorFloor ?? 0.02;
  const background = opts.background ?? 'median';
  const all = [...framesA, ...framesB];
  for (const f of all) {
    if (f.exposure.detector !== all[0].exposure.detector || f.w !== all[0].w || f.h !== all[0].h) {
      throw new SpherexError(
        'BAD_INPUT',
        `pairedDifference: frames differ in detector or shape (${f.exposure.id} vs ${all[0].exposure.id})`,
      );
    }
  }
  const A = framesA.filter(eligible);
  const B = framesB.filter(eligible);
  const w = all.length ? all[0].w : 0;
  const h = all.length ? all[0].h : 0;
  const n = w * h;
  const lam = (f: Frame): number => f.exposure.wavelengthAtTarget as number;

  const cands: { a: Frame; b: Frame; gap: number; dt: number }[] = [];
  for (const a of A)
    for (const b of B) {
      const gap = lam(b) - lam(a);
      if (Math.abs(gap) <= tol * 0.5 * (bandwidthOf(a) + bandwidthOf(b)))
        cands.push({ a, b, gap, dt: Math.abs(b.exposure.mjd - a.exposure.mjd) });
    }
  cands.sort((p, q) => {
    const d = Math.abs(p.gap) - Math.abs(q.gap);
    if (d !== 0) return d;
    const t = p.dt - q.dt;
    if (t !== 0) return t;
    if (p.a.exposure.id !== q.a.exposure.id) return p.a.exposure.id < q.a.exposure.id ? -1 : 1;
    return p.b.exposure.id < q.b.exposure.id ? -1 : p.b.exposure.id > q.b.exposure.id ? 1 : 0;
  });
  const usedA = new Set<Frame>();
  const usedB = new Set<Frame>();
  const accepted: typeof cands = [];
  for (const c of cands) {
    if (usedA.has(c.a) || usedB.has(c.b)) continue;
    usedA.add(c.a);
    usedB.add(c.b);
    accepted.push(c);
  }

  const levelOf = (f: Frame): number => (background === 'median' ? frameBackground(f).level : 0);
  const sw = new Float64Array(n);
  const swd = new Float64Array(n);
  for (const { a, b } of accepted) {
    const la = levelOf(a);
    const lb = levelOf(b);
    for (let i = 0; i < n; i++) {
      if (((a.flags[i] | b.flags[i]) & BAD_DATA_MASK) !== 0) continue;
      const pa = a.pixels[i] - la;
      const pb = b.pixels[i] - lb;
      const v = a.variance[i] + b.variance[i] + (floor * pa) ** 2 + (floor * pb) ** 2;
      if (!Number.isFinite(pa) || !Number.isFinite(pb) || !(v > 0) || !Number.isFinite(v)) continue;
      const wt = 1 / v;
      sw[i] += wt;
      swd[i] += wt * (pb - pa);
    }
  }
  const pixels = new Float32Array(n);
  const variance = new Float32Array(n);
  const snr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (sw[i] > 0) {
      const d = swd[i] / sw[i];
      const v = 1 / sw[i];
      pixels[i] = d;
      variance[i] = v;
      snr[i] = d / Math.sqrt(v);
    } else {
      pixels[i] = NaN;
      variance[i] = NaN;
      snr[i] = NaN;
    }
  }
  const [s] = robustPercentiles([pixels], [99.5], Math.abs);
  const sym = Number.isFinite(s) && s > 0 ? s : 1;
  const memA = accepted.length ? accepted.map((c) => c.a) : A;
  const memB = accepted.length ? accepted.map((c) => c.b) : B;
  const grid: Grid = accepted.length
    ? accepted[0].b.grid
    : all.length
      ? (framesB[0] ?? framesA[0]).grid
      : { ra0: 0, dec0: 0, w: 0, h: 0, scaleArcsec: 6.15, epochMjd: 0 };
  return {
    grid,
    pixels,
    variance,
    snr,
    w,
    h,
    wavelengthA: meanOf(memA.map(lam)),
    wavelengthB: meanOf(memB.map(lam)),
    wavelengthMatched: accepted.length > 0,
    stretch: { lo: -sym, hi: sym },
    method: 'paired-stack',
    nPairs: accepted.length,
    nUnpairedA: A.length - accepted.length,
    nUnpairedB: B.length - accepted.length,
    pairs: accepted.map((c) => ({
      a: c.a.exposure.id,
      b: c.b.exposure.id,
      wavelengthGapUm: c.gap,
      gapChannels: c.gap / (0.5 * (bandwidthOf(c.a) + bandwidthOf(c.b))),
    })),
  };
}

/** pairedDifference of the frames of `detector` in visit visitA (as A) and visitB (as B). */
export function visitDifference(
  frames: Frame[],
  detector: Detector,
  visitA: number,
  visitB: number,
  opts?: PairedDifferenceOptions,
): PairedDifference {
  const sel = frames.filter((f) => f.exposure.detector === detector);
  return pairedDifference(
    sel.filter((f) => f.exposure.visitIndex === visitA),
    sel.filter((f) => f.exposure.visitIndex === visitB),
    opts,
  );
}
