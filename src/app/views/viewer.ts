import type { Mount } from '../types';

export const mount: Mount = (root, ctx) => {
  const panel = document.createElement('section');
  panel.className = 'panel';
  const h = document.createElement('h2');
  h.textContent = 'Viewer';
  const p = document.createElement('p');
  const q = ctx.params.q;
  p.textContent = q ? 'Placeholder for the pixel viewer. Query: ' + q : 'Placeholder for the pixel viewer.';
  panel.append(h, p);
  root.appendChild(panel);
  return () => {
    panel.remove();
  };
};
