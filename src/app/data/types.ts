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
  wavelengthAtTarget: number | null; // um. null from a live search until the header is read
                                     // (loadFrame or annotateWavelengths fills it). Never null in cache.
  bandwidthAtTarget: number | null;  // um, FWHM of the channel at the target, same null rule
  url: string;                      // https URL of the Level 2 FITS on S3 (CORS *)
  release: 'dr1' | 'qr2' | 'qr3';
}

export interface Grid {
  ra0: number; dec0: number;        // deg, tangent point = centre of the grid
  w: number; h: number;             // pixels
  scaleArcsec: number;              // arcsec per pixel
  epochMjd: number;                 // time the centre was evaluated at
}

export interface Frame {
  exposure: Exposure;               // wavelengthAtTarget is filled here
  grid: Grid;
  pixels: Float32Array;             // MJy/sr, zodiacal model subtracted unless background:'none'
  variance: Float32Array;           // (MJy/sr)^2
  flags: Uint8Array;                // 0 = good, non-zero = masked (bit meaning in FLAG_BITS)
  w: number; h: number;             // copies of grid.w, grid.h
  coverage: number;                 // 0..1 fraction of grid pixels with data
  wavelengthMap?: Float32Array;     // um per grid pixel, NaN where no data
  bandwidthMap?: Float32Array;      // um per grid pixel
  bytes: number;                    // bytes transferred for this frame; 0 from cache
}

export type MovieMode = 'visit-stack' | 'single';

export interface MovieFrame {
  grid: Grid;
  pixels: Float32Array;             // inverse-variance mean of members, NaN where no data
  variance: Float32Array;
  w: number; h: number;
  visitIndex: number;
  detector: Detector;
  time: string; mjd: number;        // mean of members
  wavelength: number;               // um, mean of members
  wavelengthMin: number; wavelengthMax: number;
  nExposures: number;
  exposureIds: string[];
  targetXY: [number, number] | null; // predicted grid position of the target at this time
}

export interface Movie {
  mode: MovieMode;
  detector: Detector;
  grid: Grid;
  frames: MovieFrame[];             // sorted by time
  // one display stretch for the whole movie so blinking does not flicker:
  stretch: { lo: number; hi: number }; // MJy/sr, robust percentiles over all frames
}

export interface DifferenceImage {
  grid: Grid;
  pixels: Float32Array;             // b minus a, MJy/sr
  variance: Float32Array;
  snr: Float32Array;                // pixels / sqrt(variance)
  w: number; h: number;
  wavelengthA: number; wavelengthB: number; // um; if these differ by more than one channel
  wavelengthMatched: boolean;               // the UI must say the pair is not like-for-like
  stretch: { lo: number; hi: number };      // symmetric about zero
}

export interface SpectrumPoint {
  exposureId: string;
  wavelength: number;               // um
  bandwidth: number;                // um
  flux: number;                     // mJy, aperture sum minus local background
  fluxErr: number;                  // mJy
  time: string; mjd: number;
  visitIndex: number;
  detector: Detector;
  flagged: boolean;                 // saturated or masked pixel inside the aperture
}

export interface GaiaStar {
  sourceId: string;
  ra: number; dec: number;          // deg at Gaia epoch 2016.0
  pmra: number | null; pmdec: number | null; // mas/yr
  parallax: number | null;          // mas
  gmag: number;
}

export interface WiseSource {
  id: string;
  ra: number; dec: number;          // deg
  pmra: number | null; pmdec: number | null; // mas/yr
  w1mag: number | null; w2mag: number | null;
}

export interface CachedTarget {
  slug: CachedSlug;
  target: Target;
  grid: Grid;
  exposures: Exposure[];
  frames: Frame[];                  // every cached exposure, already on `grid`
  gaia: GaiaStar[];                 // field stars for the overlay
  wise: WiseSource[];               // CatWISE2020 sources, may be empty
  builtAt: string;                  // ISO time the cache was built
}

export type CachedSlug = 'barnards-star' | 'eps-indi-b' | 'wise-0855' | 'rw-aur' | 'r-dra';

export interface Progress {
  stage: 'resolve' | 'search' | 'headers' | 'pixels' | 'reproject' | 'stack';
  done: number; total: number;      // total may be 0 while unknown
  message: string;                  // short, user-presentable, plain ASCII
  retrying?: boolean;               // true while backing off after a 503
  bytes?: number;                   // cumulative bytes transferred so far in this call
}

export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
}

export interface FrameOptions extends CallOptions {
  background?: 'zodi' | 'none';     // default 'zodi': subtract the file's ZODI model plane
  wavelengthMap?: boolean;          // also fill Frame.wavelengthMap / bandwidthMap
  target?: Target;                  // wavelengthAtTarget uses positionAt(target, exposure.mjd)
}

export type SpherexErrorCode =
  | 'NOT_FOUND'        // name did not resolve
  | 'NO_COVERAGE'      // no exposure covers the position
  | 'UPSTREAM_BUSY'    // archive kept returning 503 after retries
  | 'UPSTREAM_ERROR'   // any other archive failure
  | 'BAD_INPUT'
  | 'ABORTED';

export class SpherexError extends Error {
  code: SpherexErrorCode;
  constructor(code: SpherexErrorCode, message: string) {
    super(message);
    this.name = 'SpherexError';
    this.code = code;
  }
}

export const FLAG_BITS = {
  NO_DATA: 1,
  SATURATED: 2,
  BAD_PIXEL: 4,
  TRANSIENT: 8,
  PERSIST: 16,
  ARTIFACT: 32,
} as const;

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
