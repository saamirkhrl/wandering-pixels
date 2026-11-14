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
  VIEWS[view]()
    .then((m) => {
      if (mine !== token) return;
      unmount = m.mount(shell.viewRoot, ctx);
    })
    .catch((err: unknown) => {
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
