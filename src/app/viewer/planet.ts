import { COPY, fill } from './distance-copy';
import { createDistanceControl } from './distance';
import type { DistanceControl } from './distance';

export interface PlanetModel {
  step: 0 | 1 | 2;
  ringsOn: boolean;
  gapDays: number | null;
  gapText: string | null;
  visits: number;
  hasYear: boolean;
  hasHalf: boolean;
  lowTolerance: boolean;
  // offer to load the rest of the two visits of the tracked pair
  restOffer: { n: number; mb: number } | null;
  simOn?: boolean;
  listing?: 'reading' | 'more' | 'complete';
  partial?: boolean;
  refDate?: string | null;
  jumpPx?: number | null;
}

export interface PlanetHandlers {
  onStep(step: 0 | 1 | 2): void;
  onRings(on: boolean): void;
  onDistance(distanceAu: number | null): void;
  onLoadRest(): void;
  onSim?(on: boolean): void;
}

export interface PlanetSection {
  el: HTMLElement;
  control: DistanceControl;
  set(m: PlanetModel): void;
  setOpen(open: boolean): void;
  dispose(): void;
}

function e<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function createPlanetSection(h: PlanetHandlers): PlanetSection {
  const root = e('details', 'v-sec v-planet');
  const summary = e('summary', 'v-planet-summary');
  summary.appendChild(e('h3', 'v-h', COPY.planetTitle));
  root.appendChild(summary);

  const seg = e('div', 'v-seg v-planet-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Distant bodies');
  const b1 = e('button', 'v-seg-btn', COPY.find);
  const b2 = e('button', 'v-seg-btn', COPY.measure);
  b1.type = 'button';
  b2.type = 'button';
  seg.append(b1, b2);
  const few = e('p', 'v-hint');
  few.hidden = true;

  // step 1
  const s1 = e('div', 'v-planet-step');
  s1.append(e('h4', 'v-subhead', COPY.step1Title), e('p', '', COPY.step1Body));
  const gap = e('p', 'v-detail');
  const ringsLab = e('label', 'v-check');
  const ringsInput = e('input');
  ringsInput.type = 'checkbox';
  const ringsBox = e('span', 'v-check-box');
  ringsBox.setAttribute('aria-hidden', 'true');
  ringsLab.append(ringsInput, ringsBox, e('span', 'v-check-text', COPY.ringsToggle));
  s1.appendChild(ringsLab);
  ringsInput.addEventListener('change', () => h.onRings(ringsInput.checked));

  // step 2
  const s2 = e('div', 'v-planet-step');
  const willJump = e('p', 'v-planet-key');
  const refLine = e('p', 'v-detail');
  s2.append(e('h4', 'v-subhead', COPY.step2Title), willJump, refLine);
  const control = createDistanceControl({ onChange: (d) => h.onDistance(d) }, { bare: true });
  control.el.classList.add('v-planet-control');
  s2.appendChild(control.el);
  const lowTol = e('p', 'v-detail', COPY.lowTol);
  lowTol.hidden = true;
  s2.appendChild(lowTol);
  s2.appendChild(e('p', 'v-hint', COPY.step2Lead));
  const restBtn = e('button', 'v-btn');
  restBtn.type = 'button';
  restBtn.hidden = true;
  restBtn.addEventListener('click', () => h.onLoadRest());
  s2.appendChild(restBtn);

  // limits, always under a step
  const limits = e('div', 'v-planet-limits');
  limits.appendChild(e('p', '', COPY.limit1));
  const disc = e('details', 'v-disclosure');
  disc.appendChild(e('summary', '', COPY.limitsTitle));
  const l2 = e('p', 'v-hint');
  disc.append(l2, e('p', 'v-hint', COPY.limit3), e('p', 'v-hint', COPY.limit4), e('p', 'v-hint', COPY.limit6), e('p', 'v-hint', COPY.limit7));
  limits.appendChild(disc);

  const science = e('div', 'v-planet-science');
  science.append(
    e('p', 'v-detail', COPY.brightness),
    e('p', 'v-hint', COPY.sources),
    e('p', 'v-detail', COPY.deeper),
  );


  // simulated body: first thing under the step buttons, for both steps
  const simBox = e('div', 'v-planet-sim');
  const simTagLine = e('p', 'v-sim-line', COPY.simTag);
  const simHow = e('p', 'v-hint', COPY.simHow);
  const simResult = e('p', 'v-hint', COPY.simResult);
  const simBtn = e('button', 'v-btn v-sim-btn');
  simBtn.type = 'button';
  simBox.append(simTagLine, simHow, simResult, simBtn);
  let simOn = false;
  simBtn.addEventListener('click', () => h.onSim?.(!simOn));

  root.append(seg, few, simBox, s1, s2, gap, limits, science);

  let step: 0 | 1 | 2 = 0;
  const choose = (s: 1 | 2) => h.onStep(step === s ? 0 : s);
  b1.addEventListener('click', () => choose(1));
  b2.addEventListener('click', () => choose(2));

  return {
    el: root,
    control,
    set(m): void {
      step = m.step;
      const enough = m.visits >= 2;
      b1.disabled = !enough || !m.hasYear;
      b2.disabled = !enough || !m.hasHalf;
      b1.setAttribute('aria-pressed', String(m.step === 1));
      b2.setAttribute('aria-pressed', String(m.step === 2));
      const listing = m.listing ?? 'complete';
      const missing = listing === 'reading' ? COPY.reading : listing === 'more' ? COPY.notLoaded : null;
      const notes = !enough
        ? [missing ?? fill(COPY.fewVisits, { n: m.visits })]
        : !m.hasYear || !m.hasHalf
          ? missing
            ? [missing]
            : [m.hasYear ? '' : COPY.noYear, m.hasHalf ? '' : COPY.noHalf].filter(Boolean)
          : [];
      if (m.partial && notes.length > 0) notes.push(COPY.partial);
      few.hidden = notes.length === 0;
      few.textContent = notes.join(' ');
      s1.hidden = m.step !== 1;
      s2.hidden = m.step !== 2;
      limits.hidden = m.step === 0;
      ringsInput.checked = m.ringsOn;
      const g = m.gapDays;
      gap.textContent = m.gapText ?? '';
      gap.hidden = m.gapText === null;
      l2.textContent = g === null ? '' : fill(COPY.limit2, { n: g });
      lowTol.hidden = !m.lowTolerance;
      simOn = m.simOn === true;
      simBox.hidden = m.step === 0 || h.onSim === undefined;
      simTagLine.hidden = !simOn;
      simHow.hidden = !simOn;
      simResult.hidden = !simOn;
      simBtn.textContent = simOn ? COPY.simOff : COPY.simTry;
      simBtn.setAttribute('aria-pressed', String(simOn));
      control.setSim(simOn);
      willJump.hidden = !m.jumpPx;
      willJump.textContent = m.jumpPx ? fill(COPY.willJump, { px: Math.round(m.jumpPx) }) : '';
      refLine.hidden = !m.refDate;
      refLine.textContent = m.refDate ? fill(simOn ? COPY.refSim : COPY.refReal, { date: m.refDate }) : '';
      restBtn.hidden = m.restOffer === null;
      if (m.restOffer) restBtn.textContent = fill(COPY.loadRest, { n: m.restOffer.n, mb: m.restOffer.mb });
    },
    setOpen(open): void {
      root.open = open;
    },
    dispose(): void {
      control.dispose();
      root.remove();
    },
  };
}
