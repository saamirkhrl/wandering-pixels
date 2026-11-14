// GET /api/resolve?name=  - an unknown name answers 200 { found: false } (400 only for malformed names).
// Object name to ICRS J2000 position and proper motion.
// Sesame (CfA VizieR mirror) is primary because it answers in about 0.3 s and accepts the
// aliases people actually type; SIMBAD TAP is the fallback. Positions are epoch 2000.
import { handler, fetchUpstream, json, options, RelayError } from './_lib/http.js';
import { validateName, sesameUrl, simbadUrl, parseSesame, parseSimbad, resolveBody } from './_lib/upstreams.js';

async function viaSesame(name) {
  const res = await fetchUpstream(sesameUrl(name), { attemptTimeoutMs: 8000, budgetMs: 10000, maxAttempts: 2 });
  if (!res.ok) throw new RelayError('UPSTREAM_ERROR', `Sesame returned HTTP ${res.status}`, 502);
  return parseSesame(await res.text());
}

async function viaSimbad(name) {
  const res = await fetchUpstream(simbadUrl(name), { attemptTimeoutMs: 8000, budgetMs: 10000, maxAttempts: 2 });
  if (!res.ok) throw new RelayError('UPSTREAM_ERROR', `SIMBAD returned HTTP ${res.status}`, 502);
  return parseSimbad(await res.text());
}

export const GET = handler(async (url) => {
  const name = validateName(url.searchParams.get('name'));
  let hit = null;
  let source = 'sesame';
  let sesameFailure = null;
  try {
    hit = await viaSesame(name);
  } catch (e) {
    sesameFailure = e;
  }
  if (!hit) {
    try {
      hit = await viaSimbad(name);
      source = 'simbad';
    } catch (e) {
      // Sesame answered cleanly with no match: report not found even if SIMBAD is down.
      if (sesameFailure) throw sesameFailure;
    }
  }
  if (!hit) {
    // Unknown name: HTTP 200 { found: false }, cached briefly, so browsers log no console error.
    return json(resolveBody(name, null, source), 200, 3600);
  }
  return json(resolveBody(name, hit, source), 200, 604800);
});

export function OPTIONS() {
  return options();
}
