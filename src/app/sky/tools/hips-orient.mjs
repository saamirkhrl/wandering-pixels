import { decodePng } from './hips-png.mjs';
import { nestCell, radecToXyz, vec2fxy, vec2nest, vecToTilePixel } from '../healpix.ts';

const BASE = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
const W = 512;
const EPOCH = 2025.9; // middle of t_min..t_max in properties (MJD 60790..61174)
const ORDERS = [3, 5];
const FRAME = Number(process.env.HIPS_FRAME ?? 101);
const WAVE = { 0: 0.753, 90: 4.539, 101: 4.988 };

// J2000 positions (Hipparcos), proper motion pmRA*cos(dec), pmDec in mas/yr.
const STARS = [
  { name: 'Vega', ra: 279.2347, dec: 38.7837, pmra: 200.94, pmdec: 286.23 },
  { name: 'Sirius', ra: 101.2872, dec: -16.7161, pmra: -546.01, pmdec: -1223.07 },
  { name: 'Polaris', ra: 37.9546, dec: 89.2641, pmra: 44.48, pmdec: -11.85 },
  { name: 'Canopus', ra: 95.988, dec: -52.6957, pmra: 19.93, pmdec: 23.24 },
  { name: 'Betelgeuse', ra: 88.7929, dec: 7.4071, pmra: 27.54, pmdec: 11.3 },
  { name: 'Achernar', ra: 24.4285, dec: -57.2368, pmra: 87.0, pmdec: -38.24 },
];

// The 8 symmetries, mapping local face coordinates (lx, ly in 0..1 inside the tile cell, the
// nested sub-pixel is ix = floor(lx * W), iy = floor(ly * W)) to image (col, row) / W.
const CANDIDATES = {
  'col=lx,row=ly': (lx, ly) => [lx, ly],
  'col=lx,row=1-ly': (lx, ly) => [lx, 1 - ly],
  'col=1-lx,row=ly': (lx, ly) => [1 - lx, ly],
  'col=1-lx,row=1-ly': (lx, ly) => [1 - lx, 1 - ly],
  'col=ly,row=lx': (lx, ly) => [ly, lx],
  'col=ly,row=1-lx': (lx, ly) => [ly, 1 - lx],
  'col=1-ly,row=lx': (lx, ly) => [1 - ly, lx],
  'col=1-ly,row=1-lx': (lx, ly) => [1 - ly, 1 - lx],
};

function tileUrl(order, pix, frame) {
  const dir = Math.floor(pix / 10000) * 10000;
  return `${BASE}/Norder${order}/Dir${dir}/Npix${pix}${frame ? `_${frame}` : ''}.png`;
}

const cache = new Map();
async function getTile(order, pix) {
  const url = tileUrl(order, pix, FRAME);
  if (!cache.has(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const img = decodePng(Buffer.from(await res.arrayBuffer()));
    img.median = Float32Array.from(img.lum).sort()[img.lum.length >> 1];
    cache.set(url, img);
  }
  return cache.get(url);
}

// Centroid of the bright blob in a square grid g (size n x n, centre at (n-1)/2): pixels above
// half way between the grid maximum and the background, weighted by their excess.
function blob(g, n, bg) {
  let max = -Infinity;
  for (const v of g) if (Number.isFinite(v)) max = Math.max(max, v);
  if (!(max > bg)) return null;
  const thr = bg + 0.5 * (max - bg);
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const v = g[j * n + i];
      if (!(v >= thr)) continue;
      const w = v - thr + 1;
      sw += w;
      sx += w * i;
      sy += w * j;
    }
  return { x: sx / sw - (n - 1) / 2, y: sy / sw - (n - 1) / 2, contrast: max - bg };
}

// Home-tile window around (col, row), radius R, for the candidate comparison.
function windowGrid(img, col, row, R) {
  const n = 2 * R + 1;
  const g = new Float32Array(n * n).fill(NaN);
  const c0 = Math.floor(col) - R;
  const r0 = Math.floor(row) - R;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const c = c0 + i;
      const r = r0 + j;
      if (c >= 0 && r >= 0 && c < W && r < W) g[j * n + i] = img.lum[r * W + c];
    }
  return { g, n, c0, r0 };
}

function pixelRad(order) {
  return Math.sqrt((4 * Math.PI) / (12 * 4 ** (order + 9)));
}

function starXyz(s) {
  const dt = EPOCH - 2000;
  const dec = s.dec + (s.pmdec * dt) / 3.6e6;
  const ra = s.ra + (s.pmra * dt) / 3.6e6 / Math.cos((s.dec * Math.PI) / 180);
  return radecToXyz(ra, dec);
}

function norm(v) {
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// Tangent-plane resample around p, radius R samples, step = one tile pixel at `order`.
async function tangentGrid(order, p, R) {
  const s = pixelRad(order);
  const east = norm(cross([0, 0, 1], p).some((c) => Math.abs(c) > 1e-9) ? cross([0, 0, 1], p) : [0, 1, 0]);
  const north = cross(p, east);
  const n = 2 * R + 1;
  const dirs = [];
  const tiles = new Set();
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = (i - R) * s;
      const b = (j - R) * s;
      const d = [0, 1, 2].map((k) => p[k] + a * east[k] + b * north[k]);
      const pix = vec2nest(order, ...d);
      tiles.add(pix);
      dirs.push({ d, pix });
    }
  const imgs = new Map();
  for (const pix of tiles) imgs.set(pix, await getTile(order, pix));
  const g = new Float32Array(n * n);
  const bgs = [];
  dirs.forEach(({ d, pix }, k) => {
    const img = imgs.get(pix);
    const t = vecToTilePixel(order, pix, ...d, W);
    const c = Math.min(W - 1, Math.max(0, Math.floor(t.col)));
    const r = Math.min(W - 1, Math.max(0, Math.floor(t.row)));
    g[k] = img.lum[r * W + c];
  });
  for (const img of imgs.values()) bgs.push(img.median);
  return { g, n, s, east, north, tiles: tiles.size, bg: Math.max(...bgs) };
}

// Checks the HiPS tile pixel layout against bright stars.
// 1. For each star and order it predicts the image column/row inside its tile under each of the
//    8 square symmetries of the tile and measures the bright-blob centroid near each prediction
//    (home tile only), to show which layout is the right one.
// 2. For the layout adopted in healpix.ts (vecToTilePixel) it resamples the sky on a small
//    tangent-plane grid around the star at the tile pixel scale, pulling every sample from
//    whichever tile holds it (so stars on a tile edge are measured whole), and reports the offset
//    of the measured centroid from the catalogue position.
// Run: node src/app/sky/tools/hips-orient.mjs   (network access to irsa.ipac.caltech.edu)
// HIPS_FRAME=<n> picks the cube frame (default 101, 4.988 um, where the bright stars are far
// less saturated and masked than at 0.753 um).
const rows = [];
const score = Object.fromEntries(Object.keys(CANDIDATES).map((k) => [k, []]));
for (const st of STARS) {
  const p = starXyz(st);
  for (const order of ORDERS) {
    const R = order >= 5 ? 16 : 8;
    const pix = vec2nest(order, ...p);
    const img = await getTile(order, pix);
    const f = vec2fxy(...p);
    const cell = nestCell(order, pix);
    const lx = (f.x - cell.x0) / cell.size;
    const ly = (f.y - cell.y0) / cell.size;
    for (const [k, fn] of Object.entries(CANDIDATES)) {
      const [u, v] = fn(lx, ly);
      const w = windowGrid(img, u * W, v * W, R);
      const b = blob(w.g, w.n, img.median);
      const off = b ? Math.hypot(w.c0 + R + 0.5 + b.x - u * W, w.r0 + R + 0.5 + b.y - v * W) : R;
      score[k].push(Math.min(off, R));
    }
    const pred = vecToTilePixel(order, pix, ...p, W);
    const tg = await tangentGrid(order, p, R);
    const b = blob(tg.g, tg.n, tg.bg);
    let meas = null;
    let off = Infinity;
    if (b) {
      const d = [0, 1, 2].map((k) => p[k] + b.x * tg.s * tg.east[k] + b.y * tg.s * tg.north[k]);
      const t = vecToTilePixel(order, pix, ...d, W);
      meas = t ?? { col: NaN, row: NaN };
      off = Math.hypot(b.x, b.y);
    }
    rows.push({ star: st.name, order, pix, pred, meas, off, arcsec: (off * tg.s * 180 * 3600) / Math.PI, tiles: tg.tiles, contrast: b ? b.contrast : NaN });
  }
}

console.log(`Frame ${FRAME}${WAVE[FRAME] ? ` (${WAVE[FRAME]} um)` : ''}, star positions at epoch ${EPOCH}.`);
console.log('\nCandidate layouts, mean / max offset in tile px over all stars and orders (home tile, capped at window radius):');
for (const [k, list] of Object.entries(score)) {
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  console.log(`  ${k.padEnd(20)} mean ${mean.toFixed(2).padStart(6)}  max ${Math.max(...list).toFixed(2).padStart(6)}`);
}
console.log('\nAdopted layout (healpix.ts vecToTilePixel: col = ly * 512, row = lx * 512), tangent-plane centroid:');
const pad = (v, n) => String(v).padStart(n);
console.log('star        order   Npix   predicted (col,row)   peak (col,row)      offset px  arcsec  tiles  contrast');
let worst = 0;
for (const r of rows) {
  worst = Math.max(worst, r.off);
  const m = r.meas ?? { col: NaN, row: NaN };
  console.log(
    `${r.star.padEnd(11)} ${pad(r.order, 5)} ${pad(r.pix, 6)}   ${pad(r.pred.col.toFixed(1), 7)},${pad(r.pred.row.toFixed(1), 7)}     ${pad(m.col.toFixed(1), 7)},${pad(m.row.toFixed(1), 7)}   ${pad(r.off.toFixed(2), 8)}  ${pad(r.arcsec.toFixed(1), 6)}  ${pad(r.tiles, 5)}  ${pad(r.contrast.toFixed(0), 8)}`,
  );
}
console.log(`\nworst offset ${worst.toFixed(2)} px: ${worst <= 2 ? 'PASS' : 'FAIL'} (limit 2 px)`);
if (!(worst <= 2)) process.exitCode = 1;
