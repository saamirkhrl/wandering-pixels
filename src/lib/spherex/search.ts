import { SpherexError } from './types';
import type { CallOptions, Detector, Exposure } from './types';
import { fetchJson, relayUrl } from './net';

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
}

const MJD_UNIX_EPOCH = 40587;
const VISIT_GAP_DAYS = 30;
const RELEASE_RANK: Record<string, number> = { dr1: 0, qr3: 1, qr2: 2 };

export function mjdToIso(mjd: number): string {
  return new Date((mjd - MJD_UNIX_EPOCH) * 86400000).toISOString();
}

const VISIT_MAX_SPAN_DAYS = 45;
const VISIT_BIN_DAYS = 30;

// Returns new objects sorted by mjd with visitIndex set. A gap over 30 days starts a
// new visit. A visit spanning more than 45 days (continuous coverage near the ecliptic
// poles) is split into consecutive 30-day bins measured from its first exposure.
export function assignVisits(exposures: Exposure[]): Exposure[] {
  const sorted = [...exposures].sort((a, b) => a.mjd - b.mjd);
  const groups: Exposure[][] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i].mjd - sorted[i - 1].mjd > VISIT_GAP_DAYS) groups.push([]);
    groups[groups.length - 1].push(sorted[i]);
  }
  const out: Exposure[] = [];
  let visit = -1;
  for (const g of groups) {
    const t0 = g[0].mjd;
    const split = g[g.length - 1].mjd - t0 > VISIT_MAX_SPAN_DAYS;
    let lastBin = -1;
    for (const e of g) {
      const bin = split ? Math.floor((e.mjd - t0) / VISIT_BIN_DAYS) : 0;
      if (bin !== lastBin) {
        visit++;
        lastBin = bin;
      }
      out.push({ ...e, visitIndex: visit });
    }
  }
  return out;
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
  const body = await fetchJson<ExposuresResponse>(relayUrl('/api/exposures', { ra, dec }), {
    signal, onProgress, stage: 'search', label: 'Exposure search',
  });
  const out = rowsToExposures(body.exposures ?? []);
  if (out.length === 0) {
    throw new SpherexError('NO_COVERAGE', 'No SPHEREx exposures cover this position');
  }
  onProgress?.({
    stage: 'search', done: out.length, total: out.length,
    message: `Found ${out.length} exposures`,
  });
  return out;
}
