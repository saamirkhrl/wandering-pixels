export interface BrightStar {
  ra: number; // degrees, J2000
  dec: number; // degrees, J2000
  mag: number; // V magnitude
  name: string | null;
}

let cache: Promise<BrightStar[]> | null = null;

export function loadBrightStars(): Promise<BrightStar[]> {
  if (!cache) {
    cache = fetch(`${import.meta.env.BASE_URL}data/bright-stars.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`bright-stars.json ${r.status}`);
        return r.json() as Promise<{ stars: [number, number, number, string | null][] }>;
      })
      .then((j) => j.stars.map(([ra, dec, mag, name]) => ({ ra, dec, mag, name })))
      .catch((e) => {
        cache = null;
        throw e;
      });
  }
  return cache;
}
