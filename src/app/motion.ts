const QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return window.matchMedia(QUERY).matches;
}

export function initMotionClass(): void {
  const mq = window.matchMedia(QUERY);
  const apply = () => document.documentElement.classList.toggle('reduced-motion', mq.matches);
  apply();
  mq.addEventListener('change', apply);
}
