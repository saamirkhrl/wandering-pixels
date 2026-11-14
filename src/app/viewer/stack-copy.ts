// Exact strings for the Difference source control and the whole-visit stack warning.
export const STACK_WARN =
  'Broad-band stacks, not like for like: do not read brightness changes from this. Position shifts are still real.';
export const STACK_NOISE = 'Whole-visit stacks make steady stars look changed at 4.8 times the expected noise.';
export const QUALITY_LINE = 'Frames line up to about one twentieth of a pixel.';

// Difference sources, best first. A future "paired" stack slots in as the first entry.
export type DiffSource = 'matched' | 'stack';
export const DIFF_SOURCES: { key: DiffSource; label: string }[] = [
  { key: 'matched', label: 'Matched pair' },
  { key: 'stack', label: 'Whole-visit stack' },
];
