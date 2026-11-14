// Annual parallax of distant solar system bodies, and grids that co-move with them.
//
// Definition (contract, used by outside teams):
//   apparent unit vector = normalize(D * u - E(t))
// where u is the body's HELIOCENTRIC ICRS unit direction (ra, dec), D its heliocentric distance
// in au, and E(t) the Earth's heliocentric position in au on ICRS equatorial axes at time t
// (MJD; UTC is treated as TT, a 69 s difference that is negligible here). The observer is the
// geocentre. Light-time and aberration are ignored: this is pure geometry, the shift of a point
// at distance D as the Earth goes round the Sun. The body's own orbital motion is ignored unless
// a TrackingMotion is given to gridAt, which then moves u linearly on the tangent plane (see
// gridAt); the distance D stays fixed either way.
//
// E(t) comes from a compact low-precision solar position (Meeus, Astronomical Algorithms,
// ch. 25): geometric mean longitude, mean anomaly, equation of centre, orbit eccentricity for
// the radius vector, ecliptic latitude 0. The Earth is minus the geocentric Sun vector. The
// longitude (mean equinox of date) is precessed to J2000 by subtracting 1.397 deg per Julian
// century, then rotated to equatorial axes with the J2000 obliquity 23.4392911 deg. Against
// the astropy/ERFA ephemeris this is good to about 0.01 deg in direction and 1e-4 au in radius,
// i.e. under 0.1 arcsec of parallax error at 300 au.
import { SpherexError } from './types';
import type { Grid, TrackingMotion } from './types';
import { julianYear } from './wcs';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const OBLIQUITY_J2000 = 23.4392911 * D2R;
/** Pixel scale used to express trackingTolerance in pixels (arcsec per pixel). */
const TOLERANCE_SCALE_ARCSEC = 6.15;

type Vec3 = [number, number, number];

function unit(ra: number, dec: number): Vec3 {
  const a = ra * D2R, d = dec * D2R;
  const cd = Math.cos(d);
  return [cd * Math.cos(a), cd * Math.sin(a), Math.sin(d)];
}

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}

function toRaDec(v: Vec3): { ra: number; dec: number } {
  const n = Math.hypot(v[0], v[1], v[2]);
  let ra = Math.atan2(v[1], v[0]) * R2D;
  if (ra < 0) ra += 360;
  if (ra >= 360) ra -= 360;
  const z = v[2] / n;
  return { ra, dec: Math.asin(z > 1 ? 1 : z < -1 ? -1 : z) * R2D };
}

/** Wrap an angle difference (deg) into [-180, 180). */
function wrap180(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

function validDistance(d: number | undefined): d is number {
  return typeof d === 'number' && Number.isFinite(d) && d > 0;
}

/**
 * Earth heliocentric position (au) on ICRS / J2000 equatorial axes at an MJD (TT).
 * Low-precision Meeus ch. 25 solar theory; see the file header for accuracy.
 */
export function earthHeliocentric(mjd: number): Vec3 {
  const T = (julianYear(mjd) - 2000) / 100; // Julian centuries from J2000.0
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * D2R;
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
    + 0.000289 * Math.sin(3 * M);
  const sunLon = L0 + C;                         // geometric, mean equinox of date (deg)
  const nu = M + C * D2R;                        // true anomaly (rad)
  const R = 1.000001018 * (1 - e * e) / (1 + e * Math.cos(nu));
  const lon = (sunLon + 180 - 1.397 * T) * D2R;  // Earth longitude, J2000 ecliptic
  const xe = R * Math.cos(lon), ye = R * Math.sin(lon);
  return [xe, ye * Math.cos(OBLIQUITY_J2000), ye * Math.sin(OBLIQUITY_J2000)];
}

function apparentVec(h: Vec3, mjd: number, d: number): Vec3 {
  const E = earthHeliocentric(mjd);
  return normalize([d * h[0] - E[0], d * h[1] - E[1], d * h[2] - E[2]]);
}

/**
 * Apparent (geocentric) position of a body whose heliocentric direction is (ra, dec) at
 * distanceAu from the Sun: normalize(D * u - E(t)), exact from the vector. Returns the input
 * position (RA normalised to [0, 360)) when distanceAu is not finite and positive.
 */
export function positionAtDistance(ra: number, dec: number, mjd: number, distanceAu: number): { ra: number; dec: number } {
  if (!validDistance(distanceAu)) return toRaDec(unit(ra, dec));
  return toRaDec(apparentVec(unit(ra, dec), mjd, distanceAu));
}

/**
 * Parallax offset in degrees: apparent minus heliocentric position.
 * dRa = wrap(raApp - ra) * cos(dec) is a true-angle offset (RA difference wrapped into
 * [-180, 180) deg, scaled by the cosine of the heliocentric dec); dDec = decApp - dec.
 * distanceAu of Infinity, 0, a negative number, NaN or undefined gives { 0, 0 }.
 */
export function parallaxOffset(ra: number, dec: number, mjd: number, distanceAu: number): { dRa: number; dDec: number } {
  if (!validDistance(distanceAu)) return { dRa: 0, dDec: 0 };
  const app = positionAtDistance(ra, dec, mjd, distanceAu);
  return { dRa: wrap180(app.ra - ra) * Math.cos(dec * D2R), dDec: app.dec - dec };
}

/**
 * Solve the heliocentric unit direction h whose apparent direction at mjd from distance d is the
 * unit vector b, by fixed-point iteration in vector space, h <- normalize(h + (b - apparent(h))),
 * to better than 1e-10 deg.
 */
function solveHeliocentric(b: Vec3, mjd: number, d: number): Vec3 {
  let h: Vec3 = b;
  const tol = 1e-10 * D2R;
  for (let i = 0; i < 100; i++) {
    const a = apparentVec(h, mjd, d);
    const next = normalize([h[0] + b[0] - a[0], h[1] + b[1] - a[1], h[2] + b[2] - a[2]]);
    const step = Math.hypot(next[0] - h[0], next[1] - h[1], next[2] - h[2]);
    h = next;
    if (step < tol) break;
  }
  return h;
}

/** East and north unit vectors of the tangent plane at the unit vector u. */
function eastNorth(u: Vec3): { e: Vec3; n: Vec3 } {
  const a = Math.atan2(u[1], u[0]);
  const sd = u[2] > 1 ? 1 : u[2] < -1 ? -1 : u[2];
  const cd = Math.sqrt(1 - sd * sd);
  return {
    e: [-Math.sin(a), Math.cos(a), 0],
    n: [-sd * Math.cos(a), -sd * Math.sin(a), cd],
  };
}

const DAYS_PER_JULIAN_YEAR = 365.25;
const ARCSEC2RAD = D2R / 3600;

/**
 * Heliocentric direction at mjd under linear motion from uRef at referenceMjd:
 * normalize(uRef + (dRa * east + dDec * north) * (mjd - referenceMjd) / 365.25), with the motion
 * in arcsec per Julian year converted to radians and east/north the unit vectors at uRef.
 */
function movedDirection(uRef: Vec3, motion: TrackingMotion, referenceMjd: number, mjd: number): Vec3 {
  const k = (mjd - referenceMjd) / DAYS_PER_JULIAN_YEAR * ARCSEC2RAD;
  const { e, n } = eastNorth(uRef);
  const x = motion.dRaArcsecPerYr * k, y = motion.dDecArcsecPerYr * k;
  return normalize([
    uRef[0] + x * e[0] + y * n[0],
    uRef[1] + x * e[1] + y * n[1],
    uRef[2] + x * e[2] + y * n[2],
  ]);
}

function validMotion(m: TrackingMotion): boolean {
  return Number.isFinite(m.dRaArcsecPerYr) && Number.isFinite(m.dDecArcsecPerYr);
}

/**
 * A copy of `base` (same w, h, scaleArcsec) centred on where a body at distanceAu appears at
 * `mjd`, with epochMjd = mjd.
 *
 * Without motion the body's heliocentric direction h is fixed: (base.ra0, base.dec0) when
 * referenceMjd is absent. When referenceMjd is given, base.ra0/dec0 is taken as the APPARENT
 * position at referenceMjd and h is solved exactly by fixed-point iteration in vector space,
 * h <- normalize(h + (b - apparent(h))), to better than 1e-10 deg, so
 * gridAt(base, referenceMjd, D, referenceMjd) is centred on base.
 *
 * With motion (linear heliocentric motion, arcsec per Julian year, dRa a true angle east,
 * dDec north) referenceMjd is required (finite) or this throws SpherexError('BAD_INPUT'), as it
 * does for a non-finite motion component. The heliocentric direction is then
 *   u(t) = normalize(u_ref + (dRa * east + dDec * north) * (t - referenceMjd) / 365.25)
 * with east/north the unit vectors of the tangent plane at u_ref and arcsec converted to
 * radians (a straight line on the gnomonic tangent plane at u_ref). u_ref is solved from
 * base.ra0/dec0 exactly as above, since the motion offset is zero at referenceMjd. The grid
 * centre is the apparent direction normalize(D * u(mjd) - E(mjd)).
 *
 * Non-finite or non-positive distanceAu returns a copy with epochMjd = mjd and the same centre
 * (motion is ignored then, after the referenceMjd check).
 */
export function gridAt(base: Grid, mjd: number, distanceAu: number, referenceMjd?: number, motion?: TrackingMotion): Grid {
  const hasRef = typeof referenceMjd === 'number' && Number.isFinite(referenceMjd);
  if (motion !== undefined) {
    if (!hasRef) throw new SpherexError('BAD_INPUT', 'Tracking motion needs a finite referenceMjd');
    if (!validMotion(motion)) throw new SpherexError('BAD_INPUT', 'Tracking motion must be finite');
  }
  if (!validDistance(distanceAu)) return { ...base, epochMjd: mjd };
  const b = unit(base.ra0, base.dec0);
  let h: Vec3 = hasRef ? solveHeliocentric(b, referenceMjd as number, distanceAu) : b;
  if (motion !== undefined) h = movedDirection(h, motion, referenceMjd as number, mjd);
  const c = toRaDec(apparentVec(h, mjd, distanceAu));
  return { ...base, ra0: c.ra, dec0: c.dec, epochMjd: mjd };
}

/**
 * Linear heliocentric motion (arcsec per Julian year) from two APPARENT positions a and b.
 *
 * Without distanceAu (or with an invalid one): dRa = wrap(b.ra - a.ra) * cos(mean dec) (a true
 * angle, RA difference wrapped into [-180, 180) deg), dDec = b.dec - a.dec, both divided by the
 * gap (b.mjd - a.mjd) / 365.25. The parallax left between the two dates is ignored, so this is
 * exact only for a gap of a whole number of years (to the small Julian vs sidereal year
 * difference); at other gaps the parallax change leaks into the motion.
 *
 * With distanceAu: the parallax is removed exactly first. Each heliocentric direction is the
 * solution h of apparent(h, mjd) = observed (the gridAt inversion); the motion is the offset of
 * h_b on the tangent plane at h_a (h_b / (h_b . h_a) - h_a, on the east/north unit vectors of
 * h_a, in arcsec) over the gap. This is the exact inverse of gridAt's motion rule with
 * referenceMjd = a.mjd.
 *
 * Throws SpherexError('BAD_INPUT') for non-finite inputs or a zero gap.
 */
export function motionFromPair(
  a: { ra: number; dec: number; mjd: number },
  b: { ra: number; dec: number; mjd: number },
  distanceAu?: number,
): TrackingMotion {
  for (const v of [a.ra, a.dec, a.mjd, b.ra, b.dec, b.mjd]) {
    if (!Number.isFinite(v)) throw new SpherexError('BAD_INPUT', 'motionFromPair needs finite positions and dates');
  }
  const years = (b.mjd - a.mjd) / DAYS_PER_JULIAN_YEAR;
  if (years === 0) throw new SpherexError('BAD_INPUT', 'motionFromPair needs two different dates');
  if (!validDistance(distanceAu)) {
    const cosMean = Math.cos((a.dec + b.dec) / 2 * D2R);
    return {
      dRaArcsecPerYr: wrap180(b.ra - a.ra) * cosMean * 3600 / years,
      dDecArcsecPerYr: (b.dec - a.dec) * 3600 / years,
    };
  }
  const ha = solveHeliocentric(unit(a.ra, a.dec), a.mjd, distanceAu);
  const hb = solveHeliocentric(unit(b.ra, b.dec), b.mjd, distanceAu);
  const dot = ha[0] * hb[0] + ha[1] * hb[1] + ha[2] * hb[2];
  if (!(dot > 0)) throw new SpherexError('BAD_INPUT', 'motionFromPair positions are more than 90 deg apart');
  const p: Vec3 = [hb[0] / dot - ha[0], hb[1] / dot - ha[1], hb[2] / dot - ha[2]];
  const { e, n } = eastNorth(ha);
  const k = 1 / (ARCSEC2RAD * years);
  return {
    dRaArcsecPerYr: (p[0] * e[0] + p[1] * e[1] + p[2] * e[2]) * k,
    dDecArcsecPerYr: (p[0] * n[0] + p[1] * n[1] + p[2] * n[2]) * k,
  };
}

/**
 * How far a 1 percent distance error throws off tracking between two dates, in pixels of
 * 6.15 arcsec: |(off(B; 1.01 D) - off(A; 1.01 D)) - (off(B; D) - off(A; D))| in arcsec / 6.15,
 * with off = parallaxOffset at the heliocentric direction (ra, dec). That is the residual
 * relative shift between the two dates the error leaves. 0 for an invalid distance.
 */
export function trackingTolerance(distanceAu: number, mjdA: number, mjdB: number, ra: number, dec: number): { pxPerPercent: number } {
  if (!validDistance(distanceAu)) return { pxPerPercent: 0 };
  const d2 = distanceAu * 1.01;
  const a1 = parallaxOffset(ra, dec, mjdA, distanceAu), b1 = parallaxOffset(ra, dec, mjdB, distanceAu);
  const a2 = parallaxOffset(ra, dec, mjdA, d2), b2 = parallaxOffset(ra, dec, mjdB, d2);
  const x = (b2.dRa - a2.dRa) - (b1.dRa - a1.dRa);
  const y = (b2.dDec - a2.dDec) - (b1.dDec - a1.dDec);
  return { pxPerPercent: Math.hypot(x, y) * 3600 / TOLERANCE_SCALE_ARCSEC };
}
