export type PlayMode = 'stopped' | 'play' | 'blink';

export interface Player {
  readonly mode: PlayMode;
  readonly index: number;
  readonly fps: number;
  readonly count: number;
  setCount(n: number): void;
  setAB(a: number, b: number): void;
  setIndex(i: number): void;
  step(delta: number): void;
  play(): void;
  blink(): void;
  stop(): void;
  toggleMotion(): void;
  setFps(fps: number): void;
  dispose(): void;
}

export function createPlayer(onChange: () => void, initialFps: number): Player {
  let mode: PlayMode = 'stopped';
  let lastMotion: 'play' | 'blink' = 'blink';
  let index = 0;
  let count = 0;
  let fps = initialFps;
  let a = 0;
  let b = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const tick = () => {
    timer = null;
    if (mode === 'play' && count > 0) index = (index + 1) % count;
    else if (mode === 'blink') index = index === a ? b : a;
    else return;
    onChange();
    schedule();
  };

  const schedule = () => {
    clear();
    if (mode !== 'stopped') timer = setTimeout(tick, 1000 / fps);
  };

  const clampIndex = () => {
    index = count > 0 ? Math.min(Math.max(index, 0), count - 1) : 0;
  };

  const player: Player = {
    get mode() {
      return mode;
    },
    get index() {
      return index;
    },
    get fps() {
      return fps;
    },
    get count() {
      return count;
    },
    setCount(n) {
      count = n;
      clampIndex();
      if (count < 2 && mode !== 'stopped') {
        mode = 'stopped';
        clear();
      }
    },
    setAB(na, nb) {
      a = na;
      b = nb;
    },
    setIndex(i) {
      index = i;
      clampIndex();
      onChange();
    },
    step(delta) {
      if (count === 0) return;
      mode = 'stopped';
      clear();
      index = (((index + delta) % count) + count) % count;
      onChange();
    },
    play() {
      if (count < 2) return;
      mode = 'play';
      lastMotion = 'play';
      schedule();
      onChange();
    },
    blink() {
      if (count < 2 || a === b) return;
      mode = 'blink';
      lastMotion = 'blink';
      index = a;
      schedule();
      onChange();
    },
    stop() {
      if (mode === 'stopped') return;
      mode = 'stopped';
      clear();
      onChange();
    },
    toggleMotion() {
      if (mode !== 'stopped') player.stop();
      else if (lastMotion === 'play') player.play();
      else player.blink();
    },
    setFps(v) {
      fps = v;
      if (mode !== 'stopped') schedule();
      onChange();
    },
    dispose() {
      mode = 'stopped';
      clear();
    },
  };
  return player;
}
