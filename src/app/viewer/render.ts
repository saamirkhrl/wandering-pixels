export interface Stretch {
  lo: number;
  hi: number;
  scale?: number;
}

export type Rgb = readonly [number, number, number];

// Missing data: one flat tone, slightly lighter than the near-black sky. No texture.
export const HATCH_A: Rgb = [28, 32, 43];
export const HATCH_B: Rgb = [28, 32, 43];
export const ZERO_RGB: Rgb = [6, 8, 14];

export function asinhNorm(x: number, lo: number, hi: number, scale?: number): number {
  const span = hi - lo;
  if (!(span > 0)) return 0;
  const s = scale !== undefined && scale > 0 ? scale : span / 50;
  const v = Math.asinh((x - lo) / s) / Math.asinh(span / s);
  if (!(v > 0)) return 0;
  return v > 1 ? 1 : v;
}

export function hatchColor(x: number, y: number): Rgb {
  return (x + y) % 2 === 0 ? HATCH_A : HATCH_B;
}

export function greyColor(v: number): Rgb {
  return [Math.round(v * 238), Math.round(v * 247), Math.round(v * 255)];
}

export function renderPixels(pixels: Float32Array, w: number, h: number, stretch: Stretch): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = pixels[i];
      const c = Number.isNaN(p) ? hatchColor(x, y) : greyColor(asinhNorm(p, stretch.lo, stretch.hi, stretch.scale));
      out[i * 4] = c[0];
      out[i * 4 + 1] = c[1];
      out[i * 4 + 2] = c[2];
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const POS_MID: Rgb = [240, 160, 64];
const POS_HI: Rgb = [255, 228, 178];
const NEG_MID: Rgb = [61, 142, 224];
const NEG_HI: Rgb = [190, 224, 255];

// t in -1..1, symmetric about zero. Zero is near-black, positive orange, negative blue.
export function divergingColor(t: number): Rgb {
  if (Number.isNaN(t)) return HATCH_A;
  const m = Math.min(1, Math.abs(t));
  const soft = Math.pow(m, 1.6);
  const mid = t >= 0 ? POS_MID : NEG_MID;
  const hi = t >= 0 ? POS_HI : NEG_HI;
  return soft < 0.65 ? mix(ZERO_RGB, mid, soft / 0.65) : mix(mid, hi, (soft - 0.65) / 0.35);
}

// Signed value to -1..1 with an asinh compression, so faint residuals and a bright dipole both read.
export function divergingNorm(v: number, range: number, soft?: number): number {
  if (Number.isNaN(v)) return NaN;
  if (!(soft && soft > 0)) return v / range;
  const t = Math.asinh(v / soft) / Math.asinh(range / soft);
  return t > 1 ? 1 : t < -1 ? -1 : t;
}

export type DiffRange = 'faint' | 'balanced' | 'bright';

// p-th percentile (0..1) of the absolute value of the finite entries.
export function absPercentile(values: ArrayLike<number>, p: number): number {
  const vals: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) vals.push(Math.abs(v));
  }
  if (vals.length === 0) return 0;
  const sorted = Float64Array.from(vals).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

export function diffRange(pixels: ArrayLike<number>, mode: DiffRange): { range: number; soft: number } {
  const sigma = robustSigma(pixels);
  const five = 5 * sigma;
  let range = five;
  if (mode === 'balanced') range = Math.max(five, absPercentile(pixels, 0.995));
  else if (mode === 'bright') range = Math.max(five, absPercentile(pixels, 0.999));
  return { range: range > 0 ? range : 1, soft: sigma > 0 ? 3 * sigma : 0 };
}

export function renderDiverging(
  pixels: Float32Array,
  w: number,
  h: number,
  range: number,
  soft?: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const r = range > 0 ? range : 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = pixels[i];
      const c = Number.isNaN(p) ? hatchColor(x, y) : divergingColor(divergingNorm(p, r, soft));
      out[i * 4] = c[0];
      out[i * 4 + 1] = c[1];
      out[i * 4 + 2] = c[2];
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

export function integerScale(w: number, h: number, boxW: number, boxH: number): number {
  if (w <= 0 || h <= 0) return 1;
  return Math.max(1, Math.floor(Math.min(boxW / w, boxH / h)));
}

function medianOf(sorted: Float64Array): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function collectSorted(values: ArrayLike<number>[], maxSamples = 250000): Float64Array {
  let total = 0;
  for (const a of values) total += a.length;
  const stride = Math.max(1, Math.ceil(total / maxSamples));
  const vals: number[] = [];
  let k = 0;
  for (const a of values) {
    for (let i = 0; i < a.length; i++, k++) {
      if (k % stride !== 0) continue;
      const v = a[i];
      if (Number.isFinite(v)) vals.push(v);
    }
  }
  return Float64Array.from(vals).sort();
}

function statsOf(sorted: Float64Array): { median: number; sigma: number } {
  if (sorted.length === 0) return { median: 0, sigma: 0 };
  const median = medianOf(sorted);
  const dev = Float64Array.from(sorted, (v) => Math.abs(v - median)).sort();
  return { median, sigma: 1.4826 * medianOf(dev) };
}

// Median and 1.4826 times the median absolute deviation of the finite values.
export function robustStats(values: ArrayLike<number>[], maxSamples = 250000): { median: number; sigma: number } {
  return statsOf(collectSorted(values, maxSamples));
}

export function robustSigma(pixels: ArrayLike<number>): number {
  return robustStats([pixels]).sigma;
}

export function robustMedian(pixels: ArrayLike<number>): number {
  return robustStats([pixels]).median;
}

export type Contrast = 'soft' | 'normal' | 'hard';
export const CONTRAST_SCALE: Record<Contrast, number> = { soft: 3, normal: 1, hard: 1 / 3 };

// One display stretch for a whole movie. The black point sits just under the background,
// the white point comes from the bright sources, not from the noise.
export function displayStretch(frames: ArrayLike<number>[], base: Stretch, contrast: Contrast = 'normal'): Stretch {
  const sorted = collectSorted(frames);
  const { median, sigma } = statsOf(sorted);
  if (!(sigma > 0)) return base;
  const n = sorted.length;
  const p999 = sorted[Math.min(n - 1, Math.floor(0.999 * (n - 1)))];
  const peak = sorted[n - 1] * 0.8;
  const hi = Math.max(Math.min(p999, peak), median + 20 * sigma);
  return { lo: median - 2 * sigma, hi, scale: 3 * sigma * CONTRAST_SCALE[contrast] };
}
