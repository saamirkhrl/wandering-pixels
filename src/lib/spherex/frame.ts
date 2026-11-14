// Frame loading: read a window of a Level 2 file by Range requests and resample it onto the grid.
import { getHdu, readImageBlock } from './fits';
import type { Hdu, ReadOptions } from './fits';
import { readFlagsBlock, maskBits } from './flags';
import { readWaveTable, waveAt } from './wavelength';
import { parseWcs, skyToPix, gridToWorld, positionAt } from './wcs';
import { BAD_DATA_MASK, FLAG_BITS, SpherexError } from './types';
import type { Exposure, Frame, FrameOptions, Grid, TrackingMotion } from './types';
import { gridAt } from './parallax';

function abortIf(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SpherexError('ABORTED', 'Aborted');
}

function wrap(e: unknown): SpherexError {
  if (e instanceof SpherexError) return e;
  return new SpherexError('UPSTREAM_ERROR', e instanceof Error ? e.message : String(e), { cause: e });
}

let warnedFlags = false;

function emptyFrame(exposure: Exposure, grid: Grid, withMaps = false, bytes = 0): Frame {
  const n = grid.w * grid.h;
  const maps = withMaps
    ? { wavelengthMap: new Float32Array(n).fill(NaN), bandwidthMap: new Float32Array(n).fill(NaN) }
    : {};
  return {
    ...maps,
    exposure, grid, bytes,
    pixels: new Float32Array(n).fill(NaN),
    variance: new Float32Array(n).fill(NaN),
    flags: new Uint8Array(n).fill(FLAG_BITS.NO_DATA),
    w: grid.w, h: grid.h, coverage: 0,
  };
}

/** Fast header path first, full walk on any mismatch (see fits.ts getHdu). */
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
 * Tracking options. distanceAu finite and > 0 turns tracking on. motion is used only with
 * tracking on: without a usable distanceAu it is ignored (no tracking, no trackingMotion). With
 * tracking on, motion needs a finite referenceMjd (the date at which the grid centre is the
 * body's apparent position), else SpherexError('BAD_INPUT'); a non-finite motion component is
 * BAD_INPUT too.
 */
function trackingOptions(opts: FrameOptions): { tracking: boolean; motion?: TrackingMotion } {
  const tracking = typeof opts.distanceAu === 'number' && Number.isFinite(opts.distanceAu) && opts.distanceAu > 0;
  if (!tracking || opts.motion === undefined) return { tracking };
  const m = opts.motion;
  if (!(typeof opts.referenceMjd === 'number' && Number.isFinite(opts.referenceMjd))) {
    throw new SpherexError('BAD_INPUT', 'Tracking motion needs a finite referenceMjd');
  }
  if (!Number.isFinite(m.dRaArcsecPerYr) || !Number.isFinite(m.dDecArcsecPerYr)) {
    throw new SpherexError('BAD_INPUT', 'Tracking motion must be finite');
  }
  return { tracking, motion: m };
}

export function loadFrame(exposure: Exposure, grid: Grid, opts: FrameOptions = {}): Promise<Frame> {
  return loadFrameCounted(exposure, grid, opts);
}

async function loadFrameCounted(
  exposure: Exposure,
  baseGrid: Grid,
  opts: FrameOptions,
  extraOnBytes?: (n: number) => void,
): Promise<Frame> {
  const { signal, onProgress } = opts;
  // Distance tracking: the grid co-moves with a body at distanceAu, per exposure.
  const { tracking, motion } = trackingOptions(opts);
  const grid: Grid = !tracking
    ? baseGrid
    : motion
      ? gridAt(baseGrid, exposure.mjd, opts.distanceAu as number, opts.referenceMjd, motion)
      : gridAt(baseGrid, exposure.mjd, opts.distanceAu as number, opts.referenceMjd);
  let bytes = 0;
  const ro: ReadOptions = {
    signal,
    onBytes: (n) => {
      bytes += n;
      extraOnBytes?.(n);
    },
  };
  try {
    abortIf(signal);
    const url = exposure.url;
    onProgress?.({ stage: 'pixels', done: 0, total: 1, message: 'Reading header', bytes });
    // The wavelength table (suffix read of the file) does not depend on the header or the footprint:
    // start it together with the header read so it costs no extra round trip. Failures here never
    // fail the frame (handled below); an unobserved rejection is absorbed by the wrapper.
    const tableP = readWaveTable(url, ro).then((t) => ({ t, e: null as unknown }), (e: unknown) => ({ t: null, e }));
    const imgHdu = await hduOf(url, 'IMAGE', ro);
    const wcs = parseWcs(imgHdu.header);
    const nx = Number(imgHdu.header['NAXIS1']);
    const ny = Number(imgHdu.header['NAXIS2']);
    const { w, h } = grid;
    const n = w * h;

    // Footprint map: output pixel centre -> detector coordinates.
    const sx = new Float64Array(n).fill(NaN);
    const sy = new Float64Array(n).fill(NaN);
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = gridToWorld(grid, x, y);
        const [px, py] = skyToPix(wcs, s.ra, s.dec);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        if (px < 0 || py < 0 || px > nx - 1 || py > ny - 1) continue;
        const j = y * w + x;
        sx[j] = px; sy[j] = py;
        if (px < bx0) bx0 = px;
        if (px > bx1) bx1 = px;
        if (py < by0) by0 = py;
        if (py > by1) by1 = py;
      }
    }
    if (!(bx1 >= bx0)) {
      const ef = emptyFrame({ ...exposure }, grid, opts.wavelengthMap === true, bytes);
      if (tracking) ef.trackingDistanceAu = opts.distanceAu;
      if (motion) ef.trackingMotion = { ...motion };
      return ef;
    }
    const x0 = Math.max(0, Math.floor(bx0) - 2);
    const x1 = Math.min(nx, Math.ceil(bx1) + 3);
    const y0 = Math.max(0, Math.floor(by0) - 2);
    const y1 = Math.min(ny, Math.ceil(by1) + 3);
    const bw = x1 - x0;
    abortIf(signal);

    const useZodi = opts.background !== 'none';
    let flagsFailed = false;
    const [img, vari, zodi, rawFlags] = await Promise.all([
      readImageBlock(url, imgHdu, x0, x1, y0, y1, ro),
      hduOf(url, 'VARIANCE', ro).then((hd) => readImageBlock(url, hd, x0, x1, y0, y1, ro)),
      useZodi
        ? hduOf(url, 'ZODI', ro).then((hd) => readImageBlock(url, hd, x0, x1, y0, y1, ro))
        : Promise.resolve(null),
      readFlagsBlock(url, x0, x1, y0, y1, ro).catch((e) => {
        if (e instanceof SpherexError && e.code === 'ABORTED') throw e;
        flagsFailed = true;
        return null;
      }),
    ]);
    if (flagsFailed && !warnedFlags) {
      warnedFlags = true;
      console.warn('spherex: FLAGS unavailable, continuing with flags all zero');
    }
    abortIf(signal);
    onProgress?.({ stage: 'reproject', done: 0, total: 1, message: 'Resampling', bytes });

    const pixels = new Float32Array(n).fill(NaN);
    const variance = new Float32Array(n).fill(NaN);
    const flags = new Uint8Array(n);
    // Table for the wavelength map and the target wavelength; failures here never fail the frame.
    const tr = await tableP;
    if (tr.e instanceof SpherexError && tr.e.code === 'ABORTED') throw tr.e;
    const table = tr.t;
    const wantMap = opts.wavelengthMap === true && table !== null;
    const wavelengthMap = wantMap ? new Float32Array(n).fill(NaN) : undefined;
    const bandwidthMap = wantMap ? new Float32Array(n).fill(NaN) : undefined;
    let good = 0;
    const nb = [0, 0, 0, 0];
    for (let j = 0; j < n; j++) {
      const px = sx[j];
      if (!(px >= 0)) { flags[j] = FLAG_BITS.NO_DATA; continue; }
      const py = sy[j];
      const ix = Math.floor(px), iy = Math.floor(py);
      const fx = px - ix, fy = py - iy;
      let val = 0, vr = 0, fl = 0;
      for (let k = 0; k < 4; k++) {
        const dx = k & 1, dy = k >> 1;
        const wt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        nb[k] = wt;
        if (wt <= 0) continue;
        const bi = (iy + dy - y0) * bw + (ix + dx - x0);
        if (iy + dy < y0 || iy + dy >= y1 || ix + dx < x0 || ix + dx >= x1) { fl |= FLAG_BITS.NO_DATA; continue; }
        const iv = img[bi], vv = vari[bi];
        const zv = zodi ? zodi[bi] : 0;
        if (!Number.isFinite(iv) || !Number.isFinite(vv) || !Number.isFinite(zv)) { fl |= FLAG_BITS.NO_DATA; continue; }
        if (rawFlags) fl |= maskBits(rawFlags[bi]);
        val += wt * (iv - zv);
        vr += wt * wt * vv;
      }
      // Bad-data bits (and off-detector / non-finite sources) blank the pixel. Advisory bits are
      // only OR-ed into flags: the pixel keeps its value and its normal variance weight.
      flags[j] = fl;
      if ((fl & BAD_DATA_MASK) !== 0) continue;
      pixels[j] = val;
      variance[j] = vr;
      good++;
      if (table && wavelengthMap && bandwidthMap) {
        const wv = waveAt(table, px, py);
        wavelengthMap[j] = wv.wavelength;
        bandwidthMap[j] = wv.bandwidth;
      }
    }

    // Wavelength at the target (or the grid centre), on a copy of the exposure.
    const exp: Exposure = { ...exposure };
    if (table) {
      const c = opts.target ? positionAt(opts.target, exposure.mjd) : { ra: grid.ra0, dec: grid.dec0 };
      const [cx, cy] = skyToPix(wcs, c.ra, c.dec);
      const wv = waveAt(table, cx, cy);
      if (Number.isFinite(wv.wavelength)) {
        exp.wavelengthAtTarget = wv.wavelength;
        exp.bandwidthAtTarget = wv.bandwidth;
      }
    }
    onProgress?.({ stage: 'reproject', done: 1, total: 1, message: 'Resampled', bytes });
    const frame: Frame = { exposure: exp, grid, pixels, variance, flags, w, h, coverage: good / n, bytes };
    if (tracking) frame.trackingDistanceAu = opts.distanceAu;
    if (motion) frame.trackingMotion = { ...motion };
    if (wavelengthMap && bandwidthMap) {
      frame.wavelengthMap = wavelengthMap;
      frame.bandwidthMap = bandwidthMap;
    }
    return frame;
  } catch (e) {
    if (signal?.aborted) throw new SpherexError('ABORTED', 'Aborted', { cause: e });
    throw wrap(e);
  }
}

export async function loadFrames(
  exposures: Exposure[],
  grid: Grid,
  opts: FrameOptions & { concurrency?: number; onFrame?: (f: Frame) => void } = {},
): Promise<{ frames: Frame[]; failed: { exposure: Exposure; error: SpherexError }[] }> {
  const { signal, onProgress, onFrame } = opts;
  const conc = Math.max(1, Math.floor(opts.concurrency ?? 4));
  const results: (Frame | null)[] = new Array(exposures.length).fill(null);
  const failed: { exposure: Exposure; error: SpherexError }[] = [];
  let next = 0;
  let done = 0;
  let bytes = 0;
  const total = exposures.length;
  const count = (n: number): void => { bytes += n; };
  abortIf(signal);
  trackingOptions(opts); // a bad motion option fails the whole call, not every exposure
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= total) return;
      try {
        const f = await loadFrameCounted(exposures[i], grid, {
          background: opts.background, signal, wavelengthMap: opts.wavelengthMap, target: opts.target,
          distanceAu: opts.distanceAu, referenceMjd: opts.referenceMjd, motion: opts.motion,
        }, count);
        results[i] = f;
        onFrame?.(f);
      } catch (e) {
        const err = wrap(e);
        if (err.code === 'ABORTED') return;
        failed.push({ exposure: exposures[i], error: err });
      }
      done++;
      onProgress?.({ stage: 'pixels', done, total, message: `Loaded ${done} of ${total}`, bytes });
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, total) }, worker));
  abortIf(signal);
  return { frames: results.filter((f): f is Frame => f !== null), failed };
}
