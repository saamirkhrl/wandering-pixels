import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS module without type declarations
import * as u from './upstreams.js';

describe('parseCsv', () => {
  it('handles quoted fields, commas, doubled quotes and CRLF', () => {
    const rows = u.parseCsv('a,b,c\r\n"x,1","he said ""hi""",\r\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x,1', 'he said "hi"', ''],
    ]);
  });
  it('handles a missing trailing newline and embedded newline', () => {
    expect(u.parseCsv('a,b\n"l1\nl2",2')).toEqual([
      ['a', 'b'],
      ['l1\nl2', '2'],
    ]);
  });
});

describe('Gaia parsing', () => {
  const csv =
    'source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag\n' +
    '4472832130942575872,269.4485,4.7394,-801.55,10362.39,546.97,8.19\n' +
    '4472832165289153024,269.4664,4.7055,,,,11.45\n';
  it('keeps source_id as an exact string and maps empty values to null', () => {
    const stars = u.parseGaia(csv);
    expect(stars).toHaveLength(2);
    expect(stars[0].source_id).toBe('4472832130942575872');
    expect(typeof stars[0].source_id).toBe('string');
    expect(stars[0].pmdec).toBeCloseTo(10362.39);
    expect(stars[1]).toMatchObject({ pmra: null, pmdec: null, parallax: null, phot_g_mean_mag: 11.45 });
  });
  it('rejects a response without the expected header', () => {
    expect(() => u.parseGaia('<html>oops</html>')).toThrow();
  });
});

describe('WISE parsing', () => {
  it('sorts by W1 with nulls last, ignores extra columns and caps at 500 rows', () => {
    let csv = 'source_name,extra,ra,dec,pmra,pmdec,w1mpro,w2mpro\n';
    csv += 'Jnull,x,1,2,,,,\nJfaint,x,1,2,0,0,15.5,15\nJbright,x,1,2,0,0,8.1,8\n';
    const s = u.parseWise(csv, 'catwise2020');
    expect(s.map((r) => r.id)).toEqual(['Jbright', 'Jfaint', 'Jnull']);
    let big = 'designation,ra,dec,pmra,pmdec,w1mpro,w2mpro\n';
    for (let i = 0; i < 700; i++) big += `J${i},1,2,0,0,${20 - i / 100},9\n`;
    const out = u.parseWise(big, 'allwise');
    expect(out).toHaveLength(500);
    expect(out[0].id).toBe('J699');
  });
  it('converts CatWISE arcsec/yr to mas/yr and leaves nulls', () => {
    const csv = 'source_name,ra,dec,pmra,pmdec,w1mpro,w2mpro\nJ1,269.4,4.7,-1.8781,-2.61226,9.378,\nJ2,1,2,,,,\n';
    const s = u.parseWise(csv, 'catwise2020');
    expect(s[0]).toMatchObject({ id: 'J1', pmra: -1878.1, pmdec: -2612.26, w1mag: 9.378, w2mag: null });
    expect(s[1]).toMatchObject({ pmra: null, pmdec: null, w1mag: null });
  });
  it('keeps AllWISE mas/yr as is', () => {
    const csv = 'designation,ra,dec,pmra,pmdec,w1mpro,w2mpro\nJ175747.94+044323.8,269.44,4.72,-1630,13703,4.358,3.658\n';
    expect(u.parseWise(csv, 'allwise')[0]).toMatchObject({ id: 'J175747.94+044323.8', pmra: -1630, pmdec: 13703 });
  });
});

describe('name validation and ADQL', () => {
  it('accepts normal names', () => {
    for (const n of ["Barnard's Star", 'M 31', 'Vega', '* alf Cen', 'NAME Sirius B', 'HD 10700', 'GJ 699']) {
      expect(() => u.validateName(n)).not.toThrow();
    }
  });
  it('rejects semicolons, quotes-injection characters, empty and overlong names', () => {
    for (const n of ['a;DROP', 'x"y', 'a<b', 'a\nb', '', '   ', 'x'.repeat(81), 'café']) {
      expect(() => u.validateName(n)).toThrow();
    }
  });
  it('escapes single quotes in ADQL', () => {
    expect(u.adqlEscape("Barnard's Star")).toBe("Barnard''s Star");
    expect(u.buildSimbadQuery("a' OR '1'='1")).toContain("id = 'a'' OR ''1''=''1'");
  });
});

describe('query builders', () => {
  it('formats numbers and converts arcsec to degrees', () => {
    const q = u.buildGaiaQuery(269.452, 4.693, 300);
    expect(q).toContain('TOP 500');
    expect(q).toContain("CIRCLE('ICRS',269.452000,4.693000,0.0833333)");
    expect(q).toContain('ORDER BY phot_g_mean_mag ASC');
  });
  it('clamps radius and coordinates', () => {
    const q = u.buildGaiaQuery(400, -100, 5000);
    expect(q).toContain('CIRCLE(\'ICRS\',360.000000,-90.000000,0.2500000)');
  });
  it('builds IRSA SCS urls per WISE catalog', () => {
    const c = new URL(u.wiseUrl(269.452, 4.693, 300, 'catwise2020'));
    expect(c.origin + c.pathname).toBe('https://irsa.ipac.caltech.edu/SCS');
    expect(c.searchParams.get('table')).toBe('catwise_2020');
    expect(c.searchParams.get('RA')).toBe('269.452000');
    expect(c.searchParams.get('DEC')).toBe('4.693000');
    expect(c.searchParams.get('SR')).toBe('0.0833333');
    expect(c.searchParams.get('format')).toBe('csv');
    expect(new URL(u.wiseUrl(1, 2, 5000, 'allwise')).searchParams.get('table')).toBe('allwise_p3as_psd');
    expect(new URL(u.wiseUrl(1, 2, 5000, 'allwise')).searchParams.get('SR')).toBe('0.2500000');
  });
});

describe('Sesame and SIMBAD parsing', () => {
  const xml = `<Sesame><Target option="SNV"><name>Vega</name>
<Resolver name="Sc=Simbad"><jradeg>279.23473479</jradeg><jdedeg>38.78368896</jdedeg>
<pmRA>200.94</pmRA><pmDE>286.23</pmDE><oname>* alf Lyr</oname></Resolver></Target></Sesame>`;
  it('reads position and proper motion', () => {
    expect(u.parseSesame(xml)).toEqual({ ra: 279.23473479, dec: 38.78368896, pmra: 200.94, pmdec: 286.23 });
  });
  it('gives null pm when missing and null when nothing found', () => {
    const m31 = '<Resolver name="x"><jradeg>10.68</jradeg><jdedeg>41.27</jdedeg></Resolver>';
    expect(u.parseSesame(m31)).toEqual({ ra: 10.68, dec: 41.27, pmra: null, pmdec: null });
    expect(u.parseSesame('<Target><INFO> *** Nothing found *** </INFO></Target>')).toBeNull();
  });
  it('parses SIMBAD CSV and empty result', () => {
    expect(u.parseSimbad('main_id,ra,dec,pmra,pmdec\n"* alf Lyr",279.2,38.7,200.9,286.2\n')).toMatchObject({ ra: 279.2 });
    expect(u.parseSimbad('main_id,ra,dec,pmra,pmdec\n')).toBeNull();
  });
});
