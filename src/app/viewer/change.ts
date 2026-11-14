import type { ComparisonFlag, PairComparison } from '../data';
import '../../ui/change.css';

export const Z_POSSIBLE = 3;
export const Z_CHANGED = 5;

export type VerdictKind = 'none' | 'possible' | 'changed' | 'unreliable';

const NS = 'http://www.w3.org/2000/svg';

const FLAG_WORDS: Record<ComparisonFlag, string> = {
  saturated: 'the star is saturated',
  too_few_samples: 'too few points at some colours',
  no_bracket: 'some colours fall outside the range sampled in a visit',
  blended: 'a neighbour sits inside the aperture',
  partial_visit: 'a visit has only a few images here',
};

// sigma is in mJy like deltaMjy (z = deltaMjy / sigma); shown as a percent error alongside percent.
export function pctSigma(c: { deltaMjy: number; percent: number; sigma: number }): number {
  if (!Number.isFinite(c.deltaMjy) || c.deltaMjy === 0) return NaN;
  return Math.abs((c.sigma * c.percent) / c.deltaMjy);
}

export function fmtPercent(percent: number, sigma: number): string {
  const mag = Math.abs(percent).toFixed(1);
  const sign = percent < 0 && Number(mag) > 0 ? '-' : '+';
  return `${sign}${mag} +/- ${Math.abs(sigma).toFixed(1)} percent`;
}

export function verdict(row: PairComparison): { kind: VerdictKind; text: string } {
  if (row.flags.length > 0) {
    const why = row.flags.map((f) => FLAG_WORDS[f]).join('; ');
    return { kind: 'unreliable', text: `Not reliable here: ${why}.` };
  }
  const z = Math.abs(row.matched.z);
  if (!Number.isFinite(z) || z < Z_POSSIBLE) return { kind: 'none', text: 'No change above noise' };
  if (z < Z_CHANGED) return { kind: 'possible', text: 'Possible change' };
  return { kind: 'changed', text: `Changed by ${fmtPercent(row.matched.percent, pctSigma(row.matched))}` };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function bar(value: number, sigma: number, max: number): SVGSVGElement {
  const W = 140;
  const H = 14;
  const mid = W / 2;
  const sx = (v: number): number => mid + (v / max) * (mid - 4);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'change-bar');
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag: string, attrs: Record<string, number | string>): void => {
    const n = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs)) n.setAttribute(k, String(attrs[k]));
    svg.appendChild(n);
  };
  add('line', { x1: mid, x2: mid, y1: 1, y2: H - 1, class: 'change-zero' });
  const lo = sx(value - sigma);
  const hi = sx(value + sigma);
  add('line', { x1: lo, x2: hi, y1: H / 2, y2: H / 2, class: 'change-err' });
  add('line', { x1: lo, x2: lo, y1: 3, y2: H - 3, class: 'change-err' });
  add('line', { x1: hi, x2: hi, y1: 3, y2: H - 3, class: 'change-err' });
  add('circle', { cx: sx(value), cy: H / 2, r: 2.5, class: 'change-dot' });
  return svg;
}

function cell(
  name: string,
  percent: number,
  sigma: number,
  z: number,
  detail: string,
  max: number,
): HTMLElement {
  const c = el('div', 'change-cell');
  c.appendChild(el('div', 'change-cell-name', name));
  c.appendChild(el('div', 'change-val', fmtPercent(percent, sigma)));
  c.appendChild(el('div', 'change-z', `z = ${Number.isFinite(z) ? z.toFixed(1) : 'n/a'}`));
  if (Number.isFinite(percent) && Number.isFinite(sigma)) c.appendChild(bar(percent, sigma, max));
  c.appendChild(el('div', 'change-detail', detail));
  return c;
}

export function createChangeBlock(): {
  el: HTMLElement;
  show(rows: PairComparison[], visitLabel: (visitIndex: number) => string): void;
  clear(): void;
  dispose(): void;
} {
  const root = el('section', 'v-sec v-change');
  root.hidden = true;
  root.appendChild(el('h3', 'v-h', 'Has it changed between visits?'));
  root.appendChild(
    el(
      'p',
      'change-explain',
      "Each SPHEREx image sees a slightly different infrared colour, so we fit this star's colours within each visit and compare the visits at one shared colour.",
    ),
  );
  const list = el('div', 'change-rows');
  const note = el('p', 'change-note', 'Error bars widened by our measured factor.');
  const yard = el('div', 'v-change-yardstick');
  yard.appendChild(
    el(
      'p',
      'change-note',
      'On steady stars this comparison scatters by about 2.6 percent; a single pair of images scatters by about 5.7 percent.',
    ),
  );
  yard.appendChild(
    el(
      'p',
      'change-note',
      'A plain pair of images is trustworthy only when the two wavelengths nearly match. Each extra channel of gap makes a steady star look more changed.',
    ),
  );
  root.append(list, note, yard);

  const clear = (): void => {
    list.replaceChildren();
    root.hidden = true;
  };

  return {
    el: root,
    show(rows, visitLabel): void {
      list.replaceChildren();
      if (rows.length === 0) {
        root.hidden = true;
        return;
      }
      root.hidden = false;
      for (const r of rows) {
        const row = el('div', 'change-row');
        row.appendChild(el('h4', 'change-head', `Visit ${r.visitA + 1} to visit ${r.visitB + 1}`));
        row.appendChild(el('div', 'change-dates', `${visitLabel(r.visitA)} to ${visitLabel(r.visitB)}`));
        const reach = (v: number, s: number): number => (Number.isFinite(v) && Number.isFinite(s) ? Math.abs(v) + Math.abs(s) : 0);
        const max =
          Math.max(
            1e-6,
            reach(r.plain.percent, pctSigma(r.plain)),
            reach(r.paired.percent, pctSigma(r.paired)),
            reach(r.matched.percent, pctSigma(r.matched)),
          ) * 1.1;
        const cells = el('div', 'change-cells');
        cells.appendChild(
          cell(
            'Plain pair',
            r.plain.percent,
            pctSigma(r.plain),
            r.plain.z,
            `${r.plain.wavelengthA.toFixed(2)} and ${r.plain.wavelengthB.toFixed(2)} um, ${r.plain.gapChannels.toFixed(1)} channels apart`,
            max,
          ),
        );
        cells.appendChild(
          cell(
            'Paired average',
            r.paired.percent,
            pctSigma(r.paired),
            r.paired.z,
            `${r.paired.nPairs} ${r.paired.nPairs === 1 ? 'pair' : 'pairs'}`,
            max,
          ),
        );
        cells.appendChild(
          cell(
            'Colour-matched',
            r.matched.percent,
            pctSigma(r.matched),
            r.matched.z,
            `at ${r.matched.commonWavelength.toFixed(2)} um, ${r.matched.pointsA} and ${r.matched.pointsB} points`,
            max,
          ),
        );
        row.appendChild(cells);
        const v = verdict(r);
        row.appendChild(el('p', `change-verdict change-${v.kind}`, v.text));
        list.appendChild(row);
      }
    },
    clear,
    dispose(): void {
      root.remove();
    },
  };
}
