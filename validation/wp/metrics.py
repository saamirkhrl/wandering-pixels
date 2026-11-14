"""Phase B metrics (docs/method.md, 'Choices fixed before any phase B result', item 8).

For any subset of comparison rows (a dict-like / astropy Table with columns F_A, F_B, var_A,
var_B, bp_rp, source_id):
  * z = (F_A - F_B) / sqrt(var_A + var_B); robust width = 1.4826 * MAD(z); median z.
  * f = (F_A - F_B) / (0.5 (F_A + F_B)); robust scatter (1.4826 MAD) and median, in percent.
  * slope of f vs BP-RP: per-star median f first (every star counts once), then a straight-line
    least-squares fit with iterative 3-sigma clipping (sigma = 1.4826 MAD of the residuals, up to
    5 passes). Error = standard deviation of the slope over 1000 bootstrap resamples of STARS
    (fixed seed), each resample repeating the full clipped fit.
  * "clean" verdict as pre-registered: width < 1.5 and |slope| < 2 sigma.
"""
from __future__ import annotations

import numpy as np

N_BOOT = 1000
BOOT_SEED = 20261114
CLEAN_WIDTH = 1.5
CLEAN_SIGMA = 2.0
CLIP_SIGMA = 3.0
CLIP_PASSES = 5


def mad_sigma(a) -> float:
    a = np.asarray(a, float)
    a = a[np.isfinite(a)]
    if a.size == 0:
        return float("nan")
    return float(1.4826 * np.median(np.abs(a - np.median(a))))


def z_values(F_A, F_B, var_A, var_B):
    F_A, F_B = np.asarray(F_A, float), np.asarray(F_B, float)
    v = np.asarray(var_A, float) + np.asarray(var_B, float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(v > 0, (F_A - F_B) / np.sqrt(v), np.nan)


def frac_values(F_A, F_B):
    F_A, F_B = np.asarray(F_A, float), np.asarray(F_B, float)
    m = 0.5 * (F_A + F_B)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(m > 0, (F_A - F_B) / m, np.nan)


def star_medians(ids, vals, color):
    """Per-star median of vals, with the star's colour. Returns (uniq_ids, med, color)."""
    ids, vals, color = np.asarray(ids), np.asarray(vals, float), np.asarray(color, float)
    ok = np.isfinite(vals) & np.isfinite(color)
    ids, vals, color = ids[ok], vals[ok], color[ok]
    if ids.size == 0:
        e = np.array([])
        return ids, e, e
    order = np.argsort(ids, kind="stable")
    ids, vals, color = ids[order], vals[order], color[order]
    u, start = np.unique(ids, return_index=True)
    parts = np.split(vals, start[1:])
    med = np.array([np.median(p) for p in parts])
    col = color[start]
    return u, med, col


def clipped_line(x, y):
    """Least-squares line with iterative 3-sigma clipping. Returns slope (nan if impossible)."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    m = np.ones(x.size, bool)
    slope = np.nan
    for _ in range(CLIP_PASSES):
        if m.sum() < 3 or np.ptp(x[m]) == 0:
            return np.nan
        xm, ym = x[m].mean(), y[m].mean()
        slope = np.sum((x[m] - xm) * (y[m] - ym)) / np.sum((x[m] - xm) ** 2)
        icpt = ym - slope * xm
        r = y - (icpt + slope * x)
        s = mad_sigma(r[m])
        if not np.isfinite(s) or s == 0:
            break
        m2 = np.abs(r) < CLIP_SIGMA * s
        if m2.sum() == m.sum() and np.all(m2 == m):
            break
        m = m2
    return float(slope)


def slope_bootstrap(color, medf, n_boot=N_BOOT, seed=BOOT_SEED):
    """(slope, err) of medf vs color. Inputs per star."""
    color, medf = np.asarray(color, float), np.asarray(medf, float)
    n = color.size
    if n < 8 or np.ptp(color) == 0:
        return float("nan"), float("nan")
    s0 = clipped_line(color, medf)
    rng = np.random.default_rng(seed)
    bs = np.empty(n_boot)
    for i in range(n_boot):
        k = rng.integers(0, n, n)
        bs[i] = clipped_line(color[k], medf[k])
    bs = bs[np.isfinite(bs)]
    err = float(np.std(bs, ddof=1)) if bs.size > 10 else float("nan")
    return s0, err


def subset_metrics(sub, boot=True) -> dict:
    """All metrics for a subset of rows. sub: Table / dict of arrays."""
    F_A, F_B = np.asarray(sub["F_A"], float), np.asarray(sub["F_B"], float)
    z = z_values(F_A, F_B, sub["var_A"], sub["var_B"])
    f = frac_values(F_A, F_B)
    ids = np.asarray(sub["source_id"])
    ok = np.isfinite(z)
    out = {
        "n": int(ok.sum()),
        "n_stars": int(np.unique(ids[ok]).size),
        "z_median": float(np.median(z[ok])) if ok.any() else float("nan"),
        "z_width": mad_sigma(z),
    }
    fok = np.isfinite(f)
    out["f_median_pct"] = float(100 * np.median(f[fok])) if fok.any() else float("nan")
    out["f_scatter_pct"] = 100 * mad_sigma(f)
    out["slope_pct_per_mag"] = out["slope_err"] = out["slope_sigma"] = float("nan")
    out["color_min"] = out["color_max"] = float("nan")
    out["n_stars_slope"] = 0
    if boot:
        u, med, col = star_medians(ids, 100 * f, sub["bp_rp"])
        out["n_stars_slope"] = int(u.size)
        if u.size:
            out["color_min"], out["color_max"] = float(col.min()), float(col.max())
        s, e = slope_bootstrap(col, med)
        out["slope_pct_per_mag"], out["slope_err"] = s, e
        out["slope_sigma"] = s / e if np.isfinite(e) and e > 0 else float("nan")
    w, ss = out["z_width"], out["slope_sigma"]
    out["clean"] = bool(np.isfinite(w) and np.isfinite(ss) and w < CLEAN_WIDTH and abs(ss) < CLEAN_SIGMA)
    return out
