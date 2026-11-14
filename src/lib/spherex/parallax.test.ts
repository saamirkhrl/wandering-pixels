// Oracle: astropy 7 + numpy. E(t) = get_body_barycentric('earth', t) - get_body_barycentric('sun', t)
// with t = Time(mjd, format='mjd', scale='tt') (builtin ERFA ephemeris), ICRS xyz in au. The
// oracle apparent direction is normalize(D * u - E), u the unit vector of (ra, dec); dRa is the
// wrapped RA difference times cos(dec). Ecliptic inputs were converted with
// SkyCoord(..., frame=BarycentricMeanEcliptic(equinox='J2000')).icrs. Numbers pasted verbatim.
import { describe, it, expect } from 'vitest';
import {
  parallaxOffset, positionAtDistance, gridAt, trackingTolerance, earthHeliocentric, motionFromPair,
} from './parallax';
import { worldToGrid } from './wcs';
import type { Grid, TrackingMotion } from './types';

const CASES = [
  { label: 'ecl lon 30.0 lat 0.0', ra: 27.910547921516, dec: 11.471973130734, mjd: 60700.0, d: 300.0, raApp: 27.731681499237, decApp: 11.406094662653, dRa: -1.752930486459e-01, dDec: -6.587846808126e-02 },
  { label: 'ecl lon 200.0 lat 0.0', ra: 198.466026153586, dec: -7.819214716840, mjd: 61000.0, d: 500.0, raApp: 198.531907806751, decApp: -7.845792770260, dRa: 6.526910341920e-02, dDec: -2.657805341951e-02 },
  { label: 'ecl lon 100.0 lat 30.0', ra: 104.449719206534, dec: 52.938829227267, mjd: 60800.0, d: 300.0, raApp: 104.178115283695, decApp: 52.902719713354, dRa: -1.636868105450e-01, dDec: -3.610951391340e-02 },
  { label: 'ecl lon 300.0 lat -30.0', ra: 311.512129276653, dec: -49.206903467700, mjd: 61150.0, d: 500.0, raApp: 311.679628439696, decApp: -49.171332076444, dRa: 1.094321260572e-01, dDec: 3.557139125633e-02 },
  { label: 'ecl lon 150.0 lat 60.0', ra: 194.887473023348, dec: 63.381171592774, mjd: 61300.0, d: 300.0, raApp: 194.737816241277, decApp: 63.224545214353, dRa: -6.705415499658e-02, dDec: -1.566263784212e-01 },
  { label: 'ecl lon 10.0 lat -60.0', ra: 40.740789781295, dec: -49.466504751910, mjd: 60900.0, d: 500.0, raApp: 40.909973221160, decApp: -49.464647648985, dRa: 1.099510440321e-01, dDec: 1.857102924596e-03 },
  { label: 'ecl lon 250.0 lat 0.0', ra: 248.361496306239, dec: -21.949432196908, mjd: 61400.0, d: 300.0, raApp: 248.442204848002, decApp: -21.960499997120, dRa: 7.485831142041e-02, dDec: -1.106780021191e-02 },
  { label: 'Barnard field mjd 60916.658', ra: 269.45, dec: 4.77, mjd: 60916.658, d: 500.0, raApp: 269.343262408796, decApp: 4.791984402013, dRa: -1.063679094283e-01, dDec: 2.198440201323e-02 },
  { label: 'Barnard field mjd 61273.653', ra: 269.45, dec: 4.77, mjd: 61273.653, d: 500.0, raApp: 269.350466021278, decApp: 4.798779101831, dRa: -9.918924639611e-02, dDec: 2.877910183063e-02 },
];

const EARTH = [
  { mjd: 60700.0, xyz: [-0.563434072648, 0.740729985346, 0.321102404762] },
  { mjd: 60800.0, xyz: [-0.720404164038, -0.647509192662, -0.280681360466] },
  { mjd: 60900.0, xyz: [0.777987946796, -0.595469294488, -0.258131059712] },
  { mjd: 61000.0, xyz: [0.515273148277, 0.773457146909, 0.335280005014] },
  { mjd: 61150.0, xyz: [-0.873698229955, -0.454807541710, -0.197148294521] },
  { mjd: 61300.0, xyz: [0.999314540155, -0.100167929597, -0.043424301709] },
  { mjd: 61400.0, xyz: [-0.065731935493, 0.900347394660, 0.390280825851] },
  { mjd: 60916.658, xyz: [0.924011545404, -0.373734273707, -0.162009793169] },
  { mjd: 61273.653, xyz: [0.860106133093, -0.488535380008, -0.211773573108] },
];

const D2R = Math.PI / 180;
const AS = 3600;

function sepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a = [Math.cos(dec1 * D2R) * Math.cos(ra1 * D2R), Math.cos(dec1 * D2R) * Math.sin(ra1 * D2R), Math.sin(dec1 * D2R)];
  const b = [Math.cos(dec2 * D2R) * Math.cos(ra2 * D2R), Math.cos(dec2 * D2R) * Math.sin(ra2 * D2R), Math.sin(dec2 * D2R)];
  const cross = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.atan2(cross, dot) / D2R * AS;
}

describe('earthHeliocentric vs astropy', () => {
  it('direction < 0.01 deg and radius < 2e-4 au', () => {
    let maxAng = 0, maxDr = 0;
    for (const e of EARTH) {
      const v = earthHeliocentric(e.mjd);
      const r = Math.hypot(...v), r0 = Math.hypot(e.xyz[0], e.xyz[1], e.xyz[2]);
      const dot = (v[0] * e.xyz[0] + v[1] * e.xyz[1] + v[2] * e.xyz[2]) / (r * r0);
      const ang = Math.acos(Math.min(1, dot)) / D2R;
      maxAng = Math.max(maxAng, ang);
      maxDr = Math.max(maxDr, Math.abs(r - r0));
      expect(ang).toBeLessThan(0.01);
      expect(Math.abs(r - r0)).toBeLessThan(2e-4);
    }
    console.log(`earth max direction error ${(maxAng * AS).toFixed(2)} arcsec, max radius error ${maxDr.toExponential(2)} au`);
  });
});

describe('parallaxOffset / positionAtDistance vs astropy', () => {
  it('within 0.5 arcsec on dRa and dDec', () => {
    let worst = 0;
    for (const c of CASES) {
      const o = parallaxOffset(c.ra, c.dec, c.mjd, c.d);
      const eRa = Math.abs(o.dRa - c.dRa) * AS, eDec = Math.abs(o.dDec - c.dDec) * AS;
      worst = Math.max(worst, eRa, eDec);
      expect(eRa, c.label).toBeLessThan(0.5);
      expect(eDec, c.label).toBeLessThan(0.5);
      const p = positionAtDistance(c.ra, c.dec, c.mjd, c.d);
      expect(sepArcsec(p.ra, p.dec, c.raApp, c.decApp), c.label).toBeLessThan(0.5);
    }
    console.log(`oracle max |dRa|,|dDec| residual ${worst.toFixed(3)} arcsec`);
  });

  it('dRa is consistent with positionAtDistance and the wrapped RA difference', () => {
    const o = parallaxOffset(0.001, 10, 60700, 300);
    const p = positionAtDistance(0.001, 10, 60700, 300);
    let dra = p.ra - 0.001;
    if (dra > 180) dra -= 360;
    expect(o.dRa).toBeCloseTo(dra * Math.cos(10 * D2R), 12);
    expect(Math.abs(o.dRa)).toBeLessThan(1);
  });
});

describe('degenerate distances', () => {
  it('Infinity, 0, NaN, negative and undefined give zero offset', () => {
    for (const d of [Infinity, 0, NaN, -5, undefined as unknown as number]) {
      expect(parallaxOffset(10, 20, 60700, d)).toEqual({ dRa: 0, dDec: 0 });
    }
  });
  it('positionAtDistance returns the input position for an invalid distance', () => {
    const p = positionAtDistance(10, 20, 60700, Infinity);
    expect(p.ra).toBeCloseTo(10, 12);
    expect(p.dec).toBeCloseTo(20, 12);
  });
});

describe('size of the offset', () => {
  it('is about 206265 |E| sin(elongation) / D arcsec', () => {
    for (const c of CASES) {
      const E = earthHeliocentric(c.mjd);
      const rE = Math.hypot(...E);
      const u = [Math.cos(c.dec * D2R) * Math.cos(c.ra * D2R), Math.cos(c.dec * D2R) * Math.sin(c.ra * D2R), Math.sin(c.dec * D2R)];
      const cosT = (u[0] * E[0] + u[1] * E[1] + u[2] * E[2]) / rE;
      const expected = 206264.806 * rE * Math.sqrt(1 - cosT * cosT) / c.d;
      const p = positionAtDistance(c.ra, c.dec, c.mjd, c.d);
      const got = sepArcsec(c.ra, c.dec, p.ra, p.dec);
      expect(Math.abs(got - expected) / expected, c.label).toBeLessThan(0.01);
    }
  });
  it('scales as 1/D', () => {
    const a = parallaxOffset(30, 10, 60700, 300), b = parallaxOffset(30, 10, 60700, 600);
    expect(Math.hypot(a.dRa, a.dDec) / Math.hypot(b.dRa, b.dDec)).toBeCloseTo(2, 2);
  });
});

describe('gridAt', () => {
  const base: Grid = { ra0: 269.45, dec0: 4.77, w: 65, h: 65, scaleArcsec: 6.15, epochMjd: 61000 };

  it('keeps w, h and scale, sets epochMjd, and does not mutate base', () => {
    const g = gridAt(base, 60916.658, 500);
    expect(g.w).toBe(65);
    expect(g.h).toBe(65);
    expect(g.scaleArcsec).toBe(6.15);
    expect(g.epochMjd).toBe(60916.658);
    expect(base.ra0).toBe(269.45);
    expect(base.epochMjd).toBe(61000);
  });

  it('without referenceMjd the centre is the apparent position of base', () => {
    const g = gridAt(base, 60916.658, 500);
    const p = positionAtDistance(base.ra0, base.dec0, 60916.658, 500);
    expect(sepArcsec(g.ra0, g.dec0, p.ra, p.dec)).toBeLessThan(1e-6);
    expect(sepArcsec(g.ra0, g.dec0, 269.343262408796, 4.791984402013)).toBeLessThan(0.5);
  });

  it('referenceMjd round trip is < 0.01 arcsec', () => {
    for (const [ref, d] of [[60916.658, 500], [61273.653, 300], [60700, 50]] as const) {
      const g = gridAt(base, ref, d, ref);
      expect(sepArcsec(g.ra0, g.dec0, base.ra0, base.dec0)).toBeLessThan(0.01);
    }
  });

  it('referenceMjd solves the heliocentric direction consistently at another date', () => {
    const ref = 60916.658, other = 61273.653, d = 500;
    const g = gridAt(base, other, d, ref);
    // The solved h satisfies apparent(h, ref) = base; the shift of the centre between the two
    // dates must match the change of the parallax offset (offsets near base differ from those at
    // h only at second order).
    const gRef = gridAt(base, ref, d, ref);
    expect(sepArcsec(gRef.ra0, gRef.dec0, base.ra0, base.dec0)).toBeLessThan(0.01);
    const shift = sepArcsec(g.ra0, g.dec0, base.ra0, base.dec0);
    const oA = parallaxOffset(base.ra0, base.dec0, ref, d), oB = parallaxOffset(base.ra0, base.dec0, other, d);
    const expected = Math.hypot(oB.dRa - oA.dRa, oB.dDec - oA.dDec) * AS;
    expect(Math.abs(shift - expected)).toBeLessThan(0.05);
  });

  it('invalid distance returns a copy with the same centre and the new epoch', () => {
    for (const d of [Infinity, 0, NaN, -1]) {
      const g = gridAt(base, 60000, d, 60916.658);
      expect(g).toEqual({ ...base, epochMjd: 60000 });
      expect(g).not.toBe(base);
    }
  });
});

describe('trackingTolerance', () => {
  it('about 1.3 px per percent at 500 au over 6 months near the ecliptic', () => {
    // Ecliptic lon 90 deg, lat 0 at J2000 -> ra 90, dec 23.4392911. Dates near the two
    // quadratures (elongation ~ 90 deg), about half a year apart.
    const t = trackingTolerance(500, 60755, 60938, 90, 23.4392911).pxPerPercent;
    expect(t).toBeGreaterThan(1.0);
    expect(t).toBeLessThan(1.5);
  });
  it('zero for the same date and for invalid distances', () => {
    expect(trackingTolerance(500, 60900, 60900, 10, 10).pxPerPercent).toBeCloseTo(0, 12);
    expect(trackingTolerance(Infinity, 60900, 61000, 10, 10).pxPerPercent).toBe(0);
  });
});

// Linear heliocentric motion. Synthetic body: heliocentric direction (90, 23.4392911) at the
// reference date (ecliptic lon 90, lat 0), D = 500 au, motion (100, 58.8) arcsec/yr, i.e.
// 116.1 arcsec/yr total. Reference MJD 60755 and 60755 + 182.625 sit near the two quadratures,
// where the parallax change over half a year is largest.
describe('gridAt with linear motion', () => {
  const RA = 90, DEC = 23.4392911, D = 500, REF = 60755;
  const MOTION: TrackingMotion = { dRaArcsecPerYr: 100, dDecArcsecPerYr: 58.8 };
  const HALF = REF + 182.625, FULL = REF + 365.25;

  // Independent forward model written out here: u(t) on the tangent plane at u_ref, then
  // normalize(D u(t) - E(t)) with E from earthHeliocentric.
  function bodyAt(mjd: number, d = D): { ra: number; dec: number } {
    const a = RA * D2R, dc = DEC * D2R;
    const u = [Math.cos(dc) * Math.cos(a), Math.cos(dc) * Math.sin(a), Math.sin(dc)];
    const e = [-Math.sin(a), Math.cos(a), 0];
    const n = [-Math.sin(dc) * Math.cos(a), -Math.sin(dc) * Math.sin(a), Math.cos(dc)];
    const k = (mjd - REF) / 365.25 * D2R / AS;
    const x = MOTION.dRaArcsecPerYr * k, y = MOTION.dDecArcsecPerYr * k;
    const v = [0, 1, 2].map((i) => u[i] + x * e[i] + y * n[i]);
    const nv = Math.hypot(v[0], v[1], v[2]);
    const E = earthHeliocentric(mjd);
    const w = [0, 1, 2].map((i) => d * v[i] / nv - E[i]);
    const nw = Math.hypot(w[0], w[1], w[2]);
    let ra = Math.atan2(w[1], w[0]) / D2R;
    if (ra < 0) ra += 360;
    return { ra, dec: Math.asin(w[2] / nw) / D2R };
  }

  const start = bodyAt(REF);
  const base: Grid = { ra0: start.ra, dec0: start.dec, w: 65, h: 65, scaleArcsec: 6.15, epochMjd: REF };

  function offPx(g: Grid, mjd: number): number {
    const b = bodyAt(mjd);
    const [x, y] = worldToGrid(g, b.ra, b.dec);
    return Math.hypot(x - (g.w - 1) / 2, y - (g.h - 1) / 2);
  }

  it('distance + motion keeps the body within 0.2 px of the centre at 0, 0.5 and 1 yr', () => {
    const offs = [REF, HALF, FULL].map((t) => offPx(gridAt(base, t, D, REF, MOTION), t));
    console.log(`motion tracking offsets (px) at 0, 0.5, 1 yr: ${offs.map((o) => o.toExponential(2)).join(', ')}`);
    for (const o of offs) expect(o).toBeLessThan(0.2);
  });

  it('distance only (no motion) is off by about 9 px at 0.5 yr', () => {
    const o = offPx(gridAt(base, HALF, D, REF), HALF);
    console.log(`distance-only offset at 0.5 yr: ${o.toFixed(3)} px`);
    // 116.1 arcsec/yr * 0.5 yr / 6.15 arcsec/px = 9.44 px
    expect(o).toBeGreaterThan(8.5);
    expect(o).toBeLessThan(10.5);
  });

  it('distance wrong by 5 percent with the correct motion is off by about 6 px at 0.5 yr', () => {
    const o = offPx(gridAt(base, HALF, D * 1.05, REF, MOTION), HALF);
    const oFull = offPx(gridAt(base, FULL, D * 1.05, REF, MOTION), FULL);
    console.log(`5 percent distance error offset: ${o.toFixed(3)} px at 0.5 yr, ${oFull.toFixed(3)} px at 1 yr`);
    expect(o).toBeGreaterThan(4.5);
    expect(o).toBeLessThan(8);
  });

  it('motion with zero rate equals the motionless grid', () => {
    const g0 = gridAt(base, HALF, D, REF, { dRaArcsecPerYr: 0, dDecArcsecPerYr: 0 });
    const g1 = gridAt(base, HALF, D, REF);
    expect(sepArcsec(g0.ra0, g0.dec0, g1.ra0, g1.dec0)).toBeLessThan(1e-9);
  });

  it('motion without a finite referenceMjd throws BAD_INPUT', () => {
    expect(() => gridAt(base, HALF, D, undefined, MOTION)).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
    expect(() => gridAt(base, HALF, D, NaN, MOTION)).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
    expect(() => gridAt(base, HALF, D, REF, { dRaArcsecPerYr: NaN, dDecArcsecPerYr: 0 }))
      .toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
  });

  // Oracle: astropy 7 + numpy, scratchpad motion_oracle.py. u(t) = normalize(u_ref + (100 east +
  // 58.8 north) * dt/365.25 arcsec in radians), u_ref = unit(90, 23.4392911); apparent =
  // normalize(500 u(t) - E(t)), E = get_body_barycentric('earth') - get_body_barycentric('sun')
  // at Time(mjd, format='mjd', scale='tt'). Numbers pasted verbatim.
  it('matches the astropy oracle within 0.5 arcsec', () => {
    const oracle = [
      { mjd: 60755.0, ra: 89.87559613048737, dec: 23.439240774439643 },
      { mjd: 60937.625, ra: 90.14036446442971, dec: 23.447394329290297 },
      { mjd: 61120.25, ra: 89.90585689427525, dec: 23.455595613924057 },
    ];
    const ob: Grid = { ...base, ra0: oracle[0].ra, dec0: oracle[0].dec };
    let worst = 0;
    for (const o of oracle) {
      const g = gridAt(ob, o.mjd, D, REF, MOTION);
      const sep = sepArcsec(g.ra0, g.dec0, o.ra, o.dec);
      worst = Math.max(worst, sep);
      expect(sep).toBeLessThan(0.5);
    }
    console.log(`motion oracle max separation ${worst.toFixed(3)} arcsec`);
  });

  it('motionFromPair without distance round trips a 365.25-day pair within 0.5 arcsec/yr', () => {
    const a = bodyAt(REF), b = bodyAt(FULL);
    const m = motionFromPair({ ...a, mjd: REF }, { ...b, mjd: FULL });
    console.log(`motionFromPair no D: ${m.dRaArcsecPerYr.toFixed(4)}, ${m.dDecArcsecPerYr.toFixed(4)}`);
    expect(Math.abs(m.dRaArcsecPerYr - 100)).toBeLessThan(0.5);
    expect(Math.abs(m.dDecArcsecPerYr - 58.8)).toBeLessThan(0.5);
  });

  it('motionFromPair with distance round trips a 0.5-yr pair within 0.01 arcsec/yr', () => {
    const a = bodyAt(REF), b = bodyAt(HALF);
    const m = motionFromPair({ ...a, mjd: REF }, { ...b, mjd: HALF }, D);
    console.log(`motionFromPair with D: ${m.dRaArcsecPerYr.toFixed(6)}, ${m.dDecArcsecPerYr.toFixed(6)}`);
    expect(Math.abs(m.dRaArcsecPerYr - 100)).toBeLessThan(0.01);
    expect(Math.abs(m.dDecArcsecPerYr - 58.8)).toBeLessThan(0.01);
    // and the half-year pair without D is badly off: the parallax change leaks in
    const raw = motionFromPair({ ...a, mjd: REF }, { ...b, mjd: HALF });
    expect(Math.hypot(raw.dRaArcsecPerYr - 100, raw.dDecArcsecPerYr - 58.8)).toBeGreaterThan(100);
  });

  it('motionFromPair handles the RA wrap and rejects a zero gap', () => {
    const m = motionFromPair({ ra: 359.99, dec: 0, mjd: 60000 }, { ra: 0.01, dec: 0, mjd: 60365.25 });
    expect(m.dRaArcsecPerYr).toBeCloseTo(72, 6);
    expect(() => motionFromPair({ ra: 1, dec: 0, mjd: 60000 }, { ra: 2, dec: 0, mjd: 60000 }))
      .toThrow(expect.objectContaining({ code: 'BAD_INPUT' }));
  });
});
