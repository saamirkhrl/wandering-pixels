// Matched photometry, steps 3 to 7 (docs/algorithm.md): per-visit spectral model, common
// wavelengths of a visit pair, combined difference, plain best pair, paired stack, flags, verdict.
// Pure, no dependencies. Input exposures carry the step 1-2 measurement from photometry.ts.
import type { ExposureMeasurement } from './photometry';

// ------------------------------------------------------------------ constants --
export const MIN_SAMPLES = 3;
/** Model window half width, local bandwidths. */
export const WINDOW_BW = 2.5;
/** The single worst sample is dropped when its normalised residual exceeds this. */
export const CLIP_SIGMA = 4.0;
/** Selected w0 must be more than SEP_BW * b0 above the previous. */
export const SEP_BW = 5.0;
/** Paired stack: maximum |lam gap| in mean bandwidths of the two exposures. */
export const PAIR_GAP_BW = 1.0;
/** Fewer accepted exposures than this in a visit sets partial_visit. */
export const MIN_EXPOSURES = 8;
/** Visit membership (applied by the caller, library inStack rule). */
export const MIN_VISIT_EXPOSURES = 12;
/** |z| >= Z_CHANGED reads "changed" (display choice, not calibrated). */
export const Z_CHANGED = 3.0;
export const BLEND_RADIUS_ARCSEC = 20.0;
export const BLEND_DMAG = 3.0;

// ------------------------------------------------------------------ types --
export interface MatchedExposure {
  id: string;
  /** Visit label, compared with the visitA / visitB arguments. */
  visit: number | string;
  mjd: number;
  /** Wavelength and bandwidth (um) at the star's detector pixel in this exposure. */
  wavelength: number;
  bandwidth: number;
  measurement: ExposureMeasurement;
}

/** An accepted exposure: the record (id, mjd, lam, bw, F, var', saturated). */
export interface Sample {
  id: string;
  mjd: number;
  lam: number;
  bw: number;
  flux: number;
  var: number;
  saturated: boolean;
}

export type SpecModelReason = 'ok' | 'too_few_samples' | 'no_bracket';

export interface SpecModelResult {
  /** Matched flux (model value at w0), NaN without a value. */
  a: number;
  /** Matched variance Var(a), NaN without a value. */
  varA: number;
  nUsed: number;
  reason: SpecModelReason;
}

export interface WavelengthComparison {
  w0: number;
  b0: number;
  fluxA: number;
  errA: number;
  fluxB: number;
  errB: number;
  nA: number;
  nB: number;
  D: number;
  var: number;
  z: number;
  idA: string;
  plainIdB: string;
  plainDlamBw: number;
  plainD: number;
  plainVar: number;
  plainZ: number;
}

export interface SkippedWavelength {
  w0: number;
  reason: 'too_few_samples' | 'no_bracket';
}

export interface CombinedStat {
  D: number;
  var: number;
  z: number;
  fractionalChange: number;
}

export interface PairedStack extends CombinedStat {
  nPairs: number;
  /** [id A, id B, |lam gap|] */
  pairs: Array<[string, string, number]>;
}

export type MatchedFlag = 'saturated' | 'partial_visit' | 'blended' | 'too_few_samples' | 'no_bracket';
export type Verdict = 'changed' | 'no significant change' | 'no result';

export interface MatchedResult {
  perWavelength: WavelengthComparison[];
  skipped: SkippedWavelength[];
  nExposuresA: number;
  nExposuresB: number;
  /** Number of w0 used. */
  nW0: number;
  /** Number of w0 skipped. */
  nSkipped: number;
  /** Combined (inverse-variance) values over the used w0; NaN when no w0 survives. */
  D: number;
  var: number;
  z: number;
  fractionalChange: number;
  verdict: Verdict;
  /** Plain best pair, combined over the used w0; null when no w0 survives. */
  plain: CombinedStat | null;
  /** Paired stack (nPairs 0 and NaN values when nothing pairs). */
  ps: PairedStack;
  flags: MatchedFlag[];
}

export interface CompareOptions {
  /** A Gaia neighbour with G < G_star + 3 within 20 arcsec (see isBlended). */
  blended?: boolean;
}

// ------------------------------------------------------------------ step 3 --

/**
 * Weighted straight-line model F = a + c (lam - w0) of one visit's accepted exposures, with the
 * single-worst-sample clip. Samples must carry the inflated variance.
 */
export function specModel(samples: readonly Sample[], w0: number, b0: number, halfwidthBw = WINDOW_BW): SpecModelResult {
  const n = samples.length;
  const x = new Array<number>(n);
  const sel = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    x[i] = s.lam - w0;
    sel[i] =
      Number.isFinite(x[i]!) &&
      Number.isFinite(s.flux) &&
      Number.isFinite(s.var) &&
      s.var > 0 &&
      Math.abs(x[i]!) <= halfwidthBw * b0;
  }
  const check = (m: boolean[]): SpecModelReason => {
    let cnt = 0;
    let lo = false;
    let hi = false;
    for (let i = 0; i < n; i++) {
      if (!m[i]) continue;
      cnt++;
      if (x[i]! <= 0) lo = true;
      if (x[i]! >= 0) hi = true;
    }
    if (cnt < MIN_SAMPLES) return 'too_few_samples';
    if (!(lo && hi)) return 'no_bracket';
    return 'ok';
  };
  const count = (m: boolean[]) => m.reduce((c, v) => c + (v ? 1 : 0), 0);
  const fit = (m: boolean[]) => {
    let S = 0;
    let Sx = 0;
    let Sxx = 0;
    let Sy = 0;
    let Sxy = 0;
    for (let i = 0; i < n; i++) {
      if (!m[i]) continue;
      const wt = 1 / samples[i]!.var;
      const xi = x[i]!;
      const yi = samples[i]!.flux;
      S += wt;
      Sx += wt * xi;
      Sxx += wt * xi * xi;
      Sy += wt * yi;
      Sxy += wt * xi * yi;
    }
    const Dn = S * Sxx - Sx * Sx;
    return { a: (Sxx * Sy - Sx * Sxy) / Dn, c: (S * Sxy - Sx * Sy) / Dn, va: Sxx / Dn };
  };
  const fail = (nUsed: number, reason: SpecModelReason): SpecModelResult => ({ a: NaN, varA: NaN, nUsed, reason });

  const r0 = check(sel);
  if (r0 !== 'ok') return fail(count(sel), r0);
  const f0 = fit(sel);
  let worst = -1;
  let worstRes = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!sel[i]) continue;
    const res = Math.abs(samples[i]!.flux - (f0.a + f0.c * x[i]!)) / Math.sqrt(samples[i]!.var);
    if (res > worstRes) {
      worstRes = res;
      worst = i;
    }
  }
  const sel2 = sel.slice();
  if (worst >= 0 && worstRes > CLIP_SIGMA) sel2[worst] = false;
  const r1 = check(sel2);
  if (r1 !== 'ok') return fail(count(sel2), r1);
  const f1 = fit(sel2);
  if (!(Number.isFinite(f1.a) && Number.isFinite(f1.va) && f1.va > 0)) return fail(count(sel2), 'no_bracket');
  return { a: f1.a, varA: f1.va, nUsed: count(sel2), reason: 'ok' };
}

// ------------------------------------------------------------------ step 4 --

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Step 4: greedy independent evaluation wavelengths from visit A's accepted exposures. */
export function selectWavelengths(samplesA: readonly Sample[]): Sample[] {
  const cand = samplesA.slice().sort((p, q) => p.lam - q.lam || cmpStr(p.id, q.id));
  const sel: Sample[] = [];
  for (const s of cand) {
    if (sel.length === 0 || s.lam - sel[sel.length - 1]!.lam > SEP_BW * s.bw) sel.push(s);
  }
  return sel;
}

// ------------------------------------------------------------------ step 5/6 helpers --

/** Inverse-variance mean and its variance. */
export function inverseVarianceMean(vals: readonly number[], vars: readonly number[]): { mean: number; var: number } {
  let sw = 0;
  let sv = 0;
  for (let i = 0; i < vals.length; i++) {
    const w = 1 / vars[i]!;
    sw += w;
    sv += w * vals[i]!;
  }
  return { mean: sv / sw, var: 1 / sw };
}

/** Step 6, paired stack PS. */
export function pairedStack(samplesA: readonly Sample[], samplesB: readonly Sample[]): PairedStack {
  const cands: Array<{ gap: number; dm: number; a: Sample; b: Sample }> = [];
  for (const a of samplesA) {
    for (const b of samplesB) {
      const gap = Math.abs(a.lam - b.lam);
      if (gap <= PAIR_GAP_BW * 0.5 * (a.bw + b.bw)) cands.push({ gap, dm: Math.abs(a.mjd - b.mjd), a, b });
    }
  }
  cands.sort((p, q) => p.gap - q.gap || p.dm - q.dm || cmpStr(p.a.id, q.a.id) || cmpStr(p.b.id, q.b.id));
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  const pairs: Array<{ a: Sample; b: Sample; gap: number }> = [];
  for (const c of cands) {
    if (usedA.has(c.a.id) || usedB.has(c.b.id)) continue;
    usedA.add(c.a.id);
    usedB.add(c.b.id);
    pairs.push({ a: c.a, b: c.b, gap: c.gap });
  }
  if (pairs.length === 0) return { nPairs: 0, D: NaN, var: NaN, z: NaN, fractionalChange: NaN, pairs: [] };
  const D = pairs.map((p) => p.a.flux - p.b.flux);
  const vars = pairs.map((p) => p.a.var + p.b.var);
  const dm = inverseVarianceMean(D, vars);
  const fm = inverseVarianceMean(
    pairs.map((p) => 0.5 * (p.a.flux + p.b.flux)),
    vars,
  );
  return {
    nPairs: pairs.length,
    D: dm.mean,
    var: dm.var,
    z: dm.mean / Math.sqrt(dm.var),
    fractionalChange: dm.mean / fm.mean,
    pairs: pairs.map((p) => [p.a.id, p.b.id, p.gap]),
  };
}

/** Gaia neighbour test: any other source with G < G_star + 3 within 20 arcsec. */
export function isBlended(
  star: { ra: number; dec: number; g: number },
  neighbours: ReadonlyArray<{ ra: number; dec: number; g: number }>,
  starIndex?: number,
): boolean {
  const cosd = Math.cos((star.dec * Math.PI) / 180);
  for (let i = 0; i < neighbours.length; i++) {
    if (i === starIndex) continue;
    const nb = neighbours[i]!;
    const dra = (nb.ra - star.ra) * cosd * 3600;
    const ddec = (nb.dec - star.dec) * 3600;
    if (Math.hypot(dra, ddec) <= BLEND_RADIUS_ARCSEC && nb.g < star.g + BLEND_DMAG) return true;
  }
  return false;
}

// ------------------------------------------------------------------ steps 4 to 7 --

/** Accepted exposures of one visit as samples, in input order. */
export function samplesOfVisit(exposures: readonly MatchedExposure[], visit: number | string): Sample[] {
  const out: Sample[] = [];
  for (const e of exposures) {
    if (e.visit !== visit || !e.measurement.ok) continue;
    // exposures with a non-finite lam or bw are not accepted
    if (!Number.isFinite(e.wavelength) || !Number.isFinite(e.bandwidth)) continue;
    out.push({
      id: e.id,
      mjd: e.mjd,
      lam: e.wavelength,
      bw: e.bandwidth,
      flux: e.measurement.flux,
      var: e.measurement.variance,
      saturated: e.measurement.saturated,
    });
  }
  return out;
}

/**
 * Steps 4 to 7 for one star and one visit pair (visit A earlier, B later), one detector.
 * `exposures` holds every measured exposure of the star (accepted or not); the saturation flag
 * also counts rejected exposures, as in step 2.7. Only visits that already satisfy the
 * MIN_VISIT_EXPOSURES membership rule should be passed.
 */
export function compareVisits(
  exposures: readonly MatchedExposure[],
  visitA: number | string,
  visitB: number | string,
  options: CompareOptions = {},
): MatchedResult {
  const samplesA = samplesOfVisit(exposures, visitA);
  const samplesB = samplesOfVisit(exposures, visitB);
  const flags: MatchedFlag[] = [];
  if (exposures.some((e) => (e.visit === visitA || e.visit === visitB) && e.measurement.saturated)) {
    flags.push('saturated');
  }
  if (samplesA.length < MIN_EXPOSURES || samplesB.length < MIN_EXPOSURES) flags.push('partial_visit');
  if (options.blended) flags.push('blended');

  const perWavelength: WavelengthComparison[] = [];
  const skipped: SkippedWavelength[] = [];
  for (const s of selectWavelengths(samplesA)) {
    const w0 = s.lam;
    const b0 = s.bw;
    const ma = specModel(samplesA, w0, b0);
    const mb = specModel(samplesB, w0, b0);
    if (ma.reason !== 'ok' || mb.reason !== 'ok') {
      skipped.push({ w0, reason: ma.reason !== 'ok' ? ma.reason : (mb.reason as 'too_few_samples' | 'no_bracket') });
      continue;
    }
    const D = ma.a - mb.a;
    const v = ma.varA + mb.varA;
    // plain best pair: the visit-B exposure nearest in lam to the defining visit-A exposure
    let sb: Sample | null = null;
    for (const c of samplesB) {
      if (
        sb === null ||
        Math.abs(c.lam - w0) < Math.abs(sb.lam - w0) ||
        (Math.abs(c.lam - w0) === Math.abs(sb.lam - w0) && cmpStr(c.id, sb.id) < 0)
      ) {
        sb = c;
      }
    }
    const pD = s.flux - sb!.flux;
    const pVar = s.var + sb!.var;
    perWavelength.push({
      w0,
      b0,
      fluxA: ma.a,
      errA: Math.sqrt(ma.varA),
      fluxB: mb.a,
      errB: Math.sqrt(mb.varA),
      nA: ma.nUsed,
      nB: mb.nUsed,
      D,
      var: v,
      z: D / Math.sqrt(v),
      idA: s.id,
      plainIdB: sb!.id,
      plainDlamBw: Math.abs(sb!.lam - w0) / b0,
      plainD: pD,
      plainVar: pVar,
      plainZ: pD / Math.sqrt(pVar),
    });
  }
  if (skipped.some((k) => k.reason === 'too_few_samples')) flags.push('too_few_samples');
  if (skipped.some((k) => k.reason === 'no_bracket')) flags.push('no_bracket');

  const base = {
    perWavelength,
    skipped,
    nExposuresA: samplesA.length,
    nExposuresB: samplesB.length,
    nW0: perWavelength.length,
    nSkipped: skipped.length,
    ps: pairedStack(samplesA, samplesB),
    flags,
  };
  if (perWavelength.length === 0) {
    return { ...base, D: NaN, var: NaN, z: NaN, fractionalChange: NaN, verdict: 'no result', plain: null };
  }
  const vars = perWavelength.map((k) => k.var);
  const dm = inverseVarianceMean(
    perWavelength.map((k) => k.D),
    vars,
  );
  const fbar = inverseVarianceMean(
    perWavelength.map((k) => 0.5 * (k.fluxA + k.fluxB)),
    vars,
  );
  const z = dm.mean / Math.sqrt(dm.var);
  const pVars = perWavelength.map((k) => k.plainVar);
  const pm = inverseVarianceMean(
    perWavelength.map((k) => k.plainD),
    pVars,
  );
  const pf = inverseVarianceMean(
    perWavelength.map((k) => 0.5 * (k.fluxA + k.fluxB)),
    pVars,
  );
  return {
    ...base,
    D: dm.mean,
    var: dm.var,
    z,
    fractionalChange: dm.mean / fbar.mean,
    verdict: Math.abs(z) >= Z_CHANGED ? 'changed' : 'no significant change',
    plain: { D: pm.mean, var: pm.var, z: pm.mean / Math.sqrt(pm.var), fractionalChange: pm.mean / pf.mean },
  };
}
