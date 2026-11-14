import { inflateSync } from 'node:zlib';

// Minimal PNG decoder for HiPS tiles: 8-bit greyscale, RGB, RGBA, grey+alpha or palette, no
// interlace. Returns { width, height, lum } with lum a Float32Array of luminance 0..255.
export function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let ctype = 0;
  let interlace = 0;
  let palette = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG depth ${depth} interlace ${interlace}`);
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!chans) throw new Error(`unsupported colour type ${ctype}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * chans;
  const out = new Uint8Array(stride * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= chans ? out[row + x - chans] : 0;
      const b = y > 0 ? out[row - stride + x] : 0;
      const c = x >= chans && y > 0 ? out[row - stride + x - chans] : 0;
      let v = raw[p++];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[row + x] = v & 255;
    }
  }
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    if (ctype === 3) {
      const k = out[i] * 3;
      lum[i] = (palette[k] + palette[k + 1] + palette[k + 2]) / 3;
    } else if (ctype === 0 || ctype === 4) lum[i] = out[i * chans];
    else lum[i] = (out[i * chans] + out[i * chans + 1] + out[i * chans + 2]) / 3;
  }
  return { width, height, lum };
}
