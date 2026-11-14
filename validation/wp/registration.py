"""Per-cutout star centroiding against Gaia DR3 for the SPHEREx registration check.

Conventions (all load-bearing):
  * Pixel coordinates are 0-based, numpy order data[y, x], pixel (i, j) covers
    [i-0.5, i+0.5] x [j-0.5, j+0.5]. This is astropy WCS origin 0 (pixel_to_world_values).
  * Cutout pixel + (X0, Y0) = detector pixel, so pixel phase is identical in both.
  * Sky residual r = measured - Gaia-propagated: dRA* = (ra_m - ra_g) cos(dec_g), dDec = dec_m - dec_g
    (arcsec). Pixel residual is also measured - Gaia: dx = x_meas - x_gaia, dy = y_meas - y_gaia,
    where x_gaia comes from WCS world_to_pixel of the propagated Gaia position (the sign is the
    opposite of "Gaia minus measured"; scatters do not depend on it).
  * Background: R = IMAGE - ZODI, then a sigma-clipped annulus median (r = 4..8 px) per star.

Two centroid methods:
  gauss: least-squares fit of a pixel-integrated circular 2D Gaussian (erf integrals over each
         pixel) with free x, y, flux, sigma, constant background on a 7x7 stamp, weights
         1/VARIANCE; formal errors from the unscaled covariance (J^T W J)^-1.
  win:   SExtractor XWIN-style iterative Gaussian-windowed first moments, window sigma =
         PSF_FWHM / 2.355; errors from the SExtractor formula.
"""
from __future__ import annotations

import math
import warnings

import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.table import Table
from astropy.wcs import WCS, FITSFixedWarning
from scipy.optimize import least_squares
from scipy.special import erf
from scipy.spatial import cKDTree

from .gaia import propagate

VERSION = "reg-v1"

# ------------------------------------------------------------------ selection constants --
EDGE_PX = 4                     # star must be >= 4 px from every cutout edge
G_MIN, G_MAX = 12.0, 16.5       # Gaia G window (see scripts/03_registration.py for the reason)
RUWE_MAX = 1.4
ISO_RADIUS_AS = 20.0            # no other source with G < G_star + ISO_DMAG within this radius
ISO_DMAG = 3.0
BRIGHT_G = 9.0                  # no source brighter than this ...
BRIGHT_RADIUS_AS = 180.0        # ... within 3 arcmin
SNR_MIN = 10.0                  # peak-pixel S/N after background subtraction
MAX_RESID_PX = 1.5              # |measured - Gaia| sanity cut, both methods (>> expected scatter)
# Reduced chi^2 of the Gaussian fit. Deliberately loose: the PSF is not Gaussian, so chi^2r grows
# with flux (median ~10 for G~13 in the crowded Barnard field) while the astrometric scatter of
# chi^2r 20-50 and >50 stars is no worse than chi^2r < 5 (checked on 1/12 of the frames, both
# fields). A cut at 20 removed ~30% of good bright Barnard stars; 100 only removes broken fits.
CHI2R_MAX = 100.0
STAMP_HALF = 3                  # 7x7 fit stamp
FLAG_HALF = 2                   # 5x5 flag check
ANN_IN, ANN_OUT = 4.0, 8.0      # background annulus radii, px

REJECT_FLAG_NAMES = ("TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD",
                     "NONLINEAR", "PERSIST", "BLOOM", "SNOWBALL", "HALO", "SATELLITE_HALO", "STREAK")
# Documented bit numbers (used only if a FLAGS header lacks MSKN keys for a name).
DEFAULT_BITS = {"TRANSIENT": 0, "OVERFLOW": 1, "SUR_ERROR": 2, "NONFUNC": 6, "MISSING_DATA": 9,
                "HOT": 10, "COLD": 11, "NONLINEAR": 15, "PERSIST": 17, "OUTLIER": 19, "SOURCE": 21,
                "GHOST": 22, "STREAK": 25, "BLOOM": 26, "SNOWBALL": 27, "HALO": 28, "SATELLITE_HALO": 29}

CUT_ORDER = ["in_footprint", "g_window", "ruwe", "has_pm", "isolated", "flags_ok", "snr_ok",
             "fit_converged", "resid_sane"]

SQ2 = math.sqrt(2.0)
SQ2PI = math.sqrt(2.0 * math.pi)


def flag_bits(flags_header) -> dict:
    """name -> bit from MSKNnnnn keys, falling back to the documented numbers."""
    bits = {}
    for k in flags_header:
        if k.startswith("MSKN") and k[4:].isdigit():
            bits[str(flags_header[k]).strip()] = int(k[4:])
    for n, b in DEFAULT_BITS.items():
        bits.setdefault(n, b)
    return bits


def reject_mask(bits: dict) -> int:
    m = 0
    for n in REJECT_FLAG_NAMES:
        if n in bits:
            m |= 1 << bits[n]
    return m


# ------------------------------------------------------------------ star-level cuts -------
def star_quality(gaia: Table, mjd_ref: float) -> dict:
    """Frame-independent cuts, boolean arrays over the Gaia table.

    Neighbour geometry is evaluated at mjd_ref (positions propagated, which matters for the
    fast movers Eps Indi A and Barnard's Star)."""
    G = np.asarray(gaia["phot_g_mean_mag"], float)
    ra, dec, has_pm = propagate(gaia, mjd_ref)
    xyz = np.stack([np.cos(np.deg2rad(dec)) * np.cos(np.deg2rad(ra)),
                    np.cos(np.deg2rad(dec)) * np.sin(np.deg2rad(ra)), np.sin(np.deg2rad(dec))], 1)
    tree = cKDTree(xyz)
    chord = lambda arcsec: 2 * np.sin(np.deg2rad(arcsec / 3600.0) / 2)  # noqa: E731
    g_window = (G >= G_MIN) & (G <= G_MAX)
    ruwe = np.asarray(gaia["ruwe"], float)
    ruwe_ok = np.isfinite(ruwe) & (ruwe < RUWE_MAX)
    iso = np.zeros(len(G), bool)
    cand = np.where(g_window)[0]
    neigh = tree.query_ball_point(xyz[cand], chord(ISO_RADIUS_AS))
    bright_idx = np.where(G < BRIGHT_G)[0]
    near_bright = np.zeros(len(G), bool)
    if len(bright_idx):
        bt = cKDTree(xyz[bright_idx])
        d, _ = bt.query(xyz, k=1)
        near_bright = d < chord(BRIGHT_RADIUS_AS)
    for k, i in enumerate(cand):
        others = [j for j in neigh[k] if j != i]
        ok = not np.any(G[others] < G[i] + ISO_DMAG) if others else True
        iso[i] = ok and not near_bright[i]
    return {"g_window": g_window, "ruwe": ruwe_ok, "has_pm": has_pm, "isolated": iso,
            "near_bright": near_bright}


# ------------------------------------------------------------------ models -----------------
def _pix_int(c, x0, s):
    """Fraction of a 1D Gaussian (centre x0, sigma s) falling in pixels centred at c."""
    a = (c + 0.5 - x0) / (SQ2 * s)
    b = (c - 0.5 - x0) / (SQ2 * s)
    return 0.5 * (erf(a) - erf(b))


def _pix_int_derivs(c, x0, s):
    up = c + 0.5 - x0
    lo = c - 0.5 - x0
    eu = np.exp(-up * up / (2 * s * s))
    el = np.exp(-lo * lo / (2 * s * s))
    E = 0.5 * (erf(up / (SQ2 * s)) - erf(lo / (SQ2 * s)))
    dE_dx0 = -(eu - el) / (SQ2PI * s)
    dE_ds = -(up * eu - lo * el) / (SQ2PI * s * s)
    return E, dE_dx0, dE_ds


def fit_gauss(stamp, sig, xs, ys, p0, bounds):
    """Weighted LSQ fit of F*Ex*Ey + B. stamp/sig: 2D arrays (sig=inf for masked pixels).
    xs, ys: 1D pixel-centre coordinates of the stamp columns/rows. p0 = (x, y, F, s, B)."""
    w = np.where(np.isfinite(sig) & (sig > 0), 1.0 / sig, 0.0)
    d = np.where(w > 0, stamp, 0.0)

    def fun(p):
        x, y, F, s, B = p
        Ex = _pix_int(xs, x, s)
        Ey = _pix_int(ys, y, s)
        m = F * Ey[:, None] * Ex[None, :] + B
        return ((m - d) * w).ravel()

    def jac(p):
        x, y, F, s, B = p
        Ex, dEx_dx, dEx_ds = _pix_int_derivs(xs, x, s)
        Ey, dEy_dy, dEy_ds = _pix_int_derivs(ys, y, s)
        J = np.empty((stamp.size, 5))
        J[:, 0] = (F * Ey[:, None] * dEx_dx[None, :] * w).ravel()
        J[:, 1] = (F * dEy_dy[:, None] * Ex[None, :] * w).ravel()
        J[:, 2] = (Ey[:, None] * Ex[None, :] * w).ravel()
        J[:, 3] = (F * (dEy_ds[:, None] * Ex[None, :] + Ey[:, None] * dEx_ds[None, :]) * w).ravel()
        J[:, 4] = w.ravel()
        return J

    res = least_squares(fun, p0, jac=jac, bounds=bounds, method="trf", x_scale="jac",
                        xtol=1e-10, ftol=1e-10, gtol=1e-10, max_nfev=200)
    J = res.jac
    nfree = int((w > 0).sum()) - 5
    try:
        cov = np.linalg.inv(J.T @ J)
    except np.linalg.LinAlgError:
        cov = np.full((5, 5), np.nan)
    chi2 = float(np.sum(res.fun ** 2))
    lo, hi = bounds
    at_bound = bool(np.any(np.isclose(res.x, lo, rtol=0, atol=1e-6) | np.isclose(res.x, hi, rtol=0, atol=1e-6)))
    ok = bool(res.success and not at_bound and np.all(np.isfinite(np.diag(cov))) and nfree > 0)
    return res.x, cov, chi2 / max(nfree, 1), ok


def win_centroid(img, var, xs, ys, x_start, y_start, sw, maxit=32, tol=2e-4):
    """SExtractor-style windowed centroid on a background-subtracted stamp."""
    X, Y = np.meshgrid(xs, ys)
    good = np.isfinite(img) & np.isfinite(var)
    I = np.where(good, img, 0.0)
    V = np.where(good, var, 0.0)
    x, y = float(x_start), float(y_start)
    ok = False
    for _ in range(maxit):
        wgt = np.exp(-((X - x) ** 2 + (Y - y) ** 2) / (2 * sw * sw)) * good
        S = np.sum(wgt * I)
        if not np.isfinite(S) or S <= 0:
            return np.nan, np.nan, np.nan, np.nan, False
        dx = 2.0 * np.sum(wgt * I * (X - x)) / S
        dy = 2.0 * np.sum(wgt * I * (Y - y)) / S
        x += dx
        y += dy
        if abs(x - x_start) > 2 or abs(y - y_start) > 2:
            return np.nan, np.nan, np.nan, np.nan, False
        if math.hypot(dx, dy) < tol:
            ok = True
            break
    wgt = np.exp(-((X - x) ** 2 + (Y - y) ** 2) / (2 * sw * sw)) * good
    S = np.sum(wgt * I)
    ex = 2.0 * math.sqrt(np.sum(wgt ** 2 * V * (X - x) ** 2)) / S
    ey = 2.0 * math.sqrt(np.sum(wgt ** 2 * V * (Y - y) ** 2)) / S
    return x, y, ex, ey, ok


# ------------------------------------------------------------------ WCS helpers -----------
def load_wcs(header):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        return WCS(header)        # default key only


def pixscale_arcsec(w) -> float:
    return float(np.sqrt(abs(np.linalg.det(w.pixel_scale_matrix))) * 3600.0)


def sky_jacobian(w, x, y, h=0.5):
    """d(RA*, Dec)/d(x, y) in arcsec/px at each (x, y), with RA* = RA cos(dec). Shape (N,2,2)."""
    x = np.asarray(x, float)
    y = np.asarray(y, float)
    ra0, de0 = w.pixel_to_world_values(x, y)
    rax1, dex1 = w.pixel_to_world_values(x + h, y)
    ray1, dey1 = w.pixel_to_world_values(x, y + h)
    rax0, dex0 = w.pixel_to_world_values(x - h, y)
    ray0, dey0 = w.pixel_to_world_values(x, y - h)
    c = np.cos(np.deg2rad(de0))
    wrap = lambda d: (d + 180.0) % 360.0 - 180.0  # noqa: E731
    J = np.empty((len(x), 2, 2))
    J[:, 0, 0] = wrap(rax1 - rax0) * c * 3600 / (2 * h)
    J[:, 0, 1] = wrap(ray1 - ray0) * c * 3600 / (2 * h)
    J[:, 1, 0] = (dex1 - dex0) * 3600 / (2 * h)
    J[:, 1, 1] = (dey1 - dey0) * 3600 / (2 * h)
    return J


def sky_residual(ra_m, dec_m, ra_g, dec_g):
    """(dRA*, dDec) in arcsec, measured minus Gaia."""
    dra = ((np.asarray(ra_m) - np.asarray(ra_g) + 180.0) % 360.0 - 180.0) * np.cos(np.deg2rad(dec_g)) * 3600.0
    ddec = (np.asarray(dec_m) - np.asarray(dec_g)) * 3600.0
    return dra, ddec


# ------------------------------------------------------------------ per-cutout -----------
def read_cutout(path):
    with fits.open(path, memmap=False) as hl:
        h0 = hl[0].header.copy()
        h1 = hl["IMAGE"].header.copy()
        img = np.asarray(hl["IMAGE"].data, float)
        flags = np.asarray(hl["FLAGS"].data, np.int64)
        fh = hl["FLAGS"].header.copy()
        var = np.asarray(hl["VARIANCE"].data, float)
        zodi = np.asarray(hl["ZODI"].data, float)
    return h0, h1, img, flags, fh, var, zodi


def measure_cutout(path, gaia: Table, sq: dict, field: str = "") -> tuple[Table, dict]:
    """Measure all candidate Gaia stars in one cutout. Returns (rows Table, frame meta incl. cut counts).

    Cut counts are counts of star-frame instances surviving each successive cut (CUT_ORDER)."""
    h0, h1, img, flags, fh, var, zodi = read_cutout(path)
    ny, nx = img.shape
    w = load_wcs(h1)
    mjd = float(h0.get("MJD-AVG", h1.get("MJD-AVG")))
    det = int(h0.get("DETECTOR", h1.get("DETECTOR")))
    obs = str(h0.get("OBSID", h1.get("OBSID")))
    x0off, y0off = int(h0.get("X0", 0)), int(h0.get("Y0", 0))
    fwhm_as = float(h0.get("PSF_FWHM", h1.get("PSF_FWHM", 7.5)))
    scale = pixscale_arcsec(w)
    fwhm_px = fwhm_as / scale
    bits = flag_bits(fh)
    rmask = reject_mask(bits)
    R = img - zodi

    ra_g, dec_g, has_pm = propagate(gaia, mjd)
    xg, yg = w.world_to_pixel_values(ra_g, dec_g)
    xg = np.asarray(xg)
    yg = np.asarray(yg)
    inf = np.isfinite(xg) & np.isfinite(yg) & (xg >= EDGE_PX) & (xg <= nx - 1 - EDGE_PX) & \
        (yg >= EDGE_PX) & (yg <= ny - 1 - EDGE_PX)
    sid_all = np.asarray(gaia["source_id"]).astype(np.int64)
    counts = {}
    surv = {}
    sel = inf.copy()
    counts["in_footprint"] = int(sel.sum())
    surv["in_footprint"] = sid_all[sel].tolist()
    for k in ["g_window", "ruwe", "has_pm", "isolated"]:
        sel &= sq[k]
        counts[k] = int(sel.sum())
        surv[k] = sid_all[sel].tolist()
    idx = np.where(sel)[0]
    s_flag, s_snr, s_fit, s_res = [], [], [], []
    # informational: which flag names hit the 5x5 stamps of the stars reaching the flag cut
    info_names = [n for n in REJECT_FLAG_NAMES + ("OUTLIER", "SOURCE", "GHOST") if n in bits]
    flag_hits = {n: 0 for n in info_names + ["NaN_or_bad_variance"]}
    flag_hits_accepted = {n: 0 for n in ("OUTLIER", "SOURCE", "GHOST") if n in bits}

    yy, xx = np.mgrid[0:ny, 0:nx]
    badpix = ((flags & rmask) != 0) | ~np.isfinite(R) | ~np.isfinite(var) | (var <= 0)

    rows = []
    n_flag = n_snr = n_fit = n_res = 0
    for i in idx:
        xi, yi = int(round(xg[i])), int(round(yg[i]))
        f5 = (slice(yi - FLAG_HALF, yi + FLAG_HALF + 1), slice(xi - FLAG_HALF, xi + FLAG_HALF + 1))
        fl5 = flags[f5]
        for n in info_names:
            if np.any(fl5 & (1 << bits[n])):
                flag_hits[n] += 1
        if np.any(~np.isfinite(R[f5]) | ~np.isfinite(var[f5]) | (var[f5] <= 0)):
            flag_hits["NaN_or_bad_variance"] += 1
        if np.any(badpix[f5]):
            continue
        for n in flag_hits_accepted:
            if np.any(fl5 & (1 << bits[n])):
                flag_hits_accepted[n] += 1
        n_flag += 1
        s_flag.append(int(sid_all[i]))
        # annulus background
        ys0, ys1 = max(0, yi - 9), min(ny, yi + 10)
        xs0, xs1 = max(0, xi - 9), min(nx, xi + 10)
        sub = R[ys0:ys1, xs0:xs1]
        rr = np.hypot(xx[ys0:ys1, xs0:xs1] - xg[i], yy[ys0:ys1, xs0:xs1] - yg[i])
        am = (rr >= ANN_IN) & (rr <= ANN_OUT) & ~badpix[ys0:ys1, xs0:xs1]
        if am.sum() < 20:
            continue
        _, bkg, bkg_std = sigma_clipped_stats(sub[am], sigma=3.0, maxiters=5)
        st = (slice(yi - STAMP_HALF, yi + STAMP_HALF + 1), slice(xi - STAMP_HALF, xi + STAMP_HALF + 1))
        stamp = R[st] - bkg
        vst = var[st]
        bst = badpix[st]
        xs = np.arange(xi - STAMP_HALF, xi + STAMP_HALF + 1, dtype=float)
        ys = np.arange(yi - STAMP_HALF, yi + STAMP_HALF + 1, dtype=float)
        if stamp.shape != (2 * STAMP_HALF + 1, 2 * STAMP_HALF + 1):
            continue
        c = (slice(STAMP_HALF - 1, STAMP_HALF + 2),) * 2
        peak = float(np.max(stamp[c]))
        jp = np.unravel_index(np.argmax(stamp[c]), (3, 3))
        snr = peak / math.sqrt(vst[c][jp])
        if not (snr >= SNR_MIN):
            continue
        n_snr += 1
        s_snr.append(int(sid_all[i]))
        sig = np.where(bst, np.inf, np.sqrt(np.where(vst > 0, vst, np.nan)))
        s0 = max(0.35, fwhm_px / 2.3548)
        F0 = max(float(np.nansum(np.where(bst, 0, stamp))), peak)
        p0 = np.array([xg[i], yg[i], F0, s0, 0.0])
        lo = np.array([xg[i] - 2.0, yg[i] - 2.0, 0.0, 0.25, -np.inf])
        hi = np.array([xg[i] + 2.0, yg[i] + 2.0, np.inf, 2.5, np.inf])
        try:
            p, cov, chi2r, ok = fit_gauss(stamp, sig, xs, ys, p0, (lo, hi))
        except Exception:  # noqa: BLE001
            ok = False
        # windowed centroid, started from the 3x3 first moment around the brightest central pixel
        cy, cx = yi - 1 + jp[0], xi - 1 + jp[1]
        s3 = R[cy - 1:cy + 2, cx - 1:cx + 2] - bkg
        tot3 = s3.sum()
        if tot3 > 0:
            xst = cx + float(np.sum(s3 * np.array([-1, 0, 1])[None, :]) / tot3)
            yst = cy + float(np.sum(s3 * np.array([-1, 0, 1])[:, None]) / tot3)
        else:
            xst, yst = float(cx), float(cy)
        stw = np.where(bst, np.nan, stamp)
        xw, yw, exw, eyw, okw = win_centroid(stw, np.where(bst, np.nan, vst), xs, ys, xst, yst,
                                              sw=fwhm_px / 2.3548)
        if not (ok and okw and chi2r <= CHI2R_MAX):
            continue
        n_fit += 1
        s_fit.append(int(sid_all[i]))
        if math.hypot(p[0] - xg[i], p[1] - yg[i]) > MAX_RESID_PX or math.hypot(xw - xg[i], yw - yg[i]) > MAX_RESID_PX:
            continue
        n_res += 1
        s_res.append(int(sid_all[i]))
        rows.append(dict(i=i, xg=xg[i], yg=yg[i], ra_g=ra_g[i], dec_g=dec_g[i], snr=snr, bkg=bkg,
                         bkg_std=bkg_std, x_g=p[0], y_g=p[1], ex_g=math.sqrt(cov[0, 0]),
                         ey_g=math.sqrt(cov[1, 1]), cxy_g=cov[0, 1], flux_g=p[2], sigma_g=p[3],
                         eflux_g=math.sqrt(cov[2, 2]), chi2r_g=chi2r,
                         x_w=xw, y_w=yw, ex_w=exw, ey_w=eyw))
    counts.update(flags_ok=n_flag, snr_ok=n_snr, fit_converged=n_fit, resid_sane=n_res)
    surv.update(flags_ok=s_flag, snr_ok=s_snr, fit_converged=s_fit, resid_sane=s_res)

    meta = dict(obs_id=obs, detector=det, mjd=mjd, x0=x0off, y0=y0off, nx=nx, ny=ny, pixscale=scale,
                psf_fwhm_as=fwhm_as, finast=h1.get("FINAST", -1), match_nstars=h1.get("MATCH_NSTARS", -1),
                visit=int(h0.get("VISIT", -1)), release=str(h0.get("RELEASE", "")), field=field,
                path=str(path), counts=counts, flag_bits={n: bits[n] for n in REJECT_FLAG_NAMES if n in bits},
                missing_flag_names=[n for n in REJECT_FLAG_NAMES if n not in bits])

    cols = ["source_id", "G", "bp_rp", "x_pred", "y_pred", "ra_gaia", "dec_gaia", "snr", "bkg", "bkg_std",
            "x_gauss", "y_gauss", "ex_gauss", "ey_gauss", "cxy_gauss", "flux_gauss", "eflux_gauss",
            "sigma_gauss", "chi2r_gauss", "x_win", "y_win", "ex_win", "ey_win"]
    if not rows:
        t = Table(names=cols, dtype=[np.int64] + [float] * (len(cols) - 1))
    else:
        ii = np.array([r["i"] for r in rows])
        t = Table()
        t["source_id"] = np.asarray(gaia["source_id"])[ii].astype(np.int64)
        t["G"] = np.asarray(gaia["phot_g_mean_mag"], float)[ii]
        t["bp_rp"] = np.asarray(gaia["bp_rp"], float)[ii]
        for src, dst in [("xg", "x_pred"), ("yg", "y_pred"), ("ra_g", "ra_gaia"), ("dec_g", "dec_gaia"),
                         ("snr", "snr"), ("bkg", "bkg"), ("bkg_std", "bkg_std"),
                         ("x_g", "x_gauss"), ("y_g", "y_gauss"), ("ex_g", "ex_gauss"), ("ey_g", "ey_gauss"),
                         ("cxy_g", "cxy_gauss"), ("flux_g", "flux_gauss"), ("eflux_g", "eflux_gauss"),
                         ("sigma_g", "sigma_gauss"), ("chi2r_g", "chi2r_gauss"),
                         ("x_w", "x_win"), ("y_w", "y_win"), ("ex_w", "ex_win"), ("ey_w", "ey_win")]:
            t[dst] = np.array([r[src] for r in rows], float)
    add_sky(t, w)
    t.meta.update({k: v for k, v in meta.items() if k not in ("counts", "flag_bits", "missing_flag_names")})
    t.meta["counts"] = counts
    t.meta["surv"] = surv
    t.meta["flag_hits"] = flag_hits
    t.meta["flag_hits_accepted"] = flag_hits_accepted
    t.meta["flag_bits"] = meta["flag_bits"]
    t.meta["missing_flag_names"] = meta["missing_flag_names"]
    t.meta["version"] = VERSION
    return t, meta


def add_sky(t: Table, w):
    """Sky positions, sky and pixel residuals (measured - Gaia), sky formal errors per method."""
    n = len(t)
    # local pixel -> sky Jacobian at the Gaia-predicted position (arcsec/px), for pixel-space corrections
    Jp = sky_jacobian(w, np.asarray(t["x_pred"], float), np.asarray(t["y_pred"], float)) if n else np.zeros((0, 2, 2))
    t["j_ra_x"], t["j_ra_y"] = Jp[:, 0, 0], Jp[:, 0, 1]
    t["j_dec_x"], t["j_dec_y"] = Jp[:, 1, 0], Jp[:, 1, 1]
    for m in ("gauss", "win"):
        if n == 0:
            for c in ("ra", "dec", "dra", "ddec", "dx", "dy", "era", "edec"):
                t[f"{c}_{m}"] = np.zeros(0)
            continue
        x = np.asarray(t[f"x_{m}"], float)
        y = np.asarray(t[f"y_{m}"], float)
        ra, dec = w.pixel_to_world_values(x, y)
        dra, ddec = sky_residual(ra, dec, t["ra_gaia"], t["dec_gaia"])
        t[f"ra_{m}"] = ra
        t[f"dec_{m}"] = dec
        t[f"dra_{m}"] = dra
        t[f"ddec_{m}"] = ddec
        t[f"dx_{m}"] = x - np.asarray(t["x_pred"])
        t[f"dy_{m}"] = y - np.asarray(t["y_pred"])
        J = sky_jacobian(w, x, y)
        C = np.zeros((n, 2, 2))
        C[:, 0, 0] = np.asarray(t[f"ex_{m}"]) ** 2
        C[:, 1, 1] = np.asarray(t[f"ey_{m}"]) ** 2
        if m == "gauss":
            C[:, 0, 1] = C[:, 1, 0] = np.asarray(t["cxy_gauss"])
        S = J @ C @ np.transpose(J, (0, 2, 1))
        t[f"era_{m}"] = np.sqrt(S[:, 0, 0])
        t[f"edec_{m}"] = np.sqrt(S[:, 1, 1])
