// Rings on the image around the stars whose visit comparison can be measured (see change.ts).
// The block sets the positions; the viewer draws them in its extra-draw pass and redraws on change.
import { worldToGrid } from '../../lib/spherex';
import type { Grid } from '../../lib/spherex';

export interface RingStar {
  ra: number;
  dec: number;
}

let rings: RingStar[] = [];
const listeners = new Set<() => void>();

export function setMeasurableRings(stars: RingStar[] | null): void {
  rings = stars ? stars.slice() : [];
  for (const fn of listeners) fn();
}

export function measurableRings(): readonly RingStar[] {
  return rings;
}

/** Called whenever the rings change; returns an unsubscribe function. */
export function onRingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Grid positions of the rings on the shown grid. */
export function ringPositions(grid: Grid, stars: readonly RingStar[] = rings): [number, number][] {
  const out: [number, number][] = [];
  for (const s of stars) {
    const [x, y] = worldToGrid(grid, s.ra, s.dec);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

export function drawMeasurableRings(
  c: CanvasRenderingContext2D,
  toCanvas: (gx: number, gy: number) => [number, number],
  scale: number,
  dpr: number,
  grid: Grid,
): void {
  if (rings.length === 0) return;
  const r = Math.max(6 * dpr, 2.2 * scale);
  c.save();
  for (const [gx, gy] of ringPositions(grid)) {
    const [x, y] = toCanvas(gx, gy);
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    c.lineWidth = 3.5 * dpr;
    c.stroke();
    c.strokeStyle = '#7fe0b0';
    c.lineWidth = 1.75 * dpr;
    c.stroke();
  }
  c.restore();
}
