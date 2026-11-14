export interface Stretch {
  lo: number;
  hi: number;
}

export type Rgb = readonly [number, number, number];

export const HATCH_A: Rgb = [42, 47, 58];
export const HATCH_B: Rgb = [33, 38, 48];
export const ZERO_RGB: Rgb = [6, 8, 14];

export function asinhNorm(x: number, lo: number, hi: number): number {
  const span = hi - lo;
  if (!(span > 0)) return 0;
  const s = span / 50;
  const v = Math.asinh((x - lo) / s) / Math.asinh(span / s);
  if (!(v > 0)) return 0;
  return v > 1 ? 1 : v;
}

export function hatchColor(x: number, y: number): Rgb {
  return (x + y) % 6 < 3 ? HATCH_A : HATCH_B;
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
      const c = Number.isNaN(p) ? hatchColor(x, y) : greyColor(asinhNorm(p, stretch.lo, stretch.hi));
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

export function renderDiverging(pixels: Float32Array, w: number, h: number, range: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const r = range > 0 ? range : 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = pixels[i];
      const c = Number.isNaN(p) ? hatchColor(x, y) : divergingColor(p / r);
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

// 1.4826 times the median absolute deviation of the finite pixels.
export function robustSigma(pixels: ArrayLike<number>): number {
  const vals: number[] = [];
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    if (Number.isFinite(v)) vals.push(v);
  }
  if (vals.length === 0) return 0;
  const median = (a: number[]): number => {
    const s = Float64Array.from(a).sort();
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  };
  const m = median(vals);
  return 1.4826 * median(vals.map((v) => Math.abs(v - m)));
}
