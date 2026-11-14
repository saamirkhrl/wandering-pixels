import { afterEach, describe, expect, it, vi } from 'vitest';
import { gaiaCone } from './gaia';

afterEach(() => vi.unstubAllGlobals());

describe('gaiaCone', () => {
  it('keeps source_id a string and maps fields', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      count: 1,
      stars: [{ source_id: '4472832130942575872', ra: 269.4, dec: 4.7, pmra: -802.8, pmdec: 10362.5, parallax: 546.9, phot_g_mean_mag: 8.2 }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    const out = await gaiaCone(269.4, 4.7, 1200);
    expect(out[0].sourceId).toBe('4472832130942575872');
    expect(typeof out[0].sourceId).toBe('string');
    expect(out[0].gmag).toBe(8.2);
    expect(String(f.mock.calls[0][0])).toContain('radius=900');
  });
  it('passes variable through and leaves it undefined when absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      stars: [
        { source_id: '1', ra: 1, dec: 2, pmra: null, pmdec: null, parallax: null, phot_g_mean_mag: 9, variable: true },
        { source_id: '2', ra: 1, dec: 2, pmra: null, pmdec: null, parallax: null, phot_g_mean_mag: 9, variable: false },
        { source_id: '3', ra: 1, dec: 2, pmra: null, pmdec: null, parallax: null, phot_g_mean_mag: 9, variable: null },
        { source_id: '4', ra: 1, dec: 2, pmra: null, pmdec: null, parallax: null, phot_g_mean_mag: 9 },
      ],
    }), { status: 200 })));
    const out = await gaiaCone(1, 2, 60);
    expect(out.map((s) => s.variable)).toEqual([true, false, null, undefined]);
  });
  it('rejects non-positive radius', async () => {
    await expect(gaiaCone(1, 2, 0)).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});
