import { describe, expect, it, vi } from 'vitest';
import type { Exposure } from '../../lib/spherex';

const stampsResult = vi.hoisted(() => ({ value: { stamps: [] as unknown[], failed: [] as unknown[] } }));
vi.mock('../../lib/spherex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/spherex')>();
  // the committed readouts files of public/cache
  const files = import.meta.glob(['../../../public/cache/*/index.json', '../../../public/cache/*/readouts*.json'], { eager: true, import: 'default' }) as Record<string, unknown>;
  const loadCachedReadouts = vi.fn(async (slug: string, opts?: { detector?: number }) => {
    const idx = files[`../../../public/cache/${slug}/index.json`] as
      | { readouts?: { file: string }; readoutsByDetector?: Record<string, { file: string }> }
      | undefined;
    if (!idx) throw new actual.SpherexError('NOT_FOUND', 'no index');
    const ref = opts?.detector === undefined ? idx.readouts : idx.readoutsByDetector?.[String(opts.detector)];
    if (!ref) throw new actual.SpherexError('NOT_FOUND', 'no readouts');
    return files[`../../../public/cache/${slug}/${ref.file}`];
  });
  return { ...actual, nativeStampsFor: vi.fn(async () => stampsResult.value), loadCachedReadouts };
});

import {
  checkStarLive,
  comparisonFor,
  fieldFor,
  hasBrightNeighbour,
  measurableStars,
  estimateText,
  liveEstimate,
  loadPreparedReadouts,
  matchPreparedStar,
  pairFromCached,
  preparedAvailable,
} from './change';
import type { ChangeStar, PreparedReadouts } from './change';

function star(id: string): ChangeStar {
  return { id, gmag: 10, isTarget: false, pairs: [], source: 'prepared' };
}

const prepared: PreparedReadouts = {
  slug: 'x',
  detector: 2,
  stars: [
    { id: 'target', ra: 10, dec: 20, gmag: null, isTarget: true, star: { ...star('target'), isTarget: true } },
    { id: 'g1', ra: 10.001, dec: 20, gmag: 12, isTarget: false, star: star('g1') },
    { id: 'g2', ra: 10.0005, dec: 20.0005, gmag: 13, isTarget: false, star: star('g2') },
  ],
};

describe('matchPreparedStar', () => {
  it('returns the nearest star within tolerance', () => {
    // g2 is about 2.4 arcsec from (10.0005, 20.0005)... query exactly at g2
    expect(matchPreparedStar(prepared, 10.0005, 20.0005, 3)?.id).toBe('g2');
    expect(matchPreparedStar(prepared, 10.0009, 20, 3)?.id).toBe('g1');
  });
  it('returns null outside tolerance', () => {
    expect(matchPreparedStar(prepared, 11, 21, 5)).toBeNull();
  });
  it('uses proper angular distance in RA', () => {
    const hi: PreparedReadouts = {
      slug: 'h',
      detector: 2,
      stars: [{ id: 'a', ra: 100, dec: 80, gmag: 9, isTarget: false, star: star('a') }],
    };
    // 0.01 deg of RA at dec 80 is about 6.25 arcsec on the sky
    expect(matchPreparedStar(hi, 100.01, 80, 7)?.id).toBe('a');
    expect(matchPreparedStar(hi, 100.01, 80, 5)).toBeNull();
  });
  it('uses the given target position for the target entry', () => {
    expect(matchPreparedStar(prepared, 10.01, 20, 3)).toBeNull();
    expect(matchPreparedStar(prepared, 10.01, 20, 3, { ra: 10.01, dec: 20 })?.id).toBe('target');
  });
});

describe('pairFromCached', () => {
  it('maps a full pair', () => {
    const p = pairFromCached({
      a: 0, b: 1, tA: 60000, tB: 60200, nA: 18, nB: 20,
      w: [[1.2, -0.5, 0.2, -2.5]],
      nSkipped: 2, D: -0.5, sigma: 0.2, z: -2.5, frac: -0.01,
      plain: { D: -0.4, sigma: 0.3, z: -1.3, frac: -0.008 },
      ps: { D: -0.45, sigma: 0.25, z: -1.8, frac: -0.009, n: 14 },
      flags: ['blended'], verdict: 'no significant change',
    });
    expect(p.tA).toBe(60000);
    expect(p.matched).toEqual({ D: -0.5, sigma: 0.2, z: -2.5, frac: -0.01 });
    expect(p.plain?.z).toBe(-1.3);
    expect(p.ps.n).toBe(14);
    expect(p.w).toEqual([[1.2, -0.5, 0.2, -2.5]]);
    expect(p.flags).toEqual(['blended']);
  });
  it('keeps nulls and a null plain', () => {
    const p = pairFromCached({
      a: 0, b: 1, tA: 1, tB: 2, nA: 3, nB: 4, w: [], nSkipped: 5,
      D: null, sigma: null, z: null, frac: null, plain: null,
      ps: { D: null, sigma: null, z: null, frac: null, n: 0 },
      flags: ['no_bracket'], verdict: 'no result',
    });
    expect(p.matched).toEqual({ D: null, sigma: null, z: null, frac: null });
    expect(p.plain).toBeNull();
    expect(p.ps).toEqual({ D: null, sigma: null, z: null, frac: null, n: 0 });
    expect(p.verdict).toBe('no result');
  });
});

function exp(visit: number, i: number, inStack?: boolean): Exposure {
  return {
    id: `v${visit}e${i}`, obsId: 'o', detector: 2, time: '', mjd: 60000 + visit * 100 + i * 0.01,
    visitIndex: visit, wavelengthAtTarget: null, bandwidthAtTarget: null, url: 'u', release: 'dr1', inStack,
  };
}
const many = (visit: number, n: number, inStack?: boolean) => Array.from({ length: n }, (_, i) => exp(visit, i, inStack));

describe('liveEstimate', () => {
  it('counts only in-stack exposures of visits with enough of them', () => {
    const exps = [...many(0, 18), ...many(1, 18), ...many(2, 5), ...many(3, 20, false)];
    const e = liveEstimate(exps);
    expect(e.nExposures).toBe(36);
    expect(e.nVisits).toBe(2);
    expect(e.bytes).toBeCloseTo(36 * 0.572e6, 0);
    expect(e.seconds).toBeCloseTo(36 * 0.31, 6);
  });
  it('ignores stray not-in-stack exposures inside a visit', () => {
    const exps = [...many(0, 12), ...many(0, 3, false)];
    expect(liveEstimate(exps).nExposures).toBe(12);
  });
  it('is empty for nothing', () => {
    expect(liveEstimate([])).toEqual({ bytes: 0, seconds: 0, nExposures: 0, nVisits: 0 });
  });
});

describe('estimateText', () => {
  it('formats MB and seconds', () => {
    expect(estimateText({ bytes: 20.6e6, seconds: 11.16 })).toBe('about 21 MB, about 11 seconds');
  });
  it('has a minimum of 1', () => {
    expect(estimateText({ bytes: 0, seconds: 0 })).toBe('about 1 MB, about 1 second');
  });
});

describe('prepared readouts (committed cache files)', () => {
  it('loads Barnard: target has no pairs, field counts attached', async () => {
    expect(preparedAvailable).toBe(true);
    const r = await loadPreparedReadouts('barnards-star');
    expect(r).not.toBeNull();
    expect(r!.detector).toBe(2);
    const t = r!.stars.find((s) => s.isTarget)!;
    expect(t.star.pairs.length).toBe(0);
    const p = r!.stars.find((s) => !s.isTarget && s.star.pairs.length > 0)!.star.pairs[0];
    expect(p.field!.measured).toBeGreaterThan(10);
    expect(p.field!.differ).toBeLessThanOrEqual(p.field!.measured);
    expect(fieldFor(r!, p.tA + 1, p.tB - 1)).toEqual(p.field);
  });
  it('lists measurable stars from the reliable field', async () => {
    const r = await loadPreparedReadouts('eps-indi-b');
    const m = measurableStars(r!);
    expect(m.length).toBeGreaterThan(0);
    for (const s of m) expect(s.star.pairs.some((p) => p.reliable === true)).toBe(true);
    const rd = await loadPreparedReadouts('r-dra');
    expect(measurableStars(rd!).length).toBe(0);
  });
  // the V391 Oph cache may not be committed yet; the test runs once its files exist
  const hasV391 = Object.keys(import.meta.glob('../../../public/cache/v391-oph/index.json')).length > 0;
  it.skipIf(!hasV391)('V391 Oph: detector option, catalogue note, comparison star', async () => {
    const d2 = await loadPreparedReadouts('v391-oph');
    const d1 = await loadPreparedReadouts('v391-oph', { detector: 1 });
    expect(d2!.detector).toBe(2);
    expect(d1!.detector).toBe(1);
    expect(await loadPreparedReadouts('v391-oph', { detector: 3 })).toBeNull();
    const t = d2!.stars.find((s) => s.isTarget)!;
    expect(t.star.catalogueNote).toBe('Catalogued as an eclipsing binary (Gaia DR3; SIMBAD).');
    expect(t.star.variable).toBe(true);
    // reference: about 15 to 18 percent at z about 15 to 18 on detector 2
    const big = t.star.pairs.filter((p) => Math.abs(p.matched.z ?? 0) > 10);
    expect(big.length).toBe(2);
    for (const p of big) expect(Math.abs((p.matched.frac ?? 0) * 100)).toBeGreaterThan(14);
    const c = comparisonFor(d2!)!;
    expect(c.gmag).toBeCloseTo(12.91, 2);
    for (const p of c.star.pairs) expect(Math.abs(p.matched.z ?? 99)).toBeLessThan(2);
  });
  it('resolves null for a target without a readouts file', async () => {
    expect(await loadPreparedReadouts('no-such-target')).toBeNull();
  });
});

describe('hasBrightNeighbour', () => {
  it('finds a G < 9 star within 180 arcsec, ignoring the star itself', () => {
    expect(hasBrightNeighbour(10, 20, [{ ra: 10, dec: 20.04, gmag: 8 }])).toBe(true);
    expect(hasBrightNeighbour(10, 20, [{ ra: 10, dec: 20.06, gmag: 8 }])).toBe(false);
    expect(hasBrightNeighbour(10, 20, [{ ra: 10, dec: 20.01, gmag: 9.5 }])).toBe(false);
    expect(hasBrightNeighbour(10, 20, [{ ra: 10, dec: 20, gmag: 7 }])).toBe(false);
  });
});

describe('checkStarLive', () => {
  const input = { ra: 10, dec: 20, exposures: [...many(0, 12), ...many(1, 12)], gaia: [] };
  it('throws when every stamp failed', async () => {
    stampsResult.value = { stamps: [], failed: [{}] };
    await expect(checkStarLive(input, {})).rejects.toMatchObject({ name: 'SpherexError' });
  });
  it('throws NO_COVERAGE with fewer than two usable visits', async () => {
    await expect(checkStarLive({ ...input, exposures: many(0, 12) }, {})).rejects.toMatchObject({ code: 'NO_COVERAGE' });
  });
});
