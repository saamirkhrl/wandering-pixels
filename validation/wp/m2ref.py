"""Reference implementation of the matched-photometry readout (docs/algorithm.md).

Small and dependency-light on purpose: numpy, astropy (sigma_clip; WCS and FITS only in
load_cutout) and photutils (exact circle-pixel overlap). It implements the seven steps of
docs/algorithm.md exactly; every constant lives in the table of constants below.

Conventions (same as wp/forced.py): pixels are 0-based, data[y, x], pixel (i, j) covers
[i-0.5, i+0.5]. P = IMAGE - ZODI in MJy/sr, fluxes are MJy/sr summed over native pixels.

Layers:
  measure_pixels(P, V, FL, x, y)         step 1-2, one exposure, one star
  load_cutout(path)                      read one Level 2 cutout (FITS) into arrays + WCS
  spec_model(lam, val, var, w0, b0)      step 3, one visit, one evaluation wavelength
  select_wavelengths(samples_A)          step 4
  compare_visits(samples_A, samples_B)   steps 4-7, one star, one visit pair
  assert_spec_equals_phaseb()            self test against wp.phaseb.spec_model
"""
from __future__ import annotations

import numpy as np

# ------------------------------------------------------------------ constants (docs/algorithm.md) --
BAD_DATA_BITS = (0, 2, 6, 7, 9, 10, 11, 14, 15, 26, 27)   # raw FLAGS bits, the website's BAD_DATA_MASK
BAD_DATA_MASK = sum(1 << b for b in BAD_DATA_BITS)
SATURATED_BITS = (1, 15, 26)                               # OVERFLOW, NONLINEAR, BLOOM
SATURATED_MASK = sum(1 << b for b in SATURATED_BITS)
SAT_HALF = 2                                               # central 5x5 for the saturation flag
APER_R = 2.0                                               # aperture radius, native pixels (12.3 arcsec)
ANN_IN, ANN_OUT = 4.0, 7.0                                 # annulus: ANN_IN <= r < ANN_OUT, native pixels
CLIP_SIGMA_BKG, CLIP_ITERS_BKG = 3.0, 5                    # background sigma clip
MIN_ANN = 10                                               # minimum annulus pixels
FLUX_FLOOR = 0.02                                          # fractional error floor, added in quadrature
MIN_SAMPLES = 3                                            # per-visit model
WINDOW_BW = 2.5                                            # model window half width, local bandwidths
CLIP_SIGMA = 4.0                                           # drop the single worst sample beyond this
SEP_BW = 5.0                                               # selected w0 must be > SEP_BW * b0 apart
PAIR_GAP_BW = 1.0                                          # paired stack: max |lam gap| in mean bandwidths
MIN_EXPOSURES = 8                                          # fewer accepted exposures -> 'partial_visit'
MIN_VISIT_EXPOSURES = 12                                   # inStack rule (applied by the caller)
Z_CHANGED = 3.0                                            # display threshold, not calibrated
BLEND_RADIUS_ARCSEC, BLEND_DMAG = 20.0, 3.0                # 'blended' flag
PIXEL_ARCSEC = 6.15


# ------------------------------------------------------------------ step 1-2: one exposure --
def measure_pixels(P, V, FL, x, y, *, ap_r=APER_R, ann_in=ANN_IN, ann_out=ANN_OUT, floor=FLUX_FLOOR):
    """Forced aperture photometry of one star in one exposure cutout.

    P (MJy/sr, IMAGE - ZODI), V (VARIANCE), FL (raw FLAGS, integer) are 2-D arrays [y, x];
    (x, y) the star in 0-based cutout pixels. Returns a dict:
      ok, reason ('ok', 'outside_cutout', 'edge', 'masked_aperture', 'annulus_few'),
      saturated (central 5x5 carries raw bits 1, 15 or 26; set whenever the star is in the cutout),
      flux, var_raw, var (inflated: var_raw + (floor*flux)^2), bkg, s_bkg, n_bkg, n_aperture.
    """
    from astropy.stats import sigma_clip
    from photutils.aperture import CircularAperture

    P = np.asarray(P, float)
    V = np.asarray(V, float)
    FL = np.asarray(FL).astype(np.int64)
    ny, nx = P.shape
    out = dict(ok=False, reason="ok", saturated=False, flux=np.nan, var_raw=np.nan, var=np.nan,
               bkg=np.nan, s_bkg=np.nan, n_bkg=0, n_aperture=0)
    if not (np.isfinite(x) and np.isfinite(y)) or x < -0.5 or x > nx - 0.5 or y < -0.5 or y > ny - 0.5:
        out["reason"] = "outside_cutout"
        return out
    xi, yi = int(np.rint(x)), int(np.rint(y))
    s5 = (slice(max(0, yi - SAT_HALF), yi + SAT_HALF + 1), slice(max(0, xi - SAT_HALF), xi + SAT_HALF + 1))
    out["saturated"] = bool((np.bitwise_or.reduce(FL[s5].ravel()) & SATURATED_MASK) != 0)

    # step 1: pixel mask
    bad = ((FL & BAD_DATA_MASK) != 0) | ~np.isfinite(P) | ~np.isfinite(V) | (V <= 0)

    # step 2: aperture
    if x - ap_r < -0.5 or x + ap_r > nx - 0.5 or y - ap_r < -0.5 or y + ap_r > ny - 0.5:
        out["reason"] = "edge"
        return out
    m = CircularAperture((x, y), ap_r).to_mask(method="exact")
    bb = m.bbox
    if bb.iymin < 0 or bb.ixmin < 0 or bb.iymax > ny or bb.ixmax > nx:
        out["reason"] = "edge"
        return out
    w = m.data
    sl = (slice(bb.iymin, bb.iymax), slice(bb.ixmin, bb.ixmax))
    out["n_aperture"] = int((w > 0).sum())
    if bad[sl][w > 0].any():
        out["reason"] = "masked_aperture"
        return out

    # local background: sigma-clipped median of unmasked finite pixels, ann_in <= r < ann_out
    r_out = int(np.ceil(ann_out)) + 1
    x0, x1 = max(0, xi - r_out), min(nx, xi + r_out + 1)
    y0, y1 = max(0, yi - r_out), min(ny, yi + r_out + 1)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    rr = np.hypot(xx - x, yy - y)
    keep = (rr >= ann_in) & (rr < ann_out) & ~bad[y0:y1, x0:x1]
    if keep.sum() < MIN_ANN:
        out["reason"] = "annulus_few"
        return out
    c = sigma_clip(P[y0:y1, x0:x1][keep], sigma=CLIP_SIGMA_BKG, maxiters=CLIP_ITERS_BKG,
                   cenfunc="median", stdfunc="std")
    kept = np.asarray(c.data)[~np.asarray(c.mask)]
    if kept.size < MIN_ANN:
        out["reason"] = "annulus_few"
        return out
    bkg = float(np.median(kept))
    s_b = float(np.std(kept))
    n_b = int(kept.size)

    flux = float(np.sum(w * (P[sl] - bkg)))
    var_raw = float(np.sum(w ** 2 * V[sl]) + w.sum() ** 2 * (np.pi / 2.0) * s_b ** 2 / n_b)
    out.update(ok=True, flux=flux, var_raw=var_raw, var=var_raw + (floor * flux) ** 2,
               bkg=bkg, s_bkg=s_b, n_bkg=n_b)
    return out


def load_cutout(path):
    """Read one Level 2 cutout: dict(P, V, FL, wcs, mjd, obs_id, detector, release, x0, y0)."""
    import warnings
    from astropy.io import fits
    from astropy.wcs import WCS, FITSFixedWarning
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        with fits.open(path, memmap=False) as hl:
            h0 = hl[0].header
            P = np.asarray(hl["IMAGE"].data, float) - np.asarray(hl["ZODI"].data, float)
            V = np.asarray(hl["VARIANCE"].data, float)
            FL = np.asarray(hl["FLAGS"].data, np.int64)
            wcs = WCS(hl["IMAGE"].header)
            return dict(P=P, V=V, FL=FL, wcs=wcs, mjd=float(h0["MJD-AVG"]), obs_id=str(h0["OBSID"]),
                        detector=int(h0["DETECTOR"]), release=str(h0["RELEASE"]),
                        x0=int(h0["X0"]), y0=int(h0["Y0"]))


# ------------------------------------------------------------------ step 3: per-visit spectral model --
def spec_model(lam, val, var, w0, b0, halfwidth_bw=WINDOW_BW):
    """Weighted straight-line model F = a + c (lam - w0) of one visit's accepted exposures.

    lam, val, var: 1-D sequences (var already inflated). Returns (a, var_a, n_used, reason) with
    a = matched flux at w0 and var_a its variance; reason is 'ok', 'too_few_samples' or
    'no_bracket' (a, var_a NaN). Numerically identical to wp.phaseb.spec_model.
    """
    lam = np.asarray(lam, float)
    val = np.asarray(val, float)
    var = np.asarray(var, float)
    x = lam - w0
    ok = np.isfinite(x) & np.isfinite(val) & np.isfinite(var) & (var > 0) & (np.abs(x) <= halfwidth_bw * b0)

    def check(sel):
        n = int(sel.sum())
        if n < MIN_SAMPLES:
            return "too_few_samples"
        if not (np.any(sel & (x <= 0)) and np.any(sel & (x >= 0))):
            return "no_bracket"
        return "ok"

    def fit(sel):
        wt = np.where(sel, 1.0 / np.where(var > 0, var, np.inf), 0.0)
        xx = np.where(sel, x, 0.0)
        vv = np.where(sel, val, 0.0)
        S, Sx, Sxx = wt.sum(), (wt * xx).sum(), (wt * xx * xx).sum()
        Sy, Sxy = (wt * vv).sum(), (wt * xx * vv).sum()
        D = S * Sxx - Sx * Sx
        with np.errstate(invalid="ignore", divide="ignore"):
            a = (Sxx * Sy - Sx * Sxy) / D
            c = (S * Sxy - Sx * Sy) / D
            va = Sxx / D
        return a, c, va

    r0 = check(ok)
    if r0 != "ok":
        return np.nan, np.nan, int(ok.sum()), r0
    a, c, va = fit(ok)
    with np.errstate(invalid="ignore"):
        res = np.abs(val - (a + c * x)) / np.sqrt(var)
    res = np.where(ok, res, -np.inf)
    worst = int(np.argmax(res))
    ok2 = ok.copy()
    if res[worst] > CLIP_SIGMA:
        ok2[worst] = False
    r1 = check(ok2)
    if r1 != "ok":
        return np.nan, np.nan, int(ok2.sum()), r1
    a, c, va = fit(ok2)
    if not (np.isfinite(a) and np.isfinite(va) and va > 0):
        return np.nan, np.nan, int(ok2.sum()), "no_bracket"
    return float(a), float(va), int(ok2.sum()), "ok"


def assert_spec_equals_phaseb(n_trials=300, seed=7):
    """Random windows (including clipped, unbracketed and short ones): m2ref.spec_model must equal
    wp.phaseb.spec_model to rounding. Raises AssertionError otherwise; returns the trial counts."""
    from . import phaseb
    rng = np.random.default_rng(seed)
    counts = dict(ok=0, clipped=0, fail=0)
    for _ in range(n_trials):
        n = int(rng.integers(1, 14))
        b0 = 0.02
        w0 = 1.5
        lam = w0 + rng.uniform(-3.5, 3.5, n) * b0
        flux = 10 + 40 * (lam - w0) + rng.normal(0, 0.3, n)
        var = rng.uniform(0.05, 0.4, n) ** 2
        if rng.random() < 0.4:
            flux[int(rng.integers(0, n))] += rng.choice([-1, 1]) * rng.uniform(2, 6)
        a, va, nu, reason = spec_model(lam, flux, var, w0, b0)
        pa, pva, pn = phaseb.spec_model(lam[:, None], flux[:, None], var[:, None], np.array([w0]), np.array([b0]))
        pa, pva, pn = float(pa[0]), float(pva[0]), int(pn[0])
        if np.isnan(pa):
            assert np.isnan(a) and np.isnan(va), (lam, flux, var, a, pa)
            counts["fail"] += 1
        else:
            assert abs(a - pa) <= 1e-9 * max(1.0, abs(pa)), (a, pa)
            assert abs(va - pva) <= 1e-9 * pva, (va, pva)
            assert nu == pn
            counts["ok"] += 1
            counts["clipped"] += int(nu < int(np.sum(np.abs(lam - w0) <= WINDOW_BW * b0)))
    return counts


# ------------------------------------------------------------------ step 4-7: one star, one visit pair --
def _ivmean(vals, var):
    vals, var = np.asarray(vals, float), np.asarray(var, float)
    w = 1.0 / var
    return float(np.sum(w * vals) / np.sum(w)), float(1.0 / np.sum(w))


def select_wavelengths(samples_A):
    """Step 4: greedy independent evaluation wavelengths from visit A's accepted exposures.
    Candidates sorted by (lam, id); take the first, then each one whose lam is more than
    SEP_BW * its own bw above the last selected lam. Returns the list of selected samples."""
    cand = sorted(samples_A, key=lambda s: (s["lam"], str(s["id"])))
    sel = []
    for s in cand:
        if not sel or s["lam"] - sel[-1]["lam"] > SEP_BW * s["bw"]:
            sel.append(s)
    return sel


def paired_stack(samples_A, samples_B):
    """Step 6, PS: greedy unique pairing by smallest |lam gap| (<= PAIR_GAP_BW mean bandwidths of the
    two exposures; ties: smaller |MJD difference|, then ids), inverse-variance mean of differences."""
    cands = []
    for a in samples_A:
        for b in samples_B:
            gap = abs(a["lam"] - b["lam"])
            if gap <= PAIR_GAP_BW * 0.5 * (a["bw"] + b["bw"]):
                cands.append((gap, abs(a["mjd"] - b["mjd"]), str(a["id"]), str(b["id"]), a, b))
    cands.sort(key=lambda t: t[:4])
    used_a, used_b, pairs = set(), set(), []
    for gap, dm, ia, ib, a, b in cands:
        if ia in used_a or ib in used_b:
            continue
        used_a.add(ia)
        used_b.add(ib)
        pairs.append((a, b, gap))
    if not pairs:
        return dict(n_pairs=0, D=np.nan, var=np.nan, z=np.nan, frac=np.nan, pairs=[])
    D = np.array([a["flux"] - b["flux"] for a, b, _ in pairs])
    var = np.array([a["var"] + b["var"] for a, b, _ in pairs])
    Dm, vm = _ivmean(D, var)
    Fm, _ = _ivmean([0.5 * (a["flux"] + b["flux"]) for a, b, _ in pairs], var)
    return dict(n_pairs=len(pairs), D=Dm, var=vm, z=Dm / np.sqrt(vm), frac=Dm / Fm,
                pairs=[(str(a["id"]), str(b["id"]), g) for a, b, g in pairs])


def compare_visits(samples_A, samples_B, *, blended=False):
    """Steps 4-7 for one star and one visit pair (A earlier, B later), one detector.

    samples_X: list of dicts with keys id, lam, bw, mjd, flux, var (var inflated), saturated;
    one per ACCEPTED exposure of that visit (inStack visits only). Returns a plain dict:
      per_w0: list of dict(w0, b0, F_A, err_A, F_B, err_B, D, var, z, n_A, n_B, id_A,
                           plain_id_B, plain_D, plain_var, plain_z)
      skipped: list of dict(w0, reason)
      n_exposures_A/B, n_w0, D, z, frac, var (combined), plain (combined), ps, verdict, flags.
    """
    flags = []
    if any(s.get("saturated") for s in list(samples_A) + list(samples_B)):
        flags.append("saturated")
    if len(samples_A) < MIN_EXPOSURES or len(samples_B) < MIN_EXPOSURES:
        flags.append("partial_visit")
    if blended:
        flags.append("blended")
    selected = select_wavelengths(samples_A)
    per, skipped = [], []
    lamA = np.array([s["lam"] for s in samples_A])
    fA = np.array([s["flux"] for s in samples_A])
    vA = np.array([s["var"] for s in samples_A])
    lamB = np.array([s["lam"] for s in samples_B])
    fB = np.array([s["flux"] for s in samples_B])
    vB = np.array([s["var"] for s in samples_B])
    for s in selected:
        w0, b0 = s["lam"], s["bw"]
        a, va, na, ra = spec_model(lamA, fA, vA, w0, b0)
        b, vb, nb, rb = spec_model(lamB, fB, vB, w0, b0)
        if ra != "ok" or rb != "ok":
            skipped.append(dict(w0=w0, reason=ra if ra != "ok" else rb))
            continue
        D, var = a - b, va + vb
        # plain best pair: the visit-B exposure nearest in lam to the defining visit-A exposure
        j = min(range(len(samples_B)), key=lambda k: (abs(samples_B[k]["lam"] - w0), str(samples_B[k]["id"])))
        sb = samples_B[j]
        pD, pvar = s["flux"] - sb["flux"], s["var"] + sb["var"]
        per.append(dict(w0=w0, b0=b0, F_A=a, err_A=float(np.sqrt(va)), F_B=b, err_B=float(np.sqrt(vb)),
                        D=D, var=var, z=D / np.sqrt(var), n_A=na, n_B=nb, id_A=str(s["id"]),
                        plain_id_B=str(sb["id"]), plain_dlam_bw=abs(sb["lam"] - w0) / b0,
                        plain_D=pD, plain_var=pvar, plain_z=pD / np.sqrt(pvar)))
    if any(k["reason"] == "too_few_samples" for k in skipped):
        flags.append("too_few_samples")
    if any(k["reason"] == "no_bracket" for k in skipped):
        flags.append("no_bracket")
    res = dict(per_w0=per, skipped=skipped, n_exposures_A=len(samples_A), n_exposures_B=len(samples_B),
               n_w0=len(per), flags=flags)
    if per:
        D = np.array([k["D"] for k in per])
        var = np.array([k["var"] for k in per])
        Dm, vm = _ivmean(D, var)
        Fm, _ = _ivmean([0.5 * (k["F_A"] + k["F_B"]) for k in per], var)
        pD = np.array([k["plain_D"] for k in per])
        pv = np.array([k["plain_var"] for k in per])
        pDm, pvm = _ivmean(pD, pv)
        res.update(D=Dm, var=vm, z=Dm / np.sqrt(vm), frac=Dm / Fm,
                   plain=dict(D=pDm, var=pvm, z=pDm / np.sqrt(pvm), frac=pDm / _ivmean(
                       [0.5 * (k["F_A"] + k["F_B"]) for k in per], pv)[0]),
                   verdict="changed" if abs(Dm / np.sqrt(vm)) >= Z_CHANGED else "no significant change")
    else:
        res.update(D=np.nan, var=np.nan, z=np.nan, frac=np.nan, plain=None, verdict="no result")
    res["ps"] = paired_stack(samples_A, samples_B)
    return res


def is_blended(star_ra, star_dec, star_g, nb_ra, nb_dec, nb_g, star_index=None):
    """'blended': any other Gaia source with G < G_star + BLEND_DMAG within BLEND_RADIUS_ARCSEC.
    nb_*: arrays of the catalogue; star_index (row of the star itself) is excluded."""
    nb_ra, nb_dec, nb_g = (np.asarray(a, float) for a in (nb_ra, nb_dec, nb_g))
    dra = (nb_ra - star_ra) * np.cos(np.deg2rad(star_dec)) * 3600.0
    ddec = (nb_dec - star_dec) * 3600.0
    near = (np.hypot(dra, ddec) <= BLEND_RADIUS_ARCSEC) & (nb_g < star_g + BLEND_DMAG)
    if star_index is not None:
        near[star_index] = False
    return bool(near.any())
