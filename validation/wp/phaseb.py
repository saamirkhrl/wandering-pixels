"""Phase B shared definitions: common grid, star sample, visit pairs, spectral model.

These implement the choices fixed in docs/method.md ("Choices fixed before any phase B result").
Every phase B script must import them from here rather than redefine them.
"""
from __future__ import annotations

import json

import numpy as np
import requests
from astropy.table import Table
from astropy.wcs import WCS

from .config import DATA, USER_AGENT
from .gaia import gaia_path
from .registration import star_quality

PHASEB = DATA / "phaseb"

# visit pairs per field: (visit_A, visit_B, class); A is the earlier visit
VISIT_PAIRS = {
    "barnard": [(0, 2, "6mo"), (2, 4, "6mo"), (0, 4, "12mo")],
    "epsindi": [(0, 1, "6mo"), (1, 2, "6mo"), (2, 3, "6mo"), (0, 2, "12mo"), (1, 3, "12mo"), (0, 3, "18mo")],
}

GRID_N = {6.15: 200, 3.075: 400}
APER_R = 2.0            # aperture radius, grid pixels of 6.15 arcsec (scale with grid)
ANN_IN, ANN_OUT = 4.0, 7.0
EDGE_GRID_PX = 8        # star must be >= 8 grid pixels (6.15") from the grid edge
WINDOW_BW = 2.5         # spectral window half-width in units of local bandwidth
CLIP_SIGMA = 4.0
MIN_SAMPLES = 3
BRIGHT_G = (12.0, 13.5)  # stars used for the dipole metric
BKG_G_MASK = 18.0        # background pixels must be > 3 px from any Gaia source brighter than this


def field_centre(field: str) -> tuple[float, float]:
    d = json.loads((DATA / "field_centres.json").read_text())
    c = d[field]
    ra = c.get("ra", c.get("ra_2026"))
    dec = c.get("dec", c.get("dec_2026"))
    return float(ra), float(dec)


def grid_wcs(field: str, pixscale_arcsec: float = 6.15) -> tuple[WCS, tuple[int, int]]:
    """North-up TAN grid centred on the field centre. Returns (wcs, (ny, nx)). 0-based pixels."""
    n = GRID_N[pixscale_arcsec]
    ra, dec = field_centre(field)
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]   # FITS 1-based: centre of the grid
    s = pixscale_arcsec / 3600.0
    w.wcs.cdelt = [-s, s]
    w.wcs.cunit = ["deg", "deg"]
    return w, (n, n)


def _variable_flags(field: str, source_ids) -> dict:
    """Gaia DR3 phot_variable_flag for the given ids (cached)."""
    cache = DATA / f"gaia_varflag_{field}.json"
    have = json.loads(cache.read_text()) if cache.exists() else {}
    need = [int(s) for s in source_ids if str(int(s)) not in have]
    url = "https://gea.esac.esa.int/tap-server/tap/sync"
    for i in range(0, len(need), 400):
        chunk = need[i:i + 400]
        q = ("SELECT source_id, phot_variable_flag FROM gaiadr3.gaia_source WHERE source_id IN ("
             + ",".join(str(s) for s in chunk) + ")")
        r = requests.post(url, data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": q},
                          headers={"User-Agent": USER_AGENT}, timeout=300)
        r.raise_for_status()
        for line in r.text.strip().splitlines()[1:]:
            sid, flag = line.split(",", 1)
            have[sid.strip()] = flag.strip().strip('"')
    cache.write_text(json.dumps(have))
    return have


def phaseb_stars(field: str, mjd_ref: float, pixscale_arcsec: float = 6.15) -> Table:
    """Static-star sample (pre-registered). Adds columns x_grid, y_grid (at mjd_ref), variable.

    Rows: Gaia stars passing G window, RUWE, has_pm, isolation, not VARIABLE, inside the grid by
    EDGE_GRID_PX (scaled to the grid). Per-exposure flag rejection is applied by each product.
    """
    g = Table.read(gaia_path(field))
    q = star_quality(g, mjd_ref)
    keep = q["g_window"] & q["ruwe"] & q["has_pm"] & q["isolated"]
    s = g[keep]
    from .gaia import propagate
    ra, dec, _ = propagate(s, mjd_ref)
    w, (ny, nx) = grid_wcs(field, pixscale_arcsec)
    x, y = w.world_to_pixel_values(ra, dec)
    edge = EDGE_GRID_PX * (6.15 / pixscale_arcsec)
    inside = (x >= edge) & (x <= nx - 1 - edge) & (y >= edge) & (y <= ny - 1 - edge)
    s = s[inside]
    s["x_grid"], s["y_grid"] = x[inside], y[inside]
    flags = _variable_flags(field, s["source_id"])
    s["variable"] = np.array([flags.get(str(int(i)), "") == "VARIABLE" for i in s["source_id"]])
    counts = {"quality_and_isolation": int(keep.sum()), "inside_grid": int(inside.sum()),
              "variable": int(s["variable"].sum())}
    s = s[~s["variable"]]
    counts["final"] = len(s)
    s.meta["cut_counts"] = counts
    return s


def spec_model(lam, val, var, w0, b0, halfwidth_bw: float = WINDOW_BW):
    """Pre-registered local spectral model, vectorised over the last axis.

    lam, val, var: arrays (n_samples, ...) with NaN for missing samples. w0, b0: evaluation
    wavelength and local bandwidth, broadcastable to (...). Returns (value, variance, n_used),
    NaN where fewer than MIN_SAMPLES samples are in the window or w0 is not bracketed
    (no extrapolation). Model: variance-weighted straight line in (lam - w0); the single worst sample is dropped
    if beyond 4 sigma and the line refitted.
    """
    lam = np.asarray(lam, float)
    val = np.asarray(val, float)
    var = np.asarray(var, float)
    x = lam - w0
    ok = np.isfinite(x) & np.isfinite(val) & np.isfinite(var) & (var > 0) & (np.abs(x) <= halfwidth_bw * b0)

    def fit(ok):
        wt = np.where(ok, 1.0 / np.where(var > 0, var, np.inf), 0.0)
        xx = np.where(ok, x, 0.0)
        vv = np.where(ok, val, 0.0)
        S, Sx, Sxx = wt.sum(0), (wt * xx).sum(0), (wt * xx * xx).sum(0)
        Sy, Sxy = (wt * vv).sum(0), (wt * xx * vv).sum(0)
        D = S * Sxx - Sx * Sx
        with np.errstate(invalid="ignore", divide="ignore"):
            a = (Sxx * Sy - Sx * Sxy) / D       # intercept = value at w0
            b = (S * Sxy - Sx * Sy) / D
            va = Sxx / D
        return a, b, va

    a, b, va = fit(ok)
    with np.errstate(invalid="ignore"):
        r = np.abs(val - (a + b * x)) / np.sqrt(var)
    # clip only the single worst sample per position if it is beyond CLIP_SIGMA (a full clip
    # pass from a fit pulled by one outlier can reject every sample)
    r = np.where(ok, r, -np.inf)
    worst = np.argmax(r, axis=0)
    rmax = np.take_along_axis(r, worst[None, ...], 0)[0]
    drop = np.zeros_like(ok)
    np.put_along_axis(drop, worst[None, ...], (rmax > CLIP_SIGMA)[None, ...], 0)
    ok2 = ok & ~drop
    a, b, va = fit(ok2)
    n = ok2.sum(0)
    bracket = np.any(ok2 & (x <= 0), 0) & np.any(ok2 & (x >= 0), 0)
    good = (n >= MIN_SAMPLES) & bracket & np.isfinite(a) & (va > 0)
    return np.where(good, a, np.nan), np.where(good, va, np.nan), n
