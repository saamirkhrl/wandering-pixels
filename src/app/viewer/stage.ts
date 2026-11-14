import { gridToWorld } from '../data';
import type { Grid } from '../data';
import { divergingColor, HATCH_A, integerScale } from './render';

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

export type ExtraDraw = (
  ctx: CanvasRenderingContext2D,
  toCanvas: (gx: number, gy: number) => [number, number],
  scale: number,
  dpr: number,
) => void;

export interface StageKey {
  ramp: { lo: string; hi: string; unit: string } | null;
  saturated: boolean;
}

export interface Stage {
  el: HTMLElement;
  setImage: (rgba: Uint8ClampedArray, w: number, h: number, k?: number) => void;
  deviceScale: (w: number, h: number) => number;
  onLayout: (fn: (() => void) | null) => void;
  setOverlay: (grid: Grid, targetXY: [number, number] | null) => void;
  setValueProvider: (fn: ((x: number, y: number) => string) | null) => void;
  setNote: (text: string | null) => void;
  setExtraDraw: (fn: ExtraDraw | null) => void;
  setHover: (fn: ((gx: number, gy: number) => string | null) | null) => void;
  setPick: (pos: [number, number] | null) => void;
  setReading: (text: string | null) => void;
  setKey: (key: StageKey | null) => void;
  onPick: (fn: ((gx: number, gy: number) => void) | null) => void;
  redraw: () => void;
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

  const reading = document.createElement('p');
  reading.className = 'v-reading';
  reading.hidden = true;
  const readout = document.createElement('div');
  readout.className = 'v-readout';
  const line1 = document.createElement('p');
  const line2 = document.createElement('p');
  readout.append(line1, line2);
  readout.hidden = true;
  el.append(box, reading, readout);

  const off = document.createElement('canvas');
  let imgK = 1;
  let layoutFn: (() => void) | null = null;
  let imgW = 0;
  let imgH = 0;
  let hasImage = false;
  let grid: Grid | null = null;
  let targetXY: [number, number] | null = null;
  let valueFn: ((x: number, y: number) => string) | null = null;
  let extra: ExtraDraw | null = null;
  let keyInfo: StageKey | null = null;
  let hoverFn: ((gx: number, gy: number) => string | null) | null = null;
  let pickPos: [number, number] | null = null;
  let pickFn: ((gx: number, gy: number) => void) | null = null;
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
      const before = scale;
      scale = integerScale(imgW, imgH, cw, ch);
      if (scale !== before && layoutFn) queueMicrotask(() => layoutFn?.());
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
    ctx.imageSmoothingEnabled = imgK > 1 && imgK !== scale;
    ctx.drawImage(off, 0, 0, imgW * imgK, imgH * imgK, ox, oy, imgW * scale, imgH * scale);
  }

  function drawOverlay(): void {
    const ctx = over.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, over.width, over.height);
    if (!hasImage || !grid) return;
    if (extra) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, imgW * scale, imgH * scale);
      ctx.clip();
      extra(ctx, (gx, gy) => [ox + (gx + 0.5) * scale, oy + (gy + 0.5) * scale], scale, dpr);
      ctx.restore();
    }
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

    if (pickPos) {
      const px = Math.round(ox + (pickPos[0] + 0.5) * scale);
      const py = Math.round(oy + (pickPos[1] + 0.5) * scale);
      const arm = Math.round(7 * dpr);
      const cross = () => {
        ctx.beginPath();
        ctx.moveTo(px - arm, py);
        ctx.lineTo(px + arm, py);
        ctx.moveTo(px, py - arm);
        ctx.lineTo(px, py + arm);
        ctx.stroke();
      };
      halo(cross, 'rgba(4,6,13,0.8)', lw + 2 * dpr);
      halo(cross, '#ffffff', lw);
    }

    if (keyInfo && (keyInfo.ramp || keyInfo.saturated)) drawKey(ctx, right, bottom);

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

  function drawKey(ctx: CanvasRenderingContext2D, right: number, bottom: number): void {
    if (!keyInfo) return;
    const pad = 12 * dpr;
    const rampW = Math.round(110 * dpr);
    const rampH = Math.round(7 * dpr);
    let y = bottom - pad;
    ctx.save();
    ctx.font = `${Math.round(11 * dpr)}px ${FONT}`;
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    const label = (t: string, x: number, yy: number, align: CanvasTextAlign) => {
      ctx.textAlign = align;
      ctx.strokeStyle = 'rgba(4,6,13,0.85)';
      ctx.lineWidth = 3 * dpr;
      ctx.strokeText(t, x, yy);
      ctx.fillStyle = cPaper;
      ctx.fillText(t, x, yy);
    };
    if (keyInfo.saturated) {
      const sw = Math.round(9 * dpr);
      const sx = right - pad - sw;
      ctx.fillStyle = `rgb(${HATCH_A[0]},${HATCH_A[1]},${HATCH_A[2]})`;
      ctx.fillRect(sx, y - sw, sw, sw);
      ctx.strokeStyle = cPaper;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = Math.max(1, Math.round(dpr));
      ctx.strokeRect(sx + 0.5, y - sw + 0.5, sw - 1, sw - 1);
      ctx.globalAlpha = 1;
      label('saturated', sx - 6 * dpr, y - 1 * dpr, 'right');
      y -= sw + 8 * dpr;
    }
    if (keyInfo.ramp) {
      const x0 = right - pad - rampW;
      for (let i = 0; i < rampW; i++) {
        const c = divergingColor((i / (rampW - 1)) * 2 - 1);
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.fillRect(x0 + i, y - rampH, 1, rampH);
      }
      ctx.strokeStyle = cPaper;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = Math.max(1, Math.round(dpr));
      ctx.strokeRect(x0 + 0.5, y - rampH + 0.5, rampW - 1, rampH - 1);
      ctx.globalAlpha = 1;
      label(keyInfo.ramp.lo, x0, y - rampH - 4 * dpr, 'left');
      label(`${keyInfo.ramp.hi} ${keyInfo.ramp.unit}`, x0 + rampW, y - rampH - 4 * dpr, 'right');
    }
    ctx.restore();
  }

  function setImage(rgba: Uint8ClampedArray, w: number, h: number, k = 1): void {
    if (off.width !== w * k || off.height !== h * k) {
      off.width = w * k;
      off.height = h * k;
    }
    const octx = off.getContext('2d');
    if (!octx) return;
    octx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w * k, h * k), 0, 0);
    imgK = k;
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

  function fractional(ev: PointerEvent | MouseEvent): [number, number] {
    const rect = over.getBoundingClientRect();
    const dx = (ev.clientX - rect.left) * (over.width / rect.width);
    const dy = (ev.clientY - rect.top) * (over.height / rect.height);
    return [(dx - ox) / scale - 0.5, (dy - oy) / scale - 0.5];
  }

  const onClick = (ev: MouseEvent) => {
    if (!hasImage || !pickFn) return;
    const [fx, fy] = fractional(ev);
    if (fx < -0.5 || fy < -0.5 || fx > imgW - 0.5 || fy > imgH - 0.5) return;
    pickFn(fx, fy);
  };
  over.addEventListener('click', onClick);

  const onMove = (ev: PointerEvent) => {
    const p = pixelAt(ev);
    if (!p || !grid) {
      idle();
      return;
    }
    const w = gridToWorld(grid, p[0], p[1]);
    line1.textContent = `RA ${formatRaDeg(w.ra)} deg, ${formatRa(w.ra)}   Dec ${formatDecDeg(w.dec)} deg, ${formatDec(w.dec)}`;
    const near = hoverFn ? hoverFn(...fractional(ev)) : null;
    line2.textContent = `Pixel ${p[0]}, ${p[1]}   ${valueFn ? valueFn(p[0], p[1]) : ''}${near ? '   ' + near : ''}`;
  };
  over.addEventListener('pointermove', onMove);
  over.addEventListener('pointerdown', onMove);
  over.addEventListener('pointerleave', idle);

  const ro = new ResizeObserver(layout);
  ro.observe(box);

  return {
    el,
    setImage,
    deviceScale: (w, h) => {
      const d = window.devicePixelRatio || 1;
      return integerScale(w, h, Math.max(1, Math.round(box.clientWidth * d)), Math.max(1, Math.round(box.clientHeight * d)));
    },
    onLayout: (fn) => {
      layoutFn = fn;
    },
    setOverlay,
    setValueProvider: (fn) => {
      valueFn = fn;
    },
    setExtraDraw: (fn) => {
      extra = fn;
      drawOverlay();
    },
    setHover: (fn) => {
      hoverFn = fn;
    },
    setReading: (text) => {
      reading.hidden = text === null;
      reading.textContent = text ?? '';
    },
    setKey: (k) => {
      keyInfo = k;
      drawOverlay();
    },
    setPick: (pos) => {
      pickPos = pos;
      drawOverlay();
    },
    onPick: (fn) => {
      pickFn = fn;
    },
    redraw: drawOverlay,
    setNote: (text) => {
      note.hidden = text === null;
      note.textContent = text ?? '';
    },
    dispose: () => {
      ro.disconnect();
      over.removeEventListener('pointermove', onMove);
      over.removeEventListener('pointerdown', onMove);
      over.removeEventListener('pointerleave', idle);
      over.removeEventListener('click', onClick);
    },
  };
}
