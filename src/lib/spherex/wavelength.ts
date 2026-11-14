// Per-pixel wavelength and bandwidth from the SPHEREx WCS-WAVE table (FITS Paper III, WAVE-TAB,
// alternate WCS key "W"). Browser and Node 20+, no dependencies.
import type { CallOptions, Exposure, Target } from './types';
import { SpherexError } from './types';
import { getHdu, readWaveTail } from './fits';
import type { Header, Hdu, ReadOptions } from './fits';
import { parseWcs, skyToPix, positionAt } from './wcs';

export interface WaveTable {
  /** index vector for WCS axis 1 and 2 (x and y), in FITS 1-based pixel units */
  idx: [Float64Array, Float64Array];
  /** values[m + nm * (i1 + n1 * i2)], FITS TDIM (nm, n1, n2), m fastest */
  values: Float64Array;
  nm: number;
  n1: number;
  n2: number;
  /** FITS Paper III pixel to index-vector coordinate: psi_j = crval_j + cdelt_j * sum_k pc[j][k] * (p_k - crpix_k) */
  crpix: [number, number];
  cdelt: [number, number];
  crval: [number, number];
  pc: [[number, number], [number, number]];
  /** 0-based component of the last TDIM axis for output axis 1 (wavelength) and 2 (bandwidth) */
  comp: [number, number];
}

function numKey(h: Header, key: string, dflt: number): number {
  const v = h[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function strKey(h: Header, key: string, dflt: string): string {
  const v = h[key];
  return typeof v === 'string' ? v.trim() : dflt;
}

const FORM_BYTES: Record<string, number> = { B: 1, L: 1, A: 1, I: 2, J: 4, K: 8, E: 4, D: 8 };

interface Column {
  name: string;
  code: string;
  count: number;
  offset: number;
  dims: number[];
}

function parseColumns(h: Header): Column[] {
  const n = numKey(h, 'TFIELDS', 0);
  const cols: Column[] = [];
  let offset = 0;
  for (let i = 1; i <= n; i++) {
    const form = strKey(h, 'TFORM' + i, '');
    const m = /^(\d*)([A-Z])/.exec(form);
    if (!m || !(m[2] in FORM_BYTES)) {
      throw new SpherexError('BAD_INPUT', `Unsupported TFORM${i} '${form}' in WCS-WAVE`);
    }
    const count = m[1] === '' ? 1 : parseInt(m[1], 10);
    const dimText = strKey(h, 'TDIM' + i, '');
    const dims = /^\(([\d,\s]+)\)$/.test(dimText)
      ? dimText.slice(1, -1).split(',').map((s) => parseInt(s.trim(), 10))
      : [count];
    cols.push({ name: strKey(h, 'TTYPE' + i, ''), code: m[2], count, offset, dims });
    offset += count * FORM_BYTES[m[2]];
  }
  return cols;
}

function readColumn(dv: DataView, c: Column): Float64Array {
  const out = new Float64Array(c.count);
  const bp = FORM_BYTES[c.code];
  for (let i = 0; i < c.count; i++) {
    const p = c.offset + i * bp;
    switch (c.code) {
      case 'E': out[i] = dv.getFloat32(p, false); break;
      case 'D': out[i] = dv.getFloat64(p, false); break;
      case 'J': out[i] = dv.getInt32(p, false); break;
      case 'I': out[i] = dv.getInt16(p, false); break;
      case 'K': out[i] = Number(dv.getBigInt64(p, false)); break;
      default: out[i] = dv.getUint8(p);
    }
  }
  return out;
}

/** Parse the WCS-WAVE binary table (row 0) together with the W keys of the IMAGE header. */
export function parseWaveTable(imageHeader: Header, waveHdu: Hdu, data: Uint8Array): WaveTable {
  const cols = parseColumns(waveHdu.header);
  const find = (name: string): Column => {
    const c = cols.find((x) => x.name === name);
    if (!c) throw new SpherexError('BAD_INPUT', `Column ${name} missing in WCS-WAVE`);
    return c;
  };
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const colName = (j: number, k: number, dflt: string): string => strKey(imageHeader, `PS${j}_${k}W`, dflt);
  const xName = colName(1, 2, 'X');
  const yName = colName(2, 2, 'Y');
  const valName = colName(1, 1, 'VALUES');
  const xi = readColumn(dv, find(xName));
  const yi = readColumn(dv, find(yName));
  const vc = find(valName);
  const values = readColumn(dv, vc);
  // TDIM (M, n1, n2): first axis is the output component, then the X axis, then the Y axis.
  const [nm, n1, n2] = vc.dims.length === 3 ? vc.dims : [2, xi.length, yi.length];
  if (n1 !== xi.length || n2 !== yi.length || nm * n1 * n2 !== values.length) {
    throw new SpherexError('BAD_INPUT', 'WCS-WAVE VALUES shape does not match X and Y');
  }
  const pc = (j: number, k: number): number => numKey(imageHeader, `PC${j}_${k}W`, j === k ? 1 : 0);
  const comp = (j: number): number => {
    const v = numKey(imageHeader, `PV${j}_3W`, j);
    return Math.min(Math.max(Math.round(v) - 1, 0), nm - 1);
  };
  return {
    idx: [xi, yi],
    values,
    nm,
    n1,
    n2,
    crpix: [numKey(imageHeader, 'CRPIX1W', 1), numKey(imageHeader, 'CRPIX2W', 1)],
    cdelt: [numKey(imageHeader, 'CDELT1W', 1), numKey(imageHeader, 'CDELT2W', 1)],
    crval: [numKey(imageHeader, 'CRVAL1W', 1), numKey(imageHeader, 'CRVAL2W', 1)],
    pc: [
      [pc(1, 1), pc(1, 2)],
      [pc(2, 1), pc(2, 2)],
    ],
    comp: [comp(1), comp(2)],
  };
}

/** Locate psi in an ascending index vector: lower index and fraction, clamped to the ends. */
function locate(v: Float64Array, psi: number): [number, number] {
  const n = v.length;
  if (n < 2) return [0, 0];
  if (!(psi > v[0])) return [0, 0];
  if (psi >= v[n - 1]) return [n - 2, 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (v[mid] <= psi) lo = mid;
    else hi = mid;
  }
  return [lo, (psi - v[lo]) / (v[lo + 1] - v[lo])];
}

/** Bilinear lookup at 0-based detector pixel (x, y); clamps at the table edges. Units um. */
export function waveAt(t: WaveTable, x: number, y: number): { wavelength: number; bandwidth: number } {
  const d1 = x + 1 - t.crpix[0];
  const d2 = y + 1 - t.crpix[1];
  const psi1 = t.crval[0] + t.cdelt[0] * (t.pc[0][0] * d1 + t.pc[0][1] * d2);
  const psi2 = t.crval[1] + t.cdelt[1] * (t.pc[1][0] * d1 + t.pc[1][1] * d2);
  const [i1, f1] = locate(t.idx[0], psi1);
  const [i2, f2] = locate(t.idx[1], psi2);
  const at = (a: number, b: number, m: number): number => t.values[m + t.nm * (a + t.n1 * b)];
  const interp = (m: number): number => {
    const j1 = Math.min(i1 + 1, t.n1 - 1);
    const j2 = Math.min(i2 + 1, t.n2 - 1);
    return (
      at(i1, i2, m) * (1 - f1) * (1 - f2) +
      at(j1, i2, m) * f1 * (1 - f2) +
      at(i1, j2, m) * (1 - f1) * f2 +
      at(j1, j2, m) * f1 * f2
    );
  };
  return { wavelength: interp(t.comp[0]), bandwidth: interp(t.comp[1]) };
}

interface Loaded {
  table: WaveTable;
  imageHeader: Header;
}

const loadCache = new Map<string, Promise<Loaded>>();

/** Forget cached wavelength tables (tests, long-lived pages). */
export function clearWaveCache(): void {
  loadCache.clear();
}

function load(url: string, opts?: ReadOptions): Promise<Loaded> {
  let p = loadCache.get(url);
  if (!p) {
    p = (async () => {
      // Two small independent reads: the first 32 KB (IMAGE header) and a suffix read (WCS-WAVE).
      const [img, tail] = await Promise.all([getHdu(url, 'IMAGE', opts), readWaveTail(url, opts)]);
      return { table: parseWaveTable(img.header, tail.hdu, tail.data), imageHeader: img.header };
    })();
    loadCache.set(url, p);
    p.catch(() => {
      if (loadCache.get(url) === p) loadCache.delete(url);
    });
  }
  return p;
}

/** Fetch (cached per URL) the wavelength table of one Level 2 file. */
export async function readWaveTable(url: string, opts?: ReadOptions): Promise<WaveTable> {
  return (await load(url, opts)).table;
}

function abortIf(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SpherexError('ABORTED', 'Aborted');
}

/**
 * Fill wavelengthAtTarget and bandwidthAtTarget of each exposure for the sky position (ra, dec),
 * or, when opts.target is given, for positionAt(target, exposure.mjd) (ra and dec are then ignored).
 * Returns new exposure objects; null where the target is off the detector or the header could
 * not be read. Throws only when aborted.
 */
export async function annotateWavelengths(
  exposures: Exposure[],
  ra: number,
  dec: number,
  opts?: CallOptions & { target?: Target },
): Promise<Exposure[]> {
  const out: Exposure[] = exposures.map((e) => ({ ...e }));
  const total = out.length;
  let done = 0;
  let next = 0;
  let bytes = 0;
  const ro: ReadOptions = { signal: opts?.signal, onBytes: (n) => { bytes += n; } };
  const report = (): void => {
    opts?.onProgress?.({ stage: 'headers', done, total, message: `Read ${done} of ${total} headers`, bytes });
  };
  const one = async (e: Exposure): Promise<void> => {
    try {
      const { table, imageHeader } = await load(e.url, ro);
      const pos = opts?.target ? positionAt(opts.target, e.mjd) : { ra, dec };
      const [x, y] = skyToPix(parseWcs(imageHeader), pos.ra, pos.dec);
      const nx = numKey(imageHeader, 'NAXIS1', 2040);
      const ny = numKey(imageHeader, 'NAXIS2', 2040);
      if (Number.isFinite(x) && Number.isFinite(y) && x >= -0.5 && y >= -0.5 && x <= nx - 0.5 && y <= ny - 0.5) {
        const w = waveAt(table, x, y);
        e.wavelengthAtTarget = w.wavelength;
        e.bandwidthAtTarget = w.bandwidth;
      } else {
        e.wavelengthAtTarget = null;
        e.bandwidthAtTarget = null;
      }
    } catch {
      abortIf(opts?.signal);
      e.wavelengthAtTarget = null;
      e.bandwidthAtTarget = null;
    }
  };
  const worker = async (): Promise<void> => {
    while (next < total) {
      abortIf(opts?.signal);
      const e = out[next++];
      await one(e);
      done++;
      report();
    }
  };
  abortIf(opts?.signal);
  report();
  await Promise.all(Array.from({ length: Math.min(4, total) }, worker));
  abortIf(opts?.signal);
  return out;
}
