// GET /api/exposures : SPHEREx Level 2 exposures covering a sky position (IRSA SIA2 relay).
//   ?collections=1                    list of collections
//   ?ra=&dec=&collection=<name>       one collection (handled failure is a 200 with ok:false)
//   ?ra=&dec=                         all collections merged (older form)
import { handler, numberParam, json, jsonCached, options, RelayError } from './_lib/http.js';
import { COLLECTIONS, dedupe } from './_lib/sia.js';
import { queryOneCollection } from './_lib/sia-query.js';

const CACHE_SECONDS = 21600;

const TOTAL_BUDGET_MS = 25000;
// Optional collections (qr2, the deep ones) answer in under a second when healthy, so they get a
// short budget and never hold up the response.
const OPTIONAL_BUDGET_MS = 9000;
// A single-collection request retries quickly inside this total budget.
const SINGLE_BUDGET_MS = 8000;
// Once one required collection has answered, the other gets this long to follow before the
// response is sent without it (listed in `partial`). Keeps a flaky collection from costing 25 s.
const GRACE_MS = 10000;

const LIST_CACHE = 'public, s-maxage=86400, max-age=86400';
const SINGLE_CACHE = 'public, s-maxage=86400, max-age=3600';

function readPosition(url) {
  const ra = numberParam(url.searchParams, 'ra', 0, 360);
  if (ra >= 360) throw new RelayError('BAD_INPUT', 'parameter ra must be between 0 and 360', 400);
  const dec = numberParam(url.searchParams, 'dec', -90, 90);
  return { ra, dec };
}

async function singleCollection(url, name) {
  if (!COLLECTIONS.some((c) => c.name === name)) {
    throw new RelayError('BAD_INPUT', 'unknown collection', 400);
  }
  const { ra, dec } = readPosition(url);
  try {
    const rows = await queryOneCollection(name, ra, dec, SINGLE_BUDGET_MS);
    const exposures = dedupe(rows);
    return jsonCached(
      { ok: true, collection: name, ra: Number(ra.toFixed(6)), dec: Number(dec.toFixed(6)), count: exposures.length, exposures },
      SINGLE_CACHE,
    );
  } catch (e) {
    // A handled state, not a server error: the client retries this collection later.
    const message = e instanceof RelayError ? e.message : 'upstream failed';
    return json({ ok: false, collection: name, retryable: true, message }, 200, 0);
  }
}

const run = handler(async (url) => {
  if (url.searchParams.get('collections') === '1') {
    return jsonCached({ collections: COLLECTIONS.map((c) => ({ name: c.name, required: c.required })) }, LIST_CACHE);
  }
  const wanted = url.searchParams.get('collection');
  if (wanted !== null) return singleCollection(url, wanted);

  const { ra, dec } = readPosition(url);

  const stop = new AbortController();
  let graceTimer = null;
  const settled = await Promise.allSettled(
    COLLECTIONS.map((c) =>
      queryOneCollection(c.name, ra, dec, c.required ? TOTAL_BUDGET_MS : OPTIONAL_BUDGET_MS, stop.signal).then((v) => {
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
