import type { Frame, MovieMode, Detector, Target, Movie, MovieFrame, DifferenceImage, Exposure } from './types';
import { SpherexError } from './types';
import { positionAt, worldToGrid } from './wcs';
import { robustPercentiles } from './stats';

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

function stackFrames(members: Frame[], visitIndex: number, detector: Detector, target?: Target): MovieFrame {
  const first = members[0];
  const { w, h, grid } = first;
  const n = w * h;
  const pixels = new Float32Array(n);
  const variance = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sw = 0;
    let swx = 0;
    for (const f of members) {
      const p = f.pixels[i];
      const v = f.variance[i];
      if (f.flags[i] !== 0 || !Number.isFinite(p) || !Number.isFinite(v) || !(v > 0)) continue;
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
  const mjd = meanOf(members.map((f) => f.exposure.mjd));
  const waves = members
    .map((f) => f.exposure.wavelengthAtTarget)
    .filter((x): x is number => x !== null && Number.isFinite(x));
  const wavelength = meanOf(waves);
  const targetXY: [number, number] | null = target
    ? (() => {
        const p = positionAt(target, mjd);
        return worldToGrid(grid, p.ra, p.dec);
      })()
    : null;
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
  };
}

function widen(lo: number, hi: number): { lo: number; hi: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 };
  if (hi > lo) return { lo, hi };
  const d = Math.max(Math.abs(lo) * 0.1, 1e-3);
  return { lo: lo - d, hi: hi + d };
}

export function buildMovie(frames: Frame[], mode: MovieMode, detector: Detector, target?: Target): Movie {
  const sel = frames.filter((f) => f.exposure.detector === detector);
  const grid = sel.length ? sel[0].grid : frames.length ? frames[0].grid : { ra0: 0, dec0: 0, w: 0, h: 0, scaleArcsec: 6.15, epochMjd: 0 };
  if (sel.length === 0) {
    return { mode, detector, grid, frames: [], stretch: { lo: 0, hi: 1 } };
  }
  const out: MovieFrame[] = [];
  if (mode === 'single') {
    for (const f of sel) out.push(stackFrames([f], f.exposure.visitIndex, detector, target));
  } else {
    const groups = new Map<number, Frame[]>();
    for (const f of sel) {
      const g = groups.get(f.exposure.visitIndex);
      if (g) g.push(f);
      else groups.set(f.exposure.visitIndex, [f]);
    }
    for (const [vi, members] of groups) out.push(stackFrames(members, vi, detector, target));
  }
  out.sort((a, b) => a.mjd - b.mjd);
  const [lo, hi] = robustPercentiles(out.map((m) => m.pixels), [1, 99.5]);
  return { mode, detector, grid, frames: out, stretch: widen(lo, hi) };
}

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
    grid: a.grid,
    pixels,
    variance,
    snr,
    w: a.w,
    h: a.h,
    wavelengthA: a.wavelength,
    wavelengthB: b.wavelength,
    wavelengthMatched: Math.abs(a.wavelength - b.wavelength) < bw,
    stretch: { lo: -sym, hi: sym },
  };
}

export function summarize(exposures: Exposure[]): { detector: Detector; visits: number[]; count: number }[] {
  const m = new Map<Detector, { visits: Set<number>; count: number }>();
  for (const e of exposures) {
    let r = m.get(e.detector);
    if (!r) {
      r = { visits: new Set(), count: 0 };
      m.set(e.detector, r);
    }
    r.visits.add(e.visitIndex);
    r.count++;
  }
  return [...m.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([detector, r]) => ({ detector, visits: [...r.visits].sort((a, b) => a - b), count: r.count }));
}

export function pickBlinkPair(exposures: Exposure[], detector?: Detector): [Exposure, Exposure] | null {
  const TIE = 1e-9;
  const c = exposures
    .filter(
      (e) =>
        e.wavelengthAtTarget !== null &&
        Number.isFinite(e.wavelengthAtTarget) &&
        Number.isFinite(e.mjd) &&
        (detector === undefined || e.detector === detector),
    )
    .sort((a, b) => (a.wavelengthAtTarget as number) - (b.wavelengthAtTarget as number));
  let best: [Exposure, Exposure] | null = null;
  let bestD = Infinity;
  let bestGap = -1;
  for (let i = 0; i < c.length; i++) {
    const wi = c[i].wavelengthAtTarget as number;
    for (let j = i + 1; j < c.length; j++) {
      const d = (c[j].wavelengthAtTarget as number) - wi;
      if (d > bestD + TIE) break; // sorted: no later j can tie or beat the best
      if (c[i].visitIndex === c[j].visitIndex) continue;
      const gap = Math.abs(c[j].mjd - c[i].mjd);
      if (d < bestD - TIE || (Math.abs(d - bestD) <= TIE && gap > bestGap)) {
        best = [c[i], c[j]];
        bestD = Math.min(d, bestD);
        bestGap = gap;
      }
    }
  }
  if (!best) return null;
  return best[0].mjd <= best[1].mjd ? best : [best[1], best[0]];
}
