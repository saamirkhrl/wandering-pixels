import type { Detector, MovieMode } from '../data';

export interface ViewerParams {
  q: string | null;
  ra: number | null;
  dec: number | null;
  mode: MovieMode;
  det: Detector | null;
  a: number | null;
  b: number | null;
  diff: boolean;
  snr: boolean;
  frame: number | null;
}

function num(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: string | null): number | null {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.round(n));
}

export function readParams(): ViewerParams {
  const sp = new URLSearchParams(location.search);
  const det = int(sp.get('det'));
  const q = sp.get('q');
  return {
    q: q && q.trim() ? q.trim() : null,
    ra: num(sp.get('ra')),
    dec: num(sp.get('dec')),
    mode: sp.get('mode') === 'single' ? 'single' : 'visit-stack',
    det: det !== null && det >= 1 && det <= 6 ? (det as Detector) : null,
    a: int(sp.get('a')),
    b: int(sp.get('b')),
    diff: sp.get('diff') === '1',
    snr: sp.get('snr') === '1',
    frame: int(sp.get('frame')),
  };
}

export function hasTarget(p: ViewerParams): boolean {
  return p.q !== null || (p.ra !== null && p.dec !== null);
}

export function writeParams(patch: Partial<Record<string, string | null>>): void {
  const sp = new URLSearchParams(location.search);
  sp.set('view', 'viewer');
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) sp.delete(k);
    else sp.set(k, v);
  }
  try {
    history.replaceState(null, '', '?' + sp.toString());
  } catch {
    // ignore
  }
}
