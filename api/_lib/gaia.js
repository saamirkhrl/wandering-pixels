// Gaia relay helpers that add phot_variable_flag on top of the shared Gaia query and parser.
// Gaia DR3 values seen: 'VARIABLE', 'NOT_AVAILABLE' (and empty for a few sources).
import { buildGaiaQuery, GAIA_TAP, parseGaia, csvRecords } from './upstreams.js';

/** Full TAP sync URL for a Gaia cone that also selects phot_variable_flag. */
export function gaiaFlagUrl(ra, dec, radiusArcsec) {
  const query = buildGaiaQuery(ra, dec, radiusArcsec).replace(
    'phot_g_mean_mag FROM',
    'phot_g_mean_mag,phot_variable_flag FROM',
  );
  const p = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: query });
  return `${GAIA_TAP}?${p}`;
}

/** true only for 'VARIABLE', false for any other non-empty value, null when missing or empty. */
export function variableFromFlag(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return s.toUpperCase() === 'VARIABLE';
}

/** Gaia CSV to stars, each with `variable`. A header without the flag column gives null. */
export function parseGaiaWithVariable(csv) {
  const stars = parseGaia(csv);
  const flags = new Map();
  const header = csv.replace(/^﻿/, '').split(/\r?\n/, 1)[0].split(',');
  if (header.includes('phot_variable_flag')) {
    for (const r of csvRecords(csv, ['source_id', 'phot_variable_flag'])) {
      if (r.source_id !== null) flags.set(r.source_id, r.phot_variable_flag);
    }
  }
  return stars.map((s) => ({ ...s, variable: variableFromFlag(flags.get(s.source_id)) }));
}
