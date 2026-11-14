"""Build the SPHEREx exposure index for a field: query SIA2, dedupe, read headers, locate target.

usage: uv run python scripts/00_index.py --field {epsindi,barnard,all}
Writes data/index_<field>.csv and data/field_centres.json.
"""
import argparse
import csv
import json
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wp.config import DATA, FIELDS, USER_AGENT  # noqa: E402
from wp.exposures import assign_visits, query_exposures  # noqa: E402
from wp.io import CUTOUT_DIR, read_image_header, target_pixel  # noqa: E402

GAIA_NAMES = {"epsindi": "Gaia DR3 6412595290592307840", "barnard": "Gaia DR3 4472832130942575872"}
EPOCH = 2026.0


def gaia_centre(field):
    """Gaia DR3 position of the star propagated to 2026.0 (anonymous TAP query)."""
    from astropy.coordinates import SkyCoord
    from astropy.time import Time
    import astropy.units as u
    import csv as _csv
    import io as _io
    import requests
    sid = int(GAIA_NAMES[field].split()[-1])
    q = (f"SELECT source_id,ra,dec,pmra,pmdec,parallax,ref_epoch,phot_g_mean_mag "
         f"FROM gaiadr3.gaia_source WHERE source_id={sid}")
    # plain requests (certifi) instead of astroquery: the system python here fails the ESA TLS chain
    resp = requests.post("https://gea.esac.esa.int/tap-server/tap/sync", timeout=60,
                         data=dict(REQUEST="doQuery", LANG="ADQL", FORMAT="csv", QUERY=q),
                         headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    t = list(_csv.DictReader(_io.StringIO(resp.text)))
    if len(t) != 1:
        raise RuntimeError(f"Gaia lookup for {field} returned {len(t)} rows")
    r = {k: (float(v) if k != "source_id" else v) for k, v in t[0].items()}
    c = SkyCoord(ra=r["ra"] * u.deg, dec=r["dec"] * u.deg, pm_ra_cosdec=r["pmra"] * u.mas / u.yr,
                 pm_dec=r["pmdec"] * u.mas / u.yr, distance=(1000.0 / r["parallax"]) * u.pc,
                 obstime=Time(float(r["ref_epoch"]), format="jyear"))
    c26 = c.apply_space_motion(new_obstime=Time(EPOCH, format="jyear"))
    return dict(source_id=sid, ra=float(c26.ra.deg), dec=float(c26.dec.deg), epoch=EPOCH,
                ra_ref=float(r["ra"]), dec_ref=float(r["dec"]), ref_epoch=float(r["ref_epoch"]),
                pmra=float(r["pmra"]), pmdec=float(r["pmdec"]), parallax=float(r["parallax"]),
                gmag=float(r["phot_g_mean_mag"]))


def centres():
    p = DATA / "field_centres.json"
    cache = json.loads(p.read_text()) if p.exists() else {}
    for f in FIELDS:
        if f not in cache:
            try:
                cache[f] = gaia_centre(f)
            except Exception as e:  # noqa: BLE001
                print(f"WARNING: Gaia lookup failed for {f}: {e}; falling back to config.py centre")
                cache[f] = dict(ra=FIELDS[f]["ra"], dec=FIELDS[f]["dec"], epoch=None, source_id=None)
    p.write_text(json.dumps(cache, indent=1))
    return cache


def run(field, cen):
    DATA.mkdir(exist_ok=True)
    ra, dec = cen["ra"], cen["dec"]
    print(f"\n=== {field} ({FIELDS[field]['name']}) centre used: RA {ra:.7f} Dec {dec:.7f} "
          f"(epoch {cen.get('epoch')}, Gaia {cen.get('source_id')}) ===")
    tab, info = query_exposures(ra, dec)
    print(f"SIA rows: {info['n_raw']} (dr1 {info['n_dr1']}, qr3 {info['n_qr3']} after dedup); "
          f"duplicates removed (same obs_id+detector in several releases): {info['n_duplicates']} "
          f"{info['dup_pairs']}")
    with ThreadPoolExecutor(12) as ex:
        hdrs = list(ex.map(read_image_header, list(tab["s3_key"])))
    rows = []
    for r, h in zip(tab, hdrs):
        x, y, on = target_pixel(h, ra, dec)
        det_hdr = int(h["DETECTOR"])
        assert det_hdr == int(r["detector"]) and h["OBSID"] == r["obs_id"], (r["obs_id"], det_hdr)
        rows.append(dict(obs_id=r["obs_id"], detector=int(r["detector"]), release=r["release"],
                         s3_key=r["s3_key"], t_min=float(r["t_min"]), t_max=float(r["t_max"]),
                         mjd_mid=float(h["MJD-AVG"]), target_x=round(x, 3), target_y=round(y, 3),
                         on_detector=on))
    visit = assign_visits([r["mjd_mid"] for r in rows])
    for r, v in zip(rows, visit):
        r["visit"] = int(v)
        r["cutout_path"] = str((CUTOUT_DIR / field / f"{r['obs_id']}_D{r['detector']}.fits").relative_to(DATA.parent)) if r["on_detector"] else ""
    rows.sort(key=lambda r: (r["mjd_mid"], r["detector"]))
    cols = ["obs_id", "detector", "release", "s3_key", "t_min", "t_max", "mjd_mid", "visit",
            "target_x", "target_y", "on_detector", "cutout_path"]
    out = DATA / f"index_{field}.csv"
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    n_off = sum(not r["on_detector"] for r in rows)
    print(f"rows: {len(rows)}   off-detector (header WCS): {n_off}   on-detector: {len(rows) - n_off}")
    # SIA footprint says the point is inside the polygon; header WCS disagreement = off-detector.
    print(f"wrote {out}")
    print("visit  n_rows  n_on  MJD range              dates                    per-detector (on-detector) D1..D6")
    from astropy.time import Time
    for v in sorted(set(visit)):
        vr = [r for r in rows if r["visit"] == v]
        on = [r for r in vr if r["on_detector"]]
        m0, m1 = min(r["mjd_mid"] for r in vr), max(r["mjd_mid"] for r in vr)
        cnt = Counter(r["detector"] for r in on)
        d0, d1 = Time(m0, format="mjd").iso[:10], Time(m1, format="mjd").iso[:10]
        print(f"{v:>5}  {len(vr):>6}  {len(on):>4}  {m0:.3f}-{m1:.3f}  {d0}..{d1}  "
              + " ".join(f"D{d}:{cnt.get(d, 0)}" for d in range(1, 7))
              + "   releases " + ",".join(f"{k}:{n}" for k, n in sorted(Counter(r['release'] for r in vr).items())))
    # detector x visit counts for all rows (incl. off-detector) for reference
    off = Counter((r["visit"], r["detector"]) for r in rows if not r["on_detector"])
    if off:
        print("off-detector (visit,det):", dict(sorted(off.items())))
    ov = [r for r in rows if r["release"] == "qr3" and r["mjd_mid"] < 61100]
    print(f"qr3 exposures inside the dr1 time range (MJD < 61100 is not expected): {len(ov)}")
    return rows


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", choices=["epsindi", "barnard", "all"], default="all")
    a = ap.parse_args()
    cen = centres()
    for f, c in cen.items():
        print(f"centre {f}: RA {c['ra']:.7f} Dec {c['dec']:.7f} epoch {c.get('epoch')} "
              f"(config.py: {FIELDS[f]['ra']}, {FIELDS[f]['dec']})")
    for f in (FIELDS if a.field == "all" else [a.field]):
        run(f, cen[f])
