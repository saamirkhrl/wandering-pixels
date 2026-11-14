// Browser-side HTTP helpers for the relay: URL building, timeouts, retry with backoff.
import { SpherexError } from './types';
import type { CallOptions, Progress, SpherexErrorCode } from './types';

let relayBase = '';

export function setRelayBase(base: string): void {
  relayBase = base.replace(/\/+$/, '');
}

export function relayUrl(path: string, params: Record<string, string | number>): string {
  const p = path.startsWith('/') ? path : '/' + path;
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return relayBase + p + (qs ? '?' + qs : '');
}

export interface FetchJsonOptions extends CallOptions {
  stage?: Progress['stage'];
  timeoutMs?: number;
  retries?: number;
  label?: string;
}

const CODES: readonly string[] = [
  'NOT_FOUND', 'NO_COVERAGE', 'UPSTREAM_BUSY', 'UPSTREAM_ERROR', 'BAD_INPUT', 'ABORTED',
];

function aborted(): SpherexError {
  return new SpherexError('ABORTED', 'Request was cancelled');
}

function anySignal(a: AbortSignal | undefined, b: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  if (!a) return { signal: b, cleanup: () => {} };
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([a, b]), cleanup: () => {} };
  }
  const c = new AbortController();
  const onA = () => c.abort(a.reason);
  const onB = () => c.abort(b.reason);
  if (a.aborted) c.abort(a.reason);
  else a.addEventListener('abort', onA, { once: true });
  if (b.aborted) c.abort(b.reason);
  else b.addEventListener('abort', onB, { once: true });
  return {
    signal: c.signal,
    cleanup: () => {
      a.removeEventListener('abort', onA);
      b.removeEventListener('abort', onB);
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const onAbort = () => {
      clearTimeout(t);
      reject(aborted());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers?.get?.('Retry-After');
  if (!h) return null;
  const s = Number(h);
  if (!Number.isFinite(s) || s < 0) return null;
  return Math.min(s * 1000, 10000);
}

async function errorFromResponse(res: Response, label: string): Promise<SpherexError> {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    code = body?.error?.code;
    message = body?.error?.message;
  } catch {
    // body was not JSON
  }
  let mapped: SpherexErrorCode;
  if (code && CODES.includes(code)) mapped = code as SpherexErrorCode;
  else if (res.status === 400) mapped = 'BAD_INPUT';
  else if (res.status === 404) mapped = 'NOT_FOUND';
  else if (res.status === 503) mapped = 'UPSTREAM_BUSY';
  else mapped = 'UPSTREAM_ERROR';
  return new SpherexError(mapped, message ?? `${label} failed (HTTP ${res.status})`);
}

export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { signal, onProgress, stage = 'search', timeoutMs = 30000, retries = 3, label = 'Request' } = opts;
  let lastError: SpherexError | null = null;
  let waitHint: number | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw aborted();

    if (attempt > 0) {
      const base = 1000 * 2 ** (attempt - 1);
      const delay = waitHint ?? base + Math.random() * 250;
      onProgress?.({
        stage, done: 0, total: 0,
        message: `IRSA is busy, retrying (${attempt} of ${retries})`,
        retrying: true,
      });
      await sleep(delay, signal);
    }
    waitHint = null;

    const timeoutCtl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutCtl.abort();
    }, timeoutMs);
    const { signal: combined, cleanup } = anySignal(signal, timeoutCtl.signal);

    try {
      const res = await fetch(url, { signal: combined });
      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch (e) {
          if (signal?.aborted) throw aborted();
          throw new SpherexError('UPSTREAM_ERROR', `${label} returned invalid JSON`, { cause: e });
        }
      }
      const err = await errorFromResponse(res, label);
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        lastError = err;
        waitHint = retryAfterMs(res);
        continue;
      }
      throw err;
    } catch (e) {
      if (e instanceof SpherexError) throw e;
      if (signal?.aborted) throw aborted();
      if (timedOut) {
        throw new SpherexError('UPSTREAM_ERROR', `${label} timed out after ${Math.round(timeoutMs / 1000)} s`, { cause: e });
      }
      lastError = new SpherexError('UPSTREAM_ERROR', `${label} failed: network error`, { cause: e });
    } finally {
      clearTimeout(timer);
      cleanup();
    }
  }
  throw lastError ?? new SpherexError('UPSTREAM_ERROR', `${label} failed`);
}
