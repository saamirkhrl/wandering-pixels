import { ADVISORY_MASK, BAD_DATA_MASK, worldToGrid } from '../data';
import type { Frame, GaiaStar, Grid, MovieFrame, WiseSource } from '../data';
import '../../ui/viewer-parts.css';

export type OverlayLayer = 'gaia' | 'wise' | 'masked' | 'adv';

export interface OverlaySource {
  kind: 'gaia' | 'wise';
  id: string;
  ra: number;
  dec: number;
  pmra: number | null;
  pmdec: number | null;
  epochYear: number;
  mag: number | null;
  magLabel: string;
  /** Gaia DR3 variable flag; true only when catalogued as variable. */
  variable?: boolean | null;
}

export interface ProjectedSource {
  src: OverlaySource;
  x: number;
  y: number;
}

export const MASK_BAD_BITS = BAD_DATA_MASK;
export const MASK_ADVISORY_BITS = ADVISORY_MASK;

const GAIA_EPOCH = 2016.0;
const WISE_EPOCH = 2015.4;
const J2000_MJD = 51544.5;
const DAYS_PER_YEAR = 365.25;
const MAS_PER_DEG = 3.6e6;

export function sourcesFromGaia(stars: GaiaStar[]): OverlaySource[] {
  return stars.map((s) => ({
    kind: 'gaia',
    id: s.sourceId,
    ra: s.ra,
    dec: s.dec,
    pmra: s.pmra,
    pmdec: s.pmdec,
    epochYear: GAIA_EPOCH,
    mag: Number.isFinite(s.gmag) ? s.gmag : null,
    magLabel: Number.isFinite(s.gmag) ? `G ${s.gmag.toFixed(1)}` : '',
    variable: (s as { variable?: boolean | null }).variable ?? null,
  }));
}

export function sourcesFromWise(rows: WiseSource[]): OverlaySource[] {
  return rows.map((r) => {
    const parts: string[] = [];
    if (r.w1mag !== null && Number.isFinite(r.w1mag)) parts.push(`W1 ${r.w1mag.toFixed(1)}`);
    if (r.w2mag !== null && Number.isFinite(r.w2mag)) parts.push(`W2 ${r.w2mag.toFixed(1)}`);
    const mag = r.w1mag ?? r.w2mag;
    return {
      kind: 'wise',
      id: r.id,
      ra: r.ra,
      dec: r.dec,
      pmra: r.pmra,
      pmdec: r.pmdec,
      epochYear: WISE_EPOCH,
      mag: mag !== null && Number.isFinite(mag) ? mag : null,
      magLabel: parts.join(', '),
    };
  });
}

export function projectSources(sources: OverlaySource[], grid: Grid, mjd: number): ProjectedSource[] {
  const out: ProjectedSource[] = [];
  const margin = 2;
  for (const src of sources) {
    const epochMjd = J2000_MJD + (src.epochYear - 2000) * DAYS_PER_YEAR;
    const dt = (mjd - epochMjd) / DAYS_PER_YEAR;
    const usePm = src.kind === 'gaia';
    const dDec = (((usePm ? src.pmdec : null) ?? 0) * dt) / MAS_PER_DEG;
    const dec = src.dec + dDec;
    const cosd = Math.max(1e-6, Math.cos((dec * Math.PI) / 180));
    const ra = src.ra + ((((usePm ? src.pmra : null) ?? 0)) * dt) / MAS_PER_DEG / cosd;
    const [x, y] = worldToGrid(grid, ra, dec);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < -0.5 - margin || x > grid.w - 0.5 + margin) continue;
    if (y < -0.5 - margin || y > grid.h - 0.5 + margin) continue;
    out.push({ src, x, y });
  }
  return out;
}

export function drawSources(
  ctx: CanvasRenderingContext2D,
  pts: ProjectedSource[],
  toCanvas: (gx: number, gy: number) => [number, number],
  scale: number,
  dpr: number,
): void {
  const rg = Math.max(4 * dpr, 0.9 * scale);
  const rw = Math.max(3.5 * dpr, 0.75 * scale);
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1 * dpr;
  ctx.fillStyle = 'transparent';
  for (const p of pts) {
    const [cx, cy] = toCanvas(p.x, p.y);
    if (p.src.kind === 'gaia') {
      ctx.strokeStyle = '#7fd4ff';
      ctx.beginPath();
      ctx.arc(cx, cy, rg, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#ff9fd0';
      ctx.strokeRect(cx - rw, cy - rw, rw * 2, rw * 2);
    }
  }
  ctx.restore();
}

export function hitTest(
  pts: ProjectedSource[],
  gx: number,
  gy: number,
  radiusGridPx: number,
): ProjectedSource | null {
  let best: ProjectedSource | null = null;
  let bestD = radiusGridPx * radiusGridPx;
  for (const p of pts) {
    const dx = p.x - gx;
    const dy = p.y - gy;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function signed(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(1);
}

export function describeSource(s: OverlaySource): string {
  const name = s.kind === 'gaia' ? `Gaia DR3 ${s.id}` : `CatWISE2020 ${s.id}`;
  const parts = [name + '.'];
  if (s.magLabel) parts.push(s.magLabel + '.');
  if (s.kind === 'wise') {
    parts.push('CatWISE2020 position, about 2015.');
    return parts.join(' ');
  }
  if (s.pmra !== null && s.pmdec !== null && Number.isFinite(s.pmra) && Number.isFinite(s.pmdec)) {
    parts.push(`Proper motion ${signed(s.pmra)}, ${signed(s.pmdec)} mas/yr.`);
  } else {
    parts.push('Proper motion not measured.');
  }
  if (s.variable === true) parts.push('Catalogued as variable (Gaia DR3)');
  return parts.join(' ');
}

export function drawSaturated(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  toCanvas: (gx: number, gy: number) => [number, number],
  scale: number,
  dpr: number,
): void {
  const r = Math.max(4 * dpr, 1.2 * scale);
  ctx.save();
  ctx.strokeStyle = '#e4e9f1';
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  for (const p of pts) {
    const [cx, cy] = toCanvas(p.x, p.y);
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
  }
  ctx.stroke();
  ctx.restore();
}

export function maskFor(mf: MovieFrame, frames: Frame[], bits: number = MASK_BAD_BITS): Uint8Array {
  const out = new Uint8Array(mf.w * mf.h);
  const ids = new Set(mf.exposureIds);
  for (const f of frames) {
    if (!ids.has(f.exposure.id)) continue;
    const n = Math.min(out.length, f.flags.length);
    for (let i = 0; i < n; i++) if ((f.flags[i] & bits) !== 0) out[i] = 1;
  }
  return out;
}

export function drawMask(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  w: number,
  toCanvas: (gx: number, gy: number) => [number, number],
  scale: number,
): void {
  ctx.save();
  ctx.fillStyle = 'rgba(255, 95, 210, 0.35)';
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    const [px, py] = toCanvas(x - 0.5, y - 0.5);
    ctx.fillRect(px, py, scale, scale);
  }
  ctx.restore();
}

// Thin outline of the cells set in the mask (not a fill). Used for advisory flags and
// saturated cores.
export function drawMaskOutline(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  w: number,
  toCanvas: (gx: number, gy: number) => [number, number],
  scale: number,
  dpr: number,
  style: { colour: string; alpha: number; edgeOnly?: boolean },
): void {
  const h = Math.floor(mask.length / w);
  const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] !== 0;
  ctx.save();
  ctx.strokeStyle = style.colour;
  ctx.globalAlpha = style.alpha;
  ctx.lineWidth = Math.max(1, Math.round(1 * dpr));
  ctx.beginPath();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const [px, py] = toCanvas(x - 0.5, y - 0.5);
      if (!style.edgeOnly) {
        ctx.rect(px + 0.5, py + 0.5, scale - 1, scale - 1);
        continue;
      }
      if (!on(x, y - 1)) {
        ctx.moveTo(px, py + 0.5);
        ctx.lineTo(px + scale, py + 0.5);
      }
      if (!on(x, y + 1)) {
        ctx.moveTo(px, py + scale - 0.5);
        ctx.lineTo(px + scale, py + scale - 0.5);
      }
      if (!on(x - 1, y)) {
        ctx.moveTo(px + 0.5, py);
        ctx.lineTo(px + 0.5, py + scale);
      }
      if (!on(x + 1, y)) {
        ctx.moveTo(px + scale - 0.5, py);
        ctx.lineTo(px + scale - 0.5, py + scale);
      }
    }
  }
  ctx.stroke();
  ctx.restore();
}
