import type { Frame } from './types';
import { FLAG_BITS } from './types';

/** Connected blobs (8-connectivity) of saturated pixels, largest first. x, y are 0-based grid pixels. */
export function saturatedSources(frame: Frame): { x: number; y: number; npix: number }[] {
  const { w, h, flags } = frame;
  const seen = new Uint8Array(w * h);
  const out: { x: number; y: number; npix: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || (flags[start] & FLAG_BITS.SATURATED) === 0) continue;
    seen[start] = 1;
    stack.push(start);
    let n = 0;
    let sx = 0;
    let sy = 0;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const x = i % w;
      const y = (i - x) / w;
      n++;
      sx += x;
      sy += y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (seen[j] || (flags[j] & FLAG_BITS.SATURATED) === 0) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    out.push({ x: sx / n, y: sy / n, npix: n });
  }
  out.sort((a, b) => b.npix - a.npix);
  return out;
}
