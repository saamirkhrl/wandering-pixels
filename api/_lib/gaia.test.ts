import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS module without type declarations
import * as g from './gaia.js';

describe('Gaia variable flag', () => {
  const csv =
    'source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag,phot_variable_flag\n' +
    '4472819623984651392,269.538,4.6576,1,2,3,12.1,VARIABLE\n' +
    '4472832130942575872,269.4485,4.7394,-801.55,10362.39,546.97,8.19,NOT_AVAILABLE\n' +
    '4472832165289153024,269.4664,4.7055,,,,11.45,\n';
  it('maps VARIABLE to true, NOT_AVAILABLE to false, empty to null', () => {
    const s = g.parseGaiaWithVariable(csv);
    expect(s.map((x: { variable: boolean | null }) => x.variable)).toEqual([true, false, null]);
    expect(s[0].source_id).toBe('4472819623984651392');
  });
  it('gives null when the column is absent', () => {
    const old = 'source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag\n1,2,3,,,,9\n';
    expect(g.parseGaiaWithVariable(old)[0].variable).toBeNull();
  });
  it('variableFromFlag handles odd values', () => {
    expect(g.variableFromFlag(undefined)).toBeNull();
    expect(g.variableFromFlag('')).toBeNull();
    expect(g.variableFromFlag('SOMETHING')).toBe(false);
  });
  it('selects the flag column in the URL', () => {
    const q = new URL(g.gaiaFlagUrl(269.5, 4.6, 60)).searchParams.get('QUERY');
    expect(q).toContain('phot_g_mean_mag,phot_variable_flag FROM');
  });
});
