// GET /api/gaia?ra=&dec=&radius=  - Gaia DR3 cone search relay (ESA TAP, positions at epoch 2016.0).
import { handler, numberParam, fetchUpstream, json, options, RelayError } from './_lib/http.js';
import { DEFAULT_RADIUS_ARCSEC, MAX_RADIUS_ARCSEC } from './_lib/upstreams.js';
import { gaiaFlagUrl, parseGaiaWithVariable } from './_lib/gaia.js';

export const GET = handler(async (url) => {
  const ra = numberParam(url.searchParams, 'ra', 0, 360);
  const dec = numberParam(url.searchParams, 'dec', -90, 90);
  const radius = numberParam(url.searchParams, 'radius', 0.01, MAX_RADIUS_ARCSEC, DEFAULT_RADIUS_ARCSEC);
  const res = await fetchUpstream(gaiaFlagUrl(ra, dec, radius), {
    init: { headers: { Accept: 'text/csv' } },
    attemptTimeoutMs: 20000,
    budgetMs: 25000,
  });
  if (!res.ok) throw new RelayError('UPSTREAM_ERROR', `Gaia archive returned HTTP ${res.status}`, 502);
  const stars = parseGaiaWithVariable(await res.text());
  return json({ count: stars.length, epoch: 2016, stars }, 200, 86400);
});

export function OPTIONS() {
  return options();
}
