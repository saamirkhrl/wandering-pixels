// Small numeric helpers shared by movie.ts and spectrum.ts.

/** Percentile (0..100) of a sorted ascending array, linear interpolation. NaN if empty. */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (n - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < n ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[n - 1];
}

/**
 * Collect finite values from several arrays, subsampled to at most ~maxSamples values
 * (deterministic stride), mapped through `fn` (default identity).
 */
export function collectFinite(
  arrays: ArrayLike<number>[],
  maxSamples = 200000,
  fn: (v: number) => number = (v) => v,
): Float64Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const stride = Math.max(1, Math.ceil(total / maxSamples));
  const out: number[] = [];
  let k = 0;
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++, k++) {
      if (k % stride !== 0) continue;
      const v = a[i];
      if (Number.isFinite(v)) out.push(fn(v));
    }
  }
  return Float64Array.from(out);
}

/** Percentiles of finite values, subsampled. Returns NaN entries if no finite values. */
export function robustPercentiles(
  arrays: ArrayLike<number>[],
  ps: number[],
  fn?: (v: number) => number,
): number[] {
  const v = collectFinite(arrays, 200000, fn);
  v.sort();
  return ps.map((p) => percentileSorted(v, p));
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = Float64Array.from(values).sort();
  return percentileSorted(s, 50);
}

export function stdDev(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let m = 0;
  for (const v of values) m += v;
  m /= n;
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return Math.sqrt(s / (n - 1));
}
