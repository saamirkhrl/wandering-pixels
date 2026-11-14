"""Native-pixel forced aperture photometry at Gaia positions (phase B, product M2 and P1native).

Conventions (see docs/method.md, "Choices fixed before any phase B result"):
  * Pixels are 0-based, data[y, x], pixel (i, j) covers [i-0.5, i+0.5]; cutout pixel + (X0, Y0)
    = detector pixel.
  * R = IMAGE - ZODI, units MJy/sr. flux = sum over the aperture of overlap_weight * (R - bkg),
    i.e. MJy/sr summed over native pixels (multiply by the 6.15" pixel solid angle for MJy).
  * Aperture: circle of radius phaseb.APER_R native pixels, exact pixel overlap
    (photutils CircularAperture.to_mask(method="exact")).
  * Background (amendment 2): 3-sigma-clipped (astropy sigma_clip, sigma 3, maxiters 5, centre = median) MEDIAN of the annulus pixels with
    centre distance in [ANN_IN, ANN_OUT] native pixels, excluding non-finite pixels, pixels with a
    phase A rejection flag and SOURCE-flagged pixels (bit 21); if fewer than 10 pixels remain the
    flag exclusion is dropped (plain clipped median of the finite pixels).
  * Variance: var = sum_i w_i^2 VARIANCE_i + (sum_i w_i)^2 * var_bkg, with
    var_bkg = (pi/2) * s_ann^2 / N_ann (variance of a median of N_ann independent pixels; s_ann is
    the clipped standard deviation of the annulus pixels, so it includes real structure and
    pixel correlations are ignored).
  * Drops (reason): outside_cutout (star centre outside the cutout, not stored), edge (aperture not
    fully inside the cutout), flag5x5 (prereg rule: any phase A rejection flag, or a NaN / non-positive
    variance, in the central 5x5; flux is still recorded, `ok` is False), nan_ap (any non-finite
    image/variance, or non-positive variance, in a pixel with aperture weight > 0). `ok` = prereg
    rule, `ok_browser` = browser mask (see BROWSER_BITS); `flags5` = raw FLAGS OR over the 5x5
    (-1 for edge), ann_few (< 20 good annulus pixels).
"""
from __future__ import annotations

import warnings

import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clip
from astropy.table import Table
from astropy.wcs import WCS, FITSFixedWarning
from photutils.aperture import CircularAperture

from . import phaseb
from .gaia import propagate
from .registration import flag_bits, reject_mask
from .wavelength import cal_lambda

FLAG_HALF = 2
MIN_ANN = 10
SOURCE_BIT = 21
# amendment 1: 'browser' mask = TRANSIENT, SUR_ERROR, NONFUNC, DICHROIC, MISSING_DATA, HOT, COLD,
# PHANMISS, NONLINEAR, BLOOM, SNOWBALL (bits 0,2,6,7,9,10,11,14,15,26,27) or a NaN in the 5x5
BROWSER_BITS = (0, 2, 6, 7, 9, 10, 11, 14, 15, 26, 27)
BROWSER_MASK = sum(1 << b for b in BROWSER_BITS)
VERSION = "forced-v2"
REASONS = ("ok", "edge", "flag5x5", "nan_ap", "ann_few")


def measure_background(R, excl, nonfin, x, y):
    """Clipped-median background in the annulus. excl = flagged/SOURCE/non-finite mask, nonfin =
    non-finite mask only (fallback). Returns (bkg, s_ann, n_ann, fallback) or None."""
    ny, nx = R.shape
    r_out = int(np.ceil(phaseb.ANN_OUT)) + 1
    x0, x1 = max(0, int(round(x)) - r_out), min(nx, int(round(x)) + r_out + 1)
    y0, y1 = max(0, int(round(y)) - r_out), min(ny, int(round(y)) + r_out + 1)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    rr = np.hypot(xx - x, yy - y)
    geo = (rr >= phaseb.ANN_IN) & (rr <= phaseb.ANN_OUT)
    m = geo & ~excl[y0:y1, x0:x1]
    fallback = False
    if m.sum() < MIN_ANN:
        m = geo & ~nonfin[y0:y1, x0:x1]
        fallback = True
        if m.sum() < MIN_ANN:
            return None
    c = sigma_clip(R[y0:y1, x0:x1][m], sigma=3.0, maxiters=5)
    kept = c.data[~c.mask]
    return float(np.median(kept)), float(np.std(kept)), int(kept.size), fallback


def measure_exposure(path, stars: Table, bad_names=None) -> tuple[Table, dict]:
    """Forced photometry of all `stars` in one cutout. Returns (rows, counts).
    rows: one row per star whose centre is inside the cutout. counts: reason -> n (incl. outside_cutout)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        with fits.open(path, memmap=False) as hl:
            h0 = hl[0].header.copy()
            h1 = hl["IMAGE"].header.copy()
            img = np.asarray(hl["IMAGE"].data, float)
            flags = np.asarray(hl["FLAGS"].data, np.int64)
            fh = hl["FLAGS"].header.copy()
            var = np.asarray(hl["VARIANCE"].data, float)
            zodi = np.asarray(hl["ZODI"].data, float)
        w = WCS(h1)
    ny, nx = img.shape
    mjd = float(h0["MJD-AVG"])
    det = int(h0["DETECTOR"])
    rel = str(h0["RELEASE"])
    obs = str(h0["OBSID"])
    visit = int(h0["VISIT"])
    X0, Y0 = int(h0["X0"]), int(h0["Y0"])
    rmask = reject_mask(flag_bits(fh))
    R = img - zodi
    nonfin = ~np.isfinite(R) | ~np.isfinite(var) | (var <= 0)
    bad = ((flags & rmask) != 0) | nonfin
    excl = bad | ((flags & (1 << SOURCE_BIT)) != 0)

    ra, dec, _ = propagate(stars, mjd)
    xs, ys = w.world_to_pixel_values(ra, dec)
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)
    inside = np.isfinite(xs) & np.isfinite(ys) & (xs >= -0.5) & (xs <= nx - 0.5) & (ys >= -0.5) & (ys <= ny - 0.5)
    counts = {r: 0 for r in REASONS}
    counts["outside_cutout"] = int((~inside).sum())
    counts["browser_ok"] = 0
    counts["bkg_fallback"] = 0
    lam, bw = cal_lambda(rel, det, xs + X0, ys + Y0)
    lam, bw = np.atleast_1d(lam), np.atleast_1d(bw)
    ap_r = phaseb.APER_R
    rows = []
    for k in np.where(inside)[0]:
        x, y = xs[k], ys[k]
        flux = vr = np.nan
        reason = "ok"
        ok_b = False
        flags5 = -1
        if x - ap_r < -0.5 or x + ap_r > nx - 0.5 or y - ap_r < -0.5 or y + ap_r > ny - 0.5:
            reason = "edge"
        else:
            xi, yi = int(round(x)), int(round(y))
            s5 = (slice(yi - FLAG_HALF, yi + FLAG_HALF + 1), slice(xi - FLAG_HALF, xi + FLAG_HALF + 1))
            flags5 = int(np.bitwise_or.reduce(flags[s5].ravel()))
            nan5 = bool(nonfin[s5].any())
            ok_p = (flags5 & rmask) == 0 and not nan5
            ok_b = (flags5 & BROWSER_MASK) == 0 and not nan5
            m = CircularAperture((x, y), ap_r).to_mask(method="exact")
            bb = m.bbox
            wgt = m.data
            sl = (slice(bb.iymin, bb.iymax), slice(bb.ixmin, bb.ixmax))
            if bb.iymin < 0 or bb.ixmin < 0 or bb.iymax > ny or bb.ixmax > nx:
                reason, ok_b = "edge", False
            elif nonfin[sl][wgt > 0].any():
                reason, ok_b = "nan_ap", False
            else:
                b = measure_background(R, excl, nonfin, x, y)
                if b is None:
                    reason, ok_b = "ann_few", False
                else:
                    bkg, s_ann, n_ann, fb = b
                    counts["bkg_fallback"] += int(fb)
                    flux = float(np.sum(wgt * (R[sl] - bkg)))
                    vr = float(np.sum(wgt ** 2 * var[sl]) + wgt.sum() ** 2 * (np.pi / 2) * s_ann ** 2 / n_ann)
                    if not ok_p:
                        reason = "flag5x5"
        counts[reason] += 1
        counts["browser_ok"] += int(ok_b)
        rows.append((int(stars["source_id"][k]), obs, det, visit, mjd, x, y, float(lam[k]), float(bw[k]),
                     flux, vr, reason == "ok", ok_b, reason, flags5, x - round(x), y - round(y)))
    names = ["source_id", "obs_id", "detector", "visit", "mjd", "x", "y", "lam", "bw", "flux", "var", "ok",
             "ok_browser", "reason", "flags5", "phase_x", "phase_y"]
    dts = [np.int64, "U24", np.int16, np.int16, np.float64, np.float32, np.float32, np.float32, np.float32,
           np.float64, np.float64, bool, bool, "U14", np.int64, np.float32, np.float32]
    t = Table(rows=rows, names=names, dtype=dts) if rows else Table(names=names)
    return t, counts


def spec_model_flat(lam, val, var, w0, b0, halfwidth_bw: float = phaseb.WINDOW_BW):
    """CONTROL (M2flat): copy of phaseb.spec_model with a constant model (variance-weighted mean)
    instead of a straight line. Same window, same min samples, same bracket requirement, same single
    worst-sample clip at CLIP_SIGMA. Returns (value, variance, n_used)."""
    lam = np.asarray(lam, float)
    val = np.asarray(val, float)
    var = np.asarray(var, float)
    x = lam - w0
    ok = np.isfinite(x) & np.isfinite(val) & np.isfinite(var) & (var > 0) & (np.abs(x) <= halfwidth_bw * b0)

    def fit(ok):
        wt = np.where(ok, 1.0 / np.where(var > 0, var, np.inf), 0.0)
        S = wt.sum(0)
        Sy = (wt * np.where(ok, val, 0.0)).sum(0)
        with np.errstate(invalid="ignore", divide="ignore"):
            return Sy / S, 1.0 / S

    a, va = fit(ok)
    with np.errstate(invalid="ignore"):
        r = np.abs(val - a) / np.sqrt(var)
    r = np.where(ok, r, -np.inf)
    worst = np.argmax(r, axis=0)
    rmax = np.take_along_axis(r, worst[None, ...], 0)[0]
    drop = np.zeros_like(ok)
    np.put_along_axis(drop, worst[None, ...], (rmax > phaseb.CLIP_SIGMA)[None, ...], 0)
    ok2 = ok & ~drop
    a, va = fit(ok2)
    n = ok2.sum(0)
    bracket = np.any(ok2 & (x <= 0), 0) & np.any(ok2 & (x >= 0), 0)
    good = (n >= phaseb.MIN_SAMPLES) & bracket & np.isfinite(a) & (va > 0)
    return np.where(good, a, np.nan), np.where(good, va, np.nan), n
