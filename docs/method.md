# Method and validation

Status: phases A and B done (registration, wavelength sampling, plain versus spectrally matched
differences). Injection-recovery and known movers are placeholders.

## Three results in brief

1. A plain pair of SPHEREx exposures misreads a constant star as changed more often the further
   apart the two exposures' wavelengths are. Comparing each star's own spectrum, fitted per visit
   and evaluated at the same wavelength, removes that dependence completely. Most of its gain in
   raw scatter comes from using more exposures, but about a third is the wavelength matching.
   (Section "Spectrally matched differencing".)
2. The archive's sky coordinates register different exposures to each other to 0.04 to 0.06
   pixel (0.22 to 0.39 arcsec per pair), the same within a visit and across 6, 12 and 18 months.
   We found no published figure for this. (Section "Registration precision".)
3. For point-source photometry, the archive's error bars are too small: differences of a constant
   star scatter 1.2 to 1.4 times more than the stated errors predict. A missing error of about
   2 percent of the star's flux explains it. (Section "Error bars".)
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

In plain words: SPHEREx sees a star at a different wavelength in every exposure. Subtracting two
exposures taken at different wavelengths makes a constant star look changed, simply because stars
are brighter at some wavelengths than others. We measured how often this happens and tested a fix:
for each visit, fit a short straight line through the star's own brightness against wavelength,
read both visits off at the same wavelength, and compare. On 70 constant stars (Barnard's Star
field) and 49 (Eps Indi field), the plain comparison gets steadily worse as the wavelength gap
grows; the matched comparison does not change with the gap at all. Doing the same thing on
resampled images, pixel by pixel, did not work.

All numbers below are robust widths (1.4826 x MAD) with bootstrap errors over stars (300 to 1000
resamples). z = flux difference divided by its propagated error (1.0 if errors are right and the
star constant); "scatter" = robust scatter of the fractional flux difference. Pairs from the
6-month and 12-month classes are pooled unless stated; per-class values are in results.json.

### Result 1: plain pairs degrade with the wavelength gap, matched photometry does not

Every same-detector exposure pair of the same star between two visits (Barnard, 70 stars):

| gap (channels) | N pairs | plain z width | plain scatter | matched (M2) z width |
|---|---|---|---|---|
| 0 - 0.5 | 16,411 | 1.43 | 4.8 % | 1.42 |
| 0.5 - 1 | 11,984 | 1.59 | 5.9 % | 1.45 |
| 1 - 2 | 27,104 | 2.04 | 7.9 % | 1.42 |
| 2 - 4 | 48,891 | 2.93 | 12.4 % | 1.42 |
| 4 - 7 | 60,514 | 4.63 | 20.1 % | 1.42 |
| 7 - 10 | 44,521 | 6.57 | 28.6 % | 1.42 |
| > 10 | 40,323 | 8.66 | 38.5 % | 1.45 |

Slope of z width with gap: plain +0.64 +/- 0.09 per channel, matched +0.001 +/- 0.001 (Barnard);
plain +0.18 +/- 0.02, matched +0.000 +/- 0.001 (Eps Indi). Pairs inside one visit show the same
trend (gap > 10 channels: 9.3), so it is the wavelength, not the time between visits. At gaps
under half a channel the plain pair is as good as the matched one; the matched method's gain is
that it does not need such a pair. (Script 07b, figure phaseb_gap_full_*.png.)

### Result 2: products compared on the same stars (Barnard, mask prereg unless stated)

| product | z width | scatter |
|---|---|---|
| P1 website pair, resampled (bilinear, browser mask) | 1.85 +/- 0.07 | 5.5 +/- 0.2 % |
| P1 website pair, resampled (bilinear) | 1.76 +/- 0.06 | 5.8 +/- 0.3 % |
| P1native: same pairs, native pixels | 1.56 +/- 0.06 | 5.7 +/- 0.3 % |
| P2 visit stack minus visit stack | 4.76 +/- 0.34 | 4.4 +/- 0.2 % |
| M1 per-pixel matched on the grid (six detectors) | 2.77 +/- 0.16 | 6.5 +/- 0.3 % |
| M1 per-pixel matched, 3.075" grid | 2.22 +/- 0.10 | 4.6 +/- 0.2 % |
| M2 per-star matched (six detectors) | 1.44 +/- 0.05 | 2.6 +/- 0.1 % |
| M2 per-star matched (one detector) | 1.42 +/- 0.05 | 2.6 +/- 0.2 % |

Eps Indi: M2 1.26 / 4.9 %, P1native 1.29 / 11.4 % (fainter stars; full table in results.json).
None of the plain or grid products meets the pre-registered "clean" test (width < 1.5); M2 meets it
in both fields, with colour slopes consistent with zero (+0.2 +/- 0.3 and +0.05 +/- 0.3 percent per
mag BP-RP, Barnard and Eps Indi). P2 is the worst in z because a visit stack mixes about 20
wavelengths whose mix differs between visits. M1 is worse than the plain pair: resampling each
undersampled exposure to a grid and fitting across exposures with different pixel phases adds
more error than matching removes.

### What the gain is made of (controls on identical comparisons, one detector, prereg)

| product (Barnard) | z width | scatter |
|---|---|---|
| P1native (one plain pair) | 1.46 +/- 0.06 | 5.7 +/- 0.3 % |
| P1avg (plain pairs averaged over M2's window: more data, no matching) | 1.69 +/- 0.08 | 3.7 +/- 0.2 % |
| M2flat (matched window, constant instead of a line) | 1.69 +/- 0.08 | 3.5 +/- 0.1 % |
| M2unmatched (M2 averaging, plain pair's wavelength gap) | 1.71 +/- 0.09 | 3.7 +/- 0.1 % |
| M2 | 1.39 +/- 0.05 | 2.7 +/- 0.2 % |

All M2-minus-control differences are significant in Barnard (2.4 to 19 sigma). Of the drop in
scatter from P1native to M2, averaging alone (P1avg) reproduces 67 +/- 3 % (Barnard) and
71 +/- 3 % (Eps Indi); the remaining third is the wavelength matching. In Eps Indi the straight
line is no better than a constant in scatter (1.0 sigma) and M2 is not better than the best plain
pair in z width (1.1 sigma).

Paired stack (PS): each visit-A exposure paired with the nearest-wavelength visit-B exposure of the
same detector within one channel (each used once), differences averaged. Per star, detector and
visit pair, PS scatter minus M2 scatter: Barnard one detector +0.43 +/- 0.08 percentage points
(M2 better, significant); Barnard six detectors +0.13 (1.9 sigma); Eps Indi +0.28 +/- 0.20 (one)
and +0.15 (six), not significant. PS keeps 78 % (Barnard) and 50 % (Eps Indi) of visit-A
measurements at one channel. So PS is nearly as good and simpler; M2 is measurably better only
with one detector in the denser Barnard field.

### Kernels and grid (P1, Barnard)

Median dipole level (RMS of the difference within 3 px of G 12.0-13.5 stars over the star's peak;
no bootstrap error computed, N = 300 to 1700 comparisons): bilinear 0.077 to 0.080, exact
(flux-conserving) 0.077 to 0.080, Lanczos-3 0.076 to 0.078, adaptive 0.042 to 0.046 (it smooths
the image, so the peak drops too), 3.075" grid bilinear 0.068 to 0.071; P2 0.023 to 0.028, M1
0.043 to 0.050. Photometric z widths: bilinear 1.76 +/- 0.06, exact 1.75 +/- 0.06, adaptive
1.87 +/- 0.05, Lanczos-3 1.95 +/- 0.07 (Lanczos also loses about 60 % of comparisons to NaN
spreading near masked pixels). Recommendation for the website: keep bilinear; no kernel tested
removes the dipoles, and the 3" grid helps only slightly.

### Error bars

Single-exposure fluxes of a star scatter about that visit's own smooth spectrum more than the
pipeline variance predicts: width 1.40 (Barnard) and 1.22 (Eps Indi). The excess grows with
brightness (Barnard: 1.02 at G = 15.9, 2.47 at G = 12.4), does not depend on where the star falls
inside a pixel, is not explained by crowding and is not a few variable stars (removing the worst
10 % of stars changes 1.40 to 1.33). Adding a term of 2 percent of the star's flux in quadrature
(var' = var + (0.02 F)^2) brings every brightness bin and detector close to 1 (residual spread
0.07 in log width, against 0.25 for a constant factor). We adopt this inflation downstream. Its
physical cause (flat field, PSF or aperture loss, pointing jitter) was not identified. Background
pixels of difference images also scatter 1.15 to 1.30 times the propagated error.

### Limits

Two fields, 70 and 49 stars, G 12 to 16.5, isolated, not Gaia-variable. Saturated stars are not
handled: RW Aur, a test target, is saturated or bloomed in detectors 2 to 6 and in most detector
1 frames, so it cannot settle whether its detector 2 versus 6 change is variability (17 of 334
frames usable). The SOURCE flag covers about 97 percent of pixels, so excluding SOURCE pixels from
the local background is effectively impossible; the background falls back to a clipped annulus
median in about 80 percent of cases. The matched model is a straight line over +/- 2.5 bandwidths;
across that window the PSF width changes by 0.1 to 2 percent, which we neglect. The 2 percent
error term is empirical.

### Choices fixed before any phase B result was computed (2026-11-14, 09:52 CST; see git history)

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
   variance-weighted straight-line fit in wavelength, drop the single worst sample if it lies
   beyond 4 sigma and refit (amended 09:54 CST before any result: a full clipping pass from a fit
   pulled by one outlier rejected every sample in a unit test), evaluate at w0 with its
   propagated variance. Two modes: "six" (samples from all detectors) and "one"
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
10. Amendment (coordinator request, before any phase B result). FLAGS masks, stated exactly:
   "prereg" = phase A rejection bits 0 TRANSIENT, 1 OVERFLOW, 2 SUR_ERROR, 6 NONFUNC,
   9 MISSING_DATA, 10 HOT, 11 COLD, 15 NONLINEAR, 17 PERSIST, 25 STREAK, 26 BLOOM, 27 SNOWBALL,
   28 HALO, 29 SATELLITE_HALO, plus NaN. "browser" = the website's bad-data mask: bits 0, 2, 6,
   7 DICHROIC, 9, 10, 11, 14 PHANMISS, 15, 26, 27, plus NaN (OVERFLOW, PERSIST, STREAK, HALO,
   SATELLITE_HALO not masked). P1 is reported with both masks (browser is its headline, as it
   mimics the website); P2, M1 and M2 use prereg; M1 six is also run with browser for a like-for-
   like comparison. Grid products subtract ZODI and then a per-frame sigma-clipped median of
   pixels that are unflagged, not SOURCE-flagged and more than 3 native pixels from any Gaia
   source with G < 18, before resampling; aperture photometry keeps its local annulus.
   Exposure clusters with fewer than 12 exposures are not visits and are used nowhere
   (Barnard's Star index visits 1, 3, 5).

## Injection and recovery

Results: to be written (phase C).

### Choices fixed before any phase C result was computed (2026-11-14, 10:40 CST; see git history)

1. Fields and visits: Barnard's Star field visits 0 and 2 (6 months); Eps Indi field visits 0
   and 1 (6 months). Native cutout pixels; the archive ePSF (EPSF extension of each Level 2 file,
   zone nearest the source) for the injected point source.
2. Positions: uniform random in the cutout, at least 15 px from its edges, no Gaia source with
   G < 18 within 20 arcsec and none with G < 9 within 3 arcmin of the old or new position. Fixed
   random seed. Motion direction uniform random; position linear in time, with the stated motion
   per 182.6 days (pixels of 6.15 arcsec).
3. Grid: AB 14.0 to 19.5 in steps of 0.5; motion 0, 0.25, 0.5, 1, 2, 4 px per 6 months; two
   spectra: flat in AB, and a cool brown dwarf model (Sonora Bobcat, Marley et al. 2021) normalised
   to the stated AB magnitude at 4.5 um. 50 trials per cell and field.
4. Injection: flux density converted to MJy/sr per pixel with the nominal pixel solid angle; the
   ePSF shifted to the sub-pixel position, integrated over pixels, added to IMAGE; source photon
   noise added as Gaussian noise with variance k x signal, k fitted per frame from VARIANCE against
   IMAGE on unflagged pixels, and the same added to VARIANCE.
5. Photometry and comparisons exactly as docs/algorithm.md (one detector at a time, inflated
   variance var + (0.02 F)^2), evaluated at the old position (visit A position at visit A's mean
   epoch) and the new position (visit B). Detector results are pooled by inverse variance for the
   six-detector statistic; the one-detector statistic uses detector 2.
6. Detection statistic, for each of P1 (best pair), PS (paired stack) and M2:
   S = (D_old - D_new) / sqrt(var_old + var_new), with D = visit A minus visit B. Threshold: the
   99th percentile of S over un-injected trials with the same positions and motion (at least 500
   per field and motion), i.e. 1 percent false positives; completeness also reported at S >= 5.
7. False-alarm calibration of the readout: on the phase B steady-star samples, the fraction of
   (star, detector, visit pair) combined |z| at or above 3, 4 and 5, for P1, PS and M2 with the
   inflated variance; thresholds recommended for about 1 and 0.1 percent.

## Known movers

To be written (phase D).
