// IEEE 754 half precision <-> float32 conversion without Float16Array
// (Node 20 does not have it). Round to nearest, ties to even. Handles
// subnormals, overflow to Infinity, NaN and signed zero.

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** float -> 16-bit half pattern (0..65535). Values are rounded to float32 first. */
export function floatToHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const mant = x & 0x7fffff;
  if (exp === 0xff) return mant !== 0 ? sign | 0x7e00 : sign | 0x7c00;
  const e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    const m = mant | 0x800000;
    const shift = 14 - e;
    const rounded = (m + ((1 << (shift - 1)) - 1) + ((m >>> shift) & 1)) >>> shift;
    return sign | rounded;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1) === 1)) half++;
  return sign | half;
}

/** 16-bit half pattern -> number (exact). */
export function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 5.960464477539063e-8; // 2^-24
  if (exp === 31) return mant !== 0 ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * Math.pow(2, exp - 15);
}
