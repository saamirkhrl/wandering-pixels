import { FLAG_BITS, SpherexError } from './types';
import { gridAt, positionAtDistance } from '../../lib/spherex/parallax';
import type {
  CachedDetectorData,
  CachedPreview,
  CachedSlug,
  CachedTarget,
  CallOptions,
  Detector,
  DifferenceImage,
  DifferenceImageM,
  Exposure,
  FindExposuresOptions,
  FirstLook,
  Frame,
  FrameOptions,
  GaiaStar,
  Grid,
  Movie,
  MovieFrame,
  PairComparison,
  PairedDifference,
  PairPick,
  MovieMode,
  Progress,
  SaturatedSource,
  SpectrumPoint,
  Target,
  WiseSource,
} from './types';

const ARCSEC = 206264.80624709636;
const RAD = Math.PI / 180;
const DEFAULT_SCALE = 6.15;
const DEFAULT_SIZE = 400;
const MJD0 = 60809; // 2025-05-14
const VISIT_DAYS = [0, 182, 365, 464, 547];
const SINGLE_VISIT_DAYS = [0];

export const MOCK_FRAME_MB = 2.0;

const DETECTOR_RANGE: Record<Detector, [number, number]> = {
  1: [0.75, 1.09],
  2: [1.1, 1.62],
  3: [1.63, 2.41],
  4: [2.42, 3.82],
  5: [3.83, 4.41],
  6: [4.42, 5.0],
};
const DETECTORS: Detector[] = [1, 2, 3, 4, 5, 6];

let latencyScale = 1;

export function setMockLatencyScale(scale: number): void {
  latencyScale = Math.max(0, scale);
}

// ---------------------------------------------------------------- helpers

function aborted(): SpherexError {
  return new SpherexError('ABORTED', 'Cancelled.');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const t = ms * latencyScale;
    if (t <= 0) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(id);
      reject(aborted());
    };
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, t);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted();
}

function emit(opts: CallOptions | undefined, p: Progress): void {
  opts?.onProgress?.(p);
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  u: () => number;
  n: () => number;
}

function makeRng(seed: number): Rng {
  const u = mulberry32(seed);
  let spare: number | null = null;
  return {
    u,
    n() {
      if (spare !== null) {
        const s = spare;
        spare = null;
        return s;
      }
      let a = u();
      if (a < 1e-12) a = 1e-12;
      const b = u();
      const r = Math.sqrt(-2 * Math.log(a));
      spare = r * Math.sin(2 * Math.PI * b);
      return r * Math.cos(2 * Math.PI * b);
    },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function epochToMjd(epoch: number): number {
  return 51544.5 + (epoch - 2000) * 365.25;
}

function mjdToIso(mjd: number): string {
  return new Date(Math.round((mjd - 40587) * 86400000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function angSep(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d = ((ra2 - ra1 + 540) % 360) - 180;
  const dx = d * Math.cos(((dec1 + dec2) / 2) * RAD) * 3600;
  const dy = (dec2 - dec1) * 3600;
  return Math.hypot(dx, dy);
}

function pad(n: number, len: number): string {
  return String(n).padStart(len, '0');
}

function percentile(sorted: Float32Array, q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ------------------------------------------------------------- geometry

function tanForward(ra0: number, dec0: number, ra: number, dec: number): [number, number] {
  const da = (ra - ra0) * RAD;
  const d0 = dec0 * RAD;
  const d = dec * RAD;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
  const xi = (Math.cos(d) * Math.sin(da)) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / cosc;
  return [xi * ARCSEC, eta * ARCSEC];
}

function tanInverse(ra0: number, dec0: number, xiAs: number, etaAs: number): { ra: number; dec: number } {
  const xi = xiAs / ARCSEC;
  const eta = etaAs / ARCSEC;
  const rho = Math.hypot(xi, eta);
  if (rho < 1e-15) return { ra: ra0, dec: dec0 };
  const d0 = dec0 * RAD;
  const c = Math.atan(rho);
  const sinc = Math.sin(c);
  const cosc = Math.cos(c);
  const dec = Math.asin(cosc * Math.sin(d0) + (eta * sinc * Math.cos(d0)) / rho);
  const ra = ra0 * RAD + Math.atan2(xi * sinc, rho * Math.cos(d0) * cosc - eta * Math.sin(d0) * sinc);
  let raDeg = (ra / RAD) % 360;
  if (raDeg < 0) raDeg += 360;
  return { ra: raDeg, dec: dec / RAD };
}

export function worldToGrid(grid: Grid, ra: number, dec: number): [number, number] {
  const [xi, eta] = tanForward(grid.ra0, grid.dec0, ra, dec);
  const cx = (grid.w - 1) / 2;
  const cy = (grid.h - 1) / 2;
  return [cx - xi / grid.scaleArcsec, cy - eta / grid.scaleArcsec];
}

export function gridToWorld(grid: Grid, x: number, y: number): { ra: number; dec: number } {
  const cx = (grid.w - 1) / 2;
  const cy = (grid.h - 1) / 2;
  return tanInverse(grid.ra0, grid.dec0, (cx - x) * grid.scaleArcsec, (cy - y) * grid.scaleArcsec);
}

export function positionAt(target: Target, mjd: number): { ra: number; dec: number } {
  const dt = (mjd - epochToMjd(target.epoch ?? 2000)) / 365.25;
  const dec = target.dec + ((target.pmdec ?? 0) * dt) / 3.6e6;
  const cosd = Math.cos(((dec + target.dec) / 2) * RAD);
  let ra = target.ra + ((target.pmra ?? 0) * dt) / 3.6e6 / cosd;
  ra = ((ra % 360) + 360) % 360;
  return { ra, dec };
}

function oddRound(v: number): number {
  const n = Math.max(3, Math.round(v));
  return n % 2 === 0 ? n + 1 : n;
}

export function makeGrid(
  target: Target,
  exposures: Exposure[],
  sizeArcsec: number = DEFAULT_SIZE,
  scaleArcsec: number = DEFAULT_SCALE,
): Grid {
  const mean = exposures.length
    ? exposures.reduce((s, e) => s + e.mjd, 0) / exposures.length
    : epochToMjd(target.epoch ?? 2000);
  const c = positionAt(target, mean);
  const w = oddRound(sizeArcsec / scaleArcsec);
  return { ra0: c.ra, dec0: c.dec, w, h: w, scaleArcsec, epochMjd: mean };
}

// ----------------------------------------------------------- the sky model

interface Star {
  id: string;
  ra: number;
  dec: number;
  pmra: number;
  pmdec: number;
  plx: number;
  gmag: number;
  peak1: number;
  slope: number;
  w1: number | null;
  w2: number | null;
}

interface Scene {
  key: string;
  kind: 'cached' | 'live';
  target: Target;
  ref: { ra: number; dec: number };
  stars: Star[];
  exposures: Exposure[];
  amp: (wl: number, visit: number, jitter: number) => number;
  fake: { ra: number; dec: number } | null;
  gaiaTarget: GaiaStar | null;
  wiseTarget: WiseSource | null;
}

interface RegEntry {
  scene: Scene;
  wl: number;
  bw: number;
}

const registry = new Map<string, RegEntry>();

function gaiaId(rng: Rng): string {
  let s = '4';
  for (let i = 0; i < 18; i++) s += Math.floor(rng.u() * 10);
  return s;
}

function genStars(seed: number, ref: { ra: number; dec: number }): Star[] {
  const rng = makeRng(seed ^ 0x51ed270b);
  const out: Star[] = [];
  const mk = (xi: number, eta: number, g: number): Star => {
    const p = tanInverse(ref.ra, ref.dec, xi, eta);
    const w1 = g - 1.3 - 0.5 * rng.u();
    const w2 = w1 - 0.05 - 0.15 * rng.u();
    return {
      id: gaiaId(rng),
      ra: p.ra,
      dec: p.dec,
      pmra: rng.n() * 12,
      pmdec: rng.n() * 12,
      plx: Math.max(0.05, 0.5 + rng.u() * rng.u() * 8),
      gmag: g,
      peak1: 900 * Math.pow(10, -0.4 * (g - 11)),
      slope: 1.0 + 0.8 * rng.u(),
      w1: w1 > 17.5 ? null : w1,
      w2: w2 > 16.5 ? null : w2,
    };
  };
  // fixed star 80 arcsec east and 80 arcsec north of the reference point
  out.push(mk(80, 80, 12.3));
  for (let i = 0; i < 36; i++) {
    const xi = (rng.u() - 0.5) * 840;
    const eta = (rng.u() - 0.5) * 840;
    const g = 11 + 8.5 * Math.sqrt(rng.u());
    if (Math.hypot(xi, eta) < 25) continue;
    out.push(mk(xi, eta, g));
  }
  return out;
}

interface Def {
  slug: CachedSlug;
  name: string;
  blurb: string;
  aliases: string[];
  ra: number;
  dec: number;
  pmra: number;
  pmdec: number;
  plx: number | null;
  gmag: number | null;
  gaiaId: string;
  w1: number | null;
  w2: number | null;
  spectrum: [number, number][];
  visitMult: number[];
  visitDays: number[];
  perVisit: [number, number];
  bandShift: number;
  startShift: number;
  noD6: boolean;
  seed: number;
}

const DEFS: Def[] = [
  {
    slug: 'barnards-star',
    name: "Barnard's Star",
    blurb: 'The fastest-moving star in our sky, 10 arcsec a year.',
    aliases: ['barnards star', 'barnard star', 'gj 699'],
    ra: 269.4521,
    dec: 4.6934,
    pmra: -801.6,
    pmdec: 10362.4,
    plx: 546.98,
    gmag: 9.51,
    gaiaId: '4472832130942575872',
    w1: 4.52,
    w2: 4.32,
    spectrum: [
      [0.75, 700],
      [1.0, 1000],
      [1.6, 420],
      [2.4, 170],
      [3.8, 60],
      [4.4, 40],
      [5.0, 32],
    ],
    visitMult: [1, 1, 1],
    visitDays: [91, 300, 456],
    perVisit: [2, 4],
    bandShift: 0,
    startShift: 0,
    noD6: true,
    seed: 11,
  },
  {
    slug: 'eps-indi-b',
    name: 'Eps Indi B',
    blurb: 'A cool brown dwarf, one of our nearest neighbours.',
    aliases: ['epsilon indi b', 'eps ind b', 'eps indi ba', 'epsilon indi'],
    ra: 330.879,
    dec: -56.7978,
    pmra: 3966,
    pmdec: -2536,
    plx: 274.8,
    gmag: 14.7,
    gaiaId: '6412595290592307712',
    w1: 11.7,
    w2: 8.7,
    spectrum: [
      [0.75, 2],
      [1.0, 25],
      [1.25, 70],
      [1.6, 25],
      [2.4, 6],
      [3.0, 5],
      [3.8, 40],
      [4.5, 120],
      [5.0, 100],
    ],
    visitMult: [1, 1, 1, 1, 1],
    visitDays: VISIT_DAYS,
    perVisit: [2, 4],
    bandShift: 0.03,
    startShift: 4,
    noD6: true,
    seed: 23,
  },
  {
    slug: 'wise-0855',
    name: 'WISE 0855-0714',
    blurb: 'One of the coldest brown dwarfs known, 7 light years away.',
    aliases: ['wise 0855', 'wise0855', 'wise j0855', 'wise 0855 0714', 'w0855'],
    ra: 133.7863,
    dec: -7.2443,
    pmra: -8118,
    pmdec: 673,
    plx: null,
    gmag: null,
    gaiaId: '',
    w1: null,
    w2: 13.9,
    spectrum: [
      [0.75, 0],
      [2.4, 0.05],
      [3.0, 0.3],
      [3.8, 5],
      [4.5, 30],
      [5.0, 25],
    ],
    visitMult: [1, 1, 1, 1, 1],
    visitDays: VISIT_DAYS,
    perVisit: [2, 4],
    bandShift: -0.03,
    startShift: 7,
    noD6: false,
    seed: 37,
  },
  {
    slug: 'rw-aur',
    name: 'RW Aur',
    blurb: 'A young star whose brightness changes from visit to visit.',
    aliases: ['rw aurigae'],
    ra: 76.9563,
    dec: 30.4013,
    pmra: 0.9,
    pmdec: -23.8,
    plx: 6.1,
    gmag: 10.2,
    gaiaId: '156430259646095616',
    w1: 6.5,
    w2: 5.6,
    spectrum: [
      [0.75, 60],
      [1.0, 110],
      [1.6, 200],
      [2.4, 300],
      [3.8, 330],
      [4.4, 330],
      [5.0, 350],
    ],
    visitMult: [1.0, 0.45, 0.8, 0.3, 1.3],
    visitDays: VISIT_DAYS,
    perVisit: [2, 4],
    bandShift: 0.02,
    startShift: 2,
    noD6: false,
    seed: 41,
  },
  {
    slug: 'r-dra',
    name: 'R Dra',
    blurb: 'A pulsating red giant that swings widely in brightness.',
    aliases: ['r draconis'],
    ra: 248.1675,
    dec: 66.7529,
    pmra: -2.3,
    pmdec: 8.1,
    plx: 1.1,
    gmag: 10.0,
    gaiaId: '1624598143204608512',
    w1: 1.9,
    w2: 1.3,
    spectrum: [
      [0.75, 40],
      [1.0, 150],
      [1.6, 500],
      [2.4, 700],
      [3.8, 500],
      [4.4, 350],
      [5.0, 400],
    ],
    visitMult: Array.from({ length: 16 }, (_, i) => 0.2 + 0.9 * (0.5 + 0.5 * Math.cos((2 * Math.PI * i * 31) / 245))),
    visitDays: Array.from({ length: 16 }, (_, i) => i * 31),
    perVisit: [1, 2],
    bandShift: -0.02,
    startShift: 9,
    noD6: false,
    seed: 53,
  },
];

const BUILTIN_NAMES: { names: string[]; display: string; ra: number; dec: number; pmra: number; pmdec: number }[] = [
  { names: ['vega', 'alpha lyrae'], display: 'Vega', ra: 279.2347, dec: 38.7837, pmra: 200.94, pmdec: 286.23 },
  {
    names: ['proxima cen', 'proxima centauri', 'proxima'],
    display: 'Proxima Cen',
    ra: 217.4289,
    dec: -62.6795,
    pmra: -3781.3,
    pmdec: 769.8,
  },
  { names: ['betelgeuse', 'alpha orionis'], display: 'Betelgeuse', ra: 88.7929, dec: 7.4071, pmra: 27.5, pmdec: 11.3 },
  { names: ['sirius', 'alpha canis majoris'], display: 'Sirius', ra: 101.2872, dec: -16.7161, pmra: -546, pmdec: -1223 },
  { names: ['m31', 'andromeda galaxy', 'andromeda'], display: 'M31', ra: 10.6847, dec: 41.2687, pmra: 0, pmdec: 0 },
];

function defTarget(def: Def): Target {
  return {
    ra: def.ra,
    dec: def.dec,
    pmra: def.pmra,
    pmdec: def.pmdec,
    epoch: 2000,
    name: def.name,
    source: 'cache',
  };
}

function interp(table: [number, number][], wl: number): number {
  if (wl <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (wl <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (wl - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

// ----------------------------------------------------------- exposures

function makeSchedule(
  seed: number,
  shift: number,
  bandShift: number,
  detectors: Detector[],
  visitDays: number[],
  live: boolean,
  perVisit: [number, number] = [2, 4],
): { exposures: Exposure[]; spec: Map<string, { wl: number; bw: number }> } {
  const exposures: Exposure[] = [];
  const spec = new Map<string, { wl: number; bw: number }>();
  let seq = 100 + (seed % 500);
  for (let v = 0; v < visitDays.length; v++) {
    for (const d of detectors) {
      const rng = makeRng(seed * 31 + v * 7 + d);
      const n = live ? 18 + Math.floor(rng.u() * 5) : perVisit[0] + Math.floor(rng.u() * (perVisit[1] - perVisit[0] + 1));
      let t = MJD0 + shift + visitDays[v] + (d - 1) * 0.3 + rng.u() * 0.4;
      const [lo, hi] = DETECTOR_RANGE[d];
      for (let k = 0; k < n; k++) {
        if (k > 0) t += live ? 0.05 + rng.u() * 0.5 : 0.15 + rng.u() * 2.0;
        const mjd = Math.round(t * 86400) / 86400;
        const frac = clamp(
          0.5 + 0.36 * Math.cos((2 * Math.PI * visitDays[v]) / 365.25 + 0.6 * d) + bandShift + (live ? 0.005 : 0.004) * k,
          0.04,
          0.96,
        );
        const wl = lo + frac * (hi - lo);
        const bw = wl / (d <= 4 ? 40 : 120);
        const date = new Date((mjd - 40587) * 86400000);
        const yr = date.getUTCFullYear();
        const doy = Math.floor((date.getTime() - Date.UTC(yr, 0, 1)) / 86400000);
        const wk = Math.min(52, Math.floor(doy / 7) + 1);
        const obsId = `${yr}W${pad(wk, 2)}_1B_${pad(seq++, 4)}`;
        const id = `${obsId}D${d}`;
        exposures.push({
          id,
          obsId,
          detector: d,
          time: mjdToIso(mjd),
          mjd,
          visitIndex: v,
          wavelengthAtTarget: live ? null : wl,
          bandwidthAtTarget: live ? null : bw,
          url: `https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr2/level2/${yr}W${pad(wk, 2)}_1B/l2b-v13/D${d}/level2_${obsId}D${d}_spx.fits`,
          release: 'qr2',
        });
        spec.set(id, { wl, bw });
      }
    }
  }
  exposures.sort((a, b) => a.mjd - b.mjd || a.detector - b.detector);
  return { exposures, spec };
}

// ---------------------------------------------------------- scenes

function wiseId(ra: number, dec: number): string {
  const h = ra / 15;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  const ss = Math.floor(((h - hh) * 60 - mm) * 6000) / 100;
  const sign = dec < 0 ? '-' : '+';
  const a = Math.abs(dec);
  const dd = Math.floor(a);
  const dm = Math.floor((a - dd) * 60);
  const ds = Math.floor(((a - dd) * 60 - dm) * 600) / 10;
  return `J${pad(hh, 2)}${pad(mm, 2)}${ss.toFixed(2).padStart(5, '0')}${sign}${pad(dd, 2)}${pad(dm, 2)}${ds
    .toFixed(1)
    .padStart(4, '0')}`;
}

interface Base {
  def: Def;
  scene: Scene;
  grid: Grid;
}

const bases = new Map<CachedSlug, Base>();

function base(slug: CachedSlug): Base {
  const hit = bases.get(slug);
  if (hit) return hit;
  const def = DEFS.find((d) => d.slug === slug);
  if (!def) throw new SpherexError('NOT_FOUND', 'That challenge target is not available.');
  const target = defTarget(def);
  const sched = makeSchedule(def.seed, def.startShift, def.bandShift, def.noD6 ? [1, 2, 3, 4, 5] : DETECTORS, def.visitDays, false, def.perVisit);
  const grid = makeGrid(target, sched.exposures);
  const ref = { ra: grid.ra0, dec: grid.dec0 };
  const p2016 = positionAt(target, epochToMjd(2016));
  const p2013 = positionAt(target, epochToMjd(2013));
  const scene: Scene = {
    key: slug,
    kind: 'cached',
    target,
    ref,
    stars: genStars(def.seed, ref),
    fake: null,
    exposures: sched.exposures,
    amp: (wl, visit, jitter) =>
      Math.max(0, interp(def.spectrum, wl) * (def.visitMult[visit] ?? 1) * (1 + 0.03 * jitter)),
    gaiaTarget:
      def.gmag === null
        ? null
        : {
            sourceId: def.gaiaId,
            ra: p2016.ra,
            dec: p2016.dec,
            pmra: def.pmra,
            pmdec: def.pmdec,
            parallax: def.plx,
            gmag: def.gmag,
          },
    wiseTarget: {
      id: wiseId(p2013.ra, p2013.dec),
      ra: p2013.ra,
      dec: p2013.dec,
      pmra: def.pmra,
      pmdec: def.pmdec,
      w1mag: def.w1,
      w2mag: def.w2,
    },
  };
  for (const e of sched.exposures) {
    const s = sched.spec.get(e.id);
    if (s) registry.set(e.id, { scene, wl: s.wl, bw: s.bw });
  }
  const b = { def, scene, grid };
  bases.set(slug, b);
  return b;
}

const knownTargets = new Map<string, Target>();
const liveScenes = new Map<string, Scene>();

function posKey(ra: number, dec: number): string {
  return `${ra.toFixed(3)},${dec.toFixed(3)}`;
}

// A faint source that sits where a body at 500 au would appear on every date, anchored at the
// heliocentric direction of the grid centre. Live fields only.
function fakeBody(target: Target, exposures: Exposure[]): { ra: number; dec: number } {
  const mean = exposures.reduce((s, e) => s + e.mjd, 0) / exposures.length;
  return positionAt(target, mean);
}

function brightenFirst(stars: Star[]): Star[] {
  stars[0] = { ...stars[0], gmag: 10.5, peak1: 900 * Math.pow(10, -0.4 * (10.5 - 11)) };
  return stars;
}

function sceneForPosition(ra: number, dec: number): Scene {
  for (const def of DEFS) {
    const b = base(def.slug);
    if (
      angSep(ra, dec, def.ra, def.dec) < 900 ||
      angSep(ra, dec, b.scene.ref.ra, b.scene.ref.dec) < 900
    ) {
      return b.scene;
    }
  }
  const key = posKey(ra, dec);
  const hit = liveScenes.get(key);
  if (hit) return hit;
  const seed = hashStr(key);
  const target: Target = knownTargets.get(key) ?? { ra, dec, epoch: 2000, name: key, source: 'coordinates' };
  const sched = makeSchedule(seed, seed % 15, ((seed >> 4) % 9) / 100 - 0.04, DETECTORS, ra === 2 && dec === 2 ? SINGLE_VISIT_DAYS : VISIT_DAYS, true);
  const mult = [1, 0.92, 1.08, 0.97];
  const p2016 = positionAt(target, epochToMjd(2016));
  const rng = makeRng(seed);
  const scene: Scene = {
    key,
    kind: 'live',
    target,
    ref: { ra, dec },
    stars: brightenFirst(genStars(seed, { ra, dec })),
    fake: fakeBody(target, sched.exposures),
    exposures: sched.exposures,
    amp: (wl, visit, jitter) => Math.max(0, (120 / wl) * mult[visit % 4] * (1 + 0.03 * jitter)),
    gaiaTarget: {
      sourceId: gaiaId(rng),
      ra: p2016.ra,
      dec: p2016.dec,
      pmra: target.pmra ?? 0,
      pmdec: target.pmdec ?? 0,
      parallax: 20,
      gmag: 12.5,
    },
    wiseTarget: {
      id: wiseId(ra, dec),
      ra,
      dec,
      pmra: target.pmra ?? 0,
      pmdec: target.pmdec ?? 0,
      w1mag: 8.0,
      w2mag: 7.9,
    },
  };
  for (const e of sched.exposures) {
    const s = sched.spec.get(e.id);
    if (s) registry.set(e.id, { scene, wl: s.wl, bw: s.bw });
  }
  liveScenes.set(key, scene);
  return scene;
}

function toGaia(s: Star): GaiaStar {
  return { sourceId: s.id, ra: s.ra, dec: s.dec, pmra: s.pmra, pmdec: s.pmdec, parallax: s.plx, gmag: s.gmag };
}

function toWise(s: Star): WiseSource {
  return {
    id: wiseId(s.ra, s.dec),
    ra: s.ra,
    dec: s.dec,
    pmra: s.pmra,
    pmdec: s.pmdec,
    w1mag: s.w1,
    w2mag: s.w2,
  };
}

function coneGaia(scene: Scene, ra: number, dec: number, radius: number): GaiaStar[] {
  const all: GaiaStar[] = scene.stars.map(toGaia);
  if (scene.gaiaTarget) all.push(scene.gaiaTarget);
  return all
    .map((s) => ({ s, d: angSep(ra, dec, s.ra, s.dec) }))
    .filter((x) => x.d <= radius)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.s);
}

function coneWise(scene: Scene, ra: number, dec: number, radius: number): WiseSource[] {
  const all: WiseSource[] = scene.stars.map(toWise);
  if (scene.wiseTarget) all.push(scene.wiseTarget);
  return all
    .map((s) => ({ s, d: angSep(ra, dec, s.ra, s.dec) }))
    .filter((x) => x.d <= radius)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.s);
}

// ------------------------------------------------------- frame rendering

const SATURATION_PEAK = 400;

function psfSigma(wl: number): number {
  return 0.6 + 0.3 * clamp((wl - 0.75) / 4.25, 0, 1);
}

function renderFrame(
  scene: Scene,
  exp: Exposure,
  wl: number,
  bw: number,
  grid: Grid,
  background: 'zodi' | 'none',
  withMaps = false,
): Frame {
  const { w, h } = grid;
  const n = w * h;
  const rng = makeRng(hashStr(exp.id) ^ 0x9e3779b9);
  const sigmaSky = 0.06 + 0.12 * rng.u();
  const psfWl = psfSigma(wl);
  const signal = new Float32Array(n);

  const sat: [number, number][] = [];
  const addSource = (x0: number, y0: number, amp: number, psf = psfWl) => {
    if (amp < 0.01) return;
    if (amp > SATURATION_PEAK) sat.push([Math.round(x0), Math.round(y0)]);
    const r = Math.ceil(4 * psf);
    const xa = Math.max(0, Math.floor(x0) - r);
    const xb = Math.min(w - 1, Math.ceil(x0) + r);
    const ya = Math.max(0, Math.floor(y0) - r);
    const yb = Math.min(h - 1, Math.ceil(y0) + r);
    const k = -0.5 / (psf * psf);
    for (let y = ya; y <= yb; y++) {
      const dy = y - y0;
      for (let x = xa; x <= xb; x++) {
        const dx = x - x0;
        signal[y * w + x] += amp * Math.exp(k * (dx * dx + dy * dy));
      }
    }
  };

  for (const s of scene.stars) {
    const [sx, sy] = worldToGrid(grid, s.ra, s.dec);
    if (sx < -6 || sx > w + 5 || sy < -6 || sy > h + 5) continue;
    addSource(sx, sy, s.peak1 * Math.pow(wl, -s.slope));
  }
  const tp = positionAt(scene.target, exp.mjd);
  const [tx, ty] = worldToGrid(grid, tp.ra, tp.dec);
  addSource(tx, ty, scene.amp(wl, exp.visitIndex, rng.n()));
  if (scene.fake) {
    const fp = positionAtDistance(scene.fake.ra, scene.fake.dec, exp.mjd, 500);
    const [fx, fy] = worldToGrid(grid, fp.ra, fp.dec);
    if (fx > -6 && fx < w + 5 && fy > -6 && fy < h + 5) addSource(fx, fy, 3 * sigmaSky, 0.8);
  }

  const pixels = new Float32Array(n);
  const variance = new Float32Array(n);
  const flags = new Uint8Array(n);
  const s2 = sigmaSky * sigmaSky;
  const zodi = background === 'none' ? 18 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const sig = signal[i];
      const v = s2 + 0.02 * (sig > 0 ? sig : 0);
      variance[i] = v;
      pixels[i] = zodi + 0.04 * (zodi ? x + y : 0) + sig + rng.n() * Math.sqrt(v);
    }
  }

  const mask = (x: number, y: number, bit: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    pixels[i] = NaN;
    variance[i] = NaN;
    flags[i] |= bit;
  };
  const cluster = (cx: number, cy: number, cw: number, ch: number, bit: number) => {
    for (let y = cy; y < cy + ch; y++) for (let x = cx; x < cx + cw; x++) mask(x, y, bit);
  };
  for (const [sx, sy] of sat) cluster(sx - 1, sy - 1, 3, 3, FLAG_BITS.SATURATED);

  const nClusters = 2 + Math.floor(rng.u() * 2);
  for (let c = 0; c < nClusters; c++) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const cx = Math.floor(rng.u() * (w - 3));
      const cy = Math.floor(rng.u() * (h - 3));
      if (Math.hypot(cx - tx, cy - ty) < 5) continue;
      cluster(cx, cy, 1 + Math.floor(rng.u() * 3), 1 + Math.floor(rng.u() * 3), FLAG_BITS.BAD_PIXEL);
      break;
    }
  }
  const hs = hashStr(exp.id);
  if (hs % 3 === 0) {
    const width = 2 + Math.floor(rng.u() * 4);
    const side = (hs >> 3) % 3;
    if (side === 0) cluster(0, 0, width, h, FLAG_BITS.NO_DATA);
    else if (side === 1) cluster(w - width, 0, width, h, FLAG_BITS.NO_DATA);
    else cluster(0, h - width, w, width, FLAG_BITS.NO_DATA);
  }
  if (hs % 11 === 0) cluster(Math.round(tx), Math.round(ty), 2, 2, FLAG_BITS.BAD_PIXEL);
  for (let k = 0; k < 4; k++) {
    const i = Math.floor(rng.u() * n);
    if (Number.isFinite(pixels[i])) flags[i] |= FLAG_BITS.BAD_PIXEL;
  }

  let good = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(pixels[i])) good++;

  const frame: Frame = {
    exposure: { ...exp, wavelengthAtTarget: wl, bandwidthAtTarget: bw },
    grid,
    pixels,
    variance,
    flags,
    w,
    h,
    coverage: good / n,
    bytes: scene.kind === 'live' ? 2_000_000 + (hashStr(exp.id + 'bytes') % 200_000) : 0,
  };
  if (withMaps) {
    const wlMap = new Float32Array(n);
    const bwMap = new Float32Array(n);
    const chan = exp.detector <= 4 ? 40 : 120;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (Number.isFinite(pixels[i])) {
          const v = wl * (1 + 0.02 * ((x - (w - 1) / 2) / w));
          wlMap[i] = v;
          bwMap[i] = v / chan;
        } else {
          wlMap[i] = NaN;
          bwMap[i] = NaN;
        }
      }
    }
    frame.wavelengthMap = wlMap;
    frame.bandwidthMap = bwMap;
  }
  return frame;
}

// ----------------------------------------------------- resolve + search

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fmtCoord(ra: number, dec: number): string {
  return `${ra.toFixed(4)} ${dec >= 0 ? '+' : '-'}${Math.abs(dec).toFixed(4)}`;
}

function parseCoordinates(text: string): { ra: number; dec: number } | null {
  let t = text.trim();
  if (!/^[\d\s.:+\-,hdms°'"]+$/i.test(t)) return null;
  t = t.replace(/(\d)\s*[hdms°'"]+/gi, '$1 ');
  const tokens = t.replace(/[,;:]/g, ' ').trim().split(/\s+/);
  if (!tokens.length || !tokens.every((k) => /^[+-]?\d+(\.\d+)?$/.test(k))) return null;
  if (tokens.length === 2) {
    return { ra: parseFloat(tokens[0]), dec: parseFloat(tokens[1]) };
  }
  if (tokens.length === 6) {
    const [h, m, s, d, dm, ds] = tokens;
    const ra = (Math.abs(parseFloat(h)) + parseFloat(m) / 60 + parseFloat(s) / 3600) * 15;
    const sign = d.startsWith('-') ? -1 : 1;
    const dec = sign * (Math.abs(parseFloat(d)) + parseFloat(dm) / 60 + parseFloat(ds) / 3600);
    return { ra, dec };
  }
  throw new SpherexError('BAD_INPUT', 'Give coordinates as two numbers in degrees, or hours and degrees.');
}

export async function resolveTarget(text: string, opts: CallOptions = {}): Promise<Target> {
  throwIfAborted(opts.signal);
  const raw = (text ?? '').trim();
  const norm = normName(raw);
  if (!/[a-z0-9]/.test(norm)) {
    throw new SpherexError('BAD_INPUT', 'Type a star name or coordinates.');
  }

  for (const def of DEFS) {
    if (norm === normName(def.slug) || norm === normName(def.name) || def.aliases.includes(norm)) {
      return defTarget(def);
    }
  }

  const coords = parseCoordinates(raw);
  let target: Target | null = null;
  if (coords) {
    if (coords.ra < 0 || coords.ra >= 360 || coords.dec < -90 || coords.dec > 90) {
      throw new SpherexError('BAD_INPUT', 'Those coordinates are out of range.');
    }
    target = { ra: coords.ra, dec: coords.dec, epoch: 2000, name: fmtCoord(coords.ra, coords.dec), source: 'coordinates' };
  } else {
    const hit = BUILTIN_NAMES.find((b) => b.names.includes(norm));
    if (hit) {
      target = {
        ra: hit.ra,
        dec: hit.dec,
        pmra: hit.pmra,
        pmdec: hit.pmdec,
        epoch: 2000,
        name: hit.display,
        source: 'simbad',
      };
    }
  }

  emit(opts, { stage: 'resolve', done: 0, total: 1, message: 'Looking up that name' });
  await wait(400, opts.signal);
  if (!target) {
    throw new SpherexError('NOT_FOUND', `Could not find "${raw}". Check the spelling or try coordinates.`);
  }
  knownTargets.set(posKey(target.ra, target.dec), target);
  emit(opts, { stage: 'resolve', done: 1, total: 1, message: 'Found it' });
  return target;
}

export async function findExposures(ra: number, dec: number, opts: FindExposuresOptions = {}): Promise<Exposure[]> {
  throwIfAborted(opts.signal);
  const say = (done: number, total: number, message: string, retrying?: boolean) =>
    emit(opts, retrying ? { stage: 'search', done, total, message, retrying: true } : { stage: 'search', done, total, message });

  const pace = (1300 + (hashStr(posKey(ra, dec)) % 2400)) / 2500;
  const nap = (ms: number) => wait(ms * pace, opts.signal);
  say(0, 0, 'Asking the SPHEREx archive');
  await nap(300);

  if (ra === 1 && dec === 1) {
    say(0, 0, 'The archive is busy, trying again in 2 s', true);
    await nap(1200);
    say(0, 0, 'The archive is still busy, trying again in 4 s', true);
    await nap(1000);
    throw new SpherexError('UPSTREAM_BUSY', 'The archive is busy right now. Try again in a minute.');
  }
  if (dec > 85) {
    await nap(300);
    throw new SpherexError('NO_COVERAGE', 'SPHEREx has no exposures at this position.');
  }

  say(0, 0, 'Asking the SPHEREx archive');
  await nap(500);
  say(0, 0, 'The archive is busy, trying again in 2 s', true);
  await nap(1100);
  say(0, 0, 'Reading the exposure list');
  await nap(600);

  const scene = sceneForPosition(ra, dec);
  const list = scene.exposures.map((e) => ({ ...e }));
  const visitIds = Array.from(new Set(list.map((e) => e.visitIndex))).sort((a, b) => a - b);
  if (opts.onUpdate && visitIds.length >= 3) {
    // Three archive collections. The first answers with two visits (enough for a first look), the
    // earliest visit arrives second so visit numbers shift, the rest arrive last. Updates keep
    // coming after this resolves.
    const lastVisit = visitIds[visitIds.length - 1];
    const groups = [[visitIds[1], lastVisit], [visitIds[0]], visitIds.slice(2, -1)];
    const upTo = (n: number): Exposure[] => {
      const keep = new Set(groups.slice(0, n).flat());
      const order = visitIds.filter((v) => keep.has(v));
      return list.filter((e) => keep.has(e.visitIndex)).map((e) => ({ ...e, visitIndex: order.indexOf(e.visitIndex) }));
    };
    const first = upTo(1);
    const { onUpdate, signal } = opts;
    const names = ['collection 1', 'collection 2', 'collection 3'];
    void (async () => {
      try {
        await wait(10, signal);
        onUpdate(first.map((e) => ({ ...e })), { answered: 1, total: 3, pending: names.slice(1), complete: false });
        await wait(1500, signal);
        onUpdate(upTo(2), { answered: 2, total: 3, pending: names.slice(2), complete: false });
        await wait(1000, signal);
        onUpdate(upTo(3), { answered: 3, total: 3, pending: [], complete: true });
      } catch {
        // aborted: stop quietly
      }
    })();
    say(first.length, first.length, `Found ${first.length} exposures`);
    return first;
  }
  say(list.length, list.length, `Found ${list.length} exposures`);
  return list;
}

export async function annotateWavelengths(
  exposures: Exposure[],
  _ra: number,
  _dec: number,
  opts: CallOptions & { target?: Target } = {},
): Promise<Exposure[]> {
  throwIfAborted(opts.signal);
  const total = exposures.length;
  emit(opts, { stage: 'headers', done: 0, total, message: 'Reading file headers', bytes: 0 });
  await wait(250, opts.signal);
  const out = exposures.map((e) => {
    const r = registry.get(e.id);
    if (!r) return e;
    return { ...e, wavelengthAtTarget: r.wl, bandwidthAtTarget: r.bw };
  });
  const liveCount = exposures.filter((e) => registry.get(e.id)?.scene.kind === 'live').length;
  emit(opts, { stage: 'headers', done: total, total, message: 'Read all file headers', bytes: liveCount * 235_000 });
  return out;
}

// ------------------------------------------------------------ frames

function frameDelay(id: string): number {
  if (registry.get(id)?.scene.kind === 'live') return 250 + (hashStr(id + 'delay') % 500);
  return 150 + (hashStr(id + 'delay') % 150);
}

export async function loadFrame(exposure: Exposure, grid: Grid, opts: FrameOptions = {}): Promise<Frame> {
  throwIfAborted(opts.signal);
  await wait(frameDelay(exposure.id), opts.signal);
  const r = registry.get(exposure.id);
  const scene = r?.scene ?? sceneForPosition(grid.ra0, grid.dec0);
  const range = DETECTOR_RANGE[exposure.detector];
  const wl = r?.wl ?? exposure.wavelengthAtTarget ?? (range[0] + range[1]) / 2;
  const bw = r?.bw ?? exposure.bandwidthAtTarget ?? wl / (exposure.detector <= 4 ? 40 : 120);
  const dist = opts.distanceAu;
  const tracked = typeof dist === 'number' && Number.isFinite(dist) && dist > 0;
  const g = tracked ? gridAt(grid, exposure.mjd, dist, opts.referenceMjd) : grid;
  const frame = renderFrame(scene, exposure, wl, bw, g, opts.background ?? 'zodi', opts.wavelengthMap === true);
  if (tracked) frame.trackingDistanceAu = dist;
  return frame;
}

export async function loadFrames(
  exposures: Exposure[],
  grid: Grid,
  opts: FrameOptions & { concurrency?: number; onFrame?: (f: Frame) => void } = {},
): Promise<{ frames: Frame[]; failed: { exposure: Exposure; error: SpherexError }[] }> {
  throwIfAborted(opts.signal);
  const total = exposures.length;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const results: (Frame | null)[] = new Array(total).fill(null);
  const failed: { exposure: Exposure; error: SpherexError }[] = [];
  const failIndex = total >= 4 && registry.get(exposures[0].id)?.scene.kind === 'live' ? 2 : -1;
  let next = 0;
  let done = 0;
  let bytes = 0;
  const report = () =>
    emit(opts, {
      stage: 'pixels',
      done,
      total,
      message: `Downloaded ${done} of ${total} exposures`,
      bytes,
    });
  report();

  const worker = async () => {
    for (;;) {
      throwIfAborted(opts.signal);
      const i = next++;
      if (i >= total) return;
      const e = exposures[i];
      try {
        if (i === failIndex) {
          await wait(frameDelay(e.id), opts.signal);
          throw new SpherexError('UPSTREAM_ERROR', 'The archive could not deliver this exposure.');
        }
        const f = await loadFrame(e, grid, opts);
        results[i] = f;
        bytes += f.bytes;
        opts.onFrame?.(f);
      } catch (err) {
        if (err instanceof SpherexError && err.code === 'ABORTED') throw err;
        failed.push({
          exposure: e,
          error: err instanceof SpherexError ? err : new SpherexError('UPSTREAM_ERROR', 'Could not read this exposure.'),
        });
      }
      done++;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return { frames: results.filter((f): f is Frame => f !== null), failed };
}

export async function loadFirstLook(
  _target: Target,
  exposures: Exposure[],
  grid: Grid,
  opts: FrameOptions & { detector?: Detector } = {},
): Promise<FirstLook> {
  throwIfAborted(opts.signal);
  let detector = opts.detector;
  if (detector === undefined) {
    const s = summarize(exposures);
    if (s.find((d) => d.detector === 2)?.count) detector = 2;
    else detector = s.reduce((a, b) => (b.count > a.count ? b : a)).detector;
  }
  const pool = exposures.filter((e) => e.detector === detector).sort((a, b) => a.mjd - b.mjd);
  const firsts = new Map<number, Exposure>();
  for (const e of pool) if (!firsts.has(e.visitIndex)) firsts.set(e.visitIndex, e);
  const visits = [...firsts.values()].sort((a, b) => a.mjd - b.mjd);
  if (visits.length === 0) return { frames: [], matched: false, detector };
  const pick = visits.length === 1 ? [visits[0]] : [visits[0], visits[visits.length - 1]];
  const { frames, failed } = await loadFrames(pick, grid, { ...opts, concurrency: 2 });
  if (failed.length) throw failed[0].error;
  let matched = false;
  if (frames.length === 2) {
    const [a, b] = frames.map((f) => f.exposure);
    const wa = a.wavelengthAtTarget ?? 0;
    const wb = b.wavelengthAtTarget ?? 0;
    matched = Math.abs(wa - wb) <= Math.max(a.bandwidthAtTarget ?? bandwidthOf(detector, wa), b.bandwidthAtTarget ?? bandwidthOf(detector, wb));
  }
  return { frames, matched, detector };
}

export function saturatedSources(frame: Frame): SaturatedSource[] {
  const { w, h, flags } = frame;
  const seen = new Uint8Array(w * h);
  const out: SaturatedSource[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !(flags[start] & FLAG_BITS.SATURATED)) continue;
    const stack = [start];
    seen[start] = 1;
    let sx = 0;
    let sy = 0;
    let n = 0;
    while (stack.length) {
      const i = stack.pop() as number;
      const x = i % w;
      const y = (i - x) / w;
      sx += x;
      sy += y;
      n++;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!seen[j] && flags[j] & FLAG_BITS.SATURATED) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    out.push({ x: sx / n, y: sy / n, npix: n });
  }
  return out;
}

// ---------------------------------------------------------- movie + diff

function bandwidthOf(detector: Detector, wl: number): number {
  return wl / (detector <= 4 ? 40 : 120);
}

function stackFrames(members: Frame[]): { pixels: Float32Array; variance: Float32Array } {
  const n = members[0].w * members[0].h;
  const pixels = new Float32Array(n);
  const variance = new Float32Array(n);
  if (members.length === 1) {
    pixels.set(members[0].pixels);
    variance.set(members[0].variance);
    return { pixels, variance };
  }
  for (let i = 0; i < n; i++) {
    let num = 0;
    let den = 0;
    for (const f of members) {
      const p = f.pixels[i];
      const v = f.variance[i];
      if (Number.isFinite(p) && v > 0) {
        num += p / v;
        den += 1 / v;
      }
    }
    if (den > 0) {
      pixels[i] = num / den;
      variance[i] = 1 / den;
    } else {
      pixels[i] = NaN;
      variance[i] = NaN;
    }
  }
  return { pixels, variance };
}

function mergeSaturated(list: SaturatedSource[]): SaturatedSource[] {
  const out: { x: number; y: number; npix: number; n: number }[] = [];
  for (const s of list) {
    const hit = out.find((o) => Math.hypot(o.x - s.x, o.y - s.y) <= 2);
    if (hit) {
      hit.x = (hit.x * hit.n + s.x) / (hit.n + 1);
      hit.y = (hit.y * hit.n + s.y) / (hit.n + 1);
      hit.npix = Math.max(hit.npix, s.npix);
      hit.n++;
    } else out.push({ ...s, n: 1 });
  }
  return out.map(({ x, y, npix }) => ({ x, y, npix }));
}

export function buildMovie(frames: Frame[], mode: MovieMode, detector: Detector, target?: Target): Movie {
  const sel = frames.filter((f) => f.exposure.detector === detector).sort((a, b) => a.exposure.mjd - b.exposure.mjd);
  const groups: Frame[][] = [];
  if (mode === 'single') {
    for (const f of sel) groups.push([f]);
  } else {
    const byVisit = new Map<number, Frame[]>();
    for (const f of sel) {
      const g = byVisit.get(f.exposure.visitIndex);
      if (g) g.push(f);
      else byVisit.set(f.exposure.visitIndex, [f]);
    }
    for (const g of byVisit.values()) groups.push(g);
    groups.sort((a, b) => a[0].exposure.mjd - b[0].exposure.mjd);
  }

  const trackedD = sel[0]?.trackingDistanceAu;
  for (const f of sel) {
    if (f.trackingDistanceAu !== trackedD || f.w !== sel[0].w || f.h !== sel[0].h) {
      throw new SpherexError('BAD_INPUT', 'These frames were made with different tracking settings or sizes.');
    }
  }

  const grid: Grid = (frames[0] ?? sel[0])?.grid ?? {
    ra0: 0,
    dec0: 0,
    w: 0,
    h: 0,
    scaleArcsec: DEFAULT_SCALE,
    epochMjd: 0,
  };

  const movieFrames: MovieFrame[] = groups.map((members) => {
    const { pixels, variance } = stackFrames(members);
    const wls = members.map((m) => m.exposure.wavelengthAtTarget ?? 0);
    const mjd = members.reduce((s, m) => s + m.exposure.mjd, 0) / members.length;
    const g = members[0].grid;
    let targetXY: [number, number] | null = null;
    if (trackedD !== undefined) {
      targetXY = [(members[0].w - 1) / 2, (members[0].h - 1) / 2];
    } else if (target) {
      const p = positionAt(target, mjd);
      targetXY = worldToGrid(g, p.ra, p.dec);
    }
    return {
      grid: g,
      pixels,
      variance,
      w: members[0].w,
      h: members[0].h,
      visitIndex: members[0].exposure.visitIndex,
      detector,
      time: mjdToIso(mjd),
      mjd,
      wavelength: wls.reduce((s, v) => s + v, 0) / wls.length,
      wavelengthMin: Math.min(...wls),
      wavelengthMax: Math.max(...wls),
      nExposures: members.length,
      exposureIds: members.map((m) => m.exposure.id),
      targetXY,
      backgroundLevel: 0,
      saturated: mergeSaturated(members.flatMap((m) => saturatedSources(m))),
    };
  });

  let count = 0;
  for (const f of movieFrames) for (let i = 0; i < f.pixels.length; i++) if (Number.isFinite(f.pixels[i])) count++;
  const all = new Float32Array(count);
  let k = 0;
  for (const f of movieFrames) for (let i = 0; i < f.pixels.length; i++) if (Number.isFinite(f.pixels[i])) all[k++] = f.pixels[i];
  all.sort();
  let lo = percentile(all, 0.01);
  let hi = percentile(all, 0.997);
  if (!(hi > lo)) hi = lo + 1;

  const movie: Movie = { mode, detector, grid, frames: movieFrames, stretch: { lo, hi } };
  if (trackedD !== undefined) movie.trackingDistanceAu = trackedD;
  return movie;
}

// Robust scatter (1.4826 x MAD) of the finite difference pixels, and pixels in those units.
function scatterFields(pixels: Float32Array): { scatter: number; scatterUnits: Float32Array } {
  const vals: number[] = [];
  for (const v of pixels) if (Number.isFinite(v)) vals.push(v);
  const units = new Float32Array(pixels.length).fill(NaN);
  if (vals.length < 100) return { scatter: NaN, scatterUnits: units };
  const med = (a: number[]) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
  const m = med(vals);
  const scatter = 1.4826 * med(vals.map((v) => Math.abs(v - m)));
  if (!(scatter > 0)) return { scatter: NaN, scatterUnits: units };
  for (let i = 0; i < pixels.length; i++) units[i] = pixels[i] / scatter;
  return { scatter, scatterUnits: units };
}

export function difference(a: MovieFrame, b: MovieFrame): DifferenceImage {
  const n = a.w * a.h;
  const pixels = new Float32Array(n);
  const variance = new Float32Array(n);
  const mags: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = b.pixels[i] - a.pixels[i];
    const v = a.variance[i] + b.variance[i];
    pixels[i] = p;
    variance[i] = v;
    if (Number.isFinite(p)) mags.push(Math.abs(p));
  }
  const sorted = Float32Array.from(mags).sort();
  const m = Math.max(0.05, percentile(sorted, 0.995));
  const bw = Math.max(bandwidthOf(a.detector, a.wavelength), bandwidthOf(b.detector, b.wavelength));
  return {
    grid: a.grid,
    pixels,
    variance,
    ...scatterFields(pixels),
    w: a.w,
    h: a.h,
    wavelengthA: a.wavelength,
    wavelengthB: b.wavelength,
    wavelengthMatched: Math.abs(a.wavelength - b.wavelength) <= bw,
    method: a.nExposures === 1 && b.nExposures === 1 ? 'single' : 'naive-stack',
    stretch: { lo: -m, hi: m },
  };
}

export function spectrumAt(frames: Frame[], ra: number, dec: number, apertureArcsec = 9): (SpectrumPoint & { advisory: boolean })[] {
  const out: (SpectrumPoint & { advisory: boolean })[] = [];
  const sorted = [...frames].sort((a, b) => a.exposure.mjd - b.exposure.mjd);
  for (const f of sorted) {
    const [x0, y0] = worldToGrid(f.grid, ra, dec);
    const scale = f.grid.scaleArcsec;
    const r = apertureArcsec / scale;
    const rin = r + 1.5;
    const rout = r + 4;
    const conv = Math.pow(scale / ARCSEC, 2) * 1e9;
    let nAp = 0;
    let sumAp = 0;
    let varAp = 0;
    let flagged = false;
    const bg: number[] = [];
    let bgVar = 0;
    for (let y = Math.floor(y0 - rout); y <= Math.ceil(y0 + rout); y++) {
      for (let x = Math.floor(x0 - rout); x <= Math.ceil(x0 + rout); x++) {
        const d = Math.hypot(x - x0, y - y0);
        if (d > rout) continue;
        const inside = x >= 0 && y >= 0 && x < f.w && y < f.h;
        if (d <= r) {
          if (!inside) {
            flagged = true;
            continue;
          }
          const i = y * f.w + x;
          if (f.flags[i] !== 0 || !Number.isFinite(f.pixels[i])) flagged = true;
          if (Number.isFinite(f.pixels[i])) {
            nAp++;
            sumAp += f.pixels[i];
            varAp += f.variance[i];
          }
        } else if (d >= rin && inside) {
          const i = y * f.w + x;
          if (Number.isFinite(f.pixels[i]) && f.flags[i] === 0) {
            bg.push(f.pixels[i]);
            bgVar += f.variance[i];
          }
        }
      }
    }
    if (nAp === 0) continue;
    const bgMed = bg.length >= 5 ? median(bg) : 0;
    const bgV = bg.length ? bgVar / bg.length : 0;
    const flux = (sumAp - nAp * bgMed) * conv;
    const fluxErr = Math.sqrt(varAp + (nAp * nAp * bgV) / Math.max(bg.length, 1)) * conv;
    const wl = f.exposure.wavelengthAtTarget ?? 0;
    out.push({
      exposureId: f.exposure.id,
      wavelength: wl,
      bandwidth: f.exposure.bandwidthAtTarget ?? bandwidthOf(f.exposure.detector, wl),
      flux,
      fluxErr,
      time: f.exposure.time,
      mjd: f.exposure.mjd,
      visitIndex: f.exposure.visitIndex,
      detector: f.exposure.detector,
      flagged,
      advisory: false,
    });
  }
  return out;
}

export function pickBlinkPair(exposures: Exposure[], detector?: Detector): [Exposure, Exposure] | null {
  let det = detector;
  if (det === undefined) {
    let best = 0;
    for (const s of summarize(exposures)) {
      if (s.count > best) {
        best = s.count;
        det = s.detector;
      }
    }
  }
  const pool = exposures.filter((e) => e.detector === det && e.wavelengthAtTarget !== null);
  let pair: [Exposure, Exposure] | null = null;
  let bestDiff = Infinity;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (pool[i].visitIndex === pool[j].visitIndex) continue;
      const d = Math.abs((pool[i].wavelengthAtTarget as number) - (pool[j].wavelengthAtTarget as number));
      if (d < bestDiff) {
        bestDiff = d;
        pair = [pool[i], pool[j]];
      }
    }
  }
  if (!pair) return null;
  return pair[0].mjd <= pair[1].mjd ? pair : [pair[1], pair[0]];
}

// Systematic floor on every flux (calibration and aperture centring), as a fraction of flux.
const FLUX_FLOOR = 0.05;

interface VisitFit {
  n: number;
  lo: number;
  hi: number;
  meanWl: number;
  predict: (wl: number) => { flux: number; se: number };
}

function fitVisit(pts: SpectrumPoint[]): VisitFit {
  const n = pts.length;
  const wls = pts.map((p) => p.wavelength);
  const lo = Math.min(...wls);
  const hi = Math.max(...wls);
  const meanWl = wls.reduce((a, b) => a + b, 0) / n;
  const meanFlux = pts.reduce((a, p) => a + p.flux, 0) / n;
  const floor = FLUX_FLOOR * Math.abs(meanFlux);
  if (n >= 3) {
    let sxx = 0;
    let sxy = 0;
    for (const p of pts) {
      sxx += (p.wavelength - meanWl) ** 2;
      sxy += (p.wavelength - meanWl) * (p.flux - meanFlux);
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    let ss = 0;
    for (const p of pts) ss += (p.flux - (meanFlux + slope * (p.wavelength - meanWl))) ** 2;
    const s = Math.max(1.5 * Math.sqrt(ss / (n - 2)), floor);
    return {
      n,
      lo,
      hi,
      meanWl,
      predict: (wl) => ({
        flux: meanFlux + slope * (wl - meanWl),
        se: s * Math.sqrt(1 / n + (sxx > 0 ? (wl - meanWl) ** 2 / sxx : 0)),
      }),
    };
  }
  const errMean = Math.sqrt(pts.reduce((a, p) => a + p.fluxErr ** 2, 0)) / n;
  const se = Math.max(floor, errMean) / Math.sqrt(n);
  return { n, lo, hi, meanWl, predict: () => ({ flux: meanFlux, se }) };
}

function nearestMedian(pts: SpectrumPoint[]): SpectrumPoint {
  const med = median(pts.map((p) => p.wavelength));
  return pts.reduce((best, p) => (Math.abs(p.wavelength - med) < Math.abs(best.wavelength - med) ? p : best));
}

function pairedStack(pa: SpectrumPoint[], pb: SpectrumPoint[]): PairComparison['paired'] {
  const cands: { a: SpectrumPoint; b: SpectrumPoint; gap: number; dm: number }[] = [];
  for (const a of pa) {
    for (const b of pb) {
      const gap = Math.abs(a.wavelength - b.wavelength);
      if (gap <= 0.5 * (a.bandwidth + b.bandwidth)) cands.push({ a, b, gap, dm: Math.abs(a.mjd - b.mjd) });
    }
  }
  cands.sort((x, y) => x.gap - y.gap || x.dm - y.dm || (x.a.exposureId < y.a.exposureId ? -1 : 1));
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  let sw = 0;
  let sd = 0;
  let sf = 0;
  let n = 0;
  for (const c of cands) {
    if (usedA.has(c.a.exposureId) || usedB.has(c.b.exposureId)) continue;
    usedA.add(c.a.exposureId);
    usedB.add(c.b.exposureId);
    const v = c.a.fluxErr ** 2 + (FLUX_FLOOR * c.a.flux) ** 2 + c.b.fluxErr ** 2 + (FLUX_FLOOR * c.b.flux) ** 2;
    if (!(v > 0)) continue;
    const w = 1 / v;
    sw += w;
    sd += w * (c.b.flux - c.a.flux);
    sf += w * 0.5 * (c.a.flux + c.b.flux);
    n++;
  }
  if (n === 0) return { deltaMjy: 0, percent: 0, sigma: 0, z: 0, nPairs: 0 };
  const delta = sd / sw;
  const sigma = Math.sqrt(1 / sw);
  const fbar = sf / sw;
  return { deltaMjy: delta, percent: fbar !== 0 ? (100 * delta) / fbar : 0, sigma, z: delta / sigma, nPairs: n };
}

export function compareVisits(frames: Frame[], ra: number, dec: number): PairComparison[] {
  const satExposures = new Set<string>();
  for (const f of frames) {
    const [x, y] = worldToGrid(f.grid, ra, dec);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const xi = Math.round(x) + dx;
        const yi = Math.round(y) + dy;
        if (xi >= 0 && yi >= 0 && xi < f.w && yi < f.h && f.flags[yi * f.w + xi] & FLAG_BITS.SATURATED) {
          satExposures.add(f.exposure.id);
        }
      }
    }
  }
  // exposures with a masked pixel in the aperture are dropped, as in the real readout;
  // saturated ones stay so the pair can carry the saturated flag
  const points = spectrumAt(frames, ra, dec).filter((p) => !p.flagged || satExposures.has(p.exposureId));
  const byVisit = new Map<number, SpectrumPoint[]>();
  for (const p of points) {
    const g = byVisit.get(p.visitIndex);
    if (g) g.push(p);
    else byVisit.set(p.visitIndex, [p]);
  }
  const saturatedVisits = new Set<number>();
  for (const f of frames) {
    const [x, y] = worldToGrid(f.grid, ra, dec);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xi = Math.round(x) + dx;
        const yi = Math.round(y) + dy;
        if (xi < 0 || yi < 0 || xi >= f.w || yi >= f.h) continue;
        const i = yi * f.w + xi;
        if (f.flags[i] & FLAG_BITS.SATURATED && Math.hypot(xi - x, yi - y) <= 1.5) saturatedVisits.add(f.exposure.visitIndex);
      }
    }
  }
  const visits = [...byVisit.keys()].sort((a, b) => a - b);
  const out: PairComparison[] = [];
  for (let i = 0; i < visits.length; i++) {
    for (let j = i + 1; j < visits.length; j++) {
      const pa = byVisit.get(visits[i]) as SpectrumPoint[];
      const pb = byVisit.get(visits[j]) as SpectrumPoint[];
      const a = nearestMedian(pa);
      const b = nearestMedian(pb);
      const pd = b.flux - a.flux;
      const ps = Math.sqrt(a.fluxErr ** 2 + b.fluxErr ** 2);
      const flags: PairComparison['flags'] = [];
      const fa = fitVisit(pa);
      const fb = fitVisit(pb);
      let wc: number;
      const olo = Math.max(fa.lo, fb.lo);
      const ohi = Math.min(fa.hi, fb.hi);
      if (olo <= ohi) wc = (olo + ohi) / 2;
      else {
        wc = (fa.meanWl + fb.meanWl) / 2;
        flags.push('no_bracket');
      }
      if (fa.n < 3 || fb.n < 3) flags.push('too_few_samples');
      if (fa.n < 8 || fb.n < 8) flags.push('partial_visit');
      if (saturatedVisits.has(visits[i]) || saturatedVisits.has(visits[j])) flags.push('saturated');
      const qa = fa.predict(wc);
      const qb = fb.predict(wc);
      const md = qb.flux - qa.flux;
      const ms = Math.sqrt(qa.se ** 2 + qb.se ** 2);
      out.push({
        visitA: visits[i],
        visitB: visits[j],
        plain: {
          deltaMjy: pd,
          percent: a.flux !== 0 ? (100 * pd) / a.flux : 0,
          sigma: ps,
          z: ps > 0 ? pd / ps : 0,
          wavelengthA: a.wavelength,
          wavelengthB: b.wavelength,
          gapChannels: Math.round((Math.abs(a.wavelength - b.wavelength) / (a.wavelength / 40)) * 10) / 10,
        },
        paired: pairedStack(pa, pb),
        matched: {
          deltaMjy: md,
          percent: qa.flux !== 0 ? (100 * md) / qa.flux : 0,
          sigma: ms,
          z: ms > 0 ? md / ms : 0,
          commonWavelength: wc,
          pointsA: fa.n,
          pointsB: fb.n,
        },
        flags,
      });
    }
  }
  return out;
}

export function summarize(exposures: Exposure[]): { detector: Detector; visits: number[]; count: number; outOfStack: number }[] {
  return DETECTORS.map((detector) => {
    const mine = exposures.filter((e) => e.detector === detector);
    const visits = [...new Set(mine.map((e) => e.visitIndex))].sort((a, b) => a - b);
    return { detector, visits, count: mine.length, outOfStack: 0 };
  });
}

// ------------------------------------------------------------- catalogs

const cachedTargets = new Map<CachedSlug, CachedTarget>();

export async function loadCached(slug: CachedSlug, opts: CallOptions = {}): Promise<CachedTarget> {
  throwIfAborted(opts.signal);
  const def = DEFS.find((d) => d.slug === slug);
  if (!def) throw new SpherexError('NOT_FOUND', 'That challenge target is not available.');
  await wait(150, opts.signal);
  const hit = cachedTargets.get(slug);
  if (hit) return hit;
  const b = base(slug);
  const frames = b.scene.exposures.map((e) => {
    const r = registry.get(e.id) as RegEntry;
    return renderFrame(b.scene, e, r.wl, r.bw, b.grid, 'zodi');
  });
  const result: CachedTarget = {
    slug,
    target: b.scene.target,
    grid: b.grid,
    exposures: b.scene.exposures,
    frames,
    gaia: coneGaia(b.scene, b.scene.ref.ra, b.scene.ref.dec, 280),
    wise: coneWise(b.scene, b.scene.ref.ra, b.scene.ref.dec, 280),
    builtAt: '2026-11-14T00:00:00Z',
  };
  cachedTargets.set(slug, result);
  return result;
}

export function listCached(): { slug: CachedSlug; name: string; blurb: string }[] {
  return DEFS.map((d) => ({ slug: d.slug, name: d.name, blurb: d.blurb }));
}

export async function gaiaCone(
  ra: number,
  dec: number,
  radiusArcsec: number,
  opts: CallOptions = {},
): Promise<GaiaStar[]> {
  throwIfAborted(opts.signal);
  await wait(300, opts.signal);
  return coneGaia(sceneForPosition(ra, dec), ra, dec, radiusArcsec);
}

export async function wiseCone(
  ra: number,
  dec: number,
  radiusArcsec: number,
  opts: CallOptions = {},
): Promise<WiseSource[]> {
  throwIfAborted(opts.signal);
  await wait(300, opts.signal);
  return coneWise(sceneForPosition(ra, dec), ra, dec, radiusArcsec);
}

// Sky position of a star placed 80 arcsec east and 80 arcsec north of the
// Barnard's Star grid centre. It must land in the upper-left of the image.
export const ORIENTATION_TEST_STAR: { ra: number; dec: number } = (() => {
  const ref = base('barnards-star').scene.ref;
  return tanInverse(ref.ra, ref.dec, 80, 80);
})();

export async function loadBestPair(
  target: Target,
  exposures: Exposure[],
  grid: Grid,
  opts: FrameOptions & { detector?: Detector; maxWavelengthGapUm?: number } = {},
): Promise<FirstLook> {
  const { detector: wanted, maxWavelengthGapUm: _gap, ...frameOpts } = opts;
  const counts = summarize(exposures).sort((a, b) => b.count - a.count);
  const detector = wanted ?? (counts.find((c) => c.detector === 2 && c.count > 0) ? 2 : counts[0].detector);
  const onDet = exposures.filter((e) => e.detector === detector);
  const annotated = await annotateWavelengths(onDet, target.ra, target.dec, frameOpts);
  const pair = pickBlinkPair(annotated, detector);
  if (!pair) return loadFirstLook(target, exposures, grid, { ...frameOpts, detector });
  const res = await loadFrames(pair, grid, frameOpts);
  if (res.failed.length > 0) throw res.failed[0].error;
  return { frames: res.frames, matched: true, detector };
}

// --------------------------------------------- paired differences and preview

export function asSingle(d: DifferenceImage): DifferenceImageM {
  return { ...d, method: 'single' };
}

export function asNaiveStack(d: DifferenceImage): DifferenceImageM {
  return { ...d, method: 'naive-stack' };
}

function frameMedian(f: Frame): number {
  const v: number[] = [];
  for (let i = 0; i < f.pixels.length; i++) if (Number.isFinite(f.pixels[i])) v.push(f.pixels[i]);
  return median(v);
}

export function pairedDifference(
  framesA: Frame[],
  framesB: Frame[],
  opts: { toleranceChannels?: number; errorFloor?: number; background?: 'median' | 'none' } = {},
): PairedDifference {
  if (!framesA.length || !framesB.length) {
    throw new SpherexError('BAD_INPUT', 'Both visits need at least one exposure.');
  }
  const { w, h } = framesA[0];
  for (const f of [...framesA, ...framesB]) {
    if (f.w !== w || f.h !== h) throw new SpherexError('BAD_INPUT', 'These frames are not on the same grid.');
  }
  const tol = opts.toleranceChannels ?? 1;
  const floor = opts.errorFloor ?? 0;
  const useBg = (opts.background ?? 'median') === 'median';
  const wlOf = (f: Frame) => f.exposure.wavelengthAtTarget ?? 0;
  const bwOf = (f: Frame) => f.exposure.bandwidthAtTarget ?? bandwidthOf(f.exposure.detector, wlOf(f));

  const cands: { a: Frame; b: Frame; gap: number; dm: number; chan: number }[] = [];
  for (const a of framesA) {
    for (const b of framesB) {
      const gap = Math.abs(wlOf(a) - wlOf(b));
      const chan = 0.5 * (bwOf(a) + bwOf(b));
      if (gap <= tol * chan) cands.push({ a, b, gap, dm: Math.abs(a.exposure.mjd - b.exposure.mjd), chan });
    }
  }
  cands.sort(
    (x, y) =>
      x.gap - y.gap ||
      x.dm - y.dm ||
      (x.a.exposure.obsId < y.a.exposure.obsId ? -1 : x.a.exposure.obsId > y.a.exposure.obsId ? 1 : 0),
  );
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  const accepted: typeof cands = [];
  for (const c of cands) {
    if (usedA.has(c.a.exposure.id) || usedB.has(c.b.exposure.id)) continue;
    usedA.add(c.a.exposure.id);
    usedB.add(c.b.exposure.id);
    accepted.push(c);
  }

  const n = w * h;
  const pixels = new Float32Array(n);
  const variance = new Float32Array(n);
  const num = new Float64Array(n);
  const den = new Float64Array(n);
  for (const c of accepted) {
    const ba = useBg ? frameMedian(c.a) : 0;
    const bb = useBg ? frameMedian(c.b) : 0;
    for (let i = 0; i < n; i++) {
      const d = c.b.pixels[i] - bb - (c.a.pixels[i] - ba);
      const v = c.a.variance[i] + c.b.variance[i] + floor * floor;
      if (Number.isFinite(d) && v > 0) {
        num[i] += d / v;
        den[i] += 1 / v;
      }
    }
  }
  const mags: number[] = [];
  for (let i = 0; i < n; i++) {
    if (den[i] > 0) {
      pixels[i] = num[i] / den[i];
      variance[i] = 1 / den[i];
      mags.push(Math.abs(pixels[i]));
    } else {
      pixels[i] = NaN;
      variance[i] = NaN;
    }
  }
  const m = Math.max(0.05, percentile(Float32Array.from(mags).sort(), 0.995));
  const mean = (fs: Frame[]) => fs.reduce((s, f) => s + wlOf(f), 0) / fs.length;
  const usedFramesA = accepted.length ? accepted.map((c) => c.a) : framesA;
  const usedFramesB = accepted.length ? accepted.map((c) => c.b) : framesB;
  return {
    grid: framesA[0].grid,
    pixels,
    variance,
    ...scatterFields(pixels),
    w,
    h,
    wavelengthA: mean(usedFramesA),
    wavelengthB: mean(usedFramesB),
    wavelengthMatched: accepted.length > 0,
    stretch: { lo: -m, hi: m },
    method: 'paired-stack',
    nPairs: accepted.length,
    nUnpairedA: framesA.length - accepted.length,
    nUnpairedB: framesB.length - accepted.length,
    pairs: accepted.map((c) => ({
      a: c.a.exposure.id,
      b: c.b.exposure.id,
      wavelengthGapUm: c.gap,
      gapChannels: c.chan > 0 ? c.gap / c.chan : 0,
    })),
  };
}

export function visitDifference(
  frames: Frame[],
  detector: Detector,
  visitA: number,
  visitB: number,
  opts: { toleranceChannels?: number; errorFloor?: number; background?: 'median' | 'none' } = {},
): PairedDifference {
  const pick = (v: number) => frames.filter((f) => f.exposure.detector === detector && f.exposure.visitIndex === v);
  return pairedDifference(pick(visitA), pick(visitB), opts);
}

const PREVIEW_BYTES = 250_000;
const DETECTOR_BYTES = 850_000;
const GAP_YEAR: [number, number] = [330, 400];
const GAP_HALF_YEAR: [number, number] = [150, 215];

function pickByGap(exposures: Exposure[], detector: Detector, range: [number, number]): [Exposure, Exposure] | null {
  const c = exposures.filter((e) => e.detector === detector && e.wavelengthAtTarget !== null);
  let best: [Exposure, Exposure] | null = null;
  let bestGap = Infinity;
  let bestDays = -1;
  for (let i = 0; i < c.length; i++) {
    for (let j = i + 1; j < c.length; j++) {
      if (c[i].visitIndex === c[j].visitIndex) continue;
      const days = Math.abs(c[i].mjd - c[j].mjd);
      if (days < range[0] || days > range[1]) continue;
      const g = Math.abs((c[i].wavelengthAtTarget as number) - (c[j].wavelengthAtTarget as number));
      if (g < bestGap - 1e-9 || (Math.abs(g - bestGap) <= 1e-9 && days > bestDays)) {
        best = c[i].mjd <= c[j].mjd ? [c[i], c[j]] : [c[j], c[i]];
        bestGap = g;
        bestDays = days;
      }
    }
  }
  return best;
}

const previews = new WeakMap<CachedTarget, CachedPreview>();

export function buildPreview(c: CachedTarget): CachedPreview {
  const hit = previews.get(c);
  if (hit) return hit;
  const sum = summarize(c.exposures);
  const withData = sum.filter((d) => d.count > 0);
  const preferred: Detector = c.slug === 'wise-0855' ? 6 : 2;
  const defaultDetector: Detector = sum.find((d) => d.detector === preferred)?.count
    ? preferred
    : (withData.sort((a, b) => b.count - a.count)[0]?.detector ?? preferred);
  const detFrames = c.frames.filter((f) => f.exposure.detector === defaultDetector);
  const movie = buildMovie(detFrames, 'visit-stack', defaultDetector, c.target);
  const byId = new Map(detFrames.map((f) => [f.exposure.id, f]));

  const pairPick = (range: [number, number]): PairPick | null => {
    const pair = pickByGap(c.exposures, defaultDetector, range);
    if (!pair) return null;
    const fa = byId.get(pair[0].id);
    const fb = byId.get(pair[1].id);
    if (!fa || !fb) return null;
    const wa = pair[0].wavelengthAtTarget as number;
    const wb = pair[1].wavelengthAtTarget as number;
    const bw = Math.max(
      pair[0].bandwidthAtTarget ?? bandwidthOf(defaultDetector, wa),
      pair[1].bandwidthAtTarget ?? bandwidthOf(defaultDetector, wb),
    );
    return { frames: [fa, fb], matched: Math.abs(wa - wb) <= bw, gapDays: Math.abs(pair[1].mjd - pair[0].mjd) };
  };

  const vs = movie.frames;
  const cand: { a: number; b: number; score: number }[] = [];
  for (let i = 0; i < vs.length; i++) {
    for (let j = i + 1; j < vs.length; j++) {
      const days = vs[j].mjd - vs[i].mjd;
      if (days < 90) continue;
      cand.push({ a: vs[i].visitIndex, b: vs[j].visitIndex, score: Math.min(Math.abs(days - 365), Math.abs(days - 182)) });
    }
  }
  cand.sort((x, y) => x.score - y.score);
  const differences = cand
    .slice(0, 6)
    .sort((x, y) => x.a - y.a || x.b - y.b)
    .map((p) => ({ visitA: p.a, visitB: p.b, image: visitDifference(detFrames, defaultDetector, p.a, p.b) as DifferenceImageM }));

  const preview: CachedPreview = {
    target: c.target,
    grid: c.grid,
    defaultDetector,
    movie,
    pairs: { year: pairPick(GAP_YEAR), halfYear: pairPick(GAP_HALF_YEAR) },
    differences,
    visits: vs.map((f) => ({ visitIndex: f.visitIndex, mjd: f.mjd, time: f.time, nExposures: f.nExposures })),
    gaia: c.gaia,
    wise: c.wise,
    detectors: sum.map((d) => ({ ...d, bytes: d.count > 0 ? DETECTOR_BYTES : 0 })),
    totalBytes: sum.reduce((s, d) => s + (d.count > 0 ? DETECTOR_BYTES : 0), 0),
  };
  previews.set(c, preview);
  return preview;
}

async function simulateBytes(opts: CallOptions, bytes: number, ms: number, message: string): Promise<void> {
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    throwIfAborted(opts.signal);
    emit(opts, { stage: 'pixels', done: i, total: steps, message, bytes: Math.round((bytes * i) / steps) });
    if (i < steps) await wait(ms / steps, opts.signal);
  }
}

/** Preview from an already loaded prepared set (real or mock), with simulated transfer progress. */
export async function previewFromCached(c: CachedTarget, opts: CallOptions = {}): Promise<CachedPreview> {
  throwIfAborted(opts.signal);
  await simulateBytes(opts, PREVIEW_BYTES, 300, 'Loading the first look');
  return buildPreview(c);
}

/** One detector's exposures and frames from an already loaded prepared set, with simulated progress. */
export async function detectorFromCached(
  c: CachedTarget,
  detector: Detector,
  opts: CallOptions = {},
): Promise<CachedDetectorData> {
  throwIfAborted(opts.signal);
  await simulateBytes(opts, DETECTOR_BYTES, 400, 'Loading this detector');
  return {
    exposures: c.exposures.filter((e) => e.detector === detector),
    frames: c.frames.filter((f) => f.exposure.detector === detector),
  };
}

export async function loadCachedPreview(slug: CachedSlug, opts: CallOptions = {}): Promise<CachedPreview> {
  return previewFromCached(await loadCached(slug, opts), opts);
}

export async function loadCachedDetector(
  slug: CachedSlug,
  detector: Detector,
  opts: CallOptions = {},
): Promise<CachedDetectorData> {
  return detectorFromCached(await loadCached(slug, opts), detector, opts);
}

export { parallaxOffset, positionAtDistance, gridAt, trackingTolerance, motionFromPair } from '../../lib/spherex/parallax';
export { listPairs } from '../../lib/spherex/movie';
