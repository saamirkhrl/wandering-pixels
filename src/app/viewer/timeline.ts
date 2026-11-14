import '../../ui/timeline.css';

export interface TimelineFrame {
  mjd: number;
  label: string;
  shortDate: string;
  wavelength: number;
  visitIndex: number;
}

export interface Timeline {
  el: HTMLElement;
  set(frames: TimelineFrame[], current: number, a: number | null, b: number | null): void;
  setPickEnabled(on: boolean): void;
  setPairMarks(indices: number[]): void;
  dispose(): void;
}

export interface TimelineHandlers {
  onShow(index: number): void;
  onPickA(index: number): void;
  onPickB(index: number): void;
}

export interface Tick {
  mjd: number;
  x: number;
  label: string;
}

export const PAD = 24;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UNIX_MJD = 40587;
const DAY_MS = 86400000;
const HIT = 44;

export function layoutMarks(mjds: number[], width: number): number[] {
  if (mjds.length === 0) return [];
  const lo = Math.min(...mjds);
  const hi = Math.max(...mjds);
  const inner = Math.max(0, width - 2 * PAD);
  if (!(hi > lo)) return mjds.map(() => PAD + inner / 2);
  return mjds.map((m) => PAD + ((m - lo) / (hi - lo)) * inner);
}

export function pickLabelIndexes(xs: number[], labelWidth: number): number[] {
  const n = xs.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (out.length === 0 || Math.abs(xs[i] - xs[out[out.length - 1]]) >= labelWidth) out.push(i);
  }
  if (n > 0 && out[out.length - 1] !== n - 1) {
    while (out.length > 1 && Math.abs(xs[n - 1] - xs[out[out.length - 1]]) < labelWidth) out.pop();
    if (Math.abs(xs[n - 1] - xs[out[out.length - 1]]) >= labelWidth) out.push(n - 1);
  }
  return out;
}

export function ticksFor(minMjd: number, maxMjd: number, width: number, labelWidth = 56): Tick[] {
  if (!(maxMjd > minMjd)) return [];
  const inner = Math.max(1, width - 2 * PAD);
  const pxPerDay = inner / (maxMjd - minMjd);
  const steps = [1, 2, 3, 6, 12, 24, 60, 120, 240];
  let step = steps[steps.length - 1];
  for (const s of steps) {
    if (s * 28 * pxPerDay >= labelWidth) {
      step = s;
      break;
    }
  }
  const d0 = new Date((minMjd - UNIX_MJD) * DAY_MS);
  let mi = d0.getUTCFullYear() * 12 + d0.getUTCMonth();
  while (mi % step !== 0) mi++;
  if (step >= 12) while (mi % 12 !== 0 || (mi / 12) % (step / 12) !== 0) mi++;
  const out: Tick[] = [];
  for (; ; mi += step) {
    const y = Math.floor(mi / 12);
    const m = mi - y * 12;
    const mjd = Date.UTC(y, m, 1) / DAY_MS + UNIX_MJD;
    if (mjd > maxMjd) break;
    if (mjd < minMjd) continue;
    out.push({
      mjd,
      x: PAD + ((mjd - minMjd) / (maxMjd - minMjd)) * inner,
      label: step >= 12 ? String(y) : `${MONTHS[m]} ${y}`,
    });
  }
  return out;
}

export function clampCenter(x: number, w: number, width: number): number {
  if (w >= width) return width / 2;
  return Math.min(Math.max(x, w / 2), width - w / 2);
}

export function nearestIndex(xs: number[], x: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const d = Math.abs(xs[i] - x);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function div(cls: string): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  return e;
}

export function createTimeline(h: TimelineHandlers): Timeline {
  const root = div('tl');
  const track = div('tl-track');
  track.setAttribute('role', 'group');
  track.setAttribute('aria-label', 'Timeline of images');
  const layer = div('tl-layer');
  track.appendChild(layer);
  const caption = document.createElement('p');
  caption.className = 'tl-caption';
  const hint = document.createElement('p');
  hint.className = 'tl-hint';
  hint.textContent = 'Drag the A and B flags to choose the two images to compare.';
  root.append(track, caption, hint);

  let frames: TimelineFrame[] = [];
  let xs: number[] = [];
  let width = 0;
  let cur = 0;
  let a: number | null = null;
  let b: number | null = null;
  let pickOn = true;
  let good = new Set<number>();
  let hot: number | null = null;
  let rove = 0;
  let buttons: HTMLButtonElement[] = [];
  let drag: 'A' | 'B' | null = null;

  const makeFlag = (name: 'A' | 'B'): HTMLElement => {
    const f = document.createElement('div');
    f.className = `tl-flag tl-flag-${name.toLowerCase()}`;
    f.tabIndex = 0;
    f.setAttribute('role', 'slider');
    f.setAttribute('aria-label', `Image ${name}`);
    f.setAttribute('aria-orientation', 'horizontal');
    const box = document.createElement('span');
    box.className = 'tl-flag-box';
    box.textContent = name;
    const stem = document.createElement('span');
    stem.className = 'tl-flag-stem';
    f.append(box, stem);
    track.appendChild(f);
    return f;
  };
  const flagA = makeFlag('A');
  const flagB = makeFlag('B');

  const clamp = (i: number): number => Math.max(0, Math.min(frames.length - 1, i));

  const setPick = (which: 'A' | 'B', i: number): void => {
    if (which === 'A') {
      if (a === i) return;
      a = i;
      h.onPickA(i);
    } else {
      if (b === i) return;
      b = i;
      h.onPickB(i);
    }
    refresh();
  };

  const placeFlag = (f: HTMLElement, idx: number | null, shift: number): void => {
    if (!pickOn || idx === null || idx < 0 || idx >= frames.length) {
      f.hidden = true;
      return;
    }
    f.hidden = false;
    f.style.left = `${xs[idx] - HIT / 2 + shift}px`;
    f.setAttribute('aria-valuemin', '0');
    f.setAttribute('aria-valuemax', String(frames.length - 1));
    f.setAttribute('aria-valuenow', String(idx));
    f.setAttribute('aria-valuetext', frames[idx].label);
  };

  const refresh = (): void => {
    const n = frames.length;
    rove = n ? clamp(rove) : 0;
    buttons.forEach((btn, i) => {
      btn.classList.toggle('tl-current', i === cur);
      btn.classList.toggle('tl-pairok', good.has(i));
      if (i === cur) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
      btn.tabIndex = i === rove ? 0 : -1;
    });
    const same = a !== null && a === b;
    placeFlag(flagA, a, same ? -12 : 0);
    placeFlag(flagB, b, same ? 12 : 0);
    hint.hidden = !pickOn;
    const idx = hot ?? cur;
    caption.textContent = idx >= 0 && idx < n ? frames[idx].label : '';
  };

  const rebuild = (): void => {
    width = track.clientWidth || width || 358;
    xs = layoutMarks(
      frames.map((f) => f.mjd),
      width,
    );
    layer.replaceChildren();
    buttons = [];
    if (frames.length === 0) return;
    const axis = div('tl-axis');
    layer.appendChild(axis);

    let s = 0;
    while (s < frames.length) {
      let e = s;
      while (e + 1 < frames.length && frames[e + 1].visitIndex === frames[s].visitIndex) e++;
      const band = div('tl-band');
      band.style.left = `${xs[s] - 2}px`;
      band.style.width = `${xs[e] - xs[s] + 4}px`;
      layer.appendChild(band);
      s = e + 1;
    }

    const tickLabels: { lab: HTMLElement; x: number }[] = [];
    const markLabels: { lab: HTMLElement; x: number; left: number }[] = [];
    const mjds = frames.map((f) => f.mjd);
    const lo = Math.min(...mjds);
    const hi = Math.max(...mjds);
    for (const t of ticksFor(lo, hi, width)) {
      const tk = div('tl-tick');
      tk.style.left = `${t.x}px`;
      const lab = document.createElement('span');
      lab.className = 'tl-tick-label';
      lab.textContent = t.label;
      lab.style.left = `${clampCenter(t.x, t.label.length * 6.6 + 2, width) - t.x}px`;
      tk.appendChild(lab);
      tickLabels.push({ lab, x: t.x });
      layer.appendChild(tk);
    }

    const maxLen = Math.max(...frames.map((f) => f.shortDate.length));
    const labelIdx = new Set(pickLabelIndexes(xs, maxLen * 6.4 + 10));
    frames.forEach((f, i) => {
      const left = i === 0 ? Math.max(0, xs[i] - HIT / 2) : (xs[i - 1] + xs[i]) / 2;
      const right = i === frames.length - 1 ? Math.min(width, xs[i] + HIT / 2) : (xs[i] + xs[i + 1]) / 2;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tl-mark';
      btn.dataset.i = String(i);
      btn.title = f.label;
      btn.setAttribute('aria-label', f.label);
      btn.style.left = `${left}px`;
      btn.style.width = `${Math.max(1, right - left)}px`;
      const dot = document.createElement('span');
      dot.className = 'tl-dot';
      dot.style.left = `${xs[i] - left}px`;
      btn.appendChild(dot);
      if (labelIdx.has(i)) {
        const lab = document.createElement('span');
        lab.className = 'tl-mark-label';
        lab.textContent = f.shortDate;
        lab.style.left = `${clampCenter(xs[i], f.shortDate.length * 6.6 + 2, width) - left}px`;
        btn.appendChild(lab);
        markLabels.push({ lab, x: xs[i], left });
      }
      layer.appendChild(btn);
      buttons.push(btn);
    });
    for (const m of markLabels) {
      const w = m.lab.offsetWidth;
      if (w > 0) m.lab.style.left = `${clampCenter(m.x, w, width) - m.left}px`;
    }
    for (const t of tickLabels) {
      const w = t.lab.offsetWidth;
      if (w > 0) t.lab.style.left = `${clampCenter(t.x, w, width) - t.x}px`;
    }
  };

  const markIndex = (t: EventTarget | null): number | null => {
    const m = t instanceof Element ? t.closest<HTMLElement>('.tl-mark') : null;
    return m ? Number(m.dataset.i) : null;
  };

  const onKey = (e: KeyboardEvent): void => {
    const i = markIndex(e.target);
    if (i === null) return;
    const n = frames.length;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      h.onShow(i);
      return;
    }
    let ni: number | null = null;
    if (e.key === 'ArrowLeft') ni = i - 1;
    else if (e.key === 'ArrowRight') ni = i + 1;
    else if (e.key === 'Home') ni = 0;
    else if (e.key === 'End') ni = n - 1;
    if (ni === null) return;
    e.preventDefault();
    ni = clamp(ni);
    rove = ni;
    refresh();
    buttons[ni]?.focus();
    h.onShow(ni);
  };

  const onClick = (e: MouseEvent): void => {
    const i = markIndex(e.target);
    if (i === null || e.detail === 0) return;
    if (pickOn && e.shiftKey) setPick('B', i);
    else if (pickOn && e.altKey) setPick('A', i);
    else h.onShow(i);
  };

  const onOver = (e: Event): void => {
    const i = markIndex(e.target);
    if (i !== null && hot !== i) {
      hot = i;
      refresh();
    }
  };
  const onOut = (e: Event): void => {
    if (markIndex(e.target) !== null && hot !== null) {
      hot = null;
      refresh();
    }
  };
  const onFocusIn = (e: Event): void => {
    const i = markIndex(e.target);
    if (i !== null) {
      rove = i;
      hot = i;
      refresh();
    }
  };

  const flagKey = (which: 'A' | 'B') => (e: KeyboardEvent): void => {
    const cur2 = which === 'A' ? a : b;
    if (cur2 === null) return;
    let ni: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') ni = cur2 - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') ni = cur2 + 1;
    else if (e.key === 'Home') ni = 0;
    else if (e.key === 'End') ni = frames.length - 1;
    if (ni === null) return;
    e.preventDefault();
    setPick(which, clamp(ni));
  };

  const dragStart = (which: 'A' | 'B', f: HTMLElement) => (e: PointerEvent): void => {
    drag = which;
    f.classList.add('tl-dragging');
    try {
      f.setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture unavailable */
    }
    f.focus();
    e.preventDefault();
  };
  const dragMove = (which: 'A' | 'B') => (e: PointerEvent): void => {
    if (drag !== which || frames.length === 0) return;
    const r = track.getBoundingClientRect();
    setPick(which, nearestIndex(xs, e.clientX - r.left));
  };
  const dragEnd = (f: HTMLElement) => (e: PointerEvent): void => {
    drag = null;
    f.classList.remove('tl-dragging');
    try {
      f.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  };

  track.addEventListener('keydown', onKey);
  track.addEventListener('click', onClick);
  track.addEventListener('mouseover', onOver);
  track.addEventListener('mouseout', onOut);
  track.addEventListener('focusin', onFocusIn);
  track.addEventListener('focusout', onOut);
  const flags: [HTMLElement, 'A' | 'B'][] = [
    [flagA, 'A'],
    [flagB, 'B'],
  ];
  for (const [f, w] of flags) {
    f.addEventListener('keydown', flagKey(w));
    f.addEventListener('pointerdown', dragStart(w, f));
    f.addEventListener('pointermove', dragMove(w));
    f.addEventListener('pointerup', dragEnd(f));
    f.addEventListener('pointercancel', dragEnd(f));
  }

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      const w = track.clientWidth;
      if (w > 0 && Math.abs(w - width) >= 1) {
        rebuild();
        refresh();
      }
    });
    ro.observe(track);
  }

  return {
    el: root,
    set(next, current, na, nb): void {
      const changed =
        next.length !== frames.length ||
        next.some((f, i) => f.mjd !== frames[i].mjd || f.label !== frames[i].label || f.shortDate !== frames[i].shortDate);
      frames = next;
      cur = current;
      if (drag !== 'A') a = na;
      if (drag !== 'B') b = nb;
      hot = null;
      if (changed) {
        rebuild();
        rove = next.length ? Math.max(0, Math.min(next.length - 1, current)) : 0;
      } else if (!track.contains(document.activeElement)) {
        rove = next.length ? Math.max(0, Math.min(next.length - 1, current)) : 0;
      }
      refresh();
    },
    setPairMarks(indices): void {
      good = new Set(indices);
      refresh();
    },
    setPickEnabled(on): void {
      pickOn = on;
      refresh();
    },
    dispose(): void {
      ro?.disconnect();
      root.remove();
    },
  };
}
