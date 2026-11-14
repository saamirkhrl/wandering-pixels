// Builds the precomputed cache for the five challenge targets.
//
//   npx -y vite-node scripts/build-cache.ts <slug|all>
//
// Output per target: public/cache/<slug>/manifest.json and frames.bin only. The manifest carries
// an extra top-level `build` object (decodeCache and loadCached ignore unknown keys). Raw FITS
// data is only held in memory, never written to disk.
import { mkdirSync, writeFileSync, renameSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHALLENGE_TARGETS } from '../src/lib/spherex/resolve';
import { rowsToExposures as rowsToExposureObjects } from '../src/lib/spherex/search';
import type { ExposureRow } from '../src/lib/spherex/search';
import { loadFrames } from '../src/lib/spherex/frame';
import { makeGrid, positionAt } from '../src/lib/spherex/wcs';
import { encodeCache } from '../src/lib/spherex/cache';
import { bytesTransferred } from '../src/lib/spherex/fits';
import type { CachedSlug, Exposure, Frame, GaiaStar, Target } from '../src/lib/spherex/types';
import type { WiseSource } from '../src/lib/spherex/wise';

// @ts-expect-error plain JS helper modules without type declarations
import { fetchUpstream } from '../api/_lib/http.js';
// @ts-expect-error plain JS helper modules without type declarations
import { COLLECTIONS, buildSiaUrl, parseVotable, queryStatus, rowsToExposures as siaRows, dedupe } from '../api/_lib/sia.js';
// @ts-expect-error plain JS helper modules without type declarations
import { gaiaUrl, parseGaia, wiseUrl, parseWise } from '../api/_lib/upstreams.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'cache');
const MAX_FRAMES = 300;
const MIN_COVERAGE = 0.5;
const BUDGET_BYTES = 30 * 1024 * 1024;
const SLUGS: CachedSlug[] = ['barnards-star', 'eps-indi-b', 'wise-0855', 'rw-aur', 'r-dra'];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function retry<T>(label: string, tries: number, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.warn(`  ${label} attempt ${i + 1}/${tries} failed: ${e instanceof Error ? e.message : String(e)}`);
      await sleep(2000 * (i + 1));
    }
  }
  throw last;
}

// ---- exposures ---------------------------------------------------------------------------------

type Regions = Map<string, number[]>; // exposure id -> polygon corners [ra, dec, ra, dec, ...] (deg)

async function queryCollection(name: string, ra: number, dec: number): Promise<{ rows: ExposureRow[]; regions: Regions }> {
  const res = await fetchUpstream(buildSiaUrl(name, ra, dec, 5000), {
    init: { headers: { Accept: 'application/x-votable+xml, text/xml' } },
    attemptTimeoutMs: 40000,
    budgetMs: 60000,
    maxAttempts: 4,
  });
  if (res.status !== 200) throw new Error(`${name} returned HTTP ${res.status}`);
  const xml: string = await res.text();
  if (queryStatus(xml) === 'ERROR') throw new Error(`${name} reported a query error`);
  const raw = parseVotable(xml) as Array<Record<string, string>>;
  const regions: Regions = new Map();
  for (const r of raw) {
    const det = /D([1-6])$/.exec(r.energy_bandpassname || '');
    if (!r.obs_id || !det || !r.s_region) continue;
    const nums = r.s_region.replace(/^POLYGON\s+\w+\s+/i, '').trim().split(/\s+/).map(Number);
    if (nums.length >= 8 && nums.every(Number.isFinite)) regions.set(`${r.obs_id}D${det[1]}`, nums.slice(0, 8));
  }
  return { rows: siaRows(raw) as ExposureRow[], regions };
}

async function findAll(t: Target): Promise<{ exposures: Exposure[]; regions: Regions }> {
  const all: ExposureRow[] = [];
  const regions: Regions = new Map();
  for (const c of COLLECTIONS as { name: string; required: boolean }[]) {
    try {
      const r = await retry(c.name, 3, () => queryCollection(c.name, t.ra, t.dec));
      all.push(...r.rows);
      for (const [k, v] of r.regions) if (!regions.has(k)) regions.set(k, v);
    } catch (e) {
      if (c.required) throw e;
      console.warn(`  WARNING optional collection ${c.name} failed, continuing without it`);
    }
  }
  return { exposures: rowsToExposureObjects(dedupe(all) as ExposureRow[]), regions };
}

// Distance in arcsec from the point to the nearest polygon edge, positive inside. The polygon and
// the point are projected on the tangent plane at the polygon centre.
export function edgeMargin(poly: number[], ra: number, dec: number): number {
  const n = poly.length / 2;
  let cra = 0, cdec = 0;
  for (let i = 0; i < n; i++) { cra += poly[2 * i]; cdec += poly[2 * i + 1]; }
  cra /= n; cdec /= n;
  const D = Math.PI / 180;
  const proj = (r: number, d: number): [number, number] => {
    const dr = (r - cra) * D;
    const c = Math.sin(d * D) * Math.sin(cdec * D) + Math.cos(d * D) * Math.cos(cdec * D) * Math.cos(dr);
    return [
      (Math.cos(d * D) * Math.sin(dr)) / c * 206264.806,
      (Math.sin(d * D) * Math.cos(cdec * D) - Math.cos(d * D) * Math.sin(cdec * D) * Math.cos(dr)) / c * 206264.806,
    ];
  };
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push(proj(poly[2 * i], poly[2 * i + 1]));
  const t = proj(ra, dec);
  let m = Infinity;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (!(len > 0)) continue;
    const cross = (x1 - x0) * (t[1] - y0) - (y1 - y0) * (t[0] - x0);
    const crossC = (x1 - x0) * (0 - y0) - (y1 - y0) * (0 - x0); // sign of the centre
    const d = (Math.sign(crossC) * cross) / len;
    if (d < m) m = d;
  }
  return m;
}

// ---- selection ---------------------------------------------------------------------------------

const MIN_PER_CELL = 4;
const MAX_UNSTACKED = 2;
const EDGE_MARGIN_ARCSEC = 40 * 6.15;

interface Cell { key: string; es: Exposure[]; pool: Exposure[]; q: number }

function pickEven<T>(arr: T[], q: number): T[] {
  const out: T[] = [];
  for (let k = 0; k < q; k++) out.push(arr[Math.floor(((k + 0.5) * arr.length) / q)]);
  return out;
}

export const cellKey = (e: Exposure): string => `${String(e.visitIndex).padStart(5, '0')}|${e.detector}`;

// Capped selection: every (visit, detector) cell gets at least MIN_PER_CELL exposures (or all it has),
// the rest of the cap is water-filled evenly over the cells. Inside a cell exposures whose predicted
// target position is at least 40 px inside the detector edge come first, evenly spaced in time; the
// remaining candidates of each cell, best margin first, stay in `pool` for top-ups. Deterministic.
export function select(
  exposures: Exposure[], margin: (e: Exposure) => number, max = MAX_FRAMES,
): { picked: Exposure[]; cells: Cell[]; mode: 'all' | 'even-300' } {
  const bad = exposures.filter((e) => e.inStack === false);
  const main = exposures.filter((e) => e.inStack !== false);
  const map = new Map<string, Exposure[]>();
  for (const e of (exposures.length <= max ? exposures : main)) {
    const k = cellKey(e);
    const c = map.get(k);
    if (c) c.push(e);
    else map.set(k, [e]);
  }
  const cells: Cell[] = [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, es]) => ({ key, es: es.sort((a, b) => a.mjd - b.mjd || (a.id < b.id ? -1 : 1)), pool: [], q: 0 }));
  if (exposures.length <= max) {
    return { picked: exposures, cells: cells.map((c) => ({ ...c, q: c.es.length })), mode: 'all' };
  }
  let used = 0;
  for (const c of cells) { c.q = Math.min(c.es.length, MIN_PER_CELL); used += c.q; }
  if (used > max) throw new Error(`minimum per cell (${used}) exceeds the cap ${max}`);
  let remaining = max - used;
  const bySize = [...cells].sort((a, b) => (a.es.length - a.q) - (b.es.length - b.q) || (a.key < b.key ? -1 : 1));
  bySize.forEach((c, i) => {
    const share = Math.floor(remaining / (bySize.length - i));
    const add = Math.min(c.es.length - c.q, share);
    c.q += add;
    remaining -= add;
  });
  for (let guard = 0; remaining > 0 && guard < max; guard++) {
    let gave = false;
    for (const c of [...bySize].reverse()) {
      if (remaining <= 0) break;
      if (c.q < c.es.length) { c.q++; remaining--; gave = true; }
    }
    if (!gave) break;
  }
  const picked: Exposure[] = [];
  for (const c of cells) {
    const pref = c.es.filter((e) => margin(e) >= EDGE_MARGIN_ARCSEC);
    const rest = c.es.filter((e) => !(margin(e) >= EDGE_MARGIN_ARCSEC));
    const nPref = Math.min(c.q, pref.length);
    const chosen = new Set<Exposure>([...pickEven(pref, nPref), ...(c.q > nPref ? pickEven(rest, c.q - nPref) : [])]);
    for (const e of chosen) picked.push(e);
    const left = c.es.filter((e) => !chosen.has(e));
    const key = (e: Exposure) => { const m = margin(e); return Number.isFinite(m) ? m : -Infinity; };
    c.pool = [
      ...left.filter((e) => key(e) >= EDGE_MARGIN_ARCSEC),
      ...left.filter((e) => key(e) < EDGE_MARGIN_ARCSEC).sort((a, b) => key(b) - key(a)),
    ];
  }
  // At most MAX_UNSTACKED exposures that must not be stacked, only if the cap did not fill.
  const room = Math.min(MAX_UNSTACKED, max - picked.length, bad.length);
  if (room > 0) picked.push(...pickEven(bad, room));
  picked.sort((a, b) => a.mjd - b.mjd || (a.id < b.id ? -1 : 1));
  return { picked, cells, mode: 'even-300' };
}

// ---- catalogues --------------------------------------------------------------------------------

async function fetchText(url: string, accept: string): Promise<string> {
  const res = await fetchUpstream(url, {
    init: { headers: { Accept: accept } },
    attemptTimeoutMs: 45000,
    budgetMs: 60000,
    maxAttempts: 4,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function getGaia(t: Target): Promise<GaiaStar[]> {
  try {
    const csv = await retry('gaia', 3, () => fetchText(gaiaUrl(t.ra, t.dec, 300), 'text/csv'));
    return (parseGaia(csv) as Array<Record<string, number | string | null>>).map((s) => ({
      sourceId: String(s.source_id),
      ra: s.ra as number,
      dec: s.dec as number,
      pmra: (s.pmra as number | null) ?? null,
      pmdec: (s.pmdec as number | null) ?? null,
      parallax: (s.parallax as number | null) ?? null,
      gmag: (s.phot_g_mean_mag as number | null) ?? NaN,
    }));
  } catch (e) {
    console.warn(`  WARNING Gaia failed, storing []: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

async function getWise(t: Target): Promise<WiseSource[]> {
  for (const cat of ['catwise2020', 'allwise'] as const) {
    try {
      const csv = await retry(`wise ${cat}`, 3, () => fetchText(wiseUrl(t.ra, t.dec, 300, cat), 'text/csv'));
      const rows = parseWise(csv, cat) as Array<Record<string, number | string | null>>;
      if (rows.length === 0) {
        console.warn(`  WISE ${cat} returned no sources, trying the next catalogue`);
        continue;
      }
      return rows.map((s) => ({
        id: String(s.id),
        ra: s.ra as number,
        dec: s.dec as number,
        pmra: (s.pmra as number | null) ?? null,
        pmdec: (s.pmdec as number | null) ?? null,
        w1mag: (s.w1mag as number | null) ?? null,
        w2mag: (s.w2mag as number | null) ?? null,
      }));
    } catch (e) {
      console.warn(`  WARNING WISE ${cat} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.warn('  WARNING WISE failed for every catalogue, storing []');
  return [];
}

// ---- build one target --------------------------------------------------------------------------

function fmtBytes(n: number): string {
  return `${(n / 1048576).toFixed(2)} MB (${n} bytes)`;
}

interface Summary {
  slug: string; found: number; selected: number; loaded: number; failed: number;
  droppedCoverage: number; droppedNoWavelength: number; toppedUp: number; cached: number; unstackFound: number; unstackCached: number; cellsUnder: string[]; visits: number; detectors: string;
  downloaded: number; seconds: number; outBytes: number; gaia: number; wise: number;
}

async function buildOne(slug: CachedSlug): Promise<Summary> {
  const t0 = Date.now();
  const entry = CHALLENGE_TARGETS.find((e) => e.slug === slug);
  if (!entry) throw new Error(`unknown slug ${slug}`);
  const target: Target = {
    ra: entry.ra, dec: entry.dec, pmra: entry.pmra, pmdec: entry.pmdec,
    epoch: entry.epoch, name: entry.name, source: entry.source,
  };
  console.log(`\n== ${slug} ==`);

  const { exposures, regions } = await findAll(target);
  if (exposures.length === 0) throw new Error(`${slug}: no exposures found`);
  const marginMap = new Map<string, number>();
  for (const e of exposures) {
    const poly = regions.get(e.id);
    if (!poly) { marginMap.set(e.id, NaN); continue; }
    const p = positionAt(target, e.mjd);
    marginMap.set(e.id, edgeMargin(poly, p.ra, p.dec));
  }
  const withRegion = exposures.filter((e) => Number.isFinite(marginMap.get(e.id))).length;
  const { picked, cells, mode } = select(exposures, (e) => marginMap.get(e.id) ?? NaN);
  // Grid centre is evaluated at the mean time of ALL exposures found, so it does not depend on selection.
  const grid = makeGrid(target, exposures);
  console.log(`  exposures found ${exposures.length} (${withRegion} with s_region), selected ${picked.length} (${mode}), cells ${cells.length}, grid ${grid.w}x${grid.h}`);

  const bytes0 = bytesTransferred();
  let lastPrint = 0;
  const onProgress = (p: { done: number; total: number }) => {
    const now = Date.now();
    if (now - lastPrint > 5000 || p.done === p.total) {
      lastPrint = now;
      console.log(`  frames ${p.done}/${p.total}, ${((bytesTransferred() - bytes0) / 1048576).toFixed(1)} MB`);
    }
  };
  const loadWithRetries = async (list: Exposure[], conc: number, prog?: typeof onProgress) => {
    const first = await loadFrames(list, grid, { target, concurrency: conc, onProgress: prog });
    let got: Frame[] = first.frames;
    let failedList = first.failed.map((f) => f.exposure);
    for (let pass = 1; pass <= 2 && failedList.length > 0; pass++) {
      console.log(`  retry pass ${pass}: ${failedList.length} failed exposure(s)`);
      await sleep(3000);
      const r = await loadFrames(failedList, grid, { target, concurrency: 4 });
      got = got.concat(r.frames);
      failedList = r.failed.map((f) => f.exposure);
    }
    return { got, failed: failedList };
  };
  const usable = (f: Frame) => f.coverage >= MIN_COVERAGE && f.exposure.wavelengthAtTarget !== null;

  const r0 = await loadWithRetries(picked, 8, onProgress);
  let frames: Frame[] = r0.got;
  let failedAll: Exposure[] = r0.failed;
  let loaded = frames.length;
  let toppedUp = 0;
  for (let pass = 1; pass <= 2; pass++) {
    // Deficit per cell: its quota minus the usable frames it has so far.
    const good = new Map<string, number>();
    const attempted = new Set<string>([...frames.map((f) => f.exposure.id), ...failedAll.map((e) => e.id)]);
    for (const f of frames) if (usable(f)) good.set(cellKey(f.exposure), (good.get(cellKey(f.exposure)) ?? 0) + 1);
    const extra: Exposure[] = [];
    for (const c of cells) {
      if (mode === 'all') break;
      const deficit = c.q - (good.get(c.key) ?? 0);
      let need = deficit;
      while (need > 0 && c.pool.length > 0) {
        const e = c.pool.shift() as Exposure;
        if (attempted.has(e.id)) continue;
        extra.push(e);
        need--;
      }
    }
    if (extra.length === 0) break;
    console.log(`  top-up pass ${pass}: ${extra.length} extra exposure(s)`);
    const r = await loadWithRetries(extra, 8);
    toppedUp += extra.length;
    frames = frames.concat(r.got);
    loaded += r.got.length;
    failedAll = failedAll.concat(r.failed);
  }
  const downloaded = bytesTransferred() - bytes0;
  for (const id of failedAll.map((e) => e.id)) console.warn(`  FAILED ${id}`);

  const droppedCoverage = frames.filter((f) => f.coverage < MIN_COVERAGE).length;
  let kept = frames.filter((f) => f.coverage >= MIN_COVERAGE);
  const droppedNoWavelength = kept.filter((f) => f.exposure.wavelengthAtTarget === null).length;
  kept = kept.filter((f) => f.exposure.wavelengthAtTarget !== null);
  kept.sort((a, b) => a.exposure.mjd - b.exposure.mjd || (a.exposure.id < b.exposure.id ? -1 : 1));
  if (kept.length === 0) throw new Error(`${slug}: no usable frames`);
  const keptPerCell = new Map<string, number>();
  for (const f of kept) keptPerCell.set(cellKey(f.exposure), (keptPerCell.get(cellKey(f.exposure)) ?? 0) + 1);
  const cellsUnder = cells
    .filter((c) => (keptPerCell.get(c.key) ?? 0) < Math.min(MIN_PER_CELL, c.es.length))
    .map((c) => `${c.key}:${keptPerCell.get(c.key) ?? 0}/${c.es.length}`);
  if (cellsUnder.length) console.warn(`  cells under ${MIN_PER_CELL}: ${cellsUnder.join(' ')}`);

  const [gaia, wise] = await Promise.all([getGaia(target), getWise(target)]);

  const builtAt = new Date().toISOString();
  const { manifest, bin } = encodeCache({
    slug, target, grid, exposures: kept.map((f) => f.exposure), frames: kept, gaia, wise, builtAt,
  });
  const build = {
    found: exposures.length, selected: picked.length, loaded, failed: failedAll.length,
    droppedCoverage, toppedUp, bytesDownloaded: downloaded, selection: mode,
  };
  const manifestJson = JSON.stringify({ ...manifest, build });

  const dir = join(OUT, slug);
  mkdirSync(dir, { recursive: true });
  const mTmp = join(dir, 'manifest.json.tmp');
  const bTmp = join(dir, 'frames.bin.tmp');
  writeFileSync(mTmp, manifestJson);
  writeFileSync(bTmp, bin);
  renameSync(mTmp, join(dir, 'manifest.json'));
  renameSync(bTmp, join(dir, 'frames.bin'));
  const outBytes = Buffer.byteLength(manifestJson) + bin.length;

  const visits = new Set(kept.map((f) => f.exposure.visitIndex)).size;
  const dets = [...new Set(kept.map((f) => f.exposure.detector))].sort().join(',');
  const s: Summary = {
    slug, found: exposures.length, selected: picked.length, loaded, failed: failedAll.length,
    droppedCoverage, droppedNoWavelength, toppedUp, cached: kept.length, cellsUnder,
    unstackFound: exposures.filter((e) => e.inStack === false).length,
    unstackCached: kept.filter((f) => f.exposure.inStack === false).length, visits, detectors: dets, downloaded,
    seconds: (Date.now() - t0) / 1000, outBytes, gaia: gaia.length, wise: wise.length,
  };
  console.log(`  kept ${kept.length} frames; ${JSON.stringify(s)}`);
  return s;
}

function dirSize(p: string): number {
  if (!existsSync(p)) return 0;
  let n = 0;
  for (const name of readdirSync(p)) {
    const q = join(p, name);
    const st = statSync(q);
    n += st.isDirectory() ? dirSize(q) : st.size;
  }
  return n;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: vite-node scripts/build-cache.ts <slug|all>');
    process.exit(2);
  }
  const todo = arg === 'all' ? SLUGS : SLUGS.filter((s) => s === arg);
  if (todo.length === 0) {
    console.error(`unknown slug '${arg}'`);
    process.exit(2);
  }
  const summaries: Summary[] = [];
  let exitCode = 0;
  for (const slug of todo) {
    try {
      summaries.push(await buildOne(slug));
    } catch (e) {
      exitCode = 1;
      console.error(`ERROR ${slug}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }
  console.log('\n== Summary ==');
  console.log('slug | found | selected | loaded | failed | dropCov | topUp | cached | cellsUnder4 | notInStack found/cached | visits | detectors | downloaded | time s | output | gaia | wise');
  for (const s of summaries) {
    console.log([
      s.slug, s.found, s.selected, s.loaded, s.failed, s.droppedCoverage, s.toppedUp, s.cached, s.cellsUnder.length ? s.cellsUnder.join(' ') : 'none', `${s.unstackFound}/${s.unstackCached}`, s.visits,
      s.detectors, `${(s.downloaded / 1048576).toFixed(1)} MB`, s.seconds.toFixed(1), fmtBytes(s.outBytes), s.gaia, s.wise,
    ].join(' | '));
  }
  const total = dirSize(OUT);
  console.log(`public/cache total: ${fmtBytes(total)} (budget ${fmtBytes(BUDGET_BYTES)})`);
  if (total > BUDGET_BYTES) {
    console.error('OVER BUDGET: public/cache exceeds 30 MB');
    exitCode = 1;
  }
  process.exit(exitCode);
}

main();
