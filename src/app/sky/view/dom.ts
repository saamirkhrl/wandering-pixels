export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(label: string, cls = 'sky-btn', onClick?: () => void): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

const SVG = 'http://www.w3.org/2000/svg';

export function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
  return e;
}

export function reticleSvg(): SVGSVGElement {
  const s = svg('svg', { viewBox: '-22 -22 44 44', width: '44', height: '44', 'aria-hidden': 'true' }) as SVGSVGElement;
  s.appendChild(svg('circle', { r: '20.5', fill: 'none', stroke: '#f2c230', 'stroke-width': '1' }));
  s.appendChild(
    svg('path', {
      d: 'M0 -7V-3M0 3V7M-7 0H-3M3 0H7',
      fill: 'none',
      stroke: '#f2c230',
      'stroke-width': '1',
    }),
  );
  return s;
}

export function markSvg(): SVGSVGElement {
  const s = svg('svg', { viewBox: '-9 -9 18 18', width: '18', height: '18', 'aria-hidden': 'true' }) as SVGSVGElement;
  s.appendChild(svg('path', { d: 'M-6 -6H6V6H-6Z', fill: 'none', stroke: '#f2c230', 'stroke-width': '1' }));
  s.appendChild(
    svg('path', {
      d: 'M-9 0H-6M6 0H9M0 -9V-6M0 6V9',
      fill: 'none',
      stroke: '#f2c230',
      'stroke-width': '1',
    }),
  );
  return s;
}
