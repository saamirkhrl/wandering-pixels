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
  it('rejects non-positive radius', async () => {
    await expect(gaiaCone(1, 2, 0)).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});
