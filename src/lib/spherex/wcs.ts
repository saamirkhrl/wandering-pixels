// Celestial coordinates: FITS TAN-SIP detector WCS, proper motion, and the shared output grid.
//
// Pixel convention (library wide): 0-based x, y with (0, 0) at the centre of the first stored
// pixel. FITS 1-based pixel p1 = x + 1. Only this file converts.
//
// Grid convention (contract): gnomonic projection at (ra0, dec0), north up, east left.
// Row 0 is the NORTH edge, column 0 is the EAST edge, pixel (x, y) is a pixel centre and the
// grid centre is at ((w-1)/2, (h-1)/2). With standard coordinates xi (east) and eta (north) in
// arcsec: x = (w-1)/2 - xi/scale, y = (h-1)/2 - eta/scale.
import type { Target, Exposure, Grid } from './types';
import { SpherexError } from './types';
import type { Header } from './fits';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const MAS2RAD = D2R / 3.6e6;
const ARCSEC2RAD = D2R / 3600;

/** SIP polynomial: coefficient c[p][q] multiplies u^p v^q. Empty when absent. */
type Poly = number[][];

export interface SipWcs {
  crpix: [number, number];        // FITS 1-based reference pixel
  crval: [number, number];        // deg
  cd: [number, number, number, number];     // row major, deg per pixel
  cdInv: [number, number, number, number];
  lonpole: number;                // deg, native longitude of the celestial pole
  a: Poly; b: Poly;               // forward SIP (pixel -> intermediate), may be empty
  ap: Poly; bp: Poly;             // inverse SIP (initial guess only), may be empty
}

// ---------------------------------------------------------------- header parsing

function num(h: Header, key: string): number | undefined {
  const v = h[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(/[dD]/, 'e'));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function req(h: Header, key: string): number {
  const v = num(h, key);
  if (v === undefined) throw new SpherexError('BAD_INPUT', `WCS keyword ${key} missing or not numeric`);
  return v;
}

function readPoly(h: Header, prefix: 'A' | 'B' | 'AP' | 'BP'): Poly {
  const order = num(h, `${prefix}_ORDER`);
  if (order === undefined || order < 0) return [];
  const n = Math.round(order);
  const c: Poly = [];
  let any = false;
  for (let p = 0; p <= n; p++) {
    c.push(new Array<number>(n + 1 - p).fill(0));
    for (let q = 0; q + p <= n; q++) {
      const v = num(h, `${prefix}_${p}_${q}`);
      if (v !== undefined) { c[p][q] = v; any = true; }
    }
  }
  return any ? c : [];
}

/**
 * Parse the primary (unprimed) celestial WCS of an image header. Alternate descriptions
 * (keys with a trailing letter such as CRPIX1A or CTYPE1W) are never read.
 */
export function parseWcs(header: Header): SipWcs {
  const t1 = String(header['CTYPE1'] ?? '').trim().toUpperCase();
  const t2 = String(header['CTYPE2'] ?? '').trim().toUpperCase();
  if (!t1.startsWith('RA---TAN') || !t2.startsWith('DEC--TAN')) {
    throw new SpherexError('BAD_INPUT', `unsupported WCS CTYPE ${t1} / ${t2} (need RA---TAN, DEC--TAN)`);
  }
  const crpix: [number, number] = [req(header, 'CRPIX1'), req(header, 'CRPIX2')];
  const crval: [number, number] = [req(header, 'CRVAL1'), req(header, 'CRVAL2')];

  let cd: [number, number, number, number];
  const cd11 = num(header, 'CD1_1'), cd12 = num(header, 'CD1_2');
  const cd21 = num(header, 'CD2_1'), cd22 = num(header, 'CD2_2');
  const hasPc = ['PC1_1', 'PC1_2', 'PC2_1', 'PC2_2'].some((k) => num(header, k) !== undefined);
  if (!hasPc && [cd11, cd12, cd21, cd22].some((v) => v !== undefined)) {
    cd = [cd11 ?? 0, cd12 ?? 0, cd21 ?? 0, cd22 ?? 0];
  } else {
    // PC defaults to the identity, CDELT to 1 (FITS Paper I).
    const s1 = num(header, 'CDELT1') ?? 1, s2 = num(header, 'CDELT2') ?? 1;
    const pc11 = num(header, 'PC1_1') ?? 1, pc12 = num(header, 'PC1_2') ?? 0;
    const pc21 = num(header, 'PC2_1') ?? 0, pc22 = num(header, 'PC2_2') ?? 1;
    cd = [s1 * pc11, s1 * pc12, s2 * pc21, s2 * pc22];
  }
  const det = cd[0] * cd[3] - cd[1] * cd[2];
  if (!Number.isFinite(det) || det === 0) throw new SpherexError('BAD_INPUT', 'singular WCS matrix');
  const cdInv: [number, number, number, number] = [cd[3] / det, -cd[1] / det, -cd[2] / det, cd[0] / det];

  // Zenithal projection: theta0 = 90, so the default LONPOLE is 180 unless dec0 >= 90.
  const lonpole = num(header, 'LONPOLE') ?? (crval[1] >= 90 ? 0 : 180);

  const sip = t1.endsWith('-SIP') || t2.endsWith('-SIP');
  return {
    crpix, crval, cd, cdInv, lonpole,
    a: sip ? readPoly(header, 'A') : [], b: sip ? readPoly(header, 'B') : [],
    ap: sip ? readPoly(header, 'AP') : [], bp: sip ? readPoly(header, 'BP') : [],
  };
}

// ---------------------------------------------------------------- SIP polynomials

function evalPoly(c: Poly, u: number, v: number): number {
  let s = 0;
  let up = 1;
  for (let p = 0; p < c.length; p++) {
    const row = c[p];
    let t = 0;
    for (let q = row.length - 1; q >= 0; q--) t = t * v + row[q]; // Horner in v
    s += t * up;
    up *= u;
  }
  return s;
}

/** Value and partial derivatives d/du, d/dv. */
function evalPolyGrad(c: Poly, u: number, v: number): [number, number, number] {
  let f = 0, fu = 0, fv = 0;
  for (let p = 0; p < c.length; p++) {
    const row = c[p];
    const up = p === 0 ? 1 : Math.pow(u, p);
    const upm = p === 0 ? 0 : p * Math.pow(u, p - 1);
    for (let q = 0; q < row.length; q++) {
      const k = row[q];
      if (k === 0) continue;
      const vq = q === 0 ? 1 : Math.pow(v, q);
      const vqm = q === 0 ? 0 : q * Math.pow(v, q - 1);
      f += k * up * vq;
      fu += k * upm * vq;
      fv += k * up * vqm;
    }
  }
  return [f, fu, fv];
}

// ---------------------------------------------------------------- TAN (de)projection

/** Intermediate world coords (deg) -> celestial (deg), rigorous spherical rotation. */
function tanToSky(w: SipWcs, xd: number, yd: number): { ra: number; dec: number } {
  const r = Math.hypot(xd, yd);
  const phi = r === 0 ? 0 : Math.atan2(xd, -yd);       // native longitude (rad)
  const theta = Math.atan2(R2D, r);                     // native latitude (rad), tan(theta) = (180/pi)/r
  const ap = w.crval[0] * D2R, dp = w.crval[1] * D2R, pp = w.lonpole * D2R;
  const st = Math.sin(theta), ct = Math.cos(theta);
  const sdp = Math.sin(dp), cdp = Math.cos(dp);
  const dphi = phi - pp;
  const ra = ap + Math.atan2(-ct * Math.sin(dphi), st * cdp - ct * sdp * Math.cos(dphi));
  const dec = Math.asin(clamp1(st * sdp + ct * cdp * Math.cos(dphi)));
  return { ra: normRa(ra * R2D), dec: dec * R2D };
}

/** Celestial (deg) -> intermediate world coords (deg). NaN for points on the far hemisphere. */
function skyToTan(w: SipWcs, ra: number, dec: number): [number, number] {
  const a = ra * D2R, d = dec * D2R;
  const ap = w.crval[0] * D2R, dp = w.crval[1] * D2R, pp = w.lonpole * D2R;
  const sd = Math.sin(d), cd = Math.cos(d), sdp = Math.sin(dp), cdp = Math.cos(dp);
  const da = a - ap;
  const phi = pp + Math.atan2(-cd * Math.sin(da), sd * cdp - cd * sdp * Math.cos(da));
  const stheta = sd * sdp + cd * cdp * Math.cos(da);
  if (stheta <= 0) return [NaN, NaN];
  const ctheta = Math.sqrt(Math.max(0, 1 - stheta * stheta));
  const r = R2D * ctheta / stheta;
  return [r * Math.sin(phi), -r * Math.cos(phi)];
}

function clamp1(v: number): number { return v > 1 ? 1 : v < -1 ? -1 : v; }
function normRa(ra: number): number { const r = ra % 360; return r < 0 ? r + 360 : r; }

// ---------------------------------------------------------------- pixel <-> sky

/** 0-based pixel -> sky (deg). Same as astropy all_pix2world(x, y, 0). */
export function pixToSky(w: SipWcs, x: number, y: number): { ra: number; dec: number } {
  const u = x + 1 - w.crpix[0];
  const v = y + 1 - w.crpix[1];
  const uu = w.a.length ? u + evalPoly(w.a, u, v) : u;
  const vv = w.b.length ? v + evalPoly(w.b, u, v) : v;
  const xd = w.cd[0] * uu + w.cd[1] * vv;
  const yd = w.cd[2] * uu + w.cd[3] * vv;
  return tanToSky(w, xd, yd);
}

/**
 * Sky (deg) -> 0-based pixel. The inverse SIP (AP, BP) only seeds a Newton solve on the forward
 * SIP, so pixToSky(skyToPix(p)) round-trips to well under 1e-6 px. NaN if behind the tangent plane.
 */
export function skyToPix(w: SipWcs, ra: number, dec: number): [number, number] {
  const [xd, yd] = skyToTan(w, ra, dec);
  if (!Number.isFinite(xd) || !Number.isFinite(yd)) return [NaN, NaN];
  const up = w.cdInv[0] * xd + w.cdInv[1] * yd;  // target u' = u + f(u, v)
  const vp = w.cdInv[2] * xd + w.cdInv[3] * yd;
  let u = up, v = vp;
  if (w.a.length || w.b.length) {
    if (w.ap.length || w.bp.length) {
      u = up + (w.ap.length ? evalPoly(w.ap, up, vp) : 0);
      v = vp + (w.bp.length ? evalPoly(w.bp, up, vp) : 0);
    }
    for (let i = 0; i < 30; i++) {
      const [f, fu, fv] = w.a.length ? evalPolyGrad(w.a, u, v) : [0, 0, 0];
      const [g, gu, gv] = w.b.length ? evalPolyGrad(w.b, u, v) : [0, 0, 0];
      const r1 = u + f - up, r2 = v + g - vp;
      const j11 = 1 + fu, j12 = fv, j21 = gu, j22 = 1 + gv;
      const det = j11 * j22 - j12 * j21;
      if (!Number.isFinite(det) || det === 0) break;
      const du = (j22 * r1 - j12 * r2) / det;
      const dv = (j11 * r2 - j21 * r1) / det;
      u -= du; v -= dv;
      if (Math.abs(du) < 1e-12 && Math.abs(dv) < 1e-12) break;
    }
  }
  return [u + w.crpix[0] - 1, v + w.crpix[1] - 1];
}

// ---------------------------------------------------------------- time and proper motion

/** Julian epoch of an MJD: 2000 + (mjd - 51544.5) / 365.25. */
export function julianYear(mjd: number): number {
  return 2000 + (mjd - 51544.5) / 365.25;
}

function mjdOfJulianYear(jy: number): number {
  return 51544.5 + (jy - 2000) * 365.25;
}

/** Standard coordinates (rad) around (ra0, dec0) (deg) -> sky (deg). Gnomonic deprojection. */
function fromStandard(ra0: number, dec0: number, xi: number, eta: number): { ra: number; dec: number } {
  const a0 = ra0 * D2R, d0 = dec0 * D2R;
  const s0 = Math.sin(d0), c0 = Math.cos(d0);
  const den = c0 - eta * s0;
  const ra = a0 + Math.atan2(xi, den);
  const dec = Math.atan2(s0 + eta * c0, Math.hypot(xi, den));
  return { ra: normRa(ra * R2D), dec: dec * R2D };
}

/** Sky (deg) -> standard coordinates (rad) around (ra0, dec0). NaN on the far hemisphere. */
function toStandard(ra0: number, dec0: number, ra: number, dec: number): [number, number] {
  const a0 = ra0 * D2R, d0 = dec0 * D2R, a = ra * D2R, d = dec * D2R;
  const s0 = Math.sin(d0), c0 = Math.cos(d0), sd = Math.sin(d), cd = Math.cos(d);
  const da = a - a0;
  const cosc = sd * s0 + cd * c0 * Math.cos(da);
  if (cosc <= 0) return [NaN, NaN];
  return [cd * Math.sin(da) / cosc, (sd * c0 - cd * s0 * Math.cos(da)) / cosc];
}

/**
 * Target position at a time with proper motion applied (no parallax, no radial velocity).
 * The motion is a straight line in the tangent plane at the catalogue position, which is the
 * same as linear space motion at large distance.
 */
export function positionAt(t: Target, mjd: number): { ra: number; dec: number } {
  if (!Number.isFinite(t.ra) || !Number.isFinite(t.dec) || !Number.isFinite(mjd)) {
    throw new SpherexError('BAD_INPUT', 'positionAt needs finite ra, dec and mjd');
  }
  const pmra = t.pmra ?? 0, pmdec = t.pmdec ?? 0;
  if (!Number.isFinite(pmra) || !Number.isFinite(pmdec) || (pmra === 0 && pmdec === 0)) {
    return { ra: normRa(t.ra), dec: t.dec };
  }
  const dt = julianYear(mjd) - (t.epoch ?? 2000.0);
  return fromStandard(t.ra, t.dec, pmra * dt * MAS2RAD, pmdec * dt * MAS2RAD);
}

// ---------------------------------------------------------------- output grid

/**
 * The fixed grid for a movie. Centre = target position at the mean exposure time (or at the
 * target epoch when there are no exposures). Defaults: 400 arcsec across at 6.15 arcsec/px.
 */
export function makeGrid(t: Target, e: Exposure[], size = 400, scale = 6.15): Grid {
  if (!(size > 0) || !(scale > 0) || !Number.isFinite(size) || !Number.isFinite(scale)) {
    throw new SpherexError('BAD_INPUT', 'grid size and scale must be positive');
  }
  const mjds = e.map((x) => x.mjd).filter((m) => Number.isFinite(m));
  const epochMjd = mjds.length
    ? mjds.reduce((s, m) => s + m, 0) / mjds.length
    : mjdOfJulianYear(t.epoch ?? 2000.0);
  const c = positionAt(t, epochMjd);
  const n = Math.max(1, Math.round(size / scale));
  return { ra0: c.ra, dec0: c.dec, w: n, h: n, scaleArcsec: scale, epochMjd };
}

/** Sky (deg) -> fractional grid pixel [x, y]. NaN if more than 90 deg from the centre. */
export function worldToGrid(g: Grid, ra: number, dec: number): [number, number] {
  const [xi, eta] = toStandard(g.ra0, g.dec0, ra, dec);
  const k = 1 / (g.scaleArcsec * ARCSEC2RAD);
  return [(g.w - 1) / 2 - xi * k, (g.h - 1) / 2 - eta * k];
}

/** Fractional grid pixel -> sky (deg). */
export function gridToWorld(g: Grid, x: number, y: number): { ra: number; dec: number } {
  const s = g.scaleArcsec * ARCSEC2RAD;
  const xi = ((g.w - 1) / 2 - x) * s;
  const eta = ((g.h - 1) / 2 - y) * s;
  return fromStandard(g.ra0, g.dec0, xi, eta);
}
