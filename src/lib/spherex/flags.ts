// Read and decode Level 2 FLAGS (tile-compressed int32 image stored as a binary table).
// The HDU is RICE_1 with one tile per image row, so a block of rows costs two Range
// requests: the descriptor rows, then the heap bytes of those tiles.
import { getHdu, readRange } from './fits';
import type { Hdu, ReadOptions } from './fits';
import { riceDecompress } from './rice';
import { FLAG_BITS, SpherexError } from './types';

interface TileLayout {
  nx: number;
  ny: number;
  blockSize: number;
  bytePix: number;
  rowBytes: number;
  descBytes: number; // 8 for 1P, 16 for 1Q
  wide: boolean;
  heapStart: number; // absolute file offset
  blank: number | null;
}

function num(h: Hdu, key: string): number | undefined {
  const v = h.header[key];
  return typeof v === 'number' ? v : undefined;
}

function layoutOf(hdu: Hdu): TileLayout {
  const hd = hdu.header;
  const bad = (m: string): never => {
    throw new SpherexError('UPSTREAM_ERROR', `FLAGS HDU not supported: ${m}`);
  };
  if (hd['ZIMAGE'] !== true) bad('ZIMAGE is not T');
  if (String(hd['ZCMPTYPE']).trim() !== 'RICE_1') bad(`ZCMPTYPE ${String(hd['ZCMPTYPE'])}`);
  if (num(hdu, 'ZBITPIX') !== 32) bad(`ZBITPIX ${String(hd['ZBITPIX'])}`);
  const nx = num(hdu, 'ZNAXIS1');
  const ny = num(hdu, 'ZNAXIS2');
  if (nx === undefined || ny === undefined) return bad('missing ZNAXISn');
  if ((num(hdu, 'ZTILE1') ?? nx) !== nx || (num(hdu, 'ZTILE2') ?? 1) !== 1) bad('tiles are not single rows');
  let blockSize = 32;
  let bytePix = 4;
  for (let i = 1; i < 10; i++) {
    const name = hd[`ZNAME${i}`];
    if (typeof name !== 'string') continue;
    const val = num(hdu, `ZVAL${i}`);
    if (name.trim() === 'BLOCKSIZE' && val !== undefined) blockSize = val;
    if (name.trim() === 'BYTEPIX' && val !== undefined) bytePix = val;
  }
  const tform = String(hd['TFORM1'] ?? '');
  const m = /^1([PQ])/.exec(tform.trim());
  if (!m) return bad(`TFORM1 ${tform}`);
  if (hd['TTYPE1'] !== 'COMPRESSED_DATA') bad(`TTYPE1 ${String(hd['TTYPE1'])}`);
  const wide = m[1] === 'Q';
  const rowBytes = num(hdu, 'NAXIS1') ?? 0;
  const nrows = num(hdu, 'NAXIS2') ?? 0;
  if (nrows !== ny) bad('NAXIS2 differs from ZNAXIS2');
  const theap = num(hdu, 'THEAP') ?? rowBytes * nrows;
  const zblank = num(hdu, 'ZBLANK');
  return {
    nx,
    ny,
    blockSize,
    bytePix,
    rowBytes,
    descBytes: wide ? 16 : 8,
    wide,
    heapStart: hdu.dataStart + theap,
    blank: zblank === undefined ? null : zblank,
  };
}

/**
 * Raw int32 FLAGS bits for the half-open box [x0,x1) x [y0,y1), row-major, 0-based.
 * Caller clips to the detector. Null (ZBLANK) pixels, if the file declares any, read as 0.
 */
export async function readFlagsBlock(
  url: string,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  opts?: ReadOptions,
): Promise<Int32Array> {
  const hdu = await getHdu(url, 'FLAGS', opts);
  const hh = hdu.header;
  if (hh['ZIMAGE'] !== true && hh['BITPIX'] === 32 && hh['NAXIS'] === 2) {
    // Uncompressed int32 FLAGS image (qr2 v20 files): one Range over full rows.
    const nx = Number(hh['NAXIS1']), ny = Number(hh['NAXIS2']);
    if (x0 < 0 || y0 < 0 || x1 > nx || y1 > ny || x1 < x0 || y1 < y0) {
      throw new SpherexError('BAD_INPUT', `FLAGS block out of range: x ${x0}..${x1} y ${y0}..${y1}`);
    }
    const res = new Int32Array((x1 - x0) * (y1 - y0));
    if (res.length === 0) return res;
    const start = hdu.dataStart + y0 * nx * 4;
    const b = await readRange(url, start, start + (y1 - y0) * nx * 4, opts);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let j = 0; j < y1 - y0; j++)
      for (let i = 0; i < x1 - x0; i++) res[j * (x1 - x0) + i] = v.getInt32((j * nx + x0 + i) * 4, false);
    return res;
  }
  const L = layoutOf(hdu);
  if (x0 < 0 || y0 < 0 || x1 > L.nx || y1 > L.ny || x1 < x0 || y1 < y0) {
    throw new SpherexError('BAD_INPUT', `FLAGS block out of range: x ${x0}..${x1} y ${y0}..${y1}`);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const out = new Int32Array(w * h);
  if (w === 0 || h === 0) return out;

  // 1. descriptors of rows y0..y1-1 (one Range)
  const descStart = hdu.dataStart + y0 * L.rowBytes;
  const desc = await readRange(url, descStart, descStart + (h - 1) * L.rowBytes + L.descBytes, opts);
  const dv = new DataView(desc.buffer, desc.byteOffset, desc.byteLength);
  const counts = new Array<number>(h);
  const offsets = new Array<number>(h);
  let lo = Infinity;
  let hi = 0;
  for (let r = 0; r < h; r++) {
    const p = r * L.rowBytes;
    if (L.wide) {
      counts[r] = Number(dv.getBigInt64(p, false));
      offsets[r] = Number(dv.getBigInt64(p + 8, false));
    } else {
      counts[r] = dv.getUint32(p, false);
      offsets[r] = dv.getUint32(p + 4, false);
    }
    if (counts[r] > 0) {
      lo = Math.min(lo, offsets[r]);
      hi = Math.max(hi, offsets[r] + counts[r]);
    }
  }
  if (hi === 0) throw new SpherexError('UPSTREAM_ERROR', 'FLAGS rows have no compressed data');

  // 2. one Range over the heap bytes of all those tiles
  const heap = await readRange(url, L.heapStart + lo, L.heapStart + hi, opts);

  for (let r = 0; r < h; r++) {
    if (counts[r] <= 0) throw new SpherexError('UPSTREAM_ERROR', `FLAGS row ${y0 + r} is empty`);
    const s = offsets[r] - lo;
    const tile = heap.subarray(s, s + counts[r]);
    let row: Int32Array;
    try {
      row = riceDecompress(tile, L.blockSize, L.bytePix, L.nx);
    } catch (e) {
      throw new SpherexError('UPSTREAM_ERROR', `FLAGS row ${y0 + r} failed to decompress`, { cause: e });
    }
    const base = r * w;
    for (let x = 0; x < w; x++) {
      const v = row[x0 + x];
      out[base + x] = L.blank !== null && v === L.blank ? 0 : v;
    }
  }
  return out;
}

// Source bit masks (1 << plane number, per the MSKNnnnn keywords of the FLAGS header).
const bit = (n: number): number => 1 << n;
const SATURATED_SRC = bit(15) | bit(26); // NONLINEAR, BLOOM
const BAD_PIXEL_SRC = bit(2) | bit(6) | bit(7) | bit(9) | bit(10) | bit(11) | bit(14); // SUR_ERROR, NONFUNC, DICHROIC, MISSING_DATA, HOT, COLD, PHANMISS
const TRANSIENT_SRC = bit(0) | bit(27); // TRANSIENT, SNOWBALL
const PERSIST_SRC = bit(17);
const ARTIFACT_SRC = bit(20) | bit(25) | bit(28) | bit(29); // CROSSTALK, STREAK, HALO, SATELLITE_HALO

/** Map a raw FLAGS int to FLAG_BITS (Uint8-sized). Unlisted source bits map to 0. */
export function maskBits(raw: number): number {
  let m = 0;
  if (raw & SATURATED_SRC) m |= FLAG_BITS.SATURATED;
  if (raw & BAD_PIXEL_SRC) m |= FLAG_BITS.BAD_PIXEL;
  if (raw & TRANSIENT_SRC) m |= FLAG_BITS.TRANSIENT;
  if (raw & PERSIST_SRC) m |= FLAG_BITS.PERSIST;
  if (raw & ARTIFACT_SRC) m |= FLAG_BITS.ARTIFACT;
  return m;
}
