# Wandering Pixels

Wandering Pixels is a public website for looking at images from NASA's SPHEREx telescope over time. You pick a spot on Earth, look up at the sky from there, choose a patch of sky (or type a name or coordinates), and the site plays the SPHEREx images of that patch one visit after another. You can blink two images, subtract one from the other, click a spot to read its brightness at every wavelength, and overlay Gaia and WISE catalogue stars. It was built for the NASA Space Apps 2026 challenge "Planet X and SPHEREx", and it comes with a written validation of how SPHEREx images can and cannot be compared.

Live site: https://wandering-pixels.vercel.app

Method and results: [docs/method.md](docs/method.md). Every number in it is in [docs/results.json](docs/results.json).

## What you can do

- Turn a 3D Earth (day and night, sun position from the current time), choose a city or observatory from a list, use your own location, or click anywhere. "Look up from here" flies down to the surface and opens the sky above that spot.
- Look around the whole sky from horizon to zenith with N, E, S, W marks. The backdrop is the SPHEREx all-sky map at a wavelength you choose, plus bright stars. Built-in coarse base sky tiles keep the sky view working when the archive is down. The date box turns the sky. The map is a fixed year-one map: the sky view does not show change. Change appears only after you open a patch.
- Open a patch of sky by pointing at it, by typing a name or coordinates in the top bar, or from the "Challenge targets" menu (Barnard's Star, Epsilon Indi B, WISE 0855-0714, RW Aurigae, R Draconis). The challenge targets are prepared in advance and open without a live download, with a small preview file loading ahead of the rest so the view appears fast. Any other position is downloaded live from NASA's archive, with progress shown, and results fill in per archive collection as they arrive.
- Play the images of the patch as a movie, per visit or per exposure, with a scrub bar, speed, contrast, detector and patch-size choices.
- Blink two chosen images.
- Show a difference image (B minus A) on a signed scale. The source can be a paired stack, which pairs exposures at matching wavelengths before subtracting, or a single pair. The site warns when the two images were taken at different wavelengths. Difference images are for the eye. They are not a measure of significance, and the paired stack is not validated at pixel level (see docs/method.md).
- Click a spot on an image to plot its brightness against wavelength for every exposure, with saturated or flagged points marked, and download the numbers as CSV.
- Click a star in the spectrum view to see a "Has it changed between visits?" block. It gives one of three verdicts ("Consistent between visits", "Differs between visits", "Cannot be measured here") and a reliability flag. Within about 3 arcminutes of any star brighter than magnitude 9 the result is marked unreliable, so on the challenge targets most neighbouring stars are marked not reliable. The browser code reproduces the reference analysis.
- Overlay Gaia and WISE catalogue sources, and show masked pixels and advisory flags (near a bright star or a streak).
- Try the "Distant bodies" section: step one blinks a pair of visits about a year apart, where stars cancel and a distant moving body would show as a bright and dark pair. Step two re-centres images on where a body at an assumed distance would be on each date; this step works on live targets only and is switched off on the five prepared targets. A "Try it with a simulated body" button plants a simulated 500 au body so you can try both steps. It is a demonstration of a method, not a search (see Limits).
- Copy a link that stores the target and view settings.

## How it works

The browser does the image work. It reads NASA's public SPHEREx Level 2 files directly from the IRSA public S3 bucket `nasa-irsa-spherex` using HTTP range requests, so only the header, image, flag, variance and wavelength-table bytes it needs are downloaded. It aligns the exposures with each file's own sky coordinates and shows them on one common grid.

Small relay functions in `api/` (Vercel functions) handle what browsers cannot call directly:

- `api/exposures.js`: search of the IRSA SPHEREx archive (SIA2) for exposures at a position.
- `api/gaia.js`: Gaia DR3 cone search.
- `api/wise.js`: CatWISE2020 and AllWISE cone search.
- `api/resolve.js`: name lookup (Sesame, then SIMBAD).

The five challenge targets are prepared in `public/cache/` by `scripts/build-cache.ts`, so a judge sees them with no live archive call. The cache holds at most 300 exposures per target and is a snapshot. The sky map comes from the SPHEREx all-sky HiPS cube served by IRSA. Earth textures, bright stars and fonts are bundled with the site.

## What we measured

Short version of [docs/method.md](docs/method.md), measured on two fields (Epsilon Indi and Barnard's Star) from public data:

1. A plain pair of SPHEREx exposures makes a constant star look changed more often the further apart the two exposures' wavelengths are. Fitting each star's own spectrum per visit and comparing at the same wavelength removes that dependence. For a plain pair, the width of the normalised difference grows from about 1.4 (wavelength gap under half a channel) to about 8.7 (gap over 10 channels). For the matched comparison it stays near 1.4. The slope of that width with the wavelength gap is +0.64 +/- 0.09 per channel for the plain pair and +0.001 +/- 0.001 for the matched comparison. This was tested on 70 constant stars (Barnard's Star field) and 49 (Epsilon Indi field). About two thirds of the gain in scatter comes from using more exposures; about a third is the wavelength matching. In the Epsilon Indi field the straight-line fit is no better than a constant.
2. The archive's sky coordinates register different exposures of the same star to 0.04 to 0.06 pixel (0.22 to 0.39 arcsec per pair). This holds within a visit and across 6, 12 and 18 months, on 171 (Epsilon Indi) and 257 (Barnard's Star) stars. We found no published figure for this.
3. The archive's error bars are too small for point-source photometry: differences of a constant star scatter about 1.2 to 1.4 times more than the stated errors predict. A missing error of about 2 percent of the star's flux explains it. That 2 percent is an empirical round value.
4. Visits six or twelve months apart do not line up in wavelength any better than visits in the same week; a typical pair of exposures is about 5 channel widths apart, although for most exposures a partner within one channel can be found (52 to 75 percent), which is what the site's pair picker does.
5. Known movers: Epsilon Indi B's motion between visits matches its Gaia DR3 proper motion and parallax to within 0.10 arcsec at most. Its absolute position sits a constant (+0.2, -0.55) arcsec from the Gaia position, as expected for an unresolved pair of brown dwarfs. Barnard's Star is saturated in all 358 exposures, but its outer glow gives a 12-month motion of 1.68 pixels a year against 1.69 predicted. WISE 0855-0714 is not seen: our 3 sigma limit near 4.6 microns, 16.8 AB, is not deep enough to constrain it (expected about 17.4 AB). The star that looks like it at its predicted position is a constant background Gaia star.
6. In the Barnard field, Gaia DR3 4472819623984651392 (V391 Oph, G 12.7), an eclipsing binary in the Gaia DR3 classifier (Eyer et al. 2023) that changes within a visit, stands out in the matched comparison (root-mean-square z 18.2, against 0.9 for a constant neighbour of the same brightness). That is one of two variables tested; the second (G 15.4) gives 2.3 against 0.9.
7. Fake moving stars added to real Barnard's Star field images were found half the time at AB 18.3 to 19.1 when they moved 2 to 4 pixels between visits, and only to about AB 16 when they moved 1 pixel. One field, flat spectrum, 30 trials per point: a small test. Detail: plain best pair 18.3, paired stack 19.1, matched 18.8 at 2 pixels (six detectors pooled); a fake that does not move is never found.
8. On steady stars, the share of comparisons that reach |z| of 3 or more is about 0.9 percent for the matched comparison in the Barnard's Star field (0.8 percent in the Epsilon Indi field), 2.1 and 1.3 percent for the plain pair, and 3.2 and 3.6 percent for the paired stack. The write-up recommends |z| of 3 for about 1 percent false alarms with the matched comparison and about 4 for the other two. The 1 percent false-alarm rate holds for unblended, unsaturated stars of Gaia G 12 to 16.5, more than 3 arcminutes from any star brighter than G 9. Near saturated stars, or for blends, it can be tens of percent, and the site marks those results as not reliable. The browser code reproduces the reference analysis (117 of 117 results agree when fed the same exposure numbers).
9. Negative results are in the write-up too: per-pixel matched images failed, and none of the three resampling kernels we tried removes the dipoles around bright stars in a plain pair.

## Limits

- Two test fields, 70 and 49 stars, Gaia G 12 to 16.5, isolated stars. Brighter stars, including the challenge targets, are saturated or non-linear and were not tested.
- Barnard's Star, RW Aurigae and R Draconis are saturated in SPHEREx. Photometry and positions cannot be measured on them by this method (RW Aurigae: 17 of 334 frames usable; R Draconis: 56 of 56 sampled exposures saturated). The site can show their images; it does not measure them.
- WISE 0855-0714 is not seen in SPHEREx single exposures (see above).
- Per-star matched photometry works. Per-pixel matching on resampled images did not. The difference images on the site are built from bilinearly resampled frames and are not validated at pixel level.
- The per-star "has it changed" block is a display of one statistic, not a calibrated search. The 1 percent false-alarm rate holds for unblended, unsaturated stars of Gaia G 12 to 16.5, more than 3 arcminutes from any star brighter than G 9. Near saturated stars, or for blends, it can be tens of percent, and the site marks those results as not reliable. The 1 percent thresholds rest on a few hundred empty trials.
- The distant-body section is a worked example on a simulated body at 500 au, using the real exposures of the Barnard's Star field with a point source added. Find a candidate on a pair about a year apart, then measure its distance on the visit about six months away. The injected bodies were AB 12.75 and 14.25. Step one found the bright one as a bright and dark pair 21.8 pixels apart (21.0 true). Step two read its distance back as 505 au against 500 injected; ignoring the body's own orbital motion gives 462 au. With the distance known, the tracked stack reaches about AB 19.5; a blind search in this crowded field picks out the fake only down to about AB 14, because real stars leave residuals. Step two uses the motion measured in step one; without it the distance comes out about 8 percent low at 500 au. Single SPHEREx images reach about magnitude 18.5 to 19 (pre-launch figures); published models put Planet Nine between about 19 and 27 at these wavelengths, and an earlier WISE search covered most of the sky to 19.4. Single images cannot reach past earlier searches. Stacking every frame in the body's own frame could in principle go about one magnitude deeper than the WISE search at 3 to 4 microns. That would test only the warmest models, and it is not done here. The tool shows how such a search works. It does not claim any planet, and a discovery is not expected from these data. One pair gives candidates only; many unrelated things look the same in one pair.
- The injection test covers one field (Barnard's Star), one flat spectrum, and motions of 0, 1, 2 and 4 pixels per six months, with 30 trials per cell. A sloped spectrum, the Epsilon Indi field and other motions were not run. The 1 percent thresholds rest on a few hundred empty trials and are uncertain.
- Only five targets are prepared. Any other target is downloaded live and depends on IRSA being up. Measured on the production site on 2026-11-14, single runs, during a window when IRSA's front end was unhealthy: the opening view of a prepared target downloads 119 to 170 KB (gzip; index, preview and star list) and took 1.3 to 2.0 s unthrottled, summed over the three files. The live path depends on IRSA: of 20 archive searches through the relay, 15 answered (median 10.9 s for those; 14 of the 15 were partial, missing one or more collections) and 5 failed after about 20 s. A live initial look downloaded about 5.5 to 6.0 MB and took 3.9 to 13.8 s in two runs. Treat these as one bad-hour sample, not typical figures.
- The sky view shows the year-one SPHEREx map. Rise and set times are given for the five challenge targets only.

## Run it locally

Node 26 and npm 11 were used.

```
git clone https://github.com/saamirkhrl/wandering-pixels
cd wandering-pixels
npm ci
npm test          # vitest; network tests are skipped unless WP_NET_TESTS=1
npm run typecheck
npm run build     # tsc --noEmit, then vite build into dist/
npm run dev       # Vite dev server
```

For name lookup and live archive search in development, run the relay in a second terminal. Vite proxies `/api` to `http://localhost:8787`:

```
node scripts/dev-relay.mjs      # set PORT to change the port
```

Network tests (`src/lib/spherex/*.net.test.ts`) download from the public S3 bucket and run with `WP_NET_TESTS=1 npm test`.

Validation (Python, optional, downloads about 7.7 GB for a full run):

```
cd validation
uv sync
```

Then follow [validation/README.md](validation/README.md) for the analysis scripts that produce `docs/results.json` and `docs/figures/`.

## Data and credits

NASA and partner data and services:

- SPHEREx Level 2 spectral images (data releases DR1 and QR3) and the SPHEREx all-sky HiPS cube: NASA SPHEREx mission, archived and served by the NASA/IPAC Infrared Science Archive (IRSA) at Caltech/IPAC. Search: https://irsa.ipac.caltech.edu/SIA . Files: https://nasa-irsa-spherex.s3.amazonaws.com/ . Sky map: https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube . Docs: https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_dr1.html and https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html . DOIs: 10.26131/IRSA678 (DR1 spectral images), 10.26131/IRSA679 (DR1 all-sky cube), 10.26131/IRSA662 (QR3).
- This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.
- This research has made use of the NASA/IPAC Infrared Science Archive, which is funded by the National Aeronautics and Space Administration and operated by the California Institute of Technology.
- CatWISE2020 and AllWISE (WISE mission, NASA) through the IRSA cone search: https://irsa.ipac.caltech.edu/SCS . CatWISE2020: Marocco et al. 2021, ApJS 253, 8, arXiv:2012.13084.
- Yale Bright Star Catalogue, 5th revised edition (Hoffleit and Warren 1991) through NASA HEASARC: https://heasarc.gsfc.nasa.gov/xamin/vo/tap/sync
- NASA Blue Marble Next Generation, January 2004 (Reto Stockli, NASA Earth Observatory): https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/january/world.200401.3x5400x2700.jpg
- NASA Black Marble 2012 (Joshua Stevens, Suomi NPP VIIRS, Miguel Roman, NASA GSFC): https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144875/BlackMarble_2012_01deg.jpg

Other services and catalogues:

- Gaia DR3 (ESA, Gaia Collaboration 2023, A&A 674, A1) through the ESA Gaia archive TAP service: https://gea.esac.esa.int/tap-server/tap/sync
- Sesame name resolver through the VizieR mirror at CfA: https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SNV? , and SIMBAD TAP (CDS, Strasbourg): https://simbad.cds.unistra.fr/simbad/sim-tap/sync
- HEALPix (Gorski et al. 2005, ApJ 622, 759) and HiPS (IVOA HiPS 1.0, Fernique et al. 2017). The HEALPix maths in the site is our own code.
- Sonora Bobcat model spectra (Marley et al. 2021, CC BY 4.0), used only in the offline validation as a brown dwarf template.

Website libraries (npm):

| Library | Licence |
|---|---|
| three | MIT |
| astronomy-engine (https://github.com/cosinekitty/astronomy, Don Cross) | MIT |
| @fontsource-variable/bricolage-grotesque | OFL-1.1 |
| @fontsource/atkinson-hyperlegible-next | OFL-1.1 |
| vite | MIT |
| vitest | MIT |
| typescript | Apache-2.0 |
| @types/three | MIT |

Validation libraries (Python, run with uv, https://docs.astral.sh/uv/):

| Library | Licence |
|---|---|
| aiohttp | Apache-2.0 AND MIT |
| astropy | BSD-3-Clause |
| astroquery | BSD |
| fsspec | BSD-3-Clause |
| matplotlib | Matplotlib licence (PSF-style) |
| numpy | BSD-3-Clause and others (see its metadata) |
| photutils | BSD-3-Clause |
| reproject | BSD-3-Clause |
| requests | Apache-2.0 |
| s3fs | BSD |
| scipy | BSD-style |

Fonts, bundled with the site and not loaded from a font service: Bricolage Grotesque (copyright 2022 The Bricolage Grotesque Project Authors, https://github.com/ateliertriay/bricolage) and Atkinson Hyperlegible Next (copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors, https://github.com/googlefonts/atkinson-hyperlegible-next), both under the SIL Open Font License 1.1.

Prior work that this builds on and should be read with: WiseView (https://byw.tools/wiseview; Caselden, Westin, Meisner, Kuchner and Colin 2018, ascl:1806.004) does blink, difference imaging, shift-and-add and catalogue overlays for WISE. SPXQuery (https://spxquery.readthedocs.io/en/latest/) and SPIFF (Gagne et al. 2026, arXiv:2604.22012) work with SPHEREx photometry and spectra rather than showing images.

## Use of AI tools

AI coding assistants were used to write code, run analyses, draft text and generate the demo narration audio. This was done under the team's direction and review. The code, analyses and written material in this repository were produced with that assistance.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
