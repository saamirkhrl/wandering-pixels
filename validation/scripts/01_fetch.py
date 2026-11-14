"""Fetch cached cutouts for every on-detector exposure of a field's index.

usage: uv run python scripts/01_fetch.py --field {epsindi,barnard,all} [--workers 12] [--force-large]
Writes data/cutouts/<field>/<OBSID>_D<det>.fits and data/fetch_log_<field>.json.
"""
import argparse
import csv
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wp import io as wio  # noqa: E402
from wp.config import DATA, FIELDS  # noqa: E402

EST_BYTES_PER_CUTOUT = 10.0e6   # measured 9.95 MB for a full 320x320 window
LIMIT = 5.0e9


def run(field, workers, force_large):
    rows = list(csv.DictReader(open(DATA / f"index_{field}.csv")))
    cen = json.loads((DATA / "field_centres.json").read_text())[field]
    jobs, skipped = [], 0
    for r in rows:
        if r["on_detector"] != "True":
            continue
        out = DATA.parent / r["cutout_path"]
        if out.exists():
            skipped += 1
            continue
        jobs.append(dict(s3_key=r["s3_key"], x_c=float(r["target_x"]), y_c=float(r["target_y"]),
                         half=160, out_path=out,
                         meta=dict(release=r["release"], field=field, visit=int(r["visit"]))))
    n_on = sum(r["on_detector"] == "True" for r in rows)
    est = len(jobs) * EST_BYTES_PER_CUTOUT
    print(f"[{field}] on-detector {n_on}, cached {skipped}, to fetch {len(jobs)} (est {est/1e9:.2f} GB)")
    if est > LIMIT and not force_large:
        print(f"[{field}] estimate exceeds {LIMIT/1e9:.0f} GB; not fetching (use --force-large)")
        return
    b0 = wio.bytes_downloaded()
    t0 = time.time()
    last = [0]

    def prog(i, n):
        if i - last[0] >= 50 or i == n:
            last[0] = i
            print(f"  {i}/{n}  {(wio.bytes_downloaded()-b0)/1e6:.0f} MB  {time.time()-t0:.0f}s", flush=True)
    res = wio.fetch_many(jobs, workers=workers, progress=prog) if jobs else []
    errs = [(j["out_path"].name, e) for j, e in res if e]
    dt = time.time() - t0
    nbytes = wio.bytes_downloaded() - b0
    have = sum((DATA.parent / r["cutout_path"]).exists() for r in rows if r["on_detector"] == "True")
    print(f"[{field}] downloaded {nbytes} bytes ({nbytes/1e9:.3f} GB) in {dt:.1f}s; errors {len(errs)}; "
          f"cutout files {have}/{n_on}")
    for e in errs[:10]:
        print("  ERR", e)
    log = dict(field=field, bytes=nbytes, seconds=dt, fetched=len(jobs) - len(errs), cached=skipped,
               errors=[list(e) for e in errs], on_detector=n_on, files_present=have,
               centre=dict(ra=cen["ra"], dec=cen["dec"]))
    (DATA / f"fetch_log_{field}.json").write_text(json.dumps(log, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", choices=["epsindi", "barnard", "all"], default="all")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--force-large", action="store_true")
    a = ap.parse_args()
    for f in (FIELDS if a.field == "all" else [a.field]):
        run(f, a.workers, a.force_large)
