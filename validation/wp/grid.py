"""Phase B: resample one SPHEREx cutout onto the common grid, with honest variance, wavelength
maps and per-star aperture photometry.

Units and conventions (load-bearing):
  * Grid images are surface brightness in MJy/sr (IMAGE - ZODI - per-frame background), the same
    unit as the Level 2 IMAGE. Surface brightness is intensive, so a resample keeps the value of
    a pixel, and an aperture SUM over grid pixels times the grid pixel solid angle
    OMEGA(scale) gives a flux density. Aperture fluxes leave this module as sums in
    MJy/sr * grid pixel; scripts/05 converts them to microjansky with OMEGA(scale) * 1e12.
  * Pixels are 0-based, numpy order [y, x]; pixel (i, j) covers [i-0.5, i+0.5] (astropy origin 0).
  * Cutout pixel + (X0, Y0) = detector pixel; wavelength maps come from wavelength.cal_lambda at
    the detector pixel that each grid-pixel centre maps to (nearest pixel, no interpolation).

Every kernel is written as a sparse linear operator K (n_grid x n_native) applied to the native
image, so for every kernel
    data_out = K @ R,   var_out = (K o K) @ var_native   (o = elementwise square),
which is the exact per-pixel propagation for independent native pixels. A grid pixel is NaN if any
native pixel with a non-zero weight in its row is bad (rejection flag under the active mask
variant, or non-finite IMAGE/ZODI/VARIANCE, or outside the cutout): the "strict" rule, also what
the website does for bilinear. Kernels:
  bilinear   the 4 nearest native pixels, weights (1-fx)(1-fy) etc. (the website's resampler)
  lanczos3   6 x 6 taps, separable Lanczos a=3, each axis normalised to sum 1
  adaptive   reproject.reproject_adaptive(conserve_flux=True) (DeForest 2004 anti-aliased,
             Gaussian kernel, defaults otherwise), rows divided by the response to a unit
             image (the local output/input pixel-area factor) to return to MJy/sr
  exact      reproject.reproject_exact (spherical-polygon area overlap; surface brightness)
For adaptive and exact, K is measured by probing reproject with comb images (one native pixel in
every s x s block set to 1): reproject is linear, and when the support of a grid pixel in the
native plane is smaller than s, each grid pixel sees at most one comb pixel, so the comb output
at that grid pixel IS the operator element. The probe is checked against reproject on real data
in scripts/05 (verification).

Aperture variance: neighbouring grid pixels share native pixels, so their noise is correlated and
sum(a^2 var_grid) under-counts. For a single resampled exposure this module computes the exact
aperture variance c^T diag(var_native) c with c = K^T a (and the same for the background
annulus mean); var_naive = sum(a^2 var_grid) is kept alongside, and their ratio is the
correlation factor that scripts/05 applies to the stacked and modelled products (P2, M1).
"""
from __future__ import annotations

import math
import warnings

import numpy as np
import scipy.sparse as sp
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS, FITSFixedWarning

from . import phaseb
from . import wavelength as W
from .gaia import propagate
from .registration import flag_bits, reject_mask

KERNELS = ("bilinear", "lanczos3", "adaptive", "exact")
MASKS = ("prereg", "browser")
# Website mask (src/lib/spherex/flags.ts BAD_DATA_MASK): TRANSIENT, SUR_ERROR, NONFUNC, DICHROIC,
# MISSING_DATA, HOT, COLD, PHANMISS, NONLINEAR, BLOOM, SNOWBALL. Not OVERFLOW/PERSIST/STREAK/HALO.
BROWSER_BITS = (0, 2, 6, 7, 9, 10, 11, 14, 15, 26, 27)
SOURCE_BIT = 21
BKG_SRC_RADIUS_NATIVE = 3.0      # frame background: pixels > 3 native px from any Gaia G < 18
BKG_GMAX = 18.0
PROBE_SPACING = {"exact": 4, "adaptive": 7}
ARCSEC_PER_RAD = 206264.80624709636


def scale_tag(scale: float) -> str:
    return f"{scale:g}".replace(".", "p")


def omega_sr(scale: float) -> float:
    """Solid angle of one grid pixel (sr)."""
    return (scale / ARCSEC_PER_RAD) ** 2


def mask_bits(variant: str, flags_header) -> int:
    if variant == "prereg":
        return reject_mask(flag_bits(flags_header))
    if variant == "browser":
        return int(sum(1 << b for b in BROWSER_BITS))
    raise ValueError(variant)


# ------------------------------------------------------------------ exposure ---------------
def load_exposure(path) -> dict:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        with fits.open(path, memmap=False) as hl:
            h0 = hl[0].header.copy()
            hi = hl["IMAGE"].header.copy()
            e = dict(img=np.asarray(hl["IMAGE"].data, float), flags=np.asarray(hl["FLAGS"].data, np.int64),
                     fhdr=hl["FLAGS"].header.copy(), var=np.asarray(hl["VARIANCE"].data, float),
                     zodi=np.asarray(hl["ZODI"].data, float))
        e["wcs"] = WCS(hi)                       # default key only (TAN-SIP), never key='W'
    e.update(obsid=str(h0["OBSID"]), det=int(h0["DETECTOR"]), release=str(h0.get("RELEASE", "dr1")).strip().lower(),
             mjd=float(h0["MJD-AVG"]), visit=int(h0.get("VISIT", -1)), x0=int(h0["X0"]), y0=int(h0["Y0"]))
    e["frame"] = f"{e['obsid']}_D{e['det']}"
    return e


def frame_background(e: dict, mbits: int, gaia_ra, gaia_dec) -> dict:
    """Per-frame background of IMAGE - ZODI: sigma-clipped (3 sigma, 5 iterations) median of
    pixels that are finite, not flagged under the active mask, not SOURCE-flagged and more than
    3 native px from any (propagated) Gaia G < 18 source. Also returns the plain median (finite,
    unflagged pixels, no clipping, no source masking) and the clipped median without source masking."""
    R = e["img"] - e["zodi"]
    ny, nx = R.shape
    ok = np.isfinite(R) & np.isfinite(e["var"]) & ((e["flags"] & mbits) == 0)
    plain = float(np.median(R[ok])) if ok.any() else float("nan")
    _, clip_unmasked, _ = sigma_clipped_stats(R[ok], sigma=3.0, maxiters=5)
    src = ok & ((e["flags"] & (1 << SOURCE_BIT)) == 0)
    gx, gy = e["wcs"].world_to_pixel_values(gaia_ra, gaia_dec)
    gx, gy = np.asarray(gx), np.asarray(gy)
    r = BKG_SRC_RADIUS_NATIVE
    near = np.zeros_like(src)
    inside = np.isfinite(gx) & (gx > -r - 1) & (gx < nx + r) & (gy > -r - 1) & (gy < ny + r)
    yy, xx = np.mgrid[-4:5, -4:5]
    for x, y in zip(gx[inside], gy[inside]):
        xi, yi = int(round(x)), int(round(y))
        px, py = xi + xx, yi + yy
        m = (np.hypot(px - x, py - y) <= r) & (px >= 0) & (px < nx) & (py >= 0) & (py < ny)
        near[py[m], px[m]] = True
    sel = src & ~near
    _, med, std = sigma_clipped_stats(R[sel], sigma=3.0, maxiters=5)
    return dict(bkg=float(med), bkg_std=float(std), n_bkg=int(sel.sum()), plain=plain,
                clipped_unmasked=float(clip_unmasked))


# ------------------------------------------------------------------ geometry --------------
def native_coords(w_in: WCS, gw: WCS, shape_out):
    """Cutout-pixel coordinates (float, 0-based) of every grid-pixel centre; arrays (ny, nx)."""
    ny, nx = shape_out
    gy, gx = np.mgrid[0:ny, 0:nx].astype(float)
    ra, dec = gw.pixel_to_world_values(gx, gy)
    xs, ys = w_in.world_to_pixel_values(ra, dec)
    return np.asarray(xs), np.asarray(ys)


def wave_maps(e: dict, xs, ys):
    """(lam_um, bw_um) per grid pixel: cal_lambda at detector pixel (cutout pixel + X0/Y0); NaN off-cutout."""
    ny, nx = e["img"].shape
    inside = (xs > -0.5) & (xs < nx - 0.5) & (ys > -0.5) & (ys < ny - 0.5)
    lam, bw = W.cal_lambda(e["release"], e["det"], xs + e["x0"], ys + e["y0"])
    return np.where(inside, lam, np.nan), np.where(inside, bw, np.nan)


def _lanczos(t, a=3):
    t = np.asarray(t, float)
    out = np.sinc(t) * np.sinc(t / a)
    return np.where(np.abs(t) < a, out, 0.0)


def _analytic_matrix(kernel, xs, ys, shape_in):
    ny_in, nx_in = shape_in
    n_out = xs.size
    x = xs.ravel()
    y = ys.ravel()
    good = np.isfinite(x) & np.isfinite(y)
    x = np.where(good, x, -1e6)
    y = np.where(good, y, -1e6)
    ix = np.floor(x).astype(np.int64)
    iy = np.floor(y).astype(np.int64)
    fx, fy = x - ix, y - iy
    if kernel == "bilinear":
        offs = np.array([0, 1])
        wx = np.stack([1 - fx, fx], 1)
        wy = np.stack([1 - fy, fy], 1)
    elif kernel == "lanczos3":
        offs = np.arange(-2, 4)
        wx = _lanczos(fx[:, None] - offs[None, :])
        wy = _lanczos(fy[:, None] - offs[None, :])
        wx /= wx.sum(1, keepdims=True)
        wy /= wy.sum(1, keepdims=True)
    else:
        raise ValueError(kernel)
    rows, cols, vals = [], [], []
    valid = good.copy()
    g = np.arange(n_out)
    for j, oy in enumerate(offs):
        for i, ox in enumerate(offs):
            wgt = wy[:, j] * wx[:, i]
            cx, cy = ix + ox, iy + oy
            use = wgt != 0
            outside = (cx < 0) | (cx >= nx_in) | (cy < 0) | (cy >= ny_in)
            valid &= ~(use & outside)
            m = use & ~outside & good
            rows.append(g[m])
            cols.append(cy[m] * nx_in + cx[m])
            vals.append(wgt[m])
    K = sp.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))),
                      shape=(n_out, ny_in * nx_in))
    return K, valid


def _probe_matrix(kernel, xs, ys, w_in, shape_in, gw, shape_out):
    from reproject import reproject_adaptive, reproject_exact
    ny_in, nx_in = shape_in
    n_out = xs.size
    s = PROBE_SPACING[kernel]

    def run(img):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if kernel == "adaptive":
                o, fp = reproject_adaptive((img, w_in), gw, shape_out=shape_out, conserve_flux=True)
            else:
                o, fp = reproject_exact((img, w_in), gw, shape_out=shape_out)
        return np.asarray(o, float).ravel(), np.asarray(fp, float).ravel()

    ones, fp1 = run(np.ones(shape_in))
    valid = np.isfinite(ones) & (ones > 0) & (fp1 > 0.999) & np.isfinite(xs.ravel()) & np.isfinite(ys.ravel())
    x = np.where(valid, xs.ravel(), 0.0)
    y = np.where(valid, ys.ravel(), 0.0)
    rows, cols, vals = [], [], []
    g = np.arange(n_out)
    for q in range(s):
        for p in range(s):
            comb = np.zeros(shape_in)
            comb[q::s, p::s] = 1.0
            o, _ = run(comb)
            kx = p + s * np.rint((x - p) / s).astype(np.int64)
            ky = q + s * np.rint((y - q) / s).astype(np.int64)
            m = valid & np.isfinite(o) & (np.abs(o) > 1e-10) & (kx >= 0) & (kx < nx_in) & (ky >= 0) & (ky < ny_in)
            rows.append(g[m])
            cols.append(ky[m] * nx_in + kx[m])
            vals.append(o[m])
    K = sp.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))),
                      shape=(n_out, ny_in * nx_in))
    if kernel == "adaptive":
        # back to surface brightness: divide by the response to a unit image
        K = sp.diags(np.where(valid, 1.0 / np.where(valid, ones, 1.0), 0.0)) @ K
    rs = np.asarray(K.sum(1)).ravel()
    valid &= np.abs(rs - 1.0) < 1e-3          # incomplete probe rows (should not happen) -> invalid
    return K.tocsr(), valid, ones


def kernel_matrix(kernel, e, gw, shape_out, xs=None, ys=None):
    """(K csr (n_grid, n_native), valid rows bool (n_grid,)). Rows sum to 1 (surface brightness)."""
    if xs is None:
        xs, ys = native_coords(e["wcs"], gw, shape_out)
    if kernel in ("bilinear", "lanczos3"):
        return _analytic_matrix(kernel, xs, ys, e["img"].shape)
    K, valid, _ = _probe_matrix(kernel, xs, ys, e["wcs"], e["img"].shape, gw, shape_out)
    return K, valid


def apply_kernel(K, valid, R, var, bad, shape_out):
    """data, var on the grid (NaN where invalid or any contributing native pixel is bad)."""
    R0 = np.where(bad, 0.0, R).ravel()
    V0 = np.where(bad, 0.0, var).ravel()
    Kabs = abs(K)
    badout = (Kabs @ bad.ravel().astype(float)) > 0
    data = K @ R0
    vout = K.multiply(K) @ V0
    ok = valid & ~badout
    return (np.where(ok, data, np.nan).reshape(shape_out), np.where(ok, vout, np.nan).reshape(shape_out))


# ------------------------------------------------------------------ photometry -------------
def stamp_half(scale: float) -> int:
    return int(math.ceil(phaseb.ANN_OUT * 6.15 / scale)) + 1


def stamp_geom(xc, yc, ox, oy, scale: float) -> dict:
    """Aperture/annulus geometry on stamps of size S = 2H+1 with origin (ox, oy) (grid pixel of
    stamp [0,0]) for star centres (xc, yc) (grid pixels). Aperture weights are exact circle/pixel
    overlap (photutils method 'exact'); the annulus uses pixel centres in [ANN_IN, ANN_OUT]."""
    from photutils.aperture import CircularAperture
    f = 6.15 / scale
    H = stamp_half(scale)
    S = 2 * H + 1
    n = len(xc)
    lx = np.asarray(xc, float) - ox
    ly = np.asarray(yc, float) - oy
    ap = np.zeros((n, S, S))
    for k in range(n):
        m = CircularAperture((lx[k], ly[k]), r=phaseb.APER_R * f).to_mask(method="exact")
        ap[k] = m.to_image((S, S))
    yy, xx = np.mgrid[0:S, 0:S]
    r = np.hypot(xx[None] - lx[:, None, None], yy[None] - ly[:, None, None])
    ann = (r >= phaseb.ANN_IN * f) & (r <= phaseb.ANN_OUT * f)
    return dict(ap=ap, ann=ann, r=r, S=S, H=H, f=f, lx=lx, ly=ly)


def extract(img, ox, oy, S):
    """Stamps (n, S, S) from a 2D image with origins ox, oy (ints); NaN outside the image."""
    ny, nx = img.shape
    yy, xx = np.mgrid[0:S, 0:S]
    X = np.asarray(ox)[:, None, None] + xx[None]
    Y = np.asarray(oy)[:, None, None] + yy[None]
    ins = (X >= 0) & (X < nx) & (Y >= 0) & (Y < ny)
    return np.where(ins, img[np.clip(Y, 0, ny - 1), np.clip(X, 0, nx - 1)], np.nan)


def phot(st_img, st_var, geom, min_ann: int = 10) -> dict:
    """Vectorised aperture photometry on stamps. Returns sums in (image unit) * grid pixel.

    F = sum(a * (img - bkg)), bkg = median of finite annulus pixels.
    var_naive = sum(a^2 var) + (pi/2) * (sum a)^2 * sum_ann(var) / N_ann^2 (median of N
    independent samples has variance pi/2 times that of the mean; grid-pixel correlation is NOT
    included here, see module docstring). ok = aperture fully finite and N_ann >= min_ann."""
    a = geom["ap"]
    ann = geom["ann"]
    inap = a > 0
    nan_ap = np.any(inap & ~(np.isfinite(st_img) & np.isfinite(st_var)), axis=(1, 2))
    annv = np.where(ann & np.isfinite(st_img) & np.isfinite(st_var), st_img, np.nan)
    n_ann = np.sum(np.isfinite(annv), axis=(1, 2))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        bkg = np.nanmedian(annv.reshape(len(a), -1), axis=1)
        var_ann_sum = np.nansum(np.where(np.isfinite(annv), st_var, np.nan).reshape(len(a), -1), axis=1)
    asum = a.sum((1, 2))
    F = np.nansum(np.where(inap, a * (st_img - bkg[:, None, None]), 0.0), axis=(1, 2))
    var_ap = np.nansum(np.where(inap, a * a * st_var, 0.0), axis=(1, 2))
    var_bkg = (math.pi / 2) * asum ** 2 * var_ann_sum / np.maximum(n_ann, 1) ** 2
    ok = ~nan_ap & (n_ann >= min_ann)
    return dict(F=np.where(ok, F, np.nan), bkg=bkg, nan_ap=nan_ap, n_ann=n_ann, asum=asum,
                var_naive=np.where(ok, var_ap + var_bkg, np.nan), ok=ok,
                var_ap_naive=var_ap, var_bkg_naive=var_bkg)


def exact_aperture_variance(K, var_native, geom, ox, oy, shape_out, ann_valid):
    """Covariance-aware variance of F for a single resampled exposure: c = K^T a over native pixels.
    ann_valid: (n, S, S) bool, annulus pixels actually used for the median."""
    ny, nx = shape_out
    n, S = len(ox), geom["S"]
    yy, xx = np.mgrid[0:S, 0:S]
    X = np.asarray(ox)[:, None, None] + xx[None]
    Y = np.asarray(oy)[:, None, None] + yy[None]
    ins = (X >= 0) & (X < nx) & (Y >= 0) & (Y < ny)
    gidx = np.where(ins, Y * nx + X, 0)

    def build(wts):
        m = (wts != 0) & ins
        k = np.broadcast_to(np.arange(n)[:, None, None], wts.shape)
        return sp.csr_matrix((wts[m], (gidx[m], k[m])), shape=(ny * nx, n))

    nann = np.maximum(ann_valid.sum((1, 2)), 1)
    A = build(geom["ap"])
    B = build(ann_valid / nann[:, None, None])
    v0 = np.where(np.isfinite(var_native), var_native, 0.0).ravel()
    CA = (K.T @ A).tocsc()
    CB = (K.T @ B).tocsc()
    var_ap = np.asarray(CA.multiply(CA).T @ v0).ravel()
    var_bm = np.asarray(CB.multiply(CB).T @ v0).ravel()
    asum = geom["ap"].sum((1, 2))
    return var_ap + (math.pi / 2) * asum ** 2 * var_bm, var_ap


def peak(st_img, geom, bkg, rmax: float = 1.5):
    """Peak of the background-subtracted stamp within rmax (scaled) grid px of the star."""
    m = geom["r"] <= rmax * geom["f"]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmax(np.where(m, st_img, np.nan).reshape(len(bkg), -1), axis=1) - bkg


def flag5(e: dict, mbits: int, ra, dec):
    """True where the star's central 5x5 native pixels carry a flag of the active mask (or fall
    off the cutout)."""
    ny, nx = e["flags"].shape
    x, y = e["wcs"].world_to_pixel_values(ra, dec)
    out = np.ones(len(ra), bool)
    for k, (xx, yy) in enumerate(zip(np.atleast_1d(x), np.atleast_1d(y))):
        if not (np.isfinite(xx) and np.isfinite(yy)):
            continue
        xi, yi = int(round(float(xx))), int(round(float(yy)))
        if xi - 2 < 0 or yi - 2 < 0 or xi + 3 > nx or yi + 3 > ny:
            continue
        out[k] = bool(np.any(e["flags"][yi - 2:yi + 3, xi - 2:xi + 3] & mbits))
    return out


# ------------------------------------------------------------------ one exposure -----------
def resample_exposure(path, kernel, scale, field, stars, gaia_bkg, out_paths: dict, star_origin):
    """Resample one cutout with one kernel at one grid scale, for every mask variant in out_paths
    ({mask: npz path}). stars: Table-like with ra, dec, pmra, pmdec, parallax (sample stars);
    gaia_bkg: same for all Gaia G < 18 (frame-background source mask). star_origin: (ox, oy)
    integer stamp origins on this grid. Writes one npz per mask; returns a small summary dict."""
    e = load_exposure(path)
    gw, shape = phaseb.grid_wcs(field, scale)
    xs, ys = native_coords(e["wcs"], gw, shape)
    lam, bw = wave_maps(e, xs, ys)
    K, valid = kernel_matrix(kernel, e, gw, shape, xs, ys)
    sra, sdec, _ = propagate(stars, e["mjd"])
    bra, bdec, _ = propagate(gaia_bkg, e["mjd"])
    xg, yg = gw.world_to_pixel_values(sra, sdec)
    xn, yn = e["wcs"].world_to_pixel_values(sra, sdec)
    lam_s, bw_s = W.cal_lambda(e["release"], e["det"], np.asarray(xn) + e["x0"], np.asarray(yn) + e["y0"])
    ox, oy = star_origin
    geom = stamp_geom(xg, yg, ox, oy, scale)
    summ = {}
    for mask, outp in out_paths.items():
        mb = mask_bits(mask, e["fhdr"])
        fb = frame_background(e, mb, bra, bdec)
        R = e["img"] - e["zodi"] - fb["bkg"]
        bad = ~np.isfinite(R) | ~np.isfinite(e["var"]) | ((e["flags"] & mb) != 0)
        data, var = apply_kernel(K, valid, R, e["var"], bad, shape)
        sti = extract(data, ox, oy, geom["S"])
        stv = extract(var, ox, oy, geom["S"])
        ph = phot(sti, stv, geom)
        annv = geom["ann"] & np.isfinite(sti) & np.isfinite(stv)
        vex, _ = exact_aperture_variance(K, np.where(bad, 0.0, e["var"]), geom, ox, oy, shape, annv)
        f5 = flag5(e, mb, sra, sdec)
        pk = peak(sti, geom, ph["bkg"])
        np.savez_compressed(
            outp, data=data.astype(np.float32), var=var.astype(np.float32), lam=lam.astype(np.float32),
            bw=bw.astype(np.float32), mjd=e["mjd"], det=e["det"], visit=e["visit"], frame=e["frame"],
            release=e["release"], kernel=kernel, scale=scale, mask=mask,
            bkg_frame=fb["bkg"], bkg_plain=fb["plain"], bkg_clip_unmasked=fb["clipped_unmasked"],
            bkg_std=fb["bkg_std"], n_bkg=fb["n_bkg"],
            s_x=np.asarray(xg), s_y=np.asarray(yg), s_flag5=f5, s_F=ph["F"], s_bkg=ph["bkg"],
            s_nan_ap=ph["nan_ap"], s_n_ann=ph["n_ann"], s_var_naive=ph["var_naive"],
            s_var_exact=np.where(ph["ok"], vex, np.nan), s_peak=pk, s_lam=lam_s, s_bw=bw_s)
        summ[mask] = dict(bkg=fb["bkg"], plain=fb["plain"], good=float(np.isfinite(data).mean()))
    return summ


def load_npz(p) -> dict:
    with np.load(p, allow_pickle=False) as z:
        return {k: (z[k].item() if z[k].ndim == 0 else z[k]) for k in z.files}
