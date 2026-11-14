const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];
const HALF_PI = Math.PI / 2;
const QUARTER_PI = Math.PI / 4;

// HiPS tile layout, measured on the SPHEREx tiles by tools/hips-orient.mjs (bright stars at
// orders 3 and 5): image column c (0 at the left) and row r (0 at the top) of a W x W tile of
// nested cell N at order k hold the order k + log2(W) cell N * W^2 + xy2nest(ix = r, iy = c).
// For texture coordinates (u right, v up, 0..1, three.js flipY) the point inside the cell is at
// local face coordinates x = 1 - v, y = u.
export const TILE_WIDTH = 512;

// A base face (0..11) is parametrised by continuous (x, y) in [0, 1]^2 so that at order k the
// nested cell holding (x, y) has ix = floor(x * 2^k), iy = floor(y * 2^k) and index
// face * 4^k + xy2nest(ix, iy), ix on the even bits (as Healpix_Base xyf2nest). Directions are
// unit vectors in the HiPS frame (EQJ here): x -> RA 0, y -> RA 90, z -> north celestial pole.
export interface Fxy {
  face: number;
  x: number;
  y: number;
}

export function nsideOf(order: number): number {
  return 2 ** order;
}

export function npixOf(order: number): number {
  return 12 * 4 ** order;
}

function spread(v: number): number {
  // Interleave the low 16 bits of v with zeros (exact in doubles for orders up to 16).
  let r = 0;
  for (let b = 0; b < 16; b++) if (v & (1 << b)) r += 2 ** (2 * b);
  return r;
}

function compact(v: number): number {
  let r = 0;
  for (let b = 0; b < 16; b++) if (Math.floor(v / 2 ** (2 * b)) % 2 === 1) r |= 1 << b;
  return r;
}

export function xy2nest(ix: number, iy: number): number {
  return spread(ix) + 2 * spread(iy);
}

export function nest2xy(sub: number): { ix: number; iy: number } {
  return { ix: compact(sub), iy: compact(Math.floor(sub / 2)) };
}

export function fxy2nest(order: number, f: Fxy): number {
  const n = nsideOf(order);
  const ix = Math.min(n - 1, Math.max(0, Math.floor(f.x * n)));
  const iy = Math.min(n - 1, Math.max(0, Math.floor(f.y * n)));
  return f.face * 4 ** order + xy2nest(ix, iy);
}

// Continuous face coordinates of a direction (need not be normalised).
export function vec2fxy(vx: number, vy: number, vz: number): Fxy {
  const len = Math.hypot(vx, vy, vz);
  const z = vz / len;
  const za = Math.abs(z);
  let phi = Math.atan2(vy, vx);
  if (phi < 0) phi += 2 * Math.PI;
  let tt = phi / HALF_PI;
  if (tt >= 4) tt -= 4;
  if (za <= 2 / 3) {
    const t1 = 0.5 + tt;
    const t2 = z * 0.75;
    const jp = t1 - t2; // ascending edge line, units of nside
    const jm = t1 + t2; // descending edge line
    const ifp = Math.floor(jp);
    const ifm = Math.floor(jm);
    const face = ifp === ifm ? (ifp % 4) | 4 : ifp < ifm ? ifp % 4 : (ifm % 4) + 8;
    return { face, x: jm - ifm, y: 1 - (jp - ifp) };
  }
  const ntt = Math.min(3, Math.floor(tt));
  const tp = tt - ntt;
  const s = Math.sqrt(1 - za);
  const tmp = Math.sqrt(3) * s;
  const jp = Math.min(1, tp * tmp);
  const jm = Math.min(1, (1 - tp) * tmp);
  if (z > 0) return { face: ntt, x: 1 - jm, y: 1 - jp };
  return { face: ntt + 8, x: jp, y: jm };
}

// Unit vector of continuous face coordinates; written into out[o..o+2].
export function fxy2vec(face: number, x: number, y: number, out: number[] | Float32Array, o = 0): void {
  const jr = JRLL[face] - x - y; // ring coordinate in units of nside, 0 at N pole, 4 at S pole
  let z: number;
  let phi: number;
  if (jr < 1) {
    const t = jr;
    z = 1 - (t * t) / 3;
    phi = t > 1e-12 ? QUARTER_PI * (JPLL[face] + (x - y) / t) : QUARTER_PI * JPLL[face];
  } else if (jr > 3) {
    const t = 4 - jr;
    z = (t * t) / 3 - 1;
    phi = t > 1e-12 ? QUARTER_PI * (JPLL[face] + (x - y) / t) : QUARTER_PI * JPLL[face];
  } else {
    z = ((2 - jr) * 2) / 3;
    phi = QUARTER_PI * (JPLL[face] + x - y);
  }
  const st = Math.sqrt(Math.max(0, 1 - z * z));
  out[o] = st * Math.cos(phi);
  out[o + 1] = st * Math.sin(phi);
  out[o + 2] = z;
}

// Face and lower corner (face units) of nested pixel `pix` at `order`.
export function nestCell(order: number, pix: number): { face: number; x0: number; y0: number; size: number } {
  const per = 4 ** order;
  const face = Math.floor(pix / per);
  const { ix, iy } = nest2xy(pix - face * per);
  const size = 1 / nsideOf(order);
  return { face, x0: ix * size, y0: iy * size, size };
}

// Direction of a point of HiPS tile `pix` at `order` given as fractions of the image width:
// a = column / W (0 at the left edge), b = row / W (0 at the top edge).
export function tileImageToVec(order: number, pix: number, a: number, b: number, out: number[] | Float32Array, o = 0): void {
  const c = nestCell(order, pix);
  fxy2vec(c.face, c.x0 + b * c.size, c.y0 + a * c.size, out, o);
}

export interface TilePatch {
  positions: Float32Array; // xyz per vertex, on a sphere of `radius`
  uvs: Float32Array; // texture coordinates, u = column fraction, v = row fraction (top = 0)
  indices: Uint32Array; // triangles wound counter-clockwise as seen from the sphere centre
}

// Grid mesh covering tile `pix` at `order` with segs x segs quads. Vertex (i, j) sits at image
// fractions a = i / segs, b = j / segs and carries uv = uvMap(a, b) (default: a, b, for a
// texture uploaded without flipY, so v = 0 is the first image row).
export function buildTilePatch(
  order: number,
  pix: number,
  segs: number,
  radius: number,
  uvMap: (a: number, b: number) => [number, number] = (a, b) => [a, b],
): TilePatch {
  const n = segs + 1;
  const positions = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const indices = new Uint32Array(segs * segs * 6);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const a = i / segs;
      const b = j / segs;
      tileImageToVec(order, pix, a, b, positions, k * 3);
      positions[k * 3] *= radius;
      positions[k * 3 + 1] *= radius;
      positions[k * 3 + 2] *= radius;
      const uv = uvMap(a, b);
      uvs[k * 2] = uv[0];
      uvs[k * 2 + 1] = uv[1];
    }
  // A HiPS tile image is the sky as seen from outside the sphere (from the centre it appears
  // mirrored: north up puts east on the right of the image), so (column right, row down) is
  // counter-clockwise seen from the centre and (i, j) -> (i + 1, j) -> (i, j + 1) faces inward.
  let t = 0;
  for (let j = 0; j < segs; j++)
    for (let i = 0; i < segs; i++) {
      const p00 = j * n + i;
      const p10 = p00 + 1;
      const p01 = p00 + n;
      const p11 = p01 + 1;
      indices[t++] = p00;
      indices[t++] = p10;
      indices[t++] = p01;
      indices[t++] = p10;
      indices[t++] = p11;
      indices[t++] = p01;
    }
  return { positions, uvs, indices };
}

// Unit centre direction and angular radius (radians, centre to farthest corner or edge
// midpoint) of nested cell `pix` at `order`.
export function cellBounds(order: number, pix: number): { cx: number; cy: number; cz: number; radius: number } {
  const v = [0, 0, 0];
  tileImageToVec(order, pix, 0.5, 0.5, v);
  const [cx, cy, cz] = v;
  let minDot = 1;
  for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]) {
    tileImageToVec(order, pix, a, b, v);
    minDot = Math.min(minDot, v[0] * cx + v[1] * cy + v[2] * cz);
  }
  return { cx, cy, cz, radius: Math.acos(Math.max(-1, Math.min(1, minDot))) };
}

// Image column and row (fractional, pixel centres at .5) of a direction inside HiPS tile `pix`,
// or null when the direction is outside that tile. Inverse of tileImageToVec (scaled by width).
export function vecToTilePixel(
  order: number,
  pix: number,
  vx: number,
  vy: number,
  vz: number,
  width = TILE_WIDTH,
): { col: number; row: number } | null {
  const f = vec2fxy(vx, vy, vz);
  const c = nestCell(order, pix);
  if (f.face !== c.face) return null;
  const lx = (f.x - c.x0) / c.size;
  const ly = (f.y - c.y0) / c.size;
  if (lx < 0 || lx > 1 || ly < 0 || ly > 1) return null;
  // local x = row / W, local y = col / W
  return { col: ly * width, row: lx * width };
}

export function radecToXyz(raDeg: number, decDeg: number): [number, number, number] {
  const r = (raDeg * Math.PI) / 180;
  const d = (decDeg * Math.PI) / 180;
  return [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)];
}

// Index of the nested cell at `order` holding a direction.
export function vec2nest(order: number, vx: number, vy: number, vz: number): number {
  return fxy2nest(order, vec2fxy(vx, vy, vz));
}
