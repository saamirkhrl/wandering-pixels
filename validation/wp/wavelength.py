"""Per-pixel wavelength for SPHEREx detectors.

Primary (science grade): the Spectral WCS calibration files on the public S3 bucket,
    <release>/spectral_wcs/cal-swcs-<ver>/<det>/spectral_wcs_D<det>_spx_cal-swcs-<ver>.fits
with extensions CWAVE (central wavelength, um) and CBAND (bandwidth, um), both 2040x2040,
indexed [y, x] with 0-based numpy indices (FITS pixel (x+1, y+1)). These are per detector,
NOT per exposure.

Secondary (visualization grade): the WCS-WAVE binary table carried in every Level 2 file.
Layout (verified against real files):
    X, Y   : ints, 1-BASED FITS pixel coordinates, e.g. D2 (1, 205, 409, ..., 2040). The grid
             differs per detector (D1,D6 9x9; D2,D5 11x11; D3 9(x)x14(y); D4 13x20; Y nodes
             140/141 (D3) and 1800/1801 (D4) are adjacent, i.e. a step in the lookup).
    VALUES : numpy shape (1, ny, nx, 2) = [row, iy, ix, k], k=0 wavelength um, k=1 bandwidth um
The table node values equal CWAVE/CBAND at the node pixels exactly; between nodes it is
bilinear (the file headers state max wavelength error 0.16 um, 99th percentile 0.0007 um).
We interpolate the table ourselves (astropy WCS(key='W') segfaults on this platform).

Pixel convention used by every function here: 0-based detector pixel (x = column, y = row).
cal_lambda uses the NEAREST pixel (round half to even, clipped to the array); wcswave_lambda
is a continuous bilinear interpolation.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache

import numpy as np
import requests
from astropy.io import fits

from .config import DATA, S3_HTTPS, USER_AGENT

CAL_DIR = DATA / "cal"
NPIX = 2040
_HDR = {"User-Agent": USER_AGENT}
_RELEASE_ALIASES = {"dr1": "dr1", "qr3": "qr3"}


def _norm_release(release: str) -> str:
    r = str(release).strip().lower()
    return _RELEASE_ALIASES.get(r, r)


def _list_keys(prefix: str) -> list[str]:
    out, token = [], None
    while True:
        params = {"list-type": "2", "prefix": prefix}
        if token:
            params["continuation-token"] = token
        r = requests.get(S3_HTTPS + "/", params=params, headers=_HDR, timeout=60)
        r.raise_for_status()
        out += re.findall(r"<Key>(.*?)</Key>", r.text)
        m = re.search(r"<NextContinuationToken>(.*?)</NextContinuationToken>", r.text)
        if not m:
            return out
        token = m.group(1)


@lru_cache(maxsize=None)
def cal_key(release: str, detector: int) -> str:
    """S3 key of the spectral WCS calibration file for this release and detector.
    If several versions exist the lexicographically last one is used."""
    rel = _norm_release(release)
    keys = [k for k in _list_keys(f"{rel}/spectral_wcs/") if k.endswith(f"_D{int(detector)}_spx_" + k.split("_spx_")[-1])
            and f"/{int(detector)}/" in k]
    if not keys:
        raise FileNotFoundError(f"no spectral_wcs file for {rel} D{detector}")
    return sorted(keys)[-1]


@lru_cache(maxsize=None)
def _etag(key: str) -> str:
    r = requests.head(f"{S3_HTTPS}/{key}", headers=_HDR, timeout=60)
    r.raise_for_status()
    return r.headers["ETag"].strip('"')


def cal_path(release: str, detector: int):
    """Local cached path of the calibration file (download if needed). Cache name uses the
    ETag, so identical files published under dr1 and qr3 are stored once."""
    key = cal_key(release, detector)
    CAL_DIR.mkdir(parents=True, exist_ok=True)
    p = CAL_DIR / f"swcs_D{int(detector)}_{_etag(key)[:12]}.fits"
    if not p.exists() or p.stat().st_size < 1_000_000:
        tmp = p.with_suffix(".part")
        with requests.get(f"{S3_HTTPS}/{key}", headers=_HDR, stream=True, timeout=120) as r:
            r.raise_for_status()
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
        tmp.replace(p)
    return p


@lru_cache(maxsize=12)
def _load_cal(path: str):
    with fits.open(path, memmap=False) as h:
        return (np.asarray(h["CWAVE"].data, dtype=np.float32),
                np.asarray(h["CBAND"].data, dtype=np.float32),
                np.array(h["WCS-WAVE"].data["VALUES"][0], dtype=np.float64),
                np.array(h["WCS-WAVE"].data["X"][0]), np.array(h["WCS-WAVE"].data["Y"][0]))


def cal_arrays(release: str, detector: int):
    """(CWAVE, CBAND) 2040x2040 arrays indexed [y, x]."""
    c = _load_cal(str(cal_path(release, detector)))
    return c[0], c[1]


def cal_table(release: str, detector: int) -> dict:
    """The WCS-WAVE table stored inside the calibration file, as a dict like table_from()."""
    c = _load_cal(str(cal_path(release, detector)))
    return table_from({"values": c[2].reshape(len(c[4]), len(c[3]), 2), "x": c[3].astype(float), "y": c[4].astype(float)})


def cal_version(release: str, detector: int) -> str:
    """Version tag, e.g. 'cal-swcs-v5-2026-191', parsed from the S3 key."""
    m = re.search(r"(cal-swcs-[^/]+)/", cal_key(release, detector))
    return m.group(1) if m else cal_key(release, detector)


def cal_lambda(release, detector, x, y):
    """Science-grade (cwave_um, cband_um) at 0-based detector pixel(s) x, y (array or scalar).
    Nearest-pixel lookup in CWAVE/CBAND. NaN where the pixel is outside the array."""
    cw, cb = cal_arrays(release, detector)
    xa, ya = np.broadcast_arrays(np.asarray(x, float), np.asarray(y, float))
    xi = np.rint(xa).astype(int)
    yi = np.rint(ya).astype(int)
    ok = (xi >= 0) & (xi < NPIX) & (yi >= 0) & (yi < NPIX)
    xi = np.clip(xi, 0, NPIX - 1)
    yi = np.clip(yi, 0, NPIX - 1)
    w = np.where(ok, cw[yi, xi], np.nan).astype(float)
    b = np.where(ok, cb[yi, xi], np.nan).astype(float)
    return (w, b) if w.ndim else (float(w), float(b))


def table_from(src) -> dict:
    """Normalise a WCS-WAVE table (BinTableHDU, FITS_rec, or an HDUList-like with 'WCS-WAVE')
    into {'values': (ny,nx,2) float64 [iy, ix, k], 'x': (nx,), 'y': (ny,)}."""
    if isinstance(src, dict):
        return src
    if hasattr(src, "__getitem__") and not hasattr(src, "columns") and not hasattr(src, "data"):
        src = src["WCS-WAVE"]
    d = src.data if hasattr(src, "data") else src
    x = np.array(d["X"][0], float)
    y = np.array(d["Y"][0], float)
    v = np.array(d["VALUES"][0], dtype=np.float64).reshape(len(y), len(x), 2)
    return {"values": v, "x": x, "y": y}


def wcswave_lambda(table, x, y):
    """Visualization-grade (wave_um, band_um) from our own bilinear interpolation of the
    WCS-WAVE table at 0-based detector pixel(s) x, y. Table X/Y are 1-based FITS pixel
    coordinates, so the lookup coordinate is (x + 1, y + 1). Coordinates are clamped to the
    table range [1, 2040]."""
    t = table_from(table)
    gx, gy, v = t["x"], t["y"], t["values"]
    xa, ya = np.broadcast_arrays(np.asarray(x, float) + 1.0, np.asarray(y, float) + 1.0)
    xa = np.clip(xa, gx[0], gx[-1])
    ya = np.clip(ya, gy[0], gy[-1])
    ix = np.clip(np.searchsorted(gx, xa, side="right") - 1, 0, len(gx) - 2)
    iy = np.clip(np.searchsorted(gy, ya, side="right") - 1, 0, len(gy) - 2)
    fx = (xa - gx[ix]) / (gx[ix + 1] - gx[ix])
    fy = (ya - gy[iy]) / (gy[iy + 1] - gy[iy])
    out = []
    for k in (0, 1):
        val = (v[iy, ix, k] * (1 - fx) * (1 - fy) + v[iy, ix + 1, k] * fx * (1 - fy)
               + v[iy + 1, ix, k] * (1 - fx) * fy + v[iy + 1, ix + 1, k] * fx * fy)
        out.append(val)
    w, b = out
    return (w, b) if np.ndim(w) else (float(w), float(b))


def compare_sources(release, detector, x, y, table=None):
    """Difference WCS-WAVE minus calibration at pixels x, y (0-based). If table is None the
    table stored in the calibration file is used (identical to the Level 2 one if the
    tables agree; check with tables_equal). Returns dict of arrays (um)."""
    if table is None:
        table = cal_table(release, detector)
    cw, cb = cal_lambda(release, detector, x, y)
    ww, wb = wcswave_lambda(table, x, y)
    return {"cal_wave": cw, "cal_band": cb, "tab_wave": ww, "tab_band": wb,
            "dwave": ww - cw, "dband": wb - cb}


def tables_equal(t1, t2) -> bool:
    a, b = table_from(t1), table_from(t2)
    return a["values"].shape == b["values"].shape and bool(np.array_equal(a["values"], b["values"]) and np.array_equal(a["x"], b["x"])
                and np.array_equal(a["y"], b["y"]))


def robust_sigma(a) -> float:
    a = np.asarray(a, float)
    a = a[np.isfinite(a)]
    if a.size == 0:
        return float("nan")
    return float(1.4826 * np.median(np.abs(a - np.median(a))))


def cal_versions_summary() -> dict:
    """For each release in {dr1, qr3} and detector 1..6: key, version tag, ETag."""
    out = {}
    for rel in ("dr1", "qr3"):
        for d in range(1, 7):
            k = cal_key(rel, d)
            out[f"{rel}_D{d}"] = {"key": k, "version": cal_version(rel, d), "etag": _etag(k)}
    return out


if __name__ == "__main__":
    print(json.dumps(cal_versions_summary(), indent=1))
