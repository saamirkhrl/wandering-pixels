// Per-star matched readouts for the cached targets (docs/algorithm.md).
//
//   npx -y vite-node scripts/build-readouts.ts <slug|all>
//   npx -y vite-node scripts/build-readouts.ts --rebuild <slug|all>   rebuild the trimmed files from the saved full results (no downloads)
//   npx -y vite-node scripts/build-readouts.ts --vectors      compare the Barnard vector stars (no files written)
//   npx -y vite-node scripts/build-readouts.ts --selfcheck <slug>   cropped stamps vs individual stamps (no files written)
//
// Per target: the default detector of public/cache/<slug>/index.json; the stars are the target
// (positions with its proper motion, always included) plus up to MAX_GAIA Gaia stars of the cached
// full star list that lie inside the cutout grid and have G >= SATURATION_G, brightest first. The
// exposures are ALL exposures found for the target on that detector (live SIA, same query and
// assignVisits as build-cache.ts, which cannot be imported because it runs on import); only
// inStack exposures are used and only visits with at least MIN_READ_EXPOSURES of them are read.
// For every pair of visits (A earlier) where a star has at least MIN_ACCEPTED accepted exposures in
// both, compareVisits gives the result.
//
// Stamp reads: the uncompressed rows of an exposure cost the same for any window width, so one
// exposure is read once as a (2 * BIG_HALF + 1) square window centred on the grid centre and the
// 17 x 17 stamp of every star is cropped from it (identical arrays to loadNativeStamp, checked by
// --selfcheck). A star whose window is not inside the big window is read on its own.
//
// Output: public/cache/<slug>/readouts.d<N>.<8 hex>.json (trimmed, UI fields), index.json gets a
// top-level `readouts` entry, and the full results go to $WP_SAMPLES_DIR (default
// <repo>/../research/samples)/readouts/<slug>.json.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHALLENGE_TARGETS } from '../src/lib/spherex/resolve';
import { rowsToExposures as rowsToExposureObjects } from '../src/lib/spherex/search';
import type { ExposureRow } from '../src/lib/spherex/search';
import { bytesTransferred, getHdu, setFetch } from '../src/lib/spherex/fits';
import { loadNativeStamp, nativeStampsFor, stampWindow, starPosition } from '../src/lib/spherex/native';
import type { NativeStamp } from '../src/lib/spherex/native';
import { measureStamp } from '../src/lib/spherex/photometry';
import { compareVisits, isBlended } from '../src/lib/spherex/matched';
import type { MatchedExposure, MatchedResult } from '../src/lib/spherex/matched';
import { loadCachedStars } from '../src/lib/spherex/cache';
import { fnv1a32 } from '../src/lib/spherex/cache-encode';
import { readWaveTable, waveAt } from '../src/lib/spherex/wavelength';
import { parseWcs, positionAt, skyToPix, worldToGrid } from '../src/lib/spherex/wcs';
import { SpherexError } from '../src/lib/spherex/types';
import type { CachedSlug, Exposure, GaiaStar, Grid, Target } from '../src/lib/spherex/types';
import type { CachedReadouts, PairReadout, ReadoutsRef, StarReadout } from '../src/lib/spherex/readouts';
import { READOUTS_FORMAT, applyReliability, fieldPairsOf, hasBrightNeighbour } from '../src/lib/spherex/readouts';

// @ts-expect-error plain JS helper modules without type declarations
import { fetchUpstream } from '../api/_lib/http.js';
// @ts-expect-error plain JS helper modules without type declarations
import { COLLECTIONS, buildSiaUrl, parseVotable, queryStatus, rowsToExposures as siaRows, dedupe } from '../api/_lib/sia.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'public', 'cache');
const SLUGS: CachedSlug[] = ['barnards-star', 'eps-indi-b', 'wise-0855', 'rw-aur', 'r-dra', 'v391-oph'];
// Targets that get one readouts file per listed detector (the first is the index default and also
// goes in `readouts`; all go in `readoutsByDetector`). Other targets: the default detector only.
const DETECTORS: Partial<Record<CachedSlug, number[]>> = { 'v391-oph': [2, 1, 4] };
// Gaia DR3 ids that are always measured (when inside the grid), even when not among the brightest MAX_GAIA.
const ALWAYS_INCLUDE: Partial<Record<CachedSlug, string[]>> = { 'v391-oph': ['4472831551114789632'] };

const HALF = 8;                 // stamp half size: 17 x 17 as in docs/algorithm.md
const BIG_HALF = 50;            // MAX_HALF of native.ts
const MAX_GAIA = 40;            // Gaia stars per target, in addition to the target
// docs/algorithm.md gives no magnitude limit and the star list carries no saturation info. Its test
// vectors show G 12.47 saturated in 14 of 18 exposures and G 12.75 not at all, so Gaia stars
// brighter than G 12.5 are left out (the target is always kept and carries the saturated flag).
const SATURATION_G = 12.5;
const GRID_MARGIN_PX = 3;       // a star must lie this far inside the grid
const TARGET_MATCH_ARCSEC = 3;  // a Gaia entry this close to the target is the target
const MIN_READ_EXPOSURES = 8;   // visits with fewer in-stack exposures cannot reach 8 accepted
const MIN_ACCEPTED = 8;         // accepted exposures per visit for a pair to be reported
const CONCURRENCY = 8;
const BUDGET_BYTES = 150 * 1024;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function retry<T>(label: string, tries: number, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.warn(`  ${label} attempt ${i + 1}/${tries} failed: ${msg(e)}`);
      await sleep(4000 * (i + 1));
    }
  }
  throw last;
}

// ---- exposures (same queries and visit assignment as build-cache.ts) --------------------------

async function queryCollection(name: string, ra: number, dec: number): Promise<ExposureRow[]> {
  const res = await fetchUpstream(buildSiaUrl(name, ra, dec, 5000), {
    init: { headers: { Accept: 'application/x-votable+xml, text/xml' } },
    attemptTimeoutMs: 40000,
    budgetMs: 60000,
    maxAttempts: 4,
  });
  if (res.status !== 200) throw new Error(`${name} returned HTTP ${res.status}`);
  const xml: string = await res.text();
  if (queryStatus(xml) === 'ERROR') throw new Error(`${name} reported a query error`);
  return siaRows(parseVotable(xml) as Array<Record<string, string>>) as ExposureRow[];
}

async function findAll(ra: number, dec: number): Promise<Exposure[]> {
  const all: ExposureRow[] = [];
  for (const c of COLLECTIONS as { name: string; required: boolean }[]) {
    try {
      all.push(...(await retry(c.name, 6, () => queryCollection(c.name, ra, dec))));
    } catch (e) {
      if (c.required) throw e;
      console.warn(`  WARNING optional collection ${c.name} failed, continuing without it`);
    }
  }
  return rowsToExposureObjects(dedupe(all) as ExposureRow[]);
}

// ---- disk fetch for the cache loaders ---------------------------------------------------------

function diskFetch(): typeof fetch {
  return (async (url: string | URL | Request) => {
    const m = /^\/cache\/([a-z0-9-]+)\/([a-z0-9.-]+)$/.exec(String(url));
    if (!m) throw new Error(`unexpected url ${String(url)}`);
    const p = join(CACHE, m[1], m[2]);
    if (!existsSync(p)) return new Response('missing', { status: 404 });
    return new Response(readFileSync(p), { status: 200 });
  }) as typeof fetch;
}

// ---- stars ------------------------------------------------------------------------------------

interface Star {
  id: string;
  isTarget: boolean;
  ra: number;       // table / Gaia position
  dec: number;
  gmag: number;     // NaN unknown
  target: Target;   // for positionAt
  gaiaIndex: number; // index in the full Gaia list, -1 when none
}

function sepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const c = Math.cos(((dec1 + dec2) / 2) * Math.PI / 180);
  return Math.hypot((ra1 - ra2) * c, dec1 - dec2) * 3600;
}

function pickStars(target: Target, grid: Grid, gaia: GaiaStar[], always: readonly string[] = []): Star[] {
  // The Gaia entry that is the target: nearest within TARGET_MATCH_ARCSEC of the target's position at 2016.0.
  const tAt = positionAt(target, 57388.0); // MJD of J2016.0 (2016-01-01 12:00 TT is 57388.0)
  let ti = -1;
  let tBest = TARGET_MATCH_ARCSEC;
  gaia.forEach((s, i) => {
    const d = sepArcsec(s.ra, s.dec, tAt.ra, tAt.dec);
    if (d <= tBest) { tBest = d; ti = i; }
  });
  const out: Star[] = [{
    id: ti >= 0 ? gaia[ti].sourceId : 'target', isTarget: true, ra: target.ra, dec: target.dec,
    gmag: ti >= 0 ? gaia[ti].gmag : NaN, target, gaiaIndex: ti,
  }];
  const cand: Star[] = [];
  gaia.forEach((s, i) => {
    if (i === ti || !Number.isFinite(s.gmag) || s.gmag < SATURATION_G) return;
    const t: Target = { ra: s.ra, dec: s.dec, pmra: s.pmra ?? 0, pmdec: s.pmdec ?? 0, epoch: 2016.0 };
    const p = positionAt(t, grid.epochMjd);
    const [x, y] = worldToGrid(grid, p.ra, p.dec);
    if (!(x >= GRID_MARGIN_PX && y >= GRID_MARGIN_PX && x <= grid.w - 1 - GRID_MARGIN_PX && y <= grid.h - 1 - GRID_MARGIN_PX)) return;
    cand.push({ id: s.sourceId, isTarget: false, ra: s.ra, dec: s.dec, gmag: s.gmag, target: t, gaiaIndex: i });
  });
  cand.sort((a, b) => a.gmag - b.gmag);
  const keep = cand.filter((c) => always.includes(c.id));
  for (const id of always) if (!keep.some((c) => c.id === id)) console.warn(`  WARNING always-include star ${id} is not inside the grid or not in the Gaia list`);
  const rest = cand.filter((c) => !always.includes(c.id)).slice(0, MAX_GAIA - keep.length);
  return out.concat([...keep, ...rest].sort((a, b) => a.gmag - b.gmag));
}

// ---- stamps -----------------------------------------------------------------------------------

function crop(big: NativeStamp, col0: number, row0: number, x: number, y: number, size: number,
  wavelength: number, bandwidth: number, ra: number, dec: number, e: Exposure): NativeStamp {
  const n = size * size;
  const p = new Float32Array(n), variance = new Float32Array(n), flags = new Uint32Array(n);
  for (let j = 0; j < size; j++) {
    const src = (row0 + j - big.row0) * big.size + (col0 - big.col0);
    p.set(big.p.subarray(src, src + size), j * size);
    variance.set(big.variance.subarray(src, src + size), j * size);
    flags.set(big.flags.subarray(src, src + size), j * size);
  }
  return {
    exposureId: e.id, detector: e.detector, mjd: e.mjd, visitIndex: e.visitIndex, size, half: HALF,
    col0, row0, x, y, p, variance, flags, wavelength, bandwidth, ra, dec, bytes: 0,
  };
}

interface Reader {
  /** Stamps for the stars at this exposure: null = star not on the detector (or unreadable). */
  stamps(e: Exposure, stars: Star[], counters: Counters): Promise<(NativeStamp | null)[]>;
}

interface Counters { big: number; bigFailed: number; cropped: number; individual: number; noCoverage: number; failed: number }

function makeReader(grid: Grid, useBig: boolean): Reader {
  return {
    async stamps(e, stars, c) {
      const out: (NativeStamp | null)[] = new Array(stars.length).fill(null);
      let big: NativeStamp | null = null;
      if (useBig) {
        try {
          big = await loadNativeStamp(e, grid.ra0, grid.dec0, BIG_HALF);
          c.big++;
        } catch (err) {
          c.bigFailed++;
          big = null;
          if (!(err instanceof SpherexError && err.code === 'NO_COVERAGE')) console.warn(`  big read failed ${e.id}: ${msg(err)}`);
        }
      }
      let wcs: ReturnType<typeof parseWcs> | null = null;
      let nx = 0, ny = 0;
      let table: Awaited<ReturnType<typeof readWaveTable>> | null = null;
      if (big) {
        try {
          const hdu = await getHdu(e.url, 'IMAGE');
          wcs = parseWcs(hdu.header);
          nx = Number(hdu.header['NAXIS1']);
          ny = Number(hdu.header['NAXIS2']);
          table = await readWaveTable(e.url).catch(() => null);
        } catch {
          wcs = null;
        }
      }
      for (let i = 0; i < stars.length; i++) {
        const pos = positionAt(stars[i].target, e.mjd);
        if (big && wcs) {
          const [px, py] = skyToPix(wcs, pos.ra, pos.dec);
          let win;
          try {
            win = stampWindow(px, py, nx, ny, HALF);
          } catch {
            c.noCoverage++;
            continue;
          }
          const size = 2 * HALF + 1;
          if (win.col0 >= big.col0 && win.row0 >= big.row0 && win.col0 + size <= big.col0 + big.size && win.row0 + size <= big.row0 + big.size) {
            const wv = table ? waveAt(table, px, py) : { wavelength: NaN, bandwidth: NaN };
            out[i] = crop(big, win.col0, win.row0, win.x, win.y, size, wv.wavelength, wv.bandwidth, pos.ra, pos.dec, e);
            c.cropped++;
            continue;
          }
        }
        try {
          out[i] = await loadNativeStamp(e, pos.ra, pos.dec, HALF);
          c.individual++;
        } catch (err) {
          if (err instanceof SpherexError && err.code === 'NO_COVERAGE') c.noCoverage++;
          else { c.failed++; console.warn(`  stamp failed ${e.id} star ${stars[i].id}: ${msg(err)}`); }
        }
      }
      return out;
    },
  };
}

// ---- rounding and trimming --------------------------------------------------------------------

const sig = (x: number, n: number): number | null => (Number.isFinite(x) ? Number(x.toPrecision(n)) : null);
const dp = (x: number, n: number): number | null => (Number.isFinite(x) ? Number(x.toFixed(n)) : null);

function trimPair(r: MatchedResult, a: number, b: number, tA: number, tB: number): PairReadout {
  const comb = (c: { D: number; var: number; z: number; fractionalChange: number }) => ({
    D: sig(c.D, 4), sigma: sig(Math.sqrt(c.var), 4), z: dp(c.z, 3), frac: sig(c.fractionalChange, 4),
  });
  return {
    a, b, tA: dp(tA, 2) as number, tB: dp(tB, 2) as number, nA: r.nExposuresA, nB: r.nExposuresB,
    w: r.perWavelength.map((k) => [dp(k.w0, 4) as number, sig(k.D, 4), sig(Math.sqrt(k.var), 4), dp(k.z, 3)]),
    nSkipped: r.nSkipped,
    D: sig(r.D, 4), sigma: sig(Math.sqrt(r.var), 4), z: dp(r.z, 3), frac: sig(r.fractionalChange, 4),
    plain: r.plain ? comb(r.plain) : null,
    ps: { n: r.ps.nPairs, ...comb(r.ps) },
    flags: r.flags,
    verdict: r.verdict,
  };
}

// ---- per target -------------------------------------------------------------------------------

interface Summary {
  slug: string; detector: number; stars: number; visits: string; pairs: number; results: number;
  verdicts: Record<string, number>; bytes: number; seconds: number; outBytes: number;
  targetRows: string[]; counters: Counters; exposures: number;
}

function mid(es: Exposure[]): number {
  let lo = Infinity, hi = -Infinity;
  for (const e of es) { if (e.mjd < lo) lo = e.mjd; if (e.mjd > hi) hi = e.mjd; }
  return (lo + hi) / 2;
}

async function buildOne(slug: CachedSlug, detectorArg?: number): Promise<Summary> {
  const t0 = Date.now();
  const bytes0 = bytesTransferred();
  const entry = CHALLENGE_TARGETS.find((x) => x.slug === slug);
  if (!entry) throw new Error(`unknown slug ${slug}`);
  const target: Target = {
    ra: entry.ra, dec: entry.dec, pmra: entry.pmra, pmdec: entry.pmdec, epoch: entry.epoch, name: entry.name, source: entry.source,
  };
  console.log(`\n== ${slug} ==`);
  const indexPath = join(CACHE, slug, 'index.json');
  const indexRaw = readFileSync(indexPath, 'utf8');
  const index = JSON.parse(indexRaw) as { defaultDetector: number; grid: Grid; readouts?: ReadoutsRef };
  const detector = detectorArg ?? index.defaultDetector;
  const grid = index.grid;

  const { gaia } = await loadCachedStars(slug, { baseUrl: '/cache/', fetchFn: diskFetch() });
  const stars = pickStars(target, grid, gaia, ALWAYS_INCLUDE[slug]);
  console.log(`  detector ${detector}, gaia list ${gaia.length}, stars ${stars.length} (target + ${stars.length - 1} Gaia, G >= ${SATURATION_G})`);

  const found = await findAll(target.ra, target.dec);
  const onDet = found.filter((e) => e.detector === detector);
  const inStack = onDet.filter((e) => e.inStack !== false);
  const byVisit = new Map<number, Exposure[]>();
  for (const e of inStack) {
    const l = byVisit.get(e.visitIndex);
    if (l) l.push(e); else byVisit.set(e.visitIndex, [e]);
  }
  const visits = [...byVisit.entries()].filter(([, l]) => l.length >= MIN_READ_EXPOSURES).sort((a, b) => a[0] - b[0]);
  const visitLabel = visits.map(([v, l]) => `${v}:${l.length}`).join(' ');
  console.log(`  exposures found ${found.length}, on detector ${onDet.length}, in stack ${inStack.length} (${onDet.length - inStack.length} out of stack), visits used ${visitLabel}`);
  const toRead = visits.flatMap(([, l]) => l).sort((a, b) => a.mjd - b.mjd);

  // read and measure
  const records: MatchedExposure[][] = stars.map(() => []);
  const counters: Counters = { big: 0, bigFailed: 0, cropped: 0, individual: 0, noCoverage: 0, failed: 0 };
  const reader = makeReader(grid, true);
  let next = 0, done = 0;
  let lastPrint = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= toRead.length) return;
      const e = toRead[i];
      const stamps = await reader.stamps(e, stars, counters);
      for (let k = 0; k < stars.length; k++) {
        const s = stamps[k];
        if (!s || !Number.isFinite(s.wavelength) || !Number.isFinite(s.bandwidth)) continue;
        records[k].push({
          id: e.obsId, visit: e.visitIndex, mjd: s.mjd, wavelength: s.wavelength, bandwidth: s.bandwidth, measurement: measureStamp(s),
        });
      }
      done++;
      const now = Date.now();
      if (now - lastPrint > 5000 || done === toRead.length) {
        lastPrint = now;
        console.log(`  exposures ${done}/${toRead.length}, ${((bytesTransferred() - bytes0) / 1048576).toFixed(1)} MB, ${((now - t0) / 1000).toFixed(0)} s`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toRead.length) }, worker));

  // compare
  const vInfo = visits.map(([v, l]) => ({ visit: v, mjd: dp(mid(l), 2) as number, n: l.length }));
  const neighbours = gaia.map((g) => ({ ra: g.ra, dec: g.dec, g: g.gmag }));
  const varFlags0 = await gaiaVariableFlags(stars.map((x) => x.id));
  const trimmed: StarReadout[] = [];
  const full: unknown[] = [];
  const verdicts: Record<string, number> = { changed: 0, 'no significant change': 0, 'no result': 0 };
  const targetRows: string[] = [];
  let results = 0;
  for (let k = 0; k < stars.length; k++) {
    const s = stars[k];
    const blended = Number.isFinite(s.gmag) && isBlended({ ra: s.ra, dec: s.dec, g: s.gmag }, neighbours, s.gaiaIndex >= 0 ? s.gaiaIndex : undefined);
    const accepted = new Map<number, number>();
    for (const r of records[k]) if (r.measurement.ok) accepted.set(r.visit as number, (accepted.get(r.visit as number) ?? 0) + 1);
    const pairs: PairReadout[] = [];
    const fullPairs: unknown[] = [];
    for (let i = 0; i < visits.length; i++) {
      for (let j = i + 1; j < visits.length; j++) {
        const [va, vb] = [visits[i][0], visits[j][0]];
        if ((accepted.get(va) ?? 0) < MIN_ACCEPTED || (accepted.get(vb) ?? 0) < MIN_ACCEPTED) continue;
        const res = compareVisits(records[k], va, vb, { blended });
        pairs.push(trimPair(res, va, vb, vInfo[i].mjd, vInfo[j].mjd));
        fullPairs.push({ a: va, b: vb, result: res });
        verdicts[res.verdict]++;
        results++;
        if (s.isTarget) {
          targetRows.push(`${va}->${vb} nA ${res.nExposuresA} nB ${res.nExposuresB} w0 ${res.nW0} z=${res.z.toFixed(2)} frac=${(res.fractionalChange * 100).toFixed(2)}% ` +
            `plain z=${res.plain ? res.plain.z.toFixed(2) : '-'} ps z=${res.ps.z.toFixed(2)} "${res.verdict}" [${res.flags.join(',')}]`);
        }
      }
    }
    trimmed.push({
      id: s.id, ra: dp(s.ra, 6) as number, dec: dp(s.dec, 6) as number, gmag: dp(s.gmag, 2), isTarget: s.isTarget,
      brightNeighbour: hasBrightNeighbour({ ra: s.ra, dec: s.dec, sourceId: s.gaiaIndex >= 0 ? s.id : undefined }, gaia),
      variable: varFlags0.get(s.id) ?? null,
      pairs,
    });
    full.push({ star: { ...s, target: undefined }, blended, accepted: Object.fromEntries(accepted), pairs: fullPairs, measurements: records[k] });
  }
  if (trimmed[0].pairs.length === 0) targetRows.push('no visit pair with >= 8 accepted exposures in both visits');

  const fieldPairs = fieldPairsOf(trimmed);
  applyReliability(trimmed, fieldPairs);
  const out: CachedReadouts = {
    format: READOUTS_FORMAT, slug, detector: detector as CachedReadouts['detector'], builtAt: new Date().toISOString(), visits: vInfo, stars: trimmed, fieldPairs,
  };
  const body = new TextEncoder().encode(JSON.stringify(out));
  const hash = fnv1a32(body);
  const file = `readouts.d${detector}.${hash}.json`;
  const dir = join(CACHE, slug);
  const tmp = join(dir, `${file}.tmp`);
  writeFileSync(tmp, body);
  renameSync(tmp, join(dir, file));

  commitIndex(slug, detector, file, body.length, results, indexRaw, index.defaultDetector);
  if (body.length > BUDGET_BYTES) console.warn(`  OVER BUDGET: ${body.length} bytes > ${BUDGET_BYTES}`);

  const samples = process.env.WP_SAMPLES_DIR ?? resolve(ROOT, '..', 'research', 'samples');
  mkdirSync(join(samples, 'readouts'), { recursive: true });
  writeFileSync(join(samples, 'readouts', samplesName(slug, detector, index.defaultDetector)), JSON.stringify({ slug, detector, visits: vInfo, stars: full }, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));

  const s: Summary = {
    slug, detector, stars: stars.length, visits: visitLabel, pairs: visits.length * (visits.length - 1) / 2, results, verdicts,
    bytes: bytesTransferred() - bytes0, seconds: (Date.now() - t0) / 1000, outBytes: body.length, targetRows, counters, exposures: toRead.length,
  };
  console.log(`  wrote ${file} (${body.length} bytes)`);
  report(slug, file, body.length, trimmed, fieldPairs);
  return s;
}

/** Saved full results file: <slug>.json for the default detector, <slug>.d<N>.json for the others. */
function samplesName(slug: string, detector: number, defaultDetector: number): string {
  return detector === defaultDetector ? `${slug}.json` : `${slug}.d${detector}.json`;
}

/**
 * index.json: parse, set the readouts keys, stringify with the file's own indentation. The default
 * detector goes in `readouts`; a target with several detectors also gets `readoutsByDetector`.
 * Older readouts files of the same detector are deleted, other detectors' files are kept.
 */
function commitIndex(slug: CachedSlug, detector: number, file: string, bytes: number, count: number, indexRaw: string, defaultDetector: number): void {
  const dir = join(CACHE, slug);
  const parsed = JSON.parse(indexRaw) as Record<string, any>;
  const indent = /^\{\s*\n( +)"/.exec(indexRaw)?.[1].length ?? 0;
  const trailing = indexRaw.endsWith('\n') ? '\n' : '';
  const ref: ReadoutsRef = { file, bytes, detector: detector as ReadoutsRef['detector'], count };
  if (detector === defaultDetector) parsed.readouts = ref;
  if (DETECTORS[slug]) parsed.readoutsByDetector = { ...(parsed.readoutsByDetector ?? {}), [String(detector)]: ref };
  const idxTmp = join(dir, 'index.json.tmp');
  writeFileSync(idxTmp, JSON.stringify(parsed, null, indent || undefined) + trailing);
  renameSync(idxTmp, join(dir, 'index.json'));
  for (const name of readdirSync(dir)) {
    if (new RegExp(`^readouts\\.d${detector}\\..*\\.json$`).test(name) && name !== file) unlinkSync(join(dir, name));
  }
}

// ---- rebuild from the saved full results ------------------------------------------------------

const TAP_URL = 'https://gea.esac.esa.int/tap-server/tap/sync';

/** Gaia DR3 phot_variable_flag per source id: 'VARIABLE' -> true, 'NOT_AVAILABLE' -> false, anything else or missing -> null. */
async function gaiaVariableFlags(ids: string[]): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  const clean = [...new Set(ids.filter((i) => /^\d+$/.test(i)))];
  for (let i = 0; i < clean.length; i += 100) {
    const chunk = clean.slice(i, i + 100);
    const body = new URLSearchParams({
      REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv',
      QUERY: `SELECT source_id, phot_variable_flag FROM gaiadr3.gaia_source WHERE source_id IN (${chunk.join(',')})`,
    });
    const text = await retry('gaia tap', 4, async () => {
      const res = await fetch(TAP_URL, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
    for (const line of text.split(/\r?\n/).slice(1)) {
      const [id, flag] = line.split(',');
      if (!id) continue;
      out.set(id.trim(), flag === 'VARIABLE' ? true : flag === 'NOT_AVAILABLE' ? false : null);
    }
  }
  return out;
}

const nz = (x: unknown): number => (typeof x === 'number' ? x : NaN);

/** Saved full JSON (non-finite numbers stored as null) back to what trimPair reads. */
function reviveResult(r: Record<string, any>): MatchedResult {
  const comb = (c: Record<string, any> | null) => (c ? { ...c, D: nz(c.D), var: nz(c.var), z: nz(c.z), fractionalChange: nz(c.fractionalChange) } : null);
  return {
    ...r,
    perWavelength: (r.perWavelength as Record<string, any>[]).map((k) => ({ ...k, w0: nz(k.w0), D: nz(k.D), var: nz(k.var), z: nz(k.z) })),
    D: nz(r.D), var: nz(r.var), z: nz(r.z), fractionalChange: nz(r.fractionalChange),
    plain: comb(r.plain), ps: comb(r.ps),
  } as unknown as MatchedResult;
}

function report(slug: string, file: string, size: number, stars: StarReadout[], fieldPairs: CachedReadouts['fieldPairs']): void {
  const rate = (rs: PairReadout[]): string => `${rs.filter((r) => r.verdict === 'changed').length}/${rs.length}`;
  const tgt = stars[0];
  console.log(`\n== ${slug} == ${file} ${size} bytes, ${stars.reduce((n, x) => n + x.pairs.length, 0)} results`);
  for (const p of tgt.pairs) {
    console.log(`  target ${p.a}->${p.b}: "${p.verdict}" z=${p.z} reliable=${p.reliable ? 'yes' : 'no'} [${p.unreliableReasons.join(', ')}]`);
  }
  for (const f of fieldPairs) console.log(`  field ${f.a}->${f.b}: changed fraction ${f.fieldChangedFraction} (nField ${f.nField}) fieldReliable=${f.fieldReliable}`);
  const all = stars.flatMap((s) => s.pairs);
  const rel = all.filter((p) => p.reliable);
  const isVar = new Map(stars.map((st) => [st, st.variable === true]));
  const relNoVar = stars.filter((st) => !isVar.get(st)).flatMap((st) => st.pairs.filter((p) => p.reliable));
  console.log(`  results ${all.length}, reliable ${rel.length}; changed among reliable ${rate(rel)} (incl. variables), ${rate(relNoVar)} (excl. catalogued variables); variables ${stars.filter((st) => st.variable === true).length}, unknown ${stars.filter((st) => st.variable === null).length}`);
  for (const f of fieldPairs) {
    const r = rel.filter((p) => p.a === f.a && p.b === f.b);
    console.log(`    pair ${f.a}->${f.b}: reliable ${r.length}, changed ${rate(r)}`);
  }
  console.log(`  stars with brightNeighbour: ${stars.filter((s) => s.brightNeighbour).length}/${stars.length}; stars with any reliable result: ${stars.filter((s) => s.pairs.some((p) => p.reliable)).length}`);
}

interface Rebuilt { slug: string; file: string; bytes: number; count: number; note: string[] }

async function rebuildOne(slug: CachedSlug, detectorArg?: number): Promise<Rebuilt> {
  const samples = process.env.WP_SAMPLES_DIR ?? resolve(ROOT, '..', 'research', 'samples');
  const defDet = (JSON.parse(readFileSync(join(CACHE, slug, 'index.json'), 'utf8')) as { defaultDetector: number }).defaultDetector;
  const full = JSON.parse(readFileSync(join(samples, 'readouts', samplesName(slug, detectorArg ?? defDet, defDet)), 'utf8')) as {
    detector: number; visits: CachedReadouts['visits']; stars: { star: { id: string; isTarget: boolean; ra: number; dec: number; gmag: number | null }; blended: boolean; pairs: { a: number; b: number; result: Record<string, any> }[] }[];
  };
  const note: string[] = [];
  const dir = join(CACHE, slug);
  const indexPath = join(dir, 'index.json');
  const indexRaw = readFileSync(indexPath, 'utf8');
  const vByIdx = new Map(full.visits.map((v) => [v.visit, v]));
  const { gaia } = await loadCachedStars(slug, { baseUrl: '/cache/', fetchFn: diskFetch() });

  const varFlags = await gaiaVariableFlags(full.stars.map((fs) => fs.star.id));
  const stars: StarReadout[] = full.stars.map((fs) => {
    const s = fs.star;
    const matched = s.id !== 'target';
    if (s.isTarget && !matched) note.push('target has no Gaia match and no catalogue magnitude: its own bright-neighbour rule is evaluated against the Gaia list only');
    const pairs = fs.pairs.map((p) => trimPair(reviveResult(p.result), p.a, p.b, vByIdx.get(p.a)!.mjd, vByIdx.get(p.b)!.mjd));
    return {
      id: s.id, ra: dp(s.ra, 6) as number, dec: dp(s.dec, 6) as number, gmag: dp(nz(s.gmag), 2), isTarget: s.isTarget,
      brightNeighbour: hasBrightNeighbour({ ra: s.ra, dec: s.dec, sourceId: matched ? s.id : undefined }, gaia),
      variable: varFlags.get(s.id) ?? null,
      pairs,
    };
  });
  const fieldPairs = fieldPairsOf(stars);
  applyReliability(stars, fieldPairs);
  const detector = full.detector;
  const out: CachedReadouts = {
    format: READOUTS_FORMAT, slug, detector: detector as CachedReadouts['detector'], builtAt: new Date().toISOString(),
    visits: full.visits, stars, fieldPairs,
  };
  const body = new TextEncoder().encode(JSON.stringify(out));
  const file = `readouts.d${detector}.${fnv1a32(body)}.json`;
  const tmp = join(dir, `${file}.tmp`);
  writeFileSync(tmp, body);
  renameSync(tmp, join(dir, file));
  const count = stars.reduce((n, s) => n + s.pairs.length, 0);
  commitIndex(slug, detector, file, body.length, count, indexRaw, defDet);
  if (body.length > BUDGET_BYTES) note.push(`OVER BUDGET: ${body.length} bytes > ${BUDGET_BYTES}`);

  report(slug, file, body.length, stars, fieldPairs);
  for (const n of note) console.log(`  NOTE ${n}`);
  return { slug, file, bytes: body.length, count, note };
}

// ---- vector comparison ------------------------------------------------------------------------

interface VecExp { obs_id: string; lam: number; bw: number; accepted: boolean; reason: string; flux: number | null; var: number | null }
interface Vectors {
  visit_pair: { detector: number; visit_A: number; visit_B: number };
  stars: {
    source_id: number | string;
    gaia: { ra: number; dec: number; pmra: number; pmdec: number; epoch: number; G?: number };
    blended: boolean;
    exposures: Record<string, VecExp[]>;
    expected: { D: number; var: number; z: number; verdict: string; flags: string[]; n_w0: number; frac: number; n_exposures_A: number; n_exposures_B: number };
  }[];
}

async function vectorCompare(): Promise<void> {
  const vec = JSON.parse(readFileSync(join(ROOT, 'docs', 'algorithm_test_vectors.json'), 'utf8')) as Vectors;
  const { detector, visit_A, visit_B } = vec.visit_pair;
  const bytes0 = bytesTransferred();
  const t0 = Date.now();
  const rows: string[] = [];
  let allOk = true;
  for (const star of vec.stars) {
    const g = star.gaia;
    const target: Target = { ra: g.ra, dec: g.dec, pmra: g.pmra, pmdec: g.pmdec, epoch: g.epoch };
    const visitOf = new Map<string, number>();
    const vecOf = new Map<string, VecExp>();
    for (const [v, list] of Object.entries(star.exposures)) for (const e of list) { visitOf.set(e.obs_id, Number(v)); vecOf.set(e.obs_id, e); }
    const found = (await findAll(g.ra, g.dec)).filter((e) => e.detector === detector && visitOf.has(e.obsId));
    const exps = found.map((e) => ({ ...e, visitIndex: visitOf.get(e.obsId) as number }));
    const { stamps, failed } = await nativeStampsFor(exps, starPosition(target), HALF, { concurrency: CONCURRENCY });
    const byId = new Map(exps.map((e) => [e.id, e]));
    const recs: MatchedExposure[] = [];
    let setDiff = 0;
    for (const s of stamps) {
      const e = byId.get(s.exposureId) as Exposure;
      const m = measureStamp(s);
      recs.push({ id: e.obsId, visit: e.visitIndex, mjd: s.mjd, wavelength: s.wavelength, bandwidth: s.bandwidth, measurement: m });
      if (m.ok !== (vecOf.get(e.obsId) as VecExp).accepted) setDiff++;
    }
    const r = compareVisits(recs, visit_A, visit_B, { blended: star.blended });
    const x = star.expected;
    const okSet = setDiff <= 1 && exps.length === visitOf.size && failed.length === 0;
    const okVerdict = r.verdict === x.verdict;
    const dz = Math.abs(r.z - x.z);
    const ok = okSet && okVerdict && dz < 0.5;
    if (!ok) allOk = false;
    rows.push(
      `${String(star.source_id).padEnd(20)} G ${String(g.G !== undefined ? g.G.toFixed(2) : '-').padEnd(6)} exps ${exps.length}/${visitOf.size} failed ${failed.length} setDiff ${setDiff} | ` +
      `ours nA ${r.nExposuresA} nB ${r.nExposuresB} w0 ${r.nW0} D ${r.D.toFixed(4)} z ${r.z.toFixed(3)} frac ${r.fractionalChange.toFixed(5)} ps z ${r.ps.z.toFixed(3)} "${r.verdict}" [${r.flags}] | ` +
      `vector nA ${x.n_exposures_A} nB ${x.n_exposures_B} w0 ${x.n_w0} D ${x.D.toFixed(4)} z ${x.z.toFixed(3)} frac ${x.frac.toFixed(5)} "${x.verdict}" [${x.flags}] | dz ${dz.toFixed(3)} ${ok ? 'PASS' : 'FAIL'}`,
    );
  }
  console.log('\n== Vector comparison (detector 2, visits 0 vs 2, live SIA at each vector star, individual stamps) ==');
  for (const r of rows) console.log(r);
  console.log(`bytes ${bytesTransferred() - bytes0}, ${((Date.now() - t0) / 1000).toFixed(0)} s, overall ${allOk ? 'PASS' : 'FAIL'}`);
  process.exit(allOk ? 0 : 1);
}

// ---- crop self check --------------------------------------------------------------------------

async function selfCheck(slug: CachedSlug): Promise<void> {
  const entry = CHALLENGE_TARGETS.find((x) => x.slug === slug) as (typeof CHALLENGE_TARGETS)[number];
  const target: Target = { ra: entry.ra, dec: entry.dec, pmra: entry.pmra, pmdec: entry.pmdec, epoch: entry.epoch };
  const index = JSON.parse(readFileSync(join(CACHE, slug, 'index.json'), 'utf8')) as { defaultDetector: number; grid: Grid };
  const { gaia } = await loadCachedStars(slug, { baseUrl: '/cache/', fetchFn: diskFetch() });
  const stars = pickStars(target, index.grid, gaia).slice(0, 6);
  const found = (await findAll(target.ra, target.dec)).filter((e) => e.detector === index.defaultDetector && e.inStack !== false);
  const picks = [found[0], found[Math.floor(found.length / 2)], found[found.length - 1]];
  const reader = makeReader(index.grid, true);
  let compared = 0, mismatches = 0;
  for (const e of picks) {
    const c: Counters = { big: 0, bigFailed: 0, cropped: 0, individual: 0, noCoverage: 0, failed: 0 };
    const cropped = await reader.stamps(e, stars, c);
    for (let k = 0; k < stars.length; k++) {
      const a = cropped[k];
      const pos = positionAt(stars[k].target, e.mjd);
      let b: NativeStamp | null = null;
      try { b = await loadNativeStamp(e, pos.ra, pos.dec, HALF); } catch { b = null; }
      if (!a || !b) { if (!!a !== !!b) { mismatches++; console.log(`  presence differs ${e.id} star ${stars[k].id}`); } continue; }
      compared++;
      const same = (x: ArrayLike<number>, y: ArrayLike<number>) => { for (let i = 0; i < x.length; i++) if (!(x[i] === y[i] || (x[i] !== x[i] && y[i] !== y[i]))) return false; return true; };
      const ok = a.col0 === b.col0 && a.row0 === b.row0 && a.x === b.x && a.y === b.y && a.wavelength === b.wavelength && a.bandwidth === b.bandwidth
        && same(a.p, b.p) && same(a.variance, b.variance) && same(a.flags, b.flags);
      if (!ok) { mismatches++; console.log(`  MISMATCH ${e.id} star ${stars[k].id}`); }
    }
    console.log(`  ${e.id}: big ${c.big} cropped ${c.cropped} individual ${c.individual} noCoverage ${c.noCoverage}`);
  }
  console.log(`selfcheck ${slug}: ${compared} stamps compared, ${mismatches} mismatches`);
  process.exit(mismatches === 0 ? 0 : 1);
}

// ---- main -------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  setFetch(fetch);
  if (args.includes('--vectors')) return vectorCompare();
  const arg = args.find((a) => !a.startsWith('--'));
  if (args.includes('--rebuild')) {
    const list = arg === 'all' ? SLUGS : SLUGS.filter((x) => x === arg);
    if (list.length === 0) { console.error('usage: --rebuild <slug|all>'); process.exit(2); }
    for (const slug of list) for (const d of DETECTORS[slug] ?? [undefined]) await rebuildOne(slug, d);
    process.exit(0);
  }
  if (!arg) {
    console.error('usage: vite-node scripts/build-readouts.ts <slug|all> | --vectors | --selfcheck <slug>');
    process.exit(2);
  }
  if (args.includes('--selfcheck')) return selfCheck(arg as CachedSlug);
  const todo = arg === 'all' ? SLUGS : SLUGS.filter((s) => s === arg);
  if (todo.length === 0) {
    console.error(`unknown slug '${arg}'`);
    process.exit(2);
  }
  const sums: Summary[] = [];
  let code = 0;
  for (const slug of todo) {
    try {
      for (const d of DETECTORS[slug] ?? [undefined]) sums.push(await buildOne(slug, d));
    } catch (e) {
      code = 1;
      console.error(`ERROR ${slug}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }
  console.log('\n== Summary ==');
  console.log('slug | det | stars | visits (id:n) | exposures read | visit-pair slots | star-pair results | changed / no sig change / no result | downloaded | time s | output bytes');
  for (const s of sums) {
    console.log([
      s.slug, s.detector, s.stars, s.visits, s.exposures, s.pairs, s.results,
      `${s.verdicts['changed']} / ${s.verdicts['no significant change']} / ${s.verdicts['no result']}`,
      `${(s.bytes / 1048576).toFixed(1)} MB`, s.seconds.toFixed(0), s.outBytes,
    ].join(' | '));
    const c = s.counters;
    console.log(`   reads: big ${c.big} (failed ${c.bigFailed}), cropped ${c.cropped}, individual ${c.individual}, off detector ${c.noCoverage}, failed ${c.failed}`);
  }
  console.log('\n== Target star results (matched combined; plain pair and paired stack for comparison) ==');
  for (const s of sums) {
    console.log(`${s.slug}:`);
    for (const r of s.targetRows) console.log(`   ${r}`);
  }
  process.exit(code);
}

void main();
