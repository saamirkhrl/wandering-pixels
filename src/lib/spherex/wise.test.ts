import { afterEach, describe, expect, it, vi } from 'vitest';
import { wiseCone } from './wise';

afterEach(() => vi.unstubAllGlobals());

describe('wiseCone', () => {
  it('maps sources and nulls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      count: 1, catalog: 'catwise2020', epoch: 2015.4,
      sources: [{ id: 'J1', ra: 1, dec: 2, pmra: 5, pmdec: null, w1mag: 14.1, w2mag: null }],
    }), { status: 200 })));
    const out = await wiseCone(1, 2, 60);
    expect(out).toEqual([{ id: 'J1', ra: 1, dec: 2, pmra: 5, pmdec: null, w1mag: 14.1, w2mag: null }]);
  });
  it('rejects bad dec', async () => {
    await expect(wiseCone(1, 100, 60)).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
  it('retries once after ok:false and then succeeds', async () => {
    vi.useFakeTimers();
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, retryable: true, message: 'busy' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        count: 1, sources: [{ id: 'J1', ra: 1, dec: 2, pmra: null, pmdec: null, w1mag: 1, w2mag: 2 }],
      }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    const p = wiseCone(1, 2, 60);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await p).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
  it('throws UPSTREAM_BUSY after the one retry also fails (network error then ok:false)', async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockImplementation(async () => { throw new TypeError('down'); });
    vi.stubGlobal('fetch', f);
    const caught = wiseCone(1, 2, 60).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await caught).toMatchObject({ code: 'UPSTREAM_BUSY' });
    vi.useRealTimers();
  });
  it('abort during the retry wait rejects with ABORTED', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ ok: false }), { status: 200 })));
    const ctl = new AbortController();
    const caught = wiseCone(1, 2, 60, { signal: ctl.signal }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(500);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(await caught).toMatchObject({ code: 'ABORTED' });
    vi.useRealTimers();
  });
});
