// Offline check of public/cache: loads every present target through loadCached with fetch
// replaced by a disk reader. Any other URL throws.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCached } from '../src/lib/spherex/cache';
import { buildMovie, difference } from '../src/lib/spherex/movie';
import type { CachedSlug, CachedTarget, Detector } from '../src/lib/spherex/types';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'cache');
const ALL: CachedSlug[] = ['barnards-star', 'eps-indi-b', 'wise-0855', 'rw-aur', 'r-dra'];
const present = ALL.filter((s) => existsSync(join(CACHE_DIR, s, 'manifest.json')) && existsSync(join(CACHE_DIR, s, 'frames.bin')));

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const m = /^\/cache\/([a-z0-9-]+)\/(manifest\.json|frames\.bin)$/.exec(url);
    if (!m) throw new Error(`network access not allowed: ${url}`);
    const buf = readFileSync(join(CACHE_DIR, m[1], m[2]));
    return new Response(buf, { status: 200 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function hasFinite(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) return true;
  return false;
}

function detectorWithTwoVisits(c: CachedTarget): Detector | null {
  for (const d of [1, 2, 3, 4, 5, 6] as Detector[]) {
    const v = new Set(c.frames.filter((f) => f.exposure.detector === d).map((f) => f.exposure.visitIndex));
    if (v.size >= 2) {
      const m = buildMovie(c.frames, 'visit-stack', d, c.target);
      if (m.frames.length >= 2) return d;
    }
  }
  return null;
}

it('has at least one cached target on disk', () => {
  expect(present.length).toBeGreaterThan(0);
});

describe.each(present)('cache %s', (slug) => {
  let c: CachedTarget;
  beforeAll(async () => {
    c = await loadCached(slug);
  });

  it('decodes with consistent frame count and finite pixels', () => {
    const manifest = JSON.parse(readFileSync(join(CACHE_DIR, slug, 'manifest.json'), 'utf8'));
    expect(c.frames.length).toBe(manifest.layout.nFrames);
    expect(c.frames.length).toBeGreaterThan(0);
    expect(c.frames.some((f) => hasFinite(f.pixels))).toBe(true);
    for (const f of c.frames) expect(f.exposure.wavelengthAtTarget).not.toBeNull();
  });

  it('builds a visit-stack movie and a finite difference', () => {
    const d = detectorWithTwoVisits(c);
    expect(d).not.toBeNull();
    const m = buildMovie(c.frames, 'visit-stack', d as Detector, c.target);
    expect(m.frames.length).toBeGreaterThanOrEqual(2);
    const diff = difference(m.frames[0], m.frames[m.frames.length - 1]);
    expect(hasFinite(diff.pixels)).toBe(true);
  });

  if (slug === 'barnards-star') {
    it('target moves north at about 1.65 px/yr', () => {
      const d = detectorWithTwoVisits(c) as Detector;
      const m = buildMovie(c.frames, 'visit-stack', d, c.target);
      const a = m.frames[0];
      const b = m.frames[m.frames.length - 1];
      const years = (b.mjd - a.mjd) / 365.25;
      expect(years).toBeGreaterThan(0.2);
      const dy = (a.targetXY as [number, number])[1] - (b.targetXY as [number, number])[1]; // north = row decreases
      const dx = (b.targetXY as [number, number])[0] - (a.targetXY as [number, number])[0];
      const rate = dy / years;
      console.log(`barnard motion: ${years.toFixed(3)} yr, north ${dy.toFixed(3)} px (${rate.toFixed(3)} px/yr), x change ${dx.toFixed(3)} px`);
      expect(rate).toBeGreaterThan(1.65 * 0.75);
      expect(rate).toBeLessThan(1.65 * 1.25);
    });
  }
});
