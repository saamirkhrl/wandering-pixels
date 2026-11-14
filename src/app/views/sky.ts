import {
  DefaultLoadingManager,
  Group,
  Matrix4,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
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
import { TARGETS, type Target } from '../sky/targets';
import { button, el, markSvg, reticleSvg, setText } from '../sky/view/dom';
import {
  clamp,
  fmtClock,
  fmtDay,
  fmtDeg,
  fmtPlace,
  fmtRa,
  fmtUtcClock,
  fromInputValue,
  localDayNumber,
  toInputValue,
  toIso,
  wrap360,
} from '../sky/view/format';
import { createBackdrop, createStarLayer, type StarLayer } from '../sky/view/scene';
import { loadBrightStars } from '../sky/stars';
import '../sky/view/sky.css';

const FOV_MIN = 5;
const FOV_MAX = 100;
const ALT_MIN = -10;
const ALT_MAX = 89.9;
const PATCH_ARCSEC = 400;
const WANTED_UM = [0.75, 1.1, 1.6, 2.2, 3.4, 4.6];
const PLAY_RATE = 1200;

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

interface TargetRow {
  target: Target;
  dir: Vector3;
  go: HTMLButtonElement;
  status: HTMLElement;
  jump: HTMLButtonElement;
  mark: SVGSVGElement;
  label: HTMLElement;
  info: RiseInfo | null;
}

interface NamedLabel {
  node: HTMLElement;
  w: number;
  shown: boolean;
}

export const mount: Mount = (root, ctx) => {
  const lat = parseFloat(ctx.params.lat ?? '');
  const lon = parseFloat(ctx.params.lon ?? '');
  const wrap = el('div', 'sky-root');
  root.appendChild(wrap);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 360) {
    const box = el('div', 'sky-missing');
    const p = el('section', 'sky-panel');
    p.append(
      el('h2', undefined, 'Pick a place first'),
      el('p', undefined, 'The sky depends on where you stand. Choose a place on the globe.'),
      button('Back to the globe', 'sky-btn primary', () => ctx.go('globe')),
    );
    box.appendChild(p);
    wrap.appendChild(box);
    return () => wrap.remove();
  }

  const place = { lat, lon };
  const reduced = prefersReducedMotion();
  const phoneMq = window.matchMedia('(max-width: 599px)');

  let date = new Date(ctx.params.t ?? '');
  if (Number.isNaN(date.getTime())) date = new Date();
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

  // ---- view state
  let az = Number.isFinite(parseFloat(ctx.params.az ?? '')) ? wrap360(parseFloat(ctx.params.az)) : lat >= 0 ? 180 : 0;
  let alt = 25;
  let fov = phoneMq.matches && window.innerHeight > window.innerWidth ? 60 : 75;
  const arrival = ctx.params.from === 'globe' && !reduced;
  let intro = arrival ? { start: 0, from: 2, to: 25 } : null;
  if (arrival) alt = 2;

  let width = 1;
  let height = 1;
  let rect = canvas.getBoundingClientRect();
  const camDir = new Vector3();

  // ---- overlay DOM
  const overlay = el('div', 'sky-overlay');
  wrap.appendChild(overlay);

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
    const mark = markSvg();
    mark.classList.add('sky-mark');
    const label = el('span', 'sky-label target', target.name);
    overlay.append(mark, label);
    return {
      target,
      dir: radecToVec(target.ra, target.dec),
      go: button('', 'sky-btn go'),
      status: el('span', 's'),
      jump: button('', 'sky-btn jump'),
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
  overlay.append(footprint, reticle);

  let veil: HTMLElement | null = null;
  if (arrival) {
    veil = el('div', 'sky-veil');
    wrap.appendChild(veil);
    requestAnimationFrame(() => requestAnimationFrame(() => veil?.classList.add('gone')));
  }

  // ---- panels
  const info = el('section', 'sky-panel sky-info');
  const placeLine = el('p');
  const sunLine = el('p', 'sky-note');
  const about = el('details');
  about.open = !phoneMq.matches;
  about.append(
    el('summary', undefined, 'About this map'),
    el(
      'p',
      'sky-quiet',
      "This is SPHEREx's first-year all-sky map. It does not change with the date; the date only turns the sky. Open a patch to see changes between visits.",
    ),
  );
  const tileStatus = el('p', 'sky-quiet');
  tileStatus.setAttribute('role', 'status');
  const backBtn = button('Back to the globe', 'sky-btn', () => ctx.go('globe', { lat: ctx.params.lat, lon: ctx.params.lon }));
  info.append(placeLine, sunLine, tileStatus, about, backBtn);

  const dock = el('div', 'sky-dock');

  const openBtn = button('Open this patch', 'sky-btn primary sky-open', () => openAtReticle());

  const readout = el('section', 'sky-panel sky-readout');
  readout.setAttribute('aria-label', 'Reticle readout');
  const rowOf = (k: string) => {
    const r = el('div', 'row');
    const key = el('span', 'k', k);
    const val = el('span');
    r.append(key, val);
    readout.appendChild(r);
    return val;
  };
  const roRa = rowOf('RA');
  const roDec = rowOf('Dec');
  const roAlt = rowOf('Alt, Az');
  const roNote = el('div', 'sky-quiet');
  readout.appendChild(roNote);
  const live = el('div', 'sky-sr');
  live.setAttribute('aria-live', 'polite');

  const targetsPanel = el('details', 'sky-panel sky-targets');
  targetsPanel.open = !phoneMq.matches;
  targetsPanel.append(el('summary', undefined, 'Challenge targets'));
  targetsPanel.appendChild(el('p', 'sky-quiet', 'Times are local solar time for this place.'));
  const list = el('ul');
  for (const r of rows) {
    const li = el('li');
    const nm = el('span', 'n', r.target.name);
    r.go.append(nm, r.status);
    r.go.setAttribute('aria-label', 'Turn the view to ' + r.target.name);
    r.go.addEventListener('click', () => turnTo(r));
    r.jump.addEventListener('click', () => jumpTime(r));
    li.append(r.go, r.jump);
    list.appendChild(li);
  }
  targetsPanel.appendChild(list);

  const controls = el('details', 'sky-panel sky-controls');
  controls.open = !phoneMq.matches;
  controls.appendChild(el('summary', undefined, 'Time and map'));

  const timeField = el('div', 'sky-field');
  const timeLabel = el('label', undefined, 'Time (UTC)');
  const timeInput = el('input');
  timeInput.type = 'datetime-local';
  timeInput.id = 'sky-time';
  timeLabel.htmlFor = 'sky-time';
  timeInput.addEventListener('change', () => {
    const d = fromInputValue(timeInput.value);
    if (d) setDate(d, true);
  });
  timeField.append(timeLabel, timeInput);

  const timeBtns = el('div', 'sky-btnrow');
  const playBtn = button('Turn the sky', 'sky-btn', () => setPlaying(!playing));
  playBtn.setAttribute('aria-pressed', 'false');
  timeBtns.append(
    button('Now', 'sky-btn', () => setDate(new Date(), true)),
    button('-1 h', 'sky-btn', () => setDate(new Date(date.getTime() - 3600000), true)),
    button('+1 h', 'sky-btn', () => setDate(new Date(date.getTime() + 3600000), true)),
  );
  if (!reduced) timeBtns.appendChild(playBtn);

  const waveField = el('div', 'sky-field');
  const waveLabel = el('label', undefined, 'Wavelength');
  const waveSel = el('select');
  waveSel.id = 'sky-wave';
  waveLabel.htmlFor = 'sky-wave';
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
  waveField.append(waveLabel, waveSel);

  const chartRow = el('label', 'sky-check');
  const chartBox = el('input');
  chartBox.type = 'checkbox';
  chartBox.checked = true;
  chartBox.addEventListener('change', () => {
    starsOn = chartBox.checked;
    if (starLayer) starLayer.points.visible = starsOn;
    namesLayer.style.display = starsOn ? '' : 'none';
    markDirty();
  });
  chartRow.append(chartBox, el('span', undefined, 'Star chart'));

  controls.append(timeField, timeBtns, waveField, chartRow);

  dock.append(openBtn, readout, targetsPanel, controls);
  wrap.append(info, dock, live);

  const namesLayer = el('div');
  overlay.insertBefore(namesLayer, overlay.firstChild);
  const nameLabels: NamedLabel[] = [];

  // ---- tile loading state
  const prevMgr = {
    onStart: DefaultLoadingManager.onStart,
    onLoad: DefaultLoadingManager.onLoad,
    onError: DefaultLoadingManager.onError,
  };
  let tileLoading = false;
  let tileErrors = 0;
  let tileTotal = 0;
  let tileFailed = false;
  DefaultLoadingManager.onStart = (url, loaded, total) => {
    prevMgr.onStart?.(url, loaded, total);
    if (!tileLoading) tileErrors = 0;
    tileLoading = true;
    tileTotal = total;
    uiDirty = true;
  };
  DefaultLoadingManager.onLoad = () => {
    prevMgr.onLoad?.();
    tileLoading = false;
    tileFailed = tileErrors >= 3 && tileErrors >= tileTotal * 0.5;
    uiDirty = true;
    markDirty();
  };
  DefaultLoadingManager.onError = (url) => {
    prevMgr.onError?.(url);
    tileErrors++;
  };

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

  function setPlaying(on: boolean): void {
    if (on && reduced) return;
    playing = on;
    setText(playBtn, on ? 'Pause' : 'Turn the sky');
    playBtn.setAttribute('aria-pressed', String(on));
    if (!on && urlPending) {
      writeParams({ t: toIso(date) });
      urlPending = false;
    }
    markDirty();
  }

  function localDayWord(d: Date): string {
    const diff = localDayNumber(d, lon) - localDayNumber(date, lon);
    return diff === 0 ? '' : diff === 1 ? ' tomorrow' : diff === -1 ? ' yesterday' : ' on ' + fmtDay(d, lon);
  }

  function refreshUi(): void {
    setText(
      placeLine,
      'Sky over ' + fmtPlace(lat, lon) + ' at ' + fmtClock(date, lon) + ' local solar time, ' +
        fmtDay(date, lon) + ' (' + fmtUtcClock(date) + ' UTC)',
    );
    const sun = sunAltitude(place, date);
    setText(sunLine, sun > 0 ? 'Daytime here: the Sun is up. The infrared map is still shown.' : '');
    sunLine.style.display = sun > 0 ? '' : 'none';
    if (document.activeElement !== timeInput) timeInput.value = toInputValue(date);

    for (const r of rows) {
      const ri = riseInfo({ ra: r.target.ra, dec: r.target.dec }, place, date);
      r.info = ri;
      let text: string;
      let jumpText = '';
      if (ri.state === 'circumpolar') {
        text = 'Always up, ' + Math.round(ri.altNow) + ' deg now';
        jumpText = 'Time of highest point';
      } else if (ri.state === 'up') {
        text = 'Up now, ' + Math.round(ri.altNow) + ' deg';
        jumpText = 'Time of highest point';
      } else if (ri.state === 'rises' && ri.nextRise) {
        text = 'Below the horizon until about ' + fmtClock(ri.nextRise, lon) + localDayWord(ri.nextRise);
        jumpText = 'Set time when it is up';
      } else {
        text = 'Never rises from here';
      }
      setText(r.status, text);
      setText(r.jump, jumpText);
      r.jump.style.display = jumpText ? '' : 'none';
      r.go.disabled = ri.altNow <= 0;
      r.go.title = ri.altNow > 0 ? 'Turn the view to ' + r.target.name : r.target.name + ' is below the horizon';
    }

    if (tileFailed) {
      setText(tileStatus, 'SPHEREx map tiles did not load. The chart and targets still work.');
      tileStatus.classList.add('err');
    } else {
      setText(tileStatus, tileLoading ? 'Loading map tiles' : '');
      tileStatus.classList.remove('err');
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
    setDate(d, true);
    refreshUi();
    uiDirty = false;
    turnTo(r);
  }

  // ---- view movement
  let tween: { start: number; az0: number; alt0: number; az1: number; alt1: number } | null = null;

  function turnTo(r: TargetRow): void {
    const w = r.dir.clone().applyMatrix4(celestial.matrix);
    const aa = worldToAltAz(w);
    if (aa.alt <= 0) return;
    intro = null;
    const az1 = aa.az;
    let d = wrap360(az1 - az);
    if (d > 180) d -= 360;
    const target = { alt: clamp(aa.alt, ALT_MIN, ALT_MAX), az: az + d };
    if (reduced) {
      az = wrap360(target.az);
      alt = target.alt;
      markDirty();
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
      setText(roRa, '-');
      setText(roDec, '-');
      setText(roAlt, '-');
      setText(roNote, touchMode ? 'Tap the sky to place the reticle.' : 'Move the pointer over the sky.');
      openBtn.classList.remove('on');
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
    setText(roRa, fmtRa(s.ra) + '  ' + s.ra.toFixed(3) + ' deg');
    setText(roDec, fmtDeg(s.dec, 3, true) + ' deg');
    setText(roAlt, fmtDeg(s.alt, 1) + ' deg, ' + fmtDeg(s.az, 1) + ' deg');
    setText(
      roNote,
      below
        ? 'Below the horizon'
        : px > 6
          ? 'Square is the 400 arcsec patch'
          : 'Patch 400 arcsec, smaller than the ring at this zoom',
    );
    openBtn.classList.toggle('on', touchMode && !below);
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
        place2(r.label, pt.x + 12, pt.y - 8);
        rects.push(pt.x + 12, pt.y - 8, pt.x + 12 + w, pt.y + 8);
      }
    }
    if (starLayer && starsOn) {
      let shown = 0;
      const named = starLayer.named;
      for (let i = 0; i < named.length; i++) {
        const nl = nameLabels[i];
        let ok = false;
        if (shown < 40) {
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
    canvas.focus({ preventScroll: true });
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
    if (e.pointerType === 'touch' || pointers.size > 0 || openBtn.classList.contains('on')) return;
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
    renderer.setSize(width, height, false);
    starLayer?.setPixelRatio(pixelRatio);
    markDirty();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);

  // ---- loop
  let lastChange = performance.now();
  let lastRender = 0;
  let viewDirty = true;
  let raf = 0;
  let last = performance.now();

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
    DefaultLoadingManager.onStart = prevMgr.onStart;
    DefaultLoadingManager.onLoad = prevMgr.onLoad;
    DefaultLoadingManager.onError = prevMgr.onError;
    hips?.dispose();
    starLayer?.dispose();
    backdrop.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    wrap.remove();
  };
};
