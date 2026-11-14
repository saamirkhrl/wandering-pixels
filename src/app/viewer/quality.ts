import { saturatedSources } from '../data';
import type { Frame, Movie, MovieFrame } from '../data';
import { maskFor } from './overlays';
import '../../ui/viewer-parts.css';

export interface QualityPanel {
  el: HTMLElement;
  show(movie: Movie, current: MovieFrame, frames: Frame[], compare?: { a: MovieFrame; b: MovieFrame } | null): void;
  dispose(): void;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function finiteFraction(px: Float32Array): number {
  if (px.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < px.length; i++) if (Number.isFinite(px[i])) n++;
  return n / px.length;
}

function wl(v: number): string {
  return v.toFixed(2);
}

function range(lo: number, hi: number): string {
  return Math.abs(hi - lo) < 0.005 ? wl(lo) : `${wl(lo)} to ${wl(hi)}`;
}

export function createQualityPanel(): QualityPanel {
  const root = el('section', 'v-sec v-qual');
  root.appendChild(el('h3', 'v-h', 'Data quality'));
  const body = el('div', 'v-qual-body');
  root.appendChild(body);

  return {
    el: root,
    show(movie, current, frames, compare): void {
      body.replaceChildren();
      const pct = Math.round(finiteFraction(current.pixels) * 100);
      const masked = maskFor(current, frames);
      let nMasked = 0;
      for (let i = 0; i < masked.length; i++) if (masked[i]) nMasked++;
      const n = current.nExposures;

      body.appendChild(el('p', undefined, `Coverage ${pct} percent of the patch has data.`));
      body.appendChild(el('p', undefined, `${n} ${n === 1 ? 'exposure' : 'exposures'} in this frame.`));
      body.appendChild(el('p', undefined, `Masked pixels ${nMasked.toLocaleString('en-US')}.`));
      const bg = (f: MovieFrame): string => {
        const v = (f as MovieFrame & { backgroundLevel?: number }).backgroundLevel;
        return (typeof v === 'number' && Number.isFinite(v) ? v : 0).toFixed(2);
      };
      body.appendChild(
        el(
          'p',
          undefined,
          compare
            ? `Background removed: A ${bg(compare.a)} MJy/sr, B ${bg(compare.b)} MJy/sr.`
            : `Background removed: ${bg(current)} MJy/sr.`,
        ),
      );
      body.appendChild(el('p', undefined, 'Frames are aligned to about 0.05 pixel (measured on Gaia stars).'));
      const stray = new Set<string>();
      for (const f of frames) {
        const ex = f.exposure as typeof f.exposure & { inStack?: boolean };
        if (ex.detector === movie.detector && ex.inStack === false) stray.add(ex.id);
      }
      if (stray.size > 0) {
        body.appendChild(
          el('p', undefined, `${stray.size} stray ${stray.size === 1 ? 'exposure' : 'exposures'} not averaged.`),
        );
      }

      const ids = new Set(current.exposureIds);
      let nSat = 0;
      for (const f of frames) if (ids.has(f.exposure.id)) nSat += saturatedSources(f).length;
      if (nSat > 0) {
        body.appendChild(
          el('p', undefined, `Saturated: differences here are not reliable. ${nSat} saturated ${nSat === 1 ? 'source' : 'sources'} in this frame.`),
        );
      }

      // per visit table
      const byVisit = new Map<number, MovieFrame[]>();
      for (const f of movie.frames) {
        const list = byVisit.get(f.visitIndex);
        if (list) list.push(f);
        else byVisit.set(f.visitIndex, [f]);
      }
      const visits = Array.from(byVisit.keys()).sort((a, b) => a - b);
      const scroll = el('div', 'v-spec-scroll');
      const table = el('table', 'v-spec-table');
      const cap = el('caption', 'v-hint', 'By visit');
      table.appendChild(cap);
      const thead = el('thead');
      const hr = el('tr');
      for (const c of ['Visit', 'Exposures', 'Wavelength (um)', 'Mean coverage']) {
        const th = el('th', undefined, c);
        th.scope = 'col';
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el('tbody');
      for (const v of visits) {
        const fs = byVisit.get(v) ?? [];
        const count = fs.reduce((s, f) => s + f.nExposures, 0);
        const lo = Math.min(...fs.map((f) => f.wavelengthMin));
        const hi = Math.max(...fs.map((f) => f.wavelengthMax));
        const cov = fs.reduce((s, f) => s + finiteFraction(f.pixels), 0) / fs.length;
        const tr = el('tr');
        tr.appendChild(el('td', undefined, `${v + 1}, ${dateOf(fs[0].time)}`));
        tr.appendChild(el('td', undefined, String(count)));
        tr.appendChild(el('td', undefined, range(lo, hi)));
        tr.appendChild(el('td', undefined, `${Math.round(cov * 100)} percent`));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      scroll.appendChild(table);
      body.appendChild(scroll);

      // exposures in this frame
      if (current.exposureIds.length > 0) {
        const byId = new Map(frames.map((f) => [f.exposure.id, f.exposure]));
        const det = el('details', 'v-spec-details');
        det.appendChild(el('summary', 'v-qual-sum', 'Exposures in this frame'));
        const ul = el('ul', 'v-qual-list');
        for (const id of current.exposureIds) {
          const ex = byId.get(id);
          const li = el('li');
          if (ex) {
            const a = el('a', 'v-qual-link');
            a.href = ex.url;
            a.target = '_blank';
            a.rel = 'noopener';
            const w = ex.wavelengthAtTarget;
            a.textContent = `${id}, ${dateOf(ex.time)}${w !== null ? `, ${wl(w)} um` : ''}`;
            li.appendChild(a);
          } else {
            li.textContent = id;
          }
          ul.appendChild(li);
        }
        det.appendChild(ul);
        det.appendChild(el('p', 'v-hint', 'Links open the original Level 2 FITS file from the NASA archive.'));
        body.appendChild(det);
      }
    },
    dispose(): void {
      root.remove();
    },
  };
}
