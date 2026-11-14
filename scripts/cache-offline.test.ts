// Offline check of public/cache (format 'wp-cache-2'): loads every present target with fetch
// replaced by a disk reader. Any other URL throws. Skips cleanly when public/cache is missing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCached, loadCachedDetector, loadCachedPreview, loadCachedStars } from '../src/lib/spherex/cache';
import type { CacheIndexV2, CachedPreview } from '../src/lib/spherex/cache';
import { buildMovie, difference } from '../src/lib/spherex/movie';
import type { CachedSlug, CachedTarget } from '../src/lib/spherex/types';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'cache');
const ALL: CachedSlug[] = ['barnards-star', 'eps-indi-b', 'wise-0855', 'rw-aur', 'r-dra'];
const present = ALL.filter((s) => existsSync(join(CACHE_DIR, s, 'index.json')));

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const m = /^\/cache\/([a-z0-9-]+)\/([a-z0-9.-]+)$/.exec(url);
    if (!m) throw new Error(`network access not allowed: ${url}`);
    const path = join(CACHE_DIR, m[1], m[2]);
    if (!existsSync(path)) return new Response('missing', { status: 404 });
    return new Response(readFileSync(path), { status: 200 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function hasFinite(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) return true;
  return false;
}

describe.skipIf(present.length === 0)('public/cache', () => {
  it('has all five targets in format 2', () => {
    expect(present).toEqual(ALL);
  });
});

describe.each(present)('cache %s', (slug) => {
  const idx = (): CacheIndexV2 => JSON.parse(readFileSync(join(CACHE_DIR, slug, 'index.json'), 'utf8')) as CacheIndexV2;
  let p: CachedPreview;
  let c: CachedTarget;
  beforeAll(async () => {
    p = await loadCachedPreview(slug);
    c = await loadCached(slug);
  }, 60000);

  it('lists only files that exist, with the stated sizes', () => {
    const i = idx();
    const refs = [i.preview, i.stars, ...i.detectorFiles.flatMap((d) => [d.exposures, d.frames])];
    for (const r of refs) {
      expect(r.file).toMatch(/\.[0-9a-f]{8}\.(bin|json)$/);
      expect(readFileSync(join(CACHE_DIR, slug, r.file)).length).toBe(r.bytes);
    }
    expect(existsSync(join(CACHE_DIR, slug, 'manifest.json'))).toBe(false);
    expect(existsSync(join(CACHE_DIR, slug, 'frames.bin'))).toBe(false);
  });

  it('preview: stacked movie, at least one pair, small', () => {
    expect(p.movie.frames.length).toBeGreaterThanOrEqual(2);
    expect(p.movie.detector).toBe(p.defaultDetector);
    for (const m of p.movie.frames) expect(hasFinite(m.pixels)).toBe(true);
    const pair = p.pairs.year ?? p.pairs.halfYear;
    expect(pair).not.toBeNull();
    expect(pair!.frames.length).toBe(2);
    expect(pair!.gapDays).toBeGreaterThan(100);
    expect(p.detectors.length).toBeGreaterThan(0);
    expect(p.gaia.length + p.wise.length).toBeGreaterThan(0);
    // index + preview + stars stay within the first-view budget
    expect(p.totalBytes.preview).toBeLessThanOrEqual(250 * 1000);
  });

  it('every detector loads; loadCached has the sum of their frames', async () => {
    let sum = 0;
    for (const d of idx().detectorFiles) {
      const r = await loadCachedDetector(slug, d.detector);
      expect(r.frames.length).toBe(d.nFrames);
      expect(r.exposures.length).toBe(d.nFrames);
      sum += r.frames.length;
    }
    expect(c.frames.length).toBe(sum);
    expect(c.exposures.length).toBe(sum);
    expect(c.frames.some((f) => hasFinite(f.pixels))).toBe(true);
    for (const f of c.frames) expect(f.exposure.wavelengthAtTarget).not.toBeNull();
  }, 60000);

  it('full star lists load and the preview carries the first-view subset', async () => {
    const i = idx();
    const st = await loadCachedStars(slug);
    expect(st.gaia.length).toBe(i.stars.gaia);
    expect(st.wise.length).toBe(i.stars.wise);
    expect(c.gaia.length).toBe(i.stars.gaia);
    expect(c.wise.length).toBe(i.stars.wise);
    expect(p.gaia.length).toBe(i.stars.gaiaShown);
    expect(p.wise.length).toBe(i.stars.wiseShown);
    expect(p.gaia.length).toBeLessThanOrEqual(i.stars.gaia);
    for (let k = 1; k < st.gaia.length; k++) expect(st.gaia[k].gmag >= st.gaia[k - 1].gmag || Number.isNaN(st.gaia[k].gmag)).toBe(true);
  });

  it('preview movie matches a rebuild from the detector frames', () => {
    const d = p.defaultDetector;
    const m = buildMovie(c.frames, 'visit-stack', d, c.target);
    expect(m.frames.length).toBe(p.movie.frames.length);
    for (let k = 0; k < m.frames.length; k++) {
      expect(m.frames[k].exposureIds).toEqual(p.movie.frames[k].exposureIds);
      for (let j = 0; j < m.frames[k].pixels.length; j++) {
        const a = m.frames[k].pixels[j];
        const b = p.movie.frames[k].pixels[j];
        if (Number.isNaN(a)) { expect(Number.isNaN(b)).toBe(true); continue; }
        expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.abs(a) * 2 ** -11 + 2 ** -24);
      }
    }
    const diff = difference(p.movie.frames[0], p.movie.frames[p.movie.frames.length - 1]);
    expect(hasFinite(diff.pixels)).toBe(true);
  });

  it('pair frames equal the frames of loadCached', () => {
    for (const pair of [p.pairs.year, p.pairs.halfYear]) {
      if (!pair) continue;
      for (const f of pair.frames) {
        const o = c.frames.find((x) => x.exposure.id === f.exposure.id)!;
        expect(o).toBeDefined();
        expect(Array.from(f.pixels)).toEqual(Array.from(o.pixels));
        expect(Array.from(f.variance)).toEqual(Array.from(o.variance));
        expect(Array.from(f.flags)).toEqual(Array.from(o.flags));
      }
    }
  });

  if (slug === 'barnards-star') {
    it('target moves north at about 1.65 px/yr', () => {
      const m = p.movie;
      const a = m.frames[0];
      const b = m.frames[m.frames.length - 1];
      const years = (b.mjd - a.mjd) / 365.25;
      expect(years).toBeGreaterThan(0.2);
      const dy = (a.targetXY as [number, number])[1] - (b.targetXY as [number, number])[1]; // north = row decreases
      const rate = dy / years;
      console.log(`barnard motion: ${years.toFixed(3)} yr, north ${dy.toFixed(3)} px (${rate.toFixed(3)} px/yr)`);
      expect(rate).toBeGreaterThan(1.65 * 0.75);
      expect(rate).toBeLessThan(1.65 * 1.25);
    });
  }
});
