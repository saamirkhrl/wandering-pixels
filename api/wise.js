// GET /api/wise?ra=&dec=&radius=[&catalog=catwise2020|allwise]  - WISE cone search relay (IRSA SCS).
import { handler, numberParam, fetchUpstream, json, options, RelayError } from './_lib/http.js';
import { wiseUrl, parseWise, WISE_CATALOGS, DEFAULT_RADIUS_ARCSEC, MAX_RADIUS_ARCSEC } from './_lib/upstreams.js';

const WISE_MAX_RADIUS_ARCSEC = 300;

export const GET = handler(async (url) => {
  const ra = numberParam(url.searchParams, 'ra', 0, 360);
  const dec = numberParam(url.searchParams, 'dec', -90, 90);
  // IRSA SCS time grows with row count; above ~300 arcsec dense fields overrun the budget, so clamp.
  const radius = Math.min(numberParam(url.searchParams, 'radius', 0.01, MAX_RADIUS_ARCSEC, DEFAULT_RADIUS_ARCSEC), WISE_MAX_RADIUS_ARCSEC);
  const cat = url.searchParams.get('catalog') ?? 'catwise2020';
  if (cat !== 'catwise2020' && cat !== 'allwise') {
    throw new RelayError('BAD_INPUT', 'catalog must be catwise2020 or allwise', 400);
  }
  const res = await fetchUpstream(wiseUrl(ra, dec, radius, cat), {
    init: { headers: { Accept: 'text/csv' } },
    attemptTimeoutMs: 22000,
    budgetMs: 25000,
  });
  if (!res.ok) throw new RelayError('UPSTREAM_ERROR', `IRSA returned HTTP ${res.status}`, 502);
  let text;
  try {
    text = await res.text();
  } catch {
    throw new RelayError('UPSTREAM_BUSY', 'IRSA was too slow for this radius, try a smaller one', 503);
  }
  const sources = parseWise(text, cat);
  return json({ count: sources.length, catalog: cat, epoch: WISE_CATALOGS[cat].epoch, sources }, 200, 86400);
});

export function OPTIONS() {
  return options();
}
