import { buildTilePatch, cellBounds, tileImageToVec, xy2nest } from '../healpix.ts';

const W = 512;
const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];

function compact(v) {
  let r = 0n;
  for (let b = 0n; b < 32n; b++) if ((v >> (2n * b)) & 1n) r |= 1n << b;
  return r;
}

function pix2vecRef(order, pix) {
  const nside = 1n << BigInt(order);
  const npface = nside * nside;
  const p = BigInt(pix);
  const face = Number(p / npface);
  const sub = p % npface;
  const ix = compact(sub);
  const iy = compact(sub >> 1n);
  const nl4 = 4n * nside;
  const jr = BigInt(JRLL[face]) * nside - ix - iy - 1n;
  const ns = Number(nside);
  const fact2 = 4 / (12 * ns * ns);
  let nr;
  let z;
  let kshift;
  if (jr < nside) {
    nr = jr;
    z = 1 - Number(nr) * Number(nr) * fact2;
    kshift = 0n;
  } else if (jr > 3n * nside) {
    nr = nl4 - jr;
    z = Number(nr) * Number(nr) * fact2 - 1;
    kshift = 0n;
  } else {
    nr = nside;
    z = Number(2n * nside - jr) * 2 * ns * fact2;
    kshift = (jr - nside) & 1n;
  }
  let jp = (BigInt(JPLL[face]) * nr + ix - iy + 1n + kshift) / 2n;
  if (jp > nl4) jp -= nl4;
  if (jp < 1n) jp += nl4;
  const phi = (Number(jp) - Number(kshift + 1n) * 0.5) * (Math.PI / 2 / Number(nr));
  const st = Math.sqrt(1 - z * z);
  return [st * Math.cos(phi), st * Math.sin(phi), z];
}

const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b))));
const ARCSEC = Math.PI / 180 / 3600;
let fails = 0;
const check = (ok, msg) => {
  if (!ok) {
    fails++;
    if (fails < 20) console.log('FAIL', msg);
  }
};

// Geometry checks for the HiPS tile meshes (no network, no three.js):
// 1. the mesh vertex at the centre of tile pixel (col, row) points at the HEALPix centre of the
//    order k + 9 nested cell N * 512^2 + xy2nest(ix = row, iy = col) (the layout measured by
//    hips-orient.mjs), with that centre computed by an independent port of Healpix_Base
//    pix2loc (integer ring/phi algorithm);
// 2. buildTilePatch vertices and uvs agree with tileImageToVec;
// 3. every triangle faces the sphere centre (counter-clockwise from inside, FrontSide);
// 4. reports whether the tile image appears mirrored from inside (HiPS images are drawn as seen
//    from outside, so every tile should be);
// 5. cellBounds radius contains the whole tile.
// Run: node src/app/sky/tools/hips-geom.mjs
// 1. pixel centres
let worst1 = 0;
let n1 = 0;
for (let order = 0; order <= 5; order++) {
  const npix = 12 * 4 ** order;
  for (let t = 0; t < 400; t++) {
    const pix = Math.floor(Math.random() * npix);
    for (let s = 0; s < 20; s++) {
      const col = Math.floor(Math.random() * W);
      const row = Math.floor(Math.random() * W);
      const v = [0, 0, 0];
      tileImageToVec(order, pix, (col + 0.5) / W, (row + 0.5) / W, v);
      const ref = pix2vecRef(order + 9, pix * W * W + xy2nest(row, col));
      const e = angle(v, ref);
      worst1 = Math.max(worst1, e);
      n1++;
    }
  }
  for (const pix of [0, npix - 1]) for (const [col, row] of [[0, 0], [W - 1, 0], [0, W - 1], [W - 1, W - 1]]) {
    const v = [0, 0, 0];
    tileImageToVec(order, pix, (col + 0.5) / W, (row + 0.5) / W, v);
    worst1 = Math.max(worst1, angle(v, pix2vecRef(order + 9, pix * W * W + xy2nest(row, col))));
    n1++;
  }
}
check(worst1 < 0.05 * ARCSEC, `pixel centre mismatch ${worst1 / ARCSEC} arcsec`);
console.log(`1. ${n1} tile pixel centres vs reference pix2vec at order k+9: worst ${(worst1 / ARCSEC).toExponential(2)} arcsec`);

// 2-4. patches
let worst2 = 0;
let tris = 0;
let badWinding = 0;
let mirrored = 0;
let patches = 0;
const R = 10;
for (let order = 0; order <= 5; order++) {
  const npix = 12 * 4 ** order;
  for (let t = 0; t < 60; t++) {
    const pix = t < 12 ? Math.floor((t * npix) / 12) : Math.floor(Math.random() * npix);
    const segs = 8;
    const p = buildTilePatch(order, pix, segs, R);
    patches++;
    const n = segs + 1;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const v = [0, 0, 0];
        tileImageToVec(order, pix, i / segs, j / segs, v);
        const pos = [p.positions[k * 3] / R, p.positions[k * 3 + 1] / R, p.positions[k * 3 + 2] / R];
        worst2 = Math.max(worst2, angle(v, pos), Math.abs(Math.hypot(...pos) - 1));
        check(Math.abs(p.uvs[k * 2] - i / segs) < 1e-7 && Math.abs(p.uvs[k * 2 + 1] - j / segs) < 1e-7, 'uv');
      }
    for (let q = 0; q < p.indices.length; q += 3) {
      const [a, b, c] = [p.indices[q], p.indices[q + 1], p.indices[q + 2]].map((x) => [p.positions[x * 3], p.positions[x * 3 + 1], p.positions[x * 3 + 2]]);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const cen = [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]];
      tris++;
      if (nrm[0] * cen[0] + nrm[1] * cen[1] + nrm[2] * cen[2] >= 0) badWinding++;
    }
    // Mirror test at the tile centre: d(col) and -d(row) (image right and up) seen from inside.
    const c0 = [0, 0, 0];
    const cr = [0, 0, 0];
    const cu = [0, 0, 0];
    tileImageToVec(order, pix, 0.5, 0.5, c0);
    tileImageToVec(order, pix, 0.51, 0.5, cr);
    tileImageToVec(order, pix, 0.5, 0.49, cu);
    const right = cr.map((x, k) => x - c0[k]);
    const up = cu.map((x, k) => x - c0[k]);
    // Looking out along c0, (right x up) points back at the viewer for an unmirrored image.
    const rxu = [right[1] * up[2] - right[2] * up[1], right[2] * up[0] - right[0] * up[2], right[0] * up[1] - right[1] * up[0]];
    if (rxu[0] * c0[0] + rxu[1] * c0[1] + rxu[2] * c0[2] > 0) mirrored++;
  }
}
check(worst2 < 1e-6, `patch vertex mismatch ${worst2}`);
check(badWinding === 0, `${badWinding} triangles face outward`);
console.log(`2. ${patches} patches: worst vertex error ${worst2.toExponential(2)} (radians / radius fraction)`);
console.log(`3. ${tris} triangles: ${badWinding} not facing the centre`);
check(mirrored === patches, 'tile handedness differs between tiles');
console.log(`4. tiles that appear mirrored from the centre: ${mirrored} of ${patches} (expected all: images are drawn as seen from outside)`);

// 5. bounds
let outside = 0;
for (let order = 0; order <= 5; order++)
  for (let t = 0; t < 200; t++) {
    const pix = Math.floor(Math.random() * 12 * 4 ** order);
    const b = cellBounds(order, pix);
    for (let s = 0; s < 50; s++) {
      const v = [0, 0, 0];
      tileImageToVec(order, pix, Math.random(), Math.random(), v);
      if (angle(v, [b.cx, b.cy, b.cz]) > b.radius * 1.0001 + 1e-9) outside++;
    }
  }
check(outside === 0, `${outside} points outside cellBounds`);
console.log(`5. cellBounds: ${outside} sampled tile points outside the bounding cone`);

console.log(fails ? `FAIL (${fails})` : 'PASS');
if (fails) process.exitCode = 1;
