// Public types for the SPHEREx library. Contract: roundtable/05-data-interface.md.
import type { WiseSource } from './wise';

export interface Target {
  ra: number;            // deg, at `epoch`
  dec: number;           // deg, at `epoch`
  pmra?: number;         // mas/yr, includes cos(dec)
  pmdec?: number;        // mas/yr
  epoch?: number;        // Julian year of ra/dec, default 2000.0 (Gaia DR3 rows use 2016.0)
  name?: string;         // display name as resolved
  source?: 'cache' | 'gaia' | 'simbad' | 'sesame' | 'coordinates';
}

export type Detector = 1 | 2 | 3 | 4 | 5 | 6;

export interface Exposure {
  id: string;                       // "<OBSID>D<detector>", unique, stable
  obsId: string;
  detector: Detector;
  time: string;                     // ISO UTC, mid-exposure
  mjd: number;
  visitIndex: number;               // 0-based; exposures closer than 30 days share a visit
  wavelengthAtTarget: number | null; // um; null until a header is read
  bandwidthAtTarget: number | null;  // um, same null rule
  url: string;                      // https URL of the Level 2 FITS on S3
  release: 'dr1' | 'qr2' | 'qr3';
  inStack?: boolean;                // absent or true = normal. false = small stray cluster: listed with
                                    // its visit but left out of visit stacks (the target moves between them)
}

export interface Grid {
  ra0: number; dec0: number;        // deg, tangent point = centre of the grid
  w: number; h: number;             // pixels
  scaleArcsec: number;              // arcsec per pixel
  epochMjd: number;                 // time the centre was evaluated at
}

export interface Frame {
  exposure: Exposure;
  grid: Grid;
  pixels: Float32Array;             // MJy/sr, zodi subtracted unless background:'none'
  variance: Float32Array;           // (MJy/sr)^2
  flags: Uint8Array;                // FLAG_BITS; pixel is NaN iff (flags & BAD_DATA_MASK) != 0
  w: number; h: number;
  coverage: number;                 // 0..1 fraction of grid pixels that are not NaN
  wavelengthMap?: Float32Array;     // um per grid pixel (FrameOptions.wavelengthMap), NaN where no data
  bandwidthMap?: Float32Array;      // um per grid pixel, same rule
  bytes: number;                    // bytes transferred for this frame (incl. its header reads); 0 from cache
  trackingDistanceAu?: number;      // set when resampled onto gridAt(grid, mjd, D): grid co-moves with a body at D au
  trackingMotion?: TrackingMotion;  // set when FrameOptions.motion was used
}

export type MovieMode = 'visit-stack' | 'single';

export interface MovieFrame {
  grid: Grid;
  pixels: Float32Array;
  variance: Float32Array;
  w: number; h: number;
  visitIndex: number;
  detector: Detector;
  time: string; mjd: number;
  wavelength: number;
  wavelengthMin: number; wavelengthMax: number;
  nExposures: number;
  exposureIds: string[];
  targetXY: [number, number] | null;
  backgroundFallback?: boolean;     // true if the masked background estimator had < 100 pixels and the
                                    // plain clipped median was used for at least one member
  backgroundLevel: number;          // MJy/sr subtracted per member before stacking (mean); 0 for background 'none'
}

export interface Movie {
  mode: MovieMode;
  detector: Detector;
  grid: Grid;
  frames: MovieFrame[];
  stretch: { lo: number; hi: number };
  trackingDistanceAu?: number;      // members were tracked at this heliocentric distance (au)
  trackingMotion?: TrackingMotion;  // members were tracked with this motion
}

export interface DifferenceImage {
  grid: Grid;
  pixels: Float32Array;             // b minus a, MJy/sr
  variance: Float32Array;
  snr: Float32Array;
  w: number; h: number;
  wavelengthA: number; wavelengthB: number;
  wavelengthMatched: boolean;
  stretch: { lo: number; hi: number };
}

export interface SpectrumPoint {
  exposureId: string;
  wavelength: number;
  bandwidth: number;
  flux: number;                     // mJy, aperture sum minus annulus median; NaN if no usable aperture pixel
  fluxErr: number;                  // mJy; NaN when flux is NaN
  time: string; mjd: number;
  visitIndex: number;
  detector: Detector;
  flagged: boolean;                 // NaN or BAD_DATA_MASK pixel inside the aperture
  advisory?: boolean;               // ADVISORY_MASK pixel inside the aperture (always set by spectrumAt)
}

export interface GaiaStar {
  sourceId: string;
  ra: number; dec: number;          // deg at Gaia epoch 2016.0
  pmra: number | null; pmdec: number | null;
  parallax: number | null;
  gmag: number;
}

export type CachedSlug = 'barnards-star' | 'eps-indi-b' | 'wise-0855' | 'rw-aur' | 'r-dra';

export interface CachedTarget {
  slug: CachedSlug;
  target: Target;
  grid: Grid;
  exposures: Exposure[];
  frames: Frame[];
  gaia: GaiaStar[];
  wise: WiseSource[];               // may be empty
  builtAt: string;
}

export interface Progress {
  stage: 'resolve' | 'search' | 'headers' | 'pixels' | 'reproject' | 'stack';
  done: number; total: number;
  message: string;
  retrying?: boolean;
  bytes?: number;                   // cumulative bytes transferred so far in this call
}

export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
}

export interface FrameOptions extends CallOptions {
  background?: 'zodi' | 'none';
  wavelengthMap?: boolean;          // also fill Frame.wavelengthMap / bandwidthMap (not cached)
  target?: Target;                  // if given, wavelengthAtTarget uses positionAt(target, exposure.mjd)
  distanceAu?: number;              // finite > 0: resample each exposure onto gridAt(grid, mjd, distanceAu, referenceMjd)
  referenceMjd?: number;            // see gridAt
  motion?: TrackingMotion;          // heliocentric linear motion; needs distanceAu and referenceMjd
}

// Linear motion of the heliocentric direction, arcsec per Julian year. dRa is a true angle
// (already multiplied by cos dec).
export interface TrackingMotion { dRaArcsecPerYr: number; dDecArcsecPerYr: number }

export type SpherexErrorCode =
  | 'NOT_FOUND'
  | 'NO_COVERAGE'
  | 'UPSTREAM_BUSY'
  | 'UPSTREAM_ERROR'
  | 'BAD_INPUT'
  | 'ABORTED';

export class SpherexError extends Error {
  code: SpherexErrorCode;
  constructor(code: SpherexErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SpherexError';
    this.code = code;
  }
}

// Bits of Frame.flags (Uint8). Each groups source FLAGS bits of the Level 2 file. Raw bit
// names come from the MSKNnnnn keywords of the FLAGS HDU header (e.g. MSKN0026 = 'BLOOM'),
// matching Table 16 of the SPHEREx Explanatory Supplement.
// Two masks split the bits:
// - BAD_DATA_MASK: the pixel value is bad. Such grid pixels are NaN in pixels/variance and are
//   excluded from stacks, photometry and background estimates.
// - ADVISORY_MASK: reported for overlays only. The pixel value and its variance weight are kept.
// Not mapped at all: OVERFLOW (1, about half full well; fires on unsaturated bright-star cores),
// FULLSAMPLE (12), OUTLIER (19), SOURCE (21), GHOST (22), GHOST_FPA (23), GHOST_EXT (24).
// A grid pixel gets the OR of the bits of the source pixels used to interpolate it.
export const FLAG_BITS = {
  NO_DATA: 1,      // bad: off the detector, or non-finite IMAGE/VARIANCE/ZODI
  SATURATED: 2,    // bad: NONLINEAR (15), BLOOM (26)
  BAD_PIXEL: 4,    // bad: SUR_ERROR (2), NONFUNC (6), DICHROIC (7), MISSING_DATA (9), HOT (10), COLD (11), PHANMISS (14)
  TRANSIENT: 8,    // bad: TRANSIENT (0), SNOWBALL (27)
  PERSIST: 16,     // advisory: PERSIST (17)
  CROSSTALK: 32,   // advisory: CROSSTALK (20)
  STREAK: 64,      // advisory: STREAK (25)
  HALO: 128,       // advisory: HALO (28), SATELLITE_HALO (29)
} as const;

export const BAD_DATA_MASK: number =
  FLAG_BITS.NO_DATA | FLAG_BITS.SATURATED | FLAG_BITS.BAD_PIXEL | FLAG_BITS.TRANSIENT;
export const ADVISORY_MASK: number =
  FLAG_BITS.PERSIST | FLAG_BITS.CROSSTALK | FLAG_BITS.STREAK | FLAG_BITS.HALO;
