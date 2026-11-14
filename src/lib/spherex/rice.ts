// RICE_1 tile decompression (FITS tile compression, CFITSIO fits_rdecomp logic).
// Input is one compressed tile; output is nx integer pixels.

export function riceDecompress(
  input: Uint8Array,
  blockSize: number,
  bytePix: number,
  nx: number,
): Int32Array {
  let fsbits: number;
  let fsmax: number;
  if (bytePix === 4) {
    fsbits = 5;
    fsmax = 25;
  } else if (bytePix === 2) {
    fsbits = 4;
    fsmax = 14;
  } else if (bytePix === 1) {
    fsbits = 3;
    fsmax = 6;
  } else {
    throw new Error(`riceDecompress: unsupported BYTEPIX ${bytePix}`);
  }
  const bbits = 1 << fsbits;
  const out = new Int32Array(nx);
  const n = input.length;
  let c = 0;

  // first pixel value, big-endian, stored uncompressed
  let lastpix = 0;
  if (bytePix === 4) {
    if (n < 4) throw new Error('riceDecompress: input too short');
    lastpix = ((input[0] << 24) | (input[1] << 16) | (input[2] << 8) | input[3]) | 0;
    c = 4;
  } else if (bytePix === 2) {
    if (n < 2) throw new Error('riceDecompress: input too short');
    lastpix = ((input[0] << 8) | input[1]) << 16 >> 16;
    c = 2;
  } else {
    if (n < 1) throw new Error('riceDecompress: input too short');
    lastpix = input[0];
    c = 1;
  }
  const wrap = (v: number): number =>
    bytePix === 4 ? v | 0 : bytePix === 2 ? (v << 16) >> 16 : v & 0xff;

  const next = (): number => {
    if (c >= n) throw new Error('riceDecompress: ran past end of input');
    return input[c++];
  };

  let b = next();
  let nbits = 8;

  for (let i = 0; i < nx; ) {
    nbits -= fsbits;
    while (nbits < 0) {
      b = (b << 8) | next();
      nbits += 8;
    }
    const fs = (b >> nbits) - 1;
    b &= (1 << nbits) - 1;
    const imax = Math.min(i + blockSize, nx);

    if (fs < 0) {
      // low entropy: all differences are zero
      for (; i < imax; i++) out[i] = lastpix;
    } else if (fs === fsmax) {
      // high entropy: raw bbits-wide differences
      for (; i < imax; i++) {
        let k = bbits - nbits;
        let diff = k >= 32 ? 0 : b << k;
        for (k -= 8; k >= 0; k -= 8) {
          b = next();
          diff |= b << k;
        }
        if (nbits > 0) {
          b = next();
          diff |= b >> -k;
          b &= (1 << nbits) - 1;
        } else {
          b = 0;
        }
        diff = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1);
        lastpix = wrap(diff + lastpix);
        out[i] = lastpix;
      }
    } else {
      // normal: unary high part + fs low bits
      for (; i < imax; i++) {
        while (b === 0) {
          nbits += 8;
          b = next();
        }
        const nzero = nbits - (32 - Math.clz32(b));
        nbits -= nzero + 1;
        b ^= 1 << nbits;
        nbits -= fs;
        while (nbits < 0) {
          b = (b << 8) | next();
          nbits += 8;
        }
        let diff = (nzero << fs) | (b >> nbits);
        b &= (1 << nbits) - 1;
        diff = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1);
        lastpix = wrap(diff + lastpix);
        out[i] = lastpix;
      }
    }
  }
  return out;
}
