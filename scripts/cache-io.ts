// Shared by build-cache.ts and convert-cache.ts: write a format 2 cache directory, and convert a
// format 1 directory to format 2 without re-downloading.
//
// convertOne(slug): decode format 1, re-encode as format 2 (variance codes are copied, not
// re-quantised), write public/cache/<slug>/index.json and the hashed files, remove stale hashed
// files, then verify by loading the files back from disk and comparing every frame with format 1.
// With deleteV1 the old manifest.json and frames.bin are removed after the check passes.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeCache, loadCached, loadCachedDetector, loadCachedPreview } from '../src/lib/spherex/cache';
import type { CacheManifest } from '../src/lib/spherex/cache';
import { encodeCacheV2 } from '../src/lib/spherex/cache-encode';
import { buildMovie } from '../src/lib/spherex/movie';
import type { CachedSlug, Frame } from '../src/lib/spherex/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = join(ROOT, 'public', 'cache');
export const ALL_SLUGS: CachedSlug[] = ['barnards-star', 'eps-indi-b', 'wise-0855', 'rw-aur', 'r-dra', 'v391-oph'];
const HASHED = /\.[0-9a-f]{8}\.(bin|json)$/;

/**
 * Writes the files of one target (index.json last) and removes stale hashed files. Files named
 * readouts.* are kept, and the old index.json `readouts` key is carried over when its file still exists.
 */
export function writeCacheDir(dir: string, files: Record<string, Uint8Array | string>): void {
  mkdirSync(dir, { recursive: true });
  let oldReadouts: unknown;
  try {
    const old = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { readouts?: { file?: unknown } };
    if (old.readouts && typeof old.readouts.file === 'string' && existsSync(join(dir, old.readouts.file))) oldReadouts = old.readouts;
  } catch { /* no old index */ }
  for (const [name, data] of Object.entries(files)) {
    if (name === 'index.json') continue;
    const tmp = join(dir, `${name}.tmp`);
    writeFileSync(tmp, data);
    renameSync(tmp, join(dir, name));
  }
  const tmp = join(dir, 'index.json.tmp');
  let indexData = files['index.json'];
  if (oldReadouts) {
    const text = typeof indexData === 'string' ? indexData : new TextDecoder().decode(indexData);
    indexData = JSON.stringify({ ...JSON.parse(text), readouts: oldReadouts });
  }
  writeFileSync(tmp, indexData);
  renameSync(tmp, join(dir, 'index.json'));
  for (const name of readdirSync(dir)) {
    if (HASHED.test(name) && !(name in files) && !name.startsWith('readouts.')) unlinkSync(join(dir, name));
    else if (name.endsWith('.tmp')) unlinkSync(join(dir, name));
  }
}

function sameArray(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!(x === y || (x !== x && y !== y))) diff++;
  }
  return diff;
}

function diffFrame(a: Frame, b: Frame): number {
  return sameArray(a.pixels, b.pixels) + sameArray(a.variance, b.variance) + sameArray(a.flags, b.flags)
    + (a.coverage === b.coverage ? 0 : 1) + (JSON.stringify(a.exposure) === JSON.stringify(b.exposure) ? 0 : 1);
}

function diskFetch(dir: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const m = /^\/cache\/([a-z0-9-]+)\/(.+)$/.exec(String(url));
    if (!m) throw new Error(`unexpected url ${String(url)}`);
    const path = join(dir, m[1], m[2]);
    if (!existsSync(path)) return new Response('missing', { status: 404 });
    return new Response(readFileSync(path), { status: 200 });
  }) as typeof fetch;
}

export async function convertOne(slug: CachedSlug, deleteV1: boolean): Promise<string> {
  const dir = join(CACHE_DIR, slug);
  const mPath = join(dir, 'manifest.json');
  const bPath = join(dir, 'frames.bin');
  if (!existsSync(mPath) || !existsSync(bPath)) throw new Error(`${slug}: no format 1 files in ${dir}`);
  const manifest = JSON.parse(readFileSync(mPath, 'utf8')) as CacheManifest & { build?: Record<string, unknown> };
  const v1 = decodeCache(manifest, new Uint8Array(readFileSync(bPath)));
  const va = manifest.layout.arrays.find((a) => a.name === 'variance');
  if (!va || va.log2Min === undefined || va.log2Step === undefined) throw new Error(`${slug}: no variance range`);

  const { files, index } = encodeCacheV2({
    ...v1,
    build: { ...(manifest.build ?? {}), convertedFrom: manifest.format, convertedAt: new Date().toISOString() },
    varianceRange: { log2Min: va.log2Min, log2Step: va.log2Step },
  });
  writeCacheDir(dir, files);

  // Verify from disk.
  const fetchFn = diskFetch(CACHE_DIR);
  const v2 = await loadCached(slug, { baseUrl: '/cache/', fetchFn });
  if (v2.frames.length !== v1.frames.length) throw new Error(`${slug}: frame count ${v2.frames.length} vs ${v1.frames.length}`);
  const byId = new Map(v1.frames.map((f) => [f.exposure.id, f]));
  let bad = 0;
  for (const f of v2.frames) {
    const o = byId.get(f.exposure.id);
    if (!o) { bad++; continue; }
    bad += diffFrame(f, o);
  }
  if (bad) throw new Error(`${slug}: ${bad} differing values between format 1 and format 2`);
  const det = await loadCachedDetector(slug, index.defaultDetector, { baseUrl: '/cache/', fetchFn });
  const pv = await loadCachedPreview(slug, { baseUrl: '/cache/', fetchFn });
  const ref = buildMovie(det.frames, 'visit-stack', index.defaultDetector, v1.target);
  if (ref.frames.length !== pv.movie.frames.length) throw new Error(`${slug}: preview movie has ${pv.movie.frames.length} frames, rebuild ${ref.frames.length}`);
  let maxRel = 0;
  for (let k = 0; k < ref.frames.length; k++) {
    const a = ref.frames[k].pixels;
    const b = pv.movie.frames[k].pixels;
    for (let j = 0; j < a.length; j++) {
      if (Number.isNaN(a[j]) !== Number.isNaN(b[j])) throw new Error(`${slug}: NaN mismatch in movie frame ${k}`);
      if (!Number.isNaN(a[j])) maxRel = Math.max(maxRel, Math.abs(a[j] - b[j]) / Math.max(Math.abs(a[j]), 1e-4));
    }
  }
  for (const key of ['year', 'halfYear'] as const) {
    const p = pv.pairs[key];
    if (!p) continue;
    for (const f of p.frames) {
      const o = byId.get(f.exposure.id) as Frame;
      if (diffFrame(f, o) !== 0) throw new Error(`${slug}: pair ${key} frame ${f.exposure.id} differs from format 1`);
    }
  }
  if (deleteV1) {
    unlinkSync(mPath);
    unlinkSync(bPath);
  }
  const sizes = Object.entries(files).map(([n, d]) => `${n}=${typeof d === 'string' ? new TextEncoder().encode(d).length : d.length}`);
  return `${slug}: OK, ${v2.frames.length} frames identical to format 1, movie max rel err ${maxRel.toExponential(2)}, v1 files ${deleteV1 ? 'deleted' : 'kept'}\n  ${sizes.join(' ')}`;
}

