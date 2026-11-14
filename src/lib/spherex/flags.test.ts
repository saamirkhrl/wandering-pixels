import { describe, it, expect, beforeAll } from 'vitest';
// @ts-ignore node types are not installed
import { openSync, readSync, closeSync, readFileSync, fstatSync } from 'node:fs';
import { readFlagsBlock, maskBits } from './flags';
import { setFetch, bytesTransferred, getHdu, readRange } from './fits';
import { riceDecompress } from './rice';
import { FLAG_BITS } from './types';

import { SPHEREX_TESTS_DIR, hasSamples } from './testdata';
const DIR = SPHEREX_TESTS_DIR;
const FILE = `${DIR}/level2_2025W35_2A_0221_2D2_spx_l2b-v27-2026-231.fits`;
const ORACLE = `${DIR}/flags_oracle.json`;
const have = hasSamples(FILE, ORACLE);

interface Oracle {
  block: { x0: number; x1: number; y0: number; y1: number; data: number[] };
  rows: Record<string, number[]>;
  rowChecksums: [number, number][];
}

function localFetch(path: string): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const hdr = new Headers(init?.headers).get('Range') ?? '';
    const m = /bytes=(\d+)-(\d+)/.exec(hdr);
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const s = Number(m![1]);
      const e = Math.min(Number(m![2]), size - 1);
      const buf = new Uint8Array(e - s + 1);
      readSync(fd, buf, 0, buf.length, s);
      return new Response(buf, {
        status: 206,
        headers: { 'Content-Range': `bytes ${s}-${e}/${size}` },
      });
    } finally {
      closeSync(fd);
    }
  }) as typeof fetch;
}

describe.skipIf(!have)('readFlagsBlock vs astropy', () => {
  let oracle: Oracle;
  beforeAll(() => {
    oracle = JSON.parse(readFileSync(ORACLE, 'utf8')) as Oracle;
    setFetch(localFetch(FILE));
  });

  it('matches the oracle block bit-exactly', async () => {
    const { x0, x1, y0, y1, data } = oracle.block;
    const got = await readFlagsBlock('file://local-a', x0, x1, y0, y1);
    expect(got.length).toBe(data.length);
    expect(Array.from(got)).toEqual(data);
  });

  it('matches whole rows and uses two Range requests for a block', async () => {
    const before = bytesTransferred();
    for (const [ys, row] of Object.entries(oracle.rows)) {
      const y = Number(ys);
      const got = await readFlagsBlock('file://local-b', 0, 2040, y, y + 1);
      expect(Array.from(got)).toEqual(row);
    }
    expect(bytesTransferred()).toBeGreaterThan(before);
  });

  it('decodes every row identically (checksums)', async () => {
    const got = await readFlagsBlock('file://local-c', 0, 2040, 0, 2040);
    for (let y = 0; y < 2040; y++) {
      let s = 0;
      let w = 0;
      for (let x = 0; x < 2040; x++) {
        const v = got[y * 2040 + x];
        s += v;
        w += v * ((x % 97) + 1);
      }
      expect([y, s, w]).toEqual([y, ...oracle.rowChecksums[y]]);
    }
  });

  it('riceDecompress on a raw heap tile matches', async () => {
    const url = 'file://local-d';
    const hdu = await getHdu(url, 'FLAGS');
    const y = 90;
    const d = await readRange(url, hdu.dataStart + y * 8, hdu.dataStart + y * 8 + 8);
    const dv = new DataView(d.buffer, d.byteOffset, 8);
    const count = dv.getUint32(0);
    const off = dv.getUint32(4);
    const heap = hdu.dataStart + (hdu.header['NAXIS1'] as number) * (hdu.header['NAXIS2'] as number);
    const tile = await readRange(url, heap + off, heap + off + count);
    expect(Array.from(riceDecompress(tile, 32, 4, 2040))).toEqual(oracle.rows[String(y)]);
  });
});

describe('maskBits', () => {
  it('maps source bits to FLAG_BITS', () => {
    expect(maskBits(0)).toBe(0);
    expect(maskBits(1 << 15)).toBe(FLAG_BITS.SATURATED);
    expect(maskBits(1 << 26)).toBe(FLAG_BITS.SATURATED);
    expect(maskBits(1 << 2)).toBe(FLAG_BITS.BAD_PIXEL);
    expect(maskBits(1 << 14)).toBe(FLAG_BITS.BAD_PIXEL);
    expect(maskBits(1 << 0)).toBe(FLAG_BITS.TRANSIENT);
    expect(maskBits(1 << 27)).toBe(FLAG_BITS.TRANSIENT);
    expect(maskBits(1 << 17)).toBe(FLAG_BITS.PERSIST);
    expect(maskBits(1 << 20)).toBe(FLAG_BITS.CROSSTALK);
    expect(maskBits(1 << 25)).toBe(FLAG_BITS.STREAK);
    expect(maskBits(1 << 28)).toBe(FLAG_BITS.HALO);
    expect(maskBits(1 << 29)).toBe(FLAG_BITS.HALO);
    // ignored bits: OVERFLOW, FULLSAMPLE, OUTLIER, SOURCE, GHOST*
    expect(maskBits((1 << 1) | (1 << 12) | (1 << 19) | (1 << 21) | (1 << 22) | (1 << 23) | (1 << 24))).toBe(0);
    expect(maskBits((1 << 15) | (1 << 17))).toBe(FLAG_BITS.SATURATED | FLAG_BITS.PERSIST);
    expect(maskBits(-1)).toBe(255 - FLAG_BITS.NO_DATA);
  });
});
