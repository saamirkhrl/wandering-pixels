import type { Target, Exposure, Grid, Frame, FrameOptions, Detector } from './types';
import { SpherexError } from './types';
import { loadFrame } from './frame';
import { annotateWavelengths } from './wavelength';
import { channelBandwidth } from './movie';

function pickDetector(exposures: Exposure[]): Detector {
  const by = new Map<Detector, { visits: Set<number>; count: number }>();
  for (const e of exposures) {
    let s = by.get(e.detector);
    if (!s) {
      s = { visits: new Set(), count: 0 };
      by.set(e.detector, s);
    }
    s.visits.add(e.visitIndex);
    s.count++;
  }
  let best: Detector | null = null;
  for (const d of [...by.keys()].sort((a, b) => a - b)) {
    const s = by.get(d)!;
    const b = best === null ? null : by.get(best)!;
    if (b === null || s.visits.size > b.visits.size || (s.visits.size === b.visits.size && s.count > b.count)) best = d;
  }
  if (best === null) throw new SpherexError('NO_COVERAGE', 'No exposures to build a first look from');
  return best;
}

function bandwidthOf(e: Exposure): number {
  const bw = e.bandwidthAtTarget;
  if (bw !== null && Number.isFinite(bw)) return bw;
  return channelBandwidth(e.detector, e.wavelengthAtTarget as number);
}

/** Two frames from the earliest and latest visit of one detector, for a quick first look. */
export async function loadFirstLook(
  target: Target,
  exposures: Exposure[],
  grid: Grid,
  opts: FrameOptions & { detector?: Detector } = {},
): Promise<{ frames: Frame[]; matched: boolean; detector: Detector }> {
  const { detector: wanted, ...frameOpts } = opts;
  const detector = wanted ?? pickDetector(exposures);
  const onDet = exposures.filter((e) => e.detector === detector);
  if (onDet.length === 0) throw new SpherexError('NO_COVERAGE', `No exposures on detector ${detector}`);

  const visits = new Map<number, Exposure[]>();
  for (const e of onDet) {
    const l = visits.get(e.visitIndex);
    if (l) l.push(e);
    else visits.set(e.visitIndex, [e]);
  }
  const summary = [...visits.values()].map((list) => ({
    sorted: [...list].sort((a, b) => a.mjd - b.mjd),
    t: list.reduce((s, e) => s + e.mjd, 0) / list.length,
  }));
  summary.sort((a, b) => a.t - b.t);
  const slots = summary.length === 1 ? [summary[0].sorted] : [summary[0].sorted, summary[summary.length - 1].sorted];

  const fo: FrameOptions = { ...frameOpts, target };
  const results = await Promise.all(slots.map((c) => loadSlot(c, grid, fo)));
  const frames = results.map((r) => r.frame).filter((f): f is Frame => f !== null);
  if (frames.length === 0) {
    const err = results.find((r) => r.error)?.error as { message?: string } | undefined;
    const why = err?.message ?? 'no frames loaded';
    throw new SpherexError('NO_COVERAGE', `First look failed: ${why}`, { cause: err });
  }
  frames.sort((a, b) => a.exposure.mjd - b.exposure.mjd);
  return { frames, matched: isMatched(frames), detector };
}

const GOOD_COVERAGE = 0.9;
const SLOT_EXTRA_ATTEMPTS = 2;
const PAIR_EXTRA_LOADS = 4;

/** Load candidates in order until one has good coverage; keep the best. A failed load is an attempt. */
async function loadSlot(
  candidates: Exposure[],
  grid: Grid,
  opts: FrameOptions,
): Promise<{ frame: Frame | null; error: unknown }> {
  let best: Frame | null = null;
  let error: unknown = undefined;
  const n = Math.min(candidates.length, 1 + SLOT_EXTRA_ATTEMPTS);
  for (let i = 0; i < n; i++) {
    try {
      const f = await loadFrame(candidates[i], grid, opts);
      if (best === null || f.coverage > best.coverage) best = f;
      if (f.coverage >= GOOD_COVERAGE) break;
    } catch (err) {
      if (error === undefined) error = err;
      if (err instanceof SpherexError && err.code === 'ABORTED') throw err;
    }
  }
  return { frame: best, error };
}

function isMatched(frames: Frame[]): boolean {
  if (frames.length !== 2) return false;
  const [a, b] = [frames[0].exposure, frames[1].exposure];
  const wa = a.wavelengthAtTarget;
  const wb = b.wavelengthAtTarget;
  if (wa === null || wb === null || !Number.isFinite(wa) || !Number.isFinite(wb)) return false;
  return Math.abs(wa - wb) < (bandwidthOf(a) + bandwidthOf(b)) / 2;
}

function finiteWl(e: Exposure): boolean {
  return e.wavelengthAtTarget !== null && Number.isFinite(e.wavelengthAtTarget);
}

/**
 * Two frames from different visits whose wavelengths are as close as possible, so the pair blinks
 * cleanly. Walks cross-visit pairs by increasing wavelength gap, loading frames lazily, and accepts
 * the first pair with good coverage in both. Falls back to loadFirstLook when no pair exists.
 */
export async function loadBestPair(
  target: Target,
  exposures: Exposure[],
  grid: Grid,
  opts: FrameOptions & { detector?: Detector; maxWavelengthGapUm?: number; gapDays?: [number, number] } = {},
): Promise<{ frames: Frame[]; matched: boolean; detector: Detector }> {
  const { detector: wanted, maxWavelengthGapUm, gapDays, ...frameOpts } = opts;
  const detector = wanted ?? pickDetector(exposures);
  let onDet = exposures.filter((e) => e.detector === detector);
  if (onDet.length === 0) throw new SpherexError('NO_COVERAGE', `No exposures on detector ${detector}`);

  if (onDet.filter(finiteWl).length < 2) {
    onDet = await annotateWavelengths(onDet, target.ra, target.dec, { ...frameOpts, target });
  }

  const withWl = onDet.filter(finiteWl);
  const pairs: { a: Exposure; b: Exposure; gap: number; dt: number }[] = [];
  for (let i = 0; i < withWl.length; i++) {
    for (let j = i + 1; j < withWl.length; j++) {
      const a = withWl[i];
      const b = withWl[j];
      if (a.visitIndex === b.visitIndex) continue;
      const gap = Math.abs((a.wavelengthAtTarget as number) - (b.wavelengthAtTarget as number));
      if (maxWavelengthGapUm !== undefined && gap > maxWavelengthGapUm) continue;
      const dt = Math.abs(a.mjd - b.mjd);
      if (gapDays !== undefined && !(dt >= gapDays[0] && dt <= gapDays[1])) continue;
      pairs.push({ a, b, gap, dt });
    }
  }
  pairs.sort((p, q) => p.gap - q.gap || q.dt - p.dt);
  if (pairs.length === 0) return loadFirstLook(target, onDet, grid, { ...frameOpts, detector });

  const fo: FrameOptions = { ...frameOpts, target };
  const cache = new Map<string, Promise<Frame | null>>();
  let loads = 0;
  let firstPairLoads = -1;
  let firstError: unknown = undefined;
  const get = (e: Exposure): Promise<Frame | null> => {
    let p = cache.get(e.id);
    if (!p) {
      loads++;
      p = loadFrame(e, grid, fo).catch((err) => {
        if (err instanceof SpherexError && err.code === 'ABORTED') throw err;
        if (firstError === undefined) firstError = err;
        return null;
      });
      cache.set(e.id, p);
    }
    return p;
  };

  let bestPair: { fa: Frame; fb: Frame; score: number } | null = null;
  let bestSingle: Frame | null = null;
  const note = (f: Frame | null): void => {
    if (f && (bestSingle === null || f.coverage > bestSingle.coverage)) bestSingle = f;
  };

  for (const p of pairs) {
    const needed = (cache.has(p.a.id) ? 0 : 1) + (cache.has(p.b.id) ? 0 : 1);
    if (firstPairLoads >= 0 && loads + needed > firstPairLoads + PAIR_EXTRA_LOADS) continue;
    const [fa, fb] = await Promise.all([get(p.a), get(p.b)]);
    if (firstPairLoads < 0) firstPairLoads = loads;
    note(fa);
    note(fb);
    if (fa && fb) {
      const score = Math.min(fa.coverage, fb.coverage);
      if (bestPair === null || score > bestPair.score) bestPair = { fa, fb, score };
      if (score >= GOOD_COVERAGE) break;
    }
  }

  if (bestPair) {
    const frames = [bestPair.fa, bestPair.fb].sort((a, b) => a.exposure.mjd - b.exposure.mjd);
    return { frames, matched: isMatched(frames), detector };
  }
  if (bestSingle) return { frames: [bestSingle], matched: false, detector };
  const err = firstError as { message?: string } | undefined;
  throw new SpherexError('NO_COVERAGE', `Best pair failed: ${err?.message ?? 'no frames loaded'}`, { cause: err });
}
