import type { Frame, SpectrumPoint } from './types';
import { worldToGrid } from './wcs';
import { median, stdDev } from './stats';

const ARCSEC_PER_RAD = 206264.806247;

export function spectrumAt(frames: Frame[], ra: number, dec: number, apertureArcsec?: number): SpectrumPoint[] {
  const out: SpectrumPoint[] = [];
  for (const f of frames) {
    const { grid, w, h } = f;
    const scale = grid.scaleArcsec;
    const r = apertureArcsec !== undefined ? apertureArcsec / scale : 2;
    const [cx, cy] = worldToGrid(grid, ra, dec);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx < -0.5 || cy < -0.5 || cx > w - 0.5 || cy > h - 0.5) continue;
    const rIn = Math.max(r + 2, 2 * r);
    const rOut = rIn + 4;
    const apIdx: number[] = [];
    const annVals: number[] = [];
    let flagged = false;
    const x0 = Math.max(0, Math.floor(cx - rOut));
    const x1 = Math.min(w - 1, Math.ceil(cx + rOut));
    const y0 = Math.max(0, Math.floor(cy - rOut));
    const y1 = Math.min(h - 1, Math.ceil(cy + rOut));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        const i = y * w + x;
        if (d <= r) {
          apIdx.push(i);
          if (f.flags[i] !== 0 || !Number.isFinite(f.pixels[i])) flagged = true;
        } else if (d >= rIn && d <= rOut) {
          const p = f.pixels[i];
          if (f.flags[i] === 0 && Number.isFinite(p)) annVals.push(p);
        }
      }
    }
    const bkg = annVals.length ? median(annVals) : 0;
    let sum = 0;
    let sumVar = 0;
    let nAp = 0;
    for (const i of apIdx) {
      const p = f.pixels[i];
      if (!Number.isFinite(p)) continue;
      sum += p - bkg;
      const v = f.variance[i];
      if (Number.isFinite(v)) sumVar += v;
      nAp++;
    }
    const sd = stdDev(annVals);
    const varBkg = annVals.length ? (1.2533 * 1.2533 * sd * sd) / annVals.length : 0;
    const pixSr = (scale / ARCSEC_PER_RAD) ** 2;
    const factor = pixSr * 1e9;
    const e = f.exposure;
    out.push({
      exposureId: e.id,
      wavelength: e.wavelengthAtTarget ?? NaN,
      bandwidth: e.bandwidthAtTarget ?? NaN,
      flux: nAp > 0 ? sum * factor : NaN, // no usable aperture pixel -> NaN, not 0
      fluxErr: nAp > 0 ? Math.sqrt(sumVar + nAp * nAp * varBkg) * factor : NaN,
      time: e.time,
      mjd: e.mjd,
      visitIndex: e.visitIndex,
      detector: e.detector,
      flagged,
    });
  }
  out.sort((a, b) => (Number.isNaN(a.wavelength) ? 1 : 0) - (Number.isNaN(b.wavelength) ? 1 : 0) || a.wavelength - b.wavelength);
  return out;
}
