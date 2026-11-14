import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_STACK_EXPOSURES, assignVisits, findExposures, mjdToIso, resetCollectionsCache, rowsToExposures } from './search';
import type { ExposureRow } from './search';
import type { Exposure } from './types';

const row = (obsId: string, t: number, release: ExposureRow['release'] = 'dr1', detector = 2): ExposureRow => ({
  obsId, detector, tMin: t - 0.001, tMax: t + 0.001, url: `https://s3/${obsId}/${release}`, release,
});

afterEach(() => vi.unstubAllGlobals());

describe('mjdToIso', () => {
  it('converts MJD to UTC ISO', () => {
    // MJD 40587 is 1970-01-01, so 60902.5 is 20315.5 days later: 2025-08-15T12:00Z.
    expect(mjdToIso(60902.5)).toBe('2025-08-15T12:00:00.000Z');
    expect(mjdToIso(60907.5)).toBe('2025-08-20T12:00:00.000Z');
    expect(mjdToIso(40587)).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('assignVisits', () => {
  const mk = (mjd: number): Exposure => ({
    id: String(mjd), obsId: 'o', detector: 1, time: '', mjd, visitIndex: 0,
    wavelengthAtTarget: null, bandwidthAtTarget: null, url: '', release: 'dr1',
  });
  it('starts a new visit after a 31 day gap', () => {
    expect(assignVisits([mk(60000), mk(60031)]).map((e) => e.visitIndex)).toEqual([0, 1]);
  });
  it('splits a continuous run longer than 90 days into 60-day bins', () => {
    const days = [0, 20, 40, 59.9, 60, 80, 100, 119, 121];
    expect(assignVisits(days.map((d) => mk(60000 + d))).map((e) => e.visitIndex))
      .toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2]);
  });
  it('does not split a 90 day run, and bins restart after a real gap', () => {
    expect(assignVisits([mk(60000), mk(60025), mk(60050), mk(60075), mk(60090)]).map((e) => e.visitIndex))
      .toEqual([0, 0, 0, 0, 0]);
    expect(assignVisits([mk(60000), mk(60025), mk(60050), mk(60075), mk(60091), mk(60200), mk(60210)]).map((e) => e.visitIndex))
      .toEqual([0, 0, 0, 1, 1, 2, 2]);
  });
  it('keeps a 55 day visit whole', () => {
    expect(assignVisits([mk(60000), mk(60020), mk(60040), mk(60055)]).map((e) => e.visitIndex)).toEqual([0, 0, 0, 0]);
  });
  it('sorts unsorted input', () => {
    expect(assignVisits([mk(60040), mk(60000)]).map((e) => e.mjd)).toEqual([60000, 60040]);
  });
  it('keeps a 29 day gap in the same visit', () => {
    expect(assignVisits([mk(60000), mk(60029)]).map((e) => e.visitIndex)).toEqual([0, 0]);
  });
});

describe('rowsToExposures', () => {
  it('dedupes preferring dr1 > qr3 > qr2 and sorts by mjd', () => {
    const out = rowsToExposures([
      row('B', 60100, 'qr2'), row('B', 60100, 'qr3'), row('B', 60100, 'qr2'),
      row('A', 60000, 'qr2'), row('A', 60000, 'dr1'),
    ]);
    expect(out.map((e) => e.id)).toEqual(['AD2', 'BD2']);
    expect(out[0].release).toBe('dr1');
    expect(out[1].release).toBe('qr3');
    expect(out[0].wavelengthAtTarget).toBeNull();
    expect(out[1].visitIndex).toBe(1);
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const COLS = ['c1', 'c2', 'c3'];
const colsBody = { collections: COLS.map((name) => ({ name, required: false })) };

// Fake relay. `script[name]` is a list of behaviours consumed per request: rows, 'fail' (ok:false)
// or 'net' (rejected fetch). The last entry repeats.
type Beh = ExposureRow[] | 'fail' | 'net';
function fakeRelay(script: Record<string, Beh[]>, collectionsOk = true) {
  const calls: string[] = [];
  const counts: Record<string, number> = {};
  const f = vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://x');
    if (u.searchParams.get('collections')) {
      calls.push('collections');
      return collectionsOk ? json(colsBody) : json({ error: { code: 'UPSTREAM_ERROR', message: 'x' } }, 500);
    }
    const c = u.searchParams.get('collection');
    if (!c) {
      calls.push('all');
      return json({ ra: 1, dec: 2, count: 1, partial: [], exposures: [row('LEG', 60000)] });
    }
    calls.push(c);
    const list = script[c] ?? [[]];
    const n = counts[c] ?? 0;
    counts[c] = n + 1;
    const b = list[Math.min(n, list.length - 1)];
    if (b === 'net') throw new TypeError('network down');
    if (b === 'fail') return json({ ok: false, collection: c, retryable: true, message: 'busy' });
    return json({ ok: true, collection: c, count: b.length, exposures: b });
  });
  vi.stubGlobal('fetch', f);
  return { f, calls, counts };
}

describe('findExposures', () => {
  beforeEach(() => resetCollectionsCache());
  afterEach(() => vi.useRealTimers());

  it('throws NO_COVERAGE when every collection answers with zero rows', async () => {
    fakeRelay({ c1: [[]], c2: [[]], c3: [[]] });
    await expect(findExposures(1, 2)).rejects.toMatchObject({ code: 'NO_COVERAGE' });
  });
  it('rejects bad input', async () => {
    await expect(findExposures(NaN, 0)).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(findExposures(10, 95)).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
  it('returns merged exposures, dedups across collections and reports progress', async () => {
    const { counts } = fakeRelay({
      c1: [[row('A', 60000), row('B', 60001)]],
      c2: [[{ ...row('A', 60000), release: 'qr3' }]],
      c3: [[row('C', 60002)]],
    });
    const msgs: string[] = [];
    const onUpdate = vi.fn();
    const out = await findExposures(1, 2, { onProgress: (p) => msgs.push(p.message), onUpdate });
    expect(out.map((e) => e.obsId).sort()).toEqual(['A', 'B', 'C']);
    expect(counts).toEqual({ c1: 1, c2: 1, c3: 1 });
    expect(msgs[0]).toBe('Searching the SPHEREx archive');
    expect(msgs[msgs.length - 1]).toBe('Found 3 exposures');
  });
  it('memoises the collection list per session', async () => {
    const { calls } = fakeRelay({ c1: [[row('A', 60000)]], c2: [[]], c3: [[]] });
    await findExposures(1, 2);
    await findExposures(3, 4);
    expect(calls.filter((c) => c === 'collections')).toHaveLength(1);
  });
  it('resolves on a partial first round, then fills in through onUpdate, ending complete', async () => {
    vi.useFakeTimers();
    const { counts } = fakeRelay({
      c1: [[row('A', 60000)]],
      c2: ['fail', [row('B', 60001)]],
      c3: ['net', 'net', 'fail', [row('C', 60002)]], // net is retried once inside fetchJson
    });
    const events: string[] = [];
    const updates: Array<{ n: number; pending: string[]; complete: boolean }> = [];
    const msgs: string[] = [];
    const p = findExposures(1, 2, {
      onProgress: (x) => msgs.push(x.message),
      onUpdate: (ex, st) => {
        events.push('update');
        updates.push({ n: ex.length, pending: st.pending, complete: st.complete });
      },
    });
    const resolved = p.then((r) => { events.push('resolved'); return r; });
    await vi.advanceTimersByTimeAsync(500); // c3's network retry inside fetchJson
    const out = await resolved;
    expect(out).toHaveLength(1);
    expect(msgs).toContain('1 of 3 archive collections answered; still asking the rest');
    await vi.advanceTimersByTimeAsync(1100); // retry 1: c2 answers, c3 fails
    await vi.advanceTimersByTimeAsync(2100); // retry 2: c3 answers
    await vi.advanceTimersByTimeAsync(10);
    expect(events[0]).toBe('resolved');
    expect(updates).toEqual([
      { n: 2, pending: ['c3'], complete: false },
      { n: 3, pending: [], complete: true },
    ]);
    expect(counts).toEqual({ c1: 1, c2: 2, c3: 4 });
  });
  it('fires one final complete update when all answered in the first round', async () => {
    vi.useFakeTimers();
    fakeRelay({ c1: [[row('A', 60000)]], c2: [[]], c3: [[]] });
    const events: string[] = [];
    const out = await findExposures(1, 2, { onUpdate: (_e, st) => events.push(`update:${st.complete}`) });
    events.push('resolved');
    await vi.advanceTimersByTimeAsync(10);
    expect(out).toHaveLength(1);
    expect(events).toEqual(['resolved', 'update:true']);
  });
  it('reports complete false with the pending names when time runs out', async () => {
    vi.useFakeTimers();
    fakeRelay({ c1: [[row('A', 60000)]], c2: ['fail'], c3: [[]] });
    const updates: Array<{ pending: string[]; complete: boolean }> = [];
    const out = await findExposures(1, 2, {
      maxWaitMs: 5000, onUpdate: (_e, st) => updates.push({ pending: st.pending, complete: st.complete }),
    });
    expect(out).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(updates).toEqual([{ pending: ['c2'], complete: false }]);
  });
  it('throws UPSTREAM_BUSY when nothing ever answers within maxWaitMs', async () => {
    vi.useFakeTimers();
    const { f } = fakeRelay({ c1: ['fail'], c2: ['net'], c3: ['fail'] });
    const p = findExposures(1, 2, { maxWaitMs: 10000 });
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(11000);
    expect(await caught).toMatchObject({ code: 'UPSTREAM_BUSY' });
    const n = f.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.mock.calls.length).toBe(n);
  });
  it('keeps waiting while some collections answered empty and others are pending, then finds rows', async () => {
    vi.useFakeTimers();
    fakeRelay({ c1: [[]], c2: ['fail', [row('B', 60001)]], c3: [[]] });
    const p = findExposures(1, 2);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await p).toHaveLength(1);
  });
  it('resolves [] as NO_COVERAGE once all answered empty after retries', async () => {
    vi.useFakeTimers();
    fakeRelay({ c1: [[]], c2: ['fail', []], c3: [[]] });
    const caught = findExposures(1, 2).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await caught).toMatchObject({ code: 'NO_COVERAGE' });
  });
  it('abort stops background retries and later updates', async () => {
    vi.useFakeTimers();
    const { f } = fakeRelay({ c1: [[row('A', 60000)]], c2: ['fail'], c3: ['fail'] });
    const ctl = new AbortController();
    const onUpdate = vi.fn();
    const out = await findExposures(1, 2, { signal: ctl.signal, onUpdate });
    expect(out).toHaveLength(1);
    const n = f.mock.calls.length;
    ctl.abort();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.mock.calls.length).toBe(n);
    expect(onUpdate).not.toHaveBeenCalled();
  });
  it('abort before resolving rejects with ABORTED', async () => {
    vi.useFakeTimers();
    fakeRelay({ c1: ['fail'], c2: ['fail'], c3: ['fail'] });
    const ctl = new AbortController();
    const caught = findExposures(1, 2, { signal: ctl.signal }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(500);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(await caught).toMatchObject({ code: 'ABORTED' });
  });
  it('falls back to the old all-collections form when the collection list fails', async () => {
    vi.useFakeTimers();
    const { calls } = fakeRelay({}, false);
    const done: boolean[] = [];
    const p = findExposures(1, 2, { onUpdate: (_e, st) => done.push(st.complete) });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.filter((c) => c === 'all')).toHaveLength(1);
    expect(calls.filter((c) => /^c\d/.test(c))).toHaveLength(0);
    expect(done).toEqual([true]);
  });
});

describe('findExposures old-form fallback partial results', () => {
  const resp = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const stub = (all: Array<Response>) => {
    const f = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('collections=1')) return new Response('{}', { status: 500 });
      return all.shift() as Response;
    });
    vi.stubGlobal('fetch', f);
    return f;
  };
  beforeEach(() => resetCollectionsCache());
  afterEach(() => vi.useRealTimers());

  it('re-requests once; a complete second answer replaces the first', async () => {
    vi.useFakeTimers();
    const f = stub([
      resp({ partial: ['spherex_dr1'], exposures: [row('A', 60000)] }),
      resp({ partial: [], exposures: [row('A', 60000), row('B', 60001)] }),
    ]);
    const msgs: string[] = [];
    const p = findExposures(1, 2, { onProgress: (x) => msgs.push(x.message) });
    await vi.advanceTimersByTimeAsync(5000);
    const out = await p;
    expect(f.mock.calls.filter((c) => !String(c[0]).includes('collections=1'))).toHaveLength(2);
    expect(out).toHaveLength(2);
    expect(msgs).toContain('The archive is slow; showing a partial result');
  });
  it('keeps the first answer when the second is still partial, and asks only once more', async () => {
    vi.useFakeTimers();
    const f = stub([
      resp({ partial: ['spherex_qr3'], exposures: [row('A', 60000)] }),
      resp({ partial: ['spherex_qr3'], exposures: [row('A', 60000), row('B', 60001)] }),
    ]);
    const p = findExposures(1, 2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toHaveLength(1);
    expect(f.mock.calls.filter((c) => !String(c[0]).includes('collections=1'))).toHaveLength(2);
  });
});

describe('assignVisits fragments', () => {
  let n = 0;
  const mk = (mjd: number): Exposure => ({
    id: `e${n++}`, obsId: 'o', detector: 1, time: '', mjd, visitIndex: 0,
    wavelengthAtTarget: null, bandwidthAtTarget: null, url: '', release: 'dr1',
  });
  const run = (t0: number, count: number, step = 0.2) => Array.from({ length: count }, (_, i) => mk(t0 + i * step));
  const stack = (e: Exposure) => (e as { inStack?: boolean }).inStack;

  it('marks a small trailing sub-cluster out of stack and keeps one visit', () => {
    const out = assignVisits([...run(60000, 100), ...run(60035, 8)]);
    // 60000..60019.8 then 60035: gap 15.2 d < 30, one visit; sub-clusters 100 and 8.
    expect(new Set(out.map((e) => e.visitIndex))).toEqual(new Set([0]));
    expect(out.filter((e) => stack(e) === false).length).toBe(8);
  });
  it('keeps two large sub-clusters in stack', () => {
    const out = assignVisits([...run(60000, 20), ...run(60015, MIN_STACK_EXPOSURES)]);
    expect(out.every((e) => stack(e) === true)).toBe(true);
  });
  it('merges a tiny isolated visit into the nearest visit, out of stack', () => {
    const out = assignVisits([...run(60000, 50), ...run(60060, 3), ...run(60200, 50)]);
    const tiny = out.filter((e) => e.mjd >= 60060 && e.mjd < 60061);
    expect(tiny.every((e) => e.visitIndex === 0 && stack(e) === false)).toBe(true);
    expect(new Set(out.map((e) => e.visitIndex))).toEqual(new Set([0, 1]));
  });
  it('does not mark sub-clusters inside 60-day deep-field bins', () => {
    const many = Array.from({ length: 200 }, (_, i) => mk(60000 + i * 0.75 + (i % 10 === 0 ? 0 : 0)));
    const out = assignVisits(many);
    expect(out.every((e) => stack(e) === true)).toBe(true);
    expect(new Set(out.map((e) => e.visitIndex)).size).toBe(3);
  });

});
