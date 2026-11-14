// Matched photometry, steps 1 and 2 (docs/algorithm.md): pixel mask and per-exposure forced
// aperture photometry on native pixels. Pure and browser-safe, no dependencies.
//
// Conventions: pixels are 0-based, data[y * size + x], pixel (i, j) covers [i - 0.5, i + 0.5].
// Fluxes are MJy/sr summed over native pixels.

// ------------------------------------------------------------------ constants (docs/algorithm.md) --
/** Raw FLAGS bits that exclude a pixel (the website's BAD_DATA mask). */
export const BAD_DATA_BITS = [0, 2, 6, 7, 9, 10, 11, 14, 15, 26, 27] as const;
export const BAD_DATA_MASK: number = BAD_DATA_BITS.reduce<number>((m, b) => m + 2 ** b, 0);
/** Raw FLAGS bits of the saturation quality flag: OVERFLOW, NONLINEAR, BLOOM. */
export const SATURATED_BITS = [1, 15, 26] as const;
export const SATURATED_MASK: number = SATURATED_BITS.reduce<number>((m, b) => m + 2 ** b, 0);
/** Saturation check window half width: central 5 x 5 native pixels. */
export const SAT_HALF = 2;
/** Aperture radius, native pixels (12.3 arcsec). */
export const APERTURE_RADIUS = 2.0;
/** Background annulus: ANNULUS_INNER <= r < ANNULUS_OUTER, native pixels. */
export const ANNULUS_INNER = 4.0;
export const ANNULUS_OUTER = 7.0;
export const BACKGROUND_CLIP_SIGMA = 3.0;
export const BACKGROUND_CLIP_ITERATIONS = 5;
/** Minimum annulus pixels N_b, before and after clipping. */
export const MIN_ANNULUS_PIXELS = 10;
/** Variance of a median relative to the variance of a mean. */
export const MEDIAN_VARIANCE_FACTOR = Math.PI / 2;
/** Fractional flux error floor, added in quadrature. */
export const FLUX_ERROR_FLOOR = 0.02;

// ------------------------------------------------------------------ types --
type NumArray = Float32Array | Float64Array | number[];
type IntArray = Uint32Array | number[];

/** One cutout around the star, square, native pixels, flags are RAW 32-bit values. */
export interface PhotometryStamp {
  /** Side length (2h + 1). */
  size: number;
  /** Star position in stamp pixels, 0-based, fractional. */
  x: number;
  y: number;
  /** IMAGE - ZODI, MJy/sr, row-major. */
  p: Float32Array | number[];
  variance: Float32Array | number[];
  flags: Uint32Array | number[];
}

export type MeasurementReason = 'ok' | 'outside_cutout' | 'edge' | 'masked_aperture' | 'annulus_few';

export interface ExposureMeasurement {
  ok: boolean;
  reason: MeasurementReason;
  /** Central 5 x 5 carries raw bit 1, 15 or 26. Set whenever the star is inside the cutout. */
  saturated: boolean;
  flux: number;
  /** Variance before the error floor. */
  varRaw: number;
  /** Inflated variance var' = varRaw + (floor * flux)^2. */
  variance: number;
  bkg: number;
  sBkg: number;
  nBkg: number;
  nAperture: number;
}

// ------------------------------------------------------------------ exact circle-pixel overlap --

/** Integral of sqrt(r^2 - x^2) from 0 to x (x in [-r, r]). */
function halfChordIntegral(x: number, r: number): number {
  const t = Math.max(-1, Math.min(1, x / r));
  return 0.5 * (x * Math.sqrt(Math.max(0, r * r - x * x)) + r * r * Math.asin(t));
}

/**
 * Area of the disc of radius r centred on the origin that lies in {x <= a, y <= b}.
 * Integrates the vertical extent clamp(b, -h, h) + h over x, h = sqrt(r^2 - x^2).
 */
function quadrantArea(a: number, b: number, r: number): number {
  if (a <= -r || b <= -r) return 0;
  const xe = Math.min(a, r);
  const H = (x: number) => halfChordIntegral(x, r);
  if (b >= r) return 2 * (H(xe) - H(-r));
  // |b| < r: h >= |b| exactly for |x| <= t
  const t = Math.sqrt(r * r - b * b);
  // inner part [-t, min(xe, t)]: length b + h
  let area = 0;
  const innerHi = Math.min(xe, t);
  if (innerHi > -t) area += b * (innerHi + t) + (H(innerHi) - H(-t));
  if (b >= 0) {
    // outer parts |x| > t: length 2h
    const leftHi = Math.min(xe, -t);
    if (leftHi > -r) area += 2 * (H(leftHi) - H(-r));
    if (xe > t) area += 2 * (H(xe) - H(t));
  }
  return area;
}

/**
 * Exact area of the intersection of the circle (centre cx, cy, radius r) with the unit pixel
 * (px, py), pixel centres at integers (the pixel covers [px - 0.5, px + 0.5] in each axis).
 */
export function circlePixelOverlap(cx: number, cy: number, r: number, px: number, py: number): number {
  const x0 = px - 0.5 - cx;
  const x1 = px + 0.5 - cx;
  const y0 = py - 0.5 - cy;
  const y1 = py + 0.5 - cy;
  if (x1 <= -r || x0 >= r || y1 <= -r || y0 >= r) return 0;
  const a =
    quadrantArea(x1, y1, r) - quadrantArea(x0, y1, r) - quadrantArea(x1, y0, r) + quadrantArea(x0, y0, r);
  if (a <= 0) return 0;
  return a > 1 ? 1 : a;
}

// ------------------------------------------------------------------ small numeric helpers --

/** Round half to even, as numpy's rint. */
function rint(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function medianOf(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const n = s.length;
  const m = n >> 1;
  return n % 2 === 1 ? s[m]! : 0.5 * (s[m - 1]! + s[m]!);
}

function stdOf(values: number[]): number {
  let mean = 0;
  for (const v of values) mean += v;
  mean /= values.length;
  let ss = 0;
  for (const v of values) ss += (v - mean) * (v - mean);
  return Math.sqrt(ss / values.length);
}

/** Iterative sigma clip around the median, population standard deviation (astropy sigma_clip). */
function sigmaClipMedian(values: number[], sigma: number, maxIters: number): number[] {
  let kept = values;
  for (let it = 0; it < maxIters; it++) {
    if (kept.length === 0) break;
    const c = medianOf(kept);
    const s = stdOf(kept);
    const lo = c - sigma * s;
    const hi = c + sigma * s;
    const next = kept.filter((v) => !(v < lo || v > hi));
    if (next.length === kept.length) break;
    kept = next;
  }
  return kept;
}

function emptyMeasurement(reason: MeasurementReason, saturated: boolean, nAperture = 0): ExposureMeasurement {
  return {
    ok: false,
    reason,
    saturated,
    flux: NaN,
    varRaw: NaN,
    variance: NaN,
    bkg: NaN,
    sBkg: NaN,
    nBkg: 0,
    nAperture,
  };
}

// ------------------------------------------------------------------ steps 1 and 2 --

/** Step 1: true when the pixel is excluded. */
export function isPixelBad(p: number, variance: number, flags: number): boolean {
  return (flags & BAD_DATA_MASK) !== 0 || !Number.isFinite(p) || !Number.isFinite(variance) || variance <= 0;
}

/** Steps 1 and 2: forced aperture photometry of the star in one exposure stamp. */
export function measureStamp(stamp: PhotometryStamp): ExposureMeasurement {
  const { size: n, x, y } = stamp;
  const P: NumArray = stamp.p;
  const V: NumArray = stamp.variance;
  const FL: IntArray = stamp.flags;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -0.5 || x > n - 0.5 || y < -0.5 || y > n - 0.5) {
    return emptyMeasurement('outside_cutout', false);
  }
  const xi = rint(x);
  const yi = rint(y);
  let orFlags = 0;
  for (let j = Math.max(0, yi - SAT_HALF); j < Math.min(n, yi + SAT_HALF + 1); j++) {
    for (let i = Math.max(0, xi - SAT_HALF); i < Math.min(n, xi + SAT_HALF + 1); i++) {
      orFlags |= FL[j * n + i]!;
    }
  }
  const saturated = (orFlags & SATURATED_MASK) !== 0;

  const bad = (k: number) => isPixelBad(P[k]!, V[k]!, FL[k]!);

  const r = APERTURE_RADIUS;
  if (x - r < -0.5 || x + r > n - 0.5 || y - r < -0.5 || y + r > n - 0.5) {
    return emptyMeasurement('edge', saturated);
  }
  const ixMin = Math.floor(x - r + 0.5);
  const ixMax = Math.ceil(x + r + 0.5);
  const iyMin = Math.floor(y - r + 0.5);
  const iyMax = Math.ceil(y + r + 0.5);
  if (ixMin < 0 || iyMin < 0 || ixMax > n || iyMax > n) return emptyMeasurement('edge', saturated);

  const apIdx: number[] = [];
  const apW: number[] = [];
  for (let j = iyMin; j < iyMax; j++) {
    for (let i = ixMin; i < ixMax; i++) {
      const w = circlePixelOverlap(x, y, r, i, j);
      if (w > 0) {
        apIdx.push(j * n + i);
        apW.push(w);
      }
    }
  }
  const nAperture = apIdx.length;
  for (const k of apIdx) {
    if (bad(k)) return emptyMeasurement('masked_aperture', saturated, nAperture);
  }

  // background: sigma-clipped median of unmasked pixels with ANNULUS_INNER <= r < ANNULUS_OUTER
  const rOut = Math.ceil(ANNULUS_OUTER) + 1;
  const annulus: number[] = [];
  for (let j = Math.max(0, yi - rOut); j < Math.min(n, yi + rOut + 1); j++) {
    for (let i = Math.max(0, xi - rOut); i < Math.min(n, xi + rOut + 1); i++) {
      const rr = Math.hypot(i - x, j - y);
      if (rr >= ANNULUS_INNER && rr < ANNULUS_OUTER && !bad(j * n + i)) annulus.push(P[j * n + i]!);
    }
  }
  if (annulus.length < MIN_ANNULUS_PIXELS) return emptyMeasurement('annulus_few', saturated, nAperture);
  const kept = sigmaClipMedian(annulus, BACKGROUND_CLIP_SIGMA, BACKGROUND_CLIP_ITERATIONS);
  if (kept.length < MIN_ANNULUS_PIXELS) return emptyMeasurement('annulus_few', saturated, nAperture);
  const bkg = medianOf(kept);
  const sBkg = stdOf(kept);
  const nBkg = kept.length;

  let flux = 0;
  let sumW2V = 0;
  let sumW = 0;
  for (let m = 0; m < apIdx.length; m++) {
    const w = apW[m]!;
    const k = apIdx[m]!;
    flux += w * (P[k]! - bkg);
    sumW2V += w * w * V[k]!;
    sumW += w;
  }
  const varRaw = sumW2V + sumW * sumW * MEDIAN_VARIANCE_FACTOR * ((sBkg * sBkg) / nBkg);
  const variance = varRaw + (FLUX_ERROR_FLOOR * flux) ** 2;
  return { ok: true, reason: 'ok', saturated, flux, varRaw, variance, bkg, sBkg, nBkg, nAperture };
}
