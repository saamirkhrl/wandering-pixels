import { gridToWorld } from '../data';
import type { Grid } from '../data';
import { integerScale } from './render';

export function formatRa(deg: number): string {
  const h = (((deg % 360) + 360) % 360) / 15;
  let hh = Math.floor(h);
  let mm = Math.floor((h - hh) * 60);
  let ss = Math.round(((h - hh) * 60 - mm) * 60 * 10) / 10;
  if (ss >= 60) {
    ss = 0;
    mm += 1;
  }
  if (mm >= 60) {
    mm = 0;
    hh = (hh + 1) % 24;
  }
  return `${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m ${ss.toFixed(1).padStart(4, '0')}s`;
}

export function formatDec(deg: number): string {
  const sign = deg < 0 ? '-' : '+';
  const a = Math.abs(deg);
  let dd = Math.floor(a);
  let mm = Math.floor((a - dd) * 60);
  let ss = Math.round(((a - dd) * 60 - mm) * 60 * 10) / 10;
  if (ss >= 60) {
    ss = 0;
    mm += 1;
  }
  if (mm >= 60) {
    mm = 0;
    dd += 1;
  }
  return `${sign}${String(dd).padStart(2, '0')}d ${String(mm).padStart(2, '0')}' ${ss.toFixed(1).padStart(4, '0')}"`;
}

export function formatRaDeg(deg: number): string {
  return (((deg % 360) + 360) % 360).toFixed(5);
}

export function formatDecDeg(deg: number): string {
  return (deg >= 0 ? '+' : '-') + Math.abs(deg).toFixed(5);
}

export interface Stage {
  el: HTMLElement;
  setImage: (rgba: Uint8ClampedArray, w: number, h: number) => void;
  setOverlay: (grid: Grid, targetXY: [number, number] | null) => void;
  setValueProvider: (fn: ((x: number, y: number) => string) | null) => void;
  setNote: (text: string | null) => void;
  dispose: () => void;
}

const SCALE_CHOICES = [10, 20, 30, 60, 100, 120, 200];
const FONT = "'Atkinson Hyperlegible Next', system-ui, sans-serif";

export function createStage(): Stage {
  const el = document.createElement('section');
  el.className = 'v-stage';
  el.setAttribute('aria-label', 'Image plate');

  const box = document.createElement('div');
  box.className = 'v-plate';
  const base = document.createElement('canvas');
  base.className = 'v-canvas';
  const over = document.createElement('canvas');
  over.className = 'v-canvas v-overlay';
  over.setAttribute('role', 'img');
  over.setAttribute('aria-label', 'Sky image. Move the pointer over it to read the position and brightness.');
  const note = document.createElement('p');
  note.className = 'v-note';
  note.hidden = true;
  box.append(base, over, note);

  const readout = document.createElement('div');
  readout.className = 'v-readout';
  const line1 = document.createElement('p');
  const line2 = document.createElement('p');
  readout.append(line1, line2);
  readout.hidden = true;
  el.append(box, readout);

  const off = document.createElement('canvas');
  let imgW = 0;
  let imgH = 0;
  let hasImage = false;
  let grid: Grid | null = null;
  let targetXY: [number, number] | null = null;
  let valueFn: ((x: number, y: number) => string) | null = null;
  let scale = 1;
  let ox = 0;
  let oy = 0;
  let dpr = 1;
  const style = getComputedStyle(document.documentElement);
  const cPaper = style.getPropertyValue('--paper').trim() || '#e4e9f1';
  const cSignal = style.getPropertyValue('--signal').trim() || '#f2c230';
  const cSky = style.getPropertyValue('--sky').trim() || '#04060d';

  const idle = () => {
    line1.textContent = 'Move over the image to read a position.';
    line2.textContent = '\u00a0';
  };
  idle();

  function layout(): void {
    dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(box.clientWidth * dpr));
    const ch = Math.max(1, Math.round(box.clientHeight * dpr));
    if (base.width !== cw || base.height !== ch) {
      base.width = cw;
      base.height = ch;
      over.width = cw;
      over.height = ch;
    }
    if (hasImage) {
      scale = integerScale(imgW, imgH, cw, ch);
      ox = Math.floor((cw - imgW * scale) / 2);
      oy = Math.floor((ch - imgH * scale) / 2);
    }
    drawBase();
    drawOverlay();
  }

  function drawBase(): void {
    const ctx = base.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, base.width, base.height);
    if (!hasImage) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, imgW, imgH, ox, oy, imgW * scale, imgH * scale);
  }

  function drawOverlay(): void {
    const ctx = over.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, over.width, over.height);
    if (!hasImage || !grid) return;
    const right = ox + imgW * scale;
    const bottom = oy + imgH * scale;
    const lw = Math.max(1, Math.round(1.5 * dpr));
    const halo = (draw: () => void, color: string, width: number) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'butt';
      draw();
      ctx.restore();
    };
    ctx.font = `${Math.round(12 * dpr)}px ${FONT}`;
    ctx.textBaseline = 'alphabetic';

    // scale bar
    const maxPx = imgW * scale * 0.3;
    let arc = SCALE_CHOICES[0];
    for (const c of SCALE_CHOICES) if ((c / grid.scaleArcsec) * scale <= maxPx) arc = c;
    const barLen = (arc / grid.scaleArcsec) * scale;
    const bx = ox + 14 * dpr;
    const by = bottom - 24 * dpr;
    const bar = () => {
      ctx.beginPath();
      ctx.moveTo(bx, by - 4 * dpr);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx + barLen, by);
      ctx.lineTo(bx + barLen, by - 4 * dpr);
      ctx.stroke();
    };
    halo(bar, 'rgba(4,6,13,0.75)', lw + 2 * dpr);
    halo(bar, cPaper, lw);
    ctx.fillStyle = cPaper;
    ctx.strokeStyle = 'rgba(4,6,13,0.75)';
    ctx.lineWidth = 3 * dpr;
    ctx.lineJoin = 'round';
    ctx.strokeText(`${arc} arcsec`, bx, by + 14 * dpr);
    ctx.fillText(`${arc} arcsec`, bx, by + 14 * dpr);

    // compass: north up, east left
    const cx = right - 22 * dpr;
    const cy = oy + 38 * dpr;
    const L = 22 * dpr;
    const compass = () => {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - L);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx - L, cy);
      ctx.stroke();
    };
    ctx.globalAlpha = 0.75;
    halo(compass, 'rgba(4,6,13,0.75)', lw + 2 * dpr);
    halo(compass, cPaper, lw);
    ctx.textAlign = 'center';
    ctx.lineWidth = 3 * dpr;
    ctx.strokeText('N', cx, cy - L - 5 * dpr);
    ctx.fillText('N', cx, cy - L - 5 * dpr);
    ctx.textAlign = 'right';
    ctx.strokeText('E', cx - L - 5 * dpr, cy + 4 * dpr);
    ctx.fillText('E', cx - L - 5 * dpr, cy + 4 * dpr);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';

    // target marker: two short ticks, north (above) and east (left), clear of the star
    if (targetXY) {
      const mx = Math.round(ox + (targetXY[0] + 0.5) * scale);
      const my = Math.round(oy + (targetXY[1] + 0.5) * scale);
      const gapPx = Math.round(3 * scale);
      const len = Math.round(Math.max(12 * dpr, 1.6 * scale));
      const ticks = () => {
        ctx.beginPath();
        ctx.moveTo(mx, my - gapPx);
        ctx.lineTo(mx, my - gapPx - len);
        ctx.moveTo(mx - gapPx, my);
        ctx.lineTo(mx - gapPx - len, my);
        ctx.stroke();
      };
      halo(ticks, cSky, lw + 2 * dpr);
      halo(ticks, cSignal, lw + Math.round(dpr * 0.5));
    }
  }

  function setImage(rgba: Uint8ClampedArray, w: number, h: number): void {
    if (off.width !== w || off.height !== h) {
      off.width = w;
      off.height = h;
    }
    const octx = off.getContext('2d');
    if (!octx) return;
    octx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
    const sizeChanged = !hasImage || imgW !== w || imgH !== h;
    imgW = w;
    imgH = h;
    hasImage = true;
    readout.hidden = false;
    if (sizeChanged) layout();
    else {
      drawBase();
      drawOverlay();
    }
  }

  function setOverlay(g: Grid, t: [number, number] | null): void {
    grid = g;
    targetXY = t;
    drawOverlay();
  }

  function pixelAt(ev: PointerEvent): [number, number] | null {
    if (!hasImage) return null;
    const rect = over.getBoundingClientRect();
    const dx = (ev.clientX - rect.left) * (over.width / rect.width);
    const dy = (ev.clientY - rect.top) * (over.height / rect.height);
    const x = Math.floor((dx - ox) / scale);
    const y = Math.floor((dy - oy) / scale);
    if (x < 0 || y < 0 || x >= imgW || y >= imgH) return null;
    return [x, y];
  }

  const onMove = (ev: PointerEvent) => {
    const p = pixelAt(ev);
    if (!p || !grid) {
      idle();
      return;
    }
    const w = gridToWorld(grid, p[0], p[1]);
    line1.textContent = `RA ${formatRaDeg(w.ra)} deg, ${formatRa(w.ra)}   Dec ${formatDecDeg(w.dec)} deg, ${formatDec(w.dec)}`;
    line2.textContent = `Pixel ${p[0]}, ${p[1]}   ${valueFn ? valueFn(p[0], p[1]) : ''}`;
  };
  over.addEventListener('pointermove', onMove);
  over.addEventListener('pointerdown', onMove);
  over.addEventListener('pointerleave', idle);

  const ro = new ResizeObserver(layout);
  ro.observe(box);

  return {
    el,
    setImage,
    setOverlay,
    setValueProvider: (fn) => {
      valueFn = fn;
    },
    setNote: (text) => {
      note.hidden = text === null;
      note.textContent = text ?? '';
    },
    dispose: () => {
      ro.disconnect();
      over.removeEventListener('pointermove', onMove);
      over.removeEventListener('pointerdown', onMove);
      over.removeEventListener('pointerleave', idle);
    },
  };
}
