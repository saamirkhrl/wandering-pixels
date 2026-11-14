export function upsampleSmooth(norm: Float32Array, w: number, h: number, scale: number): Float32Array {
  const W = w * scale;
  const H = h * scale;
  const out = new Float32Array(W * H);
  const x0 = new Int32Array(W);
  const x1 = new Int32Array(W);
  const fx = new Float32Array(W);
  const xn = new Int32Array(W);
  for (let ox = 0; ox < W; ox++) {
    const u = (ox + 0.5) / scale;
    const sx = u - 0.5;
    const f = Math.floor(sx);
    x0[ox] = Math.min(w - 1, Math.max(0, f));
    x1[ox] = Math.min(w - 1, Math.max(0, f + 1));
    fx[ox] = sx - f;
    xn[ox] = Math.min(w - 1, Math.floor(u));
  }
  for (let oy = 0; oy < H; oy++) {
    const v = (oy + 0.5) / scale;
    const sy = v - 0.5;
    const f = Math.floor(sy);
    const ya = Math.min(h - 1, Math.max(0, f)) * w;
    const yb = Math.min(h - 1, Math.max(0, f + 1)) * w;
    const fy = sy - f;
    const yn = Math.min(h - 1, Math.floor(v)) * w;
    const gy = 1 - fy;
    const row = oy * W;
    for (let ox = 0; ox < W; ox++) {
      const nv = norm[yn + xn[ox]];
      if (nv !== nv) {
        out[row + ox] = NaN;
        continue;
      }
      const a = x0[ox];
      const b = x1[ox];
      const gx = 1 - fx[ox];
      const hx = fx[ox];
      const p00 = norm[ya + a];
      const p10 = norm[ya + b];
      const p01 = norm[yb + a];
      const p11 = norm[yb + b];
      let sum = 0;
      let wt = 0;
      if (p00 === p00) {
        const k = gx * gy;
        sum += k * p00;
        wt += k;
      }
      if (p10 === p10) {
        const k = hx * gy;
        sum += k * p10;
        wt += k;
      }
      if (p01 === p01) {
        const k = gx * fy;
        sum += k * p01;
        wt += k;
      }
      if (p11 === p11) {
        const k = hx * fy;
        sum += k * p11;
        wt += k;
      }
      let r = wt > 1e-9 ? sum / wt : nv;
      if (r < 0) r = 0;
      else if (r > 1) r = 1;
      out[row + ox] = r;
    }
  }
  return out;
}

export function toRGBA(
  values: Float32Array,
  out: Uint8ClampedArray,
  colour: (v: number) => [number, number, number],
  nanRGB: [number, number, number],
): void {
  for (let i = 0, j = 0; i < values.length; i++, j += 4) {
    const v = values[i];
    const c = v !== v ? nanRGB : colour(v);
    out[j] = c[0];
    out[j + 1] = c[1];
    out[j + 2] = c[2];
    out[j + 3] = 255;
  }
}
