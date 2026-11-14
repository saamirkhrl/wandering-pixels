import type { ViewName, ViewParams } from '../app/types';
import { listCached } from '../app/data';
import './shell.css';
import { createAbout } from './about';

export interface Shell {
  viewRoot: HTMLElement;
  setQuery: (q: string) => void;
  closeMenu: () => void;
}

export function createShell(
  app: HTMLElement,
  go: (view: ViewName, params?: ViewParams) => void,
): Shell {
  const bar = document.createElement('header');
  bar.className = 'shell-bar';

  const wordmark = document.createElement('button');
  wordmark.type = 'button';
  wordmark.className = 'wordmark';
  wordmark.textContent = 'Wandering Pixels';
  wordmark.addEventListener('click', () => {
    closeMenu();
    go('globe');
  });

  const form = document.createElement('form');
  form.className = 'search';
  form.setAttribute('role', 'search');

  const input = document.createElement('input');
  input.type = 'search';
  input.name = 'q';
  input.placeholder = 'Name or coordinates';
  input.setAttribute('aria-label', 'Star name or coordinates');
  input.setAttribute('aria-describedby', 'search-help');
  input.autocomplete = 'off';

  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Open';

  const menuButton = document.createElement('button');
  menuButton.type = 'button';
  menuButton.className = 'targets-button';
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-controls', 'targets-menu');
  const longLabel = document.createElement('span');
  longLabel.className = 'long';
  longLabel.textContent = 'Challenge targets';
  const shortLabel = document.createElement('span');
  shortLabel.className = 'short';
  shortLabel.textContent = 'Targets';
  menuButton.append(longLabel, shortLabel);

  form.append(input, button, menuButton);

  const help = document.createElement('div');
  help.className = 'search-help';
  help.id = 'search-help';
  help.hidden = true;
  const helpTitle = document.createElement('h2');
  helpTitle.textContent = 'Examples';
  const helpList = document.createElement('ul');
  for (const text of ["Barnard's Star", '269.45 4.69', '17 57 48.5 +04 41 36']) {
    const li = document.createElement('li');
    li.textContent = text;
    helpList.append(li);
  }
  help.append(helpTitle, helpList);

  const menu = document.createElement('ul');
  menu.className = 'targets-menu';
  menu.id = 'targets-menu';
  menu.hidden = true;
  const items: HTMLButtonElement[] = [];
  for (const t of listCached()) {
    const li = document.createElement('li');
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'target-item';
    const name = document.createElement('span');
    name.className = 'target-name';
    name.textContent = t.name;
    const blurb = document.createElement('span');
    blurb.className = 'target-blurb';
    blurb.textContent = t.blurb;
    item.append(name, blurb);
    item.addEventListener('click', () => {
      closeMenu();
      go('viewer', { q: t.name });
    });
    li.append(item);
    menu.append(li);
    items.push(item);
  }

  function isOpen(): boolean {
    return !menu.hidden;
  }

  function openMenu(focusIndex?: number): void {
    help.hidden = true;
    menu.hidden = false;
    menuButton.setAttribute('aria-expanded', 'true');
    if (focusIndex !== undefined) items[focusIndex]?.focus();
  }

  function closeMenu(): void {
    menu.hidden = true;
    menuButton.setAttribute('aria-expanded', 'false');
  }

  menuButton.addEventListener('click', () => {
    if (isOpen()) closeMenu();
    else openMenu();
  });
  menuButton.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(items.length - 1);
    }
  });
  menu.addEventListener('keydown', (e) => {
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(at + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1].focus();
    }
  });
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isOpen()) {
        closeMenu();
        menuButton.focus();
      }
      help.hidden = true;
    }
  });
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (isOpen() && !menu.contains(t) && !menuButton.contains(t)) closeMenu();
  });

  input.addEventListener('focus', () => {
    if (!isOpen()) help.hidden = false;
  });
  input.addEventListener('blur', () => {
    help.hidden = true;
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) {
      closeMenu();
      help.hidden = true;
      go('viewer', { q });
    }
  });

  const about = createAbout();
  const aboutBtn = document.createElement('button');
  aboutBtn.type = 'button';
  aboutBtn.className = 'shell-about';
  aboutBtn.textContent = 'About';
  aboutBtn.addEventListener('click', () => {
    closeMenu();
    about.open();
  });
  const brand = document.createElement('div');
  brand.className = 'shell-brand';
  brand.append(wordmark, aboutBtn);

  bar.append(brand, form, help, menu);

  const viewRoot = document.createElement('main');
  viewRoot.className = 'view-root';

  app.append(bar, viewRoot);

  const fitViewRoot = () => {
    viewRoot.style.top = bar.offsetHeight + 'px';
  };
  fitViewRoot();
  new ResizeObserver(fitViewRoot).observe(bar);
  about.maybeOpenOnArrival();

  const syncView = () => {
    document.documentElement.dataset.view = new URLSearchParams(location.search).get('view') ?? 'globe';
  };
  syncView();
  new MutationObserver(syncView).observe(viewRoot, { childList: true });

  // Warm the viewer chunk once the page is quiet. Same module id as main.ts, so one chunk.
  const warmViewer = () => {
    if (document.documentElement.dataset.view === 'viewer') return;
    try {
      void import('../app/views/viewer').catch(() => undefined);
    } catch {
      /* ignore */
    }
  };
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  window.setTimeout(() => {
    if (w.requestIdleCallback) w.requestIdleCallback(warmViewer, { timeout: 3000 });
    else warmViewer();
  }, 1500);

  return {
    viewRoot,
    setQuery: (q) => {
      input.value = q;
    },
    closeMenu,
  };
}
