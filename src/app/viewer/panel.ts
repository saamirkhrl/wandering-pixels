import { isMock } from '../data';
import type { Detector, MovieMode, Progress, SpherexErrorCode } from '../data';
import { divergingColor } from './render';
import type { PlayMode } from './player';
import { STAGE_WORDS } from './load';

export interface FrameInfo {
  caption: string;
  detail: string;
  tip: string;
  option: string;
  mjd: number;
}

export interface CompareInfo {
  rangeText: string;
  unit: 'MJy/sr' | 'sigma';
  warning: string | null;
  note: string;
}

export interface PanelModel {
  frames: FrameInfo[];
  index: number;
  a: number;
  b: number;
  playMode: PlayMode;
  fps: number;
  diff: boolean;
  snr: boolean;
  mode: MovieMode;
  det: Detector;
  detectorList: { detector: Detector; label: string; enabled: boolean }[];
  size: number;
  sizeEnabled: boolean;
  sizeNote: string;
  overlays: { gaia: boolean; wise: boolean; masked: boolean };
  wiseAvailable: boolean;
  overlayNote: string;
  compare: CompareInfo | null;
}

export interface PanelHandlers {
  blink: () => void;
  playPause: () => void;
  step: (d: number) => void;
  speed: (fps: number) => void;
  selectFrame: (i: number) => void;
  setMode: (m: MovieMode) => void;
  setDet: (d: Detector) => void;
  setDiff: (on: boolean) => void;
  setSnr: (on: boolean) => void;
  setA: (i: number) => void;
  setB: (i: number) => void;
  retry: () => void;
  cancel: () => void;
  openTarget: (name: string) => void;
  loadRest: () => void;
  stopRest: () => void;
  setSize: (n: number) => void;
  toggleOverlay: (k: 'gaia' | 'wise' | 'masked') => void;
  goBack: () => void;
  openPrepared: () => void;
}

export type RestState =
  | { kind: 'optin'; n: number; mb: number; single: boolean }
  | { kind: 'loading'; done: number; total: number; mb: number }
  | { kind: 'stopped'; n: number; mb: number; loaded: number; total: number; single: boolean };

export interface Panel {
  el: HTMLElement;
  setBack: (label: string | null) => void;
  setSkyEntry: (name: string | null) => void;
  attach: (spectrum: HTMLElement, quality: HTMLElement) => void;
  toggleHelp: () => void;
  closeHelp: () => boolean;
  showEmpty: (targets: { slug: string; name: string; blurb: string }[]) => void;
  showControls: (on: boolean) => void;
  setHeader: (name: string, meta: string) => void;
  setProgress: (p: Progress | null, stageWord?: string) => void;
  setNotice: (text: string | null) => void;
  setStopped: (text: string, canTry: boolean) => void;
  setError: (code: SpherexErrorCode | 'OTHER' | 'ONCE', q: string | null, targets: { name: string }[]) => void;
  clearStatus: () => void;
  setRest: (r: RestState | null) => void;
  update: (m: PanelModel) => void;
  dispose: () => void;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MJD_UNIX = 40587;

export function formatDate(mjd: number): string {
  const d = new Date((mjd - MJD_UNIX) * 86400000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function monthStarts(m0: number, m1: number): { mjd: number; label: string; month: number }[] {
  const out: { mjd: number; label: string; month: number }[] = [];
  const d0 = new Date((m0 - MJD_UNIX) * 86400000);
  let y = d0.getUTCFullYear();
  let m = d0.getUTCMonth() + 1;
  for (let guard = 0; guard < 600; guard++) {
    if (m > 11) {
      m = 0;
      y += 1;
    }
    const mjd = Date.UTC(y, m, 1) / 86400000 + MJD_UNIX;
    if (mjd > m1) break;
    if (mjd >= m0) out.push({ mjd, label: `${MONTHS[m]} ${y}`, month: m });
    m += 1;
  }
  return out;
}

export function createPanel(hd: PanelHandlers): Panel {
  const el = h('div', 'v-panel');

  // header and status
  const head = h('header', 'v-head');
  const title = h('h2', 'v-title', '');
  const meta = h('p', 'v-meta', '');
  head.append(title, meta);
  const status = h('div', 'v-status');
  status.setAttribute('aria-live', 'polite');

  // empty state
  const empty = h('section', 'v-sec v-empty');
  empty.hidden = true;

  // controls
  const controls = h('div', 'v-controls');
  controls.hidden = true;

  // playback
  const secPlay = h('section', 'v-sec');
  const hPlay = h('h3', 'v-h', 'Playback');
  const caption = h('p', 'v-caption', '');
  const detail = h('p', 'v-detail', '');
  const rowMain = h('div', 'v-row');
  const bBlink = btn('Blink', 'v-btn v-primary', hd.blink);
  const bPlay = btn('Play', 'v-btn', hd.playPause);
  const bBack = btn('Back', 'v-btn', () => hd.step(-1));
  const bFwd = btn('Forward', 'v-btn', () => hd.step(1));
  rowMain.className = 'v-row v-main';
  rowMain.append(bBlink, bPlay, bBack, bFwd);
  const speedRow = h('div', 'v-row v-speedrow');
  const speedLabel = h('span', 'v-lab', 'Frames per second');
  const seg = h('div', 'v-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Frames per second');
  const speedBtns = [1, 2, 4].map((fps) => {
    const b = btn(String(fps), 'v-seg-btn', () => hd.speed(fps));
    b.dataset.fps = String(fps);
    seg.append(b);
    return b;
  });
  speedRow.append(speedLabel, seg);
  const keys = h('p', 'v-hint', 'Space starts and stops. Left and right arrow keys step.');
  secPlay.append(hPlay, caption, detail, rowMain, speedRow, keys);

  // timeline
  const secTl = h('section', 'v-sec');
  const hTl = h('h3', 'v-h', 'Timeline');
  const tl = h('div', 'v-tl');
  tl.setAttribute('role', 'group');
  tl.setAttribute('aria-label', 'Images placed by date');
  const tip = h('div', 'v-tl-tip');
  tip.hidden = true;
  const scrub = h('input', 'v-scrub');
  scrub.type = 'range';
  scrub.min = '0';
  scrub.step = '1';
  scrub.setAttribute('aria-label', 'Exposure');
  scrub.addEventListener('input', () => hd.selectFrame(Number(scrub.value)));
  const tlNote = h('p', 'v-hint', 'Each mark sits at the date the image was taken.');
  secTl.append(hTl, tl, scrub, tlNote);

  // compare
  const secCmp = h('section', 'v-sec');
  const hCmp = h('h3', 'v-h', 'Compare two visits');
  const selA = h('select', 'v-select');
  const selB = h('select', 'v-select');
  selA.id = 'v-sel-a';
  selB.id = 'v-sel-b';
  const labA = h('label', 'v-field');
  labA.htmlFor = selA.id;
  const labAt = h('span', 'v-lab', 'Image A');
  labA.append(labAt, selA);
  const labB = h('label', 'v-field');
  labB.htmlFor = selB.id;
  const labBt = h('span', 'v-lab', 'Image B');
  labB.append(labBt, selB);
  selA.addEventListener('change', () => hd.setA(Number(selA.value)));
  selB.addEventListener('change', () => hd.setB(Number(selB.value)));
  const cmpHint = h('p', 'v-hint', 'Blink flips between A and B. Difference shows B minus A.');
  const bDiff = btn('Difference', 'v-btn v-toggle', () => hd.setDiff(bDiff.getAttribute('aria-pressed') !== 'true'));
  bDiff.setAttribute('aria-pressed', 'false');
  const bSnr = btn('Show in sigma', 'v-btn v-toggle', () => hd.setSnr(bSnr.getAttribute('aria-pressed') !== 'true'));
  bSnr.setAttribute('aria-pressed', 'false');
  const rowDiff = h('div', 'v-row');
  rowDiff.append(bDiff, bSnr);
  const legend = h('div', 'v-legend');
  legend.hidden = true;
  const ramp = h('canvas', 'v-ramp');
  ramp.width = 256;
  ramp.height = 12;
  ramp.setAttribute('aria-hidden', 'true');
  const rampCtx = ramp.getContext('2d');
  if (rampCtx) {
    for (let x = 0; x < 256; x++) {
      const c = divergingColor((x / 255) * 2 - 1);
      rampCtx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      rampCtx.fillRect(x, 0, 1, 12);
    }
  }
  const legLabels = h('div', 'v-leg-labels');
  const legA = h('span', '', 'A brighter');
  const legZero = h('span', '', '0');
  const legB = h('span', '', 'B brighter');
  legLabels.append(legA, legZero, legB);
  const legRange = h('p', 'v-detail', '');
  const legNote = h('p', 'v-hint', '');
  const warn = h('p', 'v-warn');
  warn.hidden = true;
  legend.append(ramp, legLabels, legRange, legNote);
  secCmp.append(hCmp, labA, labB, cmpHint, rowDiff, legend, warn);

  // display
  const secDisp = h('section', 'v-sec');
  const hDisp = h('h3', 'v-h', 'Display');
  const modeSeg = h('div', 'v-seg');
  modeSeg.setAttribute('role', 'group');
  modeSeg.setAttribute('aria-label', 'What each frame shows');
  const bVisit = btn('Per visit', 'v-seg-btn', () => hd.setMode('visit-stack'));
  const bSingle = btn('Every exposure', 'v-seg-btn', () => hd.setMode('single'));
  modeSeg.append(bVisit, bSingle);
  const modeHint = h('p', 'v-hint', 'Per visit averages the exposures taken in one pass. Every exposure shows each one separately.');
  const detLab = h('p', 'v-lab v-subhead', 'Detector');
  const detList = h('div', 'v-detlist');
  detList.setAttribute('role', 'group');
  detList.setAttribute('aria-label', 'Detector');
  let detKey = '';
  const sizeLab = h('p', 'v-lab v-subhead', 'Patch size');
  const sizeSeg = h('div', 'v-seg');
  sizeSeg.setAttribute('role', 'group');
  sizeSeg.setAttribute('aria-label', 'Patch size in arcsec');
  const sizeBtns = [200, 400, 800].map((n) => {
    const b = btn(`${n} arcsec`, 'v-seg-btn', () => hd.setSize(n));
    b.dataset.size = String(n);
    sizeSeg.append(b);
    return b;
  });
  const sizeNote = h('p', 'v-hint', '');
  secDisp.append(hDisp, modeSeg, modeHint, detLab, detList, sizeLab, sizeSeg, sizeNote);

  // overlays
  const secOv = h('section', 'v-sec');
  secOv.append(h('h3', 'v-h', 'Overlays'));
  const ovRow = h('div', 'v-row');
  const mkOv = (key: 'gaia' | 'wise' | 'masked', text: string) => {
    const b = btn(text, 'v-btn v-toggle', () => hd.toggleOverlay(key));
    b.setAttribute('aria-pressed', 'false');
    ovRow.append(b);
    return b;
  };
  const bGaia = mkOv('gaia', 'Gaia stars');
  const bWise = mkOv('wise', 'WISE sources');
  const bMask = mkOv('masked', 'Masked pixels');
  const ovNote = h('p', 'v-hint', '');
  secOv.append(ovRow, ovNote);

  const slotSpec = h('div', 'v-slot');
  const slotQual = h('div', 'v-slot');

  // share
  const secShare = h('section', 'v-sec');
  secShare.append(h('h3', 'v-h', 'Share'));
  const shareRow = h('div', 'v-row');
  const bCopy = btn('Copy link', 'v-btn', () => void copyLink());
  const bKeys = btn('Keyboard', 'v-btn', () => toggleHelp());
  bKeys.setAttribute('aria-expanded', 'false');
  shareRow.append(bCopy, bKeys);
  const copied = h('p', 'v-hint v-copied', '');
  copied.setAttribute('aria-live', 'polite');
  const help = h('div', 'v-help');
  help.hidden = true;
  help.id = 'v-help';
  bKeys.setAttribute('aria-controls', 'v-help');
  help.setAttribute('role', 'group');
  help.setAttribute('aria-label', 'Keyboard shortcuts');
  const helpList = h('dl', 'v-keys');
  for (const [k, d] of [
    ['Space', 'Start or stop blinking or playing'],
    ['Left and right arrows', 'Step through the frames'],
    ['D', 'Turn the difference image on or off'],
    ['G', 'Show or hide Gaia stars'],
    ['?', 'Open this list'],
    ['Escape', 'Close this list'],
  ]) {
    helpList.append(h('dt', '', k), h('dd', '', d));
  }
  help.append(helpList);
  secShare.append(shareRow, copied, help);

  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  async function copyLink(): Promise<void> {
    const url = location.href;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      const t = document.createElement('input');
      t.value = url;
      t.setAttribute('aria-hidden', 'true');
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.append(t);
      t.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      t.remove();
      bCopy.focus();
    }
    copied.textContent = ok ? 'Link copied' : 'Could not copy. Copy the address from the browser bar.';
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.textContent = '';
    }, 2000);
  }

  function toggleHelp(): void {
    help.hidden = !help.hidden;
    bKeys.setAttribute('aria-expanded', String(!help.hidden));
  }

  function closeHelp(): boolean {
    if (help.hidden) return false;
    help.hidden = true;
    bKeys.setAttribute('aria-expanded', 'false');
    bKeys.focus();
    return true;
  }

  controls.append(secPlay, secTl, secCmp, secDisp, secOv, slotSpec, slotQual, secShare);
  const restBox = h('div', 'v-rest');
  restBox.hidden = true;
  if (isMock) {
    const mockLine = h('p', 'v-mock', 'Simulated data. Real SPHEREx images are being connected.');
    el.append(mockLine);
  }
  const backRow = h('div', 'v-top');
  backRow.hidden = true;
  const backBtn = btn('', 'v-btn', hd.goBack);
  backRow.append(backBtn);
  const skyRow = h('div', 'v-top v-skyline');
  skyRow.hidden = true;
  el.append(backRow, skyRow, head, status, restBox, empty, controls);

  // timeline rendering
  let tlKey = '';
  let tlBtns: HTMLButtonElement[] = [];
  let tlDomain: [number, number] = [0, 1];
  let tlMonths: HTMLElement[] = [];
  let frames: FrameInfo[] = [];
  const PAD = 18;

  const posStyle = (frac: number) => `calc(${PAD}px + (100% - ${PAD * 2}px) * ${frac})`;

  function buildTimeline(list: FrameInfo[]): void {
    tl.replaceChildren();
    tlBtns = [];
    tlMonths = [];
    const m = list.map((f) => f.mjd);
    let lo = Math.min(...m);
    let hi = Math.max(...m);
    if (hi - lo < 30) {
      const mid = (lo + hi) / 2;
      lo = mid - 15;
      hi = mid + 15;
    } else {
      const pad = (hi - lo) * 0.04;
      lo -= pad;
      hi += pad;
    }
    tlDomain = [lo, hi];
    const axis = h('div', 'v-tl-axis');
    tl.append(axis);
    for (const ms of monthStarts(lo, hi)) {
      const t = h('span', 'v-tl-month');
      t.style.left = posStyle((ms.mjd - lo) / (hi - lo));
      const lab = h('span', 'v-tl-mlabel', ms.label);
      lab.dataset.month = String(ms.month);
      t.append(lab);
      tl.append(t);
      tlMonths.push(t);
    }
    list.forEach((f, i) => {
      const b = h('button', 'v-tl-f');
      b.type = 'button';
      b.style.left = posStyle((f.mjd - lo) / (hi - lo));
      b.setAttribute('aria-label', f.caption);
      const mark = h('span', 'v-tl-mark');
      const tag = h('span', 'v-tl-ab', '');
      b.append(mark, tag);
      b.addEventListener('click', () => hd.selectFrame(i));
      const show = () => {
        tip.textContent = f.tip;
        tip.hidden = false;
        const w = tl.clientWidth;
        const x = PAD + ((f.mjd - lo) / (hi - lo)) * (w - PAD * 2);
        const tw = tip.offsetWidth;
        tip.style.left = `${Math.min(Math.max(x - tw / 2, 0), Math.max(0, w - tw))}px`;
      };
      b.addEventListener('pointerenter', show);
      b.addEventListener('focus', show);
      b.addEventListener('pointerleave', () => {
        tip.hidden = true;
      });
      b.addEventListener('blur', () => {
        tip.hidden = true;
      });
      tl.append(b);
      tlBtns.push(b);
    });
    tl.append(tip);
    layoutTimeline();
  }

  function layoutTimeline(): void {
    const w = tl.clientWidth;
    if (w <= 0 || tlBtns.length === 0) return;
    const [lo, hi] = tlDomain;
    const xs = frames.map((f) => ((f.mjd - lo) / (hi - lo)) * (w - PAD * 2));
    tlBtns.forEach((b, i) => {
      let gap = Infinity;
      for (let j = 0; j < xs.length; j++) if (j !== i) gap = Math.min(gap, Math.abs(xs[j] - xs[i]));
      const width = Math.max(10, Math.min(40, gap));
      b.style.width = `${width}px`;
      b.style.marginLeft = `${-width / 2}px`;
    });
    // thin the month labels so they never touch
    const per = Math.max(1, Math.ceil(tlMonths.length / Math.max(1, Math.floor(w / 80))));
    tlMonths.forEach((t, i) => {
      t.classList.toggle('v-tl-quiet', i % per !== 0);
    });
  }

  const ro = new ResizeObserver(layoutTimeline);
  ro.observe(tl);

  function fillSelect(sel: HTMLSelectElement, list: FrameInfo[], value: number): void {
    sel.replaceChildren();
    list.forEach((f, i) => {
      const o = h('option', '', f.option);
      o.value = String(i);
      sel.append(o);
    });
    sel.value = String(value);
  }

  let lastSelKey = '';

  function update(m: PanelModel): void {
    frames = m.frames;
    const n = frames.length;
    const key = `${m.mode}|${n}|${frames.map((f) => f.mjd.toFixed(3)).join(',')}`;
    if (key !== tlKey) {
      tlKey = key;
      if (n > 0) buildTimeline(frames);
      scrub.max = String(Math.max(0, n - 1));
    }
    const selKey = key + '|' + frames.map((f) => f.option).join('|');
    if (selKey !== lastSelKey) {
      lastSelKey = selKey;
      fillSelect(selA, frames, m.a);
      fillSelect(selB, frames, m.b);
    }
    selA.value = String(m.a);
    selB.value = String(m.b);
    scrub.hidden = m.mode !== 'single' || n < 2;
    scrub.value = String(m.index);

    const cur = frames[m.index];
    caption.textContent = cur ? cur.caption : '';
    detail.textContent = cur ? cur.detail : '';
    if (m.diff && m.compare) caption.textContent = 'Image B minus image A';
    if (m.diff && m.compare) detail.textContent = `A: ${frames[m.a]?.caption ?? ''}. B: ${frames[m.b]?.caption ?? ''}.`;

    const locked = m.diff;
    const few = n < 2;
    bBlink.disabled = locked || few || m.a === m.b;
    bBlink.textContent = m.playMode === 'blink' ? 'Stop blinking' : 'Blink';
    bPlay.disabled = locked || few;
    bPlay.textContent = m.playMode === 'play' ? 'Pause' : 'Play';
    bBack.disabled = locked || few;
    bFwd.disabled = locked || few;
    speedBtns.forEach((b) => {
      b.disabled = locked || few;
      b.setAttribute('aria-pressed', String(Number(b.dataset.fps) === m.fps));
    });

    tlBtns.forEach((b, i) => {
      b.classList.toggle('is-active', i === m.index);
      b.classList.toggle('is-a', i === m.a);
      b.classList.toggle('is-b', i === m.b);
      const tag = b.lastElementChild as HTMLElement;
      tag.textContent = i === m.a && i === m.b ? 'A B' : i === m.a ? 'A' : i === m.b ? 'B' : '';
      if (i === m.index) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });

    bDiff.setAttribute('aria-pressed', String(m.diff));
    bDiff.disabled = few;
    bSnr.setAttribute('aria-pressed', String(m.snr));
    bSnr.hidden = !m.diff;
    legend.hidden = !(m.diff && m.compare);
    if (m.compare) {
      legRange.textContent = m.compare.rangeText;
      legNote.textContent = m.compare.note;
      warn.hidden = m.compare.warning === null || !m.diff;
      warn.textContent = m.compare.warning ?? '';
    } else {
      warn.hidden = true;
    }

    bVisit.setAttribute('aria-pressed', String(m.mode === 'visit-stack'));
    bSingle.setAttribute('aria-pressed', String(m.mode === 'single'));
    const dkey = m.detectorList.map((d) => `${d.detector}${d.enabled ? 1 : 0}`).join(',');
    if (dkey !== detKey) {
      detKey = dkey;
      detList.replaceChildren();
      for (const d of m.detectorList) {
        const b = btn(d.label, 'v-det', () => hd.setDet(d.detector));
        b.dataset.det = String(d.detector);
        b.disabled = !d.enabled;
        detList.append(b);
      }
    }
    for (const b of Array.from(detList.children) as HTMLButtonElement[]) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.det) === m.det));
    }
    sizeBtns.forEach((b) => {
      b.disabled = !m.sizeEnabled;
      b.setAttribute('aria-pressed', String(Number(b.dataset.size) === m.size));
    });
    sizeNote.textContent = m.sizeNote;
    bGaia.setAttribute('aria-pressed', String(m.overlays.gaia));
    bMask.setAttribute('aria-pressed', String(m.overlays.masked));
    bWise.setAttribute('aria-pressed', String(m.overlays.wise && m.wiseAvailable));
    bWise.disabled = !m.wiseAvailable;
    bWise.textContent = m.wiseAvailable ? 'WISE sources' : 'WISE sources, not available yet';
    ovNote.textContent = m.overlayNote;
  }

  function clearStatus(): void {
    status.replaceChildren();
    progress = null;
    notice = null;
  }

  // progress
  interface ProgressParts {
    root: HTMLElement;
    word: HTMLElement;
    counts: HTMLElement;
    bar: HTMLProgressElement;
    msg: HTMLElement;
    retry: HTMLElement;
  }
  let progress: ProgressParts | null = null;
  let notice: HTMLElement | null = null;

  function setProgress(p: Progress | null, stageWord?: string): void {
    if (p === null) {
      progress?.root.remove();
      progress = null;
      return;
    }
    if (!progress) {
      const root = h('div', 'v-progress');
      const word = h('p', 'v-stage-word');
      const counts = h('p', 'v-detail');
      const bar = h('progress', 'v-bar');
      bar.max = 1;
      const msg = h('p', 'v-detail');
      const retry = h('p', 'v-retry', 'The archive is busy. Retrying.');
      retry.hidden = true;
      root.append(word, bar, counts, msg, retry, btn('Cancel', 'v-btn', hd.cancel));
      status.prepend(root);
      progress = { root, word, counts, bar, msg, retry };
    }
    progress.word.textContent = stageWord ?? STAGE_WORDS[p.stage];
    progress.counts.textContent = p.total > 0 ? `${p.done} of ${p.total}` : '';
    progress.counts.hidden = p.total <= 0;
    if (p.total > 0) {
      progress.bar.max = p.total;
      progress.bar.value = p.done;
    } else {
      progress.bar.removeAttribute('value');
    }
    progress.msg.textContent = p.message;
    progress.retry.hidden = !p.retrying;
  }

  function setRest(r: RestState | null): void {
    restBox.replaceChildren();
    restBox.hidden = r === null;
    if (!r) return;
    const box = h('div', 'v-progress');
    if (r.kind === 'loading') {
      box.append(h('p', 'v-stage-word', 'Downloading more exposures'));
      const bar = h('progress', 'v-bar');
      bar.max = Math.max(1, r.total);
      bar.value = r.done;
      box.append(bar, h('p', 'v-detail', `${r.done} of ${r.total}, about ${r.mb} MB downloaded`));
      box.append(btn('Stop loading', 'v-btn', hd.stopRest));
    } else {
      if (r.single) box.append(h('p', 'v-stage-word', 'You are looking at single exposures from different dates.'));
      if (r.kind === 'optin') {
        box.append(h('p', '', `${r.n} more exposures, about ${r.mb} MB. Load them to see every visit.`));
      } else {
        box.append(
          h('p', '', `Stopped. ${r.loaded} of ${r.total} more exposures were loaded. ${r.n} left, about ${r.mb} MB.`),
        );
      }
      box.append(btn('Load the rest', 'v-btn', hd.loadRest));
    }
    restBox.append(box);
  }

  function setNotice(text: string | null): void {
    notice?.remove();
    notice = null;
    if (text) {
      notice = h('p', 'v-notice', text);
      status.append(notice);
    }
  }

  function setStopped(text: string, canTry: boolean): void {
    setProgress(null);
    const box = h('div', 'v-msgbox');
    box.append(h('p', 'v-msg-title', text));
    if (canTry) box.append(btn('Try again', 'v-btn', hd.retry));
    status.append(box);
  }

  function setError(code: SpherexErrorCode | 'OTHER' | 'ONCE', q: string | null, targets: { name: string }[]): void {
    setProgress(null);
    const box = h('div', 'v-msgbox v-error');
    let titleText = '';
    let body = '';
    let retry = false;
    switch (code) {
      case 'NOT_FOUND':
        titleText = `We could not find "${q ?? ''}".`;
        body = 'Check the spelling, or type coordinates such as 269.45 4.69.';
        break;
      case 'ONCE':
        titleText = 'SPHEREx has looked here only once so far, so there is nothing to compare yet.';
        body = 'Try one of the challenge targets, or another position.';
        break;
      case 'NO_COVERAGE':
        titleText = 'SPHEREx has no images covering this position yet.';
        body = 'The telescope is still mapping the sky. Try one of the challenge targets, which are known to be covered.';
        break;
      case 'UPSTREAM_BUSY':
        titleText = 'The archive is busy right now.';
        body = 'Try again in a minute.';
        retry = true;
        break;
      case 'BAD_INPUT':
        titleText = 'That does not look like a star name or a position.';
        body = 'Try a name such as Vega, or coordinates such as 269.45 4.69, or 17 57 48.5 +04 41 36.';
        break;
      default:
        titleText = 'The archive returned something we could not use.';
        body = 'Try again in a minute, or open one of the challenge targets, which work without the archive.';
        retry = true;
    }
    box.append(h('p', 'v-msg-title', titleText), h('p', '', body));
    if (retry) box.append(btn('Try again', 'v-btn', hd.retry));
    status.append(box);
    status.append(targetList(targets.map((t) => ({ slug: t.name, name: t.name, blurb: '' }))));
  }

  function targetList(list: { slug: string; name: string; blurb: string }[]): HTMLElement {
    const ul = h('ul', 'v-targets');
    for (const t of list) {
      const li = h('li');
      const b = h('button', 'v-target');
      b.type = 'button';
      b.append(h('span', 'v-target-name', t.name));
      if (t.blurb) b.append(h('span', 'v-detail', t.blurb));
      b.addEventListener('click', () => hd.openTarget(t.name));
      li.append(b);
      ul.append(li);
    }
    return ul;
  }

  function showEmpty(targets: { slug: string; name: string; blurb: string }[]): void {
    empty.hidden = false;
    controls.hidden = true;
    head.hidden = true;
    empty.replaceChildren(
      h('h2', 'v-title', 'Watch the sky change'),
      h(
        'p',
        '',
        'SPHEREx photographs the whole sky again and again. Put images of the same spot side by side, taken months apart, and anything that moved or changed stands out.',
      ),
      h(
        'p',
        '',
        'Type a star name such as Vega, or coordinates such as 269.45 4.69, in the box at the top. Or start with one of these five.',
      ),
      targetList(targets),
    );
  }

  return {
    el,
    showEmpty,
    setBack: (label) => {
      backRow.hidden = label === null;
      if (label !== null) backBtn.textContent = label;
    },
    setSkyEntry: (name) => {
      skyRow.replaceChildren();
      skyRow.hidden = name === null;
      if (name !== null) {
        skyRow.append(h('span', '', `This is ${name}. `), btn('Open the prepared set', 'v-linkbtn', hd.openPrepared));
      }
    },
    attach: (spectrum, quality) => {
      slotSpec.replaceChildren(spectrum);
      slotQual.replaceChildren(quality);
    },
    toggleHelp,
    closeHelp,
    showControls: (on) => {
      controls.hidden = !on;
      if (on) {
        empty.hidden = true;
        head.hidden = false;
        layoutTimeline();
      }
    },
    setHeader: (name, m) => {
      head.hidden = false;
      empty.hidden = true;
      title.textContent = name;
      meta.textContent = m;
    },
    setProgress,
    setNotice,
    setStopped,
    setError,
    clearStatus,
    setRest,
    update,
    dispose: () => ro.disconnect(),
  };
}
