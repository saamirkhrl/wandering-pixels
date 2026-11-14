// Contact sheets for a quick look at the cache. Writes PNGs OUTSIDE the repo.
//
//   npx -y vite-node scripts/contact-sheet.ts <slug|all>
//
// Rows: detector 2 and detector 6. Each tile is a visit-stack frame (asinh stretch, 4x nearest),
// then the first-last difference (symmetric stretch, grey zero). Rings mark each frame's targetXY.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { decodeCache } from '../src/lib/spherex/cache';
import type { CacheManifest } from '../src/lib/spherex/cache';
import { buildMovie, difference } from '../src/lib/spherex/movie';
import type { CachedSlug, Detector, MovieFrame } from '../src/lib/spherex/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLUGS: CachedSlug[] = ['barnards-star', 'eps-indi-b', 'wise-0855', 'rw-aur', 'r-dra'];
const SAMPLES = process.env.WP_SAMPLES_DIR ?? resolve(ROOT, '..', 'research', 'samples');
const OUT_DIR = join(SAMPLES, 'cache-check');
const UP = 4;
const GAP = 4;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0)),
  ]);
}

type Rgb = [number, number, number];

function drawTile(
  img: Uint8Array, imgW: number, ox: number, oy: number,
  w: number, h: number, shade: (i: number) => number | null, marks: Array<{ xy: [number, number] | null; color: Rgb }>,
): void {
  for (let y = 0; y < h * UP; y++) {
    for (let x = 0; x < w * UP; x++) {
      const g = shade(Math.floor(y / UP) * w + Math.floor(x / UP));
      const v = g === null ? 64 : g;
      const o = ((oy + y) * imgW + ox + x) * 3;
      img[o] = v; img[o + 1] = v; img[o + 2] = v;
    }
  }
  for (const m of marks) {
    if (!m.xy || !Number.isFinite(m.xy[0]) || !Number.isFinite(m.xy[1])) continue;
    const cx = Math.round((m.xy[0] + 0.5) * UP);
    const cy = Math.round((m.xy[1] + 0.5) * UP);
    const R = 12;
    for (let a = 0; a < 360; a += 3) {
      const px = Math.round(cx + R * Math.cos((a * Math.PI) / 180));
      const py = Math.round(cy + R * Math.sin((a * Math.PI) / 180));
      if (px < 0 || py < 0 || px >= w * UP || py >= h * UP) continue;
      const o = ((oy + py) * imgW + ox + px) * 3;
      img[o] = m.color[0]; img[o + 1] = m.color[1]; img[o + 2] = m.color[2];
    }
  }
}

function asinhShade(lo: number, hi: number, px: Float32Array): (i: number) => number | null {
  const soft = (hi - lo) / 10 || 1;
  const norm = Math.asinh((hi - lo) / soft);
  return (i) => {
    const v = px[i];
    if (!Number.isFinite(v)) return null;
    const t = Math.asinh(Math.max(0, v - lo) / soft) / norm;
    return Math.round(255 * Math.min(1, Math.max(0, t)));
  };
}

export function loadFromDisk(slug: CachedSlug) {
  const dir = join(ROOT, 'public', 'cache', slug);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as CacheManifest;
  const bin = new Uint8Array(readFileSync(join(dir, 'frames.bin')));
  return decodeCache(manifest, bin);
}

export function writeSheet(slug: CachedSlug): string | null {
  const c = loadFromDisk(slug);
  const rows: { det: Detector; tiles: MovieFrame[]; stretch: { lo: number; hi: number } }[] = [];
  for (const det of [2, 6] as Detector[]) {
    const m = buildMovie(c.frames, 'visit-stack', det, c.target);
    if (m.frames.length) rows.push({ det, tiles: m.frames, stretch: m.stretch });
  }
  if (rows.length === 0) return null;
  const tw = c.grid.w * UP;
  const th = c.grid.h * UP;
  const cols = Math.max(...rows.map((r) => r.tiles.length)) + 1;
  const W = cols * (tw + GAP) + GAP;
  const H = rows.length * (th + GAP) + GAP;
  const img = new Uint8Array(W * H * 3).fill(20);
  rows.forEach((row, ri) => {
    const oy = GAP + ri * (th + GAP);
    row.tiles.forEach((t, ci) => {
      const ox = GAP + ci * (tw + GAP);
      drawTile(img, W, ox, oy, t.w, t.h, asinhShade(row.stretch.lo, row.stretch.hi, t.pixels), [{ xy: t.targetXY, color: [255, 60, 60] }]);
      console.log(`  ${slug} det ${row.det} col ${ci}: visit ${t.visitIndex} ${t.time} ${t.wavelength.toFixed(3)} um n=${t.nExposures}`);
    });
    if (row.tiles.length >= 2) {
      const a = row.tiles[0];
      const b = row.tiles[row.tiles.length - 1];
      const d = difference(a, b);
      const s = d.stretch.hi || 1;
      const soft = s / 10;
      const norm = Math.asinh(s / soft);
      const ci = row.tiles.length;
      const ox = GAP + ci * (tw + GAP);
      drawTile(img, W, ox, oy, d.w, d.h, (i) => {
        const v = d.pixels[i];
        if (!Number.isFinite(v)) return null;
        const t = Math.asinh(v / soft) / norm;
        return Math.round(128 + 127 * Math.min(1, Math.max(-1, t)));
      }, [{ xy: a.targetXY, color: [255, 60, 60] }, { xy: b.targetXY, color: [60, 200, 255] }]);
      console.log(`  ${slug} det ${row.det} col ${ci}: DIFFERENCE last(${b.time}, ${b.wavelength.toFixed(3)} um) minus first(${a.time}, ${a.wavelength.toFixed(3)} um), n=${a.nExposures}+${b.nExposures}`);
    }
  });
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `${slug}.png`);
  writeFileSync(out, encodePng(W, H, img));
  return out;
}

function main(): void {
  const arg = process.argv[2];
  const todo = arg === 'all' ? SLUGS : SLUGS.filter((s) => s === arg);
  if (todo.length === 0) {
    console.error('usage: vite-node scripts/contact-sheet.ts <slug|all>');
    process.exit(2);
  }
  for (const slug of todo) {
    if (!existsSync(join(ROOT, 'public', 'cache', slug, 'manifest.json'))) {
      console.error(`no cache for ${slug}`);
      continue;
    }
    console.log(`${slug}: rows are detector 2 then detector 6; last column is the first-last difference`);
    console.log(`  wrote ${writeSheet(slug)}`);
  }
}

if (!process.env.VITEST) main();
