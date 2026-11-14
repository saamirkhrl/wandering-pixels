import { describe, it, expect } from 'vitest';
import { saturatedSources } from './saturation';
import { FLAG_BITS } from './types';
import type { Frame } from './types';

function frame(w: number, h: number, set: [number, number, number][]): Frame {
  const flags = new Uint8Array(w * h);
  for (const [x, y, v] of set) flags[y * w + x] = v;
  return { flags, w, h } as unknown as Frame;
}
const S = FLAG_BITS.SATURATED;

describe('saturatedSources', () => {
  it('finds two separate blobs sorted by size', () => {
    const f = frame(10, 10, [[1, 1, S], [2, 1, S], [1, 2, S], [2, 2, S], [3, 1, S], [7, 7, S]]);
    const r = saturatedSources(f);
    expect(r).toHaveLength(2);
    expect(r[0].npix).toBe(5);
    expect(r[0].x).toBeCloseTo(1.8);
    expect(r[0].y).toBeCloseTo(1.4);
    expect(r[1]).toEqual({ x: 7, y: 7, npix: 1 });
  });
  it('joins diagonal neighbours', () => {
    const r = saturatedSources(frame(5, 5, [[0, 0, S], [1, 1, S], [2, 2, S]]));
    expect(r).toEqual([{ x: 1, y: 1, npix: 3 }]);
  });
  it('returns nothing for an empty frame', () => {
    expect(saturatedSources(frame(4, 4, []))).toEqual([]);
  });
  it('ignores other bits and handles combined bits', () => {
    const r = saturatedSources(frame(6, 6, [[0, 0, FLAG_BITS.NO_DATA], [1, 1, FLAG_BITS.BAD_PIXEL], [3, 3, S | FLAG_BITS.PERSIST]]));
    expect(r).toEqual([{ x: 3, y: 3, npix: 1 }]);
  });
  it('does not wrap across rows', () => {
    const r = saturatedSources(frame(4, 4, [[3, 0, S], [0, 1, S]]));
    expect(r).toHaveLength(2);
  });
});
