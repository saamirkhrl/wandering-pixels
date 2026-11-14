# Method and validation

Status: phase A (registration precision and wavelength sampling). Later sections are placeholders.
Every number below is in `docs/results.json`, with its sample size and the script that produced
it. Commands to reproduce: `validation/README.md`.

## Data

- SPHEREx Level 2 spectral images (releases DR1 and QR3), found with IRSA SIA2 and read from
  the public S3 bucket `nasa-irsa-spherex`. Two test fields: Eps Indi (centre on Eps Indi A,
  Gaia DR3 position at 2026.0, RA 330.89253, Dec -56.80430) and Barnard's Star (RA 269.44627,
  Dec 4.76820). No exposure appeared in both releases.
- Eps Indi: 458 exposures with the centre on the detector, in 4 visits (2025-04/06, 2025-09/11,
  2026-04/05, 2026-09/10). Barnard's Star: 358 exposures in 3 main visits (2025-08/09,
  2026-03/04, 2026-08/09, about 110 exposures each) plus 3 fragments of 10, 8 and 2 exposures.
- Coverage per detector is uneven: the Eps Indi QR3 visit has no detector 1 or 4 exposures, and
  its first visit has only 4 of each.

## Registration precision

In plain words: when the same star is measured in two different SPHEREx exposures, using only
the positions the archive's own sky coordinates (WCS) give, the two positions agree to about
0.3 arcsec, which is about one twentieth of a pixel. This holds equally for exposures taken
minutes, six months, twelve months or eighteen months apart, so the archive's alignment is far
better than needed to see a star that moves by a pixel or more. Part of the remaining scatter
comes from our simple star-position measurement, not from the archive.

Detail.
- Stars: Gaia DR3, G 12.0 to 16.5, RUWE < 1.4, no Gaia neighbour with G < G_star + 3 within
  20 arcsec, none brighter than G = 9 within 3 arcmin, no bad-pixel flags in the central 5x5
  pixels, peak S/N >= 10. Positions propagated to each exposure's mid-time with proper motion and
  annual parallax. Accepted: Eps Indi 171 stars, 29,048 measurements in 458 frames; Barnard's
  Star 257 stars, 47,406 measurements in 357 frames. Counts after each cut are in results.json.
- Centroids: least-squares fit of a pixel-integrated circular Gaussian on IMAGE minus ZODI
  minus a local background, weighted by VARIANCE (headline); and Gaussian-windowed moments
  (comparison). Pixel centroids are converted to sky with the frame's TAN-SIP WCS.
- Statistic: for each star, the residual r = measured minus Gaia at that epoch; for every pair of
  frames containing the star, d = r_i - r_j, so the star's own motion cancels. Robust scatter is
  1.4826 x MAD. These are per-pair numbers; one frame is sqrt(2) smaller.
- Result, per-pair robust scatter after removing each frame's median offset (computed from the
  other stars), RA* / Dec, arcsec:

  | Field | same visit | 6 months | 12 months | 18 months |
  |---|---|---|---|---|
  | Eps Indi | 0.304 / 0.383 | 0.301 / 0.381 | 0.306 / 0.385 | 0.311 / 0.391 |
  | Barnard's Star | 0.225 / 0.328 | 0.230 / 0.322 | 0.224 / 0.334 | none |

  In pixels (6.15 arcsec) this is 0.036 to 0.064 px. Pair counts range from 0.28 to 2.0 million
  per class (163 to 255 distinct stars); weighting each star equally changes the values by
  0.01 to 0.03 arcsec.
- Per-frame offset correction: helps little (raw values are 0.24 to 0.41 arcsec), except Barnard's
  Star 6-month pairs in RA* (0.283 to 0.230 arcsec). The per-frame median offset relative to Gaia
  is small (median 0.05 to 0.08 arcsec per axis).
- Noise floor: the formal centroid errors predict 0.10 to 0.16 arcsec per pair. The observed
  scatter is 2 to 3 times larger. Brightest stars (G 12 to 13) are systematics-limited; the
  faintest approach the floor.
- Where the excess comes from: the Gaussian centroid has a pixel-phase bias of about +/-0.04 px
  in y on the short-wavelength detectors. Correcting it empirically (fitted on half the stars,
  tested on the other half) lowers the pair scatter to 0.17 to 0.26 arcsec. Residuals binned on
  the detector also show a small spatial pattern (0.01 to 0.03 px), consistent with a residual
  distortion term. Windowed moments are unusable here: their pixel-phase bias reaches 0.23 px and
  their pair scatter is 1.5 to 1.65 arcsec.

Limits. Two fields only. Stars G 12 to 16.5 only (brighter stars, including the targets, are
saturated or non-linear and not tested). A fit with the archive's own PSF model (EPSF) was not
done; it should reduce the centroid part of the excess. The numbers describe relative alignment
of the archive WCS for isolated stars; they say nothing yet about difference-image residuals.

## Wavelength sampling

In plain words: in one visit, a given sky position is photographed through many different
wavelengths, roughly one per exposure. A later visit samples the same position at a different
set of wavelengths, and visits six or twelve months apart do not line up any better than visits
in the same week.

Detail.
- Wavelength per exposure at the field centre: from the per-detector spectral WCS calibration
  files (`spectral_wcs`, version cal-swcs-v5-2026-191, identical in DR1 and QR3). The WCS-WAVE
  table in each Level 2 file is byte-identical to the one in the calibration file; interpolating
  it differs from the per-pixel calibration image by a median 0.3 nm (max 7 nm, under 0.2 of a
  channel width).
- Same-detector pairs: the median wavelength difference is about 5 channel widths in every class
  (same visit, 6, 12, 18 months). Fraction of exposures in one visit that have a same-detector
  partner within one channel width in the visit 6 months later: Eps Indi 0.75 (N = 339), Barnard's
  Star 0.65 (N = 362); 12 months later: 0.63 (N = 264) and 0.52 (N = 236). Twelve-month pairs are
  NOT better matched than six-month pairs.
- Check pair (Barnard's Star, detector 2, 2025W35_2A_0221_2 and 2026W34_2A_0233_3, 357 days):
  1.3927 um and 1.3436 um, about 1.5 channel widths apart, with the target 174 detector rows
  apart.
- Density in one visit: the full Barnard's Star visits give 102 to 105 distinct wavelengths
  across 0.75 to 5.0 um, covering 99 percent of the range, largest gap 0.10 um. Eps Indi visits
  are partial: 66 to 100 distinct wavelengths, 59 to 99 percent coverage, and two visits (the first and the
  QR3 one) have a gap over about 2.4 to 3.7 um because they have 4 and 0 detector 4 exposures.

## Background: IMAGE minus ZODI

IMAGE minus ZODI is flat across a 320 x 320 pixel cutout (plane gradients at most 0.006 MJy/sr per
100 px) but not zero: a positive offset of 0.02 to 0.12 MJy/sr remains (10 to 80 percent of the
ZODI level). A constant offset cancels in a difference or is removed by a local background, so
it does not affect registration. One Eps Indi detector 1 frame shows pixel noise 5 times its
VARIANCE prediction, probably from Eps Indi A's halo; not investigated.

## Spectrally matched differencing

Results: to be written (phase B).

### Choices fixed before any phase B result was computed (2026-11-14, 10:00 CST)

These are written down first so that the comparison wavelength and the star sample cannot be
chosen after seeing which makes the matched method look best.

1. Field and visits. Barnard's Star first, its three full visits (index visits 0, 2, 4):
   pairs 0-2 and 2-4 are 6-month pairs, 0-4 is the 12-month pair. Eps Indi second if time
   allows, all visit pairs by the same time classes.
2. Common grid. Gnomonic (TAN) projection centred on the field centre (Gaia position at
   2026.0), north up, 6.15 arcsec pixels, 200 x 200 pixels. Variant: 3.075 arcsec pixels,
   400 x 400.
3. Star sample. The phase A registration selection (Gaia DR3 G 12.0 to 16.5, RUWE < 1.4, no
   neighbour with G < G_star + 3 within 20 arcsec, nothing brighter than G = 9 within 3 arcmin),
   plus Gaia DR3 phot_variable_flag not equal to VARIABLE, plus at least 8 grid pixels from the
   grid edge. Positions propagated to each exposure's epoch. A star-exposure measurement is
   dropped if the central 5 x 5 native pixels carry any phase A rejection flag; the same rule
   for every product.
4. Aperture. Radius 2.0 pixels of 6.15 arcsec (12.3 arcsec), exact pixel overlap; local
   background is the median in an annulus of 4 to 7 pixels.
5. Products.
   P1: one exposure of the earlier visit minus the same-detector exposure of the later visit
   nearest in wavelength at the field centre (what the website shows), resampled to the grid.
   P2: per detector, inverse-variance mean of each visit's exposures on the grid, visit minus
   visit.
   M1: per grid pixel, a smooth spectral model per visit, both evaluated at a common wavelength.
   M2: forced aperture photometry on native pixels at the Gaia positions in every exposure,
   per-star spectral model per visit, both evaluated at a common wavelength.
6. Common wavelengths. For each visit pair (A earlier, B later), detector d and star or pixel:
   the wavelengths at that position of visit A's detector-d exposures. P1 uses the same
   visit-A exposures, so P1, M1 and M2 have the same number of comparisons.
7. Spectral model (identical for M1 and M2). For an evaluation wavelength w0 with local
   bandwidth b0, take that visit's samples with wavelength within w0 +/- 2.5 b0; require at least
   3 samples, with at least one on each side of w0 (otherwise no value: no extrapolation);
   variance-weighted straight-line fit in wavelength, one 4-sigma clipping pass, evaluate at w0
   with its propagated variance. Two modes: "six" (samples from all detectors) and "one"
   (only detector d).
8. Metrics. z = (F_A - F_B) / sqrt(var_A + var_B) per star and comparison; report the robust
   width of z (1.4826 x MAD), the robust scatter of the fractional difference
   (F_A - F_B) / mean(F_A, F_B), and the slope of the fractional difference against BP-RP with a
   bootstrap error (resampling stars). "Clean" means width below 1.5 and slope within 2 sigma of
   zero. Pixel level: RMS of the difference within 3 pixels of stars with G 12.0 to 13.5 as a
   fraction of the star's peak in the visit A image (dipole level); background RMS, more than
   3 pixels from any Gaia source with G < 18, divided by the propagated sigma.
9. Resampling kernels compared for P1: bilinear, Lanczos-3, and flux-conserving (reproject
   adaptive and exact).

## Injection and recovery

To be written (phase C).

## Known movers

To be written (phase D).
