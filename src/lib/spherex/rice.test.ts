import { describe, it, expect } from 'vitest';
import { riceDecompress } from './rice';

// Hand-built streams exercising each block type for BYTEPIX 4, BLOCKSIZE 32.
class Bits {
  bytes: number[] = [];
  cur = 0;
  n = 0;
  put(v: number, nb: number): void {
    for (let i = nb - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((v >>> i) & 1);
      if (++this.n === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.n = 0;
      }
    }
  }
  done(): Uint8Array {
    if (this.n) this.put(0, 8 - this.n);
    return Uint8Array.from(this.bytes);
  }
}

describe('riceDecompress', () => {
  it('decodes a low-entropy block (FS=0, all pixels equal)', () => {
    const head = [0x00, 0x00, 0x01, 0x00]; // first pixel 256
    const b = new Bits();
    b.put(0, 5); // fs+1 = 0 -> fs = -1
    const out = riceDecompress(Uint8Array.from([...head, ...b.done()]), 32, 4, 20);
    expect(Array.from(out)).toEqual(new Array(20).fill(256));
  });

  it('decodes a normal block (zigzag differences, fs=2)', () => {
    const vals = [5, 7, 4, 4, 10, -3];
    const first = vals[0];
    const head = [0, 0, 0, first];
    const b = new Bits();
    const fs = 2;
    b.put(fs + 1, 5);
    let last = first;
    // pixel 0 is stored in the header; Rice still codes a diff for it (zero)
    const diffs = [0, ...vals.slice(1).map((v) => { const d = v - last; last = v; return d; })];
    for (const d of diffs) {
      const z = d >= 0 ? d * 2 : -d * 2 - 1;
      const hi = z >>> fs;
      b.put(0, hi); // unary: hi zeros then a one
      b.put(1, 1);
      b.put(z & ((1 << fs) - 1), fs);
    }
    const out = riceDecompress(Uint8Array.from([...head, ...b.done()]), 32, 4, vals.length);
    expect(Array.from(out)).toEqual(vals);
  });

  it('decodes a high-entropy block (FS=max, raw 32-bit)', () => {
    const vals = [1000, -5, 123456789, 0];
    const head = [0, 0, 0x03, 0xe8];
    const b = new Bits();
    b.put(25 + 1, 5);
    let last = vals[0];
    const diffs = [0, ...vals.slice(1).map((v) => { const d = (v - last) | 0; last = v; return d; })];
    for (const d of diffs) {
      const z = (d >= 0 ? d * 2 : -d * 2 - 1) >>> 0;
      b.put(z >>> 16, 16);
      b.put(z & 0xffff, 16);
    }
    const out = riceDecompress(Uint8Array.from([...head, ...b.done()]), 32, 4, vals.length);
    expect(Array.from(out)).toEqual(vals);
  });

  it('throws on truncated input', () => {
    expect(() => riceDecompress(Uint8Array.from([0, 0, 0, 1]), 32, 4, 100)).toThrow();
  });
});
