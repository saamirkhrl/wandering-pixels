import './about.css';

export const ABOUT_COPY = {
  heading: 'Wandering Pixels',
  paragraphs: [
    {
      lead: 'What this is.',
      text: "NASA's SPHEREx telescope maps the whole sky in infrared and comes back to most spots about every six months. This site plays those images of one small patch of sky, one visit after another.",
    },
    {
      lead: 'How to use it.',
      text: 'Pick a place on the globe and look up, type a star name or coordinates, or open a challenge target. Then play the visits, blink two, or subtract them.',
    },
    {
      lead: 'What it means.',
      text: 'Most of the sky stays put. Anything that shifts position between visits shows up when you blink or subtract. Searching for motion this way is how nearby stars and brown dwarfs were found, and how astronomers look for a possible distant planet.',
    },
  ],
  button: 'Close',
  credits:
    'Sky map and images: NASA SPHEREx, served by IRSA at Caltech/IPAC. Earth: NASA Blue Marble. Stars: Yale Bright Star Catalogue via NASA HEASARC.',
};

const STORAGE_KEY = 'wp-about-dismissed';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function shouldAutoOpen(search: string, storage: Pick<Storage, 'getItem'> | null): boolean {
  if (new URLSearchParams(search).get('view') === 'viewer') return false;
  if (!storage) return true;
  try {
    return storage.getItem(STORAGE_KEY) !== '1';
  } catch {
    return true;
  }
}

function getStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function reducedMotion(): boolean {
  if (document.documentElement.classList.contains('reduced-motion')) return true;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function createAbout(): {
  open(): void;
  close(): void;
  isOpen(): boolean;
  maybeOpenOnArrival(): void;
} {
  let scrim: HTMLElement | null = null;
  let remembered: Element | null = null;
  let pending = false;

  const onKey = (e: KeyboardEvent): void => {
    if (!scrim) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = Array.from(scrim.querySelectorAll<HTMLElement>(FOCUSABLE));
    const dialog = scrim.querySelector<HTMLElement>('.about-panel');
    if (items.length === 0) {
      e.preventDefault();
      dialog?.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else if (active && !scrim.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  function open(): void {
    if (scrim) return;
    remembered = document.activeElement;
    const s = document.createElement('div');
    s.className = 'about-scrim';
    if (reducedMotion()) s.classList.add('about-still');
    s.addEventListener('mousedown', (e) => {
      if (e.target === s) close();
    });

    const panel = document.createElement('div');
    panel.className = 'about-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'about-heading');
    panel.tabIndex = -1;

    const h = document.createElement('h2');
    h.id = 'about-heading';
    h.className = 'about-heading';
    h.textContent = ABOUT_COPY.heading;
    panel.appendChild(h);

    for (const p of ABOUT_COPY.paragraphs) {
      const para = document.createElement('p');
      para.className = 'about-para';
      const strong = document.createElement('strong');
      strong.textContent = p.lead;
      para.appendChild(strong);
      para.appendChild(document.createTextNode(' ' + p.text));
      panel.appendChild(para);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'about-close';
    btn.textContent = ABOUT_COPY.button;
    btn.addEventListener('click', () => close());
    panel.appendChild(btn);

    const credits = document.createElement('p');
    credits.className = 'about-credits';
    credits.textContent = ABOUT_COPY.credits;
    panel.appendChild(credits);

    s.appendChild(panel);
    document.body.appendChild(s);
    scrim = s;
    document.addEventListener('keydown', onKey, true);
    btn.focus();
  }

  function close(): void {
    const st = getStorage();
    try {
      st?.setItem(STORAGE_KEY, '1');
    } catch {
      /* storage unavailable */
    }
    if (!scrim) return;
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    scrim = null;
    const prev = remembered;
    remembered = null;
    if (prev instanceof HTMLElement && document.contains(prev)) prev.focus();
  }

  function maybeOpenOnArrival(): void {
    if (pending || scrim) return;
    if (!shouldAutoOpen(window.location.search, getStorage())) return;
    pending = true;
    requestAnimationFrame(() => {
      const go = (): void => {
        pending = false;
        open();
      };
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(go, { timeout: 1500 });
      else window.setTimeout(go, 300);
    });
  }

  return { open, close, isOpen: () => scrim !== null, maybeOpenOnArrival };
}
