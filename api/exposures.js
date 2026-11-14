// GET /api/exposures?ra=&dec= : SPHEREx Level 2 exposures covering a sky position (IRSA SIA2 relay).
import { handler, numberParam, fetchUpstream, json, options, RelayError } from './_lib/http.js';
import { COLLECTIONS, buildSiaUrl, parseVotable, queryStatus, rowsToExposures, dedupe } from './_lib/sia.js';

const CACHE_SECONDS = 21600;

const TOTAL_BUDGET_MS = 25000;
// Optional collections (qr2, the deep ones) answer in under a second when healthy, so they get a
// short budget and never hold up the response.
const OPTIONAL_BUDGET_MS = 9000;
// IRSA's front end often answers 502 within 0.3 s and succeeds on the next try, so retry quickly.
const MAX_ATTEMPTS = 6;
// Once one required collection has answered, the other gets this long to follow before the
// response is sent without it (listed in `partial`). Keeps a flaky collection from costing 25 s.
const GRACE_MS = 10000;
const BACKOFF_MS = 300;

/** One fetch plus body read; the body read can fail separately from the headers. */
async function fetchOnce(collection, ra, dec, deadline, signal) {
  const res = await fetchUpstream(buildSiaUrl(collection, ra, dec, 5000), {
    init: { headers: { Accept: 'application/x-votable+xml, text/xml' } },
    attemptTimeoutMs: 15000,
    maxAttempts: MAX_ATTEMPTS,
    backoffMs: BACKOFF_MS,
    signal,
    budgetMs: Math.max(deadline - Date.now(), 1000),
  });
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new RelayError('UPSTREAM_ERROR', `${collection} returned HTTP ${res.status}`, 502);
  }
  return res.text();
}

/** @param {string} collection @param {number} ra @param {number} dec @param {number} budgetMs @param {AbortSignal} signal */
async function queryCollection(collection, ra, dec, budgetMs, signal) {
  const deadline = Date.now() + budgetMs;
  let xml = '';
  for (let attempt = 0; ; attempt++) {
    try {
      xml = await fetchOnce(collection, ra, dec, deadline, signal);
      break;
    } catch (e) {
      // RelayErrors already went through retries; a stalled body read gets one more try.
      if (e instanceof RelayError) throw e;
      if (signal.aborted || attempt >= 1 || deadline - Date.now() < 4000) {
        throw new RelayError('UPSTREAM_ERROR', `${collection} response could not be read`, 502);
      }
    }
  }
  if (queryStatus(xml) === 'ERROR') {
    throw new RelayError('UPSTREAM_ERROR', `${collection} reported a query error`, 502);
  }
  return rowsToExposures(parseVotable(xml));
}

const run = handler(async (url) => {
  const ra = numberParam(url.searchParams, 'ra', 0, 360);
  if (ra >= 360) throw new RelayError('BAD_INPUT', 'parameter ra must be between 0 and 360', 400);
  const dec = numberParam(url.searchParams, 'dec', -90, 90);

  const stop = new AbortController();
  let graceTimer = null;
  const settled = await Promise.allSettled(
    COLLECTIONS.map((c) =>
      queryCollection(c.name, ra, dec, c.required ? TOTAL_BUDGET_MS : OPTIONAL_BUDGET_MS, stop.signal).then((v) => {
        if (c.required && !graceTimer) graceTimer = setTimeout(() => stop.abort(), GRACE_MS);
        return v;
      }),
    ),
  );
  clearTimeout(graceTimer ?? undefined);

  // A collection that failed is listed in `partial`. Only when every required collection failed is
  // the whole answer an error, because then there is nothing trustworthy to show.
  const partial = [];
  const all = [];
  let requiredOk = 0;
  let requiredFailure = null;
  settled.forEach((r, i) => {
    const c = COLLECTIONS[i];
    if (r.status === 'fulfilled') {
      all.push(...r.value);
      if (c.required) requiredOk++;
      return;
    }
    partial.push(c.name);
    if (c.required) {
      const busy = r.reason instanceof RelayError && r.reason.code === 'UPSTREAM_BUSY';
      if (!requiredFailure || busy) requiredFailure = r.reason;
    }
  });
  if (requiredOk === 0) {
    throw requiredFailure instanceof RelayError
      ? requiredFailure
      : new RelayError('UPSTREAM_ERROR', 'upstream failed', 502);
  }

  const exposures = dedupe(all);
  // A partial answer must not be cached (edge or browser) so that a retry reaches IRSA again.
  return json(
    { ra: Number(ra.toFixed(6)), dec: Number(dec.toFixed(6)), count: exposures.length, partial, exposures },
    200,
    partial.length > 0 ? 0 : CACHE_SECONDS,
  );
});

export async function GET(request) {
  return run(request);
}

export function OPTIONS() {
  return options();
}
