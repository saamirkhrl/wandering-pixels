import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, relayUrl, setRelayBase } from './net';
import type { Progress } from './types';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setRelayBase('');
});

describe('relayUrl', () => {
  it('builds same-origin and based urls', () => {
    expect(relayUrl('/api/x', { a: 1, b: 'c d' })).toBe('/api/x?a=1&b=c%20d');
    setRelayBase('https://r.example/');
    expect(relayUrl('api/x', { a: 1 })).toBe('https://r.example/api/x?a=1');
  });
});

describe('fetchJson', () => {
  it('retries on 503 then succeeds, reporting retrying', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(503, { error: { code: 'UPSTREAM_BUSY', message: 'busy' } }))
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    vi.stubGlobal('fetch', f);
    const seen: Progress[] = [];
    const p = fetchJson<{ ok: number }>('/x', { onProgress: (q) => seen.push(q) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(seen.some((q) => q.retrying === true)).toBe(true);
  });

  it('503 x4 -> UPSTREAM_BUSY', async () => {
    const f = vi.fn().mockImplementation(async () => json(503, {}));
    vi.stubGlobal('fetch', f);
    const p = fetchJson('/x');
    const assertion = expect(p).rejects.toMatchObject({ code: 'UPSTREAM_BUSY' });
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('abort during backoff -> ABORTED promptly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json(503, {})));
    const ctl = new AbortController();
    const p = fetchJson('/x', { signal: ctl.signal });
    const assertion = expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.advanceTimersByTimeAsync(100);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });

  it('400 -> BAD_INPUT without retry', async () => {
    const f = vi.fn().mockResolvedValue(json(400, { error: { code: 'BAD_INPUT', message: 'bad ra' } }));
    vi.stubGlobal('fetch', f);
    await expect(fetchJson('/x')).rejects.toMatchObject({ code: 'BAD_INPUT', message: 'bad ra' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('404 -> NOT_FOUND, bad JSON -> UPSTREAM_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(404, {})));
    await expect(fetchJson('/x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    await expect(fetchJson('/x')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});
