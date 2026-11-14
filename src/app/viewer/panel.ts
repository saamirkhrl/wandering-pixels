import { DIFF_SOURCES, STACK_NOISE, STACK_WARN } from './stack-copy';
import type { DiffSource } from './stack-copy';
import type { Detector, MovieMode, Progress, SpherexErrorCode } from '../data';
import { divergingColor } from './render';
import type { PlayMode } from './player';
import { STAGE_WORDS } from './load';
import { createTimeline } from './timeline';


export interface FrameInfo {
  caption: string;
  detail: string;
  tip: string;
  option: string;
  mjd: number;
  shortDate: string;
  wavelength: number;
  visitIndex: number;
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
  overlays: { gaia: boolean; wise: boolean; masked: boolean; adv: boolean };
  drange: 'faint' | 'balanced' | 'bright';
  wiseAvailable: boolean;
  overlayNote: string;
  smooth: boolean;
  contrast: 'soft' | 'normal' | 'hard';
  compare: CompareInfo | null;
  // Difference source control: null when there is no choice to make
  diffSource: { current: DiffSource; available: Record<DiffSource, boolean> } | null;
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
  setSmooth: (on: boolean) => void;
  setContrast: (c: 'soft' | 'normal' | 'hard') => void;
  toggleOverlay: (k: 'gaia' | 'wise' | 'masked' | 'adv') => void;
  setDrange: (r: 'faint' | 'balanced' | 'bright') => void;
  setDiffSource: (s: DiffSource) => void;
  goBack: () => void;
  openPrepared: () => void;
}

export type RestState =
  | { kind: 'optin'; n: number; mb: number; single: boolean; det: number; exact: boolean }
  | { kind: 'loading'; done: number; total: number; mb: number; exact: boolean }
  | { kind: 'stopped'; n: number; mb: number; loaded: number; total: number; single: boolean; det: number; exact: boolean };

export interface Panel {
  el: HTMLElement;
  setMockLine: (on: boolean) => void;
  setBack: (label: string | null) => void;
  setSkyEntry: (name: string | null) => void;
  attach: (spectrum: HTMLElement, quality: HTMLElement, planet?: HTMLElement) => void;
  setPairMarks: (indices: number[]) => void;
  toggleHelp: () => void;
  closeHelp: () => boolean;
  showEmpty: (targets: { slug: string; name: string; blurb: string }[]) => void;
  showControls: (on: boolean) => void;
  // Section headings with every control disabled, shown while data downloads.
  showSkeleton: () => void;
  setHeader: (name: string, meta: string) => void;
  setTitleNote: (text: string | null) => void;
  setMatchNote: (text: string | null) => void;
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

export function createPanel(hd: PanelHandlers): Panel {
  const el = h('div', 'v-panel');

  // header and status
  const head = h('header', 'v-head');
  const title = h('h2', 'v-title', '');
  const meta = h('p', 'v-meta', '');
  const titleNote = h('p', 'v-detail v-titlenote');
  titleNote.hidden = true;
  head.append(title, meta, titleNote);
  const matchLine = h('p', 'v-notice');
  matchLine.hidden = true;
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
  const caveat = h('p', 'v-caveat');
  const keys = h('p', 'v-hint', 'Space starts and stops. Left and right arrow keys step.');
  secPlay.append(hPlay, caption, detail, rowMain, speedRow, caveat, keys);

  // timeline
  const secTl = h('section', 'v-sec');
  const hTl = h('h3', 'v-h', 'Timeline');
  const timeline = createTimeline({
    onShow: (i) => hd.selectFrame(i),
    onPickA: (i) => hd.setA(i),
    onPickB: (i) => hd.setB(i),
  });
  const scrub = h('input', 'v-scrub');
  scrub.type = 'range';
  scrub.min = '0';
  scrub.step = '1';
  scrub.setAttribute('aria-label', 'Exposure');
  scrub.addEventListener('input', () => hd.selectFrame(Number(scrub.value)));
  secTl.append(hTl, timeline.el, scrub);

  // compare
  const secCmp = h('section', 'v-sec');
  const hCmp = h('h3', 'v-h', 'Compare two images');
  const cmpSeg = h('div', 'v-seg');
  cmpSeg.setAttribute('role', 'group');
  cmpSeg.setAttribute('aria-label', 'How to compare image A and image B');
  const bCmpBlink = btn('Blink', 'v-seg-btn', () => hd.setDiff(false));
  const bCmpDiff = btn('Difference', 'v-seg-btn', () => hd.setDiff(true));
  cmpSeg.append(bCmpBlink, bCmpDiff);
  const cmpHint = h('p', 'v-hint', 'Blink flips between A and B. Difference shows B minus A.');
  const srcWrap = h('div', 'v-diffsrc');
  const srcSeg = h('div', 'v-seg v-unitseg');
  srcSeg.setAttribute('role', 'group');
  srcSeg.setAttribute('aria-label', 'What to subtract');
  const srcBtns = DIFF_SOURCES.map((s) => {
    const b = btn(s.label, 'v-seg-btn', () => hd.setDiffSource(s.key));
    b.dataset.src = s.key;
    srcSeg.append(b);
    return b;
  });
  const srcNote = h('p', 'v-hint', STACK_NOISE);
  srcWrap.append(srcSeg, srcNote);
  srcWrap.hidden = true;
  const unitSeg = h('div', 'v-seg v-unitseg');
  unitSeg.setAttribute('role', 'group');
  unitSeg.setAttribute('aria-label', 'Difference units');
  const bUnitFlux = btn('MJy/sr', 'v-seg-btn', () => hd.setSnr(false));
  const bUnitSig = btn('Sigma', 'v-seg-btn', () => hd.setSnr(true));
  unitSeg.append(bUnitFlux, bUnitSig);
  const drangeSeg = h('div', 'v-seg v-unitseg');
  drangeSeg.setAttribute('role', 'group');
  drangeSeg.setAttribute('aria-label', 'Difference brightness range');
  const drangeBtns = (
    [
      ['faint', 'Faint'],
      ['balanced', 'Balanced'],
      ['bright', 'Bright'],
    ] as const
  ).map(([k, label]) => {
    const b = btn(label, 'v-seg-btn', () => hd.setDrange(k));
    b.dataset.dr = k;
    drangeSeg.append(b);
    return b;
  });
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
  legLabels.append(h('span', '', 'A brighter'), h('span', '', '0'), h('span', '', 'B brighter'));
  const legRange = h('p', 'v-detail', '');
  const legNote = h('p', 'v-hint', '');
  const warn = h('p', 'v-warn');
  warn.hidden = true;
  legend.append(ramp, legLabels, legRange, legNote);
  const fallback = h('details', 'v-disclosure');
  fallback.append(h('summary', '', 'Choose from a list'));
  const selA = h('select', 'v-select');
  const selB = h('select', 'v-select');
  selA.id = 'v-sel-a';
  selB.id = 'v-sel-b';
  const labA = h('label', 'v-field');
  labA.htmlFor = selA.id;
  labA.append(h('span', 'v-lab', 'Image A'), selA);
  const labB = h('label', 'v-field');
  labB.htmlFor = selB.id;
  labB.append(h('span', 'v-lab', 'Image B'), selB);
  selA.addEventListener('change', () => hd.setA(Number(selA.value)));
  selB.addEventListener('change', () => hd.setB(Number(selB.value)));
  fallback.append(labA, labB);
  secCmp.append(hCmp, cmpSeg, cmpHint, srcWrap, unitSeg, drangeSeg, legend, warn, fallback);

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
  const modeHint2 = h('p', 'v-hint', 'Stacked visits suit stars and brown dwarfs. A distant planet would move during a single visit and blur out.');
  const smoothLab = h('p', 'v-lab v-subhead', 'Image');
  const smoothSeg = h('div', 'v-seg');
  smoothSeg.setAttribute('role', 'group');
  smoothSeg.setAttribute('aria-label', 'Image smoothing');
  const bSmooth = btn('Smooth', 'v-seg-btn', () => hd.setSmooth(true));
  const bTrue = btn('True pixels', 'v-seg-btn', () => hd.setSmooth(false));
  smoothSeg.append(bSmooth, bTrue);
  const contrastLab = h('p', 'v-lab v-subhead', 'Contrast');
  const contrastSeg = h('div', 'v-seg');
  contrastSeg.setAttribute('role', 'group');
  contrastSeg.setAttribute('aria-label', 'Contrast');
  const contrastBtns = (['soft', 'normal', 'hard'] as const).map((c) => {
    const b = btn(c === 'soft' ? 'Soft' : c === 'normal' ? 'Normal' : 'Hard', 'v-seg-btn', () => hd.setContrast(c));
    b.dataset.contrast = c;
    contrastSeg.append(b);
    return b;
  });
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
  secDisp.append(hDisp, modeSeg, modeHint, modeHint2, smoothLab, smoothSeg, contrastLab, contrastSeg, detLab, detList, sizeLab, sizeSeg, sizeNote);

  // overlays
  const secOv = h('section', 'v-sec');
  secOv.append(h('h3', 'v-h', 'Overlays'));
  const ovRow = h('div', 'v-checks');
  const mkOv = (key: 'gaia' | 'wise' | 'masked' | 'adv', text: string) => {
    const lab = h('label', 'v-check');
    const input = h('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => hd.toggleOverlay(key));
    const box = h('span', 'v-check-box');
    box.setAttribute('aria-hidden', 'true');
    const t = h('span', 'v-check-text', text);
    lab.append(input, box, t);
    ovRow.append(lab);
    return { input, text: t };
  };
  const bGaia = mkOv('gaia', 'Gaia stars');
  const bWise = mkOv('wise', 'WISE sources');
  const bMask = mkOv('masked', 'Masked pixels');
  const bAdv = mkOv('adv', 'Advisory flags: near a bright star or a streak');
  const ovNote = h('p', 'v-hint', '');
  secOv.append(ovRow, ovNote);

  const slotPlanet = h('div', 'v-slot');
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

  controls.append(secPlay, secTl, secCmp, slotPlanet, secDisp, secOv, slotSpec, slotQual, secShare);
  const restBox = h('div', 'v-rest');
  restBox.hidden = true;
  const mockLine = h('p', 'v-mock', 'Simulated data. Real SPHEREx images are being connected.');
  mockLine.hidden = true;
  el.append(mockLine);
  const backRow = h('div', 'v-top');
  backRow.hidden = true;
  const backBtn = btn('', 'v-btn', hd.goBack);
  backRow.append(backBtn);
  const skyRow = h('div', 'v-top v-skyline');
  skyRow.hidden = true;
  el.append(backRow, skyRow, head, status, matchLine, restBox, empty, controls);

  let frames: FrameInfo[] = [];

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
  let tlKey = '';

  function update(m: PanelModel): void {
    frames = m.frames;
    const n = frames.length;
    const key = `${m.mode}|${n}|${frames.map((f) => f.mjd.toFixed(3)).join(',')}`;
    if (key !== tlKey) {
      tlKey = key;
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

    timeline.set(
      frames.map((f) => ({
        mjd: f.mjd,
        label: f.caption,
        shortDate: f.shortDate,
        wavelength: f.wavelength,
        visitIndex: f.visitIndex,
      })),
      m.index,
      m.a,
      m.b,
    );
    timeline.setPickEnabled(n >= 2);
    const stackWarn = m.diff && m.diffSource !== null && m.diffSource.current === 'stack';
    caveat.textContent = stackWarn
      ? STACK_WARN
      : m.diff
      ? 'Brightness needs care: each image is taken at a slightly different infrared colour, so a star can flicker without having changed. Bright stars also leave marks in a subtraction even when nothing moved.'
      : 'Brightness needs care: each image is taken at a slightly different infrared colour, so a star can flicker without having changed.';

    bCmpBlink.setAttribute('aria-pressed', String(!m.diff));
    bCmpDiff.setAttribute('aria-pressed', String(m.diff));
    bCmpDiff.disabled = few;
    unitSeg.hidden = !m.diff;
    srcWrap.hidden = !(m.diff && m.diffSource !== null);
    if (m.diffSource) {
      const ds = m.diffSource;
      srcBtns.forEach((b) => {
        const k = b.dataset.src as DiffSource;
        b.setAttribute('aria-pressed', String(k === ds.current));
        b.disabled = !ds.available[k];
      });
      srcNote.hidden = ds.current !== 'stack';
    }
    bUnitFlux.setAttribute('aria-pressed', String(!m.snr));
    bUnitSig.setAttribute('aria-pressed', String(m.snr));
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
    bSmooth.setAttribute('aria-pressed', String(m.smooth));
    bTrue.setAttribute('aria-pressed', String(!m.smooth));
    contrastBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.contrast === m.contrast)));
    bGaia.input.checked = m.overlays.gaia;
    bMask.input.checked = m.overlays.masked;
    bAdv.input.checked = m.overlays.adv;
    drangeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dr === m.drange)));
    drangeSeg.hidden = !m.diff || m.snr;
    bWise.input.checked = m.overlays.wise && m.wiseAvailable;
    bWise.input.disabled = !m.wiseAvailable;
    bWise.text.textContent = m.wiseAvailable ? 'WISE sources' : 'WISE sources, not available yet';
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
      box.append(bar, h('p', 'v-detail', `${r.done} of ${r.total}, ${r.exact ? '' : 'about '}${r.mb} MB downloaded`));
      box.append(btn('Stop loading', 'v-btn', hd.stopRest));
    } else {
      if (r.single) box.append(h('p', 'v-stage-word', 'Showing one image from each of two visits.'));
      if (r.kind === 'optin') {
        box.append(
          h('p', '', `Loading every image for this detector (${r.n} more, ${r.exact ? '' : 'about '}${r.mb} MB) gives cleaner, averaged visits.`),
        );
      } else {
        box.append(
          h('p', '', `Stopped. ${r.loaded} of ${r.total} more exposures were loaded. ${r.n} left, about ${r.mb} MB.`),
        );
      }
      box.append(btn('Load full visits', 'v-btn', hd.loadRest));
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
        titleText = 'The SPHEREx archive did not answer.';
        body = 'Try again, or open a prepared target.';
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
    setMockLine: (on) => {
      mockLine.hidden = !on;
    },
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
    setPairMarks: (indices) => timeline.setPairMarks(indices),
    attach: (spectrum, quality, planet) => {
      if (planet) slotPlanet.replaceChildren(planet);
      slotSpec.replaceChildren(spectrum);
      slotQual.replaceChildren(quality);
    },
    toggleHelp,
    closeHelp,
    showSkeleton: () => {
      controls.hidden = false;
      controls.inert = true;
      controls.classList.add('v-skeleton');
      controls.setAttribute('aria-busy', 'true');
    },
    showControls: (on) => {
      controls.inert = false;
      controls.classList.remove('v-skeleton');
      controls.removeAttribute('aria-busy');
      controls.hidden = !on;
      if (on) {
        empty.hidden = true;
        head.hidden = false;
      }
    },
    setTitleNote: (text) => {
      titleNote.hidden = text === null;
      titleNote.textContent = text ?? '';
    },
    setMatchNote: (text) => {
      matchLine.hidden = text === null;
      matchLine.textContent = text ?? '';
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
    dispose: () => timeline.dispose(),
  };
}
