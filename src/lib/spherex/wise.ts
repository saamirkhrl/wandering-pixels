import { SpherexError } from './types';
import type { CallOptions } from './types';
import { fetchJson, relayUrl } from './net';

// ra/dec are at the relay's catalog epoch (CatWISE2020 ~2015.4 or AllWISE ~2010.5),
// which the relay also returns as `epoch`. pmra includes cos(dec). pm in mas/yr.
export interface WiseSource {
  id: string;
  ra: number;
  dec: number;
  pmra: number | null;
  pmdec: number | null;
  w1mag: number | null;
  w2mag: number | null;
}

interface WiseResponse {
  count?: number;
  catalog?: string;
  epoch?: number;
  sources?: Array<{
    id: string | number;
    ra: number;
    dec: number;
    pmra: number | null;
    pmdec: number | null;
    w1mag: number | null;
    w2mag: number | null;
  }>;
}

export async function wiseCone(
  ra: number,
  dec: number,
  radiusArcsec: number,
  opts: CallOptions = {},
): Promise<WiseSource[]> {
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(radiusArcsec)) {
    throw new SpherexError('BAD_INPUT', 'ra, dec and radius must be finite numbers');
  }
  if (dec < -90 || dec > 90) throw new SpherexError('BAD_INPUT', 'dec must be within -90..90');
  if (radiusArcsec <= 0) throw new SpherexError('BAD_INPUT', 'radius must be greater than 0');
  const radius = Math.min(radiusArcsec, 300) // relay clamps WISE cones to 300 arcsec;
  const url = relayUrl('/api/wise', { ra, dec, radius });
  const body = await fetchJson<WiseResponse>(url, {
    signal: opts.signal, onProgress: opts.onProgress, stage: 'search', label: 'WISE catalog query',
  });
  return (body.sources ?? []).map((s) => ({
    id: String(s.id),
    ra: s.ra,
    dec: s.dec,
    pmra: s.pmra ?? null,
    pmdec: s.pmdec ?? null,
    w1mag: s.w1mag ?? null,
    w2mag: s.w2mag ?? null,
  }));
}
