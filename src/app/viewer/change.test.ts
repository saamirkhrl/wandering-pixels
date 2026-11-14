import { describe, expect, it, vi } from 'vitest';

vi.mock('../data/change', () => ({
  preparedAvailable: false,
  liveAvailable: false,
  loadPreparedReadouts: vi.fn(),
  matchPreparedStar: vi.fn(),
  liveEstimate: vi.fn(),
  estimateText: vi.fn(),
  checkStarLive: vi.fn(),
  fieldFor: vi.fn(),
  measurableStars: vi.fn(),
  hasBrightNeighbour: vi.fn(),
}));

import type { ReadoutFlag } from '../data/change';
import {
  blockMode,
  CHANGE_HEADING,
  columnVerdict,
  CONNECTING_TEXT,
  FIXED_LINES,
  isSaturatedTargetClick,
  NO_STAR_TEXT,
  REASON_WORDS,
  SATURATED_STAR_TEXT,
  SATURATED_TARGET_HINT,
  SATURATED_TARGET_SLUGS,
  SATURATED_TARGET_TEXT,
  BRIGHT_NEIGHBOUR_NOTE,
  COLUMN_CONSISTENT,
  dataReasonWords,
  detectorLine,
  DISAGREE_NOTE,
  ECLIPSE_CAVEAT,
  EXAMPLE_LEAD,
  EXAMPLE_LINK_TEXT,
  exampleHref,
  COMPARE_TEXT,
  diffOverError,
  isBrightNeighbour,
  measuredLine,
  pairSummary,
  RINGS_HINT,
  SHOW_NUMBERS_PLAIN,
  Z_LEGEND,
  measurableLabel,
  measurableSummary,
  NONE_MEASURABLE_TEXT,
  variableLine,
  VARIABLE_LINE,
  SHOW_NUMBERS_TEXT,
  COLUMN_DIFFERS,
  DISAGREE,
  FIELD_BANNER_TEXT,
  fieldLine,
  fieldUnreliable,
  TOO_BRIGHT_TEXT,
  WORD_CANNOT,
  WORD_CONSISTENT,
  WORD_DIFFERS,
  Z_MATCHED_CHANGED,
  Z_MATCHED_POSSIBLE,
  Z_SINGLE_POSSIBLE,
  fewerNote,
  fmtPct,
  fmtZ,
  mjdToDate,
  nearestGaia,
  pairLabel,
  progressLine,
  verdictLine,
} from './change';

const st = (z: number | null, frac = 0.1, D = 10, sigma = 2) => ({ D, sigma, z, frac });
const m = (z: number | null) => ({ matched: st(z), flags: [] as ReadoutFlag[] });
const BANNED = [/changed/i, /variable/i, /possible change/i, /significant/i, /no change above noise/i, /not reliable here/i];

describe('column verdicts', () => {
  it('colour-matched boundaries', () => {
    expect(columnVerdict(2.99, 'matched')?.word).toBe('consistent');
    expect(columnVerdict(3, 'matched')?.word).toBe('differs');
    expect(columnVerdict(-2.99, 'matched')?.word).toBe('consistent');
    expect(columnVerdict(-3, 'matched')?.word).toBe('differs');
    expect(columnVerdict(9, 'matched')?.word).toBe('differs');
  });
  it('single-pair boundaries', () => {
    expect(columnVerdict(3.99, 'single')?.word).toBe('consistent');
    expect(columnVerdict(4, 'single')?.word).toBe('differs');
    expect(columnVerdict(-4, 'single')?.word).toBe('differs');
  });
  it('has no word for a missing z', () => {
    expect(columnVerdict(null, 'matched')).toBeNull();
    expect(columnVerdict(NaN, 'single')).toBeNull();
  });
  it('uses the named thresholds', () => {
    expect([Z_MATCHED_POSSIBLE, Z_MATCHED_CHANGED, Z_SINGLE_POSSIBLE]).toEqual([3, 5, 4]);
  });
});

describe('DISAGREE', () => {
  const p = (percent: number, error: number) => ({ D: 100, sigma: (error * 100) / Math.abs(percent), z: 1, frac: percent / 100 });
  it('compares matched and paired at 3 sigma in quadrature', () => {
    // errors 2 and 2 give 3 * sqrt(8) = 8.485
    expect(DISAGREE({ matched: p(10, 2), ps: p(18.4, 2) })).toBe(false);
    expect(DISAGREE({ matched: p(10, 2), ps: p(18.6, 2) })).toBe(true);
    expect(DISAGREE({ matched: p(10, 2), ps: p(1.4, 2) })).toBe(true);
  });
  it('ignores the plain pair unless plainGapBw is defined and below 1', () => {
    const far = { matched: p(10, 2), ps: p(10, 2), plain: p(40, 2) };
    expect(DISAGREE(far)).toBe(false);
    expect(DISAGREE({ ...far, plainGapBw: 1 })).toBe(false);
    expect(DISAGREE({ ...far, plainGapBw: 0.5 })).toBe(true);
    expect(DISAGREE({ ...far, plainGapBw: 0.5, plain: p(12, 2) })).toBe(false);
  });
  it('ignores missing values', () => {
    expect(DISAGREE({ matched: null, ps: p(5, 1) })).toBe(false);
    expect(DISAGREE({ matched: p(5, 1), ps: null })).toBe(false);
    expect(DISAGREE({ matched: p(5, 1) })).toBe(false);
  });
});

describe('verdictLine', () => {
  it('is Consistent below 3', () => {
    expect(verdictLine(m(2.99))).toEqual({ kind: 'consistent', text: 'Consistent between visits' });
    expect(verdictLine(m(-1)).text).toBe('Consistent between visits');
  });
  it('Differs from 3, with percent and error', () => {
    const v = verdictLine({ matched: st(-4.2, -0.291, -10, 0.69), flags: [] });
    expect(v.kind).toBe('differs');
    expect(v.text).toBe('Differs between visits: -29.1 +/- 2.0 percent');
    expect(verdictLine({ matched: st(3, 0.1, 10, 3.33), flags: [] }).text).toMatch(/^Differs between visits: \+10\.0/);
  });
  it('appends the 5 times note from z of 5', () => {
    expect(verdictLine({ matched: st(4.99, 0.1, 10, 2), flags: [] }).text).not.toContain('5 times');
    expect(verdictLine({ matched: st(-5, -0.1, -10, 2), flags: [] }).text).toMatch(/ by more than 5 times the error$/);
  });
  it('cannot be measured for saturated, blended, partial_visit', () => {
    const v = verdictLine({ matched: st(9), flags: ['saturated', 'blended'] });
    expect(v.kind).toBe('unreliable');
    expect(v.text).toBe(
      'Cannot be measured here: the star is saturated in some images; another star of similar brightness lies within 20 arcsec.',
    );
    expect(verdictLine({ matched: st(0), flags: ['partial_visit'] }).text).toContain('fewer than 8 usable images');
  });
  it('cannot be measured with too few wavelengths', () => {
    const w2 = [[1, 1, 1, 1], [2, 1, 1, 1]];
    const w3 = [...w2, [3, 1, 1, 1]];
    expect(verdictLine({ matched: st(1), flags: ['too_few_samples'], w: w2 }).text).toBe(
      'Cannot be measured here: too few wavelengths.',
    );
    expect(verdictLine({ matched: st(1), flags: ['too_few_samples'], w: w3 }).text).toBe('Consistent between visits');
  });
  it('cannot be measured with no result', () => {
    expect(verdictLine(m(null)).text).toBe('Cannot be measured here: no result.');
    expect(verdictLine({ matched: null, flags: [] }).text).toBe('Cannot be measured here: no result.');
  });
  it('never fails a pair on estimator disagreement', () => {
    const v = verdictLine({ matched: st(5, 0.5, 10, 1), plain: st(1, 0.1, 10, 1), ps: st(1, 0.5, 10, 1), flags: [] });
    expect(v.kind).toBe('differs');
  });
  it('passes unreliableReasons through when reliable is false', () => {
    const v = verdictLine({ matched: st(9), flags: ['saturated'], reliable: false, unreliableReasons: ['reason one', 'reason two'] });
    expect(v.text).toBe('Cannot be measured here: reason one; reason two.');
    expect(verdictLine({ matched: st(9), flags: [], reliable: true }).kind).toBe('differs');
    expect(verdictLine({ matched: st(9), flags: [], reliable: false }).kind).toBe('unreliable');
  });
  it('no_bracket and too_few_samples with enough wavelengths do not override', () => {
    expect(verdictLine({ matched: st(6), flags: ['no_bracket'] }).kind).toBe('differs');
    expect(
      fewerNote({ matched: { z: 6 }, flags: ['too_few_samples', 'no_bracket'], w: [1, 2, 3] }),
    ).toBe('Fewer wavelengths used: too few images at some colours; some shared colours fall outside what one visit sampled.');
    expect(fewerNote({ matched: { z: 6 }, flags: ['no_bracket'] })).toBe(
      'Fewer wavelengths used: some shared colours fall outside what one visit sampled.',
    );
    expect(fewerNote(m(6))).toBeNull();
    expect(fewerNote({ matched: { z: null }, flags: ['no_bracket'] })).toBeNull();
  });
  it('never uses banned words', () => {
    const texts = [
      CONNECTING_TEXT,
      NO_STAR_TEXT,
      SATURATED_STAR_TEXT,
      SATURATED_TARGET_TEXT,
      SATURATED_TARGET_HINT,
      TOO_BRIGHT_TEXT,
      FIELD_BANNER_TEXT,
      // BRIGHT_NEIGHBOUR_NOTE says 'variable or not' by agreed wording; its exact text is tested below
      WORD_CONSISTENT,
      WORD_DIFFERS,
      WORD_CANNOT,
      COLUMN_CONSISTENT,
      COLUMN_DIFFERS,
      ...Object.values(REASON_WORDS),
      verdictLine({ matched: st(9), flags: ['saturated'] }).text,
      verdictLine(m(0)).text,
      verdictLine(m(null)).text,
      verdictLine({ matched: st(9, 0.3, 10, 1), flags: [] }).text,
      fieldLine({ field: { differ: 3, measured: 20 } }) as string,
    ];
    for (const t of texts) for (const re of BANNED) expect(t).not.toMatch(re);
    // the heading and the kept yardstick line say a steady star looks "more changed"; every other banned phrase must be absent
    for (const t of [...FIXED_LINES, CHANGE_HEADING]) for (const re of BANNED.slice(1)) expect(t).not.toMatch(re);
  });
});

describe('field context', () => {
  it('writes the field line', () => {
    expect(fieldLine({ field: { differ: 3, measured: 40 } })).toBe(
      'In this field 3 of 40 measured stars differ; for well-isolated stars about 1 in 100 is expected by chance (see the note below).',
    );
    expect(fieldLine({})).toBeNull();
  });
  it('flags a field above 15 percent with at least 10 stars', () => {
    expect(fieldUnreliable({ field: { differ: 2, measured: 10 } })).toBe(true);
    expect(fieldUnreliable({ field: { differ: 1, measured: 10 } })).toBe(false);
    expect(fieldUnreliable({ field: { differ: 3, measured: 20 } })).toBe(false);
    expect(fieldUnreliable({ field: { differ: 4, measured: 20 } })).toBe(true);
    expect(fieldUnreliable({ field: { differ: 5, measured: 9 } })).toBe(false);
    expect(fieldUnreliable({})).toBe(false);
  });
  it('fieldReliable wins over the fraction', () => {
    expect(fieldUnreliable({ fieldReliable: false })).toBe(true);
    expect(fieldUnreliable({ fieldReliable: true, field: { differ: 9, measured: 10 } })).toBe(false);
  });
  it('renders every pair of a bad field as not measurable', () => {
    const bad = { matched: st(9), flags: [] as ReadoutFlag[], field: { differ: 8, measured: 20 } };
    expect(verdictLine(bad).text).toBe('Cannot be measured here: too many stars in this field differ together.');
    expect(FIELD_BANNER_TEXT).toBe('Readouts in this field are not reliable: too many stars differ together.');
  });
});

describe('bright neighbour, data reasons, catalogue, links', () => {
  it('is calm when the data layer lists bright_neighbour', () => {
    const v = verdictLine({ matched: st(9), flags: [], reliable: false, unreliableReasons: ['bright_neighbour'] });
    expect(v).toEqual({ kind: 'calm', text: 'Cannot be measured here: a bright star is nearby.' });
  });
  it('is calm from the caller only when no reliable field is present', () => {
    expect(verdictLine({ matched: st(9), flags: [], brightNeighbour: true }).kind).toBe('calm');
    expect(verdictLine({ matched: st(9), flags: [], reliable: true, brightNeighbour: true }).kind).toBe('differs');
    expect(verdictLine({ matched: st(0), flags: [], brightNeighbour: true }).kind).toBe('calm');
    expect(isBrightNeighbour({ matched: st(0), flags: [], reliable: false, unreliableReasons: ['saturated'], brightNeighbour: true })).toBe(false);
  });
  it('other reasons win over the calm state and stay explicit', () => {
    const v = verdictLine({ matched: st(9), flags: ['saturated'], brightNeighbour: true });
    expect(v.kind).toBe('unreliable');
    expect(v.text).toBe('Cannot be measured here: the star is saturated in some images.');
    const w = verdictLine({ matched: st(9), flags: [], reliable: false, unreliableReasons: ['bright_neighbour', 'blended'] });
    expect(w.text).toBe('Cannot be measured here: another star of similar brightness lies within 20 arcsec.');
  });
  it('the calm sentence is fixed', () => {
    expect(BRIGHT_NEIGHBOUR_NOTE).toBe('The readout is unreliable within about 3 arcminutes of any star brighter than magnitude 9, variable or not.');
    expect(SHOW_NUMBERS_TEXT).toBe('Show the numbers anyway');
  });
  it('maps data reasons to words', () => {
    expect(dataReasonWords('saturated')).toBe('the star is saturated in some images');
    expect(dataReasonWords('blended')).toBe('another star of similar brightness lies within 20 arcsec');
    expect(dataReasonWords('partial_visit')).toBe('a visit has fewer than 8 usable images of this star');
    expect(dataReasonWords('fewer than 2 wavelengths')).toBe('too few wavelengths');
    expect(dataReasonWords('field offset')).toBe('too many stars in this field differ together');
    expect(dataReasonWords('bright_neighbour')).toBe('a bright star is nearby');
    expect(dataReasonWords('odd_new_reason')).toBe('odd new reason');
    const v = verdictLine({ matched: st(9), flags: [], reliable: false, unreliableReasons: ['fewer than 2 wavelengths', 'odd_one'] });
    expect(v.text).toBe('Cannot be measured here: too few wavelengths; odd one.');
  });
  it('has the disagreement and caveat texts', () => {
    expect(DISAGREE_NOTE).toBe('The matched and paired estimates disagree here; treat the result with caution.');
    expect(ECLIPSE_CAVEAT).toBe(
      'An eclipse lasts hours and a visit lasts weeks, so the size of the change depends on which exposures happened to fall in eclipse. Detectors can even disagree in sign.',
    );
    for (const t of [ECLIPSE_CAVEAT, DISAGREE_NOTE]) expect(t).not.toMatch(/trend|fading|period/i);
  });
  it('shows the variable line only when there is no catalogue note', () => {
    expect(variableLine({ variable: true, catalogueNote: 'x' }, 'differs')).toBeNull();
    expect(variableLine({ variable: true }, 'differs')).toBe('Catalogued as variable in Gaia DR3.');
  });
  it('writes the detector line and the example link', () => {
    expect(detectorLine(3)).toBe('Readout prepared for detector 3.');
    expect(exampleHref('V391 Oph')).toBe('?view=viewer&q=V391%20Oph');
    expect(EXAMPLE_LEAD).toBe('To see this readout on a star that really varies, ');
    expect(EXAMPLE_LINK_TEXT).toBe('open the example');
    expect(TOO_BRIGHT_TEXT).toBe('Too bright to measure here. Click a fainter star in the field.');
  });
});

describe('variable line and measurable aid', () => {
  it('shows the variable line only for variable stars with a Differs headline', () => {
    expect(variableLine({ variable: true }, 'differs')).toBe('Catalogued as variable in Gaia DR3.');
    expect(variableLine({ variable: true }, 'consistent')).toBeNull();
    expect(variableLine({ variable: true }, 'unreliable')).toBeNull();
    expect(variableLine({ variable: true }, 'calm')).toBeNull();
    expect(variableLine({ variable: false }, 'differs')).toBeNull();
    expect(variableLine({ variable: null }, 'differs')).toBeNull();
    expect(variableLine({}, 'differs')).toBeNull();
  });
  it('labels measurable stars', () => {
    expect(measurableLabel({ id: '123', gmag: 11.26, isTarget: false })).toBe('Gaia DR3 123, G 11.3');
    expect(measurableLabel({ id: '123', gmag: null, isTarget: false })).toBe('Gaia DR3 123');
    expect(measurableLabel({ id: 't', gmag: 5, isTarget: true })).toBe('The target');
    expect(measurableSummary(4)).toBe('Show stars that can be measured here (4)');
    expect(NONE_MEASURABLE_TEXT).toBe('No star in this field can be measured reliably.');
    expect(VARIABLE_LINE).not.toMatch(/trend|fading/i);
  });
});

describe('clarity, snapping, rings', () => {
  it('writes the z line and legend', () => {
    expect(diffOverError({ D: 1, sigma: 1, z: -1.74, frac: 0.1 })).toBe('difference / error: -1.7');
    expect(diffOverError(null)).toBe('difference / error: no value');
    expect(Z_LEGEND).toBe(
      'Difference / error (z) is the change divided by its error bar; 3 or more counts as a difference for the colour-matched estimate, 4 for the other two.',
    );
    expect(SHOW_NUMBERS_PLAIN).toBe('Show the numbers');
  });
  it('writes the collapsed pair summary in lower case', () => {
    expect(pairSummary(60800, 61300, 'Consistent between visits')).toMatch(/^\d+ \w+ \d{4} to \d+ \w+ \d{4}: consistent between visits$/);
  });
  it('writes the measured line', () => {
    expect(measuredLine({ id: '99', gmag: 12.91, isTarget: false })).toBe('Measured: Gaia DR3 99, G magnitude 12.9.');
    expect(measuredLine({ id: 't', gmag: 3, isTarget: true })).toBe('Measured: the target.');
  });
  it('snaps within 4 pixels when nothing is within 2', () => {
    const g = (dec: number) => ({ sourceId: 'x', ra: 10, dec, pmra: null, pmdec: null, parallax: null, gmag: 12 });
    const three = g(3 * 6.15 / 3600);
    expect(nearestGaia([three], 10, 0, 6.15)).toBe(three);
    expect(nearestGaia([g(5 * 6.15 / 3600)], 10, 0, 6.15)).toBeNull();
    const near = g(1 * 6.15 / 3600);
    expect(nearestGaia([three, near], 10, 0, 6.15)).toBe(near);
  });
  it('has the rings hint and compare text', () => {
    expect(RINGS_HINT).toBe('They are ringed on the image; click one to open its readout.');
    expect(COMPARE_TEXT).toBe('Compare with a steady neighbour');
  });
});

describe('saturated targets', () => {
  const ctx = { slug: 'rw-aur', pixelArcsec: 6.15, target: { ra: 10, dec: 0 } };
  it('lists the slugs and text', () => {
    expect(SATURATED_TARGET_SLUGS).toEqual(['barnards-star', 'rw-aur', 'r-dra']);
    expect(SATURATED_TARGET_TEXT).toBe('Saturated in SPHEREx images, so brightness changes cannot be measured here.');
    expect(SATURATED_TARGET_HINT).toBe('Click a fainter star in the field to check it.');
  });
  it('matches only clicks within two pixels of the target', () => {
    expect(isSaturatedTargetClick(ctx, 10, 0.001)).toBe(true);
    expect(isSaturatedTargetClick(ctx, 10, 0.01)).toBe(false);
    expect(isSaturatedTargetClick({ ...ctx, slug: 'other' }, 10, 0)).toBe(false);
    expect(isSaturatedTargetClick({ ...ctx, slug: null }, 10, 0)).toBe(false);
    expect(isSaturatedTargetClick({ ...ctx, target: undefined }, 10, 0)).toBe(false);
  });
});

describe('percent formatting', () => {
  const s = (D: number | null, sigma: number | null, z: number | null, frac: number | null) => ({ D, sigma, z, frac });
  it('formats value and error', () => {
    expect(fmtPct(s(10, 6.6667, 1.5, 0.021))).toBe('+2.1 +/- 1.4 percent');
    expect(fmtPct(s(-10, 5, -2, -0.05))).toBe('-5.0 +/- 2.5 percent');
    expect(fmtPct(s(1, 1, 0, -0.0001))).toBe('+0.0 +/- 0.0 percent');
  });
  it('shows no value for nulls and zero D', () => {
    expect(fmtPct(s(0, 1, 0, 0.1))).toBe('no value');
    expect(fmtPct(s(null, 1, 0, 0.1))).toBe('no value');
    expect(fmtPct(s(1, 1, 0, null))).toBe('no value');
    expect(fmtPct(null)).toBe('no value');
  });
  it('formats z to one decimal', () => {
    expect(fmtZ(s(1, 1, -1.24, 0.1))).toBe('z = -1.2');
    expect(fmtZ(s(1, 1, null, 0.1))).toBe('z = no value');
  });
});

describe('dates', () => {
  it('converts MJD', () => {
    expect(mjdToDate(40587)).toBe('1 Jan 1970');
    expect(mjdToDate(60737)).toBe('3 Mar 2025');
  });
  it('labels a pair by dates', () => {
    expect(pairLabel(60737, 61100)).toBe('3 Mar 2025 to 1 Mar 2026, 363 days apart');
  });
});

describe('block text and mode', () => {
  it('has the exact fixed lines', () => {
    expect(FIXED_LINES).toHaveLength(6);
    expect(new Set(FIXED_LINES).size).toBe(6);
    expect(FIXED_LINES.join(' ')).not.toMatch(/threshold/i);
    expect(FIXED_LINES[0]).toMatch(/^A difference here is a reason to look closer, not a discovery\./);
    expect(FIXED_LINES[1]).toBe(
      'The 1 percent false-alarm rate holds for unblended, unsaturated stars of Gaia G 12 to 16.5, more than 3 arcminutes from any star brighter than G 9. Near saturated stars, or for blends, it can be tens of percent, and the site marks those results as not reliable.',
    );
    expect(FIXED_LINES[5]).toBe(
      "Error bars include an extra 2 percent of the star's brightness, which we measured to be missing from the archive's own errors.",
    );
  });
  it('is connecting when nothing is available', () => {
    expect(CONNECTING_TEXT).toBe('This check is being connected.');
    expect(blockMode('barnards-star', false, false)).toBe('connecting');
    expect(blockMode(null, true, false)).toBe('connecting');
    expect(blockMode('barnards-star', true, false)).toBe('prepared');
    expect(blockMode(null, true, true)).toBe('live');
  });
  it('writes the progress line', () => {
    expect(progressLine(12.4e6, 21e6, 14, 36)).toBe('Read 12.4 MB of about 21 MB, 14 of 36 images');
  });
  it('finds the nearest gaia star within two pixels', () => {
    const g = (ra: number, dec: number) => ({ sourceId: 'x', ra, dec, pmra: null, pmdec: null, parallax: null, gmag: 12 });
    const near = g(10, 0.0005);
    expect(nearestGaia([g(10, 0.01), near], 10, 0, 6.15)).toBe(near);
    expect(nearestGaia([g(10, 0.01)], 10, 0, 6.15)).toBeNull();
  });
});
