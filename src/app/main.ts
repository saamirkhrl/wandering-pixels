import '@fontsource-variable/bricolage-grotesque/wdth.css';
import '@fontsource/atkinson-hyperlegible-next/400.css';
import '@fontsource/atkinson-hyperlegible-next/700.css';
import '../ui/tokens.css';
import '../ui/base.css';

import { initMotionClass } from './motion';
import { createShell } from '../ui/shell';
import type { Mount, Unmount, ViewContext, ViewName, ViewParams } from './types';
import { mount as mountGlobe } from './views/globe';
import { mount as mountSky } from './views/sky';
import { mount as mountViewer } from './views/viewer';

const VIEWS: Record<ViewName, Mount> = {
  globe: mountGlobe,
  sky: mountSky,
  viewer: mountViewer,
};

function isView(v: string | null): v is ViewName {
  return v === 'globe' || v === 'sky' || v === 'viewer';
}

initMotionClass();

const app = document.getElementById('app');
if (!app) throw new Error('Missing #app root');

let unmount: Unmount | null = null;
let current: ViewName | null = null;

export function go(view: ViewName, params: ViewParams = {}): void {
  unmount?.();
  unmount = null;
  shell.viewRoot.replaceChildren();

  const search = new URLSearchParams({ view, ...params });
  history.replaceState(null, '', '?' + search.toString());

  current = view;
  shell.setQuery(params.q ?? '');
  const ctx: ViewContext = { params, go };
  unmount = VIEWS[view](shell.viewRoot, ctx);
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
