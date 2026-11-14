// Astrometric acceptance test on the real Barnard's Star pair (network, S3 Range requests).
// @ts-ignore node types are not installed
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bytesTransferred, walkHdus } from './fits';
import { loadFrame } from './frame';
import { makeGrid, positionAt, worldToGrid } from './wcs';
import type { Exposure, Frame, Target } from './types';

const DIR = '/Users/samir/Desktop/spaceapps/research/samples/spherex-tests/';
const keys = JSON.parse(readFileSync(DIR + 'keys.json', 'utf8'));
const gaia = JSON.parse(readFileSync(DIR + 'gaia_stars.json', 'utf8'));
const oracle = JSON.parse(readFileSync(DIR + 'oracle.json', 'utf8'));
const IDS = ['2025W35_2A_0221_2', '2026W34_2A_0233_3'];
const ORACLE_WAVE = [1.392689, 1.34421];

const median = (a: number[]): number => {
  const s = a.filter(Number.isFinite).sort((p, q) => p - q);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function centroid(f: Frame, px: number, py: number): [number, number] | null {
  const { w, h, pixels } = f;
  const get = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? NaN : pixels[y * w + x]);
  let cx = px, cy = py;
  for (let it = 0; it < 2; it++) {
    const rx = Math.round(cx), ry = Math.round(cy);
    const bg: number[] = [];
    for (let y = ry - 7; y <= ry + 7; y++) {
      for (let x = rx - 7; x <= rx + 7; x++) {
        const r = Math.hypot(x - rx, y - ry);
        const v = get(x, y);
        if (r >= 4 && r <= 7 && Number.isFinite(v)) bg.push(v);
      }
    }
    if (bg.length < 10) return null;
    const b = median(bg);
    let sw = 0, sx = 0, sy = 0;
    for (let y = ry - 2; y <= ry + 2; y++) {
      for (let x = rx - 2; x <= rx + 2; x++) {
        const v = get(x, y);
        if (!Number.isFinite(v)) continue;
        const wgt = v - b;
        if (wgt <= 0) continue;
        sw += wgt; sx += wgt * x; sy += wgt * y;
      }
    }
    if (sw <= 0) return null;
    cx = sx / sw; cy = sy / sw;
  }
  return [cx, cy];
}

describe('astrometric acceptance (network)', () => {
  it('Barnard pair: Gaia stars land where predicted on the common grid', async () => {
    const barnard: Target = { ra: 269.45207696, dec: 4.69336497, pmra: -801.551, pmdec: 10362.394, epoch: 2000, name: "Barnard's Star" };
    const exps: Exposure[] = [];
    for (const id of IDS) {
      const k = keys[id];
      const hdus = await walkHdus(k.url);
      const img = hdus.find((h) => h.extname === 'IMAGE');
      const mjd = Number(img?.header['MJD-AVG'] ?? oracle[id].mjd);
      exps.push({
        id: id + 'D2', obsId: id, detector: 2, time: String(img?.header['DATE-AVG'] ?? ''), mjd,
        visitIndex: 0, wavelengthAtTarget: null, bandwidthAtTarget: null, url: k.url, release: k.release,
      });
    }
    console.log('MJD-AVG', exps.map((e) => e.mjd), 'oracle mjd', IDS.map((i) => oracle[i].mjd));
    const grid = makeGrid(barnard, exps);
    console.log('grid', JSON.stringify(grid));

    const frames: Frame[] = [];
    for (const e of exps) {
      const b0 = bytesTransferred();
      const t0 = Date.now();
      const f = await loadFrame(e, grid);
      console.log(`loadFrame ${e.obsId}: ${bytesTransferred() - b0} bytes, ${Date.now() - t0} ms, coverage ${f.coverage.toFixed(3)}, wavelength ${f.exposure.wavelengthAtTarget} bw ${f.exposure.bandwidthAtTarget}, flagged px ${f.flags.filter((v) => v !== 0).length}`);
      frames.push(f);
    }

    const rows: { id: string; g: number; pos: ([number, number] | null)[]; off: ([number, number] | null)[] }[] = [];
    const lines: string[] = ['source_id            G     | dx0     dy0     | dx1     dy1     | ff_dx   ff_dy   | measured0       measured1'];
    for (const s of gaia.stars) {
      const star: Target = { ra: s.ra, dec: s.dec, pmra: s.pmra, pmdec: s.pmdec, epoch: 2016.0 };
      const pos: ([number, number] | null)[] = [];
      const off: ([number, number] | null)[] = [];
      let skip = false;
      frames.forEach((f) => {
        const p = positionAt(star, f.exposure.mjd);
        const [gx, gy] = worldToGrid(grid, p.ra, p.dec);
        if (gx < 4 || gy < 4 || gx > grid.w - 5 || gy > grid.h - 5) { skip = true; pos.push(null); off.push(null); return; }
        const c = centroid(f, gx, gy);
        pos.push(c);
        off.push(c ? [c[0] - gx, c[1] - gy] : null);
      });
      if (skip) { console.log('skip (near edge)', s.source_id); continue; }
      rows.push({ id: s.source_id, g: s.gmag, pos, off });
      const [o0, o1] = off;
      const f = (v: number | undefined): string => (v === undefined || !Number.isFinite(v) ? '   nan ' : v.toFixed(2).padStart(6) + ' ');
      const ffx = o0 && o1 ? o1[0] - o0[0] : NaN;
      const ffy = o0 && o1 ? o1[1] - o0[1] : NaN;
      lines.push(`${s.source_id} ${s.gmag.toFixed(1)} | ${f(o0?.[0])} ${f(o0?.[1])} | ${f(o1?.[0])} ${f(o1?.[1])} | ${f(ffx)} ${f(ffy)} | ${pos[0] ? pos[0].map((v) => v.toFixed(2)).join(',') : 'none'}   ${pos[1] ? pos[1].map((v) => v.toFixed(2)).join(',') : 'none'}`);
    }
    console.log(lines.join('\n'));

    const med = (sel: (r: (typeof rows)[number]) => number | undefined, filt: (r: (typeof rows)[number]) => boolean): number =>
      median(rows.filter(filt).map((r) => Math.abs(sel(r) ?? NaN)));
    const all = (): boolean => true;
    const bright = (r: (typeof rows)[number]): boolean => r.g <= 15.5;
    const stats = {
      n: rows.length, nBright: rows.filter(bright).length,
      f0x: med((r) => r.off[0]?.[0], all), f0y: med((r) => r.off[0]?.[1], all),
      f1x: med((r) => r.off[1]?.[0], all), f1y: med((r) => r.off[1]?.[1], all),
      ffx: med((r) => (r.off[0] && r.off[1] ? r.off[1][0] - r.off[0][0] : undefined), all),
      ffy: med((r) => (r.off[0] && r.off[1] ? r.off[1][1] - r.off[0][1] : undefined), all),
      b0x: med((r) => r.off[0]?.[0], bright), b0y: med((r) => r.off[0]?.[1], bright),
      b1x: med((r) => r.off[1]?.[0], bright), b1y: med((r) => r.off[1]?.[1], bright),
      bffx: med((r) => (r.off[0] && r.off[1] ? r.off[1][0] - r.off[0][0] : undefined), bright),
      bffy: med((r) => (r.off[0] && r.off[1] ? r.off[1][1] - r.off[0][1] : undefined), bright),
    };
    console.log('median |offset| (px) all stars', JSON.stringify(stats));

    // wavelengths
    frames.forEach((f, i) => {
      console.log(`wavelength ${IDS[i]}: ${f.exposure.wavelengthAtTarget} um (oracle ${ORACLE_WAVE[i]}) bw ${f.exposure.bandwidthAtTarget}`);
      expect(Math.abs((f.exposure.wavelengthAtTarget as number) - ORACLE_WAVE[i])).toBeLessThan(0.003);
    });

    // orientation: north star (larger dec) has smaller measured y
    const n = rows.find((r) => r.id === gaia.north_pair.north);
    const sth = rows.find((r) => r.id === gaia.north_pair.south);
    if (n && sth) {
      for (let i = 0; i < 2; i++) {
        const a = n.pos[i], b = sth.pos[i];
        if (a && b) {
          console.log(`orientation frame ${i}: north y=${a[1].toFixed(2)} south y=${b[1].toFixed(2)}`);
          expect(a[1]).toBeLessThan(b[1]);
        }
      }
    } else {
      console.log('north pair not both usable (edge/skip)');
    }

    expect(rows.length).toBeGreaterThanOrEqual(5);
    // PASS criteria use the bright subset when it has >= 5 stars, else all.
    const useB = stats.nBright >= 5;
    const lim = 0.5;
    const pick = (a: number, b: number): number => (useB ? b : a);
    expect(pick(stats.f0x, stats.b0x)).toBeLessThan(lim);
    expect(pick(stats.f0y, stats.b0y)).toBeLessThan(lim);
    expect(pick(stats.f1x, stats.b1x)).toBeLessThan(lim);
    expect(pick(stats.f1y, stats.b1y)).toBeLessThan(lim);
    expect(pick(stats.ffx, stats.bffx)).toBeLessThan(lim);
    expect(pick(stats.ffy, stats.bffy)).toBeLessThan(lim);
  }, 180000);
});
