import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error plain JS module without type declarations
import * as exposures from '../exposures.js';
// @ts-expect-error plain JS module without type declarations
import * as wise from '../wise.js';

const req = (qs: string, path = 'exposures') => new Request(`http://localhost/api/${path}?${qs}`);

const VOTABLE_OK =
  '<VOTABLE><RESOURCE><INFO name="QUERY_STATUS" value="OK"/><TABLE>' +
  '<FIELD name="dataproduct_subtype"/><FIELD name="obs_id"/><FIELD name="energy_bandpassname"/>' +
  '<FIELD name="cloud_access"/><FIELD name="t_min"/><FIELD name="t_max"/>' +
  '<DATA><TABLEDATA><TR><TD>science</TD><TD>obs1</TD><TD>SPHEREx-D3</TD>' +
  '<TD>{"aws":{"key":"qr3/level2/a/b.fits"}}</TD><TD>61000.5</TD><TD>61000.6</TD></TR>' +
  '</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>';

afterEach(() => vi.unstubAllGlobals());

describe('exposures relay', () => {
  it('collections=1 lists the collections', async () => {
    const res = await exposures.GET(req('collections=1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=86400, max-age=86400');
    const body = await res.json();
    expect(body.collections).toHaveLength(5);
    expect(body.collections[0]).toEqual({ name: 'spherex_dr1', required: true });
  });

  it('single collection success carries the cache header and body', async () => {
    const f = vi.fn(async () => new Response(VOTABLE_OK, { status: 200 }));
    vi.stubGlobal('fetch', f);
    const res = await exposures.GET(req('ra=150.1&dec=2.2&collection=spherex_qr3'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=86400, max-age=3600');
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, collection: 'spherex_qr3', ra: 150.1, dec: 2.2, count: 1 });
    expect(body.exposures[0]).toMatchObject({ obsId: 'obs1', detector: 3, release: 'qr3' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('repeated upstream 502 gives a handled ok:false with no-store', async () => {
    const f = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    vi.stubGlobal('fetch', f);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await exposures.GET(req('ra=150.1&dec=2.2&collection=spherex_dr1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, collection: 'spherex_dr1', retryable: true });
    expect(typeof body.message).toBe('string');
    expect(f.mock.calls.length).toBeGreaterThan(1);
    expect(err).not.toHaveBeenCalled();
  }, 15000);

  it('unknown collection and bad position are 400', async () => {
    expect((await exposures.GET(req('ra=1&dec=2&collection=nope'))).status).toBe(400);
    expect((await exposures.GET(req('ra=999&dec=2&collection=spherex_dr1'))).status).toBe(400);
    expect((await exposures.GET(req('dec=2&collection=spherex_dr1'))).status).toBe(400);
  });

  it('old form keeps its shape including partial', async () => {
    vi.stubGlobal('fetch', async (u: string) =>
      String(u).includes('COLLECTION=spherex_qr3') && !String(u).includes('deep')
        ? new Response(VOTABLE_OK, { status: 200 })
        : new Response(VOTABLE_OK.replace('qr3/level2', 'dr1/level2'), { status: 200 }),
    );
    const res = await exposures.GET(req('ra=150.1&dec=2.2'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['count', 'dec', 'exposures', 'partial', 'ra']);
    expect(body.partial).toEqual([]);
    expect(body.count).toBeGreaterThan(0);
  });
});

describe('wise relay', () => {
  it('upstream failure is a handled ok:false with no-store', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 502 })));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await wise.GET(req('ra=10&dec=10&radius=30', 'wise'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ ok: false, retryable: true });
    expect(err).not.toHaveBeenCalled();
  }, 15000);

  it('success body is unchanged', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('source_name,ra,dec,pmra,pmdec,w1mpro,w2mpro\nJ1,10,10,0,0,9.5,9\n', { status: 200 }),
    );
    const body = await (await wise.GET(req('ra=10&dec=10&radius=30', 'wise'))).json();
    expect(body).toMatchObject({ count: 1, catalog: 'catwise2020' });
  });
});
