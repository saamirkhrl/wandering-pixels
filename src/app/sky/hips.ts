import {
  BufferAttribute,
  BufferGeometry,
  FrontSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { prefersReducedMotion } from '../motion';
import { buildTilePatch, cellBounds } from './healpix';

export const HIPS_BASE = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';

export interface HipsFrame {
  index: number; // cube depth index; 0 is the unsuffixed tile
  um: number; // wavelength in micrometres
}

// Measured 2026-11-14 by HEAD requests on Norder3/Dir0/Npix100 (and Norder5/Dir0/Npix5000):
// the unsuffixed tile (index 0) and suffixes _1.._49, _52.._101 exist; _0, _50, _51 and _102
// return 404. Wavelengths are data_cube_crval3_arr from the HiPS properties file.
// prettier-ignore
const CUBE_UM = [
  0.753, 0.771, 0.790, 0.809, 0.828, 0.848, 0.868, 0.889, 0.910, 0.932, 0.955, 0.978, 1.001, 1.025,
  1.050, 1.075, 1.102, 1.113, 1.139, 1.167, 1.195, 1.224, 1.254, 1.284, 1.315, 1.346, 1.378, 1.412,
  1.446, 1.481, 1.517, 1.554, 1.592, 1.631, 1.656, 1.695, 1.735, 1.775, 1.818, 1.861, 1.905, 1.949,
  1.995, 2.041, 2.089, 2.139, 2.189, 2.240, 2.292, 2.345, 2.399, 2.445, 2.506, 2.575, 2.646, 2.719,
  2.794, 2.871, 2.951, 3.033, 3.118, 3.204, 3.293, 3.383, 3.476, 3.570, 3.667, 3.768, 3.833, 3.867,
  3.901, 3.935, 3.970, 4.005, 4.040, 4.076, 4.112, 4.148, 4.184, 4.220, 4.257, 4.294, 4.331, 4.368,
  4.405, 4.435, 4.467, 4.500, 4.533, 4.566, 4.600, 4.635, 4.669, 4.704, 4.739, 4.773, 4.808, 4.843,
  4.879, 4.915, 4.951, 4.988,
];
const MISSING_FRAMES = new Set([50, 51]);
const isFrame = (i: number) => Number.isInteger(i) && i >= 0 && i < CUBE_UM.length && !MISSING_FRAMES.has(i);

export const HIPS_FRAMES: HipsFrame[] = CUBE_UM.map((um, index) => ({ index, um })).filter(
  (f) => !MISSING_FRAMES.has(f.index),
);

// Radius of the tile sphere in the EQJ group's units. Tiles are transparent-pass meshes with
// renderOrder far below 0, depthTest on and depthWrite off: they draw before every other
// transparent object, never hide anything, and are hidden by opaque meshes nearer than the
// radius (the ground). The camera far plane must exceed the radius.
export const HIPS_RADIUS = 10;

export interface HipsLayer {
  // Tile meshes in the EQJ frame (sphere of radius HIPS_RADIUS, drawn as a background). The sky
  // view adds this to a group whose matrix is eqjToWorld(...).
  object: Group;
  // Call once per frame before render. Picks the order from field of view and viewport height,
  // culls, loads and evicts tiles. Pass the drawing-buffer height in device pixels.
  update(camera: PerspectiveCamera, viewportHeightPx: number): void;
  // Indices not in HIPS_FRAMES are ignored (they have no tiles).
  setFrame(index: number): void;
  readonly frame: number;
  // HiPS order (512 px tiles, 0..5) of the level drawn where the camera looks.
  readonly order: number;
  // True while any tile needed for the current view at the current level is still pending.
  readonly loading: boolean;
  // True when the host has failed for the current view: most needed tiles errored (network or
  // HTTP error other than 404), including the order-0 base tiles.
  readonly failed: boolean;
  dispose(): void;
}

const MAX_ORDER = 5;
const MAX_TEXTURES = 250;
const MAX_REQUESTS = 8;
const MAX_UPLOADS_PER_UPDATE = 4;
const RETRY_MS = 15000;
const FADE_MS = 250;
const SEGMENTS = [32, 16, 16, 12, 8, 8];
// Angular size of one pixel of an order-0 tile (an order-9 HEALPix cell), radians.
const ORDER0_PIXEL = Math.sqrt((4 * Math.PI) / (12 * 4 ** 9));
// Draw order: order-0 base, then coarser fallbacks, then the shown level, then the fading level.
const RO_BASE = -1000;
const RO_SHOWN = -900;
const RO_FADE = -800;

function tileUrl(order: number, pix: number, frame: number): string {
  const dir = Math.floor(pix / 10000) * 10000;
  return `${HIPS_BASE}/Norder${order}/Dir${dir}/Npix${pix}${frame ? `_${frame}` : ''}.png`;
}

const tileKey = (frame: number, order: number, pix: number) => `${frame}/${order}/${pix}`;

interface Level {
  frame: number;
  order: number;
}

const sameLevel = (a: Level, b: Level) => a.frame === b.frame && a.order === b.order;

interface TileEntry {
  key: string;
  order: number;
  mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  bitmap: ImageBitmap;
  lastUsed: number;
}

interface Pending {
  frame: number;
  order: number;
  pix: number;
  bitmap: ImageBitmap;
}

interface Cell {
  pix: number;
  dist: number;
}

function makeTexture(bitmap: ImageBitmap, anisotropy: number): Texture {
  const tex = new Texture(bitmap);
  tex.flipY = false; // uvs use v = row fraction from the top (see buildTilePatch)
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter; // tiles are 512 x 512, so mipmaps always build
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function makeGeometry(p: { positions: Float32Array; uvs: Float32Array; indices: Uint32Array }): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(p.positions, 3));
  g.setAttribute('uv', new BufferAttribute(p.uvs, 2));
  g.setIndex(new BufferAttribute(p.indices, 1));
  g.computeBoundingSphere();
  return g;
}

function disposeMesh(mesh: Mesh<BufferGeometry, MeshBasicMaterial>): void {
  mesh.removeFromParent();
  mesh.geometry.dispose();
  mesh.material.map?.dispose();
  mesh.material.dispose();
}

async function loadBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap | 'missing'> {
  const res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
  if (res.status === 404) return 'missing';
  if (!res.ok) throw new Error(String(res.status));
  const blob = await res.blob();
  return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

export function createHipsLayer(renderer: WebGLRenderer, initialFrame = 0): HipsLayer {
  const object = new Group();
  object.name = 'spherex-hips';
  const anisotropy = renderer.capabilities.getMaxAnisotropy();

  let frame = isFrame(initialFrame) ? initialFrame : HIPS_FRAMES[0].index;
  let shownOrder = 0;
  let isLoading = true;
  let isFailed = false;
  let orderLevel = -1; // hysteresis state for the target order
  let tick = 0;
  let disposed = false;

  // `shown` is the last level that covered the view completely; it stays on screen until the
  // target level (current frame, order for this fov) is complete too, which then fades in on top.
  let shown: Level | null = null;
  let fade: { level: Level; start: number } | null = null;

  const tiles = new Map<string, TileEntry>();
  const missing = new Set<string>(); // 404: never retried
  const failed = new Map<string, number>(); // network or HTTP error: retried after RETRY_MS
  const inflight = new Map<string, AbortController>();
  const pending: Pending[] = [];
  const bounds = new Map<number, { cx: number; cy: number; cz: number; radius: number }>();

  const view = new Vector3();
  const inv = new Matrix4();

  function boundsOf(order: number, pix: number) {
    const k = order * 1e6 + pix;
    let b = bounds.get(k);
    if (!b) {
      b = cellBounds(order, pix);
      bounds.set(k, b);
    }
    return b;
  }

  function addTile(p: Pending): void {
    const key = tileKey(p.frame, p.order, p.pix);
    if (tiles.has(key)) {
      p.bitmap.close();
      return;
    }
    const geom = makeGeometry(buildTilePatch(p.order, p.pix, SEGMENTS[p.order], HIPS_RADIUS));
    const mat = new MeshBasicMaterial({
      map: makeTexture(p.bitmap, anisotropy),
      side: FrontSide,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new Mesh(geom, mat);
    mesh.visible = false;
    mesh.name = `hips-${key}`;
    object.add(mesh);
    tiles.set(key, { key, order: p.order, mesh, bitmap: p.bitmap, lastUsed: tick });
  }

  function evict(): void {
    if (tiles.size <= MAX_TEXTURES) return;
    const old = [...tiles.values()].filter((t) => t.lastUsed < tick).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of old) {
      if (tiles.size <= MAX_TEXTURES) break;
      disposeMesh(t.mesh);
      t.bitmap.close();
      tiles.delete(t.key);
    }
  }

  function startRequest(f: number, order: number, pix: number): void {
    const key = tileKey(f, order, pix);
    const ctrl = new AbortController();
    inflight.set(key, ctrl);
    loadBitmap(tileUrl(order, pix, f), ctrl.signal).then(
      (bmp) => {
        if (inflight.get(key) === ctrl) inflight.delete(key);
        failed.delete(key);
        if (bmp === 'missing') {
          missing.add(key);
          return;
        }
        if (ctrl.signal.aborted || disposed) {
          bmp.close();
          return;
        }
        pending.push({ frame: f, order, pix, bitmap: bmp });
      },
      () => {
        if (inflight.get(key) === ctrl) inflight.delete(key);
        if (!ctrl.signal.aborted) failed.set(key, performance.now());
      },
    );
  }

  // Visible cells at `order`: descend from the 12 base cells, keeping those whose bounding cone
  // meets the view cone, sorted by angular distance from the view centre.
  function visibleCells(order: number, dir: Vector3, halfAngle: number): Cell[] {
    const out: Cell[] = [];
    const visit = (o: number, pix: number) => {
      const b = boundsOf(o, pix);
      const dot = Math.max(-1, Math.min(1, b.cx * dir.x + b.cy * dir.y + b.cz * dir.z));
      const dist = Math.acos(dot);
      if (dist > halfAngle + b.radius) return;
      if (o === order) {
        out.push({ pix, dist });
        return;
      }
      for (let c = 0; c < 4; c++) visit(o + 1, pix * 4 + c);
    };
    for (let f = 0; f < 12; f++) visit(0, f);
    return out.sort((a, b) => a.dist - b.dist);
  }

  // Order for the view, with hysteresis. Tile pixels are kept at or below one screen pixel at the
  // top and bottom edges of the view, where the perspective projection magnifies the sky radially
  // by 1 / cos^2(fov / 2), so towards the centre they are slightly minified (mipmaps). Coarser
  // choices show every HEALPix pixel as a shape on screen: near the polar-cap face edges those
  // cells are up to 2.4 : 1 elongated, which read as streaks across the noise floor.
  function targetOrder(fovDeg: number, heightPx: number): number {
    const half = (fovDeg * Math.PI) / 360;
    const centrePixel = (2 * Math.tan(half)) / Math.max(1, heightPx);
    const edgePixel = centrePixel * Math.cos(half) ** 2;
    const ideal = Math.log2(ORDER0_PIXEL / edgePixel) - 0.1;
    if (orderLevel < 0 || ideal < orderLevel - 1.15 || ideal > orderLevel + 0.15) orderLevel = Math.max(0, Math.ceil(ideal));
    return Math.min(MAX_ORDER, orderLevel);
  }

  function show(t: TileEntry, renderOrder: number, opacity: number): void {
    t.mesh.visible = true;
    t.mesh.renderOrder = renderOrder;
    t.mesh.material.opacity = opacity;
    t.lastUsed = tick;
  }

  return {
    object,
    update(camera: PerspectiveCamera, viewportHeightPx: number) {
      if (disposed) return;
      tick++;
      const now = performance.now();
      for (let i = 0; i < MAX_UPLOADS_PER_UPDATE && pending.length; i++) addTile(pending.shift() as Pending);

      // View direction and cone in the EQJ frame of `object`.
      object.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();
      camera.getWorldDirection(view);
      inv.copy(object.matrixWorld).invert();
      view.transformDirection(inv);
      const halfV = (camera.fov * Math.PI) / 360;
      const halfAngle = Math.min(Math.PI, Math.atan(Math.tan(halfV) * Math.sqrt(1 + camera.aspect * camera.aspect)) + 0.02);

      // Zooming in more than one order refines one order at a time (each step is a few tiles, so
      // the view sharpens progressively instead of staying blurred until the deepest level loads).
      const wantOrder = targetOrder(camera.fov, viewportHeightPx);
      const stepOrder = shown && shown.frame === frame && wantOrder > shown.order + 1 ? shown.order + 1 : wantOrder;
      const target: Level = { frame, order: stepOrder };
      const cellsT = visibleCells(target.order, view, halfAngle);
      const cells0 = target.order === 0 ? cellsT : visibleCells(0, view, halfAngle);

      // Requests: order-0 base first (cheap, and the fallback under everything), then the
      // target level nearest the view centre first.
      const wanted = new Set<string>();
      const queue: { order: number; pix: number }[] = [];
      const need = (order: number, pix: number): 'ok' | 'pending' | 'failed' => {
        const key = tileKey(frame, order, pix);
        if (tiles.has(key) || missing.has(key)) return 'ok';
        wanted.add(key);
        const failedAt = failed.get(key);
        if (!inflight.has(key) && (failedAt === undefined || now - failedAt > RETRY_MS)) queue.push({ order, pix });
        return failedAt === undefined ? 'pending' : 'failed';
      };
      let baseFailed = 0;
      for (const c of cells0) if (need(0, c.pix) === 'failed') baseFailed++;
      let complete = true;
      let targetFailed = 0;
      for (const c of cellsT) {
        const st = need(target.order, c.pix);
        if (st !== 'ok') complete = false;
        if (st === 'failed') targetFailed++;
      }
      isLoading = !complete || stepOrder !== wantOrder;
      isFailed = targetFailed * 2 >= cellsT.length && targetFailed > 0 && baseFailed * 2 >= cells0.length;

      // Level switching: never mix two complete levels for long; cross-fade the new one in.
      if (fade && !sameLevel(fade.level, target)) {
        if (shown && !sameLevel(shown, target)) shown = fade.level;
        fade = null;
      }
      if (complete && (!shown || !sameLevel(shown, target)) && !fade) {
        if (!shown || prefersReducedMotion()) shown = target;
        else fade = { level: target, start: now };
      }
      let fadeOpacity = 0;
      if (fade) {
        fadeOpacity = Math.min(1, (now - fade.start) / FADE_MS);
        if (fadeOpacity >= 1) {
          shown = fade.level;
          fade = null;
        }
      }

      for (const t of tiles.values()) t.mesh.visible = false;

      // Base: order-0 tiles of the current frame, else of the shown frame.
      for (const c of cells0) {
        const t = tiles.get(tileKey(frame, 0, c.pix)) ?? (shown ? tiles.get(tileKey(shown.frame, 0, c.pix)) : undefined);
        if (t) show(t, RO_BASE, 1);
      }

      // Shown level; cells that panned in and are not loaded yet show their nearest ancestor.
      let centreOrder = 0;
      if (shown) {
        const lv = shown;
        const cellsS = lv.order === target.order ? cellsT : visibleCells(lv.order, view, halfAngle);
        cellsS.forEach((c, i) => {
          let t = tiles.get(tileKey(lv.frame, lv.order, c.pix));
          if (t) show(t, RO_SHOWN, 1);
          else
            for (let o = lv.order - 1, p = c.pix >> 2; o >= 1 && !t; o--, p >>= 2) {
              t = tiles.get(tileKey(lv.frame, o, p)) ?? tiles.get(tileKey(frame, o, p));
              if (t) show(t, RO_BASE + o, 1);
            }
          if (i === 0) centreOrder = t ? t.order : 0;
        });
      }
      if (fade) {
        for (const c of cellsT) {
          const t = tiles.get(tileKey(fade.level.frame, fade.level.order, c.pix));
          if (t) show(t, RO_FADE, fadeOpacity);
        }
      }
      shownOrder = centreOrder;

      // Drop requests for tiles that left the view or belong to another frame or order.
      for (const [key, ctrl] of inflight) {
        if (!wanted.has(key)) {
          ctrl.abort();
          inflight.delete(key);
        }
      }
      for (const q of queue) {
        if (inflight.size >= MAX_REQUESTS) break;
        startRequest(frame, q.order, q.pix);
      }
      evict();
    },
    setFrame(index: number) {
      if (disposed || index === frame || !isFrame(index)) return;
      // The shown level (old frame) stays until the new frame covers the view, then fades in.
      frame = index;
    },
    get frame() {
      return frame;
    },
    get order() {
      return shownOrder;
    },
    get loading() {
      return isLoading;
    },
    get failed() {
      return isFailed;
    },
    dispose() {
      disposed = true;
      for (const ctrl of inflight.values()) ctrl.abort();
      inflight.clear();
      for (const p of pending) p.bitmap.close();
      pending.length = 0;
      for (const t of tiles.values()) {
        disposeMesh(t.mesh);
        t.bitmap.close();
      }
      tiles.clear();
      missing.clear();
      failed.clear();
      bounds.clear();
    },
  };
}
