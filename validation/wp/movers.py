"""Known movers: predicted positions, a Gaussian centroid, a wings-only position fit and helpers.

Conventions are those of wp/registration.py and wp/m2ref.py: pixels are 0-based, data[y, x],
pixel (i, j) covers [i-0.5, i+0.5]; R = IMAGE - ZODI in MJy/sr. Sky offsets are measured minus
predicted, RA* = dRA cos(dec), in arcsec.

Literature (cited in outputs):
  Barnard's Star   Gaia DR3 4472832130942575872 (Gaia Collaboration 2023, A&A 674, A1).
  Eps Indi B       Gaia DR3 6412596012146801152 (unresolved Ba+Bb) and Chen et al. 2022
                   (AJ 163, 288; arXiv:2205.08077): system pm (3987.41, -2505.35) mas/yr,
                   parallax 274.99 +/- 0.43 mas; Ba-Bb orbit P 11.02 yr, a 0.66 arcsec.
  WISE 0855-0714   Luhman & Esplin 2016 (arXiv:1605.06655), reference MJD 57484.38.
"""
from __future__ import annotations

import csv
import warnings
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clip, sigma_clipped_stats
from astropy.wcs import WCS, FITSFixedWarning
from scipy.optimize import least_squares

from . import registration as reg
from .gaia import JULIAN_YEAR_D, MAS2RAD, earth_bary_au

GAIA_MJD = 57388.5
PIXEL_ARCSEC = 6.15

# ra, dec (deg) at ref_mjd; pmra includes cos(dec), mas/yr; parallax mas
TARGETS = {
    "barnard": dict(name="Barnard's Star", ra=269.44850252543836, dec=4.739420051112412, ref_mjd=GAIA_MJD,
                    pmra=-801.551, pmdec=10362.394, parallax=546.976,
                    cite="Gaia DR3 4472832130942575872"),
    "epsindib_gaia": dict(name="Eps Indi B (Gaia DR3)", ra=331.07645259656397, dec=-56.79381206688221,
                          ref_mjd=GAIA_MJD, pmra=3981.977, pmdec=-2466.832, parallax=270.658,
                          cite="Gaia DR3 6412596012146801152"),
    # Chen et al. 2022: same 2016.0 position, system proper motion and parallax from the orbit fit
    "epsindib_chen": dict(name="Eps Indi B (Chen 2022 pm)", ra=331.07645259656397, dec=-56.79381206688221,
                          ref_mjd=GAIA_MJD, pmra=3987.41, pmdec=-2505.35, parallax=274.99,
                          cite="Chen et al. 2022 AJ 163 288, positions from Gaia DR3 at 2016.0"),
    # Luhman & Esplin 2016: pm in arcsec/yr converted to mas/yr
    "wise0855": dict(name="WISE 0855-0714", ra=133.7818300, dec=-7.2440063, ref_mjd=57484.38,
                     pmra=-8118.0, pmdec=680.0, parallax=449.0,
                     cite="Luhman & Esplin 2016 arXiv:1605.06655"),
}


def predict(tg: dict, mjd, parallax: bool = True):
    """Apparent RA, Dec (deg) of a single source at `mjd` (scalar or array).

    Same model as wp.gaia.propagate: u = r0 + dt (pmra p + pmdec q) - plx E(t), normalised, with
    dt = (mjd - ref_mjd) / 365.25 yr and E the Earth's barycentric position (au). For
    ref_mjd = GAIA_MJD this is wp.gaia.propagate (checked by check_against_propagate)."""
    mjd = np.atleast_1d(np.asarray(mjd, float))
    ra0, de0 = np.deg2rad(tg["ra"]), np.deg2rad(tg["dec"])
    ca, sa, cd, sd = np.cos(ra0), np.sin(ra0), np.cos(de0), np.sin(de0)
    r = np.array([cd * ca, cd * sa, sd])
    p = np.array([-sa, ca, 0.0])
    q = np.array([-sd * ca, -sd * sa, cd])
    dt = (mjd - tg["ref_mjd"]) / JULIAN_YEAR_D
    u = r[None, :] + dt[:, None] * (tg["pmra"] * MAS2RAD * p + tg["pmdec"] * MAS2RAD * q)[None, :]
    if parallax:
        E = np.atleast_2d(earth_bary_au(mjd))
        u = u - tg["parallax"] * MAS2RAD * E
    u /= np.linalg.norm(u, axis=1)[:, None]
    ra = np.rad2deg(np.arctan2(u[:, 1], u[:, 0])) % 360.0
    dec = np.rad2deg(np.arcsin(np.clip(u[:, 2], -1, 1)))
    return (ra, dec) if ra.size > 1 else (float(ra[0]), float(dec[0]))


def check_against_propagate(tg: dict, mjd: float) -> float:
    """max |difference| in mas against wp.gaia.propagate (valid when tg['ref_mjd'] == GAIA_MJD)."""
    from astropy.table import Table
    from .gaia import propagate
    t = Table([dict(ra=tg["ra"], dec=tg["dec"], pmra=tg["pmra"], pmdec=tg["pmdec"], parallax=tg["parallax"])])
    ra, de, _ = propagate(t, mjd)
    ra2, de2 = predict(tg, mjd)
    dra = (ra[0] - ra2) * np.cos(np.deg2rad(de2)) * 3.6e6
    dde = (de[0] - de2) * 3.6e6
    return float(max(abs(dra), abs(dde)))


def sky_offset(ra_m, dec_m, ra_p, dec_p):
    """(dRA*, dDec) arcsec, measured minus predicted."""
    dra = ((np.asarray(ra_m, float) - np.asarray(ra_p, float) + 180.0) % 360.0 - 180.0) \
        * np.cos(np.deg2rad(dec_p)) * 3600.0
    dde = (np.asarray(dec_m, float) - np.asarray(dec_p, float)) * 3600.0
    return dra, dde


def sep_arcsec(tg_a, mjd_a, tg_b, mjd_b):
    """(dRA*, dDec) arcsec of position b minus position a."""
    ra_a, de_a = predict(tg_a, mjd_a)
    ra_b, de_b = predict(tg_b, mjd_b)
    return sky_offset(ra_b, de_b, ra_a, de_a)


# ------------------------------------------------------------------ frames --------------------
def load_frame(path):
    """Read one cutout (file contract of wp.io.fetch_cutout). Returns a dict with R=IMAGE-ZODI,
    VARIANCE, FLAGS, spatial WCS, flag bit names, headers."""
    h0, h1, img, flags, fh, var, zodi = reg.read_cutout(path)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        w = WCS(h1)
    bits = reg.flag_bits(fh)
    return dict(R=img - zodi, V=var, FL=flags, wcs=w, bits=bits, rmask=reg.reject_mask(bits),
                mjd=float(h0["MJD-AVG"]), obs_id=str(h0["OBSID"]), detector=int(h0["DETECTOR"]),
                release=str(h0["RELEASE"]), x0=int(h0["X0"]), y0=int(h0["Y0"]),
                fwhm_as=float(h0.get("PSF_FWHM", 7.5)), path=str(path))


def pixel_of(fr, ra, dec):
    x, y = fr["wcs"].world_to_pixel_values(ra, dec)
    return float(x), float(y)


def sky_of(fr, x, y):
    ra, dec = fr["wcs"].pixel_to_world_values(x, y)
    return float(ra), float(dec)


def flag_summary(fr, x, y, half=2):
    """OR of raw FLAGS over the central (2*half+1)^2 pixels and the named incidence."""
    ny, nx = fr["FL"].shape
    xi, yi = int(round(x)), int(round(y))
    if not (0 <= xi < nx and 0 <= yi < ny):
        return dict(inside=False, orv=0, overflow=False, nonlinear=False, bloom=False, saturated=False, n_sat_px=0)
    sl = (slice(max(0, yi - half), yi + half + 1), slice(max(0, xi - half), xi + half + 1))
    o = int(np.bitwise_or.reduce(fr["FL"][sl].ravel()))
    b = fr["bits"]
    ov, nl, bl = bool(o >> b.get("OVERFLOW", 1) & 1), bool(o >> b.get("NONLINEAR", 15) & 1), bool(o >> b.get("BLOOM", 26) & 1)
    sat_mask = sum(1 << b.get(n, d) for n, d in (("OVERFLOW", 1), ("NONLINEAR", 15), ("BLOOM", 26)))
    reg_ = (slice(max(0, yi - 6), yi + 7), slice(max(0, xi - 6), xi + 7))
    return dict(inside=True, orv=o, overflow=ov, nonlinear=nl, bloom=bl, saturated=bool(ov or nl or bl),
                n_sat_px=int(((fr["FL"][reg_] & sat_mask) != 0).sum()))


# ------------------------------------------------------------------ Gaussian centroid ---------
def centroid_gauss(fr, x, y, fwhm_px=None, stamp_half=reg.STAMP_HALF, ann=(reg.ANN_IN, reg.ANN_OUT),
                   bkg_override=None, var_floor_frac=0.0):
    """Phase A centroid (pixel-integrated circular Gaussian, 7x7 stamp, VARIANCE weights, annulus
    background 4..8 px, phase A reject flags) of the source near (x, y). Returns dict(ok, reason,
    x, y, ex, ey, flux, eflux, sigma, chi2r, bkg, peak_snr). Fit starts at (x, y), bounds +-2 px."""
    R, V, FL = fr["R"], fr["V"], fr["FL"]
    ny, nx = R.shape
    out = dict(ok=False, reason="ok", x=np.nan, y=np.nan, ex=np.nan, ey=np.nan, flux=np.nan, eflux=np.nan,
               sigma=np.nan, chi2r=np.nan, bkg=np.nan, snr=np.nan)
    xi, yi = int(round(x)), int(round(y))
    if not (stamp_half + 1 <= xi < nx - stamp_half - 1 and stamp_half + 1 <= yi < ny - stamp_half - 1):
        out["reason"] = "edge"
        return out
    bad = ((FL & fr["rmask"]) != 0) | ~np.isfinite(R) | ~np.isfinite(V) | (V <= 0)
    ys0, ys1 = max(0, yi - 9), min(ny, yi + 10)
    xs0, xs1 = max(0, xi - 9), min(nx, xi + 10)
    yy, xx = np.mgrid[ys0:ys1, xs0:xs1]
    rr = np.hypot(xx - x, yy - y)
    am = (rr >= ann[0]) & (rr <= ann[1]) & ~bad[ys0:ys1, xs0:xs1]
    if am.sum() < 20:
        out["reason"] = "annulus_few"
        return out
    _, bkg, _ = sigma_clipped_stats(R[ys0:ys1, xs0:xs1][am], sigma=3.0, maxiters=5)
    if bkg_override is not None:
        bkg = bkg_override
    st = (slice(yi - stamp_half, yi + stamp_half + 1), slice(xi - stamp_half, xi + stamp_half + 1))
    stamp = R[st] - bkg
    vst = V[st]
    bst = bad[st]
    if bst.sum() > 0.4 * bst.size:
        out["reason"] = "masked"
        return out
    xs = np.arange(xi - stamp_half, xi + stamp_half + 1, dtype=float)
    ys = np.arange(yi - stamp_half, yi + stamp_half + 1, dtype=float)
    sig = np.where(bst, np.inf, np.sqrt(np.where(vst > 0, vst, np.nan)))
    if var_floor_frac > 0:
        sig = np.sqrt(sig ** 2 + (var_floor_frac * np.where(bst, 0, np.abs(stamp))) ** 2)
    fw = fwhm_px if fwhm_px is not None else fr["fwhm_as"] / PIXEL_ARCSEC
    s0 = max(0.35, fw / 2.3548)
    c = (slice(stamp_half - 1, stamp_half + 2),) * 2
    peak = float(np.nanmax(np.where(bst[c], -np.inf, stamp[c])))
    F0 = max(float(np.nansum(np.where(bst, 0, stamp))), peak, 1e-6)
    p0 = np.array([x, y, F0, s0, 0.0])
    lo = np.array([x - 2.0, y - 2.0, 0.0, 0.25, -np.inf])
    hi = np.array([x + 2.0, y + 2.0, np.inf, 2.5, np.inf])
    try:
        p, cov, chi2r, ok = reg.fit_gauss(stamp, sig, xs, ys, p0, (lo, hi))
    except Exception:  # noqa: BLE001
        out["reason"] = "fit_error"
        return out
    jp = np.unravel_index(int(np.nanargmax(np.where(bst[c], -np.inf, stamp[c]))), (3, 3))
    out["snr"] = peak / np.sqrt(vst[c][jp]) if vst[c][jp] > 0 else np.nan
    out.update(x=float(p[0]), y=float(p[1]), ex=float(np.sqrt(cov[0, 0])), ey=float(np.sqrt(cov[1, 1])),
               flux=float(p[2]), eflux=float(np.sqrt(cov[2, 2])), sigma=float(p[3]), chi2r=float(chi2r),
               bkg=float(bkg))
    out["ok"] = bool(ok)
    out["reason"] = "ok" if ok else "fit_failed"
    return out


# ------------------------------------------------------------------ wings-only position -------
def wings_fit(fr, x, y, r_in=2.5, r_out=6.0, sat_grow=1, knot_step=0.5, x_bound=1.5):
    """Position from the PSF wings only, with a symmetric but non-parametric profile.

    Pixels with r_in <= r < r_out (r from the predicted position) that are finite, unflagged
    (phase A reject flags) and outside the saturation mask (OVERFLOW/NONLINEAR/BLOOM grown by
    `sat_grow` px) are modelled as a circularly symmetric radial profile about a free centre
    (cx, cy): value = piecewise-linear in r with knots every `knot_step` px from r_in-0.5 to
    r_out+0.5 (the profile is solved by weighted linear least squares for every trial centre;
    the centre by Nelder-Mead on chi^2). Weights 1/(VARIANCE + (0.02 model)^2) with the 2 percent
    term taken from the data. The centre error is from the numerical curvature of chi^2 at the
    minimum, scaled by the reduced chi^2 (so it includes the model misfit). Returns
    dict(ok, reason, x, y, ex, ey, chi2r, n)."""
    from scipy.ndimage import binary_dilation
    from scipy.optimize import minimize
    R, V, FL = fr["R"], fr["V"], fr["FL"]
    ny, nx = R.shape
    out = dict(ok=False, reason="ok", x=np.nan, y=np.nan, ex=np.nan, ey=np.nan, chi2r=np.nan, n=0)
    xi, yi = int(round(x)), int(round(y))
    h = int(np.ceil(r_out + x_bound)) + 2
    if not (h <= xi < nx - h and h <= yi < ny - h):
        out["reason"] = "edge"
        return out
    sat_mask = sum(1 << fr["bits"].get(n, d) for n, d in (("OVERFLOW", 1), ("NONLINEAR", 15), ("BLOOM", 26)))
    bad = ((FL & fr["rmask"]) != 0) | ~np.isfinite(R) | ~np.isfinite(V) | (V <= 0)
    sat = (FL & sat_mask) != 0
    if sat_grow:
        sat = binary_dilation(sat, iterations=sat_grow)
    sl = (slice(yi - h, yi + h + 1), slice(xi - h, xi + h + 1))
    XX, YY = np.meshgrid(np.arange(xi - h, xi + h + 1, dtype=float), np.arange(yi - h, yi + h + 1, dtype=float))
    # fixed pixel set from the predicted position (so chi^2 is comparable between trial centres)
    r0 = np.hypot(XX - x, YY - y)
    use = (r0 >= r_in) & (r0 < r_out) & ~bad[sl] & ~sat[sl]
    if use.sum() < 25:
        out["reason"] = "few_pixels"
        return out
    d = R[sl][use]
    v = V[sl][use]
    xu, yu = XX[use], YY[use]
    knots = np.arange(r_in - 0.5, r_out + 0.5 + 1e-9, knot_step)
    w = 1.0 / (v + (0.02 * np.abs(d)) ** 2)

    def solve(cx, cy):
        r = np.hypot(xu - cx, yu - cy)
        k = np.clip(np.searchsorted(knots, r, side="right") - 1, 0, len(knots) - 2)
        f = np.clip((r - knots[k]) / knots_step_arr[k], 0.0, 1.0)
        A = np.zeros((len(r), len(knots)))
        A[np.arange(len(r)), k] = 1 - f
        A[np.arange(len(r)), k + 1] = f
        Aw = A * np.sqrt(w)[:, None]
        # tiny second-difference regulariser keeps empty knots finite
        reg_ = np.zeros((len(knots) - 2, len(knots)))
        for i in range(len(knots) - 2):
            reg_[i, i:i + 3] = [1, -2, 1]
        reg_ *= 1e-3 * np.sqrt(np.median(w)) * (np.abs(d).max())
        Mx = np.vstack([Aw, reg_])
        yv = np.concatenate([d * np.sqrt(w), np.zeros(len(reg_))])
        coef = np.linalg.lstsq(Mx, yv, rcond=None)[0]
        res = (A @ coef - d) * np.sqrt(w)
        return float(np.sum(res ** 2))

    knots_step_arr = np.diff(knots)
    knots_step_arr = np.append(knots_step_arr, knots_step_arr[-1])
    best = None
    for dx0, dy0 in ((0, 0), (0.4, 0), (-0.4, 0), (0, 0.4), (0, -0.4)):
        res = minimize(lambda p: solve(p[0], p[1]), [x + dx0, y + dy0], method="Nelder-Mead",
                       options=dict(xatol=1e-3, fatol=1e-6, maxiter=400))
        if best is None or res.fun < best.fun:
            best = res
    cx, cy = best.x
    if abs(cx - x) > x_bound or abs(cy - y) > x_bound:
        out["reason"] = "at_bound"
        return out
    n = int(use.sum())
    nfree = n - len(knots) - 2
    chi2 = best.fun
    hs = 0.03
    f0 = solve(cx, cy)
    fxx = (solve(cx + hs, cy) - 2 * f0 + solve(cx - hs, cy)) / hs ** 2
    fyy = (solve(cx, cy + hs) - 2 * f0 + solve(cx, cy - hs)) / hs ** 2
    fxy = (solve(cx + hs, cy + hs) - solve(cx + hs, cy - hs) - solve(cx - hs, cy + hs) + solve(cx - hs, cy - hs)) / (4 * hs ** 2)
    H = 0.5 * np.array([[fxx, fxy], [fxy, fyy]])      # chi2 ~ chi2min + dp^T H dp
    chi2r = chi2 / max(nfree, 1)
    try:
        cov = np.linalg.inv(H) * max(chi2r, 1.0)
        ex, ey = float(np.sqrt(cov[0, 0])), float(np.sqrt(cov[1, 1]))
    except np.linalg.LinAlgError:
        ex = ey = np.nan
    ok = bool(np.isfinite(ex) and np.isfinite(ey) and ex > 0 and ey > 0)
    out.update(ok=ok, reason="ok" if ok else "bad_curvature", x=float(cx), y=float(cy), ex=ex, ey=ey,
               chi2r=float(chi2r), n=n)
    return out


# ------------------------------------------------------------------ helpers -------------------
def read_index(path):
    with open(path) as f:
        return list(csv.DictReader(f))


def frame_offsets(field):
    """Per-frame median WCS offset (dRA*, dDec arcsec, measured - Gaia) over the phase A reference
    stars of the field (data/reg/meas_<field>.ecsv), keyed (detector, round(MJD-AVG, 4)); the
    table's own 'frame' index is not the row of the index CSV when off-detector rows were skipped.
    Used to remove each frame's own registration offset from a target offset.
    Returns {(det, mjd4): (dra, ddec, n_stars)}."""
    from astropy.table import Table
    from .config import DATA
    t = Table.read(DATA / "reg" / f"meas_{field}.ecsv")
    fr = np.asarray(t["frame"]).astype(str)
    det = np.asarray(t["detector"], int)
    mj = np.asarray(t["mjd"], float)
    dra = np.asarray(t["dra_gauss"], float)
    dde = np.asarray(t["ddec_gauss"], float)
    out = {}
    for f in np.unique(fr):
        m = fr == f
        if m.sum() >= 5:
            i = int(np.argmax(m))
            out[(int(det[i]), round(float(mj[i]), 4))] = (float(np.median(dra[m])), float(np.median(dde[m])), int(m.sum()))
    return out


def wmean(v, e):
    v, e = np.asarray(v, float), np.asarray(e, float)
    w = 1.0 / e ** 2
    return float(np.sum(w * v) / np.sum(w)), float(1.0 / np.sqrt(np.sum(w)))


def mean_sem(v):
    v = np.asarray(v, float)
    v = v[np.isfinite(v)]
    n = len(v)
    if n == 0:
        return np.nan, np.nan, 0
    return float(np.mean(v)), float(np.std(v, ddof=1) / np.sqrt(n)) if n > 1 else np.nan, n
