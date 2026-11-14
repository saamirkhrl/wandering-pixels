import type {
  CachedSlug,
  CallOptions,
  Detector,
  DifferenceImage,
  Exposure,
  Frame,
  GaiaStar,
  Grid,
  Movie,
  Target,
} from '../../lib/spherex/types';
import type { PairedDifference } from '../../lib/spherex/types';
import type { WiseSource } from '../../lib/spherex/wise';

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

export type ComparisonFlag = 'saturated' | 'too_few_samples' | 'no_bracket' | 'blended' | 'partial_visit';

export interface PairComparison {
  visitA: number;
  visitB: number;
  plain: {
    deltaMjy: number;
    percent: number;
    sigma: number;
    z: number;
    wavelengthA: number;
    wavelengthB: number;
    gapChannels: number;
  };
  paired: {
    deltaMjy: number;
    percent: number;
    sigma: number;
    z: number;
    nPairs: number;
  };
  matched: {
    deltaMjy: number;
    percent: number;
    sigma: number;
    z: number;
    commonWavelength: number;
    pointsA: number;
    pointsB: number;
  };
  flags: ComparisonFlag[];
}

// ---- app-side shapes for the cached preview path (mock behind the adapter until the library lands)

/** A difference image that says how it was made. method 'paired-stack' fills the optional fields. */
export type DifferenceImageM = DifferenceImage & {
  nPairs?: number;
  nUnpairedA?: number;
  nUnpairedB?: number;
  pairs?: PairedDifference['pairs'];
};

export interface PairPick {
  frames: [Frame, Frame];
  matched: boolean;
  gapDays: number;
}

export interface DetectorSummary {
  detector: Detector;
  visits: number[];
  count: number;
  outOfStack: number;
}

export interface CachedPreview {
  target: Target;
  grid: Grid;
  defaultDetector: Detector;
  /** Prebuilt visit stacks for the default detector. */
  movie: Movie;
  pairs: { year: PairPick | null; halfYear: PairPick | null };
  /** Prebuilt paired-stack differences for the default detector. */
  differences: { visitA: number; visitB: number; image: DifferenceImageM }[];
  visits: { visitIndex: number; mjd: number; time: string; nExposures: number }[];
  gaia: GaiaStar[];
  wise: WiseSource[];
  /** Per detector summary plus the bytes loadCachedDetector would transfer (0 if empty). */
  detectors: (DetectorSummary & { bytes: number })[];
  /** Sum of the per detector bytes: the whole prepared set for this target. */
  totalBytes: number;
}

export interface CachedDetectorData {
  exposures: Exposure[];
  frames: Frame[];
}

export type { CachedSlug };

// ---- live results filling in: findExposures resolves early, then keeps reporting through onUpdate

export interface ExposureUpdateStatus {
  answered: number;
  total: number;
  pending: string[];
  complete: boolean;
}

export interface FindExposuresOptions extends CallOptions {
  /** Called as more archive collections answer; `exposures` is the whole merged list each time. */
  onUpdate?: (exposures: Exposure[], status: ExposureUpdateStatus) => void;
  /** How long the library keeps asking the collections that have not answered. Library default 60000. */
  maxWaitMs?: number;
}
