import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  annotateWavelengths,
  ORIENTATION_TEST_STAR,
  buildMovie,
  difference,
  findExposures,
  gaiaCone,
  gridToWorld,
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
import type { Grid, Progress } from './types';

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
    expect(movie.frames.length).toBeGreaterThanOrEqual(4);
    expect(movie.stretch.lo).toBeLessThan(movie.stretch.hi);
    const first = movie.frames[0].targetXY as [number, number];
    const last = movie.frames[movie.frames.length - 1].targetXY as [number, number];
    expect(last[1]).toBeLessThan(first[1]);
    expect(first[1] - last[1]).toBeGreaterThan(1.5);
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

  it('leaves an empty detector for at least one target', async () => {
    const c = await loadCached('barnards-star');
    const s = summarize(c.exposures);
    expect(s).toHaveLength(6);
    expect(s.find((d) => d.detector === 6)?.count).toBe(0);
    expect(s.find((d) => d.detector === 2)?.visits.length).toBeGreaterThanOrEqual(4);
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
      expect(c.frames.length).toBeGreaterThan(40);
      expect(performance.now() - t0).toBeLessThan(150);
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

  it('returns cone searches', async () => {
    const c = await loadCached('rw-aur');
    const gaia = await gaiaCone(c.grid.ra0, c.grid.dec0, 200);
    const wise = await wiseCone(c.grid.ra0, c.grid.dec0, 200);
    expect(gaia.length).toBeGreaterThan(3);
    expect(wise.length).toBeGreaterThan(3);
  });
});
