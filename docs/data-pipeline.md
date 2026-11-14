# Data pipeline

How the site gets SPHEREx pixels onto the screen, and how to run, test and rebuild it.

## What the data layer does

All of it is in `src/lib/spherex/` (TypeScript, no runtime dependencies, runs in the browser
and in Node 20+) and `api/` (small relay functions).

- **Range reads** (`fits.ts`, `flags.ts`, `rice.ts`, `wavelength.ts`). SPHEREx Level 2 images
  are read straight from the public S3 bucket with HTTP Range requests. Only the header and the
  rows of the window around the target are fetched, never the whole file. Reads retry on 5xx and
  network errors with exponential backoff. FLAGS is a Rice-compressed table, decoded in the
  library.
- **WCS with SIP** (`wcs.ts`). Each exposure carries a TAN-SIP world coordinate system. Pixel
  convention: 0-based, (0, 0) is the centre of the first stored pixel.
- **Reprojection** (`frame.ts`). Each exposure window is resampled onto one common grid: 65 x 65
  pixels at 6.15 arcsec per pixel, north up, east left, centred on the target, with proper
  motion applied at the exposure time. Every frame also carries a variance plane, a wavelength
  map and a flag map.
- **Masks** (`types.ts`). Flag bits are split in two groups. BAD_DATA bits (no data, saturated,
  bad pixel, transient) make a grid pixel NaN and keep it out of stacks, photometry and
  backgrounds. ADVISORY bits (persistence, crosstalk, streak, halo) are only reported for
  overlays; the pixel value is kept. A grid pixel gets the OR of the bits of the source pixels
  that fed it.
- **Visits** (`movie.ts`, `scripts/README.md`). Exposures are grouped into visits: a gap of more
  than 30 days starts a new visit, and long deep-field visits are split into 60-day bins.
  Visits with fewer than 12 exposures are kept but not stacked.
- **Paired-stack difference** (`movie.ts`, `matched.ts`, `docs/algorithm.md`). Two visits are
  stacked and subtracted. For photometry, each star's spectrum is modelled per visit and
  compared at the same wavelength (`matched.ts`, `photometry.ts`, `native.ts` on native
  pixels). The method and its validation are in `docs/method.md` and `docs/algorithm.md`.
- **Distance tracking** (`parallax.ts`). For a body at an assumed distance, the grid is shifted
  by the annual parallax of the Earth's position (low-precision Meeus solar position, under
  0.1 arcsec of error at 300 au), so a distant mover stays fixed in the stack.
- **Relay endpoints** (`api/exposures.js`, `gaia.js`, `wise.js`, `resolve.js`). The S3 bucket
  allows cross-origin Range reads, so images are fetched directly. The other services do not
  send CORS headers or are unreliable from a browser: IRSA (SIA2 exposure search, WISE cone
  search), the ESA Gaia TAP service, and the name services (SIMBAD TAP; the CfA Sesame mirror
  is called directly by the browser first and the relay is the fallback). The relay calls them
  server-side, validates inputs, retries with backoff, trims the answers to small JSON and sets
  cache headers. The browser side is `net.ts`, `search.ts`, `gaia.ts`, `wise.ts`, `resolve.ts`.

## Cache layout

The five challenge targets are precomputed so the first view needs no archive calls. Format
`wp-cache-2`, per target in `public/cache/<slug>/` (documented at the top of
`src/lib/spherex/cache.ts`):

| File | Content | Size (Barnard's Star) |
|---|---|---|
| `index.json` | format, grid, build info, visits, names and sizes of the other files; short browser cache | 17 KB |
| `preview.<hash>.bin` | first view for the default detector: visit-stack movie, blink pairs, visit difference images | 144 KB |
| `stars.<hash>.json` | Gaia (brightest first) and WISE overlay sources | 21 KB |
| `stars-full.<hash>.json` | the full star list | 69 KB |
| `exposures.d<N>.<hash>.json` | exposure list for detector N | about 20 KB |
| `frames.d<N>.<hash>.bin` | frames of detector N (f16 pixels, 8-bit log variance, flags) | 0.6 to 1.0 MB each |

`<hash>` is FNV-1a 32 of the file bytes, so every file except `index.json` is served immutable
for a year (`vercel.json`). Whole directories: barnards-star 5.2 MB, eps-indi-b 5.2 MB,
r-dra 5.1 MB, rw-aur 5.2 MB, wise-0855 4.5 MB; `public/cache` totals 25 MB (budget 30 MB).
A first view (index + preview + stars) is 171 to 237 KB raw per target (r-dra 171 KB, eps-indi-b
237 KB), computed from the files above. Details on visit rules, the 300-exposure cap and the
default detector are in `scripts/README.md`.

## Running things

    npm test                         # offline; network and sample-dependent tests skip themselves
    WP_NET_TESTS=1 WP_SAMPLES_DIR=/path/to/samples npx vitest run src/lib/spherex
    node scripts/dev-relay.mjs       # local relay on http://localhost:8787/api/{exposures,gaia,resolve,wise}

- Tests that touch the network (`*.net.test.ts`) run only with `WP_NET_TESTS=1`. Tests that
  need large sample files skip when `WP_SAMPLES_DIR` (default `../research/samples` next to the
  repo) is missing. Downloads they make go there, never into the repo.
- `dev-relay.mjs` loads the handlers in `api/` per request; `PORT` changes the port. The Vite
  dev server proxies `/api` to port 8787. Checked: an unknown route answers 404 and a bad
  parameter answers 400 with a JSON error body.
- Rebuild the cache (downloads about 650 to 850 MB per target, 90 to 110 s each, safe to
  re-run):

      npx -y vite-node scripts/build-cache.ts <slug|all>

- Convert an old format 1 cache without downloading (`--delete-v1` removes the old files after
  the check passes; running with no argument prints usage and writes nothing):

      npx -y vite-node scripts/convert-cache.ts <slug|all> [--delete-v1]

- Contact sheets for a visual check: `npx -y vite-node scripts/contact-sheet.ts <slug|all>`.
- Slugs: `barnards-star`, `eps-indi-b`, `wise-0855`, `rw-aur`, `r-dra`.

## Measured numbers

- Registration: the archive's sky coordinates register different exposures to each other to
  0.04 to 0.06 px (0.22 to 0.39 arcsec per pair; 0.036 to 0.064 px over all classes), the same
  within a visit and across 6, 12 and 18 months. Source: `docs/method.md`, section
  "Registration precision".
- First view: 171 to 237 KB raw (above).
- One 65 x 65 frame costs about 2.1 MB of S3 traffic (2,075,579 bytes in 10 Range requests,
  measured in Node and in headless Chrome on 2026-11-14): headers, then full-width rows of
  IMAGE, VARIANCE and ZODI, plus FLAGS rows and the wavelength table.
- Exposure search through the relay took 1.2 s and 16.7 s at two positions on 2026-11-14
  (production, Node). In a 20-position sweep the same day, 15 calls returned in a median
  10.9 s and 5 ended in 503 after about 20 s, during a period when the archive was slow.

## Known limits

- An image difference carries no significance by itself. The z values in `docs/method.md` come
  from the matched photometry, not from subtracting pixels.
- Bright stars leave lobes in a difference image, and saturated cores are masked, so
  residuals near very bright stars should not be read as changes.
- The archive's image search fails about half of its calls. The relay retries quickly and lists a collection it could not reach in `partial`; the browser
  asks once more after 2 s.
- The SATELLITE_HALO flag (bit 29) is not documented in the v27 headers. The library groups it
  with HALO as an advisory bit, and `docs/method.md` reports results with and without it.

- WISE 0855-0714 is too faint for single SPHEREx images and is not detected (3 sigma limit
  16.8 AB in detector 6). The faint source at its marker in detector 2 is a background star,
  Gaia DR3 5756956644387831296 (G 16.3).

## Data sources and credits

- SPHEREx Level 2 images and exposure search: NASA/IPAC Infrared Science Archive (IRSA), SPHEREx
  archive and its public S3 bucket (`nasa-irsa-spherex`).
- Gaia DR3: ESA Gaia archive. This work has made use of data from the European Space Agency
  (ESA) mission Gaia, processed by the Gaia Data Processing and Analysis Consortium (DPAC).
- WISE overlay stars: CatWISE2020 and AllWISE, served by NASA/IPAC IRSA. They are products of
  the Wide-field Infrared Survey Explorer and NEOWISE.
- Names and positions: the CfA VizieR mirror of Sesame, and SIMBAD, operated at CDS,
  Strasbourg, France.
