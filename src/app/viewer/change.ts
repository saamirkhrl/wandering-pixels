import type { Exposure, GaiaStar } from '../../lib/spherex/types';
import {
  checkStarLive,
  estimateText,
  fieldFor,
  hasBrightNeighbour,
  liveAvailable,
  liveEstimate,
  loadPreparedReadouts,
  measurableStars,
  matchPreparedStar,
  preparedAvailable,
} from '../data/change';
import type { ChangePair, ChangeStar, ChangeStat, PreparedReadouts, ReadoutFlag } from '../data/change';
import '../../ui/change.css';

export interface ChangeContext {
  slug: string | null;
  exposures: Exposure[];
  gaia: GaiaStar[];
  pixelArcsec: number;
  target?: { ra: number; dec: number };
}

export const CHANGE_HEADING = 'Has it changed between visits?';
export const CONNECTING_TEXT = 'This check is being connected.';
export const NO_STAR_TEXT = 'No catalogued star within 2 pixels of this spot. Click on the centre of a star to check it.';
export const SATURATED_STAR_TEXT = 'This star is too bright for a clean measurement. Try clicking a fainter star nearby.';

export const SATURATED_TARGET_TEXT = 'Saturated in SPHEREx images, so brightness changes cannot be measured here.';
export const SATURATED_TARGET_HINT = 'Click a fainter star in the field to check it.';
export const SATURATED_TARGET_SLUGS: readonly string[] = ['barnards-star', 'rw-aur', 'r-dra'];
export const TOO_BRIGHT_TEXT = 'Too bright to measure here. Click a fainter star in the field.';
export const FIELD_BANNER_TEXT = 'Readouts in this field are not reliable: too many stars differ together.';
export const BRIGHT_NEIGHBOUR_REASON = 'a bright star is nearby';
export const BRIGHT_NEIGHBOUR_TEXT = `${'Cannot be measured here'}: ${BRIGHT_NEIGHBOUR_REASON}.`;
export const BRIGHT_NEIGHBOUR_NOTE = 'The readout is unreliable within about 3 arcminutes of any star brighter than magnitude 9, variable or not.';
/** Field-level notes by prepared slug, signed by science; shown at the top of the block in that field. */
export const FIELD_NOTES: Readonly<Record<string, string>> = {
  'r-dra': 'R Draconis itself is saturated, but nearby stars appear to brighten and fade together between visits, most strongly close to it, as its glow changes.',
};
export const SHOW_NUMBERS_TEXT = 'Show the numbers anyway';
export const ECLIPSE_CAVEAT =
  'An eclipse lasts hours and a visit lasts weeks, so the size of the change depends on which exposures happened to fall in eclipse. Detectors can even disagree in sign.';
export const DISAGREE_NOTE = 'The three estimates disagree.';
export const VARIABLE_LINE = 'Catalogued as variable in Gaia DR3.';
export const NONE_MEASURABLE_TEXT = 'No star in this field can be measured reliably.';
export const EXAMPLE_SLUG = 'v391-oph';
export const EXAMPLE_LEAD = 'To see this readout on a star that really varies, ';
export const EXAMPLE_LINK_TEXT = 'open the example';
export const FIELD_UNRELIABLE_REASON = 'too many stars in this field differ together';

export const Z_MATCHED_POSSIBLE = 3;
export const Z_MATCHED_CHANGED = 5;
export const Z_SINGLE_POSSIBLE = 4;
export const FIELD_MIN_MEASURED = 10;
export const FIELD_MAX_FRACTION = 0.15;

export const WORD_CONSISTENT = 'Consistent between visits';
export const WORD_DIFFERS = 'Differs between visits';
export const WORD_CANNOT = 'Cannot be measured here';
export const COLUMN_CONSISTENT = 'Consistent';
export const COLUMN_DIFFERS = 'Differs';

export const FIXED_LINES: readonly string[] = [
  'A difference here is a reason to look closer, not a discovery. On steady stars about 1 in 100 comparisons differ by chance in our tests, and more in crowded or saturated fields.',
  "Each SPHEREx image sees a slightly different infrared colour, so we fit this star's colours within each visit and compare the visits at one shared colour.",
  'On steady stars this comparison scatters by about 2.6 percent; a single pair of images scatters by about 5.7 percent.',
  'A plain pair of images is trustworthy only when the two wavelengths nearly match. Each extra channel of gap makes a steady star look more changed.',
  'Error bars widened by our measured factor.',
];

export const REASON_WORDS: Record<ReadoutFlag, string> = {
  saturated: 'the star is saturated in some images',
  blended: 'another star of similar brightness lies within 20 arcsec',
  partial_visit: 'a visit has fewer than 8 usable images of this star',
  too_few_samples: 'too few images at some colours',
  no_bracket: 'some shared colours fall outside what one visit sampled',
};

const OVERRIDE_FLAGS: ReadoutFlag[] = ['saturated', 'blended', 'partial_visit'];
const NOTE_FLAGS: ReadoutFlag[] = ['too_few_samples', 'no_bracket'];

export function reasonWords(flags: ReadoutFlag[]): string {
  return flags.map((f) => REASON_WORDS[f]).join('; ');
}

export type VerdictKind = 'consistent' | 'differs' | 'unreliable' | 'calm';
export type ColumnKind = 'matched' | 'single';

// optional fields the data layer may attach to a pair
export interface PairExtras {
  reliable?: boolean;
  unreliableReasons?: string[];
  fieldReliable?: boolean;
  fieldChangedFraction?: number;
  field?: { differ: number; measured: number };
}
export type ShownPair = ChangePair & PairExtras;

// the verdict word for one column from its z score; null when there is no z
export function columnVerdict(z: number | null | undefined, column: ColumnKind): { kind: 'consistent' | 'differs'; word: string } | null {
  if (z === null || z === undefined || !Number.isFinite(z)) return null;
  const limit = column === 'matched' ? Z_MATCHED_POSSIBLE : Z_SINGLE_POSSIBLE;
  return Math.abs(z) >= limit ? { kind: 'differs', word: COLUMN_DIFFERS } : { kind: 'consistent', word: COLUMN_CONSISTENT };
}

// true when any two available estimates differ by more than the sum of their errors
export function DISAGREE(stats: (ChangeStat | null | undefined)[]): boolean {
  const v = stats.map((x) => pctValue(x ?? null)).filter((x): x is { percent: number; error: number } => x !== null);
  for (let i = 0; i < v.length; i++) {
    for (let j = i + 1; j < v.length; j++) {
      if (Math.abs(v[i].percent - v[j].percent) > v[i].error + v[j].error) return true;
    }
  }
  return false;
}

// true when this pair's field is flagged as not reliable
export function fieldUnreliable(pair: PairExtras): boolean {
  if (pair.fieldReliable === false) return true;
  const f = pair.field;
  return pair.fieldReliable === undefined && f !== undefined && f.measured >= FIELD_MIN_MEASURED && f.differ / f.measured > FIELD_MAX_FRACTION;
}

const DATA_REASONS: Record<string, string> = {
  saturated: REASON_WORDS.saturated,
  blended: REASON_WORDS.blended,
  partial_visit: REASON_WORDS.partial_visit,
  'fewer than 2 wavelengths': 'too few wavelengths',
  'field offset': FIELD_UNRELIABLE_REASON,
  bright_neighbour: BRIGHT_NEIGHBOUR_REASON,
};

export function dataReasonWords(r: string): string {
  return DATA_REASONS[r] ?? r.replace(/_/g, ' ');
}

export function exampleHref(name: string): string {
  return `?view=viewer&q=${encodeURIComponent(name)}`;
}

export function detectorLine(n: number): string {
  return `Readout prepared for detector ${n}.`;
}

export interface VerdictInput extends PairExtras {
  matched: { z: number | null; D?: number | null; sigma?: number | null; frac?: number | null } | null;
  plain?: ChangeStat | null;
  ps?: ChangeStat | null;
  w?: unknown[];
  flags: ReadoutFlag[];
  // the caller found a bright star nearby; used only when the data layer gave no `reliable` field
  brightNeighbour?: boolean;
  // the star carries a catalogue note, so disagreement between estimators is a small note, not a reason
  catalogue?: boolean;
}

export function isBrightNeighbour(pair: VerdictInput): boolean {
  if ((pair.unreliableReasons ?? []).includes('bright_neighbour')) return true;
  return pair.reliable === undefined && pair.brightNeighbour === true;
}

// reasons other than a bright neighbour; empty when the pair can be read
function cannotReasons(pair: VerdictInput): string[] {
  // the data seat's reliability decision wins when present; our own rules are only the fallback
  if (pair.reliable === true) return columnVerdict(pair.matched?.z, 'matched') === null ? ['no result'] : [];
  if (fieldUnreliable(pair)) return [FIELD_UNRELIABLE_REASON];
  if (pair.reliable === false) {
    const given = (pair.unreliableReasons ?? []).filter((r) => r.length > 0 && r !== 'bright_neighbour').map(dataReasonWords);
    if (given.length > 0) return given;
    if ((pair.unreliableReasons ?? []).includes('bright_neighbour')) return [];
  }
  const own: string[] = [];
  const over = pair.flags.filter((f) => OVERRIDE_FLAGS.includes(f));
  if (over.length > 0) own.push(reasonWords(over));
  if (pair.flags.includes('too_few_samples') && (pair.w?.length ?? 3) < 3) own.push('too few wavelengths');
  if (columnVerdict(pair.matched?.z, 'matched') === null) own.push('no result');
  else if (!pair.catalogue && DISAGREE([(pair.matched as ChangeStat | null) ?? null, pair.plain, pair.ps])) own.push('the three estimates disagree');
  if (own.length === 0 && pair.reliable === false) return ['flagged as unreliable'];
  return own;
}

// headline for a visit pair: one of three findings; 'calm' is the quiet bright-neighbour state
export function verdictLine(pair: VerdictInput): { kind: VerdictKind; text: string } {
  const why = cannotReasons(pair);
  if (why.length > 0) return { kind: 'unreliable', text: `${WORD_CANNOT}: ${why.join('; ')}.` };
  if (isBrightNeighbour(pair)) return { kind: 'calm', text: BRIGHT_NEIGHBOUR_TEXT };
  const z = pair.matched?.z as number;
  if (Math.abs(z) < Z_MATCHED_POSSIBLE) return { kind: 'consistent', text: WORD_CONSISTENT };
  const v = pair.matched ? pctValue(pair.matched as ChangeStat) : null;
  let text = WORD_DIFFERS;
  if (v) text += `: ${fmtPct(pair.matched as ChangeStat)}`;
  if (Math.abs(z) >= Z_MATCHED_CHANGED) text += ' by more than 5 times the error';
  return { kind: 'differs', text };
}

// shown beside a "Differs" headline for stars Gaia lists as variable
export function variableLine(star: Pick<ChangeStar, 'variable'>, kind: VerdictKind): string | null {
  return star.variable === true && kind === 'differs' ? VARIABLE_LINE : null;
}

export type MeasurableEntry = PreparedReadouts['stars'][number];

export function measurableLabel(e: Pick<MeasurableEntry, 'id' | 'gmag' | 'isTarget'>): string {
  if (e.isTarget) return 'The target';
  return e.gmag === null ? `Gaia DR3 ${e.id}` : `Gaia DR3 ${e.id}, G ${e.gmag.toFixed(1)}`;
}

export function measurableSummary(n: number): string {
  return `Show stars that can be measured here (${n})`;
}

export function fieldLine(pair: PairExtras): string | null {
  const f = pair.field;
  return f ? `In this field ${f.differ} of ${f.measured} measured stars differ; about 1 in 100 is expected by chance.` : null;
}

export function fewerNote(pair: { matched: { z: number | null } | null; flags: ReadoutFlag[]; w?: unknown[] }): string | null {
  if (columnVerdict(pair.matched?.z, 'matched') === null) return null;
  const f = pair.flags.filter((x) => NOTE_FLAGS.includes(x) && (x !== 'too_few_samples' || (pair.w?.length ?? 3) >= 3));
  return f.length > 0 ? `Fewer wavelengths used: ${reasonWords(f)}.` : null;
}

// percent change and its error, both in percent; null when the statistic has no usable value
export function pctValue(s: ChangeStat | null): { percent: number; error: number } | null {
  if (!s || s.frac === null || s.D === null || s.D === 0 || s.sigma === null) return null;
  if (!Number.isFinite(s.frac) || !Number.isFinite(s.D) || !Number.isFinite(s.sigma)) return null;
  const percent = s.frac * 100;
  return { percent, error: (Math.abs(percent) * s.sigma) / Math.abs(s.D) };
}

export function fmtPct(s: ChangeStat | null): string {
  const v = pctValue(s);
  if (!v) return 'no value';
  const mag = Math.abs(v.percent).toFixed(1);
  const sign = v.percent < 0 && Number(mag) > 0 ? '-' : '+';
  return `${sign}${mag} +/- ${v.error.toFixed(1)} percent`;
}

export function fmtZ(s: ChangeStat | null): string {
  return s && s.z !== null && Number.isFinite(s.z) ? `z = ${s.z.toFixed(1)}` : 'z = no value';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function mjdToDate(mjd: number): string {
  const d = new Date(Math.round((mjd - 40587) * 86400000));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function pairLabel(tA: number, tB: number): string {
  const days = Math.round(tB - tA);
  return `${mjdToDate(tA)} to ${mjdToDate(tB)}, ${days} ${days === 1 ? 'day' : 'days'} apart`;
}

export function plainDetail(pair: ChangePair): string {
  const n = pair.w.length;
  return `${n} ${n === 1 ? 'colour' : 'colours'}, one image per visit each`;
}

export function pairedDetail(pair: ChangePair): string {
  const n = pair.ps.n;
  return `${n} image ${n === 1 ? 'pair' : 'pairs'}`;
}

export function matchedDetail(pair: ChangePair): string {
  const n = pair.w.length;
  const base = `${pair.nA} and ${pair.nB} images, ${n} shared ${n === 1 ? 'colour' : 'colours'}`;
  if (n === 0) return base;
  const ws = pair.w.map((r) => r[0]);
  if (n === 1) return `${base} at ${ws[0].toFixed(2)} micrometres`;
  return `${base} from ${Math.min(...ws).toFixed(2)} to ${Math.max(...ws).toFixed(2)} micrometres`;
}

export function allSaturated(star: ChangeStar): boolean {
  if (star.pairs.length === 0) return false;
  if (star.isTarget && star.pairs.some((p) => p.flags.includes('saturated'))) return true;
  return star.pairs.every((p) => p.flags.includes('saturated'));
}

// true when the click is on a known saturated target, within two pixels of its position at the image epoch
export function isSaturatedTargetClick(ctx: Pick<ChangeContext, 'slug' | 'target' | 'pixelArcsec'>, ra: number, dec: number): boolean {
  if (!ctx.slug || !SATURATED_TARGET_SLUGS.includes(ctx.slug) || !ctx.target) return false;
  const cosd = Math.cos((dec * Math.PI) / 180);
  let dr = ctx.target.ra - ra;
  if (dr > 180) dr -= 360;
  if (dr < -180) dr += 360;
  return Math.hypot(dr * cosd, ctx.target.dec - dec) * 3600 <= 2 * ctx.pixelArcsec;
}

export type BlockMode = 'prepared' | 'live' | 'connecting';

export function blockMode(slug: string | null, prepared: boolean, live: boolean): BlockMode {
  if (slug && prepared) return 'prepared';
  if (live) return 'live';
  return 'connecting';
}

export function progressLine(bytes: number, estBytes: number, done: number, total: number): string {
  const mb = (b: number, dp: number): string => (b / 1e6).toFixed(dp);
  return `Read ${mb(bytes, 1)} MB of about ${mb(estBytes, 0)} MB, ${done} of ${total} images`;
}

// the Gaia star nearest the click, if it lies within two pixels
// epochYear: Julian year of the clicked image; Gaia positions (2016.0) are moved there by their proper motion
export function nearestGaia(gaia: GaiaStar[], ra: number, dec: number, pixelArcsec: number, epochYear = 2016): GaiaStar | null {
  const cosd = Math.cos((dec * Math.PI) / 180);
  const dt = epochYear - 2016;
  let best: GaiaStar | null = null;
  let bestD = 2 * pixelArcsec;
  for (const g of gaia) {
    let dr = g.ra + ((g.pmra ?? 0) * dt) / 3.6e6 / cosd - ra;
    if (dr > 180) dr -= 360;
    if (dr < -180) dr += 360;
    const d = Math.hypot(dr * cosd, g.dec + ((g.pmdec ?? 0) * dt) / 3.6e6 - dec) * 3600;
    if (d <= bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}

const NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// one shared half-width (percent) for every plot in the block
function plotExtent(pairs: ChangePair[]): number {
  let m = 0;
  for (const p of pairs) {
    for (const s of [p.plain, p.ps, p.matched]) {
      const v = pctValue(s);
      if (v) m = Math.max(m, Math.abs(v.percent) + v.error);
    }
  }
  return m > 0 ? m * 1.1 : 5;
}

function plot(pair: ChangePair, max: number): SVGSVGElement {
  const W = 300;
  const H = 76;
  const L = 8;
  const R = W - 8;
  const mid = W / 2;
  const sx = (v: number): number => mid + (v / max) * (mid - L);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'change-plot');
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag: string, attrs: Record<string, number | string>, text?: string): void => {
    const n = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs)) n.setAttribute(k, String(attrs[k]));
    if (text !== undefined) n.textContent = text;
    svg.appendChild(n);
  };
  const axisY = 46;
  add('line', { x1: mid, x2: mid, y1: 2, y2: axisY, class: 'change-zero' });
  add('line', { x1: L, x2: R, y1: axisY, y2: axisY, class: 'change-axis' });
  const ticks: [number, string][] = [
    [-max, `${(-max).toFixed(0)}`],
    [0, '0'],
    [max, `${max.toFixed(0)}`],
  ];
  for (const [v, t] of ticks) {
    add('line', { x1: sx(v), x2: sx(v), y1: axisY, y2: axisY + 3, class: 'change-axis' });
    add('text', { x: sx(v), y: axisY + 13, 'text-anchor': v < 0 ? 'start' : v > 0 ? 'end' : 'middle', class: 'change-tick' }, t);
  }
  add('text', { x: mid, y: H - 3, 'text-anchor': 'middle', class: 'change-tick' }, 'Change in percent');
  const rows: [ChangeStat | null, boolean, number][] = [
    [pair.plain, false, 9],
    [pair.ps, false, 22],
    [pair.matched, true, 35],
  ];
  for (const [s, strong, y] of rows) {
    const v = pctValue(s);
    if (!v) continue;
    const cls = strong ? 'change-strong' : 'change-light';
    const lo = sx(v.percent - v.error);
    const hi = sx(v.percent + v.error);
    add('line', { x1: lo, x2: hi, y1: y, y2: y, class: `change-err ${cls}` });
    add('line', { x1: lo, x2: lo, y1: y - 3, y2: y + 3, class: `change-err ${cls}` });
    add('line', { x1: hi, x2: hi, y1: y - 3, y2: y + 3, class: `change-err ${cls}` });
    add('circle', { cx: sx(v.percent), cy: y, r: 3, class: `change-dot ${cls}` });
  }
  return svg;
}

function cell(name: string, s: ChangeStat | null, detail: string, strong: boolean, column: ColumnKind, missing?: string): HTMLElement {
  const c = el('div', strong ? 'change-cell change-cell-strong' : 'change-cell');
  c.appendChild(el('div', 'change-cell-name', name));
  if (missing !== undefined) {
    c.appendChild(el('div', 'change-val', missing));
    return c;
  }
  c.appendChild(el('div', 'change-val', fmtPct(s)));
  c.appendChild(el('div', 'change-z', fmtZ(s)));
  const cv = columnVerdict(s?.z, column);
  if (cv) c.appendChild(el('div', 'change-word', cv.word));
  c.appendChild(el('div', 'change-detail', detail));
  return c;
}

export interface ResultsOptions {
  brightNeighbour?: boolean;
  detector?: number;
  example?: { name: string } | null;
}

export function renderResults(star: ChangeStar, opts: ResultsOptions = {}): HTMLElement {
  const wrap = el('div', 'change-results');
  // the field line only when every visit pair of this field is affected; otherwise each pair says so itself
  if (star.pairs.length > 0 && star.pairs.every((p) => fieldUnreliable(p))) wrap.appendChild(el('p', 'change-banner', FIELD_BANNER_TEXT));
  const max = plotExtent(star.pairs);
  if (star.pairs.length === 0) wrap.appendChild(el('p', 'change-note', 'No pair of visits covers this star.'));
  let calmShown = false;
  for (const p of star.pairs as ShownPair[]) {
    const sec = el('div', 'change-pair');
    sec.appendChild(el('h5', 'change-head', pairLabel(p.tA, p.tB)));
    const input: VerdictInput = { ...p, brightNeighbour: opts.brightNeighbour, catalogue: !!star.catalogueNote };
    const v = verdictLine(input);
    sec.appendChild(el('p', `change-verdict change-${v.kind}`, v.text));
    if (v.kind === 'calm' && !calmShown) {
      calmShown = true;
      sec.appendChild(el('p', 'change-note', BRIGHT_NEIGHBOUR_NOTE));
    }
    if (star.catalogueNote) {
      sec.appendChild(el('p', 'change-note', star.catalogueNote));
      sec.appendChild(el('p', 'change-note', ECLIPSE_CAVEAT));
      if (columnVerdict(p.matched.z, 'matched') && DISAGREE([p.matched, p.plain, p.ps])) {
        sec.appendChild(el('p', 'change-note', DISAGREE_NOTE));
      }
    }
    const vl = variableLine(star, v.kind);
    if (vl) sec.appendChild(el('p', 'change-note', vl));
    const fl = v.kind === 'differs' ? fieldLine(p) : null;
    if (fl) sec.appendChild(el('p', 'change-note', fl));
    // numbers and plot; folded away in the calm bright-neighbour state
    const body = v.kind === 'calm' ? el('details', 'change-fold') : sec;
    if (v.kind === 'calm') body.appendChild(el('summary', 'change-fold-sum', SHOW_NUMBERS_TEXT));
    const note = fewerNote(p);
    if (note) body.appendChild(el('p', 'change-note', note));
    const cells = el('div', 'change-cells');
    cells.appendChild(
      p.plain
        ? cell('Plain pair', p.plain, plainDetail(p), false, 'single')
        : cell('Plain pair', null, '', false, 'single', 'No matching pair'),
    );
    cells.appendChild(cell('Paired average', p.ps, pairedDetail(p), false, 'single'));
    cells.appendChild(cell('Colour-matched', p.matched, matchedDetail(p), true, 'matched'));
    body.appendChild(cells);
    body.appendChild(plot(p, max));
    if (body !== sec) sec.appendChild(body);
    wrap.appendChild(sec);
  }
  if (allSaturated(star)) wrap.appendChild(el('p', 'change-note', SATURATED_STAR_TEXT));
  const fixed = el('div', 'change-fixed');
  for (const t of FIXED_LINES) fixed.appendChild(el('p', 'change-note', t));
  if (opts.example) {
    const pt = el('p', 'change-note', EXAMPLE_LEAD);
    const link = el('a', undefined, EXAMPLE_LINK_TEXT);
    link.href = exampleHref(opts.example.name);
    pt.appendChild(link);
    pt.appendChild(document.createTextNode('.'));
    fixed.appendChild(pt);
  }
  wrap.appendChild(fixed);
  return wrap;
}

export function measurableAid(r: PreparedReadouts, pick: (e: MeasurableEntry) => void): HTMLElement {
  const list = measurableStars(r);
  if (list.length === 0) return el('p', 'change-note', NONE_MEASURABLE_TEXT);
  const det = el('details', 'change-fold');
  det.appendChild(el('summary', 'change-fold-sum', measurableSummary(list.length)));
  const ul = el('ul', 'change-measurable');
  for (const e of list) {
    const li = el('li');
    const b = el('button', 'v-btn change-btn', measurableLabel(e));
    b.type = 'button';
    b.addEventListener('click', () => pick(e));
    li.appendChild(b);
    ul.appendChild(li);
  }
  det.appendChild(ul);
  return det;
}

export interface ChangeBlockHandle {
  dispose(): void;
}

// Fills `host` with the heading and the check for the star at (ra, dec). Returns a handle that
// aborts anything still in flight; call it before rendering the block for another star.
export function renderChangeBlock(host: HTMLElement, ctx: ChangeContext, ra: number, dec: number): ChangeBlockHandle {
  const life = new AbortController();
  let run: AbortController | null = null;
  const alive = (): boolean => !life.signal.aborted;

  host.replaceChildren(el('h4', 'v-subhead', CHANGE_HEADING));
  const body = el('div', 'change-body');
  host.appendChild(body);
  const set = (...nodes: Node[]): void => {
    if (alive()) body.replaceChildren(...nodes);
  };
  const hint = (t: string): HTMLElement => el('p', 'v-hint', t);

  const showSaturatedTarget = (): void => set(el('p', undefined, SATURATED_TARGET_TEXT), hint(SATURATED_TARGET_HINT));
  if (!preparedAvailable && isSaturatedTargetClick(ctx, ra, dec)) {
    showSaturatedTarget();
    return {
      dispose(): void {
        life.abort();
      },
    };
  }

  const mjds = ctx.exposures.map((e) => e.mjd);
  const epochYear = mjds.length ? 2000 + ((mjds.reduce((a, b) => a + b, 0) / mjds.length) - 51544.5) / 365.25 : 2016;
  const star = nearestGaia(ctx.gaia, ra, dec, ctx.pixelArcsec, epochYear);
  // loaded lazily so this module stays importable without the data layer's browser globals
  let example: { name: string } | null = null;
  if (ctx.slug !== EXAMPLE_SLUG) {
    import('../data').then(
      (m) => {
        example = m.listCached().find((e) => (e.slug as string) === EXAMPLE_SLUG) ?? null;
      },
      () => {},
    );
  }
  const resultOpts = (sRa: number, sDec: number, detector?: number): ResultsOptions => ({
    brightNeighbour: hasBrightNeighbour(sRa, sDec, ctx.gaia.map((x) => ({ ra: x.ra, dec: x.dec, gmag: x.gmag }))),
    detector,
    example,
  });
  const showLive = (message?: string): void => {
    if (ctx.gaia.length > 0 && !star) {
      set(hint(NO_STAR_TEXT));
      return;
    }
    const est = liveEstimate(ctx.exposures);
    const btn = el('button', 'v-btn change-btn', `Check whether this star changed (${estimateText(est)})`);
    btn.type = 'button';
    btn.addEventListener('click', () => start(est.bytes));
    const caution = ctx.gaia.length === 0 ? [hint('No star catalogue is loaded for this field, so the check measures exactly the spot you clicked. Click on the centre of a star.')] : [];
    set(...caution, ...(message ? [hint(message)] : []), btn);
  };

  const start = (estBytes: number): void => {
    run?.abort();
    const ctrl = new AbortController();
    run = ctrl;
    const line = el('p', 'change-progress', 'Starting');
    line.setAttribute('role', 'status');
    const cancel = el('button', 'v-btn change-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => ctrl.abort());
    set(line, cancel);
    const g = star;
    checkStarLive(
      {
        // a matched Gaia star is measured at its own catalogue position (epoch 2016) with its motion
        ra: g ? g.ra : ra,
        dec: g ? g.dec : dec,
        pmra: g?.pmra ?? undefined,
        pmdec: g?.pmdec ?? undefined,
        epoch: 2016,
        gmag: g?.gmag,
        exposures: ctx.exposures,
        gaia: ctx.gaia,
      },
      {
        signal: ctrl.signal,
        onProgress: (p) => {
          if (run === ctrl && alive()) line.textContent = progressLine(p.bytes, estBytes, p.done, p.total);
        },
      },
    ).then(
      (res) => {
        if (run !== ctrl || !alive() || ctrl.signal.aborted) return;
        const who = g ? `Measured: Gaia DR3 ${g.sourceId}, G magnitude ${g.gmag.toFixed(1)}.` : 'Measured at the spot you clicked.';
        const show = (): void => set(hint(who), renderResults(res, resultOpts(g ? g.ra : ra, g ? g.dec : dec)));
        if (ctx.slug && preparedAvailable) {
          loadPreparedReadouts(ctx.slug, { signal: life.signal }).then(
            (r) => {
              if (r) for (const p of res.pairs as ShownPair[]) p.field = fieldFor(r, p.tA, p.tB) ?? undefined;
              if (run === ctrl && alive()) show();
            },
            () => {
              if (run === ctrl && alive()) show();
            },
          );
        } else show();
      },
      () => {
        if (run !== ctrl || !alive()) return;
        showLive(ctrl.signal.aborted ? undefined : 'The check could not finish. Please try again.');
      },
    );
    ctrl.signal.addEventListener('abort', () => {
      if (run === ctrl && alive()) showLive();
    });
  };

  const mode = blockMode(ctx.slug, preparedAvailable, liveAvailable);
  if (mode === 'connecting') {
    set(el('p', undefined, CONNECTING_TEXT));
  } else if (mode === 'live') {
    showLive();
  } else {
    set(hint('Looking up saved results.'));
    loadPreparedReadouts(ctx.slug as string, { signal: life.signal }).then(
      (r) => {
        if (!alive()) return;
        const star = r ? matchPreparedStar(r, ra, dec, 2 * ctx.pixelArcsec, ctx.target) : null;
        const showPrepared = (st: ChangeStar, sRa: number, sDec: number): void => {
          if (!r) return;
          const head = st.pairs.length === 0 ? el('p', undefined, TOO_BRIGHT_TEXT) : renderResults(st, resultOpts(sRa, sDec, r.detector));
          const note = FIELD_NOTES[r.slug];
          const top = note ? [el('p', 'change-note', note), ...(measurableStars(r).length === 0 ? [el('p', 'change-note', NONE_MEASURABLE_TEXT)] : [])] : [];
          const aid = note && measurableStars(r).length === 0 ? [] : [measurableAid(r, (e) => showPrepared(e.star, e.ra, e.dec))];
          set(hint(detectorLine(r.detector)), ...top, head, ...aid);
        };
        if (star && r) {
          const hit = r.stars.find((x) => x.star === star);
          showPrepared(star, hit ? hit.ra : ra, hit ? hit.dec : dec);
        }
        else if (isSaturatedTargetClick(ctx, ra, dec)) showSaturatedTarget();
        else if (liveAvailable) showLive();
        else set(hint('No saved result for this star.'));
      },
      () => {
        if (!alive()) return;
        if (isSaturatedTargetClick(ctx, ra, dec)) showSaturatedTarget();
        else if (liveAvailable) showLive();
        else set(el('p', undefined, CONNECTING_TEXT));
      },
    );
  }

  return {
    dispose(): void {
      life.abort();
      run?.abort();
      run = null;
    },
  };
}
