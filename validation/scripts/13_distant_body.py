"""13: a fake distant body (circular orbit, 500 au) through the two-step search (roundtable files 10, 11).

usage: uv run python scripts/13_distant_body.py [--field barnard] [--refresh] [--ab-bright X --ab-faint Y]

Field and visits (A, B = the 12-month pair, C = the 6-month visit): barnard 0, 4, 2 (361 d and 203 d from A;
visit spans 17-30 d) or epsindi 0, 2, 1 (351 d and 155 d; visit 0 spans 46 d). Default barnard: see the
"geometry" table the script prints (dates closest to 6 and 12 months, shortest visit spans); Eps Indi has the
higher ecliptic latitude (-41 deg, parallax ellipse axis ratio 0.66 against 0.47) but worse dates.

Pipeline
  geometry   wp.tracking: circular orbit at 500 au (P = 11180 yr, 115.9"/yr), prograde, inclination = the
             ecliptic latitude of the apparent track (an orbit in the ecliptic plane cannot reach a field at
             +28 or -41 deg), placed so the apparent track over all exposures is centred on the field.
  injection  wp.inject: ePSF stamp (signal_stamp), flat F_nu, flux = ab_to_mjy(AB), at the apparent position
             in every exposure of visits A, B, C. The source's own photon noise is not added (negligible at
             AB >= 18, k * signal << pixel variance); the real cutout noise and stars are untouched.
  step 1     visit stacks (inverse-variance, IMAGE - ZODI - 15x15 median background, resampled bilinearly to a
             fixed 6.15"/px TAN sky grid, no tracking), difference A - B, Gaussian filter, S/N from the
             robust (MAD) scatter of the filtered difference; positions from flux-weighted centroids.
  step 2     matched (ePSF) flux at the position predicted for a trial D, per exposure of visit C, combined with
             inverse-variance weights from the empirical per-exposure scatter. Models: naive (heliocentric
             direction fixed at the step 1 start), interpolated (data seat's linear model, motion from step 1),
             oracle (true start and best linear motion; isolates the step 1 measurement error).
Outputs: docs/figures/distant_*.png, docs/results.json section "distant_body", data/phasec/distant_*.
"""
import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from astropy.table import Table  # noqa: E402
from astropy.wcs import WCS  # noqa: E402
from scipy.ndimage import gaussian_filter, map_coordinates, median_filter  # noqa: E402

from wp import inject, m2ref, tracking as T  # noqa: E402
from wp.config import DATA, FIELDS, FIGURES, ROOT  # noqa: E402
from wp.results import metric, update_results  # noqa: E402

PHASEC = DATA / "phasec"
PIX = 6.15
D_TRUE = 500.0
VISITS = {"barnard": dict(A=0, B=4, C=2), "epsindi": dict(A=0, B=2, C=1)}
GRID_N = 321                      # step 1 sky grid, 6.15"/px, centred on the field
PSF_WIN = 7                       # matched-filter window (native px)
BKG_SIZE = 15                     # median-filter background (native px)
SIGF = 2.0                        # step 1 Gaussian filter sigma (sky-grid px)
D_GRID = np.arange(300.0, 800.0 + 1e-9, 0.1)
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


# ============================================================== geometry
def geometry_table():
    """Both candidate fields: dates, spans, sensitivity, parallax/orbit geometry (arithmetic, no pixels)."""
    rows = []
    for f, v in VISITS.items():
        d = Table.read(DATA / f"index_{f}.csv")
        fc = FIELDS[f]
        mj = {k: float(d["mjd_mid"][d["visit"] == v[k]].mean()) for k in "ABC"}
        span = {k: float(np.ptp(d["mjd_mid"][d["visit"] == v[k]])) for k in "ABC"}
        orb = T.orbit_through(fc["ra"], fc["dec"], mj["A"], D_TRUE)
        uA = orb.u(mj["A"])
        c = T.radec_to_u(fc["ra"], fc["dec"])
        pA = T.tangent_offset_arcsec(c, T.apparent_vec(uA, D_TRUE, T.earth_helio_au(mj["A"])))
        pC = T.tangent_offset_arcsec(c, T.apparent_vec(orb.u(mj["C"]), D_TRUE, T.earth_helio_au(mj["C"])))
        pB = T.tangent_offset_arcsec(c, T.apparent_vec(orb.u(mj["B"]), D_TRUE, T.earth_helio_au(mj["B"])))
        # parallax-only shifts (heliocentric direction frozen at A) between dates, px
        def par(m):
            return T.tangent_offset_arcsec(uA, T.apparent_vec(uA, D_TRUE, T.earth_helio_au(m))) / PIX
        shC = par(mj["C"]) - par(mj["A"])
        shB = par(mj["B"]) - par(mj["A"])
        mot = T.fit_linear_motion(orb, np.linspace(mj["A"], mj["A"] + 365.25, 30), mj["A"])[0] / PIX
        ang = np.degrees(np.arccos(np.dot(shC, mot) / (np.linalg.norm(shC) * np.linalg.norm(mot))))
        rows.append(dict(field=f, ecl_lat=orb.ecl_lat_deg, dtAB=mj["B"] - mj["A"], dtAC=mj["C"] - mj["A"],
                         span_A=span["A"], span_B=span["B"], span_C=span["C"],
                         parallax_AB_px=float(np.linalg.norm(shB)), parallax_AC_px=float(np.linalg.norm(shC)),
                         pxpct_AC=T.px_per_percent(uA, D_TRUE, mj["A"], mj["C"]),
                         pxpct_AB=T.px_per_percent(uA, D_TRUE, mj["A"], mj["B"]),
                         motion_px_yr=float(np.linalg.norm(mot)), angle_parallaxAC_vs_motion=float(ang),
                         axis_ratio=float(np.sin(np.deg2rad(abs(orb.ecl_lat_deg))))))
    return rows


# ============================================================== data
def load_exposures(field, visits, orbit):
    idx = Table.read(DATA / f"index_{field}.csv")
    sel = np.isin(idx["visit"], list(visits.values())) & (np.asarray(idx["on_detector"]).astype(bool))
    exps = []
    for r in idx[sel]:
        path = ROOT / str(r["cutout_path"])
        if not path.exists():
            continue
        c = m2ref.load_cutout(path)
        FL = c["FL"]
        P, V = c["P"], c["V"]
        bad = ((FL & m2ref.BAD_DATA_MASK) != 0) | ~np.isfinite(P) | ~np.isfinite(V) | (V <= 0)
        med = float(np.median(P[~bad]))
        bkg = median_filter(np.where(bad, med, P), size=BKG_SIZE, mode="nearest")
        Pb = np.where(bad, 0.0, P - bkg).astype(np.float32)
        W = np.where(bad, 0.0, 1.0 / np.where(V > 0, V, 1.0)).astype(np.float32)
        key = {v: k for k, v in visits.items()}[int(r["visit"])]
        e = dict(P=Pb, W=W, wcs=c["wcs"], mjd=c["mjd"], det=c["detector"], obs=c["obs_id"], x0=c["x0"],
                 y0=c["y0"], visit=key, release=c["release"])
        e["epsf"] = inject.get_epsf(field, e["obs"], e["det"])
        e["omega"] = inject.pixel_solid_angle_sr(e["wcs"])
        # truth: apparent position of the body
        ra, dec = T.u_to_radec(T.apparent_vec(orbit.u(e["mjd"]), D_TRUE, T.earth_helio_au(e["mjd"])))
        x, y = e["wcs"].all_world2pix(ra, dec, 0)
        e["xt"], e["yt"] = float(x), float(y)
        ny, nx = Pb.shape
        e["inside"] = bool(8 <= x < nx - 8 and 8 <= y < ny - 8)
        exps.append(e)
    return exps


# ============================================================== matched filter
def psf_batch(e, xs, ys, size=PSF_WIN):
    """ePSF stamps (N, size, size) of unit-flux sources at cutout positions (xs, ys), native sampling,
    zone nearest to the exposure's body position (zone varies slowly over the cutout)."""
    ep = e["epsf"]
    k = inject.nearest_zone(ep, e["xt"] + e["x0"], e["yt"] + e["y0"])
    pf = inject._prefiltered(id(ep["epsf"]), ep["epsf"], k)
    ovx, ovy = ep["oversampling"]
    ny_o, nx_o = ep["epsf"].shape[1:]
    cy, cx = (ny_o - 1) / 2.0, (nx_o - 1) / 2.0
    c = size // 2
    xs = np.asarray(xs, float)
    ys = np.asarray(ys, float)
    xi, yi = np.rint(xs), np.rint(ys)
    dx, dy = xs - xi, ys - yi
    ii = np.arange(size) - c
    u = ii[None, None, :] - dx[:, None, None]          # (N,1,size) offset along x
    v = ii[None, :, None] - dy[:, None, None]
    u, v = np.broadcast_arrays(u, v)
    yo, xo = cy + ovy * v, cx + ovx * u
    val = map_coordinates(pf, [yo.ravel(), xo.ravel()], order=3, mode="constant", cval=0.0, prefilter=False)
    val = val.reshape(u.shape)
    inside = (yo >= 0) & (yo <= ny_o - 1) & (xo >= 0) & (xo <= nx_o - 1)
    # normalise the zone to unit flux at native sampling (sum of the oversampled array = ovx * ovy). The
    # archive arrays in the cache sum to 1.0 (not 25 as inject.py's docstring says), which would make
    # inject.psf_stamp 25 times too faint; renormalising here is a no-op once that is fixed upstream.
    norm = (ovx * ovy) / float(ep["epsf"][k].sum())
    return np.where(inside, val, 0.0) * norm


def matched(e, img, xs, ys, size=PSF_WIN, badfrac=0.25):
    """Optimal (inverse-variance, ePSF) flux in mJy of a point source at cutout positions, and its
    formal sigma. NaN when the window leaves the cutout or more than badfrac of the PSF power is masked."""
    W = e["W"]
    ny, nx = img.shape
    c = size // 2
    xs = np.asarray(xs, float)
    ys = np.asarray(ys, float)
    N = xs.size
    xi, yi = np.rint(xs).astype(int), np.rint(ys).astype(int)
    ok = np.isfinite(xs) & np.isfinite(ys) & (xi - c >= 0) & (xi + c < nx) & (yi - c >= 0) & (yi + c < ny)
    xs2, ys2 = np.where(ok, xs, nx / 2), np.where(ok, ys, ny / 2)
    xi2, yi2 = np.rint(xs2).astype(int), np.rint(ys2).astype(int)
    psf = psf_batch(e, xs2, ys2, size) * (1e-9 / e["omega"])      # MJy/sr per mJy
    ii = np.arange(-c, c + 1)
    py = (yi2[:, None, None] + ii[None, :, None]) * np.ones((1, 1, size), int)
    px = (xi2[:, None, None] + ii[None, None, :]) * np.ones((1, size, 1), int)
    p = img[py, px].astype(float)
    w = W[py, px].astype(float)
    den = np.sum(psf ** 2 * w, axis=(1, 2))
    num = np.sum(psf * w * p, axis=(1, 2))
    tot = np.sum(psf ** 2, axis=(1, 2))
    lost = np.sum(psf ** 2 * (w == 0), axis=(1, 2)) / np.where(tot > 0, tot, 1)
    good = ok & (den > 0) & (lost <= badfrac)
    F = np.where(good, num / np.where(den > 0, den, 1), np.nan)
    S = np.where(good, 1.0 / np.sqrt(np.where(den > 0, den, 1)), np.nan)
    return F, S


def template(e, size=15):
    """Native-pixel image (float32) of the injected body at 1 mJy (noise-free), from the ePSF."""
    img = np.zeros(e["P"].shape, np.float32)
    xi, yi = int(np.rint(e["xt"])), int(np.rint(e["yt"]))
    c = size // 2
    sig = psf_batch(e, [e["xt"]], [e["yt"]], size)[0] * (1e-9 / e["omega"])
    ys, xs = slice(yi - c, yi - c + size), slice(xi - c, xi - c + size)
    ny, nx = img.shape
    y0, y1, x0, x1 = max(0, ys.start), min(ny, ys.stop), max(0, xs.start), min(nx, xs.stop)
    img[y0:y1, x0:x1] = sig[y0 - ys.start:y1 - ys.start, x0 - xs.start:x1 - xs.start]
    return img


def noise_per_exposure(e, rng, n=300):
    """Empirical per-exposure sigma of the matched flux (mJy): 1.4826 MAD over random positions (stars
    included, so it is a conservative whole-cutout figure); also the ratio to the formal sigma."""
    ny, nx = e["P"].shape
    xs, ys = rng.uniform(10, nx - 11, n), rng.uniform(10, ny - 11, n)
    F, S = matched(e, e["P"], xs, ys)
    g = np.isfinite(F)
    mad = 1.4826 * np.median(np.abs(F[g] - np.median(F[g])))
    pv = e["P"][e["W"] > 0]
    e["sigpix"] = float(1.4826 * np.median(np.abs(pv - np.median(pv))))
    return float(mad), float(mad / np.median(S[g]))


# ============================================================== step 1
def sky_grid_wcs(field):
    fc = FIELDS[field]
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [fc["ra"], fc["dec"]]
    w.wcs.crpix = [(GRID_N + 1) / 2.0, (GRID_N + 1) / 2.0]
    w.wcs.cdelt = [-PIX / 3600.0, PIX / 3600.0]
    return w


def build_stacks(field, exps, gw, tmpl, cache):
    """Per-visit inverse-variance stacks on the sky grid: clean stack, unit-flux (1 mJy) body stack,
    summed weight. Bilinear resampling. Cached in data/phasec/distant_<field>_step1.npz."""
    if cache.exists():
        d = np.load(cache)
        return {k: d[k] for k in d.files}
    gy, gx = np.mgrid[0:GRID_N, 0:GRID_N].astype(float)
    ra, dec = gw.all_pix2world(gx, gy, 0)
    out = {}
    for k in "ABC":
        out[f"S_{k}"] = np.zeros((GRID_N, GRID_N))
        out[f"T_{k}"] = np.zeros((GRID_N, GRID_N))
        out[f"W_{k}"] = np.zeros((GRID_N, GRID_N))
    for i, e in enumerate(exps):
        xs, ys = e["wcs"].all_world2pix(ra, dec, 0)
        coords = [ys.ravel(), xs.ravel()]
        valid = map_coordinates((e["W"] > 0).astype(np.float32), coords, order=1, mode="constant", cval=0.0)
        valid = (valid.reshape(GRID_N, GRID_N) > 0.99).astype(float)
        v = map_coordinates(e["P"], coords, order=1, mode="constant", cval=0.0).reshape(GRID_N, GRID_N)
        t = map_coordinates(tmpl[i], coords, order=1, mode="constant", cval=0.0).reshape(GRID_N, GRID_N)
        w = e["w"] * valid
        out[f"S_{e['visit']}"] += w * v
        out[f"T_{e['visit']}"] += w * t
        out[f"W_{e['visit']}"] += w
    for k in "ABC":
        den = np.where(out[f"W_{k}"] > 0, out[f"W_{k}"], np.nan)
        out[f"S_{k}"] = out[f"S_{k}"] / den
        out[f"T_{k}"] = out[f"T_{k}"] / den
    np.savez_compressed(cache, **out)
    return out


def robust_sigma(a):
    a = a[np.isfinite(a)]
    return 1.4826 * np.median(np.abs(a - np.median(a)))


def centroid(filt, center, radius, sign):
    """Flux-weighted centroid (grid px, x then y) of sign*filt above 25 percent of its peak inside a
    circle of `radius` px around `center` (x, y)."""
    yy, xx = np.mgrid[0:filt.shape[0], 0:filt.shape[1]]
    m = np.hypot(xx - center[0], yy - center[1]) <= radius
    f = np.where(m & np.isfinite(filt), sign * filt, -np.inf)
    j, i = np.unravel_index(np.argmax(f), f.shape)
    pk = f[j, i]
    w = np.where(m & np.isfinite(filt) & (sign * filt > 0.25 * pk), sign * filt, 0.0)
    return np.array([(w * xx).sum() / w.sum(), (w * yy).sum() / w.sum()]), pk, (i, j)


def pair_rank(filt, sig, pA, pB, thr=3.5, smin=7.0, smax=45.0, rad=14.0):
    """Blind pair search on the filtered difference: every local maximum above thr sigma paired with every
    local minimum below -thr sigma that is smin-smax px away; score = min(+S/N, -S/N). Returns the rank
    of the injected pair (peaks within rad px of the truth arc centres; 1 = best), number of candidate
    pairs, and the score of the truth pair in sigma. rank None when either truth lobe is below thr."""
    from scipy.ndimage import maximum_filter, minimum_filter
    f = np.nan_to_num(filt)
    inner = np.zeros(f.shape, bool)
    inner[20:-20, 20:-20] = True
    pk = np.argwhere((f == maximum_filter(f, 9)) & (f > thr * sig) & inner)
    nk = np.argwhere((f == minimum_filter(f, 9)) & (f < -thr * sig) & inner)
    out = dict(rank=None, n_pairs=0, truth_score=None, n_pos=len(pk), n_neg=len(nk))
    if len(pk) == 0 or len(nk) == 0:
        return out
    vp = f[pk[:, 0], pk[:, 1]] / sig
    vn = -f[nk[:, 0], nk[:, 1]] / sig
    d = np.hypot(pk[:, None, 1] - nk[None, :, 1], pk[:, None, 0] - nk[None, :, 0])
    score = np.minimum(vp[:, None], vn[None, :]) * ((d >= smin) & (d <= smax))
    out["n_pairs"] = int((score > 0).sum())
    ip = np.where(np.hypot(pk[:, 1] - pA[0], pk[:, 0] - pA[1]) <= rad)[0]
    jn = np.where(np.hypot(nk[:, 1] - pB[0], nk[:, 0] - pB[1]) <= rad)[0]
    if len(ip) == 0 or len(jn) == 0:
        return out
    ts = score[np.ix_(ip, jn)].max()
    out["truth_score"] = float(ts)
    if ts <= 0:
        return out
    # pairs not involving a truth lobe that beat the truth score
    mask = np.ones(score.shape, bool)
    mask[ip, :] = False
    mask[:, jn] = False
    out["rank"] = 1 + int((score[mask] > ts).sum())
    return out


def step1(stacks, ab, exps_pos, gw, ab_flux_mjy):
    """Difference A - B for a body of flux (mJy); returns dict with filtered map, S/N, centroids."""
    DA = stacks["S_A"] + ab_flux_mjy * stacks["T_A"]
    DB = stacks["S_B"] + ab_flux_mjy * stacks["T_B"]
    diff = DA - DB
    valid = np.isfinite(diff)
    diff0 = np.where(valid, diff, 0.0)
    filt = gaussian_filter(diff0, SIGF)
    filt = np.where(valid, filt, np.nan)
    sig = robust_sigma(filt[10:-10, 10:-10])
    return dict(diff=diff, filt=filt, sigma=sig, DA=DA, DB=DB)


# ============================================================== step 2
def predict_xy(e, aA_vec, tA, motion, D, mjd_ref=None):
    """Native cutout pixel positions of a body at trial distances D (array) for exposure e, data seat's
    model: u_ref(D) from the apparent direction aA_vec at tA, linear heliocentric motion (arcsec/yr)."""
    D = np.atleast_1d(np.asarray(D, float))
    uref = T.helio_from_apparent(aA_vec, D, T.earth_helio_au(tA))
    if motion is None or not np.any(motion):
        ui = uref
    else:
        off = np.asarray(motion, float) * (e["mjd"] - tA) / T.YEAR_D
        ui = T.add_tangent_offset(uref, off)
    app = T.apparent_vec(ui, D[:, None], T.earth_helio_au(e["mjd"]))
    ra, dec = T.u_to_radec(app)
    x, y = e["wcs"].all_world2pix(ra, dec, 0)
    return np.asarray(x), np.asarray(y)


def curve(exps_c, aA_vec, tA, motion, D, tmpl_c, null_shift_arcsec=None):
    """Per-exposure matched fluxes of the clean cutouts (Fc) and of the unit body (Ft), shape (n, nD)."""
    n = len(exps_c)
    Fc = np.full((n, D.size), np.nan)
    Ft = np.full((n, D.size), np.nan)
    for i, e in enumerate(exps_c):
        x, y = predict_xy(e, aA_vec, tA, motion, D)
        Fc[i], _ = matched(e, e["P"], x, y)
        Ft[i], _ = matched(e, tmpl_c[i], x, y)
    return Fc, Ft


def snr_curve(Fc, Ft, sig, flux, boot=None, clip=4.0):
    """Combined flux and S/N vs D. boot: integer weights (n,) to resample exposures. Exposures whose
    flux differs from the median over exposures by more than clip * their sigma are dropped (a field
    star landing on the tracked position in one exposure); the body is the same in every exposure."""
    F = Fc + flux * Ft
    w = 1.0 / sig[:, None] ** 2
    with np.errstate(all="ignore"):
        med = np.nanmedian(F, axis=0)
    ok = np.isfinite(F) & (np.abs(F - med[None, :]) <= clip * sig[:, None])
    if boot is not None:
        w = w * boot[:, None]
    sw = np.nansum(np.where(ok, w, 0.0), axis=0)
    sf = np.nansum(np.where(ok, w * F, 0.0), axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        comb = sf / sw
        sn = comb * np.sqrt(sw)
    sn = np.where(sw > 0, sn, np.nan)
    return comb, sn


def peak_and_error(D, sn):
    """Peak D (parabolic refinement) and the interval where S/N^2 >= peak^2 - 1 (delta chi^2 = 1)."""
    s = np.where(np.isfinite(sn), sn, -np.inf)
    j = int(np.argmax(s))
    Dp = D[j]
    if 0 < j < D.size - 1 and np.isfinite(s[j - 1]) and np.isfinite(s[j + 1]):
        a, b, c = s[j - 1], s[j], s[j + 1]
        den = a - 2 * b + c
        if den < 0:
            Dp = D[j] + 0.5 * (a - c) / den * (D[1] - D[0])
    pk = s[j]
    inside = np.where(s ** 2 >= pk ** 2 - 1.0)[0]
    # contiguous run around j
    lo = j
    while lo - 1 >= 0 and s[lo - 1] ** 2 >= pk ** 2 - 1.0:
        lo -= 1
    hi = j
    while hi + 1 < D.size and s[hi + 1] ** 2 >= pk ** 2 - 1.0:
        hi += 1
    return float(Dp), float(pk), (float(D[lo]), float(D[hi]))


def bootstrap_peak(D, Fc, Ft, sig, flux, rng, nb=200):
    n = Fc.shape[0]
    out = []
    for _ in range(nb):
        cnt = np.bincount(rng.integers(0, n, n), minlength=n).astype(float)
        _, sn = snr_curve(Fc, Ft, sig, flux, boot=cnt)
        out.append(peak_and_error(D, sn)[0])
    return np.array(out)


def tracked_stack(exps_c, tmpl_c, sig, aA_vec, tA, motion, D, flux, half=20):
    """Tracked stack image (sky-aligned, 6.15"/px, 2*half+1 square) centred on the predicted position at D."""
    n = 2 * half + 1
    gy, gx = np.mgrid[-half:half + 1, -half:half + 1].astype(float)
    vals, wts = [], []
    for i, e in enumerate(exps_c):
        uref = T.helio_from_apparent(aA_vec, np.array([D]), T.earth_helio_au(tA))[0]
        ui = T.add_tangent_offset(uref, np.asarray(motion) * (e["mjd"] - tA) / T.YEAR_D) if motion is not None else uref
        app = T.apparent_vec(ui, D, T.earth_helio_au(e["mjd"]))
        off = np.stack([-gx.ravel() * PIX, gy.ravel() * PIX], axis=1)       # east is -x on a north-up image
        v = T.add_tangent_offset(app, off)
        ra, dec = T.u_to_radec(v)
        x, y = e["wcs"].all_world2pix(ra, dec, 0)
        img = e["P"] + flux * tmpl_c[i]
        val = map_coordinates(img, [y, x], order=1, mode="constant", cval=0.0).reshape(n, n)
        wv = map_coordinates((e["W"] > 0).astype(np.float32), [y, x], order=1, mode="constant", cval=0.0).reshape(n, n)
        vals.append(np.where(wv > 0.99, val, np.nan))
        wts.append(1.0 / sig[i] ** 2)
    vals, wts = np.array(vals), np.array(wts)
    med = np.nanmedian(vals, axis=0)
    sp = np.array([e["sigpix"] for e in exps_c])
    keep = np.isfinite(vals) & (np.abs(vals - med[None]) <= 5.0 * sp[:, None, None])
    w = wts[:, None, None] * keep
    den = w.sum(0)
    num = np.nansum(w * np.where(keep, vals, 0.0), axis=0)
    return np.where(den > 0, num / np.where(den > 0, den, 1), np.nan)


def tracked_peak(img, sigma_flux_per_pix=None, filt_sigma=1.0):
    """Peak S/N and offset (px; east +, north +) of the filtered tracked stack from its centre."""
    n = img.shape[0]
    h = n // 2
    f = gaussian_filter(np.nan_to_num(img), filt_sigma)
    sig = robust_sigma(f)
    j, i = np.unravel_index(np.argmax(f[5:-5, 5:-5]), f[5:-5, 5:-5].shape)
    j, i = j + 5, i + 5
    # sub-pixel by centroid around the peak
    sl = (slice(j - 2, j + 3), slice(i - 2, i + 3))
    w = np.clip(f[sl] - 0.5 * f[j, i], 0, None)
    yy, xx = np.mgrid[j - 2:j + 3, i - 2:i + 3]
    cx, cy = (w * xx).sum() / w.sum(), (w * yy).sum() / w.sum()
    return float(f[j, i] / sig), (-(cx - h), cy - h), f


# ============================================================== main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", default="barnard", choices=list(VISITS))
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--ab-bright", type=float, default=None)
    ap.add_argument("--ab-faint", type=float, default=None)
    ap.add_argument("--nulls", type=int, default=40)
    args = ap.parse_args()
    field = args.field
    visits = VISITS[field]
    fc = FIELDS[field]
    rng = np.random.default_rng(13)
    PHASEC.mkdir(parents=True, exist_ok=True)
    FIGURES.mkdir(parents=True, exist_ok=True)
    res = dict(script="13_distant_body.py", field=field, visits=visits, d_true_au=D_TRUE)

    # ---------------------------------------------------------- geometry
    log("== geometry: both candidate fields")
    gt = geometry_table()
    hdr = ("field", "ecl_lat", "dtAB", "dtAC", "span A/B/C d", "par AB px", "par AC px", "px/pct AC", "px/pct AB", "angle")
    print("  %-8s %7s %6s %6s %-15s %7s %7s %9s %9s %6s" % hdr)
    for r in gt:
        print("  %-8s %7.1f %6.1f %6.1f %-15s %7.1f %7.1f %9.3f %9.3f %6.0f" % (
            r["field"], r["ecl_lat"], r["dtAB"], r["dtAC"],
            "%.0f/%.0f/%.0f" % (r["span_A"], r["span_B"], r["span_C"]), r["parallax_AB_px"], r["parallax_AC_px"],
            r["pxpct_AC"], r["pxpct_AB"], r["angle_parallaxAC_vs_motion"]))
    res["geometry_candidates"] = gt

    d_idx = Table.read(DATA / f"index_{field}.csv")
    mj_all = {k: np.asarray(d_idx["mjd_mid"][d_idx["visit"] == visits[k]], float) for k in "ABC"}
    mj_mean = {k: float(v.mean()) for k, v in mj_all.items()}
    tA, tB, tC = mj_mean["A"], mj_mean["B"], mj_mean["C"]
    all_mjd = np.concatenate(list(mj_all.values()))
    orbit = T.orbit_centered(fc["ra"], fc["dec"], D_TRUE, tA, all_mjd)
    c_u = T.radec_to_u(fc["ra"], fc["dec"])
    log(f"orbit: a={orbit.a} au P={orbit.period_yr:.0f} yr rate={orbit.rate_arcsec_yr:.2f} arcsec/yr "
        f"inc={orbit.inc_deg:.2f} deg ecliptic lat of body {orbit.ecl_lat_deg:.2f}")

    # Earth-vector cross-check vs astropy
    xc = T.crosscheck_vs_astropy(fc["ra"], fc["dec"], D_TRUE, all_mjd[::max(1, len(all_mjd) // 40)])
    log("astropy cross-check (parallax offset of a 500 au body, arcsec): "
        f"max |ours - astropy| (same barycentric reference) = {xc['d_earth'].max():.4f}; "
        f"max |ours(vs heliocentric dir) - astropy(vs barycentric dir)| = {xc['d_convention'].max():.3f} "
        f"({xc['d_convention'].max() / PIX:.3f} px); heliocentric-vs-barycentric direction of the body "
        f"{xc['d_ref'].min():.2f}-{xc['d_ref'].max():.2f}; n epochs {len(xc['d_earth'])}")
    res["astropy_crosscheck"] = dict(
        n_epochs=len(xc["d_earth"]),
        max_earth_vector_diff_arcsec=metric(float(xc["d_earth"].max()), "arcsec", len(xc["d_earth"]), note="ours vs astropy GCRS(500 au) - GCRS(infinity), same barycentric reference direction"),
        max_convention_diff_arcsec=metric(float(xc["d_convention"].max()), "arcsec", len(xc["d_earth"]), note="ours (apparent - heliocentric direction) vs astropy (apparent - barycentric direction); the Sun's barycentric offset / D"),
        convention_diff_px=float(xc["d_convention"].max() / PIX))

    # curvature residual of the heliocentric track vs best linear model
    curv = {}
    for name, (t0, t1) in dict(one_year=(tA, tA + 365.25), visit_span=(tA - np.ptp(mj_all["A"]) / 2, tB + np.ptp(mj_all["B"]) / 2)).items():
        ts = np.linspace(t0, t1, 200)
        m, ur, rs = T.fit_linear_motion(orbit, ts, tA)
        curv[name] = dict(motion_arcsec_yr=[float(m[0]), float(m[1])], max_arcsec=float(np.abs(rs).max()),
                          max_px=float(np.abs(rs).max() / PIX), span_days=float(t1 - t0))
        log(f"curvature residual ({name}, {t1 - t0:.0f} d): max {np.abs(rs).max():.2e} arcsec = {np.abs(rs).max() / PIX:.2e} px "
            f"(motion {np.hypot(*m):.2f} arcsec/yr = {np.hypot(*m) / PIX:.2f} px/yr)")
    # circular-orbit great circle: also quote the fit when the model is anchored at the VISIT-A date but
    # evaluated at C and B epochs
    res["curvature_residual"] = curv
    m_true, u_ref_true, _ = T.fit_linear_motion(orbit, np.linspace(tA, tB, 100), tA)
    res["motion_true_arcsec_yr"] = [float(m_true[0]), float(m_true[1])]

    # ---------------------------------------------------------- data
    log("== loading exposures")
    exps = load_exposures(field, visits, orbit)
    exps = [e for e in exps if e["inside"]]
    log(f"exposures used (body inside the cutout with 8 px margin): " +
        ", ".join(f"{k}={sum(e['visit'] == k for e in exps)}" for k in "ABC"))
    for e in exps:
        e["sig"], e["noise_ratio"] = noise_per_exposure(e, rng)
        e["w"] = 1.0 / e["sig"] ** 2
    ratios = np.array([e["noise_ratio"] for e in exps])
    log(f"empirical/formal noise ratio: median {np.median(ratios):.2f} (range {ratios.min():.2f}-{ratios.max():.2f}); "
        f"per-exposure sigma median {np.median([e['sig'] for e in exps]) * 1e3:.1f} uJy "
        f"(5 sigma = AB {-2.5 * np.log10(5 * np.median([e['sig'] for e in exps]) * 1e-3 / 3631.0):.2f})")
    tmpl = [template(e) for e in exps]
    exps_c = [e for e in exps if e["visit"] == "C"]
    tmpl_c = [t for t, e in zip(tmpl, exps) if e["visit"] == "C"]
    sig_c = np.array([e["sig"] for e in exps_c])
    # per-visit effective epochs: exposure-mean
    log(f"visit mean MJD A {tA:.2f} B {tB:.2f} C {tC:.2f}; dt AB {tB - tA:.1f} d AC {tC - tA:.1f} d")

    # ---------------------------------------------------------- step 1 stacks
    gw = sky_grid_wcs(field)
    cache = PHASEC / f"distant_{field}_step1_v2.npz"
    if args.refresh and cache.exists():
        cache.unlink()
    log("== step 1: building visit stacks (bilinear, sky grid)")
    stacks = build_stacks(field, exps, gw, tmpl, cache)
    # mask catalogue stars (Gaia DR3, G < 13, propagated to both visit epochs) in the visit stacks: their
    # colour-dependent residuals dominate the untracked difference. Disc radius (grid px) by magnitude.
    from wp.gaia import query_field, propagate
    gaia = query_field(field)
    gaia = gaia[np.asarray(gaia["phot_g_mean_mag"]) < 13.0]
    gmag = np.asarray(gaia["phot_g_mean_mag"], float)
    rad = np.where(gmag < 10, 14.0, np.where(gmag < 12, 8.0, 5.0))
    smask = np.zeros((GRID_N, GRID_N), bool)
    yy_, xx_ = np.mgrid[0:GRID_N, 0:GRID_N]
    for tt_ in (tA, tB):
        gra, gde, _ = propagate(gaia, tt_)
        gx, gy = gw.all_world2pix(gra, gde, 0)
        for x_, y_, r_ in zip(gx, gy, rad):
            if -20 < x_ < GRID_N + 20 and -20 < y_ < GRID_N + 20:
                x0_, x1_ = max(0, int(x_ - r_ - 1)), min(GRID_N, int(x_ + r_ + 2))
                y0_, y1_ = max(0, int(y_ - r_ - 1)), min(GRID_N, int(y_ + r_ + 2))
                if x1_ > x0_ and y1_ > y0_:
                    smask[y0_:y1_, x0_:x1_] |= np.hypot(xx_[y0_:y1_, x0_:x1_] - x_, yy_[y0_:y1_, x0_:x1_] - y_) <= r_
    log(f"star mask: {len(gaia)} Gaia stars G < 13 (both epochs), {100 * smask.mean():.1f} percent of the step 1 grid masked")
    stacks = {k: (np.where(smask, np.nan, v) if k[0] in "STW" and k[1] == "_" and k[2] in "AB" else v) for k, v in stacks.items()}
    res["star_mask_percent"] = float(100 * smask.mean())

    # step 1 sensitivity from the unit-body stack and the clean difference
    base = step1(stacks, None, None, gw, 0.0)
    unit = step1(stacks, None, None, gw, 1.0)
    tdiff = gaussian_filter(np.nan_to_num(stacks["T_A"] - stacks["T_B"]), SIGF)
    pkA, pkB = np.nanmax(tdiff), np.nanmin(tdiff)           # per mJy
    sig1 = base["sigma"]
    s1_per_mjy = 0.5 * (pkA - pkB) / sig1                  # S/N at each lobe per mJy (mean of |+| and |-|)
    f5_step1 = 5.0 / s1_per_mjy
    ab5_step1 = -2.5 * np.log10(f5_step1 * 1e-3 / 3631.0)
    log(f"step 1: filtered-difference sigma {sig1:.4g} MJy/sr; body lobe peak per mJy {pkA:.4g}/{pkB:.4g}; "
        f"5 sigma lobe = {f5_step1 * 1e3:.2f} uJy = AB {ab5_step1:.2f}")
    # step 2 sensitivity at the true D: stack of visit C
    F0c, F0t = curve(exps_c, T.apparent_vec(orbit.u(tA), D_TRUE, T.earth_helio_au(tA)), tA,
                     np.array(res["motion_true_arcsec_yr"]), np.array([D_TRUE]), tmpl_c)
    sigF_c = 1.0 / np.sqrt(np.nansum(1.0 / sig_c ** 2))
    f5_step2 = 5.0 * sigF_c
    ab5_step2 = -2.5 * np.log10(f5_step2 * 1e-3 / 3631.0)
    log(f"step 2: tracked stack of visit C ({len(exps_c)} exposures): sigma_F = {sigF_c * 1e3:.2f} uJy; "
        f"5 sigma = {f5_step2 * 1e3:.2f} uJy = AB {ab5_step2:.2f}; check Ft at truth: median {np.nanmedian(F0t):.3f}")
    # step 1 blind-rank limit: scan the brightness (the filtered difference is linear in the flux)
    valid0 = np.isfinite(stacks["S_A"]) & np.isfinite(stacks["S_B"])
    filt0 = np.where(valid0, gaussian_filter(np.where(valid0, stacks["S_A"] - stacks["S_B"], 0.0), SIGF), np.nan)
    filtu = gaussian_filter(np.where(valid0, np.nan_to_num(stacks["T_A"] - stacks["T_B"]), 0.0), SIGF)
    tp0 = {}
    for k in "AB":
        ps = [gw.all_world2pix(*T.u_to_radec(T.apparent_vec(orbit.u(m), D_TRUE, T.earth_helio_au(m))), 0) for m in mj_all[k]]
        tp0[k] = np.mean(np.array(ps), axis=0)
    ab_scan = np.arange(11.0, 20.01, 0.25)
    ranks = []
    for ab in ab_scan:
        fl = float(inject.ab_to_mjy(ab) * 1e9)
        r_ = pair_rank(filt0 + fl * np.where(valid0, filtu, np.nan), sig1, tp0["A"], tp0["B"])
        ranks.append(r_)
    print("  step 1 blind pair rank (1 = the injected pair has the highest pair score among all +/- peak pairs 7-45 px apart):")
    print("  " + "  ".join("%.2f:%s" % (ab, "-" if r_["rank"] is None else r_["rank"]) for ab, r_ in zip(ab_scan, ranks)))
    ab_rank1 = None
    for ab, r_ in zip(ab_scan, ranks):
        if r_["rank"] == 1:
            ab_rank1 = float(ab)
        else:
            if ab_rank1 is not None and ab > ab_rank1 + 1.0:
                break
    # limit = faintest AB in the first unbroken run of rank 1 from the bright end (allow 0.5 mag of gaps)
    run, last = [], None
    for ab, r_ in zip(ab_scan, ranks):
        if r_["rank"] == 1:
            if last is None or ab - last <= 0.5 + 1e-9:
                last = float(ab)
        elif last is not None and ab - last > 0.5 + 1e-9:
            break
    ab_step1_rank = last
    log(f"step 1 blind-rank limit: AB {ab_step1_rank}")
    ab_ref = ab_step1_rank if ab_step1_rank is not None else ab5_step1
    ab_bright = args.ab_bright if args.ab_bright is not None else round(ab_ref - 1.5, 2)
    ab_faint = args.ab_faint if args.ab_faint is not None else round(ab_ref, 2)
    abs_ = dict(bright=ab_bright, faint=ab_faint)
    log(f"chosen brightnesses: bright AB {ab_bright} (1.5 mag above the step 1 blind-rank limit), faint AB {ab_faint} (at it)")
    res["brightness"] = dict(bright_ab=ab_bright, faint_ab=ab_faint,
                             step1_5sigma_ab=metric(float(ab5_step1), "AB", note="5 sigma per lobe of the filtered A-B stack difference, step 1 untracked"),
                             step2_5sigma_ab=metric(float(ab5_step2), "AB", len(exps_c), note="5 sigma in the tracked stack of visit C at the true D, single known-D trial"))

    res["pairs"] = {}
    models_out = {}
    fig1, ax1 = plt.subplots(2, 4, figsize=(17, 8.2))
    cache_models = {}
    for row, (lab, ab) in enumerate(abs_.items()):
        flux = float(inject.ab_to_mjy(ab) * 1e9)             # mJy
        s1 = step1(stacks, ab, None, gw, flux)
        filt, sig = s1["filt"], s1["sigma"]
        # truth arc mean positions on the grid (exposure-mean of apparent positions)
        tpos = {}
        for k in "AB":
            ps = []
            for m in mj_all[k]:
                ra, dec = T.u_to_radec(T.apparent_vec(orbit.u(m), D_TRUE, T.earth_helio_au(m)))
                ps.append(gw.all_world2pix(ra, dec, 0))
            tpos[k] = np.mean(np.array(ps), axis=0)
        smear = {k: float(np.ptp(np.array([gw.all_world2pix(*T.u_to_radec(T.apparent_vec(orbit.u(m), D_TRUE, T.earth_helio_au(m))), 0) for m in mj_all[k]]), axis=0).max()) for k in "AB"}
        cA, pkA_, _ = centroid(filt, tpos["A"], 14.0 + smear["A"] / 2, +1)
        cB, pkB_, _ = centroid(filt, tpos["B"], 14.0 + smear["B"] / 2, -1)
        snA, snB = pkA_ / sig, pkB_ / sig
        # blind: global extrema of the filtered map
        inner = np.zeros_like(filt, bool)
        inner[20:-20, 20:-20] = True
        fz = np.where(inner & np.isfinite(filt), filt, 0.0)
        jP, iP = np.unravel_index(np.argmax(fz), fz.shape)
        jN, iN = np.unravel_index(np.argmin(fz), fz.shape)
        blindP = np.hypot(iP - tpos["A"][0], jP - tpos["A"][1]) < 14 + smear["A"] / 2
        blindN = np.hypot(iN - tpos["B"][0], jN - tpos["B"][1]) < 14 + smear["B"] / 2
        # false peaks: local maxima above 5 sigma (and minima below -5 sigma) outside the truth windows
        from scipy.ndimage import maximum_filter, minimum_filter
        mx = (filt == maximum_filter(np.nan_to_num(filt), 9)) & (filt > 5 * sig) & inner
        mn = (filt == minimum_filter(np.nan_to_num(filt), 9)) & (filt < -5 * sig) & inner
        yy, xx = np.mgrid[0:GRID_N, 0:GRID_N]
        near = lambda p, r: np.hypot(xx - p[0], yy - p[1]) < r        # noqa: E731
        nfp = int((mx & ~near(tpos["A"], 14 + smear["A"] / 2)).sum())
        nfn = int((mn & ~near(tpos["B"], 14 + smear["B"] / 2)).sum())
        # pair statistic: for every position r, filt(r) - filt(r + v) with v the measured separation
        sep = cB - cA
        T_stat = np.full_like(filt, np.nan)
        vi, vj = int(round(sep[0])), int(round(sep[1]))
        sh = np.roll(np.roll(filt, -vj, axis=0), -vi, axis=1)
        T_stat = filt - sh
        sigT = robust_sigma(T_stat[20:-20, 20:-20])
        # how many pair candidates (T > 5 sigma_T) exist outside the truth window
        Tm = np.where(inner, np.nan_to_num(T_stat), 0.0)
        cand = (Tm == maximum_filter(Tm, 9)) & (Tm > 5 * sigT)
        nfp_pair = int((cand & ~near(tpos["A"], 14 + smear["A"] / 2)).sum())
        tcen = T_stat[int(round(cA[1])), int(round(cA[0]))] / sigT
        # positions -> sky
        raA, decA = gw.all_pix2world(cA[0], cA[1], 0)
        raB, decB = gw.all_pix2world(cB[0], cB[1], 0)
        aA, aB = T.radec_to_u(float(raA), float(decA)), T.radec_to_u(float(raB), float(decB))
        # truth apparent mean (exposure mean) in arcsec for the error
        errA = (cA - tpos["A"])
        errB = (cB - tpos["B"])
        motion_meas = T.tangent_offset_arcsec(aA, aB) / (tB - tA) * T.YEAR_D          # arcsec/yr, (east, north)
        sepm = np.hypot(*(cB - cA))
        sept = np.hypot(*(tpos["B"] - tpos["A"]))
        log(f"-- step 1, AB {ab} ({lab}): lobes S/N +{snA:.1f} / -{abs(snB):.1f}; blind global extremum on the body: "
            f"+{blindP} -{blindN}; other >5 sigma blobs: {nfp} positive, {nfn} negative; pair stat at truth {tcen:.1f} sigma_T "
            f"(other >5 sigma pairs {nfp_pair}); smear A {smear['A']:.1f} px B {smear['B']:.1f} px")
        log(f"   centroid error A ({errA[0]:+.2f},{errA[1]:+.2f}) px, B ({errB[0]:+.2f},{errB[1]:+.2f}) px; pair separation measured "
            f"{sepm:.1f} px vs true {sept:.1f} px; measured motion {np.hypot(*motion_meas) / PIX:.2f} px/yr")
        res["pairs"][lab] = dict(ab=ab, rank_info=pair_rank(filt, sig, tpos["A"], tpos["B"]), flux_ujy=flux * 1e3, snr_pos_lobe=float(snA), snr_neg_lobe=float(snB),
                                 blind_global_extremum_on_body=[bool(blindP), bool(blindN)],
                                 other_pos_blobs_gt5=nfp, other_neg_blobs_gt5=nfn, pair_stat_sigma=float(tcen),
                                 other_pairs_gt5=nfp_pair, smear_px=smear,
                                 centroid_err_px=[errA.tolist(), errB.tolist()],
                                 separation_measured_px=float(sepm), separation_true_px=float(sept),
                                 motion_measured_px_yr=float(np.hypot(*motion_meas) / PIX))
        cache_models[lab] = dict(aA=aA, aB=aB, motion=motion_meas, flux=flux, ab=ab, cA=cA, cB=cB, tpos=tpos)
        # ---- figure
        hw = 60
        ctr = 0.5 * (tpos["A"] + tpos["B"])
        sl = (slice(int(ctr[1]) - hw, int(ctr[1]) + hw), slice(int(ctr[0]) - hw, int(ctr[0]) + hw))
        ext = [sl[1].start - 0.5, sl[1].stop - 0.5, sl[0].stop - 0.5, sl[0].start - 0.5]
        vmax = 5 * robust_sigma(s1["DA"][10:-10, 10:-10])
        for col, (img, ttl) in enumerate([(s1["DA"], f"visit A stack (day {tA - tA:.0f})"), (s1["DB"], f"visit B stack (+{tB - tA:.0f} d)")]):
            a = ax1[row, col]
            a.imshow(img[sl], origin="upper", extent=ext, cmap="gray", vmin=-vmax, vmax=vmax)
            a.set_title(f"{lab} AB {ab}: {ttl}", fontsize=9)
        a = ax1[row, 2]
        a.imshow(s1["diff"][sl], origin="upper", extent=ext, cmap="RdBu_r", vmin=-vmax, vmax=vmax)
        a.plot(*tpos["A"], "o", mfc="none", mec="k", ms=14)
        a.plot(*tpos["B"], "s", mfc="none", mec="k", ms=14)
        a.set_title(f"A - B (unfiltered), truth marked", fontsize=9)
        a = ax1[row, 3]
        a.imshow(filt[sl] / sig, origin="upper", extent=ext, cmap="RdBu_r", vmin=-8, vmax=8)
        a.plot(*cA, "+", c="k", ms=14, mew=2)
        a.plot(*cB, "x", c="k", ms=12, mew=2)
        a.plot([cA[0], cB[0]], [cA[1], cB[1]], "k--", lw=0.8)
        a.set_title(f"filtered A - B in sigma: +{snA:.1f} / {snB:.1f} sigma\nmeasured separation {sepm:.1f} px (true {sept:.1f})", fontsize=9)
        for a in ax1[row]:
            a.set_xlabel("sky grid x (px, east left)")
    fig1.suptitle(f"Step 1: untracked blink of visits A and B ({tB - tA:.0f} d apart), {field}, injected 500 au body "
                  f"(P = {orbit.period_yr:.0f} yr, {orbit.rate_arcsec_yr / PIX:.1f} px/yr). Stacks smeared by the within-visit parallax "
                  f"({res['pairs']['bright']['smear_px']['A']:.0f} px)", fontsize=10)
    fig1.tight_layout()
    fig1.savefig(FIGURES / "distant_step1.png", dpi=110)
    plt.close(fig1)
    log("wrote distant_step1.png")

    # ---------------------------------------------------------- step 2
    log("== step 2: tracked stacks of visit C")
    aA_true = T.apparent_vec(orbit.u(tA), D_TRUE, T.earth_helio_au(tA))
    cm = {}
    # oracle: true start (at the exposure-mean epoch) and best linear motion
    cm["oracle"] = dict(aA=aA_true, motion=np.array(res["motion_true_arcsec_yr"]))
    curves = {}
    for lab in ("bright", "faint"):
        m = cache_models[lab]
        for name, mot in (("naive", None), ("interp", m["motion"])):
            t1 = time.time()
            Fc, Ft = curve(exps_c, m["aA"], tA, mot, D_GRID, tmpl_c)
            curves[(lab, name)] = (Fc, Ft)
            log(f"  curves {lab}/{name}: {time.time() - t1:.1f}s")
    t1 = time.time()
    curves[("bright", "oracle")] = curve(exps_c, cm["oracle"]["aA"], tA, cm["oracle"]["motion"], D_GRID, tmpl_c)
    curves[("faint", "oracle")] = curves[("bright", "oracle")]
    log(f"  oracle curves {time.time() - t1:.1f}s")
    # sanity: oracle positions at D_TRUE reproduce the injected positions
    xo, yo = predict_xy(exps_c[0], aA_true, tA, cm["oracle"]["motion"], np.array([D_TRUE]))
    dpos = max(np.hypot(*(np.array(predict_xy(e, aA_true, tA, cm["oracle"]["motion"], np.array([D_TRUE]))).ravel() - [e["xt"], e["yt"]])) for e in exps_c)
    log(f"  oracle model vs injected position at D = {D_TRUE:.0f}: max difference {dpos:.4f} px over {len(exps_c)} exposures")
    res["oracle_position_check_px"] = float(dpos)

    # null distribution of the D-scan peak S/N (start positions shifted at random, no injection)
    null_pk = []
    Dn = np.arange(300.0, 800.0 + 1e-9, 0.5)
    m = cache_models["faint"]
    t1 = time.time()
    for _ in range(args.nulls):
        ang = rng.uniform(0, 2 * np.pi)
        r = rng.uniform(20, 45) * PIX
        a_n = T.add_tangent_offset(m["aA"], np.array([r * np.cos(ang), r * np.sin(ang)]))
        Fc, Ft = curve(exps_c, a_n, tA, m["motion"], Dn, tmpl_c)
        _, sn = snr_curve(Fc, Ft, sig_c, 0.0)
        null_pk.append(np.nanmax(sn))
    null_pk = np.array(null_pk)
    thr = float(np.quantile(null_pk, 0.95)) if len(null_pk) else 5.0
    log(f"  null D-scan (interp model, {len(null_pk)} random start offsets 20-45 px): peak S/N median {np.median(null_pk):.2f}, "
        f"max {null_pk.max():.2f}, 95th percentile {thr:.2f} ({time.time() - t1:.0f}s)")
    res["null_dscan_peak_snr"] = dict(n=len(null_pk), median=float(np.median(null_pk)), max=float(null_pk.max()), q95=thr)

    # recovered D table
    print()
    print("  Recovered distance (truth 500 au), visit C tracked stack, grid 300-800 au step 0.1")
    print("  %-7s %-7s %-7s %8s %8s %22s %8s %8s" % ("AB", "model", "case", "D (au)", "bias %", "stat err (dchi2=1 range)", "boot sd", "peak S/N"))
    rec = {}
    for lab in ("bright", "faint"):
        flux = cache_models[lab]["flux"]
        for name in ("naive", "interp", "oracle"):
            Fc, Ft = curves[(lab, name)]
            comb, sn = snr_curve(Fc, Ft, sig_c, flux)
            Dp, pk, (lo, hi) = peak_and_error(D_GRID, sn)
            bs = bootstrap_peak(D_GRID, Fc, Ft, sig_c, flux, rng)
            rec[(lab, name)] = dict(D=Dp, peak_snr=pk, lo=lo, hi=hi, boot_sd=float(np.std(bs)), boot_mean=float(np.mean(bs)),
                                    snr=sn)
            print("  %-7s %-7s %-7s %8.2f %8.2f %22s %8.2f %8.1f" % (
                cache_models[lab]["ab"], name, lab, Dp, (Dp / D_TRUE - 1) * 100, f"{lo:.1f}-{hi:.1f} ({(hi - lo) / 2:.2f})",
                np.std(bs), pk))
    res["recovered"] = {f"{lab}_{name}": dict(
        ab=cache_models[lab]["ab"], D_au=r["D"], bias_percent=(r["D"] / D_TRUE - 1) * 100,
        stat_interval_au=[r["lo"], r["hi"]], bootstrap_sd_au=r["boot_sd"], peak_snr=r["peak_snr"],
        peak_above_null_q95=bool(r["peak_snr"] > thr)) for (lab, name), r in rec.items()}

    # pixel shift per 1 percent of D for the actual dates
    uA = orbit.u(tA)
    ppp = {}
    for k, tt in (("A_to_C", tC), ("A_to_B", tB)):
        ppp[k] = T.px_per_percent(uA, D_TRUE, tA, tt)
    per_exp = [T.px_per_percent(uA, D_TRUE, tA, e["mjd"]) for e in exps_c]
    log(f"pixel shift per 1 percent of D: visit A -> C ({tC - tA:.0f} d) {ppp['A_to_C']:.3f} px (per-exposure range "
        f"{min(per_exp):.2f}-{max(per_exp):.2f}); A -> B ({tB - tA:.0f} d) {ppp['A_to_B']:.3f} px")
    res["px_per_percent"] = dict(A_to_C=metric(ppp["A_to_C"], "px per 1 percent of D", note=f"{tC - tA:.0f} d"),
                                 A_to_B=metric(ppp["A_to_B"], "px per 1 percent of D", note=f"{tB - tA:.0f} d"),
                                 per_exposure_C_range=[float(min(per_exp)), float(max(per_exp))])

    # ---------------------------------------------------------- tracked stacks at wrong D
    print()
    print("  Tracked stack of visit C at a wrong D (interp model, bright body): offset of the peak and peak S/N")
    print("  %-6s %-8s %-9s %-16s %-14s %-9s" % ("D err", "D (au)", "S/N (F)", "stack peak S/N", "offset (E,N) px", "|offset|"))
    wrong = [-10, -5, -1, 0, 1, 5, 10]
    fig2 = plt.figure(figsize=(18, 10))
    gs = fig2.add_gridspec(3, len(wrong), height_ratios=[1, 1, 1.15])
    tab = []
    for r_i, lab in enumerate(("bright", "faint")):
        m = cache_models[lab]
        _, snc = snr_curve(*curves[(lab, "interp")], sig_c, m["flux"])
        for c_i, pct in enumerate(wrong):
            Dw = D_TRUE * (1 + pct / 100.0)
            img = tracked_stack(exps_c, tmpl_c, sig_c, m["aA"], tA, m["motion"], Dw, m["flux"])
            pk, off, f = tracked_peak(img)
            j = int(np.argmin(np.abs(D_GRID - Dw)))
            tab.append(dict(brightness=lab, pct=pct, D=Dw, snr_F=float(snc[j]), snr_stack=pk, off_E=off[0], off_N=off[1]))
            if lab == "bright":
                print("  %+5d%% %8.1f %9.1f %16.1f   (%+5.1f,%+5.1f) %9.2f" % (pct, Dw, snc[j], pk, off[0], off[1], np.hypot(*off)))
            a = fig2.add_subplot(gs[r_i, c_i])
            h = img.shape[0] // 2
            a.imshow(f / robust_sigma(f), origin="lower", extent=[h + 0.5, -h - 0.5, -h - 0.5, h + 0.5], cmap="viridis", vmin=-3, vmax=max(8, pk))
            a.plot(0, 0, "+", c="w", ms=12)
            a.set_title(f"{lab} AB {m['ab']}  D {pct:+d}%\npeak {pk:.1f} sigma, offset ({off[0]:+.1f},{off[1]:+.1f}) px", fontsize=8)
            a.set_xticks([])
            a.set_yticks([])
    print()
    for lab in ("faint",):
        for t_ in tab:
            if t_["brightness"] == lab:
                print("  faint %+5d%% S/N(F) %6.1f stack peak %5.1f offset (%+5.1f,%+5.1f)" % (t_["pct"], t_["snr_F"], t_["snr_stack"], t_["off_E"], t_["off_N"]))
    res["wrong_distance_table"] = tab
    # offsets per percent from the table (bright)
    br = [t_ for t_ in tab if t_["brightness"] == "bright"]
    slope = np.polyfit([t_["pct"] for t_ in br if abs(t_["pct"]) <= 5], [np.hypot(t_["off_E"], t_["off_N"]) * np.sign(t_["pct"]) for t_ in br if abs(t_["pct"]) <= 5], 1)[0]
    log(f"measured offset slope (bright, |D err| <= 5 percent): {abs(slope):.2f} px per percent")
    res["measured_offset_px_per_percent"] = float(abs(slope))

    axc = fig2.add_subplot(gs[2, :])
    cols = dict(naive="tab:orange", interp="tab:blue", oracle="tab:green")
    for lab, ls in (("bright", "-"), ("faint", "--")):
        for name in ("naive", "interp", "oracle"):
            r = rec[(lab, name)]
            axc.plot(D_GRID, r["snr"], ls, c=cols[name], lw=1.2, label=f"{name}, AB {cache_models[lab]['ab']}: D = {r['D']:.1f} au")
    axc.axvline(D_TRUE, c="k", lw=0.8)
    axc.axhline(thr, c="gray", lw=0.8, ls=":")
    axc.set_xlabel("assumed distance D (au)")
    axc.set_ylabel("tracked-stack S/N (visit C)")
    axc.legend(fontsize=7, ncol=3)
    axc.set_xlim(300, 800)
    axc.set_title(f"S/N versus assumed D; dotted line = 95th percentile of the null D-scan peak ({thr:.1f})", fontsize=9)
    fig2.suptitle(f"Step 2: visit C ({tC - tA:.0f} d after A) tracked at a wrong distance; truth 500 au, interpolated motion model", fontsize=10)
    fig2.tight_layout()
    fig2.savefig(FIGURES / "distant_step2.png", dpi=110)
    plt.close(fig2)
    log("wrote distant_step2.png")

    # ---------------------------------------------------------- limits
    log("== limiting magnitude")
    sn_true = {}
    for lab in ("bright", "faint"):
        Fc, Ft = curves[(lab, "oracle")]
        j = int(np.argmin(np.abs(D_GRID - D_TRUE)))
        sn_true[lab] = float(snr_curve(Fc, Ft, sig_c, cache_models[lab]["flux"])[1][j])
    ab_lim_scan = -2.5 * np.log10(thr * sigF_c * 1e-3 / 3631.0)
    lim = dict(step1_5sigma_ab=float(ab5_step1), step2_5sigma_known_D_ab=float(ab5_step2),
               step2_null95_dscan_ab=float(ab_lim_scan),
               step1_blind_rank_ab=ab_step1_rank,
               two_step_ab=float(min(x for x in (ab_step1_rank if ab_step1_rank is not None else 99.0, ab_lim_scan))),
               criterion="step 1: the injected +/- pair has the highest pair score (min of the two lobe S/N, peaks above 3.5 sigma, 7-45 px apart) among all pairs in the filtered A-B difference (blind rank 1); "
                         "step 2: tracked stack of visit C, S/N at the D-scan peak above the 95th percentile of the null D-scan peaks (random start offsets)")
    log(f"step 1 limit (blind pair rank 1: AB {ab_step1_rank}; 5 sigma lobes only: AB {ab5_step1:.2f}) untracked, smeared; step 2 limit at known D (5 sigma): AB {ab5_step2:.2f}; "
        f"step 2 with D scan (null q95 {thr:.2f} sigma): AB {ab_lim_scan:.2f}; two-step limit (brighter of step 1 and 2): AB {lim['two_step_ab']:.2f}")
    res["limiting_magnitude"] = lim
    res["snr_at_true_D"] = sn_true

    # geometry/orbit figure
    fig3, ax3 = plt.subplots(1, 2, figsize=(11, 4.6))
    tt = np.linspace(tA - 20, tB + 40, 400)
    app = np.array([T.tangent_offset_arcsec(c_u, T.apparent_vec(orbit.u(t_), D_TRUE, T.earth_helio_au(t_))) / PIX for t_ in tt])
    hel = np.array([T.tangent_offset_arcsec(c_u, orbit.u(t_)) / PIX for t_ in tt])
    ax3[0].plot(app[:, 0], app[:, 1], "b-", lw=0.8, label="apparent (parallax + orbit)")
    ax3[0].plot(hel[:, 0] - hel[0, 0] + app[0, 0], hel[:, 1] - hel[0, 1] + app[0, 1], "r-", label="heliocentric track (shifted)")
    for k, col in zip("ABC", ("tab:green", "tab:purple", "tab:orange")):
        pp = np.array([T.tangent_offset_arcsec(c_u, T.apparent_vec(orbit.u(m_), D_TRUE, T.earth_helio_au(m_))) / PIX for m_ in mj_all[k]])
        ax3[0].plot(pp[:, 0], pp[:, 1], ".", c=col, label=f"visit {k} exposures")
    ax3[0].set_xlabel("east offset from field centre (px, 6.15 arcsec)")
    ax3[0].set_ylabel("north offset (px)")
    ax3[0].set_aspect("equal")
    ax3[0].legend(fontsize=7)
    ax3[0].set_title("500 au body: apparent track during the three visits", fontsize=9)
    ts = np.linspace(tA, tA + 730, 200)
    m1, _, rs = T.fit_linear_motion(orbit, ts, tA)
    ax3[1].plot(ts - tA, rs[:, 0], label="east")
    ax3[1].plot(ts - tA, rs[:, 1], label="north")
    ax3[1].set_xlabel("days from visit A")
    ax3[1].set_ylabel("Keplerian minus best linear model (arcsec)")
    ax3[1].set_title("curvature residual of the heliocentric track (2 years)", fontsize=9)
    ax3[1].legend(fontsize=7)
    fig3.tight_layout()
    fig3.savefig(FIGURES / "distant_geometry.png", dpi=110)
    plt.close(fig3)
    res["orbit"] = dict(a_au=D_TRUE, period_yr=orbit.period_yr, rate_arcsec_yr=orbit.rate_arcsec_yr, inc_deg=orbit.inc_deg,
                        ecl_lat_deg=orbit.ecl_lat_deg, psf="archive ePSF (wp.inject), flat F_nu",
                        n_exposures={k: sum(e["visit"] == k for e in exps) for k in "ABC"})
    res["step1_centroid_note"] = "centroid of the smeared arc = flux-weighted mean position; reference epoch taken as the exposure-mean MJD of the visit"
    # ---- worked example for the product seat
    import json as _json
    DEMO = ROOT.parent / "docs" / "prepared"
    DEMO.mkdir(parents=True, exist_ok=True)
    gw65 = WCS(naxis=2)
    gw65.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    gw65.wcs.crval = [fc["ra"], fc["dec"]]
    gw65.wcs.crpix = [33.0, 33.0]           # FITS 1-based centre of a 65 px grid = 0-based (32, 32)
    gw65.wcs.cdelt = [-PIX / 3600.0, PIX / 3600.0]
    ra_ref, dec_ref = T.apparent_radec(orbit.u(tA), D_TRUE, tA)
    ra_h, dec_h = T.u_to_radec(orbit.u(tA))
    visit_info = {}
    for k in "ABC":
        mm = mj_mean[k]
        rr, dd = T.apparent_radec(orbit.u(mm), D_TRUE, mm)
        xx, yy = gw65.all_world2pix(rr, dd, 0)
        visit_info[k] = dict(visit_index=visits[k], mean_mjd=round(mm, 4),
                             obs_ids=sorted({e["obs"] for e in exps if e["visit"] == k}),
                             expected_xy_65px_grid=[round(float(xx), 2), round(float(yy), 2)],
                             apparent_ra_dec_deg=[round(float(rr), 6), round(float(dd), 6)])
    demo = dict(
        note="Injected 500 au body, circular orbit, flat F_nu. Geometry of docs/method.md data-seat convention: apparent = normalize(D*u - E(t)), u heliocentric.",
        field=dict(name=FIELDS[field]["name"], key=field, ra_deg=fc["ra"], dec_deg=fc["dec"]),
        reference_mjd=round(tA, 4), reference_note="exposure-mean MJD of visit A",
        injected_apparent_ra_dec_deg_at_reference=[round(float(ra_ref), 6), round(float(dec_ref), 6)],
        injected_heliocentric_ra_dec_deg_at_reference=[round(float(ra_h), 6), round(float(dec_h), 6)],
        distance_au=D_TRUE,
        motion_arcsec_per_yr=dict(dra_cosdec=round(res["motion_true_arcsec_yr"][0], 3), ddec=round(res["motion_true_arcsec_yr"][1], 3),
                                  note="best linear heliocentric model of the Keplerian track; tangent plane at the heliocentric direction, reference = reference_mjd"),
        magnitude_ab=dict(flat=True, bright=ab_bright, faint=ab_faint),
        visits=visit_info,
        grid=dict(width=65, height=65, pixel_arcsec=6.15, north_up=True, east_left=True, origin_0_based=True,
                  centre_xy=[32, 32], centre_world="field centre (ra_deg, dec_deg)",
                  note="expected_xy is the body's apparent position at each visit's mean epoch on this grid; the body is tracked within a visit, so spread over the visit is a few to ~10 px"),
        step1_pair=dict(visits=["A", "B"], dt_days=round(tB - tA, 2), true_separation_px=res["pairs"]["bright"]["separation_true_px"],
                        measured_separation_px=res["pairs"]["bright"]["separation_measured_px"]),
        step2=dict(visit="C", dt_from_A_days=round(tC - tA, 2), px_per_percent_D=res["px_per_percent"]["A_to_C"]["value"]),
        recovered_distance_au={k: dict(D=round(v["D_au"], 2), bias_percent=round(v["bias_percent"], 2), stat_interval_au=[round(x, 2) for x in v["stat_interval_au"]], bootstrap_sd_au=round(v["bootstrap_sd_au"], 2), peak_snr=round(v["peak_snr"], 1))
                               for k, v in res["recovered"].items() if k.startswith("bright")})
    (DEMO / "planet-demo.json").write_text(_json.dumps(demo, indent=1) + "\n")
    update_results("distant_body", res)
    log("wrote results section distant_body")


if __name__ == "__main__":
    main()
