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
});
