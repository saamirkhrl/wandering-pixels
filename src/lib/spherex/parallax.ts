// Annual parallax of distant solar system bodies, and grids that co-move with them.
//
// Definition (contract, used by outside teams):
//   apparent unit vector = normalize(D * u - E(t))
// where u is the body's HELIOCENTRIC ICRS unit direction (ra, dec), D its heliocentric distance
// in au, and E(t) the Earth's heliocentric position in au on ICRS equatorial axes at time t
// (MJD; UTC is treated as TT, a 69 s difference that is negligible here). The observer is the
// geocentre. Light-time, aberration and the body's own orbital motion are ignored: this is pure
// geometry, the shift of a fixed point at distance D as the Earth goes round the Sun.
//
// E(t) comes from a compact low-precision solar position (Meeus, Astronomical Algorithms,
// ch. 25): geometric mean longitude, mean anomaly, equation of centre, orbit eccentricity for
// the radius vector, ecliptic latitude 0. The Earth is minus the geocentric Sun vector. The
// longitude (mean equinox of date) is precessed to J2000 by subtracting 1.397 deg per Julian
// century, then rotated to equatorial axes with the J2000 obliquity 23.4392911 deg. Against
// the astropy/ERFA ephemeris this is good to about 0.01 deg in direction and 1e-4 au in radius,
// i.e. under 0.1 arcsec of parallax error at 300 au.
import type { Grid } from './types';
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
 * A copy of `base` (same w, h, scaleArcsec) centred on where a body at distanceAu appears at
 * `mjd`, with epochMjd = mjd. The body's heliocentric direction h is (base.ra0, base.dec0) when
 * referenceMjd is absent. When referenceMjd is given, base.ra0/dec0 is taken as the APPARENT
 * position at referenceMjd and h is solved exactly by fixed-point iteration in vector space,
 * h <- normalize(h + (b - apparent(h))), to better than 1e-10 deg, so
 * gridAt(base, referenceMjd, D, referenceMjd) is centred on base.
 * Non-finite or non-positive distanceAu returns a copy with epochMjd = mjd and the same centre.
 */
export function gridAt(base: Grid, mjd: number, distanceAu: number, referenceMjd?: number): Grid {
  if (!validDistance(distanceAu)) return { ...base, epochMjd: mjd };
  const b = unit(base.ra0, base.dec0);
  let h: Vec3 = b;
  if (referenceMjd !== undefined && Number.isFinite(referenceMjd)) {
    const tol = 1e-10 * D2R;
    for (let i = 0; i < 100; i++) {
      const a = apparentVec(h, referenceMjd, distanceAu);
      const next = normalize([h[0] + b[0] - a[0], h[1] + b[1] - a[1], h[2] + b[2] - a[2]]);
      const step = Math.hypot(next[0] - h[0], next[1] - h[1], next[2] - h[2]);
      h = next;
      if (step < tol) break;
    }
  }
  const c = toRaDec(apparentVec(h, mjd, distanceAu));
  return { ...base, ra0: c.ra, dec0: c.dec, epochMjd: mjd };
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
