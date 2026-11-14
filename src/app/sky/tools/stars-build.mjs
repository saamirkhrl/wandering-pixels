import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT = 4.5;
const URL_BASE = 'https://heasarc.gsfc.nasa.gov/xamin/vo/tap/sync';
const QUERY = `SELECT hr, ra, dec, vmag FROM bsc5p WHERE vmag <= ${LIMIT} ORDER BY vmag`;
const URL = `${URL_BASE}?REQUEST=doQuery&LANG=ADQL&FORMAT=votable&QUERY=${encodeURIComponent(QUERY).replace(/%20/g, '+')}`;

// IAU proper names, keyed by Bright Star Catalogue (HR) number.
const NAMES = {
  2491: 'Sirius', 2326: 'Canopus', 5340: 'Arcturus', 5459: 'Rigil Kentaurus', 7001: 'Vega',
  1708: 'Capella', 1713: 'Rigel', 2943: 'Procyon', 472: 'Achernar', 2061: 'Betelgeuse',
  5267: 'Hadar', 7557: 'Altair', 4730: 'Acrux', 1457: 'Aldebaran', 6134: 'Antares',
  5056: 'Spica', 2990: 'Pollux', 8728: 'Fomalhaut', 7924: 'Deneb', 4853: 'Mimosa',
  3982: 'Regulus', 2618: 'Adhara', 2891: 'Castor', 6527: 'Shaula', 1790: 'Bellatrix',
  424: 'Polaris', 1903: 'Alnilam', 4905: 'Alioth', 4301: 'Dubhe', 4763: 'Gacrux',
  1791: 'Elnath', 3685: 'Miaplacidus', 8425: 'Alnair', 1948: 'Alnitak', 1852: 'Mintaka',
  2004: 'Saiph',
};

const res = await fetch(URL);
if (!res.ok) throw new Error('HEASARC request failed: ' + res.status);
const xml = await res.text();
if (xml.includes('name="QUERY_STATUS" value="ERROR"')) throw new Error('HEASARC query error');
const m = xml.match(/<STREAM encoding="base64">([\s\S]*?)<\/STREAM>/);
if (!m) throw new Error('no binary stream in response');
const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');

// Fields in order: hr short, ra double, dec double, vmag float (big endian, no null mask)
const ROW = 2 + 8 + 8 + 4;
if (buf.length % ROW !== 0) throw new Error('unexpected stream length ' + buf.length);
const stars = [];
for (let o = 0; o < buf.length; o += ROW) {
  const hr = buf.readInt16BE(o);
  const ra = buf.readDoubleBE(o + 2);
  const dec = buf.readDoubleBE(o + 10);
  const v = buf.readFloatBE(o + 18);
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(v)) continue;
  if (v > LIMIT) continue;
  stars.push([Math.round(ra * 1e4) / 1e4, Math.round(dec * 1e4) / 1e4, Math.round(v * 100) / 100, NAMES[hr] ?? null, hr]);
}
stars.sort((a, b) => a[2] - b[2]);

const vega = stars.find((s) => s[4] === 7001);
if (!vega || Math.abs(vega[0] - 279.2347) > 0.01 || Math.abs(vega[1] - 38.7837) > 0.01) {
  throw new Error('Vega sanity check failed: ' + JSON.stringify(vega));
}
const named = stars.filter((s) => s[3]).length;

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../public/data/bright-stars.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ source: URL, limit: LIMIT, stars: stars.map((s) => s.slice(0, 4)) }));
console.log('stars', stars.length, 'named', named, 'vega', vega.slice(0, 3), 'wrote', out);
