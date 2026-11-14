import type { ViewName, ViewParams } from '../app/types';

export interface Shell {
  viewRoot: HTMLElement;
  setQuery: (q: string) => void;
}

export function createShell(
  app: HTMLElement,
  go: (view: ViewName, params?: ViewParams) => void,
): Shell {
  const bar = document.createElement('header');
  bar.className = 'shell-bar';

  const wordmark = document.createElement('span');
  wordmark.className = 'wordmark';
  wordmark.textContent = 'Wandering Pixels';

  const form = document.createElement('form');
  form.className = 'search';
  form.setAttribute('role', 'search');

  const input = document.createElement('input');
  input.type = 'search';
  input.name = 'q';
  input.placeholder = 'Star name or coordinates';
  input.setAttribute('aria-label', 'Star name or coordinates');
  input.autocomplete = 'off';

  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Open';

  form.append(input, button);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) go('viewer', { q });
  });

  bar.append(wordmark, form);

  const viewRoot = document.createElement('main');
  viewRoot.className = 'view-root';

  app.append(bar, viewRoot);

  return {
    viewRoot,
    setQuery: (q) => {
      input.value = q;
    },
  };
}
