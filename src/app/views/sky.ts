import { Group, Matrix4, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { prefersReducedMotion } from '../motion';
import type { Mount } from '../types';
import {
  altAzToWorld,
  eqjToWorld,
  radecToVec,
  riseInfo,
  sunAltitude,
  vecToRadec,
  worldToAltAz,
  type RiseInfo,
} from '../sky/astro';
import { createHipsLayer, HIPS_FRAMES, type HipsLayer } from '../sky/hips';
import { loadBrightStars } from '../sky/stars';
import { TARGETS, type Target } from '../sky/targets';
import { button, el, markSvg, reticleSvg, setText } from '../sky/view/dom';
import {
  clamp,
  fmtDeg,
  fmtPlace,
  fmtRa,
  fmtUtcClock,
  makeClock,
  toIso,
  wrap360,
} from '../sky/view/format';
import { createBackdrop, createStarLayer, type StarLayer } from '../sky/view/scene';
import '../../ui/entry.css';
import '../sky/view/sky.css';

const FOV_MIN = 5;
const FOV_MAX = 100;
const FOV_RINGS = 25;
const ALT_MIN = -10;
const ALT_MAX = 89.9;
const PATCH_ARCSEC = 400;
const WANTED_UM = [0.75, 1.1, 1.6, 2.2, 3.4, 4.6];
const PLAY_RATE = 1200;
const NOTE_KEY = 'sky-note-dismissed';
const NOTE_TEXT = 'First-year SPHEREx map. The date only turns the sky; open a patch to see change.';

function writeParams(values: Record<string, string>): void {
  try {
    const sp = new URLSearchParams(location.search);
    for (const k of Object.keys(values)) sp.set(k, values[k]);
    history.replaceState(null, '', '?' + sp.toString());
  } catch {
    /* ignore */
  }
}

function pickFrames(): { index: number; um: number }[] {
  const out = new Map<number, { index: number; um: number }>();
  if (HIPS_FRAMES.length === 0) return [];
  for (const want of WANTED_UM) {
    let best = HIPS_FRAMES[0];
    for (const f of HIPS_FRAMES) if (Math.abs(f.um - want) < Math.abs(best.um - want)) best = f;
    out.set(best.index, best);
  }
  return [...out.values()].sort((a, b) => a.um - b.um);
}

function umLabel(um: number): string {
  return um.toFixed(um < 10 ? (Math.abs(um * 10 - Math.round(um * 10)) < 0.05 ? 1 : 2) : 0) + ' um';
}

function readNoteDismissed(): boolean {
  try {
    return sessionStorage.getItem(NOTE_KEY) === '1';
  } catch {
    return false;
  }
}

interface TargetRow {
  target: Target;
  dir: Vector3;
  go: HTMLButtonElement;
  status: HTMLElement;
  jump: HTMLButtonElement;
  mark: HTMLButtonElement;
  label: HTMLElement;
  info: RiseInfo | null;
}

interface NamedLabel {
  node: HTMLElement;
  w: number;
  shown: boolean;
}

interface Pop {
  btns: HTMLButtonElement[];
  pop: HTMLElement;
}

export const mount: Mount = (root, ctx) => {
  const lat = parseFloat(ctx.params.lat ?? '');
  const lon = parseFloat(ctx.params.lon ?? '');
  const wrap = el('div', 'sky-root');
  root.appendChild(wrap);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 360) {
    const box = el('div', 'sky-missing');
    const p = el('section', 'chrome');
    p.append(
      el('h2', undefined, 'Pick a place first'),
      el('p', undefined, 'The sky depends on where you stand. Choose a place on the globe.'),
      button('Back to the globe', 'chrome-btn', () => ctx.go('globe')),
    );
    box.appendChild(p);
    wrap.appendChild(box);
    return () => wrap.remove();
  }

  const place = { lat, lon };
  const placeName = (ctx.params.place ?? '').trim();
  const clock = makeClock(lon, ctx.params.tz ?? null);
  const reduced = prefersReducedMotion();
  const phoneMq = window.matchMedia('(max-width: 599px)');

  function defaultNight(from: Date): Date {
    if (sunAltitude(place, from) < -12) return from;
    for (let m = 10; m <= 48 * 60; m += 10) {
      const d = new Date(from.getTime() + m * 60000);
      if (sunAltitude(place, d) < -12) {
        let lo = m - 10;
        let hi = m;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          if (sunAltitude(place, new Date(from.getTime() + mid * 60000)) < -12) hi = mid;
          else lo = mid;
        }
        return new Date(Math.ceil((from.getTime() + hi * 60000) / 60000) * 60000);
      }
    }
    return from;
  }

  let date = new Date(ctx.params.t ?? '');
  let isTonight = false;
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    date = defaultNight(now);
    isTonight = true;
  }
  date = new Date(Math.floor(date.getTime() / 1000) * 1000);

  // ---- renderer, scene, camera
  const canvas = el('canvas', 'sky-canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute(
    'aria-label',
    'Sky view. Drag to look around. Arrow keys pan, plus and minus zoom, Enter opens the patch at the reticle.',
  );
  wrap.appendChild(canvas);

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0x04060d, 1);
  const scene = new Scene();
  const camera = new PerspectiveCamera(75, 1, 0.1, 100);
  camera.up.set(0, 1, 0);

  const backdrop = createBackdrop();
  scene.add(backdrop.group);

  const celestial = new Group();
  celestial.matrixAutoUpdate = false;
  scene.add(celestial);
  const invCelestial = new Matrix4();

  let hips: HipsLayer | null = null;
  const frames = pickFrames();
  let frameIndex = frames.length ? frames[Math.min(2, frames.length - 1)].index : 0;
  const frameParam = parseInt(ctx.params.frame ?? '', 10);
  const frameKnown = HIPS_FRAMES.find((f) => f.index === frameParam);
  if (frameKnown) frameIndex = frameKnown.index;
  try {
    hips = createHipsLayer(renderer, frameIndex);
    celestial.add(hips.object);
  } catch {
    hips = null;
  }

  let starLayer: StarLayer | null = null;
  let starsOn = true;
  let ringMode = false;

  // ---- view state
  let fov = phoneMq.matches && window.innerHeight > window.innerWidth ? 60 : 75;
  function horizonAlt(): number {
    return (Math.atan(0.56 * Math.tan((fov / 2) * (Math.PI / 180))) * 180) / Math.PI;
  }
  let az = lat >= 0 ? 180 : 0;
  let alt = horizonAlt();
  const arrival = ctx.params.from === 'globe' && !reduced;
  let intro: { start: number; from: number; to: number } | null = arrival ? { start: 0, from: 2, to: alt } : null;
  if (arrival) alt = 2;

  let width = 1;
  let height = 1;
  let stripH = 60;
  let rect = canvas.getBoundingClientRect();
  const camDir = new Vector3();

  // ---- overlay DOM
  const overlay = el('div', 'sky-overlay');
  wrap.appendChild(overlay);
  const namesLayer = el('div');
  overlay.appendChild(namesLayer);

  const cardinals = [
    { t: 'N', az: 0 },
    { t: 'E', az: 90 },
    { t: 'S', az: 180 },
    { t: 'W', az: 270 },
  ].map((c) => {
    const node = el('span', 'sky-label cardinal', c.t);
    overlay.appendChild(node);
    return { node, dir: altAzToWorld(3, c.az), w: 14 };
  });

  const rows: TargetRow[] = TARGETS.map((target) => {
    const mark = button('', 'sky-mark', () => ctx.go('viewer', { q: target.name }));
    mark.setAttribute('aria-label', 'Open ' + target.name + ' in the viewer');
    mark.appendChild(markSvg());
    const label = el('span', 'sky-label target', target.name);
    overlay.append(label, mark);
    return {
      target,
      dir: radecToVec(target.ra, target.dec),
      go: button('', 'go'),
      status: el('span', 's'),
      jump: button('', 'jump'),
      mark,
      label,
      info: null,
    };
  });

  const footprint = el('div', 'sky-footprint');
  footprint.style.display = 'none';
  const reticle = el('div', 'sky-reticle');
  reticle.appendChild(reticleSvg());
  reticle.style.display = 'none';
  const readout = el('div', 'sky-readout');
  readout.style.display = 'none';
  const roRa = el('div');
  const roDec = el('div');
  const roAlt = el('div');
  const roNote = el('div', 'dim');
  readout.append(roRa, roDec, roAlt, roNote);
  overlay.append(footprint, reticle, readout);

  let veil: HTMLElement | null = null;
  if (arrival) {
    veil = el('div', 'sky-veil');
    wrap.appendChild(veil);
    requestAnimationFrame(() => requestAnimationFrame(() => veil?.classList.add('gone')));
  }

  // ---- bottom strip
  const bottom = el('div', 'sky-bottom');
  const msgs = el('div', 'sky-msgs');
  const statusLine = el('div', 'sky-msg');
  statusLine.setAttribute('role', 'status');
  const noteLine = el('div', 'sky-msg');
  if (!readNoteDismissed()) {
    noteLine.append(el('span', undefined, NOTE_TEXT));
    const x = button('x', 'x', () => {
      noteLine.replaceChildren();
      try {
        sessionStorage.setItem(NOTE_KEY, '1');
      } catch {
        /* ignore */
      }
    });
    x.setAttribute('aria-label', 'Dismiss this note');
    noteLine.appendChild(x);
  }
  msgs.append(statusLine, noteLine);

  const strip = el('section', 'sky-strip');
  strip.setAttribute('aria-label', 'Place, time and map controls');
  bottom.append(msgs, strip);

  const openBtn = button('Open this patch', 'chrome-btn primary', () => openAtReticle());
  const touchText = el('span');
  const touchRow = el('div', 's-touch');
  touchRow.append(touchText, openBtn);

  const textBox = el('div', 's-text');
  const l1 = el('div', 'l1');
  const l1Place = el('span');
  const l1Sun = el('small');
  l1.append(l1Place, l1Sun);
  const timeText = button('', 's-time-text');
  const timeMain = el('span');
  const timeUtc = el('small');
  timeText.append(timeMain, timeUtc);
  textBox.append(l1, timeText);

  const playBtns: HTMLButtonElement[] = [];
  function timeButtons(cls: string): HTMLElement {
    const g = el('div', 's-group ' + cls);
    if (cls === 'desk-only') {
      g.appendChild(
        button('Now', 'chrome-btn', () => {
          isTonight = false;
          setDate(new Date(), true);
        }),
      );
    }
    g.append(
      button('-1 h', 'chrome-btn', () => stepHours(-1)),
      button('+1 h', 'chrome-btn', () => stepHours(1)),
    );
    if (!reduced) {
      const p = button('Turn the sky', 'chrome-btn', () => setPlaying(!playing));
      p.setAttribute('aria-pressed', 'false');
      playBtns.push(p);
      g.appendChild(p);
    }
    return g;
  }

  const timeBtnPhone = button('Time', 'chrome-btn s-timebtn');
  const breakEl = el('div', 's-break');

  const waveBox = el('div', 's-wave');
  const waveSel = el('select', 'chrome-field');
  waveSel.setAttribute('aria-label', 'Wavelength');
  const opts = [...frames];
  if (frameKnown && !opts.some((f) => f.index === frameKnown.index)) {
    opts.push(frameKnown);
    opts.sort((a, b) => a.um - b.um);
  }
  for (const f of opts) {
    const o = el('option', undefined, umLabel(f.um));
    o.value = String(f.index);
    waveSel.appendChild(o);
  }
  waveSel.value = String(frameIndex);
  waveSel.disabled = opts.length < 2;
  waveSel.addEventListener('change', () => {
    const idx = parseInt(waveSel.value, 10);
    if (!Number.isFinite(idx)) return;
    frameIndex = idx;
    hips?.setFrame(idx);
    writeParams({ frame: String(idx) });
    markDirty();
  });
  waveBox.appendChild(waveSel);

  const chartBtn = button('Star chart', 'chrome-btn desk-only', () => setStars(!starsOn));
  chartBtn.setAttribute('aria-pressed', 'true');

  const targetsAnchor = el('div', 's-anchor s-targets');
  const targetsBtn = button('', 'chrome-btn');
  targetsBtn.append(el('span', 'long', 'Challenge targets'), el('span', 'short', 'Targets'));
  targetsBtn.setAttribute('aria-label', 'Challenge targets');
  const targetsPop = el('section', 'sky-pop right pop-targets');
  targetsPop.append(el('h2', undefined, 'Challenge targets'));
  targetsPop.appendChild(el('p', 'secondary', 'Open one in the viewer, or find when it is up. Times are ' + clock.label + '.'));
  const list = el('ul');
  for (const r of rows) {
    const li = el('li');
    r.go.append(el('span', 'n', r.target.name), r.status);
    r.go.setAttribute('aria-label', 'Open ' + r.target.name + ' in the viewer');
    r.go.addEventListener('click', () => ctx.go('viewer', { q: r.target.name }));
    r.jump.addEventListener('click', () => jumpTime(r));
    li.append(r.go, r.jump);
    list.appendChild(li);
  }
  targetsPop.appendChild(list);
  targetsAnchor.append(targetsBtn, targetsPop);

  const aboutAnchor = el('div', 's-anchor s-about');
  const aboutBtn = button('About this map', 'chrome-btn');
  const aboutPop = el('section', 'sky-pop right pop-about');
  aboutPop.append(
    el('p', undefined, NOTE_TEXT),
    el('p', 'secondary', 'Map tiles: NASA/IPAC IRSA SPHEREx DR1 all-sky HiPS.'),
  );
  const chartCheckRow = el('label', 'sky-check phone-only');
  const chartBox = el('input');
  chartBox.type = 'checkbox';
  chartBox.checked = true;
  chartBox.addEventListener('change', () => setStars(chartBox.checked));
  chartCheckRow.append(chartBox, el('span', undefined, 'Star chart'));
  aboutPop.appendChild(chartCheckRow);
  aboutAnchor.append(aboutBtn, aboutPop);

  const backBtn = button('', 'chrome-btn s-back', () =>
    ctx.go('globe', { lat: ctx.params.lat, lon: ctx.params.lon }),
  );
  backBtn.append(el('span', 'long', 'Back to the globe'), el('span', 'short', 'Globe'));
  backBtn.setAttribute('aria-label', 'Back to the globe');

  // time popover: edit field, Now; on phones also the step buttons
  const timePop = el('section', 'sky-pop pop-time');
  const timeInput = el('input', 'chrome-field');
  timeInput.type = 'datetime-local';
  timeInput.setAttribute('aria-label', 'Time, ' + clock.label);
  timeInput.title = 'Time, ' + clock.label;
  timeInput.addEventListener('change', () => {
    const d = clock.fromInput(timeInput.value);
    if (d) {
      isTonight = false;
      setDate(d, true);
    }
  });
  timePop.append(
    timeInput,
    button('Now', 'chrome-btn', () => {
      isTonight = false;
      setDate(new Date(), true);
    }),
    timeButtons('phone-only'),
  );

  strip.append(
    touchRow,
    textBox,
    timeButtons('desk-only'),
    timeBtnPhone,
    breakEl,
    waveBox,
    chartBtn,
    targetsAnchor,
    aboutAnchor,
    backBtn,
    timePop,
  );

  const live = el('div', 'sky-sr');
  live.setAttribute('aria-live', 'polite');
  wrap.append(bottom, live);

  function setStars(on: boolean): void {
    starsOn = on;
    chartBox.checked = on;
    chartBtn.setAttribute('aria-pressed', String(on));
    if (starLayer) starLayer.points.visible = on;
    namesLayer.style.display = on ? '' : 'none';
    markDirty();
  }

  // ---- popovers
  const pops: Pop[] = [
    { btns: [timeText, timeBtnPhone], pop: timePop },
    { btns: [targetsBtn], pop: targetsPop },
    { btns: [aboutBtn], pop: aboutPop },
  ];
  function closePops(except?: Pop, refocus = false): void {
    for (const p of pops) {
      if (p === except || !p.pop.classList.contains('open')) continue;
      p.pop.classList.remove('open');
      p.btns.forEach((b) => b.setAttribute('aria-expanded', 'false'));
      if (refocus) {
        const vis = p.btns.find((b) => b.offsetParent !== null);
        vis?.focus();
      }
    }
  }
  for (const p of pops) {
    p.btns.forEach((b) => {
      b.setAttribute('aria-expanded', 'false');
      b.addEventListener('click', () => {
        const open = !p.pop.classList.contains('open');
        closePops(open ? p : undefined);
        p.pop.classList.toggle('open', open);
        p.btns.forEach((x) => x.setAttribute('aria-expanded', String(open)));
      });
    });
  }
  const onDocPointer = (e: PointerEvent): void => {
    const t = e.target as Node;
    for (const p of pops) {
      if (!p.pop.classList.contains('open')) continue;
      if (p.pop.contains(t) || p.btns.some((b) => b.contains(t))) return;
    }
    closePops();
  };
  const onDocKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && pops.some((p) => p.pop.classList.contains('open'))) closePops(undefined, true);
  };
  document.addEventListener('pointerdown', onDocPointer, true);
  document.addEventListener('keydown', onDocKey);

  // ---- time
  let playing = false;
  let uiDirty = true;
  let lastUi = 0;
  let lastUrlWrite = 0;
  let urlPending = false;

  function applyTime(): void {
    celestial.matrix.copy(eqjToWorld(date, place));
    celestial.matrixWorldNeedsUpdate = true;
    invCelestial.copy(celestial.matrix).invert();
  }

  function setDate(d: Date, writeNow: boolean): void {
    date = d;
    applyTime();
    uiDirty = true;
    markDirty();
    if (writeNow) {
      writeParams({ t: toIso(date) });
      urlPending = false;
    } else urlPending = true;
  }

  function stepHours(h: number): void {
    isTonight = false;
    setDate(new Date(date.getTime() + h * 3600000), true);
  }

  function setPlaying(on: boolean): void {
    if (on && reduced) return;
    playing = on;
    if (on) isTonight = false;
    for (const b of playBtns) {
      setText(b, on ? 'Pause' : 'Turn the sky');
      b.setAttribute('aria-pressed', String(on));
    }
    if (!on && urlPending) {
      writeParams({ t: toIso(date) });
      urlPending = false;
    }
    markDirty();
  }

  function localDayWord(d: Date): string {
    const diff = clock.dayNumber(d) - clock.dayNumber(date);
    return diff === 0 ? '' : diff === 1 ? ' tomorrow' : diff === -1 ? ' yesterday' : '';
  }

  function refreshUi(): void {
    setText(l1Place, 'Sky over ' + (placeName || fmtPlace(lat, lon)));
    const sun = sunAltitude(place, date);
    setText(l1Sun, sun > 0 ? 'The Sun is up here at this time.' : '');
    setText(
      timeMain,
      (isTonight ? 'Tonight, ' + clock.time(date) : clock.full(date)) + ' ' + clock.label,
    );
    setText(timeUtc, fmtUtcClock(date) + ' UTC');
    if (document.activeElement !== timeInput) timeInput.value = clock.toInput(date);

    for (const r of rows) {
      const ri = riseInfo({ ra: r.target.ra, dec: r.target.dec }, place, date);
      r.info = ri;
      let text: string;
      let jumpText = '';
      if (ri.state === 'circumpolar') {
        text = 'Always up, ' + Math.round(ri.altNow) + ' deg now';
        jumpText = 'Show me its highest point';
      } else if (ri.state === 'up') {
        text = 'Up now, ' + Math.round(ri.altNow) + ' deg';
        jumpText = 'Show me its highest point';
      } else if (ri.state === 'rises' && ri.nextRise) {
        text = 'Below the horizon until ' + clock.time(ri.nextRise) + localDayWord(ri.nextRise);
        jumpText = 'Show me when it is up';
      } else {
        text = 'Never rises from here';
      }
      setText(r.status, text);
      setText(r.jump, jumpText);
      r.jump.style.display = jumpText ? '' : 'none';
    }
  }

  function transitTime(from: Date, target: Target): Date {
    let best = from;
    let bestAlt = -999;
    for (let m = 0; m <= 24 * 60; m += 10) {
      const d = new Date(from.getTime() + m * 60000);
      const a = riseInfo({ ra: target.ra, dec: target.dec }, place, d).altNow;
      if (a > bestAlt) {
        bestAlt = a;
        best = d;
      }
    }
    return best;
  }

  function jumpTime(r: TargetRow): void {
    const ri = r.info;
    if (!ri) return;
    let d: Date | null = null;
    if (ri.state === 'rises' && ri.nextRise) d = new Date(ri.nextRise.getTime() + 2 * 3600000);
    else if (ri.state === 'up' || ri.state === 'circumpolar') d = transitTime(date, r.target);
    if (!d) return;
    isTonight = false;
    setDate(d, true);
    refreshUi();
    uiDirty = false;
    closePops();
    turnTo(r);
  }

  // ---- view movement
  let tween: { start: number; az0: number; alt0: number; az1: number; alt1: number } | null = null;

  function turnTo(r: TargetRow): void {
    const w = r.dir.clone().applyMatrix4(celestial.matrix);
    const aa = worldToAltAz(w);
    if (aa.alt <= 0) return;
    intro = null;
    let d = wrap360(aa.az - az);
    if (d > 180) d -= 360;
    const target = { alt: clamp(aa.alt, ALT_MIN, ALT_MAX), az: az + d };
    if (reduced) {
      az = wrap360(target.az);
      alt = target.alt;
    } else tween = { start: performance.now(), az0: az, alt0: alt, az1: target.az, alt1: target.alt };
    markDirty();
  }

  function applyCamera(): void {
    alt = clamp(alt, ALT_MIN, ALT_MAX);
    az = wrap360(az);
    fov = clamp(fov, FOV_MIN, FOV_MAX);
    camera.fov = fov;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    altAzToWorld(alt, az, camDir);
    camera.lookAt(camDir);
    camera.updateMatrixWorld();
    const ring = fov < FOV_RINGS;
    if (ring !== ringMode) {
      ringMode = ring;
      starLayer?.setRing(ring);
    }
  }

  const ray = new Vector3();
  function dirAt(x: number, y: number, out = ray): Vector3 {
    out.set((x / width) * 2 - 1, -(y / height) * 2 + 1, 0.5).unproject(camera);
    return out.normalize();
  }

  // ---- reticle
  let rx = 0;
  let ry = 0;
  let reticleOn = false;
  let touchMode = false;

  function setReticle(x: number, y: number): void {
    rx = x;
    ry = y;
    reticleOn = true;
    reticle.style.display = '';
    markDirty();
  }

  const worldTmp = new Vector3();
  const eqjTmp = new Vector3();
  function reticleSky(): { ra: number; dec: number; alt: number; az: number } {
    dirAt(rx, ry, worldTmp);
    const aa = worldToAltAz(worldTmp);
    eqjTmp.copy(worldTmp).applyMatrix4(invCelestial);
    const rd = vecToRadec(eqjTmp);
    return { ra: rd.ra, dec: rd.dec, alt: aa.alt, az: aa.az };
  }

  function updateReticleUi(): void {
    if (!reticleOn) {
      footprint.style.display = 'none';
      reticle.style.display = 'none';
      readout.style.display = 'none';
      touchRow.classList.remove('on');
      return;
    }
    const s = reticleSky();
    const below = s.alt < 0;
    reticle.style.transform = 'translate(' + rx.toFixed(1) + 'px,' + ry.toFixed(1) + 'px)';
    reticle.classList.toggle('below', below);
    const px = (PATCH_ARCSEC / 3600 / fov) * height;
    if (!below && px > 6) {
      footprint.style.display = '';
      footprint.style.width = px.toFixed(1) + 'px';
      footprint.style.height = px.toFixed(1) + 'px';
      footprint.style.transform = 'translate(' + (rx - px / 2).toFixed(1) + 'px,' + (ry - px / 2).toFixed(1) + 'px)';
    } else footprint.style.display = 'none';
    const note = below
      ? 'Below the horizon'
      : px > 6
        ? 'Square is the 400 arcsec patch'
        : 'Patch 400 arcsec, smaller than the ring at this zoom';
    const raTxt = 'RA ' + fmtRa(s.ra) + '  ' + s.ra.toFixed(3) + ' deg';
    const decTxt = 'Dec ' + fmtDeg(s.dec, 3, true) + ' deg';
    const altTxt = 'Alt ' + fmtDeg(s.alt, 1) + ' deg  Az ' + fmtDeg(s.az, 1) + ' deg';
    if (touchMode) {
      readout.style.display = 'none';
      touchRow.classList.add('on');
      setText(touchText, below ? note : fmtRa(s.ra) + ', ' + fmtDeg(s.dec, 2, true) + ' deg, alt ' + fmtDeg(s.alt, 0) + ' deg');
      openBtn.disabled = below;
    } else {
      touchRow.classList.remove('on');
      readout.style.display = '';
      setText(roRa, raTxt);
      setText(roDec, decTxt);
      setText(roAlt, altTxt);
      setText(roNote, note);
      const w = 200;
      const h = 70;
      const limitY = height - stripH - 20;
      let ox = rx + 26;
      let align = 'left';
      if (ox + w > width - 8) {
        ox = rx - 26 - w;
        align = 'right';
      }
      let oy = ry + 14;
      if (oy + h > limitY) oy = ry - 14 - h;
      readout.style.textAlign = align;
      readout.style.transform = 'translate(' + ox.toFixed(0) + 'px,' + oy.toFixed(0) + 'px)';
    }
  }

  function openAtReticle(): void {
    if (!reticleOn) return;
    const s = reticleSky();
    if (s.alt < 0) return;
    ctx.go('viewer', { ra: s.ra.toFixed(5), dec: s.dec.toFixed(5) });
  }

  // ---- projection of overlays
  const pv = new Vector3();
  const wv = new Vector3();
  function proj(dirWorld: Vector3, out: { x: number; y: number }): boolean {
    if (dirWorld.dot(camDir) <= 0.02) return false;
    pv.copy(dirWorld).project(camera);
    out.x = (pv.x + 1) * 0.5 * width;
    out.y = (1 - pv.y) * 0.5 * height;
    return out.x > -30 && out.x < width + 30 && out.y > -30 && out.y < height + 30;
  }

  const pt = { x: 0, y: 0 };
  const rects: number[] = [];
  function free(x: number, y: number, w: number, h: number): boolean {
    for (let i = 0; i < rects.length; i += 4) {
      if (x < rects[i + 2] && x + w > rects[i] && y < rects[i + 3] && y + h > rects[i + 1]) return false;
    }
    rects.push(x, y, x + w, y + h);
    return true;
  }

  function place2(node: HTMLElement, x: number, y: number): void {
    node.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
  }

  function projectOverlay(): void {
    rects.length = 0;
    for (const c of cardinals) {
      const ok = proj(c.dir, pt);
      c.node.style.display = ok ? '' : 'none';
      if (ok) place2(c.node, pt.x - c.w / 2, pt.y - 24);
    }
    for (const r of rows) {
      wv.copy(r.dir).applyMatrix4(celestial.matrix);
      const ok = wv.y > 0 && proj(wv, pt);
      r.mark.style.display = ok ? '' : 'none';
      r.label.style.display = ok ? '' : 'none';
      if (ok) {
        r.mark.style.transform = 'translate(' + pt.x.toFixed(1) + 'px,' + pt.y.toFixed(1) + 'px)';
        const w = r.target.name.length * 7 + 4;
        place2(r.label, pt.x + 14, pt.y - 8);
        rects.push(pt.x + 14, pt.y - 8, pt.x + 14 + w, pt.y + 8);
      }
    }
    if (starLayer && starsOn) {
      let shown = 0;
      const cap = ringMode ? 40 : 12;
      const named = starLayer.named;
      for (let i = 0; i < named.length; i++) {
        const nl = nameLabels[i];
        let ok = false;
        if (shown < cap) {
          wv.copy(named[i].dir).applyMatrix4(celestial.matrix);
          if (wv.y > 0.02 && proj(wv, pt) && pt.x > 0 && pt.x < width && pt.y > 0 && pt.y < height) {
            if (free(pt.x + 10, pt.y - 8, nl.w, 16)) {
              ok = true;
              shown++;
              place2(nl.node, pt.x + 10, pt.y - 8);
            }
          }
        }
        if (ok !== nl.shown) {
          nl.node.style.display = ok ? '' : 'none';
          nl.shown = ok;
        }
      }
    }
  }
  const nameLabels: NamedLabel[] = [];

  // ---- input
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { id: number; sx: number; sy: number; lx: number; ly: number; moved: boolean; type: string } | null = null;
  let pinch: { dist: number; fov: number } | null = null;
  let liveTimer = 0;

  function local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function panBy(dx: number, dy: number): void {
    const k = fov / height;
    const c = Math.max(0.3, Math.cos((alt * Math.PI) / 180));
    az -= (dx * k) / c;
    alt += dy * k;
    alt = clamp(alt, ALT_MIN, ALT_MAX);
  }

  function pinchDist(): number {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function announce(): void {
    window.clearTimeout(liveTimer);
    liveTimer = window.setTimeout(() => {
      const lines = ['Looking at azimuth ' + Math.round(az) + ' degrees, altitude ' + Math.round(alt) + ' degrees.'];
      if (reticleOn) lines.push(roNote.textContent ?? '');
      live.textContent = lines.join(' ');
    }, 400);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') canvas.focus({ preventScroll: true });
    intro = null;
    tween = null;
    touchMode = e.pointerType === 'touch';
    const p = local(e);
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      drag = { id: e.pointerId, sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false, type: e.pointerType };
    } else if (pointers.size === 2) {
      if (drag) drag.moved = true;
      pinch = { dist: Math.max(1, pinchDist()), fov };
    }
    if (!touchMode) setReticle(p.x, p.y);
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (e.pointerType !== 'touch') {
      touchMode = false;
      canvas.classList.add('hide-cursor');
      setReticle(p.x, p.y);
    }
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      fov = clamp((pinch.fov * pinch.dist) / Math.max(1, pinchDist()), FOV_MIN, FOV_MAX);
      markDirty();
      return;
    }
    if (drag && drag.id === e.pointerId) {
      if (!drag.moved && Math.hypot(p.x - drag.sx, p.y - drag.sy) >= 5) drag.moved = true;
      if (drag.moved) {
        panBy(p.x - drag.lx, p.y - drag.ly);
        drag.lx = p.x;
        drag.ly = p.y;
        markDirty();
      }
    }
  });

  function endPointer(e: PointerEvent, cancelled: boolean): void {
    const p = local(e);
    const wasDrag = drag && drag.id === e.pointerId ? drag : null;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (wasDrag) {
      drag = null;
      if (!cancelled && !wasDrag.moved && pointers.size === 0) {
        setReticle(p.x, p.y);
        if (wasDrag.type !== 'touch') openAtReticle();
        else {
          touchMode = true;
          markDirty();
        }
      }
    }
  }
  canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch' || pointers.size > 0 || touchMode) return;
    reticleOn = false;
    markDirty();
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      intro = null;
      tween = null;
      const p = local(e);
      const before = worldToAltAz(dirAt(p.x, p.y, new Vector3()));
      fov = clamp(fov * Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0012)), FOV_MIN, FOV_MAX);
      applyCamera();
      const after = worldToAltAz(dirAt(p.x, p.y, new Vector3()));
      az += before.az - after.az;
      alt += before.alt - after.alt;
      markDirty();
    },
    { passive: false },
  );

  canvas.addEventListener('keydown', (e) => {
    const step = fov / 10;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        az -= step;
        break;
      case 'ArrowRight':
        az += step;
        break;
      case 'ArrowUp':
        alt += step;
        break;
      case 'ArrowDown':
        alt -= step;
        break;
      case '+':
      case '=':
        fov *= 0.8;
        break;
      case '-':
      case '_':
        fov /= 0.8;
        break;
      case 'Enter':
        if (!reticleOn) setReticle(width / 2, height / 2);
        applyCamera();
        openAtReticle();
        break;
      default:
        handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    intro = null;
    tween = null;
    if (e.key !== 'Enter') {
      if (!reticleOn) setReticle(width / 2, height / 2);
      announce();
    }
    markDirty();
  });

  // ---- sizing
  function resize(): void {
    rect = canvas.getBoundingClientRect();
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    stripH = strip.offsetHeight || 60;
    renderer.setSize(width, height, false);
    starLayer?.setPixelRatio(pixelRatio);
    markDirty();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  ro.observe(strip);

  // ---- loop
  let lastChange = performance.now();
  let lastRender = 0;
  let viewDirty = true;
  let raf = 0;
  let last = performance.now();
  let shownLoading = false;
  let shownFailed = false;

  function markDirty(): void {
    lastChange = performance.now();
    viewDirty = true;
  }

  function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  function tick(now: number): void {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    if (intro) {
      if (!intro.start) intro.start = now;
      const t = Math.min(1, (now - intro.start) / 900);
      alt = intro.from + (intro.to - intro.from) * easeOutCubic(t);
      if (t >= 1) intro = null;
      markDirty();
    }
    if (tween) {
      const t = Math.min(1, (now - tween.start) / 400);
      const e = easeOutCubic(t);
      az = tween.az0 + (tween.az1 - tween.az0) * e;
      alt = tween.alt0 + (tween.alt1 - tween.alt0) * e;
      if (t >= 1) tween = null;
      markDirty();
    }
    if (playing) {
      date = new Date(date.getTime() + dt * PLAY_RATE * 1000);
      applyTime();
      urlPending = true;
      markDirty();
      if (now - lastUi > 250) uiDirty = true;
      if (now - lastUrlWrite > 500) {
        writeParams({ t: toIso(date) });
        lastUrlWrite = now;
        urlPending = false;
      }
    }
    if (uiDirty && (!playing || now - lastUi > 250)) {
      refreshUi();
      uiDirty = false;
      lastUi = now;
    }

    const ld = !!hips?.loading;
    const fl = !!hips?.failed;
    if (ld !== shownLoading || fl !== shownFailed) {
      shownLoading = ld;
      shownFailed = fl;
      setText(
        statusLine,
        fl ? 'Map tiles did not load. The chart and targets still work.' : ld ? 'Loading map' : '',
      );
    }
    if (ld) lastChange = now;

    if (now - lastChange > 1000 && now - lastRender < 250) return;

    if (viewDirty) {
      applyCamera();
      projectOverlay();
      updateReticleUi();
      viewDirty = false;
    }
    hips?.update(camera, height * pixelRatio);
    renderer.render(scene, camera);
    lastRender = now;
  }

  applyTime();
  // face the highest challenge target above the horizon, else the equator side
  {
    let best = 0;
    for (const r of rows) {
      const aa = worldToAltAz(r.dir.clone().applyMatrix4(celestial.matrix));
      if (aa.alt > best) {
        best = aa.alt;
        az = aa.az;
      }
    }
  }
  resize();
  refreshUi();
  raf = requestAnimationFrame(tick);

  let disposed = false;
  loadBrightStars()
    .then((stars) => {
      if (disposed || stars.length === 0) return;
      starLayer = createStarLayer(stars);
      starLayer.points.visible = starsOn;
      starLayer.setPixelRatio(pixelRatio);
      starLayer.setRing(ringMode);
      celestial.add(starLayer.points);
      for (const n of starLayer.named) {
        const node = el('span', 'sky-label', n.star.name ?? '');
        node.style.display = 'none';
        namesLayer.appendChild(node);
        nameLabels.push({ node, w: (n.star.name ?? '').length * 6.6 + 4, shown: false });
      }
      markDirty();
    })
    .catch(() => {});

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    window.clearTimeout(liveTimer);
    ro.disconnect();
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onDocKey);
    hips?.dispose();
    starLayer?.dispose();
    backdrop.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    wrap.remove();
  };
};
