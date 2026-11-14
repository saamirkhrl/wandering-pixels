import type { Detector, Frame } from '../../lib/spherex/types';

export * from '../../lib/spherex/types';
export type { WiseSource } from '../../lib/spherex/wise';

export interface FirstLook {
  frames: Frame[];
  matched: boolean;
  detector: Detector;
}

export interface SaturatedSource {
  x: number;
  y: number;
  npix: number;
}
