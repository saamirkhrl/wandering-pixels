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
  flags: Uint8Array;                // 0 = good, non-zero = masked (bits in FLAG_BITS)
  w: number; h: number;
  coverage: number;                 // 0..1 fraction of grid pixels with data
  wavelengthMap?: Float32Array;     // um per grid pixel (FrameOptions.wavelengthMap), NaN where no data
  bandwidthMap?: Float32Array;      // um per grid pixel, same rule
  bytes: number;                    // bytes transferred for this frame (incl. its header reads); 0 from cache
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
}

export interface Movie {
  mode: MovieMode;
  detector: Detector;
  grid: Grid;
  frames: MovieFrame[];
  stretch: { lo: number; hi: number };
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
  flux: number;                     // mJy
  fluxErr: number;                  // mJy
  time: string; mjd: number;
  visitIndex: number;
  detector: Detector;
  flagged: boolean;
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
}

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

// Bits of Frame.flags (Uint8). Each groups several source FLAGS bits of the Level 2 file.
// Any non-zero value means the output pixel is masked (and its value is NaN).
// Source bit numbers are those of the Level 2 FLAGS header (MSKNnnnn). Not mapped (pixel stays
// usable): OVERFLOW (1, about half full well; it fires on unsaturated bright-star cores),
// FULLSAMPLE (12), OUTLIER (19), SOURCE (21), GHOST (22), GHOST_FPA (23), GHOST_EXT (24).
// A grid pixel gets the OR of the bits of the source pixels used to interpolate it.
export const FLAG_BITS = {
  NO_DATA: 1,      // off the detector, or non-finite IMAGE/VARIANCE/ZODI
  SATURATED: 2,    // NONLINEAR, BLOOM
  BAD_PIXEL: 4,    // SUR_ERROR, NONFUNC, DICHROIC, MISSING_DATA, HOT, COLD, PHANMISS
  TRANSIENT: 8,    // TRANSIENT, SNOWBALL
  PERSIST: 16,     // PERSIST
  ARTIFACT: 32,    // CROSSTALK, STREAK, HALO, SATELLITE_HALO
} as const;
