import type { Target, Exposure, Grid, Frame, FrameOptions, Detector } from './types';
import { SpherexError } from './types';
import { loadFrames } from './frame';
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
  const summary = [...visits.values()].map((list) => {
    const sorted = [...list].sort((a, b) => a.mjd - b.mjd);
    return { first: sorted[0], t: list.reduce((s, e) => s + e.mjd, 0) / list.length };
  });
  summary.sort((a, b) => a.t - b.t);
  const chosen = summary.length === 1 ? [summary[0].first] : [summary[0].first, summary[summary.length - 1].first];

  const { frames, failed } = await loadFrames(chosen, grid, { ...frameOpts, target });
  if (frames.length === 0) {
    const why = failed.length > 0 ? failed[0].error.message : 'no frames loaded';
    throw new SpherexError('NO_COVERAGE', `First look failed: ${why}`, { cause: failed[0]?.error });
  }
  frames.sort((a, b) => a.exposure.mjd - b.exposure.mjd);

  let matched = false;
  if (frames.length === 2) {
    const [a, b] = [frames[0].exposure, frames[1].exposure];
    const wa = a.wavelengthAtTarget;
    const wb = b.wavelengthAtTarget;
    if (wa !== null && wb !== null && Number.isFinite(wa) && Number.isFinite(wb)) {
      matched = Math.abs(wa - wb) < (bandwidthOf(a) + bandwidthOf(b)) / 2;
    }
  }
  return { frames, matched, detector };
}
