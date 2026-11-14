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

function medianInPlace(a: Float64Array, n: number): number {
  const s = a.subarray(0, n).sort();
  return percentileSorted(s, 50);
}

/**
 * Sigma-clipped median and robust sigma. Each iteration takes the median m and
 * sigma = 1.4826 * MAD about m, then keeps values within nSigma * sigma of m. The result is the
 * median of the final set and 1.4826 * MAD of that set about its median. NaN fields for empty
 * input. Does not modify `values`.
 */
export function sigmaClippedStats(
  values: ArrayLike<number>,
  iterations = 3,
  nSigma = 3,
): { median: number; sigma: number } {
  let n = values.length;
  if (n === 0) return { median: NaN, sigma: NaN };
  const cur = Float64Array.from(values as ArrayLike<number>);
  const dev = new Float64Array(n);
  const spread = (k: number, m: number): number => {
    for (let i = 0; i < k; i++) dev[i] = Math.abs(cur[i] - m);
    return 1.4826 * medianInPlace(dev, k);
  };
  for (let it = 0; it < iterations; it++) {
    const m = medianInPlace(Float64Array.from(cur.subarray(0, n)), n);
    const sigma = spread(n, m);
    if (!(sigma > 0)) break;
    const lim = nSigma * sigma;
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(cur[i] - m) <= lim) cur[k++] = cur[i];
    }
    if (k === 0 || k === n) break;
    n = k;
  }
  const med = medianInPlace(Float64Array.from(cur.subarray(0, n)), n);
  return { median: med, sigma: spread(n, med) };
}

/** Median of the sigma-clipped set (3 iterations at 3 sigma by default). */
export function sigmaClippedMedian(values: ArrayLike<number>, iterations = 3, nSigma = 3): number {
  return sigmaClippedStats(values, iterations, nSigma).median;
}
