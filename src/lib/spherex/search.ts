import { SpherexError } from './types';
import type { CallOptions, Detector, Exposure } from './types';
import { fetchJson, relayUrl, sleep } from './net';

export interface ExposureRow {
  obsId: string;
  detector: number;
  tMin: number;
  tMax: number;
  url: string;
  release: 'dr1' | 'qr2' | 'qr3';
}

interface ExposuresResponse {
  exposures?: ExposureRow[];
  partial?: string[];
}

// When the relay reports collections it could not reach, wait a moment and ask once more. Partial
// answers are served uncached, so the second call reaches the archive again. Extra time is bounded
// by the delay plus the timeout.
export const PARTIAL_RETRY_DELAY_MS = 2000;
export const PARTIAL_RETRY_TIMEOUT_MS = 8000;

const MJD_UNIX_EPOCH = 40587;
export const VISIT_GAP_DAYS = 30;
const RELEASE_RANK: Record<string, number> = { dr1: 0, qr3: 1, qr2: 2 };

export function mjdToIso(mjd: number): string {
  return new Date((mjd - MJD_UNIX_EPOCH) * 86400000).toISOString();
}

export const VISIT_MAX_SPAN_DAYS = 90;
export const VISIT_BIN_DAYS = 60;

export const SUBCLUSTER_GAP_DAYS = 7;
export const MIN_STACK_EXPOSURES = 12;

function splitByGap(sorted: Exposure[], gapDays: number): Exposure[][] {
  const out: Exposure[][] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i].mjd - sorted[i - 1].mjd > gapDays) out.push([]);
    out[out.length - 1].push(sorted[i]);
  }
  return out;
}

interface VisitGroup {
  members: Exposure[];
  binned: boolean;
}

// Returns new objects sorted by mjd with visitIndex and inStack set.
// 1. A gap over 30 days starts a new visit. A visit spanning more than 90 days
//    (continuous coverage near the ecliptic poles) is split into consecutive 60-day
//    bins measured from its first exposure.
// 2. Within an unbinned visit, exposures are sub-clustered with a 7-day gap. If every
//    sub-cluster other than the largest has fewer than 12 exposures, those small ones
//    get inStack false (the target moves between them and the main cluster).
// 3. A whole visit with fewer than 12 exposures is merged into the nearest visit in
//    time, with inStack false, as long as some visit has 12 or more.
export function assignVisits(exposures: Exposure[]): Exposure[] {
  const sorted = [...exposures].sort((a, b) => a.mjd - b.mjd);
  const visits: VisitGroup[] = [];
  for (const g of splitByGap(sorted, VISIT_GAP_DAYS)) {
    const t0 = g[0].mjd;
    if (g[g.length - 1].mjd - t0 > VISIT_MAX_SPAN_DAYS) {
      let lastBin = -1;
      for (const e of g) {
        const bin = Math.floor((e.mjd - t0) / VISIT_BIN_DAYS);
        if (bin !== lastBin) {
          visits.push({ members: [], binned: true });
          lastBin = bin;
        }
        visits[visits.length - 1].members.push(e);
      }
    } else {
      visits.push({ members: g, binned: false });
    }
  }

  const outOfStack = new Set<Exposure>();
  for (const v of visits) {
    if (v.binned) continue;
    const subs = splitByGap(v.members, SUBCLUSTER_GAP_DAYS);
    if (subs.length < 2) continue;
    const main = subs.reduce((a, b) => (b.length > a.length ? b : a));
    if (subs.every((s) => s === main || s.length < MIN_STACK_EXPOSURES)) {
      for (const s of subs) if (s !== main) for (const e of s) outOfStack.add(e);
    }
  }

  const big = visits.filter((v) => v.members.length >= MIN_STACK_EXPOSURES);
  const kept = big.length > 0 ? big : visits;
  if (big.length > 0) {
    for (const v of visits) {
      if (v.members.length >= MIN_STACK_EXPOSURES) continue;
      const lo = v.members[0].mjd;
      const hi = v.members[v.members.length - 1].mjd;
      let best = big[0];
      let bestDist = Infinity;
      for (const b of big) {
        const blo = b.members[0].mjd;
        const bhi = b.members[b.members.length - 1].mjd;
        const d = blo > hi ? blo - hi : lo > bhi ? lo - bhi : 0;
        if (d < bestDist) {
          bestDist = d;
          best = b;
        }
      }
      for (const e of v.members) {
        outOfStack.add(e);
        best.members.push(e);
      }
    }
  }

  const index = new Map<Exposure, number>();
  kept.forEach((v, i) => {
    for (const e of v.members) index.set(e, i);
  });
  return sorted.map((e) => ({ ...e, visitIndex: index.get(e) ?? 0, inStack: !outOfStack.has(e) }));
}

export function rowsToExposures(rows: ExposureRow[]): Exposure[] {
  const byId = new Map<string, Exposure>();
  for (const r of rows) {
    const mjd = (r.tMin + r.tMax) / 2;
    const e: Exposure = {
      id: `${r.obsId}D${r.detector}`,
      obsId: r.obsId,
      detector: r.detector as Detector,
      time: mjdToIso(mjd),
      mjd,
      visitIndex: 0,
      wavelengthAtTarget: null,
      bandwidthAtTarget: null,
      url: r.url,
      release: r.release,
    };
    const prev = byId.get(e.id);
    if (!prev || (RELEASE_RANK[e.release] ?? 9) < (RELEASE_RANK[prev.release] ?? 9)) {
      byId.set(e.id, e);
    }
  }
  const sorted = [...byId.values()].sort((a, b) => a.mjd - b.mjd || (a.id < b.id ? -1 : 1));
  return assignVisits(sorted);
}

export async function findExposures(ra: number, dec: number, opts: CallOptions = {}): Promise<Exposure[]> {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
    throw new SpherexError('BAD_INPUT', 'ra and dec must be finite numbers');
  }
  if (dec < -90 || dec > 90) throw new SpherexError('BAD_INPUT', 'dec must be within -90..90');
  ra = ((ra % 360) + 360) % 360;
  const { signal, onProgress } = opts;
  onProgress?.({ stage: 'search', done: 0, total: 0, message: 'Searching the SPHEREx archive' });
  const url = relayUrl('/api/exposures', { ra, dec });
  const body = await fetchJson<ExposuresResponse>(url, {
    signal, onProgress, stage: 'search', label: 'Exposure search',
  });
  let final = body;
  if ((body.partial?.length ?? 0) > 0) {
    onProgress?.({
      stage: 'search', done: 0, total: 0, message: 'The archive is slow; showing a partial result',
    });
    try {
      await sleep(PARTIAL_RETRY_DELAY_MS, signal);
      const again = await fetchJson<ExposuresResponse>(url, {
        signal, onProgress, stage: 'search', label: 'Exposure search',
        retries: 0, timeoutMs: PARTIAL_RETRY_TIMEOUT_MS,
      });
      if ((again.partial?.length ?? 0) === 0) final = again;
    } catch (e) {
      if (signal?.aborted || (e instanceof SpherexError && e.code === 'ABORTED')) throw e;
      // keep the first, partial answer
    }
  }
  const out = rowsToExposures(final.exposures ?? []);
  if (out.length === 0) {
    throw new SpherexError('NO_COVERAGE', 'No SPHEREx exposures cover this position');
  }
  onProgress?.({
    stage: 'search', done: out.length, total: out.length,
    message: `Found ${out.length} exposures`,
  });
  return out;
}
