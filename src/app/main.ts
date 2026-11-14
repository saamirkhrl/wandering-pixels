import '@fontsource-variable/bricolage-grotesque/wdth.css';
import '@fontsource/atkinson-hyperlegible-next/400.css';
import '@fontsource/atkinson-hyperlegible-next/700.css';
import '../ui/tokens.css';
import '../ui/base.css';

import { initMotionClass } from './motion';
import { createShell } from '../ui/shell';
import type { Mount, Unmount, ViewContext, ViewName, ViewParams } from './types';

type ViewModule = { mount: Mount };

const VIEWS: Record<ViewName, () => Promise<ViewModule>> = {
  globe: () => import('./views/globe'),
  sky: () => import('./views/sky'),
  viewer: () => import('./views/viewer'),
};

function isView(v: string | null): v is ViewName {
  return v === 'globe' || v === 'sky' || v === 'viewer';
}

initMotionClass();

const app = document.getElementById('app');
if (!app) throw new Error('Missing #app root');

let unmount: Unmount | null = null;
let current: ViewName | null = null;
let token = 0;

export function go(view: ViewName, params: ViewParams = {}): void {
  const mine = ++token;
  unmount?.();
  unmount = null;
  shell.viewRoot.replaceChildren();

  const search = new URLSearchParams({ view, ...params });
  history.replaceState(null, '', '?' + search.toString());

  current = view;
  shell.setQuery(params.q ?? '');
  const ctx: ViewContext = { params, go };
  performance.mark('wp-go-' + view);
  // Until the view's code has arrived (normally preloaded, so this is one microtask), the dark
  // root shows a quiet line instead of nothing.
  const pending = document.createElement('p');
  pending.className = 'view-pending';
  pending.textContent = view === 'sky' ? 'Opening the sky' : 'Loading';
  pending.setAttribute('role', 'status');
  pending.style.cssText = 'position:absolute;top:50%;left:0;right:0;margin:0;text-align:center;color:var(--paper-dim);font-size:0.875rem';
  const pendingTimer = window.setTimeout(() => {
    if (mine === token) shell.viewRoot.appendChild(pending);
  }, 50);
  VIEWS[view]()
    .then((m) => {
      window.clearTimeout(pendingTimer);
      pending.remove();
      if (mine !== token) return;
      performance.mark('wp-chunk-' + view);
      unmount = m.mount(shell.viewRoot, ctx);
    })
    .catch((err: unknown) => {
      window.clearTimeout(pendingTimer);
      if (mine === token) {
        pending.textContent = 'This part of the site did not load. Reload the page to try again.';
        shell.viewRoot.appendChild(pending);
      }
      console.error(err);
    });
}

export function currentView(): ViewName | null {
  return current;
}

const shell = createShell(app, go);

const initial = new URLSearchParams(location.search);
const view = initial.get('view');
const params: ViewParams = {};
initial.forEach((value, key) => {
  if (key !== 'view') params[key] = value;
});
go(isView(view) ? view : 'globe', params);

// Fetch the sky code while the visitor is still on the globe, so the fly-in never ends on an
// empty page.
const idle = (fn: () => void) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 3000 });
  else window.setTimeout(fn, 1500);
};
idle(() => void VIEWS.sky().catch(() => undefined));
