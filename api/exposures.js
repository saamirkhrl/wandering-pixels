// GET /api/exposures?ra=&dec= : SPHEREx Level 2 exposures covering a sky position (IRSA SIA2 relay).
import { handler, numberParam, fetchUpstream, json, options, RelayError } from './_lib/http.js';
import { COLLECTIONS, buildSiaUrl, parseVotable, queryStatus, rowsToExposures, dedupe } from './_lib/sia.js';

const CACHE_SECONDS = 21600;

const TOTAL_BUDGET_MS = 25000;

/** One fetch plus body read; the body read can fail separately from the headers. */
async function fetchOnce(collection, ra, dec, deadline) {
  const res = await fetchUpstream(buildSiaUrl(collection, ra, dec, 5000), {
    init: { headers: { Accept: 'application/x-votable+xml, text/xml' } },
    attemptTimeoutMs: 15000,
    budgetMs: Math.max(deadline - Date.now(), 1000),
  });
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new RelayError('UPSTREAM_ERROR', `${collection} returned HTTP ${res.status}`, 502);
  }
  return res.text();
}

/** @param {string} collection @param {number} ra @param {number} dec */
async function queryCollection(collection, ra, dec) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let xml = '';
  for (let attempt = 0; ; attempt++) {
    try {
      xml = await fetchOnce(collection, ra, dec, deadline);
      break;
    } catch (e) {
      // RelayErrors already went through retries; a stalled body read gets one more try.
      if (e instanceof RelayError) throw e;
      if (attempt >= 1 || deadline - Date.now() < 4000) {
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

  const settled = await Promise.allSettled(COLLECTIONS.map((c) => queryCollection(c.name, ra, dec)));

  const partial = [];
  const all = [];
  let requiredFailure = null;
  settled.forEach((r, i) => {
    const c = COLLECTIONS[i];
    if (r.status === 'fulfilled') {
      all.push(...r.value);
    } else if (c.required) {
      const busy = r.reason instanceof RelayError && r.reason.code === 'UPSTREAM_BUSY';
      if (!requiredFailure || busy) requiredFailure = r.reason;
    } else {
      partial.push(c.name);
    }
  });
  if (requiredFailure) {
    throw requiredFailure instanceof RelayError
      ? requiredFailure
      : new RelayError('UPSTREAM_ERROR', 'upstream failed', 502);
  }

  const exposures = dedupe(all);
  return json(
    { ra: Number(ra.toFixed(6)), dec: Number(dec.toFixed(6)), count: exposures.length, partial, exposures },
    200,
    CACHE_SECONDS,
  );
});

export async function GET(request) {
  return run(request);
}

export function OPTIONS() {
  return options();
}
