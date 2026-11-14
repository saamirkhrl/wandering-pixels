import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
const UA = 'hips-mirror/1.0';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..', 'public', 'sky', 'hips');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const frame = Number(opt('--frame', '32'));
const maxOrder = Number(opt('--max-order', '1'));
const sizesOnly = args.includes('--sizes');

const tilePath = (order, pix) =>
  `Norder${order}/Dir${Math.floor(pix / 10000) * 10000}/Npix${pix}${frame ? `_${frame}` : ''}.png`;

const jobs = [];
for (let order = 0; order <= maxOrder; order++) for (let pix = 0; pix < 12 * 4 ** order; pix++) jobs.push([order, pix]);

let bytes = 0;
let fetched = 0;
let skipped = 0;
const perOrder = {};

async function one([order, pix]) {
  const rel = tilePath(order, pix);
  const url = `${BASE}/${rel}`;
  if (sizesOnly) {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const n = Number(res.headers.get('content-length') ?? 0);
    bytes += n;
    perOrder[order] = (perOrder[order] ?? 0) + n;
    return;
  }
  const file = join(root, String(frame), rel);
  try {
    const st = await stat(file);
    if (st.size > 0) {
      skipped++;
      bytes += st.size;
      perOrder[order] = (perOrder[order] ?? 0) + st.size;
      return;
    }
  } catch {
    /* not present */
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, buf);
      fetched++;
      bytes += buf.length;
      perOrder[order] = (perOrder[order] ?? 0) + buf.length;
      return;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

// Mirrors the lowest orders of one SPHEREx HiPS frame into public/sky/hips/<frame>/ with the
// IRSA layout (Norder<k>/Dir<d>/Npix<n>[_<frame>].png), so hips.ts can draw them without the
// archive. Polite: two requests at a time, generic User-Agent, files already present are skipped.
// Usage: node src/app/sky/tools/hips-fetch.mjs [--frame 32] [--max-order 1] [--sizes]
//   --sizes only sums Content-Length with HEAD requests and writes nothing.
let next = 0;
async function worker() {
  while (next < jobs.length) await one(jobs[next++]);
}
await Promise.all([worker(), worker()]);

const mb = (n) => (n / 1e6).toFixed(2) + ' MB';
console.log(`frame ${frame}, orders 0..${maxOrder}: ${jobs.length} tiles, ${mb(bytes)}`);
for (const [o, n] of Object.entries(perOrder)) console.log(`  order ${o}: ${12 * 4 ** Number(o)} tiles, ${mb(n)}`);
if (!sizesOnly) console.log(`fetched ${fetched}, already present ${skipped}, into ${join(root, String(frame))}`);
