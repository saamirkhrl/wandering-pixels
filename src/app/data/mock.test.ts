import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  annotateWavelengths,
  ORIENTATION_TEST_STAR,
  buildMovie,
  difference,
  findExposures,
  gaiaCone,
  compareVisits,
  asNaiveStack,
  asSingle,
  detectorFromCached,
  gridToWorld,
  loadCachedDetector,
  loadCachedPreview,
  pairedDifference,
  previewFromCached,
  visitDifference,
  positionAtDistance,
  loadFirstLook,
  saturatedSources,
  loadFrame,
  listCached,
  loadCached,
  loadFrames,
  makeGrid,
  MOCK_FRAME_MB,
  pickBlinkPair,
  positionAt,
  resolveTarget,
  setMockLatencyScale,
  spectrumAt,
  summarize,
  wiseCone,
  worldToGrid,
} from './mock';
import type { Grid, PairComparison, Progress } from './types';

const grid: Grid = { ra0: 269.4, dec0: 4.7, w: 65, h: 65, scaleArcsec: 6.15, epochMjd: 60900 };

beforeAll(() => setMockLatencyScale(0));
afterAll(() => setMockLatencyScale(1));

describe('geometry', () => {
  it('round-trips grid and world', () => {
    for (const [x, y] of [
      [0, 0],
      [32, 32],
      [10.5, 50.25],
      [64, 3],
    ]) {
      const p = gridToWorld(grid, x, y);
      const [bx, by] = worldToGrid(grid, p.ra, p.dec);
      expect(bx).toBeCloseTo(x, 6);
      expect(by).toBeCloseTo(y, 6);
    }
    const [cx, cy] = worldToGrid(grid, grid.ra0, grid.dec0);
    expect(cx).toBeCloseTo(32, 9);
    expect(cy).toBeCloseTo(32, 9);
  });

  it('puts east on the left and north up', () => {
    const [xe] = worldToGrid(grid, grid.ra0 + 0.01, grid.dec0);
    expect(xe).toBeLessThan(32);
    const [, yn] = worldToGrid(grid, grid.ra0, grid.dec0 + 0.01);
    expect(yn).toBeLessThan(32);
  });

  it('sizes grids as odd pixel counts', () => {
    const t = { ra: 10, dec: 10 };
    expect(makeGrid(t, [], 400).w).toBe(65);
    expect(makeGrid(t, [], 200).w).toBe(33);
    expect(makeGrid(t, [], 800).w).toBe(131);
  });

  it('applies proper motion', () => {
    const t = { ra: 269.4521, dec: 4.6934, pmra: -801.6, pmdec: 10362.4 };
    const a = positionAt(t, 51544.5);
    const b = positionAt(t, 51544.5 + 365.25);
    expect((b.dec - a.dec) * 3600).toBeCloseTo(10.3624, 3);
  });
});

describe('cached targets', () => {
  it('lands the orientation star upper-left', async () => {
    const c = await loadCached('barnards-star');
    const [x, y] = worldToGrid(c.grid, ORIENTATION_TEST_STAR.ra, ORIENTATION_TEST_STAR.dec);
    const cx = (c.grid.w - 1) / 2;
    const cy = (c.grid.h - 1) / 2;
    expect(x).toBeLessThan(cx);
    expect(y).toBeLessThan(cy);
    expect(x).toBeCloseTo(cx - 80 / 6.15, 1);
    expect(y).toBeCloseTo(cy - 80 / 6.15, 1);
  });

  it('walks Barnard\'s Star north across visits', async () => {
    const c = await loadCached('barnards-star');
    const movie = buildMovie(c.frames, 'visit-stack', 2, c.target);
    expect(movie.frames.length).toBe(3);
    expect(movie.stretch.lo).toBeLessThan(movie.stretch.hi);
    const first = movie.frames[0].targetXY as [number, number];
    const last = movie.frames[movie.frames.length - 1].targetXY as [number, number];
    expect(last[1]).toBeLessThan(first[1]);
    expect(first[1] - last[1]).toBeGreaterThan(1.4);
    expect(Math.abs(last[0] - first[0])).toBeLessThan(first[1] - last[1]);
  });

  it('has frames with gaps, NaN and zero-filled flags kept consistent', async () => {
    const c = await loadCached('wise-0855');
    expect(c.frames.length).toBe(c.exposures.length);
    let anyGap = false;
    for (const f of c.frames) {
      let finite = 0;
      for (let i = 0; i < f.pixels.length; i++) {
        if (Number.isFinite(f.pixels[i])) finite++;
        else expect(f.flags[i]).not.toBe(0);
      }
      expect(f.coverage).toBeCloseTo(finite / f.pixels.length, 9);
      if (f.coverage < 1) anyGap = true;
    }
    expect(anyGap).toBe(true);
    expect(c.gaia.length).toBeGreaterThan(3);
    expect(c.wise.length).toBeGreaterThan(3);
    expect(c.wise.some((s) => /^J\d{6}\.\d{2}[+-]\d{6}\.\d$/.test(s.id))).toBe(true);
  });

  it('finds both matched and unmatched difference pairs', async () => {
    const c = await loadCached('barnards-star');
    const m = buildMovie(c.frames, 'visit-stack', 2, c.target);
    const flags: boolean[] = [];
    for (let i = 0; i < m.frames.length; i++) {
      for (let j = i + 1; j < m.frames.length; j++) {
        flags.push(difference(m.frames[i], m.frames[j]).wavelengthMatched);
      }
    }
    expect(flags).toContain(true);
    expect(flags).toContain(false);
    const d = difference(m.frames[0], m.frames[1]);
    expect(d.stretch.lo).toBe(-d.stretch.hi);
  });

  it('keeps the zodi-subtracted sky centred on zero between visits', async () => {
    const robust = (v: number[]) => {
      const sorted = [...v].sort((x, y) => x - y);
      const med = sorted[sorted.length >> 1];
      const dev = sorted.map((x) => Math.abs(x - med)).sort((x, y) => x - y);
      return { med, sigma: 1.4826 * dev[dev.length >> 1] };
    };
    for (const slug of ['barnards-star', 'rw-aur'] as const) {
      const c = await loadCached(slug);
      const m = buildMovie(c.frames, 'visit-stack', 2, c.target);
      const d = difference(m.frames[0], m.frames[m.frames.length - 1]);
      const finite = Array.from(d.pixels).filter((x) => Number.isFinite(x));
      const { med, sigma } = robust(finite);
      expect(sigma).toBeGreaterThan(0);
      expect(Math.abs(med)).toBeLessThan(0.2 * sigma);
    }
  });

  it('leaves an empty detector for at least one target', async () => {
    const c = await loadCached('barnards-star');
    const s = summarize(c.exposures);
    expect(s).toHaveLength(6);
    expect(s.find((d) => d.detector === 6)?.count).toBe(0);
    expect(s.find((d) => d.detector === 2)?.visits.length).toBe(3);
  });

  it('produces a spectrum with the expected colour for WISE 0855', async () => {
    const c = await loadCached('wise-0855');
    const pts = spectrumAt(c.frames, c.grid.ra0, c.grid.dec0);
    expect(pts.length).toBeGreaterThan(10);
    const mean = (d: number) => {
      const v = pts.filter((p) => p.detector === d).map((p) => p.flux);
      return v.reduce((s, x) => s + x, 0) / v.length;
    };
    expect(mean(5)).toBeGreaterThan(10 * Math.max(mean(1), 0.01));
    expect(pts.every((p) => typeof p.flagged === 'boolean')).toBe(true);
  });

  it('loads every target quickly', async () => {
    for (const t of listCached()) {
      const t0 = performance.now();
      const c = await loadCached(t.slug);
      expect(c.frames.length).toBeGreaterThan(25);
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });
});

describe('resolveTarget', () => {
  it('resolves names, slugs and coordinates', async () => {
    expect((await resolveTarget("Barnard's Star")).name).toBe("Barnard's Star");
    expect((await resolveTarget('barnards star')).source).toBe('cache');
    expect((await resolveTarget('wise-0855')).name).toBe('WISE 0855-0714');
    const a = await resolveTarget('17 57 48.5 +04 41 36');
    expect(a.ra).toBeCloseTo(269.452, 2);
    expect(a.dec).toBeCloseTo(4.6933, 3);
    const b = await resolveTarget('17:57:48.5 +04:41:36');
    expect(b.ra).toBeCloseTo(a.ra, 9);
    const c = await resolveTarget('269.45, +4.69');
    expect(c.source).toBe('coordinates');
    expect(c.dec).toBeCloseTo(4.69, 9);
  });

  it('rejects unknown and bad input', async () => {
    await expect(resolveTarget('nowhere')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(resolveTarget('')).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(resolveTarget('???')).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(resolveTarget('400 95')).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});

describe('live path', () => {
  it('reports no coverage and busy errors', async () => {
    await expect(findExposures(0, 90)).rejects.toMatchObject({ code: 'NO_COVERAGE' });
    await expect(findExposures(1, 1)).rejects.toMatchObject({ code: 'UPSTREAM_BUSY' });
  });

  it('aborts promptly', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(resolveTarget('Vega', { signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(findExposures(10, 10, { signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(loadCached('r-dra', { signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(gaiaCone(10, 10, 100, { signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('aborts while waiting', async () => {
    setMockLatencyScale(1);
    try {
      const ac = new AbortController();
      const p = findExposures(10, 10, { signal: ac.signal });
      setTimeout(() => ac.abort(), 20);
      await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    } finally {
      setMockLatencyScale(0);
    }
  });

  it('runs a full search and download with one failure', async () => {
    const events: Progress[] = [];
    const t = await resolveTarget('Vega');
    const exposures = await findExposures(t.ra, t.dec, { onProgress: (p) => events.push(p) });
    expect(events.some((e) => e.retrying)).toBe(true);
    expect(exposures.every((e) => e.wavelengthAtTarget === null)).toBe(true);
    const g = makeGrid(t, exposures);
    const pick = exposures.filter((e) => e.detector === 2);
    const landed: string[] = [];
    const prog: Progress[] = [];
    const r = await loadFrames(pick, g, {
      onFrame: (f) => landed.push(f.exposure.id),
      onProgress: (p) => prog.push(p),
    });
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].error.code).toBe('UPSTREAM_ERROR');
    expect(r.frames.length).toBe(pick.length - 1);
    expect(landed.length).toBe(r.frames.length);
    expect(r.frames[0].exposure.wavelengthAtTarget).not.toBeNull();
    expect(prog[prog.length - 1].message).toBe(`Downloaded ${pick.length} of ${pick.length} exposures`);
  });

  it('picks a blink pair from different visits nearest in wavelength', async () => {
    const c = await loadCached('barnards-star');
    const pair = pickBlinkPair(c.exposures, 2) as [typeof c.exposures[0], typeof c.exposures[0]];
    expect(pair).not.toBeNull();
    expect(pair[0].visitIndex).not.toBe(pair[1].visitIndex);
    expect(pair[0].mjd).toBeLessThanOrEqual(pair[1].mjd);
    const d = Math.abs((pair[0].wavelengthAtTarget as number) - (pair[1].wavelengthAtTarget as number));
    const pool = c.exposures.filter((e) => e.detector === 2);
    for (const a of pool) {
      for (const b of pool) {
        if (a.visitIndex !== b.visitIndex) {
          expect(Math.abs((a.wavelengthAtTarget as number) - (b.wavelengthAtTarget as number))).toBeGreaterThanOrEqual(d - 1e-12);
        }
      }
    }
    expect(pickBlinkPair(c.exposures)).not.toBeNull();
  });

  it('returns one visit for ra=2 dec=2 and many exposures elsewhere', async () => {
    const one = await findExposures(2, 2);
    expect(new Set(one.map((e) => e.visitIndex)).size).toBe(1);
    expect(pickBlinkPair(await annotateWavelengths(one, 2, 2))).toBeNull();
    const many = await findExposures(150, 20);
    expect(many.filter((e) => e.detector === 2).length).toBeGreaterThanOrEqual(80);
    expect(new Set(many.map((e) => e.visitIndex)).size).toBe(5);
    expect(MOCK_FRAME_MB).toBe(2);
    const noTarget = buildMovie([], 'visit-stack', 2);
    expect(noTarget.frames).toHaveLength(0);
  });

  it('loads a first look from two visits that is not matched', async () => {
    const t = await resolveTarget('Vega');
    const ex = await findExposures(t.ra, t.dec);
    const g = makeGrid(t, ex);
    const prog: Progress[] = [];
    const fl = await loadFirstLook(t, ex, g, { onProgress: (p) => prog.push(p) });
    expect(fl.detector).toBe(2);
    expect(fl.frames).toHaveLength(2);
    expect(fl.frames[0].exposure.visitIndex).not.toBe(fl.frames[1].exposure.visitIndex);
    expect(fl.frames[0].exposure.wavelengthAtTarget).not.toBeNull();
    expect(fl.matched).toBe(false);
    expect(prog[prog.length - 1].bytes).toBeGreaterThan(3_900_000);
    const d4 = await loadFirstLook(t, ex, g, { detector: 4 });
    expect(d4.detector).toBe(4);
    expect(d4.frames.every((f) => f.exposure.detector === 4)).toBe(true);
    const annotated = await annotateWavelengths(ex, t.ra, t.dec);
    expect(pickBlinkPair(annotated, 2)).not.toBeNull();
    const one = await findExposures(2, 2);
    const t2 = await resolveTarget('2 2');
    const single = await loadFirstLook(t2, one, makeGrid(t2, one));
    expect(single.frames).toHaveLength(1);
  });

  it('flags a saturated core and tracks bytes', async () => {
    const c = await loadCached('barnards-star');
    const f = c.frames.find((x) => x.exposure.detector === 2) as (typeof c.frames)[0];
    const src = saturatedSources(f);
    expect(src.length).toBeGreaterThanOrEqual(1);
    expect(src[0].npix).toBeGreaterThanOrEqual(9);
    const [tx, ty] = worldToGrid(f.grid, positionAt(c.target, f.exposure.mjd).ra, positionAt(c.target, f.exposure.mjd).dec);
    expect(Math.hypot(src[0].x - tx, src[0].y - ty)).toBeLessThan(1);
    expect(Number.isNaN(f.pixels[Math.round(ty) * f.w + Math.round(tx)])).toBe(true);
    expect(f.bytes).toBe(0);
    const t = await resolveTarget('Vega');
    const ex = await findExposures(t.ra, t.dec);
    const lf = await loadFrame(ex.find((e) => e.detector === 2)!, makeGrid(t, ex), { wavelengthMap: true });
    expect(lf.bytes).toBeGreaterThan(1_900_000);
    expect(lf.wavelengthMap).toBeDefined();
    expect(saturatedSources(lf).length).toBeGreaterThanOrEqual(1);
  });

  it('gives R Dra about sixteen visits', async () => {
    const c = await loadCached('r-dra');
    expect(summarize(c.exposures)[1].visits.length).toBe(16);
  });

  it('tracks a body at an assumed distance', async () => {
    const t = await resolveTarget('150 20');
    const ex = await findExposures(t.ra, t.dec);
    const g = makeGrid(t, ex);
    const det2 = ex.filter((e) => e.detector === 2);
    const early = det2[0];
    const late = det2.find((e) => e.mjd - early.mjd > 170 && e.mjd - early.mjd < 200) ?? det2[det2.length - 1];
    const track = async (d: number) =>
      (await loadFrames([early, late], g, { distanceAu: d })).frames;
    const f500 = await track(500);
    expect(f500).toHaveLength(2);
    expect(f500[0].trackingDistanceAu).toBe(500);
    expect(f500[0].grid.ra0).not.toBeCloseTo(f500[1].grid.ra0, 4);
    expect(f500[0].grid.epochMjd).toBeCloseTo(early.mjd, 6);

    const body = (frame: (typeof f500)[0]) => {
      const p = positionAtDistance(g.ra0, g.dec0, frame.exposure.mjd, 500);
      return worldToGrid(frame.grid, p.ra, p.dec);
    };
    const a = body(f500[0]);
    const b = body(f500[1]);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(0.5);
    expect(a[0]).toBeCloseTo((g.w - 1) / 2, 1);

    const f300 = await track(300);
    const c = body(f300[0]);
    const d = body(f300[1]);
    expect(Math.hypot(c[0] - d[0], c[1] - d[1])).toBeGreaterThan(3);

    // the faint source is really painted: its centre pixel is positive on average at 500 au
    const sample = det2.filter((_, i) => i % 7 === 0).slice(0, 14);
    const res = await loadFrames(sample, g, { distanceAu: 500 });
    let sum = 0;
    let n = 0;
    for (const f of res.frames) {
      const [x, y] = body(f);
      const v = f.pixels[Math.round(y) * f.w + Math.round(x)];
      if (Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    expect(n).toBeGreaterThan(5);
    expect(sum / n).toBeGreaterThan(0.12);

    const movie = buildMovie(f500, 'single', 2, t);
    expect(movie.trackingDistanceAu).toBe(500);
    expect(movie.frames[0].targetXY).toEqual([(g.w - 1) / 2, (g.h - 1) / 2]);
    const plain = (await loadFrames([early], g)).frames;
    expect(() => buildMovie([...f500, ...plain], 'single', 2)).toThrowError(expect.objectContaining({ code: 'BAD_INPUT' }));
    const other = (await loadFrames([late], g, { distanceAu: 300 })).frames;
    expect(() => buildMovie([f500[0], ...other], 'single', 2)).toThrowError(expect.objectContaining({ code: 'BAD_INPUT' }));
  });

  it('compares visit pairs', async () => {
    const det2 = async (slug: 'eps-indi-b' | 'wise-0855' | 'rw-aur' | 'barnards-star' | 'r-dra') => {
      const c = await loadCached(slug);
      const fr = c.frames.filter((f) => f.exposure.detector === 2);
      const visits = new Set(spectrumAt(fr, c.grid.ra0, c.grid.dec0).map((p) => p.visitIndex)).size;
      return { out: compareVisits(fr, c.grid.ra0, c.grid.dec0), visits };
    };
    const steady = await det2('eps-indi-b');
    expect(steady.out).toHaveLength((steady.visits * (steady.visits - 1)) / 2);
    const first = steady.out[0];
    expect(first.visitA).toBeLessThan(first.visitB);
    expect(Object.keys(first).sort()).toEqual(['flags', 'matched', 'paired', 'plain', 'visitA', 'visitB']);
    expect(first.plain.gapChannels).toBeGreaterThanOrEqual(0);
    // pairs flagged no_bracket have no common wavelength and are not expected to agree
    const bracketed = (o: PairComparison[]) => o.filter((p) => !p.flags.includes('no_bracket'));
    expect(bracketed(steady.out).length).toBeGreaterThan(0);
    for (const p of bracketed(steady.out)) expect(Math.abs(p.matched.z)).toBeLessThan(3);
    const wise = await det2('wise-0855');
    expect(bracketed(wise.out).length).toBeGreaterThan(0);
    for (const p of bracketed(wise.out)) expect(Math.abs(p.matched.z)).toBeLessThan(3);

    const variable = await det2('rw-aur');
    expect(variable.out.some((p) => Math.abs(p.matched.z) >= 5)).toBe(true);
    const mira = await det2('r-dra');
    expect(mira.out).toHaveLength((mira.visits * (mira.visits - 1)) / 2);
    expect(mira.out.some((p) => Math.abs(p.matched.z) >= 5)).toBe(true);

    expect(steady.out.some((p) => p.flags.includes('too_few_samples'))).toBe(true);
    expect(mira.out.every((p) => p.flags.includes('too_few_samples'))).toBe(true);
    expect(steady.out.every((p) => p.flags.includes('partial_visit'))).toBe(true);
    expect(variable.out.some((p) => p.paired.nPairs > 0 && Math.abs(p.paired.z) >= 5)).toBe(true);
    for (const p of steady.out) {
      expect(Number.isInteger(p.paired.nPairs)).toBe(true);
      if (p.paired.nPairs > 0) expect(Math.abs(p.paired.z)).toBeLessThan(3);
    }
    expect(steady.out.some((p) => p.paired.nPairs > 0)).toBe(true);
    expect((await det2('barnards-star')).out.some((p) => p.flags.includes('saturated'))).toBe(true);
  });

  it('builds a cached preview', async () => {
    for (const t of listCached()) {
      const pv = await loadCachedPreview(t.slug);
      expect(pv.defaultDetector).toBe(t.slug === 'wise-0855' ? 6 : 2);
      expect(pv.movie.detector).toBe(pv.defaultDetector);
      expect(pv.movie.frames.length).toBeGreaterThanOrEqual(3);
      expect(pv.visits).toHaveLength(pv.movie.frames.length);
      expect(pv.detectors).toHaveLength(6);
      expect(pv.totalBytes).toBe(pv.detectors.reduce((s, d) => s + d.bytes, 0));
      expect(pv.differences.length).toBeGreaterThan(0);
      for (const d of pv.differences) {
        expect(d.visitA).toBeLessThan(d.visitB);
        expect(d.image.method).toBe('paired-stack');
        expect(typeof d.image.nPairs).toBe('number');
      }
      for (const pick of [pv.pairs.year, pv.pairs.halfYear]) {
        if (pick) {
          expect(pick.frames).toHaveLength(2);
          expect(pick.frames[0].exposure.mjd).toBeLessThanOrEqual(pick.frames[1].exposure.mjd);
          expect(pick.gapDays).toBeGreaterThan(100);
        }
      }
    }
    const b = await loadCachedPreview('barnards-star');
    expect(b.pairs.year?.matched).toBe(true);
    expect(b.pairs.halfYear?.matched).toBe(false);
    expect(b.movie.frames.some((f) => (f.saturated?.length ?? 0) > 0)).toBe(true);
    expect(b.detectors[5].bytes).toBe(0);
    expect(b.detectors[1].bytes).toBeGreaterThan(0);
  });

  it('simulates transfer bytes for previews and detectors', async () => {
    const c = await loadCached('rw-aur');
    const prog: Progress[] = [];
    const pv = await previewFromCached(c, { onProgress: (p) => prog.push(p) });
    expect(pv.target).toBe(c.target);
    expect(prog[prog.length - 1].bytes).toBe(250_000);
    const prog2: Progress[] = [];
    const det = await detectorFromCached(c, 3, { onProgress: (p) => prog2.push(p) });
    expect(prog2[prog2.length - 1].bytes).toBe(850_000);
    expect(det.frames.every((f) => f.exposure.detector === 3)).toBe(true);
    expect(det.exposures).toHaveLength(det.frames.length);
    const viaSlug = await loadCachedDetector('rw-aur', 4);
    expect(viaSlug.exposures.every((e) => e.detector === 4)).toBe(true);
  });

  it('pairs exposures by smallest wavelength gap, each used once', async () => {
    const c = await loadCached('barnards-star');
    const year = visitDifference(c.frames, 2, 0, 2);
    expect(year.method).toBe('paired-stack');
    expect(year.nPairs).toBeGreaterThan(0);
    expect(year.wavelengthMatched).toBe(true);
    const ids = new Set<string>();
    const idsB = new Set<string>();
    const byId = new Map(c.frames.map((f) => [f.exposure.id, f.exposure]));
    for (const p of year.pairs) {
      expect(ids.has(p.a)).toBe(false);
      expect(idsB.has(p.b)).toBe(false);
      ids.add(p.a);
      idsB.add(p.b);
      const a = byId.get(p.a)!;
      const b = byId.get(p.b)!;
      const gap = Math.abs((a.wavelengthAtTarget as number) - (b.wavelengthAtTarget as number));
      expect(gap).toBeLessThanOrEqual(0.5 * ((a.bandwidthAtTarget as number) + (b.bandwidthAtTarget as number)) + 1e-12);
      expect(p.wavelengthGapUm).toBeCloseTo(gap, 9);
    }
    const sorted = year.pairs.map((p) => p.wavelengthGapUm);
    expect(sorted).toEqual([...sorted].sort((x, y) => x - y));
    expect(year.nUnpairedA + year.nPairs).toBe(c.frames.filter((f) => f.exposure.detector === 2 && f.exposure.visitIndex === 0).length);

    const half = visitDifference(c.frames, 2, 0, 1);
    expect(half.nPairs).toBe(0);
    expect(half.wavelengthMatched).toBe(false);
    expect(half.pairs).toHaveLength(0);

    const a = c.frames.filter((f) => f.exposure.detector === 2 && f.exposure.visitIndex === 0);
    expect(() => pairedDifference([], a)).toThrowError(expect.objectContaining({ code: 'BAD_INPUT' }));

    const m = buildMovie(c.frames, 'visit-stack', 2, c.target);
    const naive = asNaiveStack(difference(m.frames[0], m.frames[2]));
    expect(naive.method).toBe('naive-stack');
    expect(asSingle(difference(m.frames[0], m.frames[2])).method).toBe('single');
    expect(difference(m.frames[0], m.frames[2]).method).toBeDefined();
  });

  it('returns cone searches', async () => {
    const c = await loadCached('rw-aur');
    const gaia = await gaiaCone(c.grid.ra0, c.grid.dec0, 200);
    const wise = await wiseCone(c.grid.ra0, c.grid.dec0, 200);
    expect(gaia.length).toBeGreaterThan(3);
    expect(wise.length).toBeGreaterThan(3);
  });
});
