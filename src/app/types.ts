export type ViewName = 'globe' | 'sky' | 'viewer';

export type ViewParams = Record<string, string>;

export interface ViewContext {
  params: ViewParams;
  go: (view: ViewName, params?: ViewParams) => void;
}

export type Unmount = () => void;

export type Mount = (root: HTMLElement, ctx: ViewContext) => Unmount;
