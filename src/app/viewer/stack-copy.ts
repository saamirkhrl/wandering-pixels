// Exact strings for the Difference source control and the whole-visit stack warning.
export const STACK_WARN =
  'Broad-band stacks, not like for like: do not read brightness changes from this. Position shifts are still real.';
export const PAIRED_NOTE = 'The like-for-like image is about 18 percent tighter than the whole-visit stack on steady sky.';
export const PAIRED_READING = 'Like-for-like image: exposures at matching wavelengths are paired before subtracting.';
export const DIFF_HINT = 'The image shows where to look. To test whether one star changed, click it.';
export const QUALITY_LINE = 'Frames line up to about one twentieth of a pixel.';

// Difference sources, best first.
export type DiffSource = 'paired' | 'matched' | 'stack';
export const DIFF_SOURCES: { key: DiffSource; label: string }[] = [
  { key: 'paired', label: 'Paired stack' },
  { key: 'matched', label: 'Matched pair' },
  { key: 'stack', label: 'Whole-visit stack' },
];
