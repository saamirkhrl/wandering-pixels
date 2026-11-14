import { gridAt, worldToGrid, gridToWorld } from '../../lib/spherex';
import type { Frame, Grid, TrackingMotion } from '../../lib/spherex';
import { COPY } from './distance-copy';
import { PLANET_DEMO } from './planet-demo';

// A simulated distant body planted into the display copy of real frames. Cached frames are never
// changed. The body is defined exactly as the library's tracking defines one: its heliocentric
// direction at SIM_DISTANCE_AU is anchored at the anchor point on the anchor date and moves
// linearly by SIM_MOTION; its apparent position on a date is gridAt(anchorGrid, mjd, D, anchor, motion).

export const SIM_DISTANCE_AU = PLANET_DEMO.distanceAu;
export const SIM_SIGMA_PX = 0.6;
// Motion and brightness of the science seat's injected test body (about 19 px a year, eastward).
export const SIM_MOTION: TrackingMotion = {
  dRaArcsecPerYr: PLANET_DEMO.motionDraCosDecArcsecPerYr,
  dDecArcsecPerYr: PLANET_DEMO.motionDdecArcsecPerYr,
};
// Shown brighter than the science seat's test body (PLANET_DEMO.magnitudeAb) so it is easy to see.
export const SIM_MAG_AB = 11.5;
// Anchor offset from the patch centre in grid pixels (west and north), so the body does not sit on
// the target star and its year of eastward motion stays inside the patch.
export const SIM_OFFSET_PX: [number, number] = [12, -12];

/** The untracked grid moved so that its centre is the simulated body's anchor point. */
export function simAnchorGrid(base: Grid): Grid {
  const c = gridToWorld(base, (base.w - 1) / 2 + SIM_OFFSET_PX[0], (base.h - 1) / 2 + SIM_OFFSET_PX[1]);
  return { ...base, ra0: c.ra, dec0: c.dec };
}

/** Sky position of the simulated body on a date. */
export function simBodyRaDec(anchor: Grid, anchorMjd: number, mjd: number): [number, number] {
  const g = gridAt(anchor, mjd, SIM_DISTANCE_AU, anchorMjd, SIM_MOTION);
  return [g.ra0, g.dec0];
}

/** Grid position of the simulated body on a date, in any grid. */
export function simBodyAt(grid: Grid, mjd: number, anchor: Grid, anchorMjd: number): [number, number] {
  const [ra, dec] = simBodyRaDec(anchor, anchorMjd, mjd);
  return worldToGrid(grid, ra, dec);
}

/** The small "simulated" label beside the body, drawn on the image. */
export function drawSimLabel(
  c: CanvasRenderingContext2D,
  toCanvas: (gx: number, gy: number) => [number, number],
  scale: number,
  dpr: number,
  xy: [number, number],
): void {
  const [cx, cy] = toCanvas(xy[0], xy[1]);
  const off = 1.6 * scale;
  const colour = getComputedStyle(document.documentElement).getPropertyValue('--signal').trim() || '#f2c230';
  c.save();
  c.font = `700 ${Math.round(11 * dpr)}px 'Atkinson Hyperlegible Next', system-ui, sans-serif`;
  c.textAlign = 'left';
  c.textBaseline = 'bottom';
  c.lineJoin = 'round';
  c.lineWidth = 3 * dpr;
  c.strokeStyle = 'rgba(5, 8, 16, 0.85)';
  c.strokeText(COPY.simLabel, cx + off, cy - off);
  c.fillStyle = colour;
  c.fillText(COPY.simLabel, cx + off, cy - off);
  c.strokeStyle = colour;
  c.lineWidth = Math.max(1, dpr);
  c.beginPath();
  c.moveTo(cx + off * 0.45, cy - off * 0.45);
  c.lineTo(cx + off * 0.95, cy - off * 0.95);
  c.stroke();
  c.restore();
}

/** Grid position of the simulated body in a frame. */
export function simBodyXY(frame: Frame, anchor: Grid, anchorMjd: number): [number, number] {
  const [ra, dec] = simBodyRaDec(anchor, anchorMjd, frame.exposure.mjd);
  return worldToGrid(frame.grid, ra, dec);
}

/**
 * Peak surface brightness in MJy/sr of a flat-spectrum point source of SIM_MAG_AB spread as a
 * Gaussian of SIM_SIGMA_PX: F = 3631 Jy * 10^(-0.4 m); peak = F / (pixel solid angle * 2 pi sigma^2).
 */
export function simPeak(scaleArcsec: number): number {
  const fluxMJy = 3631e-6 * Math.pow(10, -0.4 * SIM_MAG_AB);
  const pixSr = Math.pow((scaleArcsec / 3600) * (Math.PI / 180), 2);
  return fluxMJy / (pixSr * 2 * Math.PI * SIM_SIGMA_PX * SIM_SIGMA_PX);
}

/** A copy of the frame with a Gaussian of sigma SIM_SIGMA_PX added at (x, y). NaN pixels stay NaN. */
export function plant(frame: Frame, x: number, y: number, peak: number): Frame {
  const out = new Float32Array(frame.pixels);
  const r = Math.ceil(SIM_SIGMA_PX * 4);
  const s2 = 2 * SIM_SIGMA_PX * SIM_SIGMA_PX;
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  for (let j = y0 - r; j <= y0 + r; j++) {
    if (j < 0 || j >= frame.h) continue;
    for (let i = x0 - r; i <= x0 + r; i++) {
      if (i < 0 || i >= frame.w) continue;
      const k = j * frame.w + i;
      if (!Number.isFinite(out[k])) continue;
      out[k] += peak * Math.exp(-((i - x) * (i - x) + (j - y) * (j - y)) / s2);
    }
  }
  return { ...frame, pixels: out };
}

const memo = new WeakMap<Frame, { key: string; out: Frame }>();

/** Display copies of the frames with the simulated body planted. */
export function simFrames(frames: Frame[], anchor: Grid, anchorMjd: number): Frame[] {
  const key = `${anchor.ra0.toFixed(7)}|${anchor.dec0.toFixed(7)}|${anchorMjd}`;
  return frames.map((f) => {
    const hit = memo.get(f);
    if (hit && hit.key === key) return hit.out;
    const [x, y] = simBodyXY(f, anchor, anchorMjd);
    const out = plant(f, x, y, simPeak(f.grid.scaleArcsec));
    memo.set(f, { key, out });
    return out;
  });
}

/** The persistent tag shown on the image while the simulated body is shown. */
export function createSimTag(): HTMLElement {
  const tag = document.createElement('p');
  tag.className = 'v-sim-tag';
  tag.textContent = COPY.simTag;
  tag.hidden = true;
  return tag;
}
