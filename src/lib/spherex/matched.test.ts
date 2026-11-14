import { describe, expect, it } from 'vitest';
import vectors from '../../../docs/algorithm_test_vectors.json';
import {
  type MatchedExposure,
  type Sample,
  compareVisits,
  isBlended,
  selectWavelengths,
  specModel,
} from './matched';
import type { MeasurementReason } from './photometry';

interface VecExposure {
  obs_id: string;
  mjd: number;
  lam: number;
  bw: number;
  accepted: boolean;
  reason: string;
  saturated: boolean;
  flux: number | null;
  var: number | null;
  var_raw: number | null;
  bkg: number | null;
  n_bkg: number;
}
interface VecStar {
  source_id: string;
  blended: boolean;
  exposures: Record<string, VecExposure[]>;
  expected: {
    per_w0: Array<Record<string, number | string>>;
    skipped: Array<{ w0: number; reason: string }>;
    n_exposures_A: number;
    n_exposures_B: number;
    n_w0: number;
    D: number;
    var: number;
    z: number;
    frac: number;
    plain: { D: number; var: number; z: number; frac: number };
    ps: { n_pairs: number; D: number; var: number; z: number; frac: number; pairs: Array<[string, string, number]> };
    verdict: string;
    flags: string[];
  };
}
const V = vectors as unknown as { stars: VecStar[]; visit_pair: { visit_A: number; visit_B: number } };

// The vector file is unrounded; docs/algorithm.md asks a port to match to 1e-6 relative.
const TOL = 1e-6;

function close(a: number, b: number, label: string, rel = TOL): void {
  const ok = Math.abs(a - b) <= rel * Math.abs(b) + (b === 0 ? 1e-12 : 0);
  if (!ok) throw new Error(`${label}: got ${a}, expected ${b} (rel ${(Math.abs(a - b) / Math.abs(b)).toExponential(2)})`);
}

function exposuresOf(star: VecStar): MatchedExposure[] {
  const out: MatchedExposure[] = [];
  for (const [visit, list] of Object.entries(star.exposures)) {
    for (const e of list) {
      out.push({
        id: e.obs_id,
        visit: Number(visit),
        mjd: e.mjd,
        wavelength: e.lam,
        bandwidth: e.bw,
        measurement: {
          ok: e.accepted,
          reason: e.reason as MeasurementReason,
          saturated: e.saturated,
          flux: e.flux ?? NaN,
          varRaw: e.var_raw ?? NaN,
          variance: e.var ?? NaN,
          bkg: e.bkg ?? NaN,
          sBkg: NaN,
          nBkg: e.n_bkg,
          nAperture: 0,
        },
      });
    }
  }
  return out;
}

describe.each(V.stars.map((s, i) => [i + 1, s] as const))('test vector star %i', (_n, star) => {
  const res = compareVisits(exposuresOf(star), V.visit_pair.visit_A, V.visit_pair.visit_B, { blended: star.blended });
  const e = star.expected;

  it('counts, skipped wavelengths and flags', () => {
    expect(res.nExposuresA).toBe(e.n_exposures_A);
    expect(res.nExposuresB).toBe(e.n_exposures_B);
    expect(res.nW0).toBe(e.n_w0);
    expect(res.nSkipped).toBe(e.skipped.length);
    expect(res.skipped.map((s) => s.reason)).toEqual(e.skipped.map((s) => s.reason));
    res.skipped.forEach((s, i) => close(s.w0, e.skipped[i]!.w0, 'skipped w0'));
    expect(res.flags).toEqual(e.flags);
    expect(res.verdict).toBe(e.verdict);
  });

  it('per-wavelength matched fluxes, differences and plain pair', () => {
    expect(res.perWavelength).toHaveLength(e.per_w0.length);
    res.perWavelength.forEach((k, i) => {
      const x = e.per_w0[i]!;
      const t = (name: string) => `w0 ${k.w0} ${name}`;
      close(k.w0, x.w0 as number, t('w0'));
      close(k.b0, x.b0 as number, t('b0'));
      close(k.fluxA, x.F_A as number, t('F_A'));
      close(k.errA, x.err_A as number, t('err_A'));
      close(k.fluxB, x.F_B as number, t('F_B'));
      close(k.errB, x.err_B as number, t('err_B'));
      expect(k.nA).toBe(x.n_A);
      expect(k.nB).toBe(x.n_B);
      close(k.D, x.D as number, t('D'));
      close(k.var, x.var as number, t('var'));
      close(k.z, x.z as number, t('z'));
      expect(k.idA).toBe(x.id_A);
      expect(k.plainIdB).toBe(x.plain_id_B);
      close(k.plainDlamBw, x.plain_dlam_bw as number, t('plain dlam'));
      close(k.plainD, x.plain_D as number, t('plain D'));
      close(k.plainVar, x.plain_var as number, t('plain var'));
      close(k.plainZ, x.plain_z as number, t('plain z'));
    });
  });

  it('combined result, plain pair and paired stack', () => {
    close(res.D, e.D, 'D');
    close(res.var, e.var, 'var');
    close(res.z, e.z, 'z');
    close(res.fractionalChange, e.frac, 'frac');
    close(res.plain!.D, e.plain.D, 'plain D');
    close(res.plain!.var, e.plain.var, 'plain var');
    close(res.plain!.z, e.plain.z, 'plain z');
    close(res.plain!.fractionalChange, e.plain.frac, 'plain frac');
    expect(res.ps.nPairs).toBe(e.ps.n_pairs);
    close(res.ps.D, e.ps.D, 'ps D');
    close(res.ps.var, e.ps.var, 'ps var');
    close(res.ps.z, e.ps.z, 'ps z');
    close(res.ps.fractionalChange, e.ps.frac, 'ps frac');
    expect(res.ps.pairs.map((p) => [p[0], p[1]])).toEqual(e.ps.pairs.map((p) => [p[0], p[1]]));
    res.ps.pairs.forEach((p, i) => close(p[2], e.ps.pairs[i]![2], `ps gap ${i}`));
  });
});

const sample = (id: string, lam: number, flux: number, v: number, bw = 0.03): Sample => ({
  id,
  mjd: 0,
  lam,
  bw,
  flux,
  var: v,
  saturated: false,
});

describe('specModel', () => {
  it('recovers a straight line exactly', () => {
    const s = [-0.05, -0.02, 0.01, 0.04].map((d, i) => sample(String(i), 1.5 + d, 10 + 40 * d, 0.01));
    const m = specModel(s, 1.5, 0.03);
    expect(m.reason).toBe('ok');
    expect(m.a).toBeCloseTo(10, 9);
    expect(m.nUsed).toBe(4);
  });

  it('reports too_few_samples and no_bracket', () => {
    const two = [sample('a', 1.49, 1, 1), sample('b', 1.51, 1, 1)];
    expect(specModel(two, 1.5, 0.03).reason).toBe('too_few_samples');
    const one_sided = [1.51, 1.52, 1.53].map((l, i) => sample(String(i), l, 1, 1));
    expect(specModel(one_sided, 1.5, 0.03).reason).toBe('no_bracket');
  });

  it('drops only the single worst sample beyond 4 sigma, once', () => {
    const s = [-0.05, -0.03, -0.01, 0.01, 0.03, 0.05].map((d, i) => sample(String(i), 1.5 + d, 10, 0.01));
    s[2] = sample('out', 1.49, 10 + 5, 0.01);
    const m = specModel(s, 1.5, 0.03);
    expect(m.nUsed).toBe(5);
    expect(m.a).toBeCloseTo(10, 9);
    expect(m.varA).toBeGreaterThan(0);
  });

  it('is invariant to input order', () => {
    const s = [-0.05, -0.02, 0.01, 0.04, 0.06].map((d, i) => sample(String(i), 1.5 + d, 10 + 30 * d + (i % 2) * 0.1, 0.01 + i * 0.001));
    const a = specModel(s, 1.5, 0.03);
    const b = specModel(s.slice().reverse(), 1.5, 0.03);
    expect(b.a).toBeCloseTo(a.a, 12);
    expect(b.varA).toBeCloseTo(a.varA, 12);
  });
});

describe('selectWavelengths and flags', () => {
  it('selects greedily, more than 5 b0 apart, ties by id', () => {
    const s = [1.0, 1.05, 1.2, 1.21, 1.4].map((l, i) => sample(`i${i}`, l, 1, 1, 0.03));
    expect(selectWavelengths(s).map((x) => x.lam)).toEqual([1.0, 1.2, 1.4]);
  });

  it('returns no result when no wavelength survives', () => {
    const ex: MatchedExposure[] = [0, 1, 2].map((i) => ({
      id: `a${i}`,
      visit: 0,
      mjd: i,
      wavelength: 1 + i * 0.01,
      bandwidth: 0.03,
      measurement: {
        ok: true, reason: 'ok', saturated: false, flux: 1, varRaw: 1, variance: 1, bkg: 0, sBkg: 0, nBkg: 20, nAperture: 12,
      },
    }));
    const r = compareVisits(ex, 0, 1);
    expect(r.verdict).toBe('no result');
    expect(r.plain).toBeNull();
    expect(r.flags).toContain('partial_visit');
  });

  it('isBlended follows the 20 arcsec and 3 mag rule', () => {
    const star = { ra: 10, dec: 0, g: 12 };
    const near = { ra: 10 + 10 / 3600, dec: 0, g: 14.9 };
    const faint = { ra: 10 + 10 / 3600, dec: 0, g: 15.1 };
    const far = { ra: 10 + 30 / 3600, dec: 0, g: 10 };
    expect(isBlended(star, [star, near], 0)).toBe(true);
    expect(isBlended(star, [star, faint, far], 0)).toBe(false);
  });
});
