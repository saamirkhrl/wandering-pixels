// Exact strings for the Difference source control.
export const PAIRED_NOTE = 'Each pixel compares images taken at matching wavelengths. Lobes around bright stars remain.';
export const PAIRED_READING = 'Like-for-like stack: exposures at matching wavelengths are paired before subtracting.';
export const NO_PAIR_READING = 'These two visits have no exposures at matching wavelengths to compare.';
export const DIFF_HINT = 'The image shows where to look. To test whether one star changed, click it.';
export const QUALITY_LINE = 'Frames line up to about one twentieth of a pixel.';

// Difference sources, best first.
export type DiffSource = 'paired' | 'matched';
export const DIFF_SOURCES: { key: DiffSource; label: string }[] = [
  { key: 'paired', label: 'Like-for-like stack' },
  { key: 'matched', label: 'Single pair' },
];
