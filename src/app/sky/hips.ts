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

// Radius of the tile sphere in the EQJ group's units. The tiles are drawn first (renderOrder
// below 0) with depthTest and depthWrite off, so they act as a background whatever the radius;
// the camera far plane must exceed it (and near must be below it).
export const HIPS_RADIUS = 10;

export interface HipsLayer {
  // Tile meshes in the EQJ frame (sphere of radius HIPS_RADIUS, drawn as a background). The sky
  // view adds this to a group whose matrix is eqjToWorld(...).
  object: Group;
  // Call once per frame before render. Picks the order from field of view and viewport height,
  // culls, loads and evicts tiles. Pass the drawing-buffer height in device pixels for 1:1 tiles.
  update(camera: PerspectiveCamera, viewportHeightPx: number): void;
  // Indices not in HIPS_FRAMES are ignored (they have no tiles).
  setFrame(index: number): void;
  readonly frame: number;
  // Order of the tile drawn where the camera looks, in HiPS orders (512 px tiles): 0 when only the
  // Norder3 Allsky preview (64 px per order-3 tile, the same pixel scale as order 0) is drawn.
  readonly order: number;
  dispose(): void;
}

const MAX_ORDER = 5;
const MIN_TILE_ORDER = 1; // below this the Allsky preview has the same resolution
const ALLSKY_ORDER = 3;
const ALLSKY_TILE = 64;
const ALLSKY_COLS = 27;
const MAX_TEXTURES = 250;
const MAX_REQUESTS = 8;
const MAX_UPLOADS_PER_UPDATE = 4;
const RETRY_MS = 15000;
const SEGMENTS = [16, 16, 16, 12, 8, 8];
// Angular size of one pixel of an order-0 tile (an order-9 HEALPix cell), radians.
const ORDER0_PIXEL = Math.sqrt((4 * Math.PI) / (12 * 4 ** 9));
const RENDER_ORDER_BASE = -1000;

function tileUrl(order: number, pix: number, frame: number): string {
  const dir = Math.floor(pix / 10000) * 10000;
  return `${HIPS_BASE}/Norder${order}/Dir${dir}/Npix${pix}${frame ? `_${frame}` : ''}.png`;
}

function allskyUrl(frame: number): string {
  return `${HIPS_BASE}/Norder${ALLSKY_ORDER}/Allsky${frame ? `_${frame}` : ''}.png`;
}

const tileKey = (frame: number, order: number, pix: number) => `${frame}/${order}/${pix}`;

interface TileEntry {
  key: string;
  order: number;
  mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  bitmap: ImageBitmap;
  lastUsed: number;
}

interface AllskyEntry {
  frame: number;
  mesh: Mesh<BufferGeometry, MeshBasicMaterial> | null;
  bitmap: ImageBitmap | null;
}

interface Pending {
  frame: number;
  order: number;
  pix: number;
  bitmap: ImageBitmap;
}

function makeTexture(bitmap: ImageBitmap, anisotropy: number, mipmaps: boolean): Texture {
  const tex = new Texture(bitmap);
  tex.flipY = false; // uvs use v = row fraction from the top (see buildTilePatch)
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = LinearFilter;
  tex.minFilter = mipmaps ? LinearMipmapLinearFilter : LinearFilter;
  tex.generateMipmaps = mipmaps;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function makeMaterial(map: Texture): MeshBasicMaterial {
  return new MeshBasicMaterial({ map, side: FrontSide, depthTest: false, depthWrite: false, toneMapped: false });
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
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  let frame = isFrame(initialFrame) ? initialFrame : HIPS_FRAMES[0].index;
  let shownOrder = 0;
  let orderLevel = -1; // hysteresis state for the target order
  let tick = 0;
  let disposed = false;

  const tiles = new Map<string, TileEntry>();
  const missing = new Set<string>(); // 404: never retried
  const failed = new Map<string, number>(); // network or decode error: retried after RETRY_MS
  const inflight = new Map<string, AbortController>();
  const pending: Pending[] = [];
  const bounds = new Map<number, { cx: number; cy: number; cz: number; radius: number }>();

  // Allsky previews: `allsky` is the current frame's, `allskyPrev` stays drawn until it loads.
  let allsky: AllskyEntry = { frame, mesh: null, bitmap: null };
  let allskyPrev: AllskyEntry | null = null;
  let allskyController: AbortController | null = null;
  let allskyMissing = false;
  let allskyFailedAt = -Infinity;

  // Frame whose tiles are used as fallback while the current frame's tiles load: the frame that
  // last covered the view completely.
  let prevFrame = frame;
  let frameComplete = false;

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

  function allskyGeometry(): BufferGeometry {
    const n = 12 * 4 ** ALLSKY_ORDER;
    const rows = Math.ceil(n / ALLSKY_COLS);
    const w = ALLSKY_COLS * ALLSKY_TILE;
    const h = rows * ALLSKY_TILE;
    const segs = 4;
    const per = (segs + 1) * (segs + 1);
    const positions = new Float32Array(n * per * 3);
    const uvs = new Float32Array(n * per * 2);
    const indices = new Uint32Array(n * segs * segs * 6);
    for (let pix = 0; pix < n; pix++) {
      // Sub-image of tile `pix`: column pix % 27, row floor(pix / 27), same layout as a tile.
      // Inset by half a texel so linear filtering does not bleed into the neighbour.
      const c0 = (pix % ALLSKY_COLS) * ALLSKY_TILE;
      const r0 = Math.floor(pix / ALLSKY_COLS) * ALLSKY_TILE;
      const p = buildTilePatch(ALLSKY_ORDER, pix, segs, HIPS_RADIUS, (a, b) => [
        (c0 + 0.5 + a * (ALLSKY_TILE - 1)) / w,
        (r0 + 0.5 + b * (ALLSKY_TILE - 1)) / h,
      ]);
      positions.set(p.positions, pix * per * 3);
      uvs.set(p.uvs, pix * per * 2);
      for (let i = 0; i < p.indices.length; i++) indices[pix * p.indices.length + i] = p.indices[i] + pix * per;
    }
    return makeGeometry({ positions, uvs, indices });
  }

  function disposeAllsky(e: AllskyEntry | null): void {
    if (!e) return;
    if (e.mesh) disposeMesh(e.mesh);
    e.bitmap?.close();
    e.mesh = null;
    e.bitmap = null;
  }

  function requestAllsky(): void {
    allskyController?.abort();
    allskyMissing = false;
    const target = frame;
    const ctrl = new AbortController();
    allskyController = ctrl;
    loadBitmap(allskyUrl(target), ctrl.signal).then(
      (bmp) => {
        if (ctrl.signal.aborted || disposed || target !== frame) {
          if (bmp !== 'missing') bmp.close();
          return;
        }
        allskyController = null;
        if (bmp === 'missing') {
          allskyMissing = true;
          return;
        }
        const mesh = new Mesh(allskyGeometry(), makeMaterial(makeTexture(bmp, anisotropy, false)));
        mesh.renderOrder = RENDER_ORDER_BASE;
        mesh.frustumCulled = false;
        mesh.name = `allsky-${target}`;
        object.add(mesh);
        disposeAllsky(allsky.frame === target ? allsky : null);
        allsky = { frame: target, mesh, bitmap: bmp };
        disposeAllsky(allskyPrev);
        allskyPrev = null;
      },
      () => {
        if (allskyController !== ctrl) return;
        allskyController = null;
        allskyFailedAt = performance.now();
      },
    );
  }

  function addTile(p: Pending): void {
    const key = tileKey(p.frame, p.order, p.pix);
    if (tiles.has(key)) {
      p.bitmap.close();
      return;
    }
    const geom = makeGeometry(buildTilePatch(p.order, p.pix, SEGMENTS[p.order], HIPS_RADIUS));
    const mesh = new Mesh(geom, makeMaterial(makeTexture(p.bitmap, anisotropy, true)));
    mesh.renderOrder = RENDER_ORDER_BASE + 10 * p.order;
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
  // meets the view cone. Returned with their angular distance from the view centre.
  function visibleCells(order: number, dir: Vector3, halfAngle: number): { pix: number; dist: number }[] {
    const out: { pix: number; dist: number }[] = [];
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
    return out;
  }

  function findLoaded(order: number, pix: number): TileEntry | null {
    const frames = prevFrame !== frame ? [frame, prevFrame] : [frame];
    for (const f of frames) {
      const t = tiles.get(tileKey(f, order, pix));
      if (t) return t;
    }
    for (let o = order - 1, p = pix >> 2; o >= MIN_TILE_ORDER; o--, p >>= 2) {
      for (const f of frames) {
        const t = tiles.get(tileKey(f, o, p));
        if (t) return t;
      }
    }
    return null;
  }

  function targetOrder(fovDeg: number, heightPx: number): number {
    const screenPixel = (fovDeg * Math.PI) / 180 / Math.max(1, heightPx);
    const level = Math.log2(ORDER0_PIXEL / screenPixel);
    // Hysteresis: keep the current order until the ideal one is 0.6 orders away.
    if (orderLevel < 0 || Math.abs(level - orderLevel) > 0.6) orderLevel = Math.round(level);
    return Math.max(0, Math.min(MAX_ORDER, orderLevel));
  }

  return {
    object,
    update(camera: PerspectiveCamera, viewportHeightPx: number) {
      if (disposed) return;
      tick++;
      if (!allsky.mesh && !allskyController && !allskyMissing && performance.now() - allskyFailedAt > RETRY_MS)
        requestAllsky();

      for (let i = 0; i < MAX_UPLOADS_PER_UPDATE && pending.length; i++) addTile(pending.shift() as Pending);

      // View direction and cone in the EQJ frame of `object`.
      object.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();
      camera.getWorldDirection(view);
      inv.copy(object.matrixWorld).invert();
      view.transformDirection(inv);
      const halfV = (camera.fov * Math.PI) / 360;
      const halfAngle = Math.min(Math.PI, Math.atan(Math.tan(halfV) * Math.sqrt(1 + camera.aspect * camera.aspect)) + 0.02);

      const order = targetOrder(camera.fov, viewportHeightPx);
      for (const t of tiles.values()) t.mesh.visible = false;

      const wanted = new Set<string>();
      const toLoad: { pix: number; dist: number }[] = [];
      let centreOrder = 0;
      let complete = true;
      if (order >= MIN_TILE_ORDER) {
        const cells = visibleCells(order, view, halfAngle).sort((a, b) => a.dist - b.dist);
        let bestDist = Infinity;
        for (const c of cells) {
          const key = tileKey(frame, order, c.pix);
          const own = tiles.get(key);
          const shown = own ?? findLoaded(order, c.pix);
          if (shown) {
            shown.mesh.visible = true;
            shown.lastUsed = tick;
          }
          if (c.dist < bestDist) {
            bestDist = c.dist;
            centreOrder = shown ? shown.order : 0;
          }
          if (own || missing.has(key)) continue;
          complete = false;
          wanted.add(key);
          const failedAt = failed.get(key);
          if (failedAt !== undefined && performance.now() - failedAt < RETRY_MS) continue;
          if (!inflight.has(key)) toLoad.push(c);
        }
      }
      shownOrder = centreOrder;
      frameComplete = complete && (order >= MIN_TILE_ORDER || !!allsky.mesh);
      if (frameComplete) prevFrame = frame;

      // Drop requests for tiles that left the view or belong to another frame or order.
      for (const [key, ctrl] of inflight) {
        if (!wanted.has(key)) {
          ctrl.abort();
          inflight.delete(key);
        }
      }
      for (const c of toLoad) {
        if (inflight.size + (allskyController ? 1 : 0) >= MAX_REQUESTS) break;
        startRequest(frame, order, c.pix);
      }
      evict();
    },
    setFrame(index: number) {
      if (disposed || index === frame || !isFrame(index)) return;
      // Fall back to the frame on screen now: this one if it had loaded, else the earlier one.
      if (frameComplete) prevFrame = frame;
      frameComplete = false;
      frame = index;
      if (allsky.mesh) {
        disposeAllsky(allskyPrev);
        allskyPrev = allsky;
        allsky = { frame, mesh: null, bitmap: null };
      } else {
        allsky = { frame, mesh: null, bitmap: null };
      }
      requestAllsky();
      // Tiles of frames other than the two in use are no longer drawn; they age out of the LRU.
    },
    get frame() {
      return frame;
    },
    get order() {
      return shownOrder;
    },
    dispose() {
      disposed = true;
      allskyController?.abort();
      for (const ctrl of inflight.values()) ctrl.abort();
      inflight.clear();
      for (const p of pending) p.bitmap.close();
      pending.length = 0;
      for (const t of tiles.values()) {
        disposeMesh(t.mesh);
        t.bitmap.close();
      }
      tiles.clear();
      disposeAllsky(allsky);
      disposeAllsky(allskyPrev);
      allskyPrev = null;
      missing.clear();
      failed.clear();
      bounds.clear();
    },
  };
}
