# scripts

## Local relay

    node scripts/dev-relay.mjs

Serves the functions in `api/` at http://localhost:8787/api/{exposures,gaia,resolve,wise}
(set `PORT` to change it). The Vite dev server proxies `/api` to this port. Needs Node 20 or
later and no build step.

## Rebuilding the target cache

    npx -y vite-node scripts/build-cache.ts <slug|all>

Slugs: `barnards-star`, `eps-indi-b`, `wise-0855`, `rw-aur`, `r-dra`. For each target it
queries IRSA SIA2 for every Level 2 exposure covering the position, reads the selected
exposures from the public SPHEREx S3 bucket by HTTP Range requests, resamples them onto the
shared 65 x 65 grid (6.15 arcsec/px), adds Gaia DR3 and WISE overlay stars, and writes the
format `wp-cache-2` files (below). No FITS files are stored. A full run
downloads about 650 to 850 MB per target and takes about 90 to 110 s per target. It is safe
to re-run for one target.

### Cache format (wp-cache-2)

Per target, in `public/cache/<slug>/`:

- `index.json`: small, short cache. Format, target, grid, build info, default detector and the
  rule used, per-detector summary, visits, and the names and byte sizes of the other files.
- `preview.<hash>.bin`: first view for the default detector: the visit-stack movie, the year
  and half-year blink pairs (frames with flags) and the visit difference images.
- `stars.<hash>.json`: Gaia (brightest first, rounded) and WISE sources.
- `exposures.d<N>.<hash>.json` and `frames.d<N>.<hash>.bin`: all cached exposures and frames of
  detector N (f16 pixels, 8-bit log variance, flags).

`<hash>` is 8 hex characters of FNV-1a 32 over the file bytes, so those files are served
immutable for a year (`vercel.json`). Default detector: 2, except `wise-0855` which uses 6 (the
only band with a marginal signal); a target without detector 2 data uses the detector with the
most visits. The full layout is documented at the top of `src/lib/spherex/cache.ts`. A first
view (index + preview + stars) is 180 to 300 KB raw, about 120 to 180 KB gzipped; the whole
directory is about 5.4 MB per target.

Convert an old format 1 cache (manifest.json + frames.bin) without downloading anything; the
check compares every frame with format 1 and `--delete-v1` then removes the old files:

    npx -y vite-node scripts/build-cache.ts --convert all --delete-v1

(`scripts/convert-cache.ts` does the same). A rebuild removes stale hashed files and any
format 1 files.

Contact sheets for a visual check: `npx -y vite-node scripts/contact-sheet.ts <slug|all>`
(written to `$WP_SAMPLES_DIR/cache-check/`, default `../research/samples/` next to the repo).

## Rules

- Visits: a gap over 30 days starts a new visit; a visit spanning over 90 days (deep fields)
  is split into 60-day bins.
- Inside a visit, small sub-clusters (7-day gap, under 12 exposures) and whole visits under
  12 exposures are kept but marked `inStack: false`, so they are not stacked.
- Targets with more than 300 exposures are capped at 300: every (visit, detector) cell gets
  at least 4, the rest is spread evenly, evenly in time within a cell.
- Exposures with the target at least 40 px inside the detector edge are preferred; frames
  under 50 percent coverage are dropped and topped up from the same cell.
- Budget: `public/cache/` stays under 30 MB in total (about 5.4 MB per target).

## Tests

    npx vitest run scripts

`cache-offline.test.ts` loads every cached target (preview, each detector, the whole target) with
the network disabled and skips when `public/cache` is missing.
`visits-lists.test.ts` checks the visit rule on saved exposure lists and skips when
`WP_SAMPLES_DIR` (or the default samples folder) is missing.
