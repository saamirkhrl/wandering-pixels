// Minimal FITS reader over HTTP Range requests. Browser and Node 20+, no dependencies.
import { SpherexError } from './types';

export type HeaderValue = string | number | boolean;
export type Header = Record<string, HeaderValue>;

export interface Hdu {
  index: number;
  extname: string; // '' for primary
  header: Header;
  headerStart: number;
  dataStart: number;
  dataBytes: number;
}

export interface ReadOptions {
  signal?: AbortSignal;
  onRetry?: (attempt: number, status: number) => void;
  /** Called with the length of each response body actually received (successful reads only). */
  onBytes?: (n: number) => void;
}

const BLOCK = 2880;
const CARD = 80;
const FIRST_CHUNK = 64 * 1024;
const HEADER_CHUNK = 40 * 1024;
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

let fetchImpl: typeof fetch | null = null;
let transferred = 0;

export function setFetch(fn: typeof fetch): void {
  fetchImpl = fn;
}

export function bytesTransferred(): number {
  return transferred;
}

function doFetch(input: string, init: RequestInit): Promise<Response> {
  return (fetchImpl ?? fetch)(input, init);
}

function abortError(): SpherexError {
  return new SpherexError('ABORTED', 'Request aborted');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get('Retry-After');
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.min(Math.max(s, 0) * 1000, 30000);
  const d = Date.parse(v);
  if (Number.isFinite(d)) return Math.min(Math.max(d - Date.now(), 0), 30000);
  return null;
}

interface RangeResult {
  data: Uint8Array;
  total: number | null; // total resource size if known
}

async function fetchRange(url: string, start: number, end: number, opts?: ReadOptions): Promise<RangeResult> {
  if (end <= start) return { data: new Uint8Array(0), total: null };
  return fetchBytes(url, `bytes=${start}-${end - 1}`, (b) => b.slice(start, end), opts);
}

/** One GET with the given Range header value, retried like every read. slice200 trims a full body. */
async function fetchBytes(
  url: string,
  rangeValue: string,
  slice200: (full: Uint8Array) => Uint8Array,
  opts?: ReadOptions,
): Promise<RangeResult> {
  const signal = opts?.signal;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw abortError();
    let wait: number | null = null;
    try {
      const res = await doFetch(url, { headers: { Range: rangeValue }, signal });
      if (res.status === 206 || res.status === 200) {
        const buf = new Uint8Array(await res.arrayBuffer());
        transferred += buf.length;
        opts?.onBytes?.(buf.length);
        if (res.status === 206) {
          const cr = res.headers.get('Content-Range');
          const m = cr ? /\/(\d+)\s*$/.exec(cr) : null;
          return { data: buf, total: m ? Number(m[1]) : null };
        }
        return { data: slice200(buf), total: buf.length };
      }
      lastStatus = res.status;
      if (res.status === 416) {
        // Range starts past EOF. Browsers cannot read Content-Range on S3, so walkHdus
        // finds the end of the file this way.
        await res.arrayBuffer().catch(() => undefined);
        return { data: new Uint8Array(0), total: null };
      }
      if (res.status >= 500 || res.status === 429) {
        wait = retryAfterMs(res);
        await res.arrayBuffer().catch(() => undefined);
      } else {
        await res.arrayBuffer().catch(() => undefined);
        throw new SpherexError('UPSTREAM_ERROR', `HTTP ${res.status} reading ${url}`);
      }
    } catch (e) {
      if (e instanceof SpherexError) throw e;
      if (signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw abortError();
      lastStatus = 0; // network error, retry
    }
    if (attempt === MAX_ATTEMPTS) break;
    opts?.onRetry?.(attempt, lastStatus);
    const base = BACKOFF_MS[attempt - 1] ?? 8000;
    await sleep(wait ?? base * (0.75 + Math.random() * 0.5), signal);
  }
  if (lastStatus === 503) throw new SpherexError('UPSTREAM_BUSY', `Server busy (503) reading ${url}`);
  throw new SpherexError('UPSTREAM_ERROR', `Failed reading ${url} (status ${lastStatus || 'network error'})`);
}

export async function readRange(url: string, start: number, end: number, opts?: ReadOptions): Promise<Uint8Array> {
  return (await fetchRange(url, start, end, opts)).data;
}

function parseValue(raw: string): HeaderValue | undefined {
  const s = raw.trimStart();
  if (s.length === 0) return undefined;
  if (s[0] === "'") {
    let out = '';
    let i = 1;
    while (i < s.length) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        break;
      }
      out += s[i];
      i++;
    }
    return out.replace(/\s+$/, '');
  }
  const slash = s.indexOf('/');
  const tok = (slash >= 0 ? s.slice(0, slash) : s).trim();
  if (tok === 'T') return true;
  if (tok === 'F') return false;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eEdD][+-]?\d+)?$/.test(tok)) {
    return Number(tok.replace(/[dD]/, 'E'));
  }
  return undefined; // complex or unparsable: skip
}

export function parseHeader(bytes: Uint8Array, offset = 0): { header: Header; end: number } | null {
  const header: Header = {};
  const dec = new TextDecoder('latin1');
  for (let pos = offset; pos + CARD <= bytes.length; pos += CARD) {
    const card = dec.decode(bytes.subarray(pos, pos + CARD));
    const kw = card.slice(0, 8).trimEnd();
    if (kw === 'END') {
      const used = pos + CARD - offset;
      const end = offset + Math.ceil(used / BLOCK) * BLOCK;
      return end <= bytes.length ? { header, end } : null;
    }
    if (kw === '' || kw === 'COMMENT' || kw === 'HISTORY' || kw === 'CONTINUE') continue;
    let key: string;
    let rest: string;
    if (kw === 'HIERARCH') {
      const eq = card.indexOf('=');
      if (eq < 0) continue;
      key = card.slice(8, eq).trim().toUpperCase();
      rest = card.slice(eq + 1);
    } else {
      if (card.slice(8, 10) !== '= ') continue;
      key = kw.toUpperCase();
      rest = card.slice(10);
    }
    if (!key || key in header) continue;
    const v = parseValue(rest);
    if (v !== undefined) header[key] = v;
  }
  return null;
}

function num(h: Header, k: string, d: number): number {
  const v = h[k];
  return typeof v === 'number' ? v : d;
}

function dataSize(h: Header): number {
  const naxis = num(h, 'NAXIS', 0);
  if (naxis === 0) return 0;
  let prod = 1;
  for (let i = 1; i <= naxis; i++) prod *= num(h, `NAXIS${i}`, 0);
  return (Math.abs(num(h, 'BITPIX', 8)) / 8) * num(h, 'GCOUNT', 1) * (num(h, 'PCOUNT', 0) + prod);
}

const hduCache = new Map<string, Promise<Hdu[]>>();

async function walk(url: string, opts?: ReadOptions): Promise<Hdu[]> {
  const first = await fetchRange(url, 0, FIRST_CHUNK, opts);
  let buf = first.data;
  let bufStart = 0;
  const total = first.total ?? Infinity;
  const hdus: Hdu[] = [];
  let offset = 0;
  while (offset < total) {
    let parsed = null;
    let want = HEADER_CHUNK;
    if (offset >= bufStart && offset < bufStart + buf.length) {
      parsed = parseHeader(buf, offset - bufStart);
    }
    while (!parsed) {
      const r = await fetchRange(url, offset, Math.min(offset + want, total), opts);
      buf = r.data;
      bufStart = offset;
      if (buf.length === 0) {
        if (first.total === null && hdus.length > 0) return hdus; // EOF, size unknown
        throw new SpherexError('UPSTREAM_ERROR', `Unexpected end of file at ${offset} in ${url}`);
      }
      parsed = parseHeader(buf, 0);
      if (!parsed) {
        if (offset + buf.length >= total) {
          throw new SpherexError('UPSTREAM_ERROR', `FITS header without END at ${offset} in ${url}`);
        }
        want *= 2;
      }
    }
    // parsed.end is relative to buf when it came from a fresh read, else absolute within buf
    const headerEndAbs = bufStart + parsed.end;
    const header = parsed.header;
    const dataBytes = dataSize(header);
    const ext = header['EXTNAME'];
    hdus.push({
      index: hdus.length,
      extname: typeof ext === 'string' ? ext : '',
      header,
      headerStart: offset,
      dataStart: headerEndAbs,
      dataBytes,
    });
    offset = headerEndAbs + Math.ceil(dataBytes / BLOCK) * BLOCK;
  }
  return hdus;
}

export function walkHdus(url: string, opts?: ReadOptions): Promise<Hdu[]> {
  let p = hduCache.get(url);
  if (!p) {
    p = walk(url, opts);
    hduCache.set(url, p);
    p.catch(() => {
      if (hduCache.get(url) === p) hduCache.delete(url);
    });
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Fast header path. A Level 2 file is PRIMARY, IMAGE, FLAGS, VARIANCE, ZODI, (E)PSF, WCS-WAVE.
// Measured on 8 real files (dr1, qr2, qr3; D1, D2, D4, D6): header lengths are 2880 (primary),
// 20160-25920 (IMAGE), 14400-17280 (FLAGS), 11520 (VARIANCE, ZODI), 2880 (WCS-WAVE); IMAGE,
// VARIANCE and ZODI data are 2040x2040 float32; WCS-WAVE is always last and 3600-5760 bytes
// including its header. Each HDU starts right after the previous one, so the offsets follow from
// the headers. Every shortcut is validated (EXTNAME, XTENSION, BITPIX, NAXIS, dimensions, and for
// WCS-WAVE that header plus padded data end exactly at the end of the file). Anything that does
// not match throws FastMismatch, the URL is remembered as bad, and the full walk takes over.
// ---------------------------------------------------------------------------------------------

const FAST_FIRST = 32 * 1024; // primary + IMAGE header (max 28800 measured)
const FAST_FLAGS = 7 * BLOCK; // FLAGS header (max 17280 measured)
const FAST_EXT = 5 * BLOCK; // VARIANCE, ZODI header (11520 measured)
const FAST_EXT_GUESS = 4 * BLOCK; // expected VARIANCE header length, to guess the ZODI start
const FAST_TAIL = 4 * BLOCK; // suffix read for WCS-WAVE (max 5760 measured incl. header)
const FAST_MAX = 1 << 20; // give up doubling at 1 MiB

class FastMismatch extends Error {}

function padded(n: number): number {
  return Math.ceil(n / BLOCK) * BLOCK;
}

function makeHdu(index: number, header: Header, headerStart: number, headerLen: number): Hdu {
  const ext = header['EXTNAME'];
  return {
    index,
    extname: typeof ext === 'string' ? ext : '',
    header,
    headerStart,
    dataStart: headerStart + headerLen,
    dataBytes: dataSize(header),
  };
}

function checkExt(h: Hdu, name: string, like?: Hdu): void {
  const hd = h.header;
  if (h.extname !== name || typeof hd['XTENSION'] !== 'string') throw new FastMismatch(`not ${name}`);
  if (!(h.dataBytes > 0)) throw new FastMismatch(`${name} has no data`);
  if (name === 'FLAGS') return;
  if (hd['BITPIX'] !== -32 || hd['NAXIS'] !== 2) throw new FastMismatch(`${name} is not a float32 image`);
  const nx = hd['NAXIS1'];
  const ny = hd['NAXIS2'];
  if (typeof nx !== 'number' || typeof ny !== 'number' || nx <= 0 || ny <= 0) throw new FastMismatch(`${name} size`);
  if (like && (like.header['NAXIS1'] !== nx || like.header['NAXIS2'] !== ny)) {
    throw new FastMismatch(`${name} size differs from IMAGE`);
  }
}

/** Read the header at `offset`, doubling the read until END is found (or `once`: a single try). */
async function readHeaderAt(
  url: string,
  offset: number,
  initial: number,
  opts?: ReadOptions,
  once = false,
): Promise<{ header: Header; len: number }> {
  let want = initial;
  for (;;) {
    const r = await fetchRange(url, offset, offset + want, opts);
    const p = parseHeader(r.data, 0);
    if (p) return { header: p.header, len: p.end };
    if (once || r.data.length < want || want >= FAST_MAX) throw new FastMismatch(`no END at ${offset}`);
    want *= 2;
  }
}

async function readExt(
  url: string,
  index: number,
  name: string,
  start: number,
  size: number,
  like: Hdu | undefined,
  opts?: ReadOptions,
  once = false,
): Promise<Hdu> {
  const { header, len } = await readHeaderAt(url, start, size, opts, once);
  const h = makeHdu(index, header, start, len);
  checkExt(h, name, like);
  return h;
}

interface FastEntry {
  image?: Promise<Hdu>;
  flags?: Promise<Hdu>;
  variance?: Promise<Hdu>;
  zodi?: Promise<Hdu>;
}
const fastCache = new Map<string, FastEntry>();
const fastBad = new Set<string>();

function memo(url: string, key: keyof FastEntry, make: () => Promise<Hdu>): Promise<Hdu> {
  let e = fastCache.get(url);
  if (!e) {
    e = {};
    fastCache.set(url, e);
  }
  const entry = e;
  let p = entry[key];
  if (!p) {
    p = make();
    entry[key] = p;
    const mine = p;
    mine.catch(() => {
      if (entry[key] === mine) delete entry[key];
    });
  }
  return p;
}

function fastImage(url: string, opts?: ReadOptions): Promise<Hdu> {
  return memo(url, 'image', async () => {
    let want = FAST_FIRST;
    for (;;) {
      const r = await fetchRange(url, 0, want, opts);
      const p0 = parseHeader(r.data, 0);
      if (p0) {
        if (p0.header['SIMPLE'] !== true || dataSize(p0.header) !== 0) throw new FastMismatch('primary has data');
        const p1 = parseHeader(r.data, p0.end);
        if (p1) {
          const h = makeHdu(1, p1.header, p0.end, p1.end - p0.end);
          checkExt(h, 'IMAGE');
          return h;
        }
      }
      if (r.data.length < want || want >= FAST_MAX) throw new FastMismatch('no IMAGE header');
      want *= 2;
    }
  });
}

function fastFlags(url: string, opts?: ReadOptions): Promise<Hdu> {
  return memo(url, 'flags', async () => {
    const img = await fastImage(url, opts);
    return readExt(url, 2, 'FLAGS', img.dataStart + padded(img.dataBytes), FAST_FLAGS, undefined, opts);
  });
}

function fastVariance(url: string, opts?: ReadOptions): Promise<Hdu> {
  return memo(url, 'variance', async () => {
    const [img, fl] = await Promise.all([fastImage(url, opts), fastFlags(url, opts)]);
    return readExt(url, 3, 'VARIANCE', fl.dataStart + padded(fl.dataBytes), FAST_EXT, img, opts);
  });
}

function fastZodi(url: string, opts?: ReadOptions): Promise<Hdu> {
  return memo(url, 'zodi', async () => {
    const img = await fastImage(url, opts);
    const fl = await fastFlags(url, opts);
    // The ZODI header sits after VARIANCE (same size as IMAGE, header 11520 bytes). Guess it so the
    // read runs in parallel with the VARIANCE header read, then confirm against the real VARIANCE.
    const varStart = fl.dataStart + padded(fl.dataBytes);
    const guess = varStart + FAST_EXT_GUESS + padded(img.dataBytes);
    const [vr, spec] = await Promise.all([
      fastVariance(url, opts),
      readExt(url, 4, 'ZODI', guess, FAST_EXT, img, opts, true).catch((e: unknown) => {
        if (e instanceof FastMismatch) return null;
        throw e;
      }),
    ]);
    const real = vr.dataStart + padded(vr.dataBytes);
    if (spec && spec.headerStart === real) return spec;
    return readExt(url, 4, 'ZODI', real, FAST_EXT, img, opts);
  });
}

const FAST_STAGES: Record<string, (url: string, opts?: ReadOptions) => Promise<Hdu>> = {
  IMAGE: fastImage,
  FLAGS: fastFlags,
  VARIANCE: fastVariance,
  ZODI: fastZodi,
};

/** Forget every cached header and table location (tests, long-lived pages). */
export function clearHeaderCaches(): void {
  hduCache.clear();
  fastCache.clear();
  fastBad.clear();
  tailCache.clear();
}

/**
 * HDU by EXTNAME. IMAGE, FLAGS, VARIANCE and ZODI come from the fast header path (a few small
 * reads, EPSF and the rest skipped) unless the full walk is already cached; anything else, or any
 * file whose layout does not match the expectations, uses walkHdus.
 */
export async function getHdu(url: string, extname: string, opts?: ReadOptions): Promise<Hdu> {
  const fast = FAST_STAGES[extname];
  if (fast && !hduCache.has(url) && !fastBad.has(url)) {
    try {
      return await fast(url, opts);
    } catch (e) {
      if (!(e instanceof FastMismatch)) throw e;
      fastBad.add(url);
    }
  }
  const hdus = await walkHdus(url, opts);
  const h = hdus.find((x) => x.extname === extname);
  if (!h) throw new SpherexError('NOT_FOUND', `HDU ${extname} not found in ${url}`);
  return h;
}

export interface WaveTail {
  /**
   * The WCS-WAVE HDU. On the suffix path index is -1 (unknown) and, when the file size is not
   * readable (browsers cannot see Content-Range), headerStart and dataStart are negative offsets
   * from the end of the file. fileSize is null in that case.
   */
  hdu: Hdu;
  /** The table data (unpadded), already read. */
  data: Uint8Array;
  fileSize: number | null;
}

const tailCache = new Map<string, Promise<WaveTail>>();

async function fastTail(url: string, opts?: ReadOptions): Promise<WaveTail> {
  const r = await fetchBytes(url, `bytes=-${FAST_TAIL}`, (b) => b.slice(Math.max(0, b.length - FAST_TAIL)), opts);
  const buf = r.data;
  if (buf.length === 0 || buf.length % BLOCK !== 0) throw new FastMismatch('tail not block aligned');
  const dec = new TextDecoder('latin1');
  for (let s = buf.length - BLOCK; s >= 0; s -= BLOCK) {
    if (dec.decode(buf.subarray(s, s + 8)) !== 'XTENSION') continue;
    const p = parseHeader(buf, s);
    if (!p || p.header['EXTNAME'] !== 'WCS-WAVE') continue;
    const dataBytes = dataSize(p.header);
    if (p.end + padded(dataBytes) !== buf.length) continue; // must be the last HDU
    const base = r.total !== null ? r.total - buf.length : -buf.length;
    const hdu = makeHdu(-1, p.header, base + s, p.end - s);
    return { hdu, data: buf.slice(p.end, p.end + dataBytes), fileSize: r.total };
  }
  throw new FastMismatch('WCS-WAVE not at the end of the file');
}

/**
 * WCS-WAVE header and data in one small suffix read (Range: bytes=-N), validated to end exactly at
 * the end of the file; falls back to the full walk otherwise. Cached per URL.
 */
export function readWaveTail(url: string, opts?: ReadOptions): Promise<WaveTail> {
  let p = tailCache.get(url);
  if (!p) {
    p = (async () => {
      if (!hduCache.has(url) && !fastBad.has(url)) {
        try {
          return await fastTail(url, opts);
        } catch (e) {
          if (!(e instanceof FastMismatch)) throw e;
          fastBad.add(url);
        }
      }
      const hdus = await walkHdus(url, opts);
      const hdu = hdus.find((x) => x.extname === 'WCS-WAVE');
      if (!hdu) throw new SpherexError('NOT_FOUND', `HDU WCS-WAVE not found in ${url}`);
      const data = await readHduData(url, hdu, opts);
      const last = hdus[hdus.length - 1];
      return { hdu, data, fileSize: last.dataStart + padded(last.dataBytes) };
    })();
    tailCache.set(url, p);
    const mine = p;
    mine.catch(() => {
      if (tailCache.get(url) === mine) tailCache.delete(url);
    });
  }
  return p;
}

export async function readImageBlock(
  url: string,
  hdu: Hdu,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  opts?: ReadOptions,
): Promise<Float32Array> {
  const bitpix = num(hdu.header, 'BITPIX', 0);
  const nx = num(hdu.header, 'NAXIS1', 0);
  const ny = num(hdu.header, 'NAXIS2', 0);
  if (![8, 16, 32, -32, -64].includes(bitpix)) {
    throw new SpherexError('BAD_INPUT', `Unsupported BITPIX ${bitpix}`);
  }
  if (x0 < 0 || y0 < 0 || x1 > nx || y1 > ny || x1 < x0 || y1 < y0) {
    throw new SpherexError('BAD_INPUT', `Block [${x0},${x1})x[${y0},${y1}) outside ${nx}x${ny}`);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const out = new Float32Array(w * h);
  if (w === 0 || h === 0) return out;
  const bp = Math.abs(bitpix) / 8;
  const rowBytes = nx * bp;
  const bytes = await readRange(url, hdu.dataStart + y0 * rowBytes, hdu.dataStart + y1 * rowBytes, opts);
  if (bytes.length < h * rowBytes) {
    throw new SpherexError('UPSTREAM_ERROR', 'Short read of image block');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bscale = num(hdu.header, 'BSCALE', 1);
  const bzero = num(hdu.header, 'BZERO', 0);
  const scaled = bscale !== 1 || bzero !== 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const p = j * rowBytes + (x0 + i) * bp;
      let v: number;
      switch (bitpix) {
        case -32: v = dv.getFloat32(p, false); break;
        case -64: v = dv.getFloat64(p, false); break;
        case 32: v = dv.getInt32(p, false); break;
        case 16: v = dv.getInt16(p, false); break;
        default: v = dv.getUint8(p);
      }
      out[j * w + i] = scaled ? bzero + bscale * v : v;
    }
  }
  return out;
}

export async function readHduData(url: string, hdu: Hdu, opts?: ReadOptions): Promise<Uint8Array> {
  return readRange(url, hdu.dataStart, hdu.dataStart + hdu.dataBytes, opts);
}
