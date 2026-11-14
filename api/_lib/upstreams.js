// Pure helpers for the Gaia, name-resolve and WISE relays: query building, input
// validation and response parsing. No network access here so it can be unit tested.

import { RelayError } from './http.js';

export const GAIA_TAP = 'https://gea.esac.esa.int/tap-server/tap/sync';
export const IRSA_SCS = 'https://irsa.ipac.caltech.edu/SCS';
export const SIMBAD_TAP = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';
export const SESAME_BASE = 'https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SNV?';

export const MAX_ROWS = 500;
export const MAX_RADIUS_ARCSEC = 900;
export const DEFAULT_RADIUS_ARCSEC = 300;

/**
 * Parse RFC 4180 style CSV into rows of strings. Handles quoted fields, doubled quotes,
 * embedded commas and newlines, CRLF, and a missing trailing newline.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/**
 * CSV text to objects keyed by header name. Empty values become null.
 * Throws UPSTREAM_ERROR if any of the required columns is missing from the header.
 * @param {string} text @param {string[]} required
 * @returns {Record<string, string|null>[]}
 */
export function csvRecords(text, required) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  const header = rows[0];
  if (!header || !required.every((c) => header.includes(c))) {
    throw new RelayError('UPSTREAM_ERROR', 'unexpected upstream response format', 502);
  }
  return rows.slice(1).map((r) => {
    /** @type {Record<string, string|null>} */
    const o = {};
    header.forEach((h, k) => {
      const v = r[k];
      o[h] = v === undefined || v.trim() === '' ? null : v.trim();
    });
    return o;
  });
}

/** Finite number from a CSV cell, else null. Never used for source ids. */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

const round = (x, digits) => (x === null ? null : Number(x.toFixed(digits)));

/** Escape a string for an ADQL single-quoted literal. */
export function adqlEscape(s) {
  return s.replace(/'/g, "''");
}

/**
 * Validate a user supplied object name. 1-80 chars of letters, digits, space and + - . _ ' * ( ).
 * @param {string|null} raw
 * @returns {string} the trimmed name
 */
export function validateName(raw) {
  const name = (raw ?? '').trim().replace(/ +/g, ' ');
  if (name.length < 1 || name.length > 80) {
    throw new RelayError('BAD_INPUT', 'name must be 1 to 80 characters', 400);
  }
  if (!/^[A-Za-z0-9 +\-._'*()]+$/.test(name)) {
    throw new RelayError('BAD_INPUT', 'name contains unsupported characters', 400);
  }
  return name;
}

/** Cone search parts shared by the Gaia and WISE queries. */
function cone(ra, dec, radiusArcsec) {
  const r = Math.min(Math.max(radiusArcsec, 0.01), MAX_RADIUS_ARCSEC) / 3600;
  const raC = Math.min(Math.max(ra, 0), 360);
  const decC = Math.min(Math.max(dec, -90), 90);
  return `CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${raC.toFixed(6)},${decC.toFixed(6)},${r.toFixed(7)}))=1`;
}

/** ADQL for the Gaia DR3 cone, brightest first. */
export function buildGaiaQuery(ra, dec, radiusArcsec) {
  return (
    `SELECT TOP ${MAX_ROWS} source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag ` +
    `FROM gaiadr3.gaia_source WHERE ${cone(ra, dec, radiusArcsec)} ORDER BY phot_g_mean_mag ASC`
  );
}

/** Full TAP sync URL for a Gaia cone. */
export function gaiaUrl(ra, dec, radiusArcsec) {
  const p = new URLSearchParams({
    REQUEST: 'doQuery',
    LANG: 'ADQL',
    FORMAT: 'csv',
    QUERY: buildGaiaQuery(ra, dec, radiusArcsec),
  });
  return `${GAIA_TAP}?${p}`;
}

/**
 * Gaia CSV to stars. source_id stays an exact string (it exceeds 2^53).
 * @param {string} csv
 */
export function parseGaia(csv) {
  const recs = csvRecords(csv, ['source_id', 'ra', 'dec', 'pmra', 'pmdec', 'parallax', 'phot_g_mean_mag']);
  return recs
    .filter((r) => r.source_id !== null && num(r.ra) !== null && num(r.dec) !== null)
    .map((r) => ({
      source_id: /** @type {string} */ (r.source_id),
      ra: num(r.ra),
      dec: num(r.dec),
      pmra: num(r.pmra),
      pmdec: num(r.pmdec),
      parallax: num(r.parallax),
      phot_g_mean_mag: num(r.phot_g_mean_mag),
    }));
}

/**
 * Catalog definitions for the IRSA relay. pmScale converts the table unit to mas/yr.
 * CatWISE2020 positions are at the mean observation epoch (MJD about 57170, 2015.4) and its
 * proper motions are in arcsec/yr; AllWISE positions are at MJD about 55400 (2010.56) with mas/yr.
 */
export const WISE_CATALOGS = {
  catwise2020: { table: 'catwise_2020', idCol: 'source_name', pmScale: 1000, epoch: 2015.4, label: 'catwise2020' },
  allwise: { table: 'allwise_p3as_psd', idCol: 'designation', pmScale: 1, epoch: 2010.56, label: 'allwise' },
};

/**
 * IRSA Simple Cone Search URL (fixed host, table whitelist, validated numbers only).
 * SCS answers in a few seconds for a 300 arcsec cone, where the TAP endpoint needed 25 to 55 s.
 * It returns every row in the cone, so parseWise sorts and caps them.
 * @param {'catwise2020'|'allwise'} catalog
 */
export function wiseUrl(ra, dec, radiusArcsec, catalog) {
  const c = WISE_CATALOGS[catalog];
  const r = Math.min(Math.max(radiusArcsec, 0.01), MAX_RADIUS_ARCSEC) / 3600;
  const raC = Math.min(Math.max(ra, 0), 360);
  const decC = Math.min(Math.max(dec, -90), 90);
  return (
    `${IRSA_SCS}?table=${c.table}&RA=${raC.toFixed(6)}&DEC=${decC.toFixed(6)}` +
    `&SR=${r.toFixed(7)}&format=csv`
  );
}

/**
 * IRSA WISE-family CSV to sources, brightest W1 first (missing W1 last), at most MAX_ROWS,
 * with proper motion in mas/yr. Columns are read by header name, extra columns are ignored.
 * @param {string} csv @param {'catwise2020'|'allwise'} catalog
 */
export function parseWise(csv, catalog) {
  const c = WISE_CATALOGS[catalog];
  const recs = csvRecords(csv, [c.idCol, 'ra', 'dec', 'pmra', 'pmdec', 'w1mpro', 'w2mpro']);
  return recs
    .filter((r) => num(r.ra) !== null && num(r.dec) !== null)
    .map((r) => {
      const pmra = num(r.pmra);
      const pmdec = num(r.pmdec);
      return {
        id: r[c.idCol],
        ra: num(r.ra),
        dec: num(r.dec),
        pmra: pmra === null ? null : round(pmra * c.pmScale, 3),
        pmdec: pmdec === null ? null : round(pmdec * c.pmScale, 3),
        w1mag: num(r.w1mpro),
        w2mag: num(r.w2mpro),
      };
    })
    .sort((x, y) => {
      if (x.w1mag === null) return y.w1mag === null ? 0 : 1;
      if (y.w1mag === null) return -1;
      return x.w1mag - y.w1mag;
    })
    .slice(0, MAX_ROWS);
}

/** ADQL for the SIMBAD name lookup. name must already be validated. */
export function buildSimbadQuery(name) {
  return (
    'SELECT TOP 1 basic.main_id, ra, dec, pmra, pmdec FROM basic JOIN ident ON oidref=oid ' +
    `WHERE id = '${adqlEscape(name)}'`
  );
}

export function simbadUrl(name) {
  const p = new URLSearchParams({
    REQUEST: 'doQuery',
    LANG: 'ADQL',
    FORMAT: 'csv',
    QUERY: buildSimbadQuery(name),
  });
  return `${SIMBAD_TAP}?${p}`;
}

export function sesameUrl(name) {
  return SESAME_BASE + encodeURIComponent(name);
}

/**
 * SIMBAD CSV to a position, or null when no row.
 * @param {string} csv
 */
export function parseSimbad(csv) {
  const recs = csvRecords(csv, ['main_id', 'ra', 'dec', 'pmra', 'pmdec']);
  const r = recs[0];
  if (!r || num(r.ra) === null || num(r.dec) === null) return null;
  return { ra: num(r.ra), dec: num(r.dec), pmra: num(r.pmra), pmdec: num(r.pmdec) };
}

/**
 * Sesame XML (-oxp/SNV) to a position, or null when nothing was found.
 * Takes the first resolver block that carries jradeg and jdedeg.
 * @param {string} xml
 */
export function parseSesame(xml) {
  const blocks = xml.split(/<Resolver\b/).slice(1);
  for (const b of blocks) {
    const ra = num(/<jradeg>\s*([^<\s]+)\s*<\/jradeg>/.exec(b)?.[1] ?? null);
    const dec = num(/<jdedeg>\s*([^<\s]+)\s*<\/jdedeg>/.exec(b)?.[1] ?? null);
    if (ra === null || dec === null) continue;
    const pmra = num(/<pmRA>\s*([^<\s]+)\s*<\/pmRA>/.exec(b)?.[1] ?? null);
    const pmdec = num(/<pmDE>\s*([^<\s]+)\s*<\/pmDE>/.exec(b)?.[1] ?? null);
    return { ra, dec, pmra, pmdec };
  }
  return null;
}
