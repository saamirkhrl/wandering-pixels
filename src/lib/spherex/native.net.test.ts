// Network test: one real Barnard-field exposure, Gaia DR3 4472838526141369856 (see
// docs/algorithm_test_vectors.json). Runs only with WP_NET_TESTS=1.
import { describe, expect, it } from 'vitest';
// @ts-ignore node types are not installed
import { readFileSync } from 'node:fs';
import { bytesTransferred, setFetch } from './fits';
import { loadNativeStamp } from './native';
import { positionAt } from './wcs';
import { NET_TESTS } from './testdata';
import type { Exposure, Target } from './types';

const rel = (p: string): string => decodeURIComponent(new URL(`../../../${p}`, import.meta.url).pathname);
const OBS = '2025W34_2B_0090_4';

interface VecExp { obs_id: string; x: number; y: number; lam: number; accepted: boolean }
interface Vectors {
  stars: { source_id: number; gaia: Target & { parallax?: number }; exposures: Record<string, VecExp[]> }[];
}

describe.skipIf(!NET_TESTS)('loadNativeStamp against real S3', () => {
  it('Gaia 4472838526141369856 in visit-A exposure 2025W34_2B_0090_4, detector 2, half 10', async () => {
    setFetch(fetch);
    const manifest = JSON.parse(readFileSync(rel('public/cache/barnards-star/manifest.json'), 'utf8')) as {
      exposures: Exposure[];
    };
    const exposure = manifest.exposures.find((e) => e.obsId === OBS && e.detector === 2);
    expect(exposure).toBeDefined();
    const vec = JSON.parse(readFileSync(rel('docs/algorithm_test_vectors.json'), 'utf8')) as Vectors;
    const star = vec.stars.find((s) => s.source_id === 4472838526141369856)!;
    const g = star.gaia;
    const ve = Object.values(star.exposures).flat().find((e) => e.obs_id === OBS)!;
    const target: Target = { ra: g.ra, dec: g.dec, pmra: g.pmra, pmdec: g.pmdec, epoch: g.epoch };
    const pos = positionAt(target, exposure!.mjd);

    const half = 10;
    const b0 = bytesTransferred();
    const t0 = Date.now();
    const s = await loadNativeStamp(exposure!, pos.ra, pos.dec, half);
    const ms = Date.now() - t0;
    const counted = bytesTransferred() - b0;
    // second call on the same file: headers and wave table cached
    const t1 = Date.now();
    const s2 = await loadNativeStamp(exposure!, pos.ra, pos.dec, half);
    const ms2 = Date.now() - t1;
    console.log(
      `stamp ${s.size}x${s.size} at col0=${s.col0} row0=${s.row0} x=${s.x.toFixed(3)} y=${s.y.toFixed(3)}: ` +
      `${s.bytes} bytes (${counted} counted), ${ms} ms cold; warm ${s2.bytes} bytes, ${ms2} ms; ` +
      `lam=${s.wavelength.toFixed(4)} bw=${s.bandwidth.toFixed(4)} (vector lam ${ve.lam})`,
    );

    // pixel-centre convention: the fractional offset from the nearest pixel matches the vector's
    // (its x, y are in cutout pixels, same convention, different origin)
    expect(s.x - half).toBeCloseTo(ve.x - Math.round(ve.x), 1);
    expect(s.y - half).toBeCloseTo(ve.y - Math.round(ve.y), 1);

    // p finite near the star, and the star is the local maximum within 1.5 px of (x, y)
    let best = -Infinity, bi = -1, bj = -1;
    for (let j = 0; j < s.size; j++) {
      for (let i = 0; i < s.size; i++) {
        const dx = i - s.x, dy = j - s.y;
        if (dx * dx + dy * dy > 1.5 * 1.5) continue;
        const v = s.p[j * s.size + i];
        expect(Number.isFinite(v)).toBe(true);
        if (v > best) { best = v; bi = i; bj = j; }
      }
    }
    const isMax = (i: number, j: number): boolean => {
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (s.p[(j + dj) * s.size + i + di] > s.p[j * s.size + i]) return false;
      }
      return true;
    };
    console.log(`peak ${best.toFixed(3)} MJy/sr at stamp (${bi}, ${bj}); local max=${isMax(bi, bj)}`);
    expect(isMax(bi, bj)).toBe(true);
    expect(best).toBeGreaterThan(5 * Math.sqrt(s.variance[bj * s.size + bi]));

    const distinct = [...new Set(Array.from(s.flags))].sort((a, b) => a - b);
    console.log(`distinct raw flags: ${distinct.map((v) => '0x' + v.toString(16)).join(' ')}`);
    expect(s.flags).toBeInstanceOf(Uint32Array);

    if (Number.isFinite(ve.lam)) expect(Math.abs(s.wavelength - ve.lam)).toBeLessThan(0.005);
    expect(s2.p).toEqual(s.p);
  }, 60000);
});
