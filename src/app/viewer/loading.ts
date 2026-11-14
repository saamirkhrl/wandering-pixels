// Calm loading line for the stage while a data set downloads.
export interface LoadingBytes {
  bytes: number | null;
  total: number | null;
}

function mb(n: number): string {
  return (n / 1e6).toFixed(1);
}

export function loadingLine(name: string, b: LoadingBytes): string {
  const who = name ? `Loading ${name}` : 'Loading';
  if (b.bytes === null || !(b.bytes > 0)) return who;
  if (b.total !== null && b.total >= b.bytes) return `${who}, ${mb(b.bytes)} of ${mb(b.total)} MB`;
  return `${who}, ${mb(b.bytes)} MB so far`;
}

// Progress.total is a byte count only for a single large transfer; small totals are item counts.
export function bytesFromProgress(p: { bytes?: number; total: number; done: number; stage: string }): LoadingBytes {
  const bytes = typeof p.bytes === 'number' && p.bytes > 0 ? p.bytes : null;
  const total = p.total >= 100_000 && bytes !== null && p.total >= bytes ? p.total : null;
  return { bytes, total };
}
