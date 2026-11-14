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
  // Handled failure: a 200 with ok:false and no-store, so the client can retry without an error log.
  const failed = (message) => json({ ok: false, retryable: true, message }, 200, 0);
  let res;
  try {
    // IRSA's front end often 502s in under a second and then succeeds, so retry quickly.
    res = await fetchUpstream(wiseUrl(ra, dec, radius, cat), {
      init: { headers: { Accept: 'text/csv' } },
      attemptTimeoutMs: 22000,
      budgetMs: 25000,
      maxAttempts: 5,
      backoffMs: 300,
    });
  } catch (e) {
    return failed(e instanceof RelayError ? e.message : 'IRSA failed');
  }
  if (!res.ok) return failed(`IRSA returned HTTP ${res.status}`);
  let text;
  try {
    text = await res.text();
  } catch {
    return failed('IRSA was too slow for this radius, try a smaller one');
  }
  let sources;
  try {
    sources = parseWise(text, cat);
  } catch {
    return failed('IRSA returned an unreadable answer');
  }
  return json({ count: sources.length, catalog: cat, epoch: WISE_CATALOGS[cat].epoch, sources }, 200, 86400);
});

export function OPTIONS() {
  return options();
}
