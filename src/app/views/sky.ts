import type { Mount } from '../types';

export const mount: Mount = (root, ctx) => {
  const panel = document.createElement('section');
  panel.className = 'panel';
  const h = document.createElement('h2');
  h.textContent = 'Sky view';
  const p = document.createElement('p');
  const q = ctx.params.q;
  p.textContent = q ? 'Placeholder for the sky survey view. Query: ' + q : 'Placeholder for the sky survey view.';
  panel.append(h, p);
  root.appendChild(panel);
  return () => {
    panel.remove();
  };
};
