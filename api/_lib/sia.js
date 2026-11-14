// Pure helpers for the IRSA SIA2 SPHEREx exposure relay. No network access in this file.

export const SIA_HOST = 'https://irsa.ipac.caltech.edu/SIA';
export const S3_PREFIX = 'https://nasa-irsa-spherex.s3.amazonaws.com/';
export const IBE_PREFIX = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/';

/** Collections the relay may query; required ones must succeed. */
export const COLLECTIONS = [
  { name: 'spherex_dr1', required: true },
  { name: 'spherex_qr3', required: true },
  { name: 'spherex_qr2', required: false },
  { name: 'spherex_dr1_deep', required: false },
  { name: 'spherex_qr3_deep', required: false },
];

const COLLECTION_WHITELIST = new Set(COLLECTIONS.map((c) => c.name));
const RELEASE_RANK = { dr1: 0, qr3: 1, qr2: 2 };

/**
 * Build the SIA2 query URL for a fixed host and a whitelisted collection.
 * @param {string} collection @param {number} ra @param {number} dec @param {number} [maxrec]
 */
export function buildSiaUrl(collection, ra, dec, maxrec = 5000) {
  if (!COLLECTION_WHITELIST.has(collection)) throw new Error('collection not allowed');
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) throw new Error('bad position');
  const pos = `CIRCLE+${ra.toFixed(6)}+${dec.toFixed(6)}+0.0001`;
  return `${SIA_HOST}?COLLECTION=${collection}&POS=${pos}&CALIB=2&MAXREC=${Math.trunc(maxrec)}`;
}

/** @param {string} s */
function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Value of the QUERY_STATUS INFO element ("OK", "OVERFLOW", "ERROR"), or '' when absent.
 * @param {string} xml
 */
export function queryStatus(xml) {
  const m = /<INFO\s[^>]*name="QUERY_STATUS"[^>]*value="([^"]*)"/.exec(xml);
  return m ? decodeEntities(m[1]) : '';
}

/**
 * Parse the first TABLEDATA of a VOTable into row records keyed by FIELD name.
 * @param {string} xml
 * @returns {Array<Record<string,string>>}
 */
export function parseVotable(xml) {
  const names = [];
  const fieldRe = /<FIELD\s[^>]*?\bname="([^"]*)"/g;
  let fm;
  while ((fm = fieldRe.exec(xml))) names.push(decodeEntities(fm[1]));
  if (names.length === 0) return [];

  const start = xml.indexOf('<TABLEDATA>');
  if (start < 0) return [];
  const end = xml.indexOf('</TABLEDATA>', start);
  const body = xml.slice(start, end < 0 ? undefined : end);

  const rows = [];
  const trRe = /<TR>([\s\S]*?)<\/TR>/g;
  const tdRe = /<TD\s*\/>|<TD[^>]*>([\s\S]*?)<\/TD>/g;
  let tr;
  while ((tr = trRe.exec(body))) {
    const rec = {};
    let i = 0;
    let td;
    tdRe.lastIndex = 0;
    while ((td = tdRe.exec(tr[1])) && i < names.length) {
      rec[names[i++]] = td[1] === undefined ? '' : decodeEntities(td[1]).trim();
    }
    rows.push(rec);
  }
  return rows;
}

/** @param {string} s */
function s3KeyFromRow(row) {
  const ca = row.cloud_access;
  if (ca) {
    try {
      const key = JSON.parse(ca)?.aws?.key;
      if (typeof key === 'string' && key) return key;
    } catch {
      /* fall through to access_url */
    }
  }
  const au = row.access_url;
  if (au && au.startsWith(IBE_PREFIX)) return au.slice(IBE_PREFIX.length);
  return '';
}

/**
 * @param {Array<Record<string,string>>} rows
 * @returns {Array<{obsId:string, detector:number, tMin:number, tMax:number, url:string, release:string}>}
 */
export function rowsToExposures(rows) {
  const out = [];
  for (const row of rows) {
    if (row.dataproduct_subtype !== 'science') continue;
    const obsId = row.obs_id;
    const det = /D([1-6])$/.exec(row.energy_bandpassname || '');
    if (!obsId || !det) continue;
    const key = s3KeyFromRow(row);
    const release = key.split('/')[0];
    if (!(release in RELEASE_RANK) || !key.endsWith('.fits')) continue;
    const tMin = Number(row.t_min);
    const tMax = Number(row.t_max);
    if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || row.t_min === '' || row.t_max === '') continue;
    out.push({ obsId, detector: Number(det[1]), tMin, tMax, url: S3_PREFIX + key, release });
  }
  return out;
}

/**
 * One exposure per obsId+detector, preferring dr1, then qr3, then qr2; sorted by tMin.
 * @param {ReturnType<typeof rowsToExposures>} exposures
 */
export function dedupe(exposures) {
  const best = new Map();
  for (const e of exposures) {
    const k = `${e.obsId}|${e.detector}`;
    const cur = best.get(k);
    if (!cur || RELEASE_RANK[e.release] < RELEASE_RANK[cur.release]) best.set(k, e);
  }
  return [...best.values()].sort(
    (a, b) => a.tMin - b.tMin || a.obsId.localeCompare(b.obsId) || a.detector - b.detector,
  );
}
