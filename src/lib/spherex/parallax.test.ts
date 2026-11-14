// Oracle: astropy 7 + numpy. E(t) = get_body_barycentric('earth', t) - get_body_barycentric('sun', t)
// with t = Time(mjd, format='mjd', scale='tt') (builtin ERFA ephemeris), ICRS xyz in au. The
// oracle apparent direction is normalize(D * u - E), u the unit vector of (ra, dec); dRa is the
// wrapped RA difference times cos(dec). Ecliptic inputs were converted with
// SkyCoord(..., frame=BarycentricMeanEcliptic(equinox='J2000')).icrs. Numbers pasted verbatim.
import { describe, it, expect } from 'vitest';
import {
  parallaxOffset, positionAtDistance, gridAt, trackingTolerance, earthHeliocentric,
} from './parallax';
import type { Grid } from './types';

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
