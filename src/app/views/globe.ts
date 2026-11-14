import {
  DataTexture,
  Mesh,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
  Matrix4,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { prefersReducedMotion } from '../motion';
import type { Mount } from '../types';
import { formatLatLon, nearestPlace } from '../globe/places';
import { latLonToVec, localBasis, subsolarPoint, vecToLatLon } from '../globe/geo';
import '../globe/globe.css';

const INTRO =
  "Pick a place on Earth. See its sky as NASA's SPHEREx telescope mapped it in infrared, then open any patch to watch it across visits.";
const FLIGHT_MS = 1600;
const VEIL_MS = 400;
const STAND_DIST = 1.003;
const STAND_PITCH = 25 * (Math.PI / 180);
const TAP_SLOP = 5;

const VERT = `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vViewN;
varying vec3 vViewPos;
void main() {
  vUv = uv;
  vN = normalize(position);
  vViewN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = `
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform vec3 uSun;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vViewN;
varying vec3 vViewPos;
void main() {
  float d = dot(normalize(vN), uSun);
  float k = smoothstep(-0.10, 0.12, d);
  vec3 day = texture2D(uDay, vUv).rgb;
  vec3 lit = day * (0.8 + 0.2 * clamp(d, 0.0, 1.0));
  vec3 night = texture2D(uNight, vUv).rgb * 0.85 + day * 0.05;
  vec3 col = mix(night, lit, k);
  float rim = pow(1.0 - clamp(dot(normalize(vViewN), normalize(-vViewPos)), 0.0, 1.0), 9.0);
  col += vec3(0.42, 0.52, 0.72) * rim * 0.22;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease3 = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const sub = (a: number, lo: number, hi: number) => ease3((a - lo) / (hi - lo));

function slerpDir(a: Vector3, b: Vector3, t: number, out: Vector3): Vector3 {
  const dot = Math.max(-1, Math.min(1, a.dot(b)));
  const ang = Math.acos(dot);
  if (ang < 1e-5) return out.copy(b);
  const s = Math.sin(ang);
  return out
    .copy(a)
    .multiplyScalar(Math.sin((1 - t) * ang) / s)
    .addScaledVector(b, Math.sin(t * ang) / s)
    .normalize();
}

function lookQuat(pos: Vector3, out: Quaternion): Quaternion {
  const up = Math.abs(pos.y) / pos.length() > 0.98 ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
  const m = new Matrix4().lookAt(pos, new Vector3(), up);
  return out.setFromRotationMatrix(m);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function blackTexture(): DataTexture {
  const t = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat);
  t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export const mount: Mount = (root, ctx) => {
  const view = el('div', 'globe-view');
  root.appendChild(view);

  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 0.01, 40);

  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setClearColor(0x04060d, 1);
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute(
    'aria-label',
    'Globe. Arrow keys rotate it. Enter picks the point at the centre.',
  );
  view.appendChild(canvas);

  const textures: Texture[] = [];
  const placeholderDay = blackTexture();
  const placeholderNight = blackTexture();
  textures.push(placeholderDay, placeholderNight);

  const sunDir = new Vector3(1, 0, 0);
  const material = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uDay: { value: placeholderDay },
      uNight: { value: placeholderNight },
      uSun: { value: sunDir },
    },
  });
  const geometry = new SphereGeometry(1, 96, 64);
  const globe = new Mesh(geometry, material);
  scene.add(globe);

  let disposed = false;
  const loader = new TextureLoader();
  const small = window.innerWidth < 700 || window.innerWidth * (window.devicePixelRatio || 1) < 1100;
  const base = import.meta.env.BASE_URL;
  const loadInto = (file: string, uniform: 'uDay' | 'uNight') => {
    loader.load(
      base + 'textures/' + file,
      (tex) => {
        if (disposed) {
          tex.dispose();
          return;
        }
        tex.colorSpace = SRGBColorSpace;
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        textures.push(tex);
        material.uniforms[uniform]!.value = tex;
      },
      undefined,
      () => undefined,
    );
  };
  loadInto(small ? 'earth-2k.jpg' : 'earth-4k.jpg', 'uDay');
  loadInto('earth-night-2k.jpg', 'uNight');

  let sunStamp = 0;
  const updateSun = (now: number) => {
    if (now - sunStamp < 60000 && sunStamp !== 0) return;
    sunStamp = now;
    const sp = subsolarPoint(new Date());
    latLonToVec(sp.lat, sp.lon, sunDir);
  };
  updateSun(Date.now());

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 1.35;
  controls.maxDistance = 8;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.5;

  const stopIdle = () => {
    controls.autoRotate = false;
  };
  controls.addEventListener('start', stopIdle);

  const fitDist = () => {
    const t = 0.88 * Math.tan((camera.fov * Math.PI) / 360) * Math.min(1, camera.aspect);
    return Math.min(7.5, Math.max(3.1, Math.sqrt(1 + 1 / (t * t))));
  };

  const setCameraTo = (lat: number, lon: number, dist: number) => {
    camera.position.copy(latLonToVec(lat, lon)).multiplyScalar(dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
  };

  const wantLat = Number.parseFloat(ctx.params.lat ?? '');
  const wantLon = Number.parseFloat(ctx.params.lon ?? '');
  const hasParams = Number.isFinite(wantLat) && Number.isFinite(wantLon);

  // ----- overlay -----
  const intro = el('p', 'globe-intro', INTRO);
  const marker = el('div', 'globe-marker');
  marker.hidden = true;
  marker.setAttribute('aria-hidden', 'true');
  const panel = el('div', 'globe-panel');
  panel.hidden = true;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Selected place');
  const near = el('p', 'globe-near');
  const subline = el('p', 'globe-sub');
  const coords = el('p', 'globe-coords');
  const lookBtn = el('button', 'globe-btn globe-btn-primary', 'Look up from here');
  lookBtn.type = 'button';
  const msg = el('p', 'globe-msg');
  msg.hidden = true;
  msg.setAttribute('role', 'status');
  const selected = el('div');
  selected.hidden = true;
  selected.append(near, subline, coords, lookBtn);
  panel.append(selected, msg);
  const locateBtn = el('button', 'globe-btn globe-btn-locate', 'Use my location');
  locateBtn.type = 'button';
  const veil = el('div', 'globe-veil');
  view.append(intro, marker, panel, locateBtn, veil);

  // ----- selection -----
  let sel: { lat: number; lon: number } | null = null;
  const selDir = new Vector3();

  const refreshPanel = () => {
    panel.hidden = flight !== null || (!sel && msg.hidden);
  };

  const select = (lat: number, lon: number) => {
    sel = { lat, lon };
    latLonToVec(lat, lon, selDir);
    const { place, km } = nearestPlace(lat, lon);
    const far = km > 600;
    near.textContent = far ? formatLatLon(lat, lon) : 'Near ' + place.name;
    subline.textContent = far
      ? 'Nearest listed place: ' + place.name + ', ' + Math.round(km).toLocaleString('en-US') + ' km'
      : km > 50
        ? place.country + ', ' + Math.round(km).toLocaleString('en-US') + ' km away'
        : place.country;
    coords.textContent = formatLatLon(lat, lon);
    coords.hidden = far;
    selected.hidden = false;
    msg.hidden = true;
    msg.textContent = '';
    refreshPanel();
  };

  const showMessage = (text: string) => {
    msg.textContent = text;
    msg.hidden = false;
    refreshPanel();
  };

  // ----- centring tween (orbit state) -----
  let tween: { t0: number; from: Vector3; to: Vector3; d0: number; d1: number; ms: number } | null = null;
  const centreOn = (lat: number, lon: number, instant: boolean) => {
    const to = latLonToVec(lat, lon);
    const d1 = Math.min(Math.max(camera.position.length(), 1.8), fitDist());
    if (instant || prefersReducedMotion()) {
      tween = null;
      setCameraTo(lat, lon, d1);
      controls.update();
      return;
    }
    tween = {
      t0: performance.now(),
      from: camera.position.clone().normalize(),
      to,
      d0: camera.position.length(),
      d1,
      ms: 900,
    };
    controls.enabled = false;
  };

  // ----- picking -----
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const pickAt = (nx: number, ny: number): boolean => {
    ndc.set(nx, ny);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(globe, false)[0];
    if (!hit) return false;
    const ll = vecToLatLon(hit.point);
    select(ll.lat, ll.lon);
    return true;
  };

  let down: { x: number; y: number } | null = null;
  let ignoreUp = false;
  const onPointerDown = (e: PointerEvent) => {
    stopIdle();
    if (flight) {
      cancelFlight(false);
      ignoreUp = true;
      return;
    }
    tween = null;
    controls.enabled = true;
    down = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent) => {
    if (ignoreUp) {
      ignoreUp = false;
      down = null;
      return;
    }
    if (!down || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > TAP_SLOP) return;
    const r = canvas.getBoundingClientRect();
    pickAt(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);

  const onWheel = () => {
    stopIdle();
    if (flight) cancelFlight(false);
  };
  canvas.addEventListener('wheel', onWheel, { passive: true });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && flight) {
      cancelFlight(true);
      return;
    }
    if (e.target !== canvas || flight) return;
    const step = 0.08 * Math.min(1, Math.max(0.15, (camera.position.length() - 1) / 2));
    const yAxis = new Vector3(0, 1, 0);
    let handled = true;
    if (e.key === 'ArrowLeft') camera.position.applyAxisAngle(yAxis, step);
    else if (e.key === 'ArrowRight') camera.position.applyAxisAngle(yAxis, -step);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const p = camera.position;
      const lat = Math.asin(p.y / p.length());
      const next = Math.max(-1.45, Math.min(1.45, lat + dir * step));
      const axis = new Vector3().crossVectors(yAxis, p).normalize();
      if (axis.lengthSq() > 0) p.applyAxisAngle(axis, lat - next);
    } else if (e.key === 'Enter') {
      pickAt(0, 0);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      stopIdle();
    }
  };
  document.addEventListener('keydown', onKeyDown);

  // ----- fly-in -----
  interface Flight {
    t0: number;
    dir0: Vector3;
    dirP: Vector3;
    d0: number;
    qStart: Quaternion;
    qStand: Quaternion;
    lat: number;
    lon: number;
    dirNow: Vector3;
    dist: number;
  }
  let flight: Flight | null = null;

  const startFlight = () => {
    if (!sel || flight) return;
    const { lat, lon } = sel;
    if (prefersReducedMotion()) {
      ctx.go('sky', { lat: lat.toFixed(4), lon: lon.toFixed(4), from: 'globe', az: '0' });
      return;
    }
    const { up, north } = localBasis(lat, lon);
    const f = north.clone().multiplyScalar(Math.cos(STAND_PITCH)).addScaledVector(up, Math.sin(STAND_PITCH));
    const camUp = up.clone().multiplyScalar(Math.cos(STAND_PITCH)).addScaledVector(north, -Math.sin(STAND_PITCH));
    const right = new Vector3().crossVectors(f, camUp);
    const qStand = new Quaternion().setFromRotationMatrix(
      new Matrix4().makeBasis(right, camUp, f.clone().negate()),
    );
    stopIdle();
    tween = null;
    controls.enabled = false;
    flight = {
      t0: performance.now(),
      dir0: camera.position.clone().normalize(),
      dirP: up.clone(),
      d0: camera.position.length(),
      qStart: camera.quaternion.clone(),
      qStand,
      lat,
      lon,
      dirNow: camera.position.clone().normalize(),
      dist: camera.position.length(),
    };
    panel.hidden = true;
    marker.hidden = true;
    view.classList.add('is-flying');
    canvas.focus({ preventScroll: true });
  };

  const cancelFlight = (focusButton: boolean) => {
    if (!flight) return;
    const f = flight;
    flight = null;
    view.classList.remove('is-flying');
    veil.style.opacity = '0';
    const dist = Math.max(f.dist, 1.8);
    camera.position.copy(f.dirNow).multiplyScalar(dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.near = 0.01;
    camera.updateProjectionMatrix();
    controls.enabled = true;
    controls.update();
    refreshPanel();
    if (focusButton) lookBtn.focus();
  };

  const tmpQ = new Quaternion();
  const tmpLook = new Quaternion();
  const tmpV = new Vector3();
  const stepFlight = (now: number) => {
    const f = flight!;
    const dt = now - f.t0;
    const a = ease3(dt / FLIGHT_MS);
    slerpDir(f.dir0, f.dirP, sub(a, 0, 0.7), f.dirNow);
    f.dist = STAND_DIST + (f.d0 - STAND_DIST) * Math.pow(1 - a, 2);
    camera.position.copy(f.dirNow).multiplyScalar(f.dist);
    lookQuat(camera.position, tmpLook);
    tmpQ.copy(f.qStart).slerp(tmpLook, sub(a, 0, 0.4));
    tmpQ.slerp(f.qStand, sub(a, 0.5, 1));
    camera.quaternion.copy(tmpQ);
    camera.near = Math.max(0.0005, (f.dist - 1) * 0.4);
    camera.updateProjectionMatrix();
    const v = clamp01((dt - FLIGHT_MS) / VEIL_MS);
    veil.style.opacity = String(v);
    if (dt >= FLIGHT_MS + VEIL_MS) {
      camera.getWorldDirection(tmpV);
      const { east, north } = localBasis(f.lat, f.lon);
      let az = (Math.atan2(tmpV.dot(east), tmpV.dot(north)) * 180) / Math.PI;
      az = ((az % 360) + 360) % 360;
      const lat = f.lat;
      const lon = f.lon;
      flight = null;
      ctx.go('sky', {
        lat: lat.toFixed(4),
        lon: lon.toFixed(4),
        from: 'globe',
        az: String(Math.round(az) % 360),
      });
    }
  };

  lookBtn.addEventListener('click', startFlight);

  // ----- geolocation -----
  let locating = false;
  const onLocate = () => {
    if (locating || flight) return;
    if (!('geolocation' in navigator)) {
      showMessage('Location not shared. Pick a place on the globe instead.');
      return;
    }
    locating = true;
    locateBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locating = false;
        if (disposed) return;
        locateBtn.disabled = false;
        stopIdle();
        select(pos.coords.latitude, pos.coords.longitude);
        centreOn(pos.coords.latitude, pos.coords.longitude, false);
      },
      () => {
        locating = false;
        if (disposed) return;
        locateBtn.disabled = false;
        showMessage('Location not shared. Pick a place on the globe instead.');
      },
      { timeout: 10000, maximumAge: 600000 },
    );
  };
  locateBtn.addEventListener('click', onLocate);

  // ----- sizing -----
  const resize = () => {
    const w = Math.max(1, view.clientWidth);
    const h = Math.max(1, view.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(view);
  window.addEventListener('resize', resize);
  resize();

  // ----- initial state -----
  if (hasParams) {
    controls.autoRotate = false;
    setCameraTo(wantLat, wantLon, Math.min(2.6, fitDist()));
    select(wantLat, wantLon);
  } else {
    const sp = subsolarPoint(new Date());
    setCameraTo(20, sp.lon, fitDist());
    if (prefersReducedMotion()) controls.autoRotate = false;
  }
  controls.update();

  const ndcV = new Vector3();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    if (flight) {
      stepFlight(now);
    } else {
      if (tween) {
        const k = ease3((now - tween.t0) / tween.ms);
        slerpDir(tween.from, tween.to, k, tmpV);
        camera.position.copy(tmpV).multiplyScalar(tween.d0 + (tween.d1 - tween.d0) * k);
        camera.up.set(0, 1, 0);
        camera.lookAt(0, 0, 0);
        if (now - tween.t0 >= tween.ms) {
          tween = null;
          controls.enabled = true;
        }
      }
      const dist = camera.position.length();
      controls.rotateSpeed = Math.min(1, Math.max(0.2, (dist - 1) / 1.6));
      camera.near = Math.max(0.01, (dist - 1) * 0.4);
      camera.updateProjectionMatrix();
      if (!tween) controls.update();
    }
    updateSun(Date.now());

    if (sel && !flight) {
      const facing = selDir.dot(camera.position) > 1.0;
      marker.hidden = !facing;
      if (facing) {
        ndcV.copy(selDir).project(camera);
        const w = view.clientWidth;
        const h = view.clientHeight;
        marker.style.transform =
          'translate(' + ((ndcV.x * 0.5 + 0.5) * w).toFixed(1) + 'px,' + ((-ndcV.y * 0.5 + 0.5) * h).toFixed(1) + 'px)';
      }
    }
    renderer.render(scene, camera);
  });

  return () => {
    disposed = true;
    flight = null;
    renderer.setAnimationLoop(null);
    observer.disconnect();
    window.removeEventListener('resize', resize);
    document.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    lookBtn.removeEventListener('click', startFlight);
    locateBtn.removeEventListener('click', onLocate);
    controls.removeEventListener('start', stopIdle);
    controls.dispose();
    geometry.dispose();
    material.dispose();
    for (const t of textures) t.dispose();
    renderer.dispose();
    view.remove();
  };
};
