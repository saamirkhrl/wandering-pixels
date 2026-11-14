# validation

Python code that measures, from public SPHEREx Level 2 data, the numbers in
`docs/results.json` and the figures in `docs/figures/`. Method notes: `docs/method.md`.

## Setup

Requires [uv](https://docs.astral.sh/uv/). From this directory:

```
uv sync
```

All data access is anonymous: IRSA SIA2 (exposure search), the public AWS S3 bucket
`nasa-irsa-spherex` (Level 2 images and spectral calibration files, HTTP Range reads) and the
ESA Gaia archive TAP service (Gaia DR3). Downloads are cached under `validation/data/`
(gitignored). A full run downloads about 7.7 GB (4.4 GB Eps Indi, 3.3 GB Barnard's Star,
plus about 200 MB of calibration files) and keeps about 1.8 GB on disk.

## Commands (run in order; each accepts `--field epsindi|barnard|all`)

| Step | Command | Produces |
|---|---|---|
| 1. Exposure index | `uv run python scripts/00_index.py --field all` | `data/index_<field>.csv`, `data/field_centres.json` (visit structure printed) |
| 2. Cutouts | `uv run python scripts/01_fetch.py --field all` | `data/cutouts/<field>/*.fits` (320 x 320 px around the field centre) |
| 3. Wavelength sampling | `uv run python scripts/02_wavelength.py --field all` | results sections `wavelength_source_check`, `wavelength_sampling`; figures `wavelength_sampling_*.png`, `wavelength_pair_dlambda_*.png` |
| 4. Registration precision | `uv run python scripts/03_registration.py --field all` | results sections `registration_<field>`; figures `registration_pairs_*.png`, `registration_vs_mag_*.png` |
| 5. IMAGE minus ZODI flatness | `uv run python scripts/04_zodi.py --field all` | results section `zodi_flatness`; figures `zodi_residual_*.png` |

| 6. Grid products P1, P2, M1, kernels (Barnard) | `uv run python scripts/05_grid_products.py --field barnard` | `data/phaseb/barnard/fluxes_{P1,P2,M1}.ecsv`, results `phaseb_pixel_barnard`, figures `phaseb_panels_*`, `phaseb_kernels_*` |
| 7. Forced photometry, M2 and controls | `uv run python scripts/06_forced_phot.py --field barnard` (then `--field epsindi`) | `data/phaseb/<field>/fluxes_{M2,P1native,M2flat,M2unmatched}.ecsv`, results `phaseb_forced_<field>` |
| 8. Product metrics | `uv run python scripts/07_metrics.py --field all` | results `phaseb_metrics_<field>`, `psf_vs_wavelength`; figures `phaseb_z_hist_*`, `phaseb_frac_vs_color_*`, `phaseb_p1_vs_gap_*`, `phaseb_psf_vs_lambda` |
| 9. Controls, paired stack, error study | `uv run python scripts/07b_phaseb_controls.py --field all` | results `phaseb_controls_<field>`; figures `phaseb_gap_full_*`, `phaseb_controls_*`, `phaseb_errors_*` |
| 9b. Error floor effect | `uv run python scripts/07c_error_floor.py` | results `phaseb_error_floor_barnard` |
| 9c. Injection flux check | `uv run python scripts/10c_injection_flux_check.py` | prints recovered AB of injected AB 16 and 18 sources |
| 10. Port test vectors | `uv run python scripts/09_algorithm_vectors.py` | `docs/algorithm_test_vectors.json` (spec: `docs/algorithm.md`) |

Steps 3 onward only need the cache from steps 1 and 2 (step 10 needs step 7). Re-running any step with a warm cache
gives identical numbers (fixed random seeds).

## Layout

- `wp/config.py` paths and field definitions
- `wp/exposures.py` SIA2 query, de-duplication across releases, visit clustering, pair classes
- `wp/io.py` header reads and cutouts by HTTP Range from S3 (FLAGS decompressed, WCS kept)
- `wp/wavelength.py` per-pixel wavelength from the spectral WCS calibration files, and the
  WCS-WAVE lookup table for comparison
- `wp/gaia.py` Gaia DR3 query and propagation to each exposure epoch (proper motion and parallax)
- `wp/registration.py` star selection, two centroid methods, residuals against Gaia
- `wp/results.py` writes sections of `docs/results.json`
