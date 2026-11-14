// Shared helpers for the relay functions. Files under api/_lib are not routed by Vercel.

/** @typedef {'NOT_FOUND'|'NO_COVERAGE'|'UPSTREAM_BUSY'|'UPSTREAM_ERROR'|'BAD_INPUT'} ErrorCode */

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'X-Content-Type-Options': 'nosniff',
};

/**
 * JSON response with CORS. cacheSeconds > 0 lets the edge cache it (s-maxage).
 * @param {unknown} body
 * @param {number} [status]
 * @param {number} [cacheSeconds]
 */
export function json(body, status = 200, cacheSeconds = 0) {
  const cache =
    status === 200 && cacheSeconds > 0
      ? `public, max-age=300, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}`
      : 'no-store';
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'Cache-Control': cache },
  });
}

/** @param {ErrorCode} code @param {string} message @param {number} status */
export function errorJson(code, message, status) {
  return json({ error: { code, message } }, status);
}

/** Preflight answer for every relay route. */
export function options() {
  return new Response(null, {
    status: 204,
    headers: { ...BASE_HEADERS, 'Access-Control-Max-Age': '86400' },
  });
}

export class RelayError extends Error {
  /** @param {ErrorCode} code @param {string} message @param {number} status */
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Read a finite number query parameter inside [min, max], or throw RelayError BAD_INPUT.
 * @param {URLSearchParams} params @param {string} name @param {number} min @param {number} max
 * @param {number} [fallback] used when the parameter is absent
 */
export function numberParam(params, name, min, max, fallback) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') {
    if (fallback !== undefined) return fallback;
    throw new RelayError('BAD_INPUT', `missing parameter ${name}`, 400);
  }
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw.trim())) {
    throw new RelayError('BAD_INPUT', `parameter ${name} must be a number`, 400);
  }
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new RelayError('BAD_INPUT', `parameter ${name} must be between ${min} and ${max}`, 400);
  }
  return v;
}

/** Resolves after ms, or early when the signal aborts. */
const sleep = (ms, signal) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  });

/**
 * Fetch a fixed upstream URL with a per-attempt timeout and retries with exponential backoff
 * on 502/503/504 and network errors, all inside an overall time budget.
 * Returns the final Response (status 200..499) or throws RelayError (UPSTREAM_BUSY / UPSTREAM_ERROR).
 * @param {string} url
 * backoffMs is the first retry wait (doubles each attempt); default 500.
 * `signal` (optional) cancels the attempt in flight and stops further retries.
 * @param {{ init?: RequestInit, attemptTimeoutMs?: number, budgetMs?: number, maxAttempts?: number, backoffMs?: number, signal?: AbortSignal }} [o]
 */
export async function fetchUpstream(url, o = {}) {
  const { init = {}, attemptTimeoutMs = 20000, budgetMs = 25000, maxAttempts = 4, backoffMs = 500, signal } = o;
  const deadline = Date.now() + budgetMs;
  let lastStatus = 0;
  let lastErr = '';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const left = deadline - Date.now();
    if (left < 500 || signal?.aborted) break;
    try {
      const timeout = AbortSignal.timeout(Math.min(attemptTimeoutMs, left));
      const res = await fetch(url, {
        ...init,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      if (res.status !== 502 && res.status !== 503 && res.status !== 504) return res;
      lastStatus = res.status;
      const ra = Number(res.headers.get('retry-after'));
      await res.body?.cancel();
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : backoffMs * 2 ** attempt;
      if (Date.now() + wait > deadline - 500) break;
      await sleep(wait, signal);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      const wait = backoffMs * 2 ** attempt;
      if (Date.now() + wait > deadline - 500) break;
      await sleep(wait, signal);
    }
  }
  if (lastStatus === 503 || lastStatus === 502 || lastStatus === 504) {
    throw new RelayError('UPSTREAM_BUSY', `upstream busy (HTTP ${lastStatus}) after retries`, 503);
  }
  throw new RelayError('UPSTREAM_ERROR', `upstream failed: ${lastErr || 'timeout'}`, 502);
}

/**
 * Wrap a handler so thrown RelayErrors become JSON errors and anything else a 502.
 * @param {(url: URL) => Promise<Response>} fn
 * @returns {(request: Request) => Promise<Response>}
 */
export function handler(fn) {
  return async (request) => {
    try {
      return await fn(new URL(request.url));
    } catch (e) {
      if (e instanceof RelayError) return errorJson(e.code, e.message, e.status);
      return errorJson('UPSTREAM_ERROR', 'relay failure', 502);
    }
  };
}
