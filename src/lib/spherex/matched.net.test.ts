// Live end-to-end run of the matched method for vector star Gaia DR3 4472838526141369856:
// real exposures -> native stamps -> measureStamp -> compareVisits, against
// docs/algorithm_test_vectors.json. Runs only with WP_NET_TESTS=1.
import { describe, expect, it } from 'vitest';
// @ts-ignore node types are not installed
import { readFileSync } from 'node:fs';
import { setFetch } from './fits';
import { nativeStampsFor, starPosition } from './native';
import { measureStamp } from './photometry';
import { compareVisits } from './matched';
import type { MatchedExposure } from './matched';
import { NET_TESTS } from './testdata';
import type { Exposure, Target } from './types';

const rel = (p: string): string => decodeURIComponent(new URL(`../../../${p}`, import.meta.url).pathname);

interface VecExp {
  obs_id: string; lam: number; bw: number; accepted: boolean; reason: string;
  flux: number | null; var: number | null;
}
interface Vectors {
  visit_pair: { detector: number; visit_A: number; visit_B: number };
  stars: {
    source_id: number;
    gaia: { ra: number; dec: number; pmra: number; pmdec: number; epoch: number };
    blended: boolean;
    exposures: Record<string, VecExp[]>;
    expected: { D: number; var: number; z: number; verdict: string; flags: string[]; n_w0: number };
  }[];
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

describe.skipIf(!NET_TESTS)('matched method end to end on real S3 data', () => {
  it('Gaia 4472838526141369856, Barnard field, detector 2, visits 0 vs 2', async () => {
    setFetch(fetch);
    const vec = JSON.parse(readFileSync(rel('docs/algorithm_test_vectors.json'), 'utf8')) as Vectors;
    const { detector, visit_A, visit_B } = vec.visit_pair;
    const star = vec.stars.find((s) => s.source_id === 4472838526141369856)!;
    const manifest = JSON.parse(readFileSync(rel('public/cache/barnards-star/manifest.json'), 'utf8')) as {
      exposures: Exposure[];
    };

    // exactly the vector's exposures, tagged with their visit
    const visitOf = new Map<string, number>();
    const vecOf = new Map<string, VecExp>();
    for (const [v, list] of Object.entries(star.exposures)) {
      for (const e of list) { visitOf.set(e.obs_id, Number(v)); vecOf.set(e.obs_id, e); }
    }
    // The Barnard manifest holds most of them; the rest come from a live SIA query at the star
    // (the manifest only lists exposures that cover Barnard's Star itself).
    const exps = manifest.exposures.filter((e) => e.detector === detector && visitOf.has(e.obsId));
    const have = new Set(exps.map((e) => e.obsId));
    const missing = [...visitOf.keys()].filter((id) => !have.has(id));
    if (missing.length > 0) {
      // @ts-ignore plain JS module
      const sia = (await import('../../../api/_lib/sia.js')) as {
        buildSiaUrl: (c: string, ra: number, dec: number) => string;
        parseVotable: (x: string) => Record<string, string>[];
        rowsToExposures: (r: Record<string, string>[]) => { obsId: string; detector: number; tMin: number; tMax: number; url: string; release: string }[];
        dedupe: <T>(e: T[]) => T[];
      };
      const rows: Record<string, string>[] = [];
      for (const c of ['spherex_dr1', 'spherex_qr3']) {
        const res = await fetch(sia.buildSiaUrl(c, star.gaia.ra, star.gaia.dec));
        if (res.ok) rows.push(...sia.parseVotable(await res.text()));
      }
      for (const f of sia.dedupe(sia.rowsToExposures(rows))) {
        if (f.detector !== detector || !missing.includes(f.obsId)) continue;
        const mjd = (f.tMin + f.tMax) / 2;
        exps.push({
          id: `${f.obsId}D${f.detector}`, obsId: f.obsId, detector: f.detector as Exposure['detector'],
          time: '', mjd, visitIndex: visitOf.get(f.obsId)!, wavelengthAtTarget: null, bandwidthAtTarget: null,
          url: f.url, release: f.release as Exposure['release'],
        });
      }
      console.log(`${missing.length} exposures not in the manifest, ${exps.length - have.size} found by live SIA`);
    }
    expect(exps.length).toBe(visitOf.size);

    const g = star.gaia;
    const target: Target = { ra: g.ra, dec: g.dec, pmra: g.pmra, pmdec: g.pmdec, epoch: g.epoch };
    const t0 = Date.now();
    const { stamps, failed } = await nativeStampsFor(exps, starPosition(target), 8, { concurrency: 6 });
    const secs = (Date.now() - t0) / 1000;
    const totalBytes = stamps.reduce((a, s) => a + s.bytes, 0);
    console.log(`stamps ${stamps.length}/${exps.length} (failed ${failed.length}), ${totalBytes} bytes, ${secs.toFixed(1)} s total, ` +
      `${Math.round(totalBytes / Math.max(1, stamps.length))} bytes and ${(secs / Math.max(1, stamps.length)).toFixed(2)} s per stamp`);
    for (const f of failed) console.log(`FAILED ${f.exposure.id}: ${f.error.code} ${f.error.message}`);

    const records: MatchedExposure[] = [];
    const byId = new Map(exps.map((e) => [e.id, e]));
    const rows: string[] = [];
    const relFlux: number[] = [];
    const relVar: number[] = [];
    const dLam: number[] = [];
    let setDiff = 0;
    for (const s of stamps) {
      const e = byId.get(s.exposureId)!;
      const v = vecOf.get(e.obsId)!;
      const m = measureStamp(s);
      records.push({ id: e.obsId, visit: visitOf.get(e.obsId)!, mjd: s.mjd, wavelength: s.wavelength, bandwidth: s.bandwidth, measurement: m });
      const dl = s.wavelength - v.lam;
      dLam.push(Math.abs(dl));
      if (m.ok !== v.accepted) setDiff++;
      let fr = '', vr = '';
      if (m.ok && v.accepted && v.flux !== null && v.var !== null) {
        const a = Math.abs(m.flux / v.flux - 1), b = Math.abs(m.variance / v.var - 1);
        relFlux.push(a); relVar.push(b);
        fr = (a * 100).toFixed(2) + '%'; vr = (b * 100).toFixed(2) + '%';
      }
      rows.push(
        `${e.obsId.padEnd(18)} v${visitOf.get(e.obsId)} dlam=${(dl * 1000).toFixed(2).padStart(7)}nm ` +
        `acc ${m.ok ? 'Y' : 'n'}/${v.accepted ? 'Y' : 'n'} ${m.ok ? '' : m.reason} ` +
        `flux ${m.ok ? m.flux.toFixed(3) : '-'}/${v.flux ?? '-'} dF ${fr} var ${m.ok ? m.variance.toFixed(4) : '-'}/${v.var ?? '-'} dV ${vr}`,
      );
    }
    console.log(rows.join('\n'));
    console.log(
      `per-exposure: |dlam| median ${(median(dLam) * 1000).toFixed(2)} nm max ${(Math.max(...dLam) * 1000).toFixed(2)} nm; ` +
      `flux rel diff median ${(median(relFlux) * 100).toFixed(3)}% max ${(Math.max(...relFlux) * 100).toFixed(3)}%; ` +
      `var rel diff median ${(median(relVar) * 100).toFixed(3)}% max ${(Math.max(...relVar) * 100).toFixed(3)}%; ` +
      `accepted-set differences ${setDiff}`,
    );

    const r = compareVisits(records, visit_A, visit_B, { blended: star.blended });
    const x = star.expected;
    console.log(
      `combined      ours: D=${r.D.toFixed(4)} var=${r.var.toFixed(4)} sigma=${Math.sqrt(r.var).toFixed(4)} z=${r.z.toFixed(3)} n_w0=${r.nW0} verdict="${r.verdict}" flags=[${r.flags}]\n` +
      `              vector: D=${x.D} var=${x.var} sigma=${Math.sqrt(x.var).toFixed(4)} z=${x.z} n_w0=${x.n_w0} verdict="${x.verdict}" flags=[${x.flags}]`,
    );

    expect(failed.length).toBe(0);
    expect(setDiff).toBeLessThanOrEqual(1);
    expect(r.verdict).toBe(x.verdict);
    expect(Math.abs(r.z - x.z)).toBeLessThan(0.5);
  }, 180000);
});
