// Adapter for the per-star "Has it changed between visits?" readout.
// Two sources feed one shape (ChangeStar): prepared results of the cached targets, and a live
// check of a clicked star that reads native pixels and runs the matched comparison.
import {
  compareVisits,
  isBlended,
  measureStamp,
  nativeStampsFor,
  starPosition,
  MIN_VISIT_EXPOSURES,
  SpherexError,
  loadCachedReadouts,
  readoutReliability,
  gaiaCone,
} from '../../lib/spherex';
import type { CachedSlug, Exposure, GaiaStar, MatchedResult, Target } from '../../lib/spherex';

// ------------------------------------------------------------------ contract types --

export type ReadoutFlag = 'saturated' | 'partial_visit' | 'blended' | 'too_few_samples' | 'no_bracket';
export type ReadoutVerdict = 'changed' | 'no significant change' | 'no result';

export interface ChangeStat {
  D: number | null;
  sigma: number | null;
  z: number | null;
  frac: number | null;
}

export interface ChangePair {
  /** Visit mid times, MJD (A earlier). */
  tA: number;
  tB: number;
  /** Accepted exposures per visit. */
  nA: number;
  nB: number;
  /** [w0 um, D, sigma, z] per shared wavelength used. */
  w: [number, number, number, number][];
  nSkipped: number;
  /** Combined colour-matched result. */
  matched: ChangeStat;
  /** Best single pair; null when none. */
  plain: ChangeStat | null;
  /** Paired stack ("Paired average"); n = exposure pairs. */
  ps: ChangeStat & { n: number };
  flags: ReadoutFlag[];
  verdict: ReadoutVerdict;
  /** Visit indices (prepared results only). */
  a?: number;
  b?: number;
  /** From the data seat when the readouts file carries them (feature-detected). */
  reliable?: boolean;
  unreliableReasons?: string[];
  fieldReliable?: boolean;
  fieldChangedFraction?: number;
  /** Field stars of this visit pair with |matched z| >= 3, of those with a matched z. */
  field?: { differ: number; measured: number };
  /** Largest plain-pair wavelength gap in channels (live results only). */
  plainGapBw?: number;
}

export interface ChangeStar {
  id: string;
  gmag: number | null;
  isTarget: boolean;
  pairs: ChangePair[];
  source: 'prepared' | 'live';
  /** A catalogue fact about the star when the dataset supplies one (or the slug constant below). */
  catalogueNote?: string;
  /** Gaia DR3 phot_variable_flag: true when catalogued as variable; null or absent when unknown. */
  variable?: boolean | null;
  /** From the data seat: a star with G < 9 lies within 3 arcmin. */
  brightNeighbour?: boolean;
}

/** Catalogue facts by prepared slug, applied to that slug's target star only. Science signed this text. */
export const CATALOGUE_NOTES: Readonly<Record<string, string>> = {
  'v391-oph': 'Catalogued as an eclipsing binary (Gaia DR3; SIMBAD).',
};

/** A steady comparison star per prepared slug (Gaia DR3 id), until the data supplies one. */
export const COMPARISON_STARS: Readonly<Record<string, string>> = {
  // G 12.91 against the target's 12.66, 179 arcsec away, reliable and consistent in every detector-2 pair
  'v391-oph': '4472831551114789632',
};

/** Science's calibration holds only for stars with no star brighter than this within BRIGHT_RADIUS_ARCSEC. */
export const BRIGHT_G = 9;
export const BRIGHT_RADIUS_ARCSEC = 180;

/** True when any listed star (other than the star itself, beyond 1.5 arcsec) with G < 9 lies within 180 arcsec. */
export function hasBrightNeighbour(ra: number, dec: number, stars: ReadonlyArray<{ ra: number; dec: number; gmag: number | null }>): boolean {
  for (const g of stars) {
    if (g.gmag === null || !(g.gmag < BRIGHT_G)) continue;
    const d = sepArcsec(ra, dec, g.ra, g.dec);
    if (d > 1.5 && d <= BRIGHT_RADIUS_ARCSEC) return true;
  }
  return false;
}

export interface PreparedReadouts {
  slug: string;
  /** Detector the readouts were measured on. */
  detector: number;
  stars: { id: string; ra: number; dec: number; gmag: number | null; isTarget: boolean; star: ChangeStar }[];
}

export interface LiveInput {
  ra: number;
  dec: number;
  pmra?: number | null;
  pmdec?: number | null;
  epoch?: number;
  gmag?: number | null;
  /** Gaia DR3 id of the measured star, when it is a catalogued star. */
  sourceId?: string;
  exposures: Exposure[];
  gaia: GaiaStar[];
}

// ------------------------------------------------------------------ cached readouts (local type copy) --
// Shapes copied from the library's readouts module, which index.ts does not export yet.

interface CombinedLike {
  D: number | null;
  sigma: number | null;
  z: number | null;
  frac: number | null;
}

interface PairReadoutLike {
  a: number;
  b: number;
  tA: number;
  tB: number;
  nA: number;
  nB: number;
  w: [number, number | null, number | null, number | null][];
  nSkipped: number;
  D: number | null;
  sigma: number | null;
  z: number | null;
  frac: number | null;
  plain: CombinedLike | null;
  ps: CombinedLike & { n: number };
  flags: ReadoutFlag[];
  verdict: ReadoutVerdict;
  reliable?: boolean;
  unreliableReasons?: string[];
}

interface FieldPairLike {
  a: number;
  b: number;
  fieldChangedFraction: number;
  fieldReliable: boolean;
}

interface StarReadoutLike {
  id: string;
  ra: number;
  dec: number;
  gmag: number | null;
  isTarget: boolean;
  pairs: PairReadoutLike[];
  catalogueNote?: string;
  variable?: boolean | null;
  brightNeighbour?: boolean;
}

interface CachedReadoutsLike {
  slug: string;
  detector: number;
  stars: StarReadoutLike[];
  fieldPairs?: FieldPairLike[];
}

const loadCachedReadoutsImpl:
  | ((slug: string, opts?: { signal?: AbortSignal; detector?: number }) => Promise<CachedReadoutsLike>)
  | null = (slug, opts) =>
  loadCachedReadouts(slug as CachedSlug, opts as Parameters<typeof loadCachedReadouts>[1]) as unknown as Promise<CachedReadoutsLike>;

export const preparedAvailable: boolean = loadCachedReadoutsImpl !== null;

const fin = (x: number | null | undefined): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? x : null;

function statOf(c: CombinedLike): ChangeStat {
  return { D: fin(c.D), sigma: fin(c.sigma), z: fin(c.z), frac: fin(c.frac) };
}

/** Cached PairReadout to ChangePair. Non-finite numbers become null. */
export function pairFromCached(p: PairReadoutLike): ChangePair {
  return {
    tA: p.tA,
    tB: p.tB,
    nA: p.nA,
    nB: p.nB,
    w: p.w.map((r) => [r[0], r[1], r[2], r[3]] as unknown as [number, number, number, number]),
    nSkipped: p.nSkipped,
    matched: statOf({ D: p.D, sigma: p.sigma, z: p.z, frac: p.frac }),
    plain: p.plain ? statOf(p.plain) : null,
    ps: { ...statOf(p.ps), n: p.ps.n },
    flags: [...p.flags],
    verdict: p.verdict,
    a: p.a,
    b: p.b,
    ...(typeof p.reliable === 'boolean' ? { reliable: p.reliable, unreliableReasons: [...(p.unreliableReasons ?? [])] } : {}),
  };
}

function starFromCached(s: StarReadoutLike): ChangeStar {
  return {
    id: s.id, gmag: s.gmag, isTarget: s.isTarget, pairs: s.pairs.map(pairFromCached), source: 'prepared',
    ...(s.catalogueNote ? { catalogueNote: s.catalogueNote } : {}),
    ...(s.variable !== undefined ? { variable: s.variable } : {}),
    ...(typeof s.brightNeighbour === 'boolean' ? { brightNeighbour: s.brightNeighbour } : {}),
  };
}

/** Per visit pair (a:b), the field stars (not the target) with a matched z, and how many have |z| >= 3. */
function fieldCounts(stars: StarReadoutLike[]): Map<string, { differ: number; measured: number }> {
  const out = new Map<string, { differ: number; measured: number }>();
  for (const s of stars) {
    if (s.isTarget) continue;
    for (const p of s.pairs) {
      const z = fin(p.z);
      if (z === null) continue;
      const k = `${p.a}:${p.b}`;
      const c = out.get(k) ?? { differ: 0, measured: 0 };
      c.measured++;
      if (Math.abs(z) >= 3) c.differ++;
      out.set(k, c);
    }
  }
  return out;
}

/** Prepared stars with at least one pair the data seat marks reliable (empty when the field is absent). */
export function measurableStars(r: PreparedReadouts): PreparedReadouts['stars'] {
  return r.stars.filter((s) => s.star.pairs.some((p) => p.reliable === true));
}

/** The steady comparison star of a prepared field, when one is named. */
export function comparisonFor(r: PreparedReadouts): PreparedReadouts['stars'][number] | null {
  const id = COMPARISON_STARS[r.slug];
  return id ? (r.stars.find((s) => s.id === id) ?? null) : null;
}

/** Field context of a visit pair, matched by visit mid times within 10 days. */
export function fieldFor(r: PreparedReadouts, tA: number, tB: number): { differ: number; measured: number } | null {
  for (const s of r.stars) {
    for (const p of s.star.pairs) {
      if (p.field && Math.abs(p.tA - tA) <= 10 && Math.abs(p.tB - tB) <= 10) return p.field;
    }
  }
  return null;
}

const preparedCache = new Map<string, Promise<PreparedReadouts | null>>();

/** Prepared readouts of a cached target. Null when unavailable or the target has none. Cached per slug. */
export function loadPreparedReadouts(slug: string, opts: { signal?: AbortSignal; detector?: number } = {}): Promise<PreparedReadouts | null> {
  const key = `${slug}:${opts.detector ?? ''}`;
  const impl = loadCachedReadoutsImpl;
  if (!impl) return Promise.resolve(null);
  const hit = preparedCache.get(key);
  if (hit) return hit;
  const p = impl(slug, opts).then(
    (r): PreparedReadouts => {
      const counts = fieldCounts(r.stars);
      const fp = new Map<string, FieldPairLike>((r.fieldPairs ?? []).map((f) => [`${f.a}:${f.b}`, f]));
      const note = CATALOGUE_NOTES[slug];
      return {
        slug,
        detector: r.detector,
        stars: r.stars.map((s) => {
          const star = starFromCached(s);
          if (s.isTarget && note && !star.catalogueNote) star.catalogueNote = note;
          for (const p of star.pairs) {
            const k = `${p.a}:${p.b}`;
            const c = counts.get(k);
            if (c) p.field = c;
            const f = fp.get(k);
            if (f) {
              p.fieldReliable = f.fieldReliable;
              p.fieldChangedFraction = f.fieldChangedFraction;
            }
          }
          return { id: s.id, ra: s.ra, dec: s.dec, gmag: s.gmag, isTarget: s.isTarget, star };
        }),
      };
    },
    (e: unknown) => {
      preparedCache.delete(key);
      const code = (e as { code?: string } | null)?.code;
      if (code === 'NOT_FOUND') return null;
      throw e;
    },
  );
  preparedCache.set(key, p);
  return p;
}

function sepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d2r = Math.PI / 180;
  const p1 = dec1 * d2r, p2 = dec2 * d2r;
  const dl = (ra2 - ra1) * d2r;
  const s1 = Math.sin((p2 - p1) / 2), s2 = Math.sin(dl / 2);
  const h = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h))) * 3600) / d2r;
}

/** Nearest prepared star within the tolerance. The target entry uses `target` when given. */
export function matchPreparedStar(
  r: PreparedReadouts,
  ra: number,
  dec: number,
  toleranceArcsec: number,
  target?: { ra: number; dec: number },
): ChangeStar | null {
  let best: ChangeStar | null = null;
  let bestSep = Infinity;
  for (const s of r.stars) {
    const pos = s.isTarget && target ? target : s;
    const d = sepArcsec(ra, dec, pos.ra, pos.dec);
    if (d <= toleranceArcsec && d < bestSep) {
      best = s.star;
      bestSep = d;
    }
  }
  return best;
}

// ------------------------------------------------------------------ live check --

const BYTES_PER_STAMP = 0.572e6;
const SECONDS_PER_STAMP = 0.31;
const STAMP_HALF = 8;
const GAIA_EPOCH = 2016;

/** True when the app runs against the real library (not ?mock=1). */
export const liveAvailable: boolean =
  typeof location === 'undefined' ? true : new URLSearchParams(location.search).get('mock') !== '1';

/** In-stack exposures of visits that have enough of them. */
function usableExposures(exposures: Exposure[]): Exposure[] {
  const byVisit = new Map<number, Exposure[]>();
  for (const e of exposures) {
    if (e.inStack === false) continue;
    const g = byVisit.get(e.visitIndex);
    if (g) g.push(e);
    else byVisit.set(e.visitIndex, [e]);
  }
  const out: Exposure[] = [];
  for (const g of byVisit.values()) if (g.length >= MIN_VISIT_EXPOSURES) out.push(...g);
  return out;
}

export function liveEstimate(exposures: Exposure[]): { bytes: number; seconds: number; nExposures: number; nVisits: number } {
  const use = usableExposures(exposures);
  const nVisits = new Set(use.map((e) => e.visitIndex)).size;
  return { bytes: use.length * BYTES_PER_STAMP, seconds: use.length * SECONDS_PER_STAMP, nExposures: use.length, nVisits };
}

/** e.g. "about 21 MB, about 11 seconds". */
export function estimateText(e: { bytes: number; seconds: number }): string {
  const mb = Math.max(1, Math.round(e.bytes / 1e6));
  const s = Math.max(1, Math.round(e.seconds));
  return `about ${mb} MB, about ${s} ${s === 1 ? 'second' : 'seconds'}`;
}

function pairFromMatched(r: MatchedResult, tA: number, tB: number): ChangePair {
  const sd = (v: number): number | null => (Number.isFinite(v) && v >= 0 ? fin(Math.sqrt(v)) : null);
  const plain = r.plain
    ? { D: fin(r.plain.D), sigma: sd(r.plain.var), z: fin(r.plain.z), frac: fin(r.plain.fractionalChange) }
    : null;
  return {
    tA,
    tB,
    nA: r.nExposuresA,
    nB: r.nExposuresB,
    w: r.perWavelength.map((c) => [c.w0, c.D, Math.sqrt(c.var), c.z] as [number, number, number, number]),
    nSkipped: r.nSkipped,
    matched: { D: fin(r.D), sigma: sd(r.var), z: fin(r.z), frac: fin(r.fractionalChange) },
    plain,
    ps: { D: fin(r.ps.D), sigma: sd(r.ps.var), z: fin(r.ps.z), frac: fin(r.ps.fractionalChange), n: r.ps.nPairs },
    flags: [...r.flags],
    verdict: r.verdict,
    ...(r.perWavelength.length > 0 ? { plainGapBw: Math.max(...r.perWavelength.map((c) => Math.abs(c.plainDlamBw))) } : {}),
  };
}

export async function checkStarLive(
  input: LiveInput,
  opts: { signal?: AbortSignal; onProgress?: (p: { bytes: number; done: number; total: number }) => void } = {},
): Promise<ChangeStar> {
  const exps = usableExposures(input.exposures);
  const visits = [...new Set(exps.map((e) => e.visitIndex))];
  if (visits.length < 2) {
    throw new SpherexError('NO_COVERAGE', 'This star needs at least two visits with enough exposures to compare.');
  }
  const target: Target = {
    ra: input.ra,
    dec: input.dec,
    pmra: input.pmra ?? 0,
    pmdec: input.pmdec ?? 0,
    epoch: input.epoch ?? GAIA_EPOCH,
  };
  const { stamps } = await nativeStampsFor(exps, starPosition(target), STAMP_HALF, {
    signal: opts.signal,
    concurrency: 6,
    onProgress: opts.onProgress
      ? (p) => opts.onProgress?.({ bytes: p.bytes ?? 0, done: p.done, total: p.total })
      : undefined,
  });
  if (opts.signal?.aborted) throw new SpherexError('ABORTED', 'Aborted');
  if (stamps.length === 0) {
    throw new SpherexError('UPSTREAM_ERROR', 'None of the exposures could be read for this star. Try again in a moment.');
  }

  const records = stamps.map((s) => ({
    id: s.exposureId,
    visit: s.visitIndex,
    mjd: s.mjd,
    wavelength: s.wavelength,
    bandwidth: s.bandwidth,
    measurement: measureStamp(s),
  }));

  // The star itself may be in the Gaia list; it is not its own neighbour.
  const g = fin(input.gmag);
  const blended =
    g === null
      ? false
      : isBlended(
          { ra: input.ra, dec: input.dec, g },
          input.gaia
            .filter((s) => sepArcsec(input.ra, input.dec, s.ra, s.dec) > 1.5)
            .map((s) => ({ ra: s.ra, dec: s.dec, g: s.gmag })),
        );

  const meanMjd = new Map<number, number>();
  for (const v of visits) {
    const m = records.filter((r) => r.visit === v).map((r) => r.mjd);
    if (m.length) meanMjd.set(v, m.reduce((a, b) => a + b, 0) / m.length);
  }
  const ordered = [...meanMjd.keys()].sort((a, b) => (meanMjd.get(a) as number) - (meanMjd.get(b) as number));
  const pairs: ChangePair[] = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i] as number, b = ordered[j] as number;
      const res = compareVisits(records, a, b, { blended });
      const pair = pairFromMatched(res, meanMjd.get(a) as number, meanMjd.get(b) as number);
      // the library's reliability rule, the same one the prepared files carry
      Object.assign(pair, readoutReliability(res.flags, res.perWavelength.length, {
        star: { ra: input.ra, dec: input.dec, ...(input.sourceId ? { sourceId: input.sourceId } : {}) },
        gaia: input.gaia.map((s) => ({ sourceId: s.sourceId, ra: s.ra, dec: s.dec, gmag: s.gmag })),
      }));
      pairs.push(pair);
    }
  }
  return { id: 'live', gmag: g, isTarget: false, pairs, source: 'live' };
}

const gaiaCache = new Map<string, Promise<GaiaStar[]>>();

/** Gaia stars within 4 arcmin of a live position (for snapping, blends and the bright-star rule). Cached per position. */
export function liveGaia(ra: number, dec: number, opts: { signal?: AbortSignal } = {}): Promise<GaiaStar[]> {
  const key = `${ra.toFixed(3)}:${dec.toFixed(3)}`;
  const hit = gaiaCache.get(key);
  if (hit) return hit;
  const p = gaiaCone(ra, dec, 240, { signal: opts.signal });
  p.catch(() => gaiaCache.delete(key));
  gaiaCache.set(key, p);
  return p;
}
