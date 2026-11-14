// Offline check of the per-star readouts in public/cache: loadCachedReadouts with fetch replaced by
// a disk reader (any other URL throws). A target is skipped cleanly when its index.json or its
// `readouts` entry is missing.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCachedReadouts, READOUTS_FORMAT } from '../src/lib/spherex/readouts';
import type { ReadoutsRef } from '../src/lib/spherex/readouts';
import { SpherexError } from '../src/lib/spherex/types';
import type { CachedSlug } from '../src/lib/spherex/types';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'cache');
const ALL: CachedSlug[] = ['barnards-star', 'eps-indi-b', 'wise-0855', 'rw-aur', 'r-dra', 'v391-oph'];

function readIndex(slug: CachedSlug): { readouts?: ReadoutsRef } | null {
  const p = join(CACHE_DIR, slug, 'index.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as { readouts?: ReadoutsRef };
}

const diskFetch = (async (input: unknown) => {
  const url = String(input);
  const m = /^\/cache\/([a-z0-9-]+)\/([a-z0-9.-]+)$/.exec(url);
  if (!m) throw new Error(`network access not allowed: ${url}`);
  const path = join(CACHE_DIR, m[1], m[2]);
  if (!existsSync(path)) return new Response('missing', { status: 404 });
  return new Response(readFileSync(path), { status: 200 });
}) as typeof fetch;

describe.each(ALL)('readouts %s', (slug) => {
  const idx = readIndex(slug);
  const ref = idx?.readouts;

  describe.skipIf(!ref)('present', () => {
    it('loads and matches the index entry', async () => {
      const r = await loadCachedReadouts(slug, { fetchFn: diskFetch });
      const entry = ref as ReadoutsRef;
      expect(r.format).toBe(READOUTS_FORMAT);
      expect(r.slug).toBe(slug);
      expect(r.detector).toBe(entry.detector);
      expect(readFileSync(join(CACHE_DIR, slug, entry.file)).length).toBe(entry.bytes);
      expect(entry.file).toMatch(/^readouts\.d[1-6]\.[0-9a-f]{8}\.json$/);
      expect(entry.bytes).toBeLessThan(150 * 1024);
      expect(r.stars.reduce((n, s) => n + s.pairs.length, 0)).toBe(entry.count);
      expect(r.stars.length).toBeGreaterThan(0);
      expect(r.stars[0].isTarget).toBe(true);
      expect(r.stars.filter((s) => s.isTarget).length).toBe(1);
      expect(r.stars.length).toBeLessThanOrEqual(41);
    });

    it('has field pairs and a variable flag per star', async () => {
      const r = await loadCachedReadouts(slug, { fetchFn: diskFetch });
      expect(Array.isArray(r.fieldPairs)).toBe(true);
      const keys = new Set(r.stars.flatMap((s) => s.pairs.map((p) => `${p.a}:${p.b}`)));
      expect(r.fieldPairs.length).toBe(keys.size);
      for (const f of r.fieldPairs) {
        expect(f.a).toBeLessThan(f.b);
        expect(f.fieldChangedFraction).toBeGreaterThanOrEqual(0);
        expect(f.fieldChangedFraction).toBeLessThanOrEqual(1);
        expect(f.judged).toBe(f.nField >= 10);
        if (f.judged) expect(f.fieldReliable).toBe(f.fieldChangedFraction <= 0.1);
        else { expect(f.fieldReliable).toBe(true); expect(f.reason).toBe('too few stars to judge the field'); }
        expect(f.nField).toBeGreaterThanOrEqual(0);
        for (const s of r.stars) {
          for (const p of s.pairs.filter((q) => q.a === f.a && q.b === f.b)) {
            if (!f.fieldReliable) expect(p.unreliableReasons).toContain('field offset');
          }
        }
      }
      for (const s of r.stars) expect([true, false, null]).toContain(s.variable);
    });

    it('has consistent pairs', async () => {
      const r = await loadCachedReadouts(slug, { fetchFn: diskFetch });
      const visits = new Map(r.visits.map((v) => [v.visit, v]));
      for (const s of r.stars) {
        expect(typeof s.id).toBe('string');
        for (const p of s.pairs) {
          expect(visits.has(p.a) && visits.has(p.b)).toBe(true);
          expect(p.a).toBeLessThan(p.b);
          expect(p.tA).toBeLessThan(p.tB);
          expect(p.nA).toBeGreaterThanOrEqual(8);
          expect(p.nB).toBeGreaterThanOrEqual(8);
          expect(['changed', 'no significant change', 'no result']).toContain(p.verdict);
          if (p.verdict === 'no result') {
            expect(p.w.length).toBe(0);
            expect(p.z).toBeNull();
          } else {
            expect(p.w.length).toBeGreaterThan(0);
            expect(Number.isFinite(p.z as number)).toBe(true);
            expect((p.verdict === 'changed') === (Math.abs(p.z as number) >= 3)).toBe(true);
          }
          expect(typeof p.reliable).toBe('boolean');
          expect(Array.isArray(p.unreliableReasons)).toBe(true);
          expect(p.reliable).toBe(p.unreliableReasons.length === 0);
          if (p.flags.some((f) => f === 'saturated' || f === 'blended' || f === 'partial_visit')) {
            expect(p.reliable).toBe(false);
          }
          if (p.w.length < 2) expect(p.unreliableReasons).toContain('fewer than 2 wavelengths');
          if (s.brightNeighbour) expect(p.reliable).toBe(false);
        }
      }
    });
  });

  describe.skipIf(!idx || !!ref)('absent', () => {
    it('throws NOT_FOUND when the index has no readouts entry', async () => {
      await expect(loadCachedReadouts(slug, { fetchFn: diskFetch })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(loadCachedReadouts(slug, { fetchFn: diskFetch })).rejects.toBeInstanceOf(SpherexError);
    });
  });
});

describe('readouts by detector (v391-oph)', () => {
  const idx = readIndex('v391-oph') as { readouts?: ReadoutsRef; readoutsByDetector?: Record<string, ReadoutsRef> } | null;
  describe.skipIf(!idx?.readoutsByDetector)('present', () => {
    it.each([1, 2, 4] as const)('loads detector %i', async (d) => {
      const ref = idx!.readoutsByDetector![String(d)];
      const r = await loadCachedReadouts('v391-oph', { fetchFn: diskFetch, detector: d });
      expect(r.detector).toBe(d);
      expect(ref.detector).toBe(d);
      expect(readFileSync(join(CACHE_DIR, 'v391-oph', ref.file)).length).toBe(ref.bytes);
      expect(ref.bytes).toBeLessThan(150 * 1024);
      expect(r.stars.some((s) => s.id === '4472831551114789632')).toBe(true);
    });
    it('the default entry is detector 2 and loads without a detector argument', async () => {
      expect(idx!.readouts!.detector).toBe(2);
      expect(idx!.readouts).toEqual(idx!.readoutsByDetector!['2']);
      expect((await loadCachedReadouts('v391-oph', { fetchFn: diskFetch })).detector).toBe(2);
    });
    it('throws NOT_FOUND for a detector without readouts', async () => {
      await expect(loadCachedReadouts('v391-oph', { fetchFn: diskFetch, detector: 3 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});

describe('readouts loader errors', () => {
  it('rejects an unknown slug', async () => {
    await expect(loadCachedReadouts('nope' as CachedSlug, { fetchFn: diskFetch })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('refuses URLs outside the cache', async () => {
    await expect(loadCachedReadouts('barnards-star', { baseUrl: 'https://example.invalid/', fetchFn: diskFetch })).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});
