// Name or coordinates -> Target. Contract: roundtable/05-data-interface.md (resolveTarget).
//
// Order: coordinates, then the offline table of the six built-in targets, then the CfA
// VizieR mirror of Sesame (CORS enabled, called straight from the browser), then the relay.
import { SpherexError } from './types';
import type { CallOptions, Target } from './types';
import { fetchJson, relayUrl } from './net';
import { positionAt } from './wcs';

export type ChallengeSlug = 'barnards-star' | 'eps-indi-b' | 'wise-0855' | 'rw-aur' | 'r-dra' | 'v391-oph';

export interface ChallengeEntry {
  slug: ChallengeSlug;
  name: string;
  ra: number;            // deg, at `epoch`
  dec: number;           // deg, at `epoch`
  pmra: number;          // mas/yr, includes cos(dec)
  pmdec: number;         // mas/yr
  epoch: number;         // Julian year of ra/dec
  source: 'gaia' | 'simbad';
  aliases: string[];
}

// Every value below was fetched on 2026-11-14, not typed from memory.
// Gaia rows: ESA Gaia archive TAP (https://gea.esac.esa.int/tap-server/tap/sync), table
// gaiadr3.gaia_source, ref_epoch 2016.0, ICRS. Source ids were found through the SIMBAD TAP
// mirror (https://simbad.cfa.harvard.edu/simbad/sim-tap/sync), ident table.
export const CHALLENGE_TARGETS: readonly ChallengeEntry[] = [
  {
    // Gaia DR3 4472832130942575872 (SIMBAD main id "NAME Barnard's star", GJ 699).
    // Gaia DR3 gaia_source, queried 2026-11-14: parallax 546.9759 mas, G = 8.194.
    slug: 'barnards-star',
    name: "Barnard's Star",
    ra: 269.44850252543836,
    dec: 4.739420051112412,
    pmra: -801.5509783684709,
    pmdec: 10362.394206546573,
    epoch: 2016.0,
    source: 'gaia',
    aliases: [
      "Barnard's Star", 'Barnards Star', 'Barnard Star', 'barnards-star', 'GJ 699', 'Gl 699',
    ],
  },
  {
    // Gaia DR3 6412596012146801152, which SIMBAD lists as an identifier of "* eps Ind B"
    // (the brown dwarf binary Ba/Bb, GJ 845 B/C, not the K star eps Ind A).
    // Gaia DR3 gaia_source, queried 2026-11-14: parallax 270.658 mas, G = 18.03.
    // Caveat: ruwe = 4.30, so this is a single-source fit to an unresolved pair
    // (separation under 1 arcsec); the position is the pair photocentre.
    slug: 'eps-indi-b',
    name: 'Epsilon Indi B',
    ra: 331.07645259656397,
    dec: -56.79381206688221,
    pmra: 3981.97666296105,
    pmdec: -2466.8318147663504,
    epoch: 2016.0,
    source: 'gaia',
    aliases: [
      'Eps Indi B', 'Epsilon Indi B', 'Eps Ind B', 'Epsilon Ind B', 'eps-indi-b',
      'Eps Indi Ba', 'Eps Ind Ba', 'Epsilon Indi Ba', 'GJ 845 B',
    ],
  },
  {
    // Not in Gaia (too faint). Kirkpatrick et al. 2021, ApJS 253, 7 (bibcode 2021ApJS..253....7K),
    // VizieR J/ApJS/253/7, parallax and motion fit table ("plx" table = their Table 5),
    // row WISE J085510.83-071442.5, queried 2026-11-14 from vizier.cfa.harvard.edu:
    //   RA_ICRS 133.780984, DE_ICRS -07.243932 at t0 MJD 57633.39,
    //   pmRA -8123.7 +/- 1.3 and pmDE 673.2 +/- 1.3 mas/yr (absolute, pmRA includes cos dec),
    //   parallax 439.0 mas.
    // Epoch = 2000 + (57633.39 - 51544.5) / 365.25 = 2016.670 (J2000.0 is MJD 51544.5).
    // Check: the same catalogue (VizieR _RA.icrs/_DE.icrs) and SIMBAD (coo_bibcode and pm_bibcode
    // both 2021ApJS..253....7K) give 133.8189 -7.2470 at J2000 with these motions.
    slug: 'wise-0855',
    name: 'WISE 0855-0714',
    ra: 133.780984,
    dec: -7.243932,
    pmra: -8123.7,
    pmdec: 673.2,
    epoch: 2016.67,
    source: 'simbad',
    aliases: [
      'WISE 0855-0714', 'WISE J085510.83-071442.5', 'WISEA J085510.74-071442.5', 'wise-0855',
      'WISE 0855', 'WISE J0855-0714', 'WISE0855-0714',
    ],
  },
  {
    // Gaia DR3 156430822114424576 = SIMBAD "V* RW Aur A" (the primary; RW Aur B is
    // Gaia DR3 156430817820015232). Gaia DR3 gaia_source, queried 2026-11-14:
    // parallax 6.406 mas, G = 12.18, ruwe = 1.50 (acceptable for a young binary).
    slug: 'rw-aur',
    name: 'RW Aurigae',
    ra: 76.95608119552952,
    dec: 30.401204589097233,
    pmra: 2.6406431770317083,
    pmdec: -27.397582540455325,
    epoch: 2016.0,
    source: 'gaia',
    aliases: ['RW Aur', 'RW Aurigae', 'RW Aur A', 'rw-aur'],
  },
  {
    // Gaia DR3 1648328016354496384 = SIMBAD "V* R Dra". Gaia DR3 gaia_source, queried
    // 2026-11-14: parallax 1.251 mas, G = 6.374, ruwe = 1.30. A Mira variable, so its
    // photocentre may move a little with the pulsation cycle.
    slug: 'r-dra',
    name: 'R Draconis',
    ra: 248.1673783672889,
    dec: 66.75500674547219,
    pmra: -20.642811719160797,
    pmdec: 6.148818852711324,
    epoch: 2016.0,
    source: 'gaia',
    aliases: ['R Dra', 'R Draconis', 'r-dra'],
  },
  {
    // Gaia DR3 4472819623984651392 = SIMBAD "V* V391 Oph" (EB*; Gaia DR3 variability class ECL).
    // Gaia DR3 gaia_source and SIMBAD, queried 2026-11-14: parallax 0.595 mas, G = 12.658,
    // near-zero proper motion. Comparison star (not a built-in target): Gaia DR3
    // 4472831551114789632 (G = 12.91). About 516 arcsec from Barnard's Star, so the 60 arcsec
    // match radius cannot confuse the two.
    slug: 'v391-oph',
    name: 'V391 Ophiuchi',
    ra: 269.5380383,
    dec: 4.6576478,
    pmra: -1.114,
    pmdec: -4.998,
    epoch: 2016.0,
    source: 'gaia',
    aliases: ['V391 Oph', 'V391 Ophiuchi', 'v391-oph', 'Gaia DR3 4472819623984651392'],
  },
];

// Lowercase, drop apostrophes, turn every other non-alphanumeric run into one space.
function normalizeName(text: string): string {
  return text
    .toLowerCase()
    .replace(/['\u2018\u2019\u02BC`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ALIAS_INDEX: Map<string, ChallengeEntry> = (() => {
  const m = new Map<string, ChallengeEntry>();
  for (const e of CHALLENGE_TARGETS) {
    m.set(normalizeName(e.slug), e);
    m.set(normalizeName(e.name), e);
    for (const a of e.aliases) m.set(normalizeName(a), e);
  }
  return m;
})();

export function slugForName(text: string): ChallengeSlug | null {
  return ALIAS_INDEX.get(normalizeName(text))?.slug ?? null;
}

function entryToTarget(e: ChallengeEntry): Target {
  return {
    ra: e.ra, dec: e.dec, pmra: e.pmra, pmdec: e.pmdec,
    epoch: e.epoch, name: e.name, source: 'cache', cachedSlug: e.slug,
  };
}

// ---- position match to the built-in targets ------------------------------------------------

const D2R = Math.PI / 180;
/** A typed position within this many arcsec of a built-in target counts as that target. */
export const MATCH_RADIUS_ARCSEC = 60;
const MJD_J2000 = 51544.5;
const MJD_UNIX_EPOCH = 40587;

/** Great-circle separation in arcsec (haversine). */
function separationArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const p1 = dec1 * D2R, p2 = dec2 * D2R;
  const dp = p2 - p1, dl = (ra2 - ra1) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * (180 / Math.PI) * 3600;
}

/** MJD of the current moment. */
export function mjdNow(): number {
  return MJD_UNIX_EPOCH + Date.now() / 86400000;
}

/**
 * The built-in target a position belongs to, or null. A position matches when it lies within
 * 60 arcsec of ANY of: the proper-motion-corrected position at `mjd` (today), the catalogue
 * epoch position (Gaia 2016.0), or the J2000 position (what SIMBAD and Sesame print). It is an
 * OR on purpose: people type whichever epoch the source they copied from used, and the fast
 * movers (Barnard's Star, 10 arcsec/yr) are 2 to 3 arcmin apart between those epochs.
 */
export function matchCachedTarget(ra: number, dec: number, mjd: number = mjdNow()): Target | null {
  let best: { e: ChallengeEntry; sep: number } | null = null;
  for (const e of CHALLENGE_TARGETS) {
    const base = entryToTarget(e);
    const spots = [
      positionAt(base, mjd),
      { ra: e.ra, dec: e.dec },
      positionAt(base, MJD_J2000),
    ];
    for (const p of spots) {
      const sep = separationArcsec(ra, dec, p.ra, p.dec);
      if (sep <= MATCH_RADIUS_ARCSEC && (!best || sep < best.sep)) best = { e, sep };
    }
  }
  return best ? entryToTarget(best.e) : null;
}

// ---- coordinates ---------------------------------------------------------------------------

const NUM = '(\\d+(?:\\.\\d*)?)';
const DECIMAL_RE = /^([+-]?\d+(?:\.\d*)?|[+-]?\.\d+)\s*(?:,|\s)\s*([+-]?\d+(?:\.\d*)?|[+-]?\.\d+)$/;
// RA "17 57 48.5", "17:57:48.5", "17h57m48.5s"; Dec "+04 41 36", "+04:41:36", "+04d41m36s".
const SEXA_RE = new RegExp(
  `^${NUM}\\s*[h: ]\\s*${NUM}\\s*[m: ]\\s*${NUM}\\s*s?` +
  `\\s*,?\\s*` +
  `([+-]?)\\s*${NUM}\\s*[d\\u00b0: ]\\s*${NUM}\\s*['m\\u2032: ]\\s*${NUM}\\s*(?:"|s|\\u2033|'')?$`,
  'i',
);

function bad(message: string): SpherexError {
  return new SpherexError('BAD_INPUT', message);
}

function checkRange(ra: number, dec: number): void {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) throw bad('Coordinates are not numbers.');
  if (ra < 0 || ra >= 360) throw bad(`Right ascension ${ra} is outside 0 to 360 degrees.`);
  if (dec < -90 || dec > 90) throw bad(`Declination ${dec} is outside -90 to +90 degrees.`);
}

// Returns null when the text does not look like coordinates at all (so it is a name).
function parseCoordinates(text: string): { ra: number; dec: number } | null {
  const s = text.trim();
  const dm = DECIMAL_RE.exec(s);
  if (dm) {
    const ra = Number(dm[1]);
    const dec = Number(dm[2]);
    checkRange(ra, dec);
    return { ra, dec };
  }
  const sm = SEXA_RE.exec(s);
  if (sm) {
    const [h, mi, se] = [Number(sm[1]), Number(sm[2]), Number(sm[3])];
    const neg = sm[4] === '-';
    const [d, dmin, dsec] = [Number(sm[5]), Number(sm[6]), Number(sm[7])];
    if (mi >= 60 || se >= 60 || dmin >= 60 || dsec >= 60) throw bad('Minutes and seconds must be below 60.');
    if (h >= 24) throw bad(`Right ascension ${h}h is outside 0 to 24 hours.`);
    const ra = (h + mi / 60 + se / 3600) * 15;
    const mag = d + dmin / 60 + dsec / 3600;
    const dec = neg ? -mag : mag;
    checkRange(ra, dec);
    return { ra, dec };
  }
  return null;
}

// ---- Sesame --------------------------------------------------------------------------------

const SESAME_BASE = 'https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SNV?';

function tag(block: string, name: string): number | null {
  const m = new RegExp(`<${name}>\\s*([-+]?[0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\\s*</${name}>`).exec(block);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

// Parses Sesame -oxp XML (works in node, where DOMParser does not exist). Uses the first
// resolver block that has a position. pmRA is mas/yr and already includes cos(dec).
export function parseSesameXml(xml: string): Target | null {
  const blocks = xml.match(/<Resolver\b[\s\S]*?<\/Resolver>/g) ?? [];
  for (const b of blocks) {
    const ra = tag(b, 'jradeg');
    const dec = tag(b, 'jdedeg');
    if (ra === null || dec === null) continue;
    const t: Target = { ra, dec, epoch: 2000, source: 'sesame' };
    const pmra = tag(b, 'pmRA');
    const pmdec = tag(b, 'pmDE');
    if (pmra !== null && pmdec !== null) {
      t.pmra = pmra;
      t.pmdec = pmdec;
    }
    return t;
  }
  return null;
}

type SesameResult = { target: Target } | { nothing: boolean };

async function trySesame(name: string, signal: AbortSignal | undefined): Promise<SesameResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(SESAME_BASE + encodeURIComponent(name), { signal: ctl.signal });
    if (!res.ok) return { nothing: false };
    const xml = await res.text();
    const t = parseSesameXml(xml);
    if (t) return { target: t };
    return { nothing: /Nothing found/i.test(xml) };
  } catch {
    return { nothing: false };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ---- relay ---------------------------------------------------------------------------------

interface RelayResolve {
  found?: boolean;       // false: unknown name (HTTP 200). Absent in old-style bodies, meaning found.
  name?: string;
  ra: number;
  dec: number;
  pmra?: number | null;
  pmdec?: number | null;
  epoch?: number | null;
  source?: string;
}

function relayToTarget(r: RelayResolve, fallbackName: string): Target {
  if (r && r.found === false) {
    throw new SpherexError('NOT_FOUND', `Could not find "${fallbackName}". Try another name or enter coordinates.`);
  }
  if (!r || typeof r.ra !== 'number' || typeof r.dec !== 'number' || !Number.isFinite(r.ra) || !Number.isFinite(r.dec)) {
    throw new SpherexError('UPSTREAM_ERROR', 'Name resolver returned no position.');
  }
  const t: Target = {
    ra: r.ra,
    dec: r.dec,
    epoch: typeof r.epoch === 'number' && Number.isFinite(r.epoch) ? r.epoch : 2000,
    name: r.name || fallbackName,
    source: r.source === 'gaia' || r.source === 'sesame' ? r.source : 'simbad',
  };
  if (typeof r.pmra === 'number' && typeof r.pmdec === 'number' && Number.isFinite(r.pmra) && Number.isFinite(r.pmdec)) {
    t.pmra = r.pmra;
    t.pmdec = r.pmdec;
  }
  return t;
}

// ---- entry point ---------------------------------------------------------------------------

export async function resolveTarget(text: string, opts: CallOptions = {}): Promise<Target> {
  const { signal, onProgress } = opts;
  const input = (text ?? '').trim();
  if (!input) throw bad('Enter a name or coordinates.');
  if (signal?.aborted) throw new SpherexError('ABORTED', 'Request was cancelled');

  const report = (done: number, message: string) =>
    onProgress?.({ stage: 'resolve', done, total: 1, message });
  report(0, `Looking up ${input}`);

  const coords = parseCoordinates(input);
  if (coords) {
    report(1, 'Coordinates read');
    const hit = matchCachedTarget(coords.ra, coords.dec);
    if (hit) return hit;
    return { ra: coords.ra, dec: coords.dec, epoch: 2000, name: input, source: 'coordinates' };
  }

  const entry = ALIAS_INDEX.get(normalizeName(input));
  if (entry) {
    report(1, `Found ${entry.name}`);
    return entryToTarget(entry);
  }

  const ses = await trySesame(input, signal);
  if (signal?.aborted) throw new SpherexError('ABORTED', 'Request was cancelled');
  if ('target' in ses) {
    report(1, `Found ${input}`);
    return matchCachedTarget(ses.target.ra, ses.target.dec) ?? { ...ses.target, name: input };
  }
  if (ses.nothing) {
    // Sesame SNV already searches SIMBAD, NED and VizieR, so the relay (Sesame, then SIMBAD)
    // cannot know more: a definitive "Nothing found" ends here with no second request.
    throw new SpherexError('NOT_FOUND', `Could not find "${input}". Try another name or enter coordinates.`);
  }

  try {
    const r = await fetchJson<RelayResolve>(relayUrl('/api/resolve', { name: input }), {
      signal, onProgress, stage: 'resolve', retries: 1, timeoutMs: 15000, label: 'Name lookup',
    });
    const rt = relayToTarget(r, input);
    const t = matchCachedTarget(rt.ra, rt.dec) ?? rt;
    report(1, `Found ${t.name}`);
    return t;
  } catch (e) {
    if (e instanceof SpherexError && e.code === 'ABORTED') throw e;
    if (e instanceof SpherexError && e.code === 'NOT_FOUND') {
      throw new SpherexError('NOT_FOUND', `Could not find "${input}". Try another name or enter coordinates.`, { cause: e });
    }
    throw e;
  }
}
