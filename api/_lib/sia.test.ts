import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module without declarations
import { parseVotable, rowsToExposures, dedupe, queryStatus, buildSiaUrl } from './sia.js';
// @ts-expect-error plain JS module without declarations
import { numberParam, RelayError } from './http.js';

const FIELDS = [
  'dataproduct_subtype', 'energy_bandpassname', 'obs_id', 'access_url', 't_min', 't_max', 'proposal_pi', 'cloud_access',
];
function row(cells: string[]): string {
  return `<TR>${cells.map((c) => (c === '' ? '<TD/>' : `<TD>${c}</TD>`)).join('')}</TR>`;
}
function ca(key: string): string {
  return `{&quot;aws&quot;: {&quot;bucket_name&quot;: &quot;nasa-irsa-spherex&quot;, &quot;key&quot;:&quot;${key}&quot;, &quot;region&quot;: &quot;us-east-1&quot;}}`;
}
const KEY1 = 'dr1/level2/2025W35_2A/l2b-v20/2/level2_2025W35_2A_0221_2D2_spx_l2b-v20.fits';
const KEY2 = 'qr3/level2/2026W34_2A/l2b-v27/3/level2_2026W34_2A_0233_3D3_spx_l2b-v27.fits';
const FIXTURE = `<?xml version="1.0"?><VOTABLE><RESOURCE type="results"><INFO name="QUERY_STATUS" value="OK"/><TABLE>
${FIELDS.map((f) => `<FIELD name="${f}" datatype="char"/>`).join('')}
<DATA><TABLEDATA>
${row(['science', 'SPHEREx-D2', '2025W35_2A_0221_2', 'https://irsa.ipac.caltech.edu/ibe/data/spherex/' + KEY1, '60900.5', '60900.6', '', ca(KEY1)])}
${row(['science', 'SPHEREx-D3', '2026W34_2A_0233_3', 'https://irsa.ipac.caltech.edu/ibe/data/spherex/' + KEY2, '61260.1', '61260.2', '', ca(KEY2)])}
${row(['calibration', 'SPHEREx-D1', 'X_1', 'https://irsa.ipac.caltech.edu/ibe/data/spherex/' + KEY1, '1', '2', '', ''])}
</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>`;

describe('parseVotable', () => {
  const rows = parseVotable(FIXTURE);
  it('reads every row keyed by field name', () => {
    expect(rows).toHaveLength(3);
    expect(rows[0].obs_id).toBe('2025W35_2A_0221_2');
    expect(rows[1].energy_bandpassname).toBe('SPHEREx-D3');
  });
  it('decodes entities and keeps empty TD as empty string', () => {
    expect(rows[0].cloud_access.startsWith('{"aws"')).toBe(true);
    expect(JSON.parse(rows[0].cloud_access).aws.key).toBe(KEY1);
    expect(rows[0].proposal_pi).toBe('');
    expect(rows[2].cloud_access).toBe('');
  });
  it('returns [] without a table and reads QUERY_STATUS', () => {
    expect(parseVotable('<VOTABLE></VOTABLE>')).toEqual([]);
    expect(queryStatus(FIXTURE)).toBe('OK');
    expect(queryStatus('<INFO name="QUERY_STATUS" value="ERROR">x</INFO>')).toBe('ERROR');
  });
});

describe('rowsToExposures', () => {
  it('keeps science rows, maps detector and S3 url', () => {
    const ex = rowsToExposures(parseVotable(FIXTURE));
    expect(ex).toHaveLength(2);
    expect(ex[0]).toEqual({
      obsId: '2025W35_2A_0221_2', detector: 2, tMin: 60900.5, tMax: 60900.6,
      url: 'https://nasa-irsa-spherex.s3.amazonaws.com/' + KEY1, release: 'dr1',
    });
    expect(ex[1].release).toBe('qr3');
  });
  it('falls back to access_url and drops unknown releases', () => {
    const base = { dataproduct_subtype: 'science', energy_bandpassname: 'SPHEREx-D4', obs_id: 'A', t_min: '1', t_max: '2' };
    const ok = rowsToExposures([{ ...base, cloud_access: '', access_url: 'https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/a.fits' }]);
    expect(ok[0].url).toBe('https://nasa-irsa-spherex.s3.amazonaws.com/qr2/level2/a.fits');
    const bad = rowsToExposures([{ ...base, cloud_access: '', access_url: 'https://irsa.ipac.caltech.edu/ibe/data/spherex/zz9/level2/a.fits' }]);
    expect(bad).toHaveLength(0);
  });
});

describe('dedupe', () => {
  const mk = (release: string, tMin: number, detector = 1) => ({
    obsId: 'O', detector, tMin, tMax: tMin + 1, url: `u/${release}`, release,
  });
  it('prefers dr1 over qr3 over qr2 and sorts by tMin', () => {
    const out = dedupe([mk('qr2', 5), mk('qr3', 5), mk('dr1', 5), mk('qr3', 2, 2)]);
    expect(out).toHaveLength(2);
    expect(out[0].detector).toBe(2);
    expect(out[1].release).toBe('dr1');
    expect(dedupe([mk('qr2', 1), mk('qr3', 1)])[0].release).toBe('qr3');
  });
});

describe('buildSiaUrl', () => {
  it('uses the fixed host and rejects other collections', () => {
    expect(buildSiaUrl('spherex_dr1', 269.452, 4.693)).toBe(
      'https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1&POS=CIRCLE+269.452000+4.693000+0.0001&CALIB=2&MAXREC=5000',
    );
    expect(() => buildSiaUrl('evil&x=1', 1, 1)).toThrow();
  });
});

describe('numberParam', () => {
  const p = (q: string) => new URLSearchParams(q);
  it('accepts valid numbers', () => {
    expect(numberParam(p('ra=269.452'), 'ra', 0, 360)).toBe(269.452);
  });
  it('rejects missing, abc, 1e400 and out of range', () => {
    for (const q of ['', 'ra=', 'ra=abc', 'ra=1e400', 'ra=400', 'ra=-1']) {
      try {
        numberParam(p(q), 'ra', 0, 360);
        throw new Error('should have thrown for ' + q);
      } catch (e) {
        expect(e).toBeInstanceOf(RelayError);
        expect((e as { code: string }).code).toBe('BAD_INPUT');
      }
    }
  });
});
