"""SPHEREx exposure discovery via IRSA SIA2, dedup across releases, visit clustering."""
import csv
import io
import json
import re

import numpy as np
import requests
from astropy.table import Table

from .config import USER_AGENT

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
RELEASE_RANK = {"dr1": 0, "qr3": 1}   # higher = later processing, wins in dedup


def query_exposures(ra, dec, collections=("spherex_dr1", "spherex_qr3"), radius=0.001):
    """Return (Table, info). Columns: obs_id, detector, release, s3_key, t_min, t_max, mjd_mid.

    info: dict(n_raw, n_duplicates, dup_obs, winners) describing dedup (same obs_id+detector
    in both releases keeps qr3).
    """
    params = [("COLLECTION", c) for c in collections]
    params += [("POS", f"CIRCLE {ra} {dec} {radius}"), ("RESPONSEFORMAT", "CSV"), ("MAXREC", "5000")]
    r = requests.get(SIA_URL, params=params, headers={"User-Agent": USER_AGENT}, timeout=120)
    r.raise_for_status()
    raw = list(csv.DictReader(io.StringIO(r.text)))
    rows = {}
    n_dup = 0
    dup_pairs = []
    for row in raw:
        if str(row["dataproduct_subtype"]) not in ("science",):
            continue
        det = int(re.search(r"D(\d)", str(row["energy_bandpassname"])).group(1))
        rel = str(row["obs_collection"]).replace("spherex_", "")
        # cloud_access JSON is unquoted CSV with commas, so derive the S3 key from access_url
        # (IBE path == S3 key after the /ibe/data/spherex/ prefix).
        key = str(row["access_url"]).split("/ibe/data/spherex/", 1)[1]
        tmin, tmax = float(row["t_min"]), float(row["t_max"])
        rec = dict(obs_id=str(row["obs_id"]), detector=det, release=rel, s3_key=key,
                   t_min=tmin, t_max=tmax, mjd_mid=0.5 * (tmin + tmax))
        k = (rec["obs_id"], det)
        if k in rows:
            n_dup += 1
            old = rows[k]
            dup_pairs.append((k, old["release"], rel))
            if RELEASE_RANK.get(rel, -1) > RELEASE_RANK.get(old["release"], -1):
                rows[k] = rec
        else:
            rows[k] = rec
    recs = sorted(rows.values(), key=lambda d: (d["t_min"], d["detector"]))
    names = ["obs_id", "detector", "release", "s3_key", "t_min", "t_max", "mjd_mid"]
    tab = Table(rows=[[d[n] for n in names] for d in recs], names=names)
    win = {}
    for _, o, n in dup_pairs:
        win[(o, n)] = win.get((o, n), 0) + 1
    info = dict(n_raw=len(raw), n_duplicates=n_dup, dup_pairs=win,
                n_dr1=int(np.sum(tab["release"] == "dr1")), n_qr3=int(np.sum(tab["release"] == "qr3")))
    return tab, info


def assign_visits(mjd, gap=20.0):
    """Cluster by time gaps > gap days. Returns int array of visit index 0..N-1 in time order."""
    mjd = np.asarray(mjd, float)
    order = np.argsort(mjd)
    visit = np.zeros(len(mjd), int)
    v = 0
    for i in range(1, len(order)):
        if mjd[order[i]] - mjd[order[i - 1]] > gap:
            v += 1
        visit[order[i]] = v
    return visit


def pair_class(dt_days):
    d = abs(float(dt_days))
    if d < 20:
        return "same_visit"
    if 120 <= d <= 240:
        return "6mo"
    if 300 <= d <= 430:
        return "12mo"
    if 480 <= d <= 620:
        return "18mo"
    return "other"
