import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bytesTransferred,
  clearHeaderCaches,
  getHdu,
  parseHeader,
  readHduData,
  readImageBlock,
  readRange,
  readWaveTail,
  setFetch,
  walkHdus,
} from './fits';

const enc = new TextEncoder();

function card(s: string): string {
  return s.padEnd(80, ' ').slice(0, 80);
}

function kv(key: string, value: string): string {
  return card(key.padEnd(8, ' ') + '= ' + value);
}

function headerBytes(cards: string[]): Uint8Array {
  const text = cards.map((c) => card(c)).join('') + card('END');
  const n = Math.ceil(text.length / 2880) * 2880;
  return enc.encode(text.padEnd(n, ' '));
}

function pad(len: number): number {
  return Math.ceil(len / 2880) * 2880;
}

/** Synthetic MEF: empty primary, IMAGE 4x3 float32 BE, small BINTABLE with heap. */
function buildMef(): { file: Uint8Array; imgStart: number } {
  const parts: Uint8Array[] = [];
  parts.push(headerBytes([kv('SIMPLE', 'T'), kv('BITPIX', '8'), kv('NAXIS', '0'), kv('EXTEND', 'T')]));
  const imgHdr = headerBytes([
    kv('XTENSION', "'IMAGE   '"),
    kv('BITPIX', '-32'),
    kv('NAXIS', '2'),
    kv('NAXIS1', '4'),
    kv('NAXIS2', '3'),
    kv('PCOUNT', '0'),
    kv('GCOUNT', '1'),
    kv('EXTNAME', "'IMAGE   '"),
  ]);
  parts.push(imgHdr);
  const imgStart = parts[0].length + imgHdr.length;
  const img = new Uint8Array(pad(48));
  const dv = new DataView(img.buffer);
  for (let i = 0; i < 12; i++) dv.setFloat32(i * 4, i * 1.5 - 3, false);
  parts.push(img);
  const tblHdr = headerBytes([
    kv('XTENSION', "'BINTABLE'"),
    kv('BITPIX', '8'),
    kv('NAXIS', '2'),
    kv('NAXIS1', '8'),
    kv('NAXIS2', '10'),
    kv('PCOUNT', '100'),
    kv('GCOUNT', '1'),
    kv('EXTNAME', "'FLAGS   '"),
  ]);
  parts.push(tblHdr);
  const tbl = new Uint8Array(pad(180));
  for (let i = 0; i < 180; i++) tbl[i] = i & 255;
  parts.push(tbl);
  const total = parts.reduce((a, p) => a + p.length, 0);
  const file = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    file.set(p, o);
    o += p.length;
  }
  return { file, imgStart };
}

function rangeFetch(file: Uint8Array, log?: string[]): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>)?.Range ?? '';
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if (!m) return new Response(file.slice(), { status: 200 });
    const s = Number(m[1]);
    const e = Math.min(Number(m[2]), file.length - 1);
    log?.push(range);
    if (s >= file.length) return new Response('', { status: 416 });
    return new Response(file.slice(s, e + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${s}-${e}/${file.length}` },
    });
  }) as typeof fetch;
}

describe('parseHeader', () => {
  it('parses strings, logicals, ints, floats, exponents, HIERARCH', () => {
    const b = headerBytes([
      kv('SIMPLE', 'T'),
      kv('NAME', "'O''Brien  ' / comment / with slash"),
      kv('FLAGX', 'F'),
      kv('INT', '  -42 / an int'),
      kv('FLT', '3.25'),
      kv('EXPE', '1.5E-3'),
      kv('EXPD', '2.5D+2'),
      kv('EMPTYS', "''"),
      'COMMENT this is a comment',
      'HISTORY ignored',
      'HIERARCH ESO DET CHIP = 7 / hier',
      kv('INT', '99'),
      'CONTINUE  \'abc\'',
    ]);
    const r = parseHeader(b)!;
    expect(r.end).toBe(2880);
    expect(r.header.SIMPLE).toBe(true);
    expect(r.header.NAME).toBe("O'Brien");
    expect(r.header.FLAGX).toBe(false);
    expect(r.header.INT).toBe(-42);
    expect(r.header.FLT).toBe(3.25);
    expect(r.header.EXPE).toBeCloseTo(0.0015, 10);
    expect(r.header.EXPD).toBe(250);
    expect(r.header.EMPTYS).toBe('');
    expect(r.header['ESO DET CHIP']).toBe(7);
    expect(r.header.COMMENT).toBeUndefined();
  });

  it('returns null without END and honours offset', () => {
    const b = headerBytes([kv('A', '1')]);
    expect(parseHeader(b.subarray(0, 2000))).toBeNull();
    const two = new Uint8Array(b.length * 2);
    two.set(b, 0);
    two.set(headerBytes([kv('B', '2')]), b.length);
    const r = parseHeader(two, b.length)!;
    expect(r.header.B).toBe(2);
    expect(r.end).toBe(b.length * 2);
  });
});

describe('walkHdus and readers', () => {
  const { file, imgStart } = buildMef();
  let log: string[];
  beforeEach(() => {
    log = [];
    setFetch(rangeFetch(file, log));
  });

  it('walks a synthetic MEF', async () => {
    const hdus = await walkHdus('mem://a');
    expect(hdus.map((h) => h.extname)).toEqual(['', 'IMAGE', 'FLAGS']);
    expect(hdus[1].dataStart).toBe(imgStart);
    expect(hdus[1].dataBytes).toBe(48);
    expect(hdus[2].dataBytes).toBe(180);
    expect(hdus[2].dataStart % 2880).toBe(0);
    expect(log.length).toBe(1); // whole file fits in the first chunk
    const again = await walkHdus('mem://a');
    expect(again).toBe(hdus);
    expect(log.length).toBe(1);
    const h = await getHdu('mem://a', 'FLAGS');
    expect(h.index).toBe(2);
    await expect(getHdu('mem://a', 'NOPE')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reads a column slice of image rows, big-endian', async () => {
    const h = await getHdu('mem://a', 'IMAGE');
    const blk = await readImageBlock('mem://a', h, 1, 3, 1, 3);
    // pixel (x,y) = (y*4 + x) * 1.5 - 3
    expect(Array.from(blk)).toEqual([
      (5) * 1.5 - 3, 6 * 1.5 - 3,
      9 * 1.5 - 3, 10 * 1.5 - 3,
    ]);
    const last = log[log.length - 1];
    expect(last).toBe(`bytes=${imgStart + 16}-${imgStart + 48 - 1}`);
    await expect(readImageBlock('mem://a', h, 0, 5, 0, 1)).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('applies BSCALE/BZERO to integer images', async () => {
    const f = new Uint8Array(2880 * 2);
    f.set(headerBytes([kv('SIMPLE', 'T'), kv('BITPIX', '16'), kv('NAXIS', '2'), kv('NAXIS1', '2'), kv('NAXIS2', '1'),
      kv('BSCALE', '2.0'), kv('BZERO', '10.0')]), 0);
    new DataView(f.buffer).setInt16(2880, -3, false);
    new DataView(f.buffer).setInt16(2882, 5, false);
    setFetch(rangeFetch(f));
    const hdus = await walkHdus('mem://int');
    const blk = await readImageBlock('mem://int', hdus[0], 0, 2, 0, 1);
    expect(Array.from(blk)).toEqual([4, 20]);
  });

  it('readHduData returns whole data block and counts bytes', async () => {
    const h = await getHdu('mem://a', 'FLAGS');
    const before = bytesTransferred();
    const d = await readHduData('mem://a', h);
    expect(d.length).toBe(180);
    expect(d[5]).toBe(5);
    expect(bytesTransferred() - before).toBe(180);
  });

  it('uses extra range reads for headers beyond the first chunk', async () => {
    // big primary data (empty IMAGE of 100 KB) pushes next header past 64 KB
    const big = 100 * 1024;
    const h0 = headerBytes([kv('SIMPLE', 'T'), kv('BITPIX', '8'), kv('NAXIS', '1'), kv('NAXIS1', String(big))]);
    const h1 = headerBytes([kv('XTENSION', "'IMAGE'"), kv('BITPIX', '8'), kv('NAXIS', '0'), kv('EXTNAME', "'SECOND'")]);
    const f = new Uint8Array(h0.length + pad(big) + h1.length);
    f.set(h0, 0);
    f.set(h1, h0.length + pad(big));
    const l: string[] = [];
    setFetch(rangeFetch(f, l));
    const hdus = await walkHdus('mem://big');
    expect(hdus.map((x) => x.extname)).toEqual(['', 'SECOND']);
    expect(l.length).toBe(2);
    expect(hdus[1].headerStart).toBe(h0.length + pad(big));
  });
});

describe('readRange retry and abort', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries 503 then succeeds', async () => {
    let n = 0;
    const retries: Array<[number, number]> = [];
    setFetch((async () => {
      n++;
      if (n < 3) return new Response('busy', { status: 503 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'Content-Range': 'bytes 0-2/3' } });
    }) as typeof fetch);
    const p = readRange('mem://r', 0, 3, { onRetry: (a, s) => retries.push([a, s]) });
    await vi.advanceTimersByTimeAsync(10000);
    expect(Array.from(await p)).toEqual([1, 2, 3]);
    expect(n).toBe(3);
    expect(retries).toEqual([[1, 503], [2, 503]]);
  });

  it('throws UPSTREAM_BUSY after 5 attempts of 503', async () => {
    let n = 0;
    setFetch((async () => {
      n++;
      return new Response('busy', { status: 503 });
    }) as typeof fetch);
    const p = readRange('mem://r', 0, 3);
    const assertion = expect(p).rejects.toMatchObject({ code: 'UPSTREAM_BUSY' });
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
    expect(n).toBe(5);
  });

  it('throws UPSTREAM_ERROR on 404 without retry', async () => {
    let n = 0;
    setFetch((async () => {
      n++;
      return new Response('no', { status: 404 });
    }) as typeof fetch);
    await expect(readRange('mem://r', 0, 3)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(n).toBe(1);
  });

  it('slices when the server answers 200 with the full body', async () => {
    setFetch((async () => new Response(new Uint8Array([0, 1, 2, 3, 4, 5]), { status: 200 })) as typeof fetch);
    expect(Array.from(await readRange('mem://r', 2, 4))).toEqual([2, 3]);
  });

  it('aborts during backoff', async () => {
    setFetch((async () => new Response('busy', { status: 503 })) as typeof fetch);
    const ac = new AbortController();
    const p = readRange('mem://r', 0, 3, { signal: ac.signal });
    const assertion = expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    await assertion;
  });

  it('aborts when the signal is already aborted', async () => {
    setFetch((async () => new Response('x', { status: 206 })) as typeof fetch);
    const ac = new AbortController();
    ac.abort();
    await expect(readRange('mem://r', 0, 3, { signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('clears the walkHdus cache on failure', async () => {
    setFetch((async () => new Response('no', { status: 404 })) as typeof fetch);
    await expect(walkHdus('mem://fail')).rejects.toBeTruthy();
    const { file } = buildMef();
    setFetch(rangeFetch(file));
    expect((await walkHdus('mem://fail')).length).toBe(3);
  });
});

// ---- onBytes and the fast header path -------------------------------------------------------

function imageExt(name: string, fill: number, extraCards = 0): Uint8Array[] {
  const cards = [
    kv('XTENSION', "'IMAGE   '"), kv('BITPIX', '-32'), kv('NAXIS', '2'), kv('NAXIS1', '4'), kv('NAXIS2', '3'),
    kv('PCOUNT', '0'), kv('GCOUNT', '1'), kv('EXTNAME', `'${name}'`),
  ];
  for (let i = 0; i < extraCards; i++) cards.push('COMMENT padding ' + i);
  const hdr = headerBytes(cards);
  const data = new Uint8Array(pad(48));
  const dv = new DataView(data.buffer);
  for (let i = 0; i < 12; i++) dv.setFloat32(i * 4, fill + i, false);
  return [hdr, data];
}

function tableExt(name: string, rows: number, rowLen: number, pcount: number): Uint8Array[] {
  const hdr = headerBytes([
    kv('XTENSION', "'BINTABLE'"), kv('BITPIX', '8'), kv('NAXIS', '2'), kv('NAXIS1', String(rowLen)),
    kv('NAXIS2', String(rows)), kv('PCOUNT', String(pcount)), kv('GCOUNT', '1'), kv('EXTNAME', `'${name}'`),
  ]);
  const data = new Uint8Array(pad(rows * rowLen + pcount));
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + name.length) & 255;
  return [hdr, data];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const PRIMARY = (): Uint8Array =>
  headerBytes([kv('SIMPLE', 'T'), kv('BITPIX', '8'), kv('NAXIS', '0'), kv('EXTEND', 'T')]);

/** PRIMARY, IMAGE, FLAGS (variable), VARIANCE, ZODI, EPSF, WCS-WAVE: the real layout, tiny. */
function buildLevel2(
  order: string[] = ['IMAGE', 'FLAGS', 'VARIANCE', 'ZODI', 'EPSF', 'WCS-WAVE'],
  extHeaderCards = 130, // VARIANCE and ZODI headers of 11520 bytes, as in the real files
): Uint8Array {
  const parts = [PRIMARY()];
  for (const n of order) {
    if (n === 'FLAGS') parts.push(...tableExt('FLAGS', 6, 8, 300));
    else if (n === 'EPSF') parts.push(...tableExt('EPSF', 10, 40, 0));
    else if (n === 'WCS-WAVE') parts.push(...tableExt('WCS-WAVE', 1, 700, 0));
    else parts.push(...imageExt(n, n.length * 100, n === 'IMAGE' ? 0 : extHeaderCards));
  }
  return concat(parts);
}

/** Range fetch that also understands the suffix form bytes=-N. */
function suffixFetch(file: Uint8Array, log: string[], mode: 'full' | 'noContentRange' | 'ignoreSuffix' = 'full'): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>)?.Range ?? '';
    log.push(range);
    const suf = /^bytes=-(\d+)$/.exec(range);
    if (suf) {
      if (mode === 'ignoreSuffix') return new Response(file.slice(), { status: 200 });
      const n = Math.min(Number(suf[1]), file.length);
      const a = file.length - n;
      return new Response(file.slice(a), {
        status: 206,
        headers: mode === 'full' ? { 'Content-Range': `bytes ${a}-${file.length - 1}/${file.length}` } : {},
      });
    }
    const m = /bytes=(\d+)-(\d+)/.exec(range)!;
    const s = Number(m[1]);
    const e = Math.min(Number(m[2]), file.length - 1);
    if (s >= file.length) return new Response('', { status: 416 });
    return new Response(file.slice(s, e + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${s}-${e}/${file.length}` },
    });
  }) as typeof fetch;
}

describe('onBytes', () => {
  it('reports each response body length, 206 and 200 alike', async () => {
    const got: number[] = [];
    setFetch((async () => new Response(new Uint8Array(100), { status: 200 })) as typeof fetch);
    await readRange('mem://ob', 10, 30, { onBytes: (n) => got.push(n) });
    setFetch((async () => new Response(new Uint8Array(7), { status: 206 })) as typeof fetch);
    await readRange('mem://ob', 0, 7, { onBytes: (n) => got.push(n) });
    expect(got).toEqual([100, 7]); // a 200 counts the full body that crossed the wire
  });

  it('does not report a 416', async () => {
    const got: number[] = [];
    setFetch((async () => new Response('', { status: 416 })) as typeof fetch);
    await readRange('mem://ob', 10, 30, { onBytes: (n) => got.push(n) });
    expect(got).toEqual([]);
  });

  it('counts the walk and matches bytesTransferred', async () => {
    const file = buildLevel2();
    setFetch(rangeFetch(file));
    clearHeaderCaches();
    let n = 0;
    const before = bytesTransferred();
    await walkHdus('mem://ob2', { onBytes: (b) => { n += b; } });
    expect(n).toBeGreaterThan(0);
    expect(bytesTransferred() - before).toBe(n);
  });
});

describe('fast header path', () => {
  const file = buildLevel2();
  let log: string[];
  beforeEach(() => {
    log = [];
    clearHeaderCaches();
    setFetch(suffixFetch(file, log));
  });

  async function walkOf(f: Uint8Array): Promise<Awaited<ReturnType<typeof walkHdus>>> {
    setFetch(suffixFetch(f, []));
    const h = await walkHdus('mem://walk-' + f.length);
    setFetch(suffixFetch(f, log));
    return h;
  }

  it('gives the same HDUs as the full walk without reading the rest', async () => {
    const hdus = await walkOf(file);
    const url = 'mem://fast';
    for (const name of ['IMAGE', 'FLAGS', 'VARIANCE', 'ZODI']) {
      expect(await getHdu(url, name)).toEqual(hdus.find((h) => h.extname === name));
    }
    // IMAGE, FLAGS, VARIANCE and ZODI (the latter guessed in parallel) are four small reads
    expect(log.length).toBe(4);
    expect(log.every((r) => /^bytes=\d+-\d+$/.test(r))).toBe(true);
    const epsf = hdus.find((h) => h.extname === 'EPSF')!;
    expect(log.some((r) => r.startsWith(`bytes=${epsf.headerStart}-`))).toBe(false);
  });

  it('still returns the right ZODI when the parallel guess misses (short headers)', async () => {
    const short = buildLevel2(undefined, 0);
    const ref = await walkOf(short);
    setFetch(suffixFetch(short, log));
    expect(await getHdu('mem://short', 'ZODI')).toEqual(ref.find((h) => h.extname === 'ZODI'));
    expect(log.length).toBe(5); // one wasted guess
  });

  it('caches per URL and does not refetch', async () => {
    await getHdu('mem://c', 'ZODI');
    const n = log.length;
    await getHdu('mem://c', 'FLAGS');
    await getHdu('mem://c', 'IMAGE');
    expect(log.length).toBe(n);
  });

  it('suffix read finds WCS-WAVE and equals the walk (offsets relative when the size is unknown)', async () => {
    const hdus = await walkOf(file);
    const wave = hdus.find((h) => h.extname === 'WCS-WAVE')!;
    const t = await readWaveTail('mem://t1');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^bytes=-\d+$/);
    expect({ ...t.hdu, index: wave.index }).toEqual(wave);
    expect(t.hdu.index).toBe(-1);
    expect(t.fileSize).toBe(file.length);
    expect(Array.from(t.data)).toEqual(Array.from(file.subarray(wave.dataStart, wave.dataStart + wave.dataBytes)));
    clearHeaderCaches();
    setFetch(suffixFetch(file, log, 'noContentRange'));
    const u = await readWaveTail('mem://t2');
    expect(u.fileSize).toBeNull();
    expect(u.hdu.dataStart).toBe(wave.dataStart - file.length);
    expect(u.hdu.headerStart).toBe(wave.headerStart - file.length);
    expect(Array.from(u.data)).toEqual(Array.from(t.data));
    expect(u.hdu.header).toEqual(wave.header);
  });

  it('a server that ignores the suffix range (200, full body) still works', async () => {
    setFetch(suffixFetch(file, log, 'ignoreSuffix'));
    const t = await readWaveTail('mem://t3');
    expect(t.hdu.extname).toBe('WCS-WAVE');
    expect(t.data.length).toBe(700);
  });

  it('falls back to the full walk when WCS-WAVE is not last', async () => {
    const odd = buildLevel2(['IMAGE', 'FLAGS', 'VARIANCE', 'ZODI', 'WCS-WAVE', 'EPSF']);
    setFetch(suffixFetch(odd, log));
    const t = await readWaveTail('mem://t4');
    expect(t.hdu.extname).toBe('WCS-WAVE');
    expect(t.hdu.index).toBe(5);
    expect(t.data.length).toBe(700);
    expect(t.fileSize).toBe(odd.length);
  });

  it('falls back to the walk when the order differs (ZODI before VARIANCE)', async () => {
    const odd = buildLevel2(['IMAGE', 'FLAGS', 'ZODI', 'VARIANCE', 'EPSF', 'WCS-WAVE']);
    const ref = await walkOf(odd);
    setFetch(suffixFetch(odd, log));
    for (const name of ['IMAGE', 'FLAGS', 'VARIANCE', 'ZODI']) {
      expect(await getHdu('mem://odd', name)).toEqual(ref.find((h) => h.extname === name));
    }
  });

  it('falls back when VARIANCE is missing', async () => {
    const odd = buildLevel2(['IMAGE', 'FLAGS', 'EPSF', 'WCS-WAVE']);
    setFetch(suffixFetch(odd, log));
    await expect(getHdu('mem://miss', 'VARIANCE')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await getHdu('mem://miss', 'EPSF')).extname).toBe('EPSF');
  });

  it('doubles the first read when the IMAGE header is longer than 32 KB', async () => {
    const cards: string[] = [
      kv('XTENSION', "'IMAGE   '"), kv('BITPIX', '-32'), kv('NAXIS', '2'), kv('NAXIS1', '4'), kv('NAXIS2', '3'),
      kv('PCOUNT', '0'), kv('GCOUNT', '1'), kv('EXTNAME', "'IMAGE   '"),
    ];
    for (let i = 0; i < 500; i++) cards.push('COMMENT padding card ' + i);
    const hdr = headerBytes(cards);
    expect(hdr.length).toBeGreaterThan(32 * 1024);
    const f = concat([PRIMARY(), hdr, new Uint8Array(pad(48)), ...tableExt('FLAGS', 6, 8, 300)]);
    setFetch(suffixFetch(f, log));
    const h = await getHdu('mem://long', 'IMAGE');
    expect(h.extname).toBe('IMAGE');
    expect(h.headerStart).toBe(2880);
    expect(h.dataStart).toBe(2880 + hdr.length);
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it('counts header bytes through onBytes', async () => {
    let n = 0;
    const before = bytesTransferred();
    await getHdu('mem://by', 'ZODI', { onBytes: (b) => { n += b; } });
    expect(n).toBeGreaterThan(0);
    expect(bytesTransferred() - before).toBe(n);
  });

  it('clears a failed stage so a retry works', async () => {
    setFetch((async () => new Response('no', { status: 404 })) as typeof fetch);
    await expect(getHdu('mem://rt', 'IMAGE')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    setFetch(suffixFetch(file, log));
    expect((await getHdu('mem://rt', 'IMAGE')).extname).toBe('IMAGE');
  });
});
