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
  frame: number | null;
  size: number | null;
  trueSharp: boolean;
  planet: 0 | 1 | 2;
  dist: number | null;
  ref: number | null;
  drange: 'faint' | 'balanced' | 'bright';
  overlays: string[];
  from: 'sky' | 'globe' | null;
  fromParams: Record<string, string>;
}

export const OVERLAY_KEYS = ['gaia', 'wise', 'masked', 'adv'] as const;

function num(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: string | null): number | null {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.round(n));
}

function fromParams(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  sp.forEach((v, k) => {
    if (k.startsWith('from-') && k.length > 5) out[k.slice(5)] = v;
  });
  return out;
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
    frame: int(sp.get('frame')),
    trueSharp: sp.get('px') === '1',
    planet: sp.get('planet') === '1' ? 1 : sp.get('planet') === '2' ? 2 : 0,
    dist: num(sp.get('dist')),
    ref: num(sp.get('ref')),
    drange: sp.get('drange') === 'f' ? 'faint' : sp.get('drange') === 'h' ? 'bright' : 'balanced',
    size: [200, 400, 800].includes(int(sp.get('size')) ?? 0) ? int(sp.get('size')) : null,
    overlays: (sp.get('overlays') ?? '')
      .split(',')
      .filter((k) => (OVERLAY_KEYS as readonly string[]).includes(k)),
    from: sp.get('from') === 'sky' ? 'sky' : sp.get('from') === 'globe' ? 'globe' : null,
    fromParams: fromParams(sp),
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
