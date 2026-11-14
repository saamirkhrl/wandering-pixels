// Native-pixel stamp reader: a small window of one Level 2 exposure in detector orientation,
// with IMAGE minus ZODI, VARIANCE and the raw 32-bit FLAGS words. Used by forced photometry
// (docs/algorithm.md steps 1-2), which works on native pixels and never on the resampled grid.
import { getHdu, readImageBlock } from './fits';
import type { Hdu, ReadOptions } from './fits';
import { readFlagsBlock } from './flags';
import { readWaveTable, waveAt } from './wavelength';
import { parseWcs, positionAt, skyToPix } from './wcs';
import { SpherexError } from './types';
import type { CallOptions, Detector, Exposure, Target } from './types';

/**
 * A (2*half+1)^2 window of native pixels, centred on the native pixel nearest the star.
 * Layout is NATIVE detector orientation, NOT the north-up grid of Frame: row-major, row 0 is the
 * native row with the smallest index (row0), column 0 the native column col0.
 * Pixels that fall off the detector hold p = variance = NaN and flags = 0.
 */
export interface NativeStamp {
  exposureId: string;
  detector: Detector;
  mjd: number;
  visitIndex: number;
  size: number;          // 2 * half + 1
  half: number;
  col0: number;          // 0-based native column of stamp column 0
  row0: number;          // 0-based native row of stamp row 0
  /** Star position in stamp pixels, 0-based, pixel centres at integers (pixel i covers [i-0.5, i+0.5]). */
  x: number;
  y: number;
  p: Float32Array;       // IMAGE - ZODI, MJy/sr
  variance: Float32Array; // VARIANCE, (MJy/sr)^2
  flags: Uint32Array;    // raw FLAGS words (32 bit)
  wavelength: number;    // um at the star's pixel (NaN if the WCS-WAVE table could not be read)
  bandwidth: number;     // um
  ra: number;            // deg, the position that was asked for
  dec: number;
  bytes: number;         // bytes transferred for this stamp
}

export const MAX_HALF = 50;

function abortIf(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SpherexError('ABORTED', 'Aborted');
}

function wrap(e: unknown): SpherexError {
  if (e instanceof SpherexError) return e;
  return new SpherexError('UPSTREAM_ERROR', e instanceof Error ? e.message : String(e), { cause: e });
}

async function hduOf(url: string, name: string, ro: ReadOptions): Promise<Hdu> {
  try {
    return await getHdu(url, name, ro);
  } catch (e) {
    if (e instanceof SpherexError && e.code === 'NOT_FOUND') {
      throw new SpherexError('UPSTREAM_ERROR', `HDU ${name} missing`);
    }
    throw e;
  }
}

/**
 * Window geometry from the star's 0-based native pixel position (px, py) on an nx x ny detector.
 * Throws NO_COVERAGE when the star is not on the detector (outside [-0.5, n-0.5)).
 * Exported for tests.
 */
export function stampWindow(
  px: number, py: number, nx: number, ny: number, half: number,
): { col0: number; row0: number; x: number; y: number; cx: number; cy: number } {
  if (!Number.isFinite(px) || !Number.isFinite(py) || px < -0.5 || py < -0.5 || px >= nx - 0.5 || py >= ny - 0.5) {
    throw new SpherexError('NO_COVERAGE', 'Star is off the detector in this exposure');
  }
  const cx = Math.round(px);
  const cy = Math.round(py);
  const col0 = cx - half;
  const row0 = cy - half;
  return { col0, row0, x: px - col0, y: py - row0, cx, cy };
}

export async function loadNativeStamp(
  exposure: Exposure,
  ra: number,
  dec: number,
  halfSizePx: number,
  opts: CallOptions & { onBytes?: (n: number) => void } = {},
): Promise<NativeStamp> {
  if (!Number.isInteger(halfSizePx) || halfSizePx < 1 || halfSizePx > MAX_HALF) {
    throw new SpherexError('BAD_INPUT', `halfSizePx must be an integer 1..${MAX_HALF}, got ${String(halfSizePx)}`);
  }
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
    throw new SpherexError('BAD_INPUT', 'ra and dec must be finite');
  }
  const { signal } = opts;
  let bytes = 0;
  const ro: ReadOptions = {
    signal,
    onBytes: (n) => {
      bytes += n;
      opts.onBytes?.(n);
    },
  };
  try {
    abortIf(signal);
    const url = exposure.url;
    const imgHdu = await hduOf(url, 'IMAGE', ro);
    const wcs = parseWcs(imgHdu.header);
    const nx = Number(imgHdu.header['NAXIS1']);
    const ny = Number(imgHdu.header['NAXIS2']);
    const [px, py] = skyToPix(wcs, ra, dec); // 0-based, pixel centres at integers
    const win = stampWindow(px, py, nx, ny, halfSizePx);
    const size = 2 * halfSizePx + 1;
    const x0 = Math.max(0, win.col0), x1 = Math.min(nx, win.col0 + size);
    const y0 = Math.max(0, win.row0), y1 = Math.min(ny, win.row0 + size);
    const bw = x1 - x0;
    abortIf(signal);

    const tableP = readWaveTable(url, ro).then((t) => ({ t, e: null as unknown }), (e: unknown) => ({ t: null, e }));
    const [img, zodi, vari, rawFlags] = await Promise.all([
      readImageBlock(url, imgHdu, x0, x1, y0, y1, ro),
      hduOf(url, 'ZODI', ro).then((hd) => readImageBlock(url, hd, x0, x1, y0, y1, ro)),
      hduOf(url, 'VARIANCE', ro).then((hd) => readImageBlock(url, hd, x0, x1, y0, y1, ro)),
      readFlagsBlock(url, x0, x1, y0, y1, ro),
    ]);
    abortIf(signal);

    const n = size * size;
    const p = new Float32Array(n).fill(NaN);
    const variance = new Float32Array(n).fill(NaN);
    const flags = new Uint32Array(n);
    for (let j = y0; j < y1; j++) {
      for (let i = x0; i < x1; i++) {
        const src = (j - y0) * bw + (i - x0);
        const dst = (j - win.row0) * size + (i - win.col0);
        p[dst] = img[src] - zodi[src];
        variance[dst] = vari[src];
        flags[dst] = rawFlags[src] >>> 0;
      }
    }

    const tr = await tableP;
    if (tr.e instanceof SpherexError && tr.e.code === 'ABORTED') throw tr.e;
    let wavelength = NaN, bandwidth = NaN;
    if (tr.t) {
      const wv = waveAt(tr.t, px, py);
      wavelength = wv.wavelength;
      bandwidth = wv.bandwidth;
    }
    return {
      exposureId: exposure.id, detector: exposure.detector, mjd: exposure.mjd, visitIndex: exposure.visitIndex,
      size, half: halfSizePx, col0: win.col0, row0: win.row0, x: win.x, y: win.y,
      p, variance, flags, wavelength, bandwidth, ra, dec, bytes,
    };
  } catch (e) {
    if (signal?.aborted) throw new SpherexError('ABORTED', 'Aborted', { cause: e });
    throw wrap(e);
  }
}

/** positionFn for nativeStampsFor: the target at each exposure's mjd, proper motion applied. */
export function starPosition(target: Target): (e: Exposure) => { ra: number; dec: number } {
  return (e) => positionAt(target, e.mjd);
}

export async function nativeStampsFor(
  exposures: Exposure[],
  positionFn: (e: Exposure) => { ra: number; dec: number },
  halfSizePx: number,
  opts: CallOptions & { concurrency?: number } = {},
): Promise<{ stamps: NativeStamp[]; failed: { exposure: Exposure; error: SpherexError }[] }> {
  const { signal, onProgress } = opts;
  const conc = Math.max(1, Math.floor(opts.concurrency ?? 6));
  const results: (NativeStamp | null)[] = new Array(exposures.length).fill(null);
  const failed: { exposure: Exposure; error: SpherexError }[] = [];
  const total = exposures.length;
  let next = 0, done = 0, bytes = 0;
  if (!Number.isInteger(halfSizePx) || halfSizePx < 1 || halfSizePx > MAX_HALF) {
    throw new SpherexError('BAD_INPUT', `halfSizePx must be an integer 1..${MAX_HALF}, got ${String(halfSizePx)}`);
  }
  abortIf(signal);
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= total) return;
      try {
        const pos = positionFn(exposures[i]);
        results[i] = await loadNativeStamp(exposures[i], pos.ra, pos.dec, halfSizePx, {
          signal,
          onBytes: (n) => { bytes += n; },
        });
      } catch (e) {
        const err = wrap(e);
        if (err.code === 'ABORTED') return;
        failed.push({ exposure: exposures[i], error: err });
      }
      done++;
      onProgress?.({ stage: 'pixels', done, total, message: `Read ${done} of ${total} stamps`, bytes });
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, total) }, worker));
  abortIf(signal);
  return { stamps: results.filter((s): s is NativeStamp => s !== null), failed };
}
