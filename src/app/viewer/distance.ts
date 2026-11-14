import { COPY, fill } from './distance-copy';
import '../../ui/distance.css';

export interface DistanceReadout {
  pxPerPercent: number | null;
  jumpArcsec: number | null;
  jumpPx: number | null;
  spanDays: number | null;
}

export interface DistanceControl {
  el: HTMLElement;
  setAvailable(on: boolean, reason?: string): void;
  setValue(distanceAu: number | null): void;
  setReadout(r: DistanceReadout | null): void;
  setLoading(p: { done: number; total: number; bytes?: number } | null): void;
  setSim(on: boolean): void;
  dispose(): void;
}

export const RING_PX_500AU_PER_6MO = 9;
const REF_SCALE_ARCSEC = 6.15;
export const AU_MIN = 100;
export const AU_MAX = 2000;
export const AU_DEFAULT = 500;
const SLIDER_STEPS = 1000;
const DEBOUNCE_MS = 400;

export function ringRadiusPx(distanceAu: number, spanDays: number, scaleArcsec: number): number {
  return (
    RING_PX_500AU_PER_6MO *
    (REF_SCALE_ARCSEC / scaleArcsec) *
    Math.pow(500 / distanceAu, 1.5) *
    (spanDays / 182.6)
  );
}

export function clampAu(v: number): number {
  if (!Number.isFinite(v)) return AU_DEFAULT;
  return Math.min(AU_MAX, Math.max(AU_MIN, v));
}

export function sliderToAu(pos: number): number {
  const t = Math.min(1, Math.max(0, pos / SLIDER_STEPS));
  return AU_MIN * Math.pow(AU_MAX / AU_MIN, t);
}

export function auToSlider(au: number): number {
  return (Math.log(clampAu(au) / AU_MIN) / Math.log(AU_MAX / AU_MIN)) * SLIDER_STEPS;
}

export function nudgeAu(au: number, dir: 1 | -1): number {
  const next = au * (dir > 0 ? 1.01 : 0.99);
  return clampAu(Math.round(next * 10) / 10);
}

function fmtAu(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let uid = 0;

export function createDistanceControl(
  h: { onChange(distanceAu: number | null): void },
  opts: { bare?: boolean } = {},
): DistanceControl {
  const id = `dist-${++uid}`;
  const root = el('section', 'v-sec dist');
  if (!opts.bare) root.appendChild(el('h3', 'v-h', COPY.title));

  const reason = el('p', 'dist-reason');
  reason.hidden = true;
  root.appendChild(reason);

  const offRow = el('div', 'dist-row');
  const onBtn = el('button', 'dist-btn', 'Turn on');
  onBtn.type = 'button';
  offRow.appendChild(onBtn);
  root.appendChild(offRow);

  const onBox = el('div', 'dist-on');
  onBox.hidden = true;
  root.appendChild(onBox);

  const fieldRow = el('div', 'dist-row');
  const label = el('label', 'dist-label', 'Distance in au');
  label.htmlFor = `${id}-num`;
  const num = el('input', 'dist-num');
  num.id = `${id}-num`;
  num.type = 'number';
  num.min = String(AU_MIN);
  num.max = String(AU_MAX);
  num.step = '1';
  num.inputMode = 'decimal';
  fieldRow.append(label, num, el('span', 'dist-unit', 'au'));
  onBox.appendChild(fieldRow);

  const slider = el('input', 'dist-range');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(SLIDER_STEPS);
  slider.step = '1';
  slider.setAttribute('aria-label', 'Distance in au, logarithmic slider');
  onBox.appendChild(slider);

  const nudgeRow = el('div', 'dist-row');
  const minus = el('button', 'dist-btn', '-1 percent');
  minus.type = 'button';
  minus.setAttribute('aria-label', 'Decrease distance by 1 percent');
  const plus = el('button', 'dist-btn', '+1 percent');
  plus.type = 'button';
  plus.setAttribute('aria-label', 'Increase distance by 1 percent');
  const offBtn = el('button', 'dist-btn', 'Turn off');
  offBtn.type = 'button';
  nudgeRow.append(minus, plus, offBtn);
  onBox.appendChild(nudgeRow);

  const example = el('p', 'dist-hint', COPY.example);
  const onText = el('p', 'dist-p');
  const readout = el('div', 'dist-readout');
  readout.setAttribute('aria-live', 'polite');
  onBox.append(example, onText, readout);

  const loading = el('p', 'dist-loading');
  loading.setAttribute('role', 'status');
  loading.hidden = true;
  root.appendChild(loading);

  if (!opts.bare) {
    root.appendChild(el('p', 'dist-p', COPY.brightness));
    root.appendChild(el('p', 'dist-hint', COPY.sources));
    root.appendChild(el('p', 'dist-p', COPY.deeper));
  }

  let value: number | null = null;
  let available = true;
  let timer: number | null = null;
  let lastReadout: DistanceReadout | null = null;
  let sim = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const drawReadout = (): void => {
    readout.replaceChildren();
    if (value === null) return;
    const r = lastReadout;
    if (r && r.pxPerPercent !== null && Number.isFinite(r.pxPerPercent)) {
      readout.appendChild(el('p', 'dist-p', fill(COPY.fine, { px: r.pxPerPercent.toFixed(1) })));
    }
    if (r && r.jumpArcsec !== null && r.jumpPx !== null && Number.isFinite(r.jumpArcsec) && Number.isFinite(r.jumpPx)) {
      readout.appendChild(
        el('p', 'dist-p', fill(COPY.jump, { arcsec: r.jumpArcsec.toFixed(1), px: r.jumpPx.toFixed(1) })),
      );
    }
    readout.appendChild(el('p', 'dist-p', sim ? COPY.orbitalSim : COPY.orbital));
  };

  const draw = (): void => {
    const on = value !== null;
    offRow.hidden = on;
    onBox.hidden = !on || !available;
    offRow.hidden = on || !available;
    if (value !== null) {
      if (document.activeElement !== num) num.value = fmtAu(value);
      slider.value = String(Math.round(auToSlider(value)));
      onText.textContent = fill(COPY.on, { D: fmtAu(value) });
    }
    drawReadout();
  };

  const schedule = (): void => {
    clearTimer();
    timer = window.setTimeout(() => {
      timer = null;
      h.onChange(value);
    }, DEBOUNCE_MS);
  };

  const commit = (): void => {
    clearTimer();
    h.onChange(value);
  };

  const apply = (v: number, immediate: boolean): void => {
    value = clampAu(v);
    draw();
    if (immediate) commit();
    else schedule();
  };

  onBtn.addEventListener('click', () => apply(AU_DEFAULT, true));
  offBtn.addEventListener('click', () => {
    clearTimer();
    value = null;
    draw();
    h.onChange(null);
  });
  minus.addEventListener('click', () => apply(nudgeAu(value ?? AU_DEFAULT, -1), false));
  plus.addEventListener('click', () => apply(nudgeAu(value ?? AU_DEFAULT, 1), false));
  slider.addEventListener('input', () => {
    const au = Math.round(sliderToAu(Number(slider.value)) * 10) / 10;
    if (document.activeElement !== num) num.value = fmtAu(clampAu(au));
    else num.value = fmtAu(clampAu(au));
    value = clampAu(au);
    onText.textContent = fill(COPY.on, { D: fmtAu(value) });
    schedule();
  });
  num.addEventListener('input', () => {
    const v = Number(num.value);
    if (num.value === '' || !Number.isFinite(v) || v < AU_MIN || v > AU_MAX) return;
    value = v;
    slider.value = String(Math.round(auToSlider(v)));
    onText.textContent = fill(COPY.on, { D: fmtAu(v) });
    schedule();
  });
  num.addEventListener('change', () => {
    const v = Number(num.value);
    apply(num.value === '' ? (value ?? AU_DEFAULT) : v, false);
    num.value = fmtAu(value ?? AU_DEFAULT);
  });
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = Number(num.value);
      value = clampAu(num.value === '' ? (value ?? AU_DEFAULT) : v);
      num.value = fmtAu(value);
      draw();
      commit();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      const base = Number.isFinite(Number(num.value)) && num.value !== '' ? Number(num.value) : (value ?? AU_DEFAULT);
      value = clampAu(base + step);
      num.value = fmtAu(value);
      draw();
      schedule();
    }
  });

  draw();

  return {
    el: root,
    setAvailable(on, why): void {
      available = on;
      for (const c of [onBtn, offBtn, minus, plus, num, slider]) c.disabled = !on;
      root.classList.toggle('dist-unavailable', !on);
      reason.hidden = on;
      reason.textContent = on ? '' : (why ?? COPY.unavailablePrepared);
      if (!on) clearTimer();
      draw();
    },
    setValue(d): void {
      clearTimer();
      value = d === null ? null : clampAu(d);
      draw();
    },
    setReadout(r): void {
      lastReadout = r;
      drawReadout();
    },
    setLoading(p): void {
      if (!p) {
        loading.hidden = true;
        loading.textContent = '';
        return;
      }
      loading.hidden = false;
      const mb = p.bytes !== undefined ? `, ${(p.bytes / 1e6).toFixed(0)} MB` : '';
      loading.textContent = `Loading ${p.done} of ${p.total} images${mb}`;
    },
    setSim(on): void {
      sim = on;
      drawReadout();
    },
    dispose(): void {
      clearTimer();
      root.remove();
    },
  };
}
