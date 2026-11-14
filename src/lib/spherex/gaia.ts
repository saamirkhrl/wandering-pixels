import { SpherexError } from './types';
import type { CallOptions, GaiaStar } from './types';
import { fetchJson, relayUrl } from './net';

interface GaiaResponse {
  count?: number;
  stars?: Array<{
    source_id: string | number;
    ra: number;
    dec: number;
    pmra: number | null;
    pmdec: number | null;
    parallax: number | null;
    phot_g_mean_mag: number | null;
  }>;
}

export async function gaiaCone(
  ra: number,
  dec: number,
  radiusArcsec: number,
  opts: CallOptions = {},
): Promise<GaiaStar[]> {
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(radiusArcsec)) {
    throw new SpherexError('BAD_INPUT', 'ra, dec and radius must be finite numbers');
  }
  if (dec < -90 || dec > 90) throw new SpherexError('BAD_INPUT', 'dec must be within -90..90');
  if (radiusArcsec <= 0) throw new SpherexError('BAD_INPUT', 'radius must be greater than 0');
  const radius = Math.min(radiusArcsec, 900);
  const url = relayUrl('/api/gaia', { ra, dec, radius });
  const body = await fetchJson<GaiaResponse>(url, {
    signal: opts.signal, onProgress: opts.onProgress, stage: 'search', label: 'Gaia query',
  });
  return (body.stars ?? []).map((s) => ({
    sourceId: String(s.source_id),
    ra: s.ra,
    dec: s.dec,
    pmra: s.pmra ?? null,
    pmdec: s.pmdec ?? null,
    parallax: s.parallax ?? null,
    gmag: s.phot_g_mean_mag ?? NaN,
  }));
}
