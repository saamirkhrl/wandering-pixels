import type { SpectrumPoint } from '../data';
import { renderChangeBlock } from './change';
import type { ChangeBlockHandle, ChangeContext } from './change';
import '../../ui/viewer-parts.css';

export interface SpectrumPanel {
  el: HTMLElement;
  show(
    points: SpectrumPoint[],
    where: { ra: number; dec: number },
    visitLabel: (visitIndex: number) => string,
    visitNo?: (visitIndex: number) => number,
    ctx?: ChangeContext,
  ): void;
  clear(): void;
  // a short reason in place of the spectrum, for example while every exposure is still loading
  wait(text: string): void;
  dispose(): void;
}

const NS = 'http://www.w3.org/2000/svg';
const PALETTE = ['#1f5fa8', '#c4561d', '#2e7d4f', '#7a3fa0', '#8a6d12', '#1c7c8c'];
const EMPTY_TEXT = 'Click a spot on the image to measure its brightness at every wavelength.';

const W = 520;
const H = 260;
const M = { l: 56, r: 12, t: 10, b: 44 };

// keyed by the displayed 1-based visit number so a visit keeps its colour
export function visitColour(visitNumber: number): string {
  const n = PALETTE.length;
  return PALETTE[((Math.round(visitNumber) - 1) % n + n) % n];
}

const CSV_HEAD = [
  'exposure_id',
  'wavelength_um',
  'bandwidth_um',
  'flux_mJy',
  'flux_err_mJy',
  'time_utc',
  'mjd',
  'visit',
  'detector',
  'flagged',
];

function csvCell(v: string | number | boolean): string {
  if (typeof v === 'number' && !Number.isFinite(v)) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function spectrumCsv(points: SpectrumPoint[], visitNo: (visitIndex: number) => number = (v) => v + 1): string {
  const lines = [CSV_HEAD.join(',')];
  for (const p of points) {
    lines.push(
      [
        p.exposureId,
        p.wavelength,
        p.bandwidth,
        p.flux,
        p.fluxErr,
        p.time,
        p.mjd,
        visitNo(p.visitIndex),
        p.detector,
        p.flagged ? 1 : 0,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: SVGElement,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return e;
}

function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  const m = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return m * mag;
}

function linearTicks(lo: number, hi: number, target: number): number[] {
  const step = niceStep(hi - lo, target);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

function logTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  const a = Math.floor(Math.log10(lo));
  const b = Math.ceil(Math.log10(hi));
  for (let e = a; e <= b; e++) {
    for (const m of [1, 3]) {
      const v = m * Math.pow(10, e);
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
    }
  }
  if (out.length < 2) out.push(lo, hi);
  return out;
}

function fmtTick(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e4 || a < 1e-2) return v.toExponential(0).replace('e+', 'e');
  const s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function fmtNum(v: number, dp: number): string {
  return Number.isFinite(v) ? v.toFixed(dp) : '';
}

function pointTitle(p: SpectrumPoint, visitNo: number): string {
  return `${fmtNum(p.wavelength, 2)} um, ${fmtNum(p.flux, 1)} +/- ${fmtNum(p.fluxErr, 1)} mJy, visit ${visitNo}`;
}

export function isUsablePoint(p: SpectrumPoint): boolean {
  return Number.isFinite(p.flux) && Number.isFinite(p.wavelength) && Number.isFinite(p.fluxErr);
}

function bwOf(p: SpectrumPoint): number {
  return Number.isFinite(p.bandwidth) ? p.bandwidth : 0;
}

function fileNum(v: number): string {
  return v.toFixed(5);
}

// Block below the spectrum: has this star changed between visits. Rendered only when this flag is on.
export const CHANGE_BLOCK_ENABLED = true;

export function createSpectrumPanel(): SpectrumPanel {
  const root = el('section', 'v-sec v-spec');
  root.appendChild(el('h3', 'v-h', 'Spectrum here'));
  const body = el('div', 'v-spec-body');
  root.appendChild(body);
  const changeHost = el('div', 'v-changeblock');
  changeHost.hidden = true;
  let changeHandle: ChangeBlockHandle | null = null;
  const dropChange = (): void => {
    changeHandle?.dispose();
    changeHandle = null;
    changeHost.hidden = true;
    changeHost.replaceChildren();
  };
  if (CHANGE_BLOCK_ENABLED) root.appendChild(changeHost);
  let urlToRevoke: string | null = null;
  let timer: number | null = null;

  const clear = (): void => {
    dropChange();
    body.replaceChildren(el('p', 'v-hint', EMPTY_TEXT));
  };

  const wait = (text: string): void => {
    dropChange();
    body.replaceChildren(el('p', 'v-hint', text));
  };

  const show: SpectrumPanel['show'] = (points, where, visitLabel, visitNo = (v) => v + 1, ctx) => {
    dropChange();
    body.replaceChildren();
    const pos = `RA ${fileNum(where.ra)}, Dec ${fileNum(where.dec)} degrees`;
    if (points.length === 0) {
      body.appendChild(el('p', undefined, `Position ${pos}.`));
      body.appendChild(el('p', undefined, 'No exposures cover this spot.'));
      return;
    }
    const n = points.length;
    body.appendChild(
      el('p', undefined, `Position ${pos}. ${n} ${n === 1 ? 'measurement' : 'measurements'}.`),
    );

    const usable = points.filter(isUsablePoint);
    const bad = n - usable.length;
    if (bad > 0 && usable.length > 0) {
      body.appendChild(
        el('p', 'v-hint', `${bad} ${bad === 1 ? 'measurement' : 'measurements'} could not be made here (masked or saturated pixels).`),
      );
    }
    if (usable.length === 0) {
      body.appendChild(el('p', undefined, 'No usable measurements here: the pixels are masked or saturated.'));
    } else {
      const flux = usable.map((p) => p.flux);
      const posFlux = flux.filter((f) => f > 0);
      const useLog =
        posFlux.length >= 2 && Math.max(...posFlux) / Math.min(...posFlux) > 100;

      // x domain
      let xLo = Infinity;
      let xHi = -Infinity;
      for (const p of usable) {
        xLo = Math.min(xLo, p.wavelength - bwOf(p) / 2);
        xHi = Math.max(xHi, p.wavelength + bwOf(p) / 2);
      }
      if (!(xHi > xLo)) {
        xLo -= 0.1;
        xHi += 0.1;
      }
      const xPad = (xHi - xLo) * 0.04;
      xLo -= xPad;
      xHi += xPad;

      // y domain
      let yLo: number;
      let yHi: number;
      let yTicks: number[];
      if (useLog) {
        const minPos = Math.min(...posFlux);
        let top = -Infinity;
        for (const p of usable) top = Math.max(top, p.flux + p.fluxErr);
        yLo = minPos / 1.5;
        yHi = top * 1.5;
        yTicks = logTicks(yLo, yHi);
      } else {
        let lo = Infinity;
        let hi = -Infinity;
        for (const p of usable) {
          lo = Math.min(lo, p.flux - p.fluxErr);
          hi = Math.max(hi, p.flux + p.fluxErr);
        }
        if (!(hi > lo)) {
          lo -= 1;
          hi += 1;
        }
        const pad = (hi - lo) * 0.06;
        yLo = lo - pad;
        yHi = hi + pad;
        yTicks = linearTicks(yLo, yHi, 5);
      }
      const xTicks = linearTicks(xLo, xHi, 6);

      const pw = W - M.l - M.r;
      const ph = H - M.t - M.b;
      const sx = (v: number): number => M.l + ((v - xLo) / (xHi - xLo)) * pw;
      const sy = (v: number): number => {
        if (useLog) {
          const c = Math.max(v, yLo);
          return M.t + ph - ((Math.log(c) - Math.log(yLo)) / (Math.log(yHi) - Math.log(yLo))) * ph;
        }
        return M.t + ph - ((v - yLo) / (yHi - yLo)) * ph;
      };
      const clampY = (y: number): number => Math.min(M.t + ph, Math.max(M.t, y));

      const chart = svg('svg', {
        viewBox: `0 0 ${W} ${H}`,
        class: 'v-spec-chart',
        role: 'img',
        'aria-label': `Flux in millijansky against wavelength in micrometres, ${usable.length} points`,
      });
      const style = 'currentColor';

      // grid and ticks
      for (const t of yTicks) {
        const y = sy(t);
        svg('line', { x1: M.l, x2: M.l + pw, y1: y, y2: y, class: 'v-spec-grid' }, chart);
        const lab = svg('text', { x: M.l - 6, y: y + 4, 'text-anchor': 'end', class: 'v-spec-tick' }, chart);
        lab.textContent = fmtTick(t);
      }
      for (const t of xTicks) {
        const x = sx(t);
        svg('line', { x1: x, x2: x, y1: M.t + ph, y2: M.t + ph + 4, stroke: style, class: 'v-spec-axis' }, chart);
        const lab = svg('text', { x, y: M.t + ph + 17, 'text-anchor': 'middle', class: 'v-spec-tick' }, chart);
        lab.textContent = fmtTick(t);
      }
      svg('line', { x1: M.l, x2: M.l, y1: M.t, y2: M.t + ph, class: 'v-spec-axis' }, chart);
      svg('line', { x1: M.l, x2: M.l + pw, y1: M.t + ph, y2: M.t + ph, class: 'v-spec-axis' }, chart);

      const xl = svg('text', { x: M.l + pw / 2, y: H - 6, 'text-anchor': 'middle', class: 'v-spec-label' }, chart);
      xl.textContent = 'Wavelength (micrometres)';
      const yl = svg(
        'text',
        {
          transform: `translate(12 ${M.t + ph / 2}) rotate(-90)`,
          'text-anchor': 'middle',
          class: 'v-spec-label',
        },
        chart,
      );
      yl.textContent = useLog ? 'Flux (mJy), log scale' : 'Flux (mJy)';

      // points
      for (const p of usable) {
        const col = visitColour(visitNo(p.visitIndex));
        const g = svg('g', { class: 'v-spec-pt', stroke: col, fill: p.flagged ? 'none' : col }, chart);
        const cx = sx(p.wavelength);
        const cy = sy(p.flux);
        const x0 = sx(p.wavelength - bwOf(p) / 2);
        const x1 = sx(p.wavelength + bwOf(p) / 2);
        const y0 = clampY(sy(p.flux - p.fluxErr));
        const y1 = clampY(sy(p.flux + p.fluxErr));
        svg('line', { x1: x0, x2: x1, y1: cy, y2: cy, 'stroke-width': 1, fill: 'none' }, g);
        svg('line', { x1: cx, x2: cx, y1: y0, y2: y1, 'stroke-width': 1.5, fill: 'none' }, g);
        svg('circle', { cx, cy, r: 3.5, 'stroke-width': 1.5 }, g);
        const t = svg('title', {}, g);
        t.textContent = pointTitle(p, visitNo(p.visitIndex));
      }
      const wrap = el('div', 'v-spec-wrap');
      wrap.appendChild(chart);
      body.appendChild(wrap);

      // legend
      const byNo = new Map<number, number>();
      for (const p of usable) {
        const no = visitNo(p.visitIndex);
        if (!byNo.has(no)) byNo.set(no, p.visitIndex);
      }
      const legend = el('ul', 'v-spec-legend');
      for (const no of Array.from(byNo.keys()).sort((a, b) => a - b)) {
        const li = el('li');
        const sw = el('span', 'v-spec-swatch');
        sw.style.background = visitColour(no);
        sw.setAttribute('aria-hidden', 'true');
        li.appendChild(sw);
        li.appendChild(document.createTextNode(visitLabel(byNo.get(no) as number)));
        legend.appendChild(li);
      }
      body.appendChild(legend);

      if (usable.some((p) => p.flagged)) {
        body.appendChild(el('p', 'v-hint', 'Hollow points touch a masked or saturated pixel.'));
      }
      if (useLog) {
        body.appendChild(
          el('p', 'v-hint', 'The brightest and faintest points differ by more than 100 times, so the flux axis is logarithmic.'),
        );
      }
    }

    // table
    const det = el('details', 'v-spec-details');
    det.appendChild(el('summary', 'v-spec-sum', 'Table of points'));
    const scroll = el('div', 'v-spec-scroll');
    const table = el('table', 'v-spec-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const c of ['Visit', 'Wavelength (um)', 'Flux (mJy)', 'Error (mJy)', 'Masked']) {
      const th = el('th', undefined, c);
      th.scope = 'col';
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const p of points) {
      const tr = el('tr');
      tr.appendChild(el('td', undefined, String(visitNo(p.visitIndex))));
      tr.appendChild(el('td', undefined, fmtNum(p.wavelength, 3)));
      tr.appendChild(el('td', undefined, fmtNum(p.flux, 2)));
      tr.appendChild(el('td', undefined, fmtNum(p.fluxErr, 2)));
      tr.appendChild(el('td', undefined, p.flagged ? 'yes' : 'no'));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    det.appendChild(scroll);
    body.appendChild(det);

    if (CHANGE_BLOCK_ENABLED && ctx) {
      changeHost.hidden = false;
      changeHandle = renderChangeBlock(changeHost, ctx, where.ra, where.dec);
    }

    // download
    const row = el('div', 'v-row');
    const btn = el('button', 'v-btn', 'Download CSV');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const blob = new Blob([spectrumCsv(points, visitNo)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      urlToRevoke = url;
      const a = document.createElement('a');
      a.href = url;
      a.download = `spectrum-${fileNum(where.ra)}-${fileNum(where.dec)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (urlToRevoke === url) {
          URL.revokeObjectURL(url);
          urlToRevoke = null;
        }
        timer = null;
      }, 1000);
    });
    row.appendChild(btn);
    body.appendChild(row);
  };

  clear();

  return {
    el: root,
    show,
    clear,
    wait,
    dispose(): void {
      dropChange();
      if (timer !== null) window.clearTimeout(timer);
      if (urlToRevoke) URL.revokeObjectURL(urlToRevoke);
      urlToRevoke = null;
      timer = null;
      root.remove();
    },
  };
}
