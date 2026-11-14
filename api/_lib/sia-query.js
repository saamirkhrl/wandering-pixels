// One SIA2 collection query with quick in-function retries. Used by api/exposures.js.
import { fetchUpstream, RelayError } from './http.js';
import { buildSiaUrl, parseVotable, queryStatus, rowsToExposures } from './sia.js';

// IRSA's front end often answers 502 within 0.3 s and succeeds on the next try, so retry quickly
// (waits of 0.3, 0.6, 1.2, 2.4 s) instead of giving up or waiting long.
const MAX_ATTEMPTS = 5;
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

/**
 * Query one collection; returns exposure rows or throws RelayError.
 * @param {string} collection @param {number} ra @param {number} dec @param {number} budgetMs @param {AbortSignal} [signal]
 */
export async function queryOneCollection(collection, ra, dec, budgetMs, signal) {
  const deadline = Date.now() + budgetMs;
  let xml = '';
  for (let attempt = 0; ; attempt++) {
    try {
      xml = await fetchOnce(collection, ra, dec, deadline, signal);
      break;
    } catch (e) {
      // RelayErrors already went through retries; a stalled body read gets one more try.
      if (e instanceof RelayError) throw e;
      if (signal?.aborted || attempt >= 1 || deadline - Date.now() < 3000) {
        throw new RelayError('UPSTREAM_ERROR', `${collection} response could not be read`, 502);
      }
    }
  }
  if (queryStatus(xml) === 'ERROR') {
    throw new RelayError('UPSTREAM_ERROR', `${collection} reported a query error`, 502);
  }
  return rowsToExposures(parseVotable(xml));
}
