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
  'r-dra': SATURATED,
};

export function targetNote(slug: string | null | undefined): string | null {
  return slug ? (TARGET_NOTES[slug] ?? null) : null;
}
