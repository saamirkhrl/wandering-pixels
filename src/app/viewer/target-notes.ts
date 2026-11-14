// One signed sentence per prepared target, shown under the name in the logbook header.
const SATURATED = 'Saturated in SPHEREx images, so brightness changes cannot be measured here.';

export const TARGET_NOTES: Record<string, string> = {
  'barnards-star':
    'Too bright for SPHEREx: its core is saturated in every image, but its outer glow still shifts by 1.7 pixels a year, as catalogued.',
  'eps-indi-b':
    'This brown dwarf pair moves between visits exactly as its catalogue motion predicts, to within a tenth of an arcsecond.',
  'wise-0855':
    'Not detected: it is fainter than a single SPHEREx image can reach at these wavelengths. The faint dot near the marker is an unrelated background star.',
  'rw-aur': SATURATED,
  'r-dra':
    'R Draconis itself is saturated, but nearby stars appear to brighten and fade together between visits, most strongly close to it, as its glow changes.',
  'v391-oph':
    "An eclipsing binary star near Barnard's Star: the readout catches it dimmed by eclipse in some SPHEREx exposures, while a steady neighbour of the same brightness shows no change.",
};

// A caveat shown after the note, for targets that need one.
export const TARGET_CAVEATS: Record<string, string> = {
  'v391-oph': 'The size of the change depends on which exposures happened to fall in eclipse.',
};

export function targetNote(slug: string | null | undefined): string | null {
  const note = slug ? TARGET_NOTES[slug] : undefined;
  if (!note || !slug) return null;
  const caveat = TARGET_CAVEATS[slug];
  return caveat ? `${note} ${caveat}` : note;
}

// The five Space Apps challenge targets. Any other prepared target is listed as an example.
export const CHALLENGE_SLUGS = new Set(['barnards-star', 'eps-indi-b', 'wise-0855', 'rw-aur', 'r-dra']);
export const CHALLENGE_HEADING = 'Challenge targets';
export const EXAMPLE_HEADING = 'Example: a star that varies';

export function groupTargets<T extends { slug: string }>(list: T[]): { heading: string; items: T[] }[] {
  const challenge = list.filter((t) => CHALLENGE_SLUGS.has(t.slug));
  const example = list.filter((t) => !CHALLENGE_SLUGS.has(t.slug));
  if (!example.length) return [{ heading: CHALLENGE_HEADING, items: challenge }];
  return [
    { heading: CHALLENGE_HEADING, items: challenge },
    { heading: EXAMPLE_HEADING, items: example },
  ];
}
