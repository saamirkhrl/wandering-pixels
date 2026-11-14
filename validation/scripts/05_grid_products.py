"""05: phase B grid-based difference products P1, P2, M1, resampling-kernel comparison and
pixel-level metrics.

usage: uv run python scripts/05_grid_products.py --field {barnard,epsindi}
           [--scale 6.15|3.075] [--kernels bilinear,lanczos3,adaptive,exact] [--jobs N] [--refresh]
Default (no --scale/--kernels): the full plan, i.e. P1 with all four kernels on the 6.15" grid,
P1 bilinear and M1 six on the 3.075" grid, P2 and M1 (six, one) bilinear on the 6.15" grid,
each P1 with both mask variants (browser = website FLAGS mask, prereg = phase A rejection list),
M1 six also with the browser mask.

Definitions: docs/method.md "Choices fixed before any phase B result was computed"; shared
constants and the spectral model from wp/phaseb.py; resampling and photometry from wp/grid.py.
Outputs:
  data/phaseb/<field>/grid_<kernel>_<scale>_<mask>/<frame>.npz   resampled exposures (cache)
  data/phaseb/<field>/fluxes_P1.ecsv, fluxes_P2.ecsv, fluxes_M1.ecsv  (F in microjansky)
  docs/figures/phaseb_panels_<field>.png, docs/figures/phaseb_kernels_<field>.png
  docs/results.json section phaseb_pixel_<field>
"""
import argparse
import csv
import math
import sys
import time
import warnings
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from astropy.table import Table
from scipy.optimize import least_squares

from wp import grid as GR
from wp import phaseb
from wp import wavelength as W
from wp.config import DATA, FIGURES
from wp.gaia import gaia_path, propagate
from wp.results import metric, update_results

SCRIPT = "05_grid_products.py"
ROOT = Path(__file__).resolve().parents[1]
UJY_PER_MJY = 1e12
TIMES = {}


def log(msg):
    print(msg, flush=True)


class Stage:
    def __init__(self, name):
        self.name = name

    def __enter__(self):
        self.t = time.time()
        log(f"\n== {self.name}")

    def __exit__(self, *a):
        dt = time.time() - self.t
        TIMES[self.name] = round(dt, 1)
        log(f"   [{self.name}: {dt:.1f} s]")


# ---------------------------------------------------------------- inputs ------------------
def load_index(field):
    visits = sorted({v for a, b, _ in phaseb.VISIT_PAIRS[field] for v in (a, b)})
    rows = []
    with open(DATA / f"index_{field}.csv") as f:
        for r in csv.DictReader(f):
            if int(r["visit"]) not in visits or r["on_detector"] != "True":
                continue
            p = ROOT / r["cutout_path"]
            if not p.exists():
                continue
            det = int(r["detector"])
            lam_c, bw_c = W.cal_lambda(r["release"], det, float(r["target_x"]), float(r["target_y"]))
            rows.append(dict(obs_id=r["obs_id"], det=det, release=r["release"], mjd=float(r["mjd_mid"]),
                             visit=int(r["visit"]), frame=f"{r['obs_id']}_D{det}", path=str(p),
                             lam_c=lam_c, bw_c=bw_c))
    return rows, visits


def star_positions(stars, mjd, gw):
    ra, dec, _ = propagate(stars, mjd)
    x, y = gw.world_to_pixel_values(ra, dec)
    return np.asarray(x), np.asarray(y)


def bkg_pixel_mask(field, scale, mjd_ref):
    """True for background pixels: > 3 px (scaled) from every Gaia source with G < BKG_G_MASK."""
    g = Table.read(gaia_path(field))
    g = g[np.asarray(g["phot_g_mean_mag"], float) < phaseb.BKG_G_MASK]
    gw, (ny, nx) = phaseb.grid_wcs(field, scale)
    x, y = star_positions(g, mjd_ref, gw)
    r = 3.0 * 6.15 / scale
    m = np.ones((ny, nx), bool)
    R = int(math.ceil(r)) + 1
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1]
    for xc, yc in zip(x, y):
        if not (np.isfinite(xc) and -R < xc < nx + R and -R < yc < ny + R):
            continue
        px, py = int(round(xc)) + xx, int(round(yc)) + yy
        k = (np.hypot(px - xc, py - yc) <= r) & (px >= 0) & (px < nx) & (py >= 0) & (py < ny)
        m[py[k], px[k]] = False
    return m


# ---------------------------------------------------------------- resampling --------------
def _resample_job(a):
    path, kernel, scale, field, stars, gbkg, outs, origin = a
    t = time.time()
    s = GR.resample_exposure(path, kernel, scale, field, stars, gbkg, outs, origin)
    return path, kernel, scale, time.time() - t, s


def cache_dir(field, kernel, scale, mask):
    return DATA / "phaseb" / field / f"grid_{kernel}_{GR.scale_tag(scale)}_{mask}"


def run_resampling(field, idx, plan, stars, origins, jobs, refresh):
    g = Table.read(gaia_path(field))
    gbkg = g[np.asarray(g["phot_g_mean_mag"], float) < GR.BKG_GMAX]
    gbkg = gbkg[["source_id", "ra", "dec", "pmra", "pmdec", "parallax"]]
    st = stars[["source_id", "ra", "dec", "pmra", "pmdec", "parallax"]]
    tasks = []
    for kernel, scale, masks in plan:
        for m in masks:
            cache_dir(field, kernel, scale, m).mkdir(parents=True, exist_ok=True)
        for r in idx:
            outs = {m: str(cache_dir(field, kernel, scale, m) / f"{r['frame']}.npz") for m in masks}
            if not refresh and all(Path(p).exists() for p in outs.values()):
                continue
            tasks.append((r["path"], kernel, scale, field, st, gbkg, outs, origins[scale]))
    log(f"   {len(tasks)} resampling jobs to run ({sum(len(idx) for _ in plan)} exposure-kernel-scale "
        f"combinations planned), {jobs} processes")
    per = {}
    if tasks:
        with ProcessPoolExecutor(max_workers=jobs) as ex:
            futs = [ex.submit(_resample_job, t) for t in tasks]
            for i, f in enumerate(as_completed(futs), 1):
                path, k, s, dt, _ = f.result()
                per.setdefault(f"{k}_{s:g}", []).append(dt)
                if i % 100 == 0 or i == len(tasks):
                    log(f"   {i}/{len(tasks)}")
    for k, v in per.items():
        log(f"   {k}: median {np.median(v):.2f} s per exposure (CPU, inside a worker)")


def load_set(field, kernel, scale, mask, idx, arrays=True):
    out = {}
    for r in idx:
        z = GR.load_npz(cache_dir(field, kernel, scale, mask) / f"{r['frame']}.npz")
        if not arrays:
            for k in ("data", "var", "lam", "bw"):
                z.pop(k, None)
        out[r["frame"]] = z
    return out


# ---------------------------------------------------------------- metrics helpers ---------
def robust_rms(a):
    a = np.asarray(a, float)
    a = a[np.isfinite(a)]
    if a.size < 10:
        return float("nan")
    return float(1.4826 * np.median(np.abs(a - np.median(a))))


def dipole_level(diff_st, peakA, geom):
    """RMS of (difference - its annulus median) within 3 (scaled) grid px of the star, over the
    star's background-subtracted peak in the visit-A image. NaN if any core pixel is not finite."""
    core = geom["r"] <= 3.0 * geom["f"]
    n = len(diff_st)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        bk = np.nanmedian(np.where(geom["ann"], diff_st, np.nan).reshape(n, -1), axis=1)
        d = np.where(core, diff_st - bk[:, None, None], np.nan)
        allfin = np.all(np.isfinite(d) | ~core, axis=(1, 2))
        rms = np.sqrt(np.nanmean(d.reshape(n, -1) ** 2, axis=1))
    return np.where(allfin & (peakA > 0), rms / peakA, np.nan)


class Acc:
    """Accumulates per-group pixel metrics."""

    def __init__(self):
        self.d = {}

    def add(self, key, cls, name, vals):
        self.d.setdefault(key, {}).setdefault(cls, {}).setdefault(name, []).extend(np.atleast_1d(vals).tolist())


def bkg_honesty(diff, var, bmask):
    m = bmask & np.isfinite(diff) & np.isfinite(var) & (var > 0)
    if m.sum() < 100:
        return float("nan"), 0
    return robust_rms(diff[m] / np.sqrt(var[m])), int(m.sum())


def to_ujy(scale):
    return GR.omega_sr(scale) * UJY_PER_MJY


# ---------------------------------------------------------------- P1 ----------------------
def run_p1(field, idx, kernel, scale, mask, stars, geomA_cache, bmask, acc, rows, cfac, fig_keep):
    S = load_set(field, kernel, scale, mask, idx)
    by = {(r["visit"], r["det"]): [] for r in idx}
    for r in idx:
        by[(r["visit"], r["det"])].append(r)
    ox, oy = geomA_cache["origin"][scale]
    sid = np.asarray(stars["source_id"])
    G = np.asarray(stars["phot_g_mean_mag"], float)
    bprp = np.asarray(stars["bp_rp"], float)
    bright = (G >= phaseb.BRIGHT_G[0]) & (G <= phaseb.BRIGHT_G[1])
    u = to_ujy(scale)
    key = f"P1|{kernel}|{mask}|{scale:g}"
    # correlation factor exact/naive, from every star-exposure of this set
    rat = []
    for z in S.values():
        q = z["s_var_exact"] / z["s_var_naive"]
        rat.extend(q[np.isfinite(q)].tolist())
    cfac[(kernel, scale, mask)] = (float(np.median(rat)), len(rat), float(np.percentile(rat, 16)), float(np.percentile(rat, 84)))
    cnt = dict(star_comparisons=0, drop_flag5=0, drop_nan_or_annulus=0, kept=0)
    H = GR.stamp_half(scale)
    Sz = 2 * H + 1
    for a, b, cls in phaseb.VISIT_PAIRS[field]:
        for d in range(1, 7):
            A = by.get((a, d), [])
            B = by.get((b, d), [])
            if not A or not B:
                continue
            lamB = np.array([r["lam_c"] for r in B])
            for ri in A:
                rj = B[int(np.argmin(np.abs(lamB - ri["lam_c"])))]
                zi, zj = S[ri["frame"]], S[rj["frame"]]
                f5 = zi["s_flag5"] | zj["s_flag5"]
                ok = ~f5 & np.isfinite(zi["s_F"]) & np.isfinite(zj["s_F"])
                cnt["star_comparisons"] += len(sid)
                cnt["drop_flag5"] += int(f5.sum())
                cnt["drop_nan_or_annulus"] += int((~f5 & ~ok).sum())
                cnt["kept"] += int(ok.sum())
                for k in np.where(ok)[0]:
                    rows.append(("P1", "-", mask, kernel, scale, a, b, cls, d, int(sid[k]), G[k], bprp[k],
                                 zi["s_lam"][k], zi["s_bw"][k], zj["s_lam"][k],
                                 abs(zi["s_lam"][k] - zj["s_lam"][k]) / zi["s_bw"][k],
                                 ri["frame"], rj["frame"], ri["frame"],
                                 zi["s_F"][k] * u, zj["s_F"][k] * u, zi["s_var_exact"][k] * u * u,
                                 zj["s_var_exact"][k] * u * u))
                # pixel metrics
                diff = zi["data"] - zj["data"]
                val, npx = bkg_honesty(diff, zi["var"] + zj["var"], bmask)
                acc.add(key, cls, "bkg_ratio", val)
                acc.add(key, cls, "bkg_npix", npx)
                sel = ok & bright
                if sel.any():
                    g = geomA_cache["P1"][(scale, ri["frame"])]
                    ix = np.where(sel)[0]
                    dst = GR.extract(diff, ox[ix], oy[ix], Sz)
                    gs = {k2: (v[ix] if isinstance(v, np.ndarray) and v.ndim >= 1 and len(v) == len(sid) else v)
                          for k2, v in g.items()}
                    dl = dipole_level(dst, zi["s_peak"][ix], gs)
                    acc.add(key, cls, "dipole", dl[np.isfinite(dl)])
                if fig_keep is not None and (a, b, d) == fig_keep["pair_det"] and ri["frame"] == fig_keep["frame"]:
                    fig_keep.setdefault("P1", {})[(kernel, mask, scale)] = dict(A=zi["data"], diff=diff, partner=rj["frame"])
    log(f"   {key}: {cnt}; var correlation factor exact/naive = {cfac[(kernel, scale, mask)][0]:.3f}")
    return cnt


# ---------------------------------------------------------------- stacks / model ---------
def stamp_stack(S, frames, key, ox, oy, Sz, excl=None):
    st = np.stack([GR.extract(S[f][key], ox, oy, Sz) for f in frames]).astype(np.float64)
    if excl is not None:
        st[excl] = np.nan
    return st


def ivar_mean(val, var, axis=0):
    ok = np.isfinite(val) & np.isfinite(var) & (var > 0)
    w = np.where(ok, 1.0 / np.where(ok, var, 1.0), 0.0)
    sw = w.sum(axis)
    with np.errstate(invalid="ignore", divide="ignore"):
        m = (np.where(ok, val, 0.0) * w).sum(axis) / sw
        v = 1.0 / sw
    return np.where(sw > 0, m, np.nan), np.where(sw > 0, v, np.nan)


def visit_geom(stars, mjd, gw, ox, oy, scale):
    x, y = star_positions(stars, mjd, gw)
    return GR.stamp_geom(x, y, ox, oy, scale), x, y


def run_p2(field, idx, stars, origins, bmask, acc, rows, cfac, fig_keep, counts):
    scale, mask, kernel = 6.15, "prereg", "bilinear"
    S = load_set(field, kernel, scale, mask, idx)
    gw, _ = phaseb.grid_wcs(field, scale)
    ox, oy = origins[scale]
    H = GR.stamp_half(scale)
    Sz = 2 * H + 1
    sid = np.asarray(stars["source_id"])
    G = np.asarray(stars["phot_g_mean_mag"], float)
    bprp = np.asarray(stars["bp_rp"], float)
    bright = (G >= phaseb.BRIGHT_G[0]) & (G <= phaseb.BRIGHT_G[1])
    u = to_ujy(scale)
    C = cfac[("bilinear", scale, mask)][0]
    key = f"P2|{kernel}|{mask}|{scale:g}"
    vmjd = {v: np.mean([r["mjd"] for r in idx if r["visit"] == v]) for v in {r["visit"] for r in idx}}
    cnt = dict(star_comparisons=0, drop_nan_or_annulus=0, kept=0)
    for a, b, cls in phaseb.VISIT_PAIRS[field]:
        gA, _, _ = visit_geom(stars, vmjd[a], gw, ox, oy, scale)
        gB, _, _ = visit_geom(stars, vmjd[b], gw, ox, oy, scale)
        for d in range(1, 7):
            FA = [r["frame"] for r in idx if r["visit"] == a and r["det"] == d]
            FB = [r["frame"] for r in idx if r["visit"] == b and r["det"] == d]
            if not FA or not FB:
                continue
            # full grid
            mA, vA = ivar_mean(np.stack([S[f]["data"] for f in FA]), np.stack([S[f]["var"] for f in FA]))
            mB, vB = ivar_mean(np.stack([S[f]["data"] for f in FB]), np.stack([S[f]["var"] for f in FB]))
            val, npx = bkg_honesty(mA - mB, vA + vB, bmask)
            acc.add(key, cls, "bkg_ratio", val)
            acc.add(key, cls, "bkg_npix", npx)
            if fig_keep is not None and (a, b, d) == fig_keep["pair_det"]:
                fig_keep["P2"] = mA - mB
            # per star, flagged star-exposures excluded
            res = {}
            for tag, F, g in (("A", FA, gA), ("B", FB, gB)):
                ex = np.stack([S[f]["s_flag5"] for f in F])                     # (nf, ns)
                vst = stamp_stack(S, F, "data", ox, oy, Sz, ex)
                wst = stamp_stack(S, F, "var", ox, oy, Sz, ex)
                m, v = ivar_mean(vst, wst)
                ph = GR.phot(m, v, g)
                # inverse-variance mean wavelength / bandwidth at the star (weights 1/var at the star's pixel)
                xs = np.rint(g["lx"]).astype(int)
                ys = np.rint(g["ly"]).astype(int)
                vs = wst[:, np.arange(len(sid)), ys, xs]
                okw = np.isfinite(vs) & (vs > 0)
                w = np.where(okw, 1.0 / np.where(okw, vs, 1.0), 0.0)
                lam = np.stack([S[f]["s_lam"] for f in F])
                bw = np.stack([S[f]["s_bw"] for f in F])
                with np.errstate(invalid="ignore"):
                    lm = (w * np.nan_to_num(lam)).sum(0) / w.sum(0)
                    bm = (w * np.nan_to_num(bw)).sum(0) / w.sum(0)
                res[tag] = dict(m=m, ph=ph, lam=lm, bw=bm)
            ok = res["A"]["ph"]["ok"] & res["B"]["ph"]["ok"]
            cnt["star_comparisons"] += len(sid)
            cnt["drop_nan_or_annulus"] += int((~ok).sum())
            cnt["kept"] += int(ok.sum())
            for k in np.where(ok)[0]:
                la, ba, lb = res["A"]["lam"][k], res["A"]["bw"][k], res["B"]["lam"][k]
                rows.append(("P2", "-", mask, kernel, scale, a, b, cls, d, int(sid[k]), G[k], bprp[k], la, ba, lb,
                             abs(la - lb) / ba, "stack", "stack", "stack",
                             res["A"]["ph"]["F"][k] * u, res["B"]["ph"]["F"][k] * u,
                             res["A"]["ph"]["var_naive"][k] * C * u * u, res["B"]["ph"]["var_naive"][k] * C * u * u))
            sel = ok & bright
            if sel.any():
                ix = np.where(sel)[0]
                pk = GR.peak(res["A"]["m"][ix], {**gA, "r": gA["r"][ix]}, res["A"]["ph"]["bkg"][ix])
                dl = dipole_level(res["A"]["m"][ix] - res["B"]["m"][ix], pk, {**gA, "r": gA["r"][ix], "ann": gA["ann"][ix]})
                acc.add(key, cls, "dipole", dl[np.isfinite(dl)])
    counts[key] = cnt
    log(f"   {key}: {cnt}; variance uses correlation factor {C:.3f}")


def select_samples(lam_pool, w0, b0):
    """Indices of pool samples that fall in the window at ANY pixel (a superset; spec_model applies
    the exact per-pixel window)."""
    with np.errstate(invalid="ignore"):
        hit = np.abs(lam_pool - w0[None]) <= phaseb.WINDOW_BW * b0[None]
    return np.where(hit.reshape(len(lam_pool), -1).any(1))[0]


def run_m1(field, idx, stars, origins, bmask, acc, rows, cfac, fig_keep, counts, scale, mask, modes, novalue):
    kernel = "bilinear"
    S = load_set(field, kernel, scale, mask, idx)
    gw, _ = phaseb.grid_wcs(field, scale)
    ox, oy = origins[scale]
    H = GR.stamp_half(scale)
    Sz = 2 * H + 1
    sid = np.asarray(stars["source_id"])
    ns = len(sid)
    G = np.asarray(stars["phot_g_mean_mag"], float)
    bprp = np.asarray(stars["bp_rp"], float)
    bright = (G >= phaseb.BRIGHT_G[0]) & (G <= phaseb.BRIGHT_G[1])
    u = to_ujy(scale)
    C = cfac[("bilinear", scale, mask)][0]
    vmjd = {v: np.mean([r["mjd"] for r in idx if r["visit"] == v]) for v in {r["visit"] for r in idx}}
    visits = sorted(vmjd)
    # per visit: full-grid sample cubes and star stamp cubes (flagged star-exposures -> NaN)
    V = {}
    for v in visits:
        fr = [r for r in idx if r["visit"] == v]
        F = [r["frame"] for r in fr]
        ex = np.stack([S[f]["s_flag5"] for f in F])
        V[v] = dict(frames=F, det=np.array([r["det"] for r in fr]),
                    lam=np.stack([S[f]["lam"] for f in F]), val=np.stack([S[f]["data"] for f in F]),
                    var=np.stack([S[f]["var"] for f in F]),
                    s_val=stamp_stack(S, F, "data", ox, oy, Sz, ex), s_var=stamp_stack(S, F, "var", ox, oy, Sz, ex),
                    s_lam=stamp_stack(S, F, "lam", ox, oy, Sz), ex=ex)
    geo = {v: visit_geom(stars, vmjd[v], gw, ox, oy, scale)[0] for v in visits}
    tsm = 0.0
    for mode in modes:
        key = f"M1-{mode}|{kernel}|{mask}|{scale:g}"
        cnt = dict(star_comparisons=0, drop_flag5_eval=0, drop_no_model_or_nan=0, kept=0)
        nv = dict(pix=0, noA=0, noB=0, nodiff=0)
        for a, b, cls in phaseb.VISIT_PAIRS[field]:
            for d in range(1, 7):
                iA = [k for k, f in enumerate(V[a]["frames"]) if V[a]["det"][k] == d]
                if not iA or not np.any(V[b]["det"] == d):
                    continue
                for i in iA:
                    fi = V[a]["frames"][i]
                    w0, b0 = S[fi]["lam"].astype(float), S[fi]["bw"].astype(float)
                    w0s = GR.extract(w0, ox, oy, Sz)
                    b0s = GR.extract(b0, ox, oy, Sz)
                    mods, smods = {}, {}
                    t0 = time.time()
                    for tag, v in (("A", a), ("B", b)):
                        pool = np.arange(len(V[v]["frames"])) if mode == "six" else np.where(V[v]["det"] == d)[0]
                        sel = pool[select_samples(V[v]["lam"][pool], w0, b0)]
                        m, mv, _ = phaseb.spec_model(V[v]["lam"][sel], V[v]["val"][sel], V[v]["var"][sel], w0, b0)
                        mods[tag] = (m, mv)
                        sm, smv, _ = phaseb.spec_model(V[v]["s_lam"][sel], V[v]["s_val"][sel], V[v]["s_var"][sel], w0s, b0s)
                        smods[tag] = (sm, smv)
                    tsm += time.time() - t0
                    diff = mods["A"][0] - mods["B"][0]
                    has = np.isfinite(w0)
                    nv["pix"] += int(has.sum())
                    nv["noA"] += int((has & ~np.isfinite(mods["A"][0])).sum())
                    nv["noB"] += int((has & ~np.isfinite(mods["B"][0])).sum())
                    nv["nodiff"] += int((has & ~np.isfinite(diff)).sum())
                    val, npx = bkg_honesty(diff, mods["A"][1] + mods["B"][1], bmask)
                    acc.add(key, cls, "bkg_ratio", val)
                    acc.add(key, cls, "bkg_npix", npx)
                    phA = GR.phot(smods["A"][0], smods["A"][1], geo[a])
                    phB = GR.phot(smods["B"][0], smods["B"][1], geo[b])
                    f5 = V[a]["ex"][i]
                    ok = ~f5 & phA["ok"] & phB["ok"]
                    cnt["star_comparisons"] += ns
                    cnt["drop_flag5_eval"] += int(f5.sum())
                    cnt["drop_no_model_or_nan"] += int((~f5 & ~ok).sum())
                    cnt["kept"] += int(ok.sum())
                    zi = S[fi]
                    for k in np.where(ok)[0]:
                        rows.append(("M1", mode, mask, kernel, scale, a, b, cls, d, int(sid[k]), G[k], bprp[k],
                                     zi["s_lam"][k], zi["s_bw"][k], np.nan, 0.0, "model", "model", fi,
                                     phA["F"][k] * u, phB["F"][k] * u,
                                     phA["var_naive"][k] * C * u * u, phB["var_naive"][k] * C * u * u))
                    sel = ok & bright
                    if sel.any():
                        ix = np.where(sel)[0]
                        gA = {**geo[a], "r": geo[a]["r"][ix], "ann": geo[a]["ann"][ix]}
                        pk = GR.peak(smods["A"][0][ix], gA, phA["bkg"][ix])
                        dl = dipole_level(smods["A"][0][ix] - smods["B"][0][ix], pk, gA)
                        acc.add(key, cls, "dipole", dl[np.isfinite(dl)])
                    if fig_keep is not None and scale == 6.15 and mask == "prereg" and (a, b, d) == fig_keep["pair_det"] \
                            and fi == fig_keep["frame"]:
                        fig_keep[f"M1-{mode}"] = diff
        counts[key] = cnt
        novalue[key] = {k: v for k, v in nv.items()}
        log(f"   {key}: {cnt}; no-value fraction diff {nv['nodiff'] / max(nv['pix'], 1):.4f} "
            f"(A {nv['noA'] / max(nv['pix'], 1):.4f}, B {nv['noB'] / max(nv['pix'], 1):.4f})")
    log(f"   spec_model time {tsm:.1f} s")


# ---------------------------------------------------------------- PSF check ---------------
def gauss_sigma(st):
    n = st.shape[0]
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    c = (n - 1) / 2

    def f(p):
        A, x0, y0, s, B = p
        return (A * np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * s * s)) + B - st).ravel()

    p0 = [np.nanmax(st) - np.nanmedian(st), c, c, 0.8, np.nanmedian(st)]
    try:
        r = least_squares(f, p0, bounds=([0, c - 1.5, c - 1.5, 0.2, -np.inf], [np.inf, c + 1.5, c + 1.5, 4.0, np.inf]))
    except Exception:  # noqa: BLE001
        return np.nan
    if not r.success or r.x[3] <= 0.21 or r.x[3] >= 3.99:
        return np.nan
    return float(r.x[3])


def psf_check(field, idx, stars, origins):
    scale = 6.15
    S = load_set(field, "bilinear", scale, "prereg", idx)
    G = np.asarray(stars["phot_g_mean_mag"], float)
    bright = np.where((G >= phaseb.BRIGHT_G[0]) & (G <= phaseb.BRIGHT_G[1]))[0]
    visA = sorted({a for a, _, _ in phaseb.VISIT_PAIRS[field]})
    out = {}
    for d in range(1, 7):
        lam, fw, bwc = [], [], []
        for r in idx:
            if r["det"] != d or r["visit"] not in visA:
                continue
            z = S[r["frame"]]
            sig = []
            for k in bright:
                if z["s_flag5"][k] or not np.isfinite(z["s_F"][k]):
                    continue
                xi, yi = int(round(z["s_x"][k])), int(round(z["s_y"][k]))
                st = z["data"][yi - 3:yi + 4, xi - 3:xi + 4].astype(float)
                if st.shape != (7, 7) or not np.all(np.isfinite(st)):
                    continue
                s = gauss_sigma(st)
                if np.isfinite(s):
                    sig.append(s)
            if len(sig) >= 3:
                lam.append(r["lam_c"])
                bwc.append(r["bw_c"])
                fw.append(2.3548 * np.median(sig) * scale)
        lam, fw = np.array(lam), np.array(fw)
        if len(lam) < 5:
            out[f"D{d}"] = {"n_exposures": int(len(lam)), "note": "too few exposures with >= 3 fitted bright stars"}
            continue
        p, cov = np.polyfit(lam, fw, 1, cov=True)
        win = 2 * phaseb.WINDOW_BW * float(np.median(bwc))
        out[f"D{d}"] = {"n_exposures": int(len(lam)), "lam_range_um": [float(lam.min()), float(lam.max())],
                        "fwhm_median_arcsec": float(np.median(fw)),
                        "slope_arcsec_per_um": float(p[0]), "slope_err": float(np.sqrt(cov[0, 0])),
                        "window_width_um": win,
                        "dfwhm_across_window_arcsec": float(p[0] * win),
                        "dfwhm_across_window_frac": float(p[0] * win / np.median(fw))}
    return out


# ---------------------------------------------------------------- verification ------------
def verify(field, idx, stars, fig_frame, p1rows_tab, origins):
    from photutils.aperture import CircularAnnulus, CircularAperture, aperture_photometry
    from wp.registration import pixscale_arcsec, sky_jacobian
    out = {}
    # (a) grid vs native aperture flux, 5 bright stars, one exposure
    r = next(x for x in idx if x["frame"] == fig_frame)
    e = GR.load_exposure(r["path"])
    z = GR.load_npz(cache_dir(field, "bilinear", 6.15, "prereg") / f"{fig_frame}.npz")
    R = e["img"] - e["zodi"] - float(z["bkg_frame"])
    ra, dec, _ = propagate(stars, e["mjd"])
    xn, yn = e["wcs"].world_to_pixel_values(ra, dec)
    G = np.asarray(stars["phot_g_mean_mag"], float)
    order = [k for k in np.argsort(G) if np.isfinite(z["s_F"][k]) and not z["s_flag5"][k]][:5]
    lines = []
    for k in order:
        J = sky_jacobian(e["wcs"], np.array([xn[k]]), np.array([yn[k]]))[0]
        area_as2 = abs(np.linalg.det(J))
        nscale = math.sqrt(area_as2)
        rap = phaseb.APER_R * 6.15 / nscale
        ap = CircularAperture((xn[k], yn[k]), rap)
        an = CircularAnnulus((xn[k], yn[k]), phaseb.ANN_IN * 6.15 / nscale, phaseb.ANN_OUT * 6.15 / nscale)
        am = an.to_mask(method="center").get_values(R)
        bk = np.nanmedian(am)
        f = aperture_photometry(R - bk, ap, method="exact", mask=~np.isfinite(R))["aperture_sum"][0]
        fn = float(f) * (nscale / ARC) ** 2 * UJY_PER_MJY
        fg = float(z["s_F"][k]) * to_ujy(6.15)
        lines.append(dict(source_id=int(stars["source_id"][k]), G=float(G[k]), F_native_uJy=fn, F_grid_uJy=fg,
                          ratio=fg / fn, native_scale_arcsec=nscale))
    out["a_grid_vs_native"] = lines
    log("   (a) bilinear 6.15\" grid vs native cutout aperture flux (uJy), frame " + fig_frame)
    for l in lines:
        log(f"       G={l['G']:.2f} native {l['F_native_uJy']:.1f} grid {l['F_grid_uJy']:.1f} ratio {l['ratio']:.4f}")
    # (b) P1 star pair by hand
    t = p1rows_tab
    sel = (t["kernel"] == "bilinear") & (t["mask"] == "browser") & (t["pixscale"] == 6.15)
    row = t[np.where(sel)[0][len(np.where(sel)[0]) // 2]]
    za = GR.load_npz(cache_dir(field, "bilinear", 6.15, "browser") / f"{row['frame_A']}.npz")
    zb = GR.load_npz(cache_dir(field, "bilinear", 6.15, "browser") / f"{row['frame_B']}.npz")
    k = int(np.where(np.asarray(stars["source_id"]) == row["source_id"])[0][0])
    hand = []
    for zz in (za, zb):
        x, y = float(zz["s_x"][k]), float(zz["s_y"][k])
        img = zz["data"].astype(float)
        bk = np.nanmedian(CircularAnnulus((x, y), phaseb.ANN_IN, phaseb.ANN_OUT).to_mask(method="center").get_values(img))
        hand.append(float(aperture_photometry(img - bk, CircularAperture((x, y), phaseb.APER_R), method="exact")["aperture_sum"][0]) * to_ujy(6.15))
    out["b_p1_by_hand"] = dict(source_id=int(row["source_id"]), frame_A=str(row["frame_A"]), frame_B=str(row["frame_B"]),
                               table_diff=float(row["F_A"] - row["F_B"]), hand_diff=hand[0] - hand[1],
                               table_FA=float(row["F_A"]), hand_FA=hand[0])
    log(f"   (b) P1 by hand ({row['frame_A']} - {row['frame_B']}, star {row['source_id']}): table "
        f"{row['F_A'] - row['F_B']:.4f} uJy, hand {hand[0] - hand[1]:.4f} uJy (F_A {row['F_A']:.3f} vs {hand[0]:.3f})")
    # (c) spec_model at one pixel vs numpy.polyfit
    S = load_set(field, "bilinear", 6.15, "prereg", idx)
    rA = next(x for x in idx if x["frame"] == fig_frame)
    v = rA["visit"]
    F = [x["frame"] for x in idx if x["visit"] == v]
    lam = np.stack([S[f]["lam"] for f in F]).astype(float)
    val = np.stack([S[f]["data"] for f in F]).astype(float)
    var = np.stack([S[f]["var"] for f in F]).astype(float)
    w0, b0 = S[fig_frame]["lam"].astype(float), S[fig_frame]["bw"].astype(float)
    m, mv, n = phaseb.spec_model(lam, val, var, w0, b0)
    yy, xx = np.where(np.isfinite(m))
    pick = len(yy) // 2
    py, px = yy[pick], xx[pick]
    x = lam[:, py, px] - w0[py, px]
    okk = np.isfinite(x) & np.isfinite(val[:, py, px]) & np.isfinite(var[:, py, px]) & (np.abs(x) <= 2.5 * b0[py, px])
    xs, ys, vs = x[okk], val[okk, py, px], var[okk, py, px]
    c, cov = np.polyfit(xs, ys, 1, w=1 / np.sqrt(vs), cov="unscaled")
    resid = np.abs(ys - np.polyval(c, xs)) / np.sqrt(vs)
    clipped = False
    if resid.max() > phaseb.CLIP_SIGMA:
        keep = np.ones(len(xs), bool)
        keep[np.argmax(resid)] = False
        c, cov = np.polyfit(xs[keep], ys[keep], 1, w=1 / np.sqrt(vs[keep]), cov="unscaled")
        clipped = True
    out["c_spec_model_vs_polyfit"] = dict(pixel=[int(px), int(py)], n_samples=int(okk.sum()), clipped=clipped,
                                         spec_model=float(m[py, px]), polyfit=float(c[1]),
                                         spec_model_var=float(mv[py, px]), polyfit_var=float(cov[1, 1]))
    log(f"   (c) spec_model at grid pixel ({px},{py}), {okk.sum()} samples, clipped={clipped}: value "
        f"{m[py, px]:.6f} vs polyfit {c[1]:.6f}; variance {mv[py, px]:.6e} vs {cov[1, 1]:.6e}")
    return out


ARC = GR.ARCSEC_PER_RAD


# ---------------------------------------------------------------- figures -----------------
def fig_panels(field, fig_keep, path, bmask):
    A = fig_keep["P1"][("bilinear", "prereg", 6.15)]["A"]
    pan = [("visit A exposure\n" + fig_keep["frame"], A), ("P1 (bilinear)", fig_keep["P1"][("bilinear", "prereg", 6.15)]["diff"]),
           ("P2 (inverse-variance stacks)", fig_keep.get("P2")), ("M1 six detectors", fig_keep.get("M1-six")),
           ("M1 one detector", fig_keep.get("M1-one"))]
    n = A.shape[0]
    c, h = n // 2, 40
    sl = (slice(c - h, c + h), slice(c - h, c + h))
    p1 = fig_keep["P1"][("bilinear", "prereg", 6.15)]["diff"]
    lim = 5 * robust_rms(p1[bmask])
    fig, axs = plt.subplots(1, 5, figsize=(17, 4.2))
    cmap = plt.get_cmap("RdBu_r").copy()
    cmap.set_bad("0.75")
    for ax, (t, im) in zip(axs, pan):
        if im is None:
            ax.set_axis_off()
            continue
        mi = ax.imshow(im[sl], origin="lower", cmap=cmap, vmin=-lim, vmax=lim, interpolation="nearest")
        ax.set_title(t, fontsize=10)
        ax.set_xticks([])
        ax.set_yticks([])
    cb = fig.colorbar(mi, ax=axs, shrink=0.8, pad=0.01)
    cb.set_label("MJy/sr (same symmetric stretch in every panel)")
    a, b, d = fig_keep["pair_det"]
    fig.suptitle(f"{field}: visit {a} minus visit {b} (12-month pair), detector D{d}, "
                 f"{2 * h} x {2 * h} grid px of 6.15\" at the field centre, prereg mask; grey = no value", fontsize=11)
    fig.savefig(path, dpi=130, bbox_inches="tight")
    plt.close(fig)


def fig_kernels(field, res_dip, fig_keep, stars, origins, path):
    kernels = list(GR.KERNELS)
    fig = plt.figure(figsize=(13, 4.6))
    gs = fig.add_gridspec(2, 6, width_ratios=[2.2, 2.2, 1, 1, 1, 1])
    ax = fig.add_subplot(gs[:, :2])
    classes = sorted({c for k in kernels for c in res_dip.get(f"P1|{k}|browser|6.15", {})})
    wdt = 0.8 / max(len(classes), 1)
    for ci, cls in enumerate(classes):
        vals = [res_dip.get(f"P1|{k}|browser|6.15", {}).get(cls, (np.nan, 0)) for k in kernels]
        xs = np.arange(len(kernels)) + (ci - (len(classes) - 1) / 2) * wdt
        ax.bar(xs, [v[0] * 100 for v in vals], wdt, label=cls)
        for x, v in zip(xs, vals):
            ax.text(x, v[0] * 100, f"N={v[1]}", ha="center", va="bottom", fontsize=7)
    ax.set_xticks(range(len(kernels)))
    ax.set_xticklabels(kernels)
    ax.set_ylabel("dipole level: RMS within 3 px / visit-A peak (%)")
    ax.set_title("P1, browser mask, 6.15\" grid, median over bright-star comparisons", fontsize=9)
    ax.legend(fontsize=8)
    # one star in P1 per kernel
    G = np.asarray(stars["phot_g_mean_mag"], float)
    sk = fig_keep.get("kernel_star")
    if sk is not None:
        k, x, y = sk
        lim = None
        for j, kern in enumerate(kernels):
            dd = fig_keep["P1"].get((kern, "browser", 6.15))
            if dd is None:
                continue
            xi, yi = int(round(x)), int(round(y))
            st = dd["diff"][yi - 6:yi + 7, xi - 6:xi + 7]
            if lim is None:
                lim = np.nanmax(np.abs(fig_keep["P1"][("bilinear", "browser", 6.15)]["diff"][yi - 6:yi + 7, xi - 6:xi + 7]))
            a2 = fig.add_subplot(gs[j // 2, 2 + 2 * (j % 2):4 + 2 * (j % 2)])
            cm = plt.get_cmap("RdBu_r").copy()
            cm.set_bad("0.75")
            a2.imshow(st, origin="lower", cmap=cm, vmin=-lim, vmax=lim, interpolation="nearest")
            a2.set_title(kern, fontsize=9)
            a2.set_xticks([])
            a2.set_yticks([])
        fig.text(0.78, 0.01, f"Gaia DR3 {int(stars['source_id'][k])} (G={G[k]:.2f}) in P1 of {fig_keep['frame']}, "
                             "13x13 grid px, same stretch, grey = no value", ha="center", fontsize=8)
    fig.suptitle(f"{field}: resampling kernel comparison", fontsize=11)
    fig.savefig(path, dpi=130, bbox_inches="tight")
    plt.close(fig)


# ---------------------------------------------------------------- main --------------------
COLS = ["product", "mode", "mask", "kernel", "pixscale", "visitA", "visitB", "pair_class", "detector", "source_id",
        "G", "bp_rp", "lam_eval", "bw_eval", "lam_B", "dlam_ch", "frame_A", "frame_B", "frame_eval",
        "F_A", "F_B", "var_A", "var_B"]


def write_table(rows, path, product, meta):
    t = Table(rows=rows, names=COLS) if rows else Table(names=COLS)
    t.meta.update(meta)
    t.meta["product"] = product
    t.write(path, overwrite=True)
    return t


def summarize(acc):
    out = {}
    for key, bycls in acc.d.items():
        out[key] = {}
        for cls, d in bycls.items():
            dip = np.array(d.get("dipole", []), float)
            br = np.array(d.get("bkg_ratio", []), float)
            out[key][cls] = dict(dipole=(float(np.median(dip)) if dip.size else float("nan"), int(dip.size)),
                                 bkg=(float(np.nanmedian(br)) if np.isfinite(br).any() else float("nan"),
                                      int(np.sum(d.get("bkg_npix", []))), int(np.isfinite(br).sum())))
    return out


def quick_flux_metrics(t):
    z = (t["F_A"] - t["F_B"]) / np.sqrt(t["var_A"] + t["var_B"])
    fr = (t["F_A"] - t["F_B"]) / (0.5 * (t["F_A"] + t["F_B"]))
    return dict(z_width=robust_rms(np.asarray(z)), frac_scatter=robust_rms(np.asarray(fr)), n=len(t))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", default="barnard", choices=list(phaseb.VISIT_PAIRS))
    ap.add_argument("--scale", type=float, default=None, choices=[6.15, 3.075])
    ap.add_argument("--kernels", default=None)
    ap.add_argument("--jobs", type=int, default=9)
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()
    field = args.field
    warnings.simplefilter("ignore", RuntimeWarning)
    t_all = time.time()
    outdir = DATA / "phaseb" / field
    outdir.mkdir(parents=True, exist_ok=True)

    with Stage("inputs"):
        idx, visits = load_index(field)
        mjd_ref = float(np.mean([r["mjd"] for r in idx]))
        stars = phaseb.phaseb_stars(field, mjd_ref, 6.15)
        s3 = phaseb.phaseb_stars(field, mjd_ref, 3.075)
        same = set(np.asarray(stars["source_id"]).tolist()) == set(np.asarray(s3["source_id"]).tolist())
        log(f"   {len(idx)} exposures in visits {visits}; mjd_ref {mjd_ref:.3f}; star sample {stars.meta['cut_counts']}"
            f"; same sample on the 3.075\" grid: {same}")
        origins = {}
        for sc in (6.15, 3.075):
            gw, _ = phaseb.grid_wcs(field, sc)
            x, y = star_positions(stars, mjd_ref, gw)
            H = GR.stamp_half(sc)
            origins[sc] = (np.rint(x).astype(int) - H, np.rint(y).astype(int) - H)
        bmasks = {sc: bkg_pixel_mask(field, sc, mjd_ref) for sc in (6.15, 3.075)}
        log(f"   background pixels (> 3 px from Gaia G < {phaseb.BKG_G_MASK}): "
            + ", ".join(f"{sc:g}\": {bmasks[sc].mean():.3f}" for sc in bmasks))

    kernels = args.kernels.split(",") if args.kernels else list(GR.KERNELS)
    full = args.scale is None and args.kernels is None
    plan = []
    if args.scale in (None, 6.15):
        for k in kernels:
            plan.append((k, 6.15, list(GR.MASKS)))
    if args.scale in (None, 3.075):
        plan.append(("bilinear", 3.075, list(GR.MASKS)))
    if args.scale == 3.075 and args.kernels:
        plan = [(k, 3.075, list(GR.MASKS)) for k in kernels]

    with Stage("resampling"):
        run_resampling(field, idx, plan, stars, origins, args.jobs, args.refresh)

    # figure choices fixed before looking: 12-month pair (longest class if absent), detector 2,
    # visit-A exposure whose field-centre wavelength is the median of that detector's visit-A wavelengths
    pairs = phaseb.VISIT_PAIRS[field]
    fp = next((p for p in pairs if p[2] == "12mo"), pairs[-1])
    cand = sorted([r for r in idx if r["visit"] == fp[0] and r["det"] == 2], key=lambda r: r["lam_c"])
    fig_frame = cand[(len(cand) - 1) // 2]["frame"]
    fig_keep = dict(pair_det=(fp[0], fp[1], 2), frame=fig_frame)
    log(f"   figure exposure: {fig_frame} (lambda_c {cand[(len(cand) - 1) // 2]['lam_c']:.4f} um), pair {fp}")

    acc = Acc()
    cfac = {}
    counts = {}
    p1rows, p2rows, m1rows = [], [], []
    with Stage("P1"):
        geomA = {"origin": origins, "P1": {}}
        for kernel, scale, masks in plan:
            S0 = load_set(field, kernel, scale, masks[0], idx, arrays=False)
            for r in idx:
                z = S0[r["frame"]]
                ox, oy = origins[scale]
                geomA["P1"][(scale, r["frame"])] = GR.stamp_geom(z["s_x"], z["s_y"], ox, oy, scale)
            for m in masks:
                counts[f"P1|{kernel}|{m}|{scale:g}"] = run_p1(field, idx, kernel, scale, m, stars, geomA, bmasks[scale],
                                                              acc, p1rows, cfac, fig_keep)
    have_bil615 = ("bilinear", 6.15, "prereg") in cfac
    if have_bil615:
        with Stage("P2"):
            run_p2(field, idx, stars, origins, bmasks[6.15], acc, p2rows, cfac, fig_keep, counts)
    novalue = {}
    with Stage("M1"):
        if have_bil615:
            run_m1(field, idx, stars, origins, bmasks[6.15], acc, m1rows, cfac, fig_keep, counts, 6.15, "prereg",
                   ["six", "one"], novalue)
            run_m1(field, idx, stars, origins, bmasks[6.15], acc, m1rows, cfac, fig_keep, counts, 6.15, "browser",
                   ["six"], novalue)
        if ("bilinear", 3.075, "prereg") in cfac:
            run_m1(field, idx, stars, origins, bmasks[3.075], acc, m1rows, cfac, None, counts, 3.075, "prereg",
                   ["six"], novalue)

    with Stage("write flux tables"):
        meta = dict(field=field, script=SCRIPT, mjd_ref=mjd_ref, units_F="microjansky (aperture sum of MJy/sr times grid pixel solid angle)",
                    units_var="microjansky^2", units_lam="um",
                    var_note="P1: exact aperture variance c^T diag(var_native) c with c = K^T a; P2, M1: per-pixel "
                             "propagated variance summed with aperture weights squared, times the median exact/naive "
                             "correlation factor of single bilinear exposures at the same scale and mask; both include "
                             "(pi/2)(sum a)^2 var(annulus mean) for the median background",
                    frame_eval="visit-A exposure that defines the comparison (P1, M1); 'stack' for P2",
                    corr_factors={f"{k}|{s:g}|{m}": v[0] for (k, s, m), v in cfac.items()})
        tabs = {}
        if p1rows:
            tabs["P1"] = write_table(p1rows, outdir / "fluxes_P1.ecsv", "P1", meta)
        if p2rows:
            tabs["P2"] = write_table(p2rows, outdir / "fluxes_P2.ecsv", "P2", meta)
        if m1rows:
            tabs["M1"] = write_table(m1rows, outdir / "fluxes_M1.ecsv", "M1", meta)
        for k, t in tabs.items():
            log(f"   fluxes_{k}.ecsv: {len(t)} rows")

    res = summarize(acc)
    # pixel metrics table
    log("\nPixel metrics (dipole: median RMS within 3 px of G 12-13.5 stars / visit-A peak; "
        "bkg: median over comparisons of robust RMS of diff/sqrt(var) on background pixels)")
    log(f"{'product|kernel|mask|scale':38s} {'class':6s} {'dipole':>8s} {'N':>5s} {'bkg':>7s} {'Ncmp':>5s} {'Npix':>10s}")
    for key in sorted(res):
        for cls in sorted(res[key]):
            v = res[key][cls]
            log(f"{key:38s} {cls:6s} {v['dipole'][0]:8.4f} {v['dipole'][1]:5d} {v['bkg'][0]:7.3f} {v['bkg'][2]:5d} {v['bkg'][1]:10d}")

    with Stage("PSF check"):
        psf = psf_check(field, idx, stars, origins) if have_bil615 else {}
        for d, v in psf.items():
            if "slope_arcsec_per_um" in v:
                log(f"   {d}: FWHM {v['fwhm_median_arcsec']:.2f}\" slope {v['slope_arcsec_per_um']:+.2f} +- {v['slope_err']:.2f} \"/um;"
                    f" across +-2.5 bw window ({v['window_width_um']:.4f} um): {v['dfwhm_across_window_arcsec']:+.3f}\""
                    f" ({100 * v['dfwhm_across_window_frac']:+.2f}%), n={v['n_exposures']}")
            else:
                log(f"   {d}: {v}")

    # frame background: plain median minus source-masked median
    fb = {}
    for m in GR.MASKS:
        try:
            S0 = load_set(field, "bilinear", 6.15, m, idx, arrays=False)
        except FileNotFoundError:
            continue
        for d in range(1, 7):
            dd = np.array([S0[r["frame"]]["bkg_plain"] - S0[r["frame"]]["bkg_frame"] for r in idx if r["det"] == d])
            sm = np.array([S0[r["frame"]]["bkg_frame"] for r in idx if r["det"] == d])
            fb[f"{m}|D{d}"] = dict(plain_minus_masked_median=float(np.median(dd)), p16=float(np.percentile(dd, 16)),
                                  p84=float(np.percentile(dd, 84)), masked_bkg_median=float(np.median(sm)), n=int(len(dd)))
    log("\nFrame background (MJy/sr): plain median minus source-masked clipped median, per detector")
    for k, v in fb.items():
        log(f"   {k}: median {v['plain_minus_masked_median']:+.4f} (16-84%: {v['p16']:+.4f} .. {v['p84']:+.4f}); "
            f"masked bkg median {v['masked_bkg_median']:+.4f}; n={v['n']}")

    # scale comparison (quick flux metrics; the official ones are scripts/07)
    scale_cmp = {}
    if "P1" in tabs:
        t = tabs["P1"]
        for sc in (6.15, 3.075):
            for m in GR.MASKS:
                s = t[(t["kernel"] == "bilinear") & (t["mask"] == m) & (np.isclose(t["pixscale"], sc))]
                if len(s):
                    scale_cmp[f"P1|bilinear|{m}|{sc:g}"] = quick_flux_metrics(s)
        for k in GR.KERNELS:
            s = t[(t["kernel"] == k) & (t["mask"] == "browser") & (np.isclose(t["pixscale"], 6.15))]
            if len(s):
                scale_cmp[f"P1|{k}|browser|6.15"] = quick_flux_metrics(s)
    if "M1" in tabs:
        t = tabs["M1"]
        for sc in (6.15, 3.075):
            for m in GR.MASKS:
                for mode in ("six", "one"):
                    s = t[(t["mode"] == mode) & (t["mask"] == m) & (np.isclose(t["pixscale"], sc))]
                    if len(s):
                        scale_cmp[f"M1-{mode}|bilinear|{m}|{sc:g}"] = quick_flux_metrics(s)
    if "P2" in tabs:
        scale_cmp["P2|bilinear|prereg|6.15"] = quick_flux_metrics(tabs["P2"])
    log("\nQuick flux metrics (all pair classes pooled; z width = 1.4826 MAD of z; frac = 1.4826 MAD of (F_A-F_B)/mean)")
    for k, v in scale_cmp.items():
        log(f"   {k:34s} z_width {v['z_width']:.3f}  frac_scatter {100 * v['frac_scatter']:.2f}%  n={v['n']}")

    ver = {}
    if have_bil615 and "P1" in tabs and full:
        with Stage("verification"):
            ver = verify(field, idx, stars, fig_frame, tabs["P1"], origins)

    with Stage("figures"):
        FIGURES.mkdir(parents=True, exist_ok=True)
        if have_bil615 and ("bilinear", "prereg", 6.15) in fig_keep.get("P1", {}):
            fig_panels(field, fig_keep, FIGURES / f"phaseb_panels_{field}.png", bmasks[6.15])
            log(f"   wrote phaseb_panels_{field}.png")
        if full:
            # star for the kernel panel (fixed rule): brightest G 12-13.5 sample star kept in P1 of the
            # figure exposure for every kernel (browser mask: both frames finite and unflagged)
            z = GR.load_npz(cache_dir(field, "bilinear", 6.15, "browser") / f"{fig_frame}.npz")
            G = np.asarray(stars["phot_g_mean_mag"], float)
            for k in np.argsort(G):
                if not (phaseb.BRIGHT_G[0] <= G[k] <= phaseb.BRIGHT_G[1]):
                    continue
                okk = True
                for kk in GR.KERNELS:
                    part = fig_keep["P1"][(kk, "browser", 6.15)]["partner"]
                    for fr in (fig_frame, part):
                        zz = GR.load_npz(cache_dir(field, kk, 6.15, "browser") / f"{fr}.npz")
                        okk &= bool(np.isfinite(zz["s_F"][k]) and not zz["s_flag5"][k])
                if okk and not z["s_flag5"][k]:
                    fig_keep["kernel_star"] = (k, float(z["s_x"][k]), float(z["s_y"][k]))
                    break
            dip = {key: {cls: v["dipole"] for cls, v in d.items()} for key, d in res.items()}
            fig_kernels(field, dip, fig_keep, stars, origins, FIGURES / f"phaseb_kernels_{field}.png")
            log(f"   wrote phaseb_kernels_{field}.png")

    TIMES["total"] = round(time.time() - t_all, 1)
    if full:
        def mm(key):
            return {cls: dict(dipole=metric(v["dipole"][0], "fraction of visit-A peak", n=v["dipole"][1], script=SCRIPT),
                              bkg_ratio=metric(v["bkg"][0], "robust RMS of diff/sqrt(var), median over comparisons",
                                               n=v["bkg"][1], script=SCRIPT,
                                               note=f"n = background pixels summed over {v['bkg'][2]} comparisons"))
                    for cls, v in res[key].items()}
        payload = {
            "script": SCRIPT,
            "units": {"grid_images": "MJy/sr (IMAGE - ZODI - per-frame source-masked background)",
                      "flux_tables": "microjansky", "pixel_scale": "arcsec"},
            "definitions": {
                "dipole": "per star-comparison: RMS of (difference image minus its annulus median) within 3 grid px "
                          "(scaled with the grid) of sample stars with Gaia G 12.0-13.5, divided by the star's "
                          "background-subtracted peak (max within 1.5 px) in the visit-A image (P1: exposure i; P2: "
                          "visit-A stack; M1: visit-A model); only comparisons kept in the flux table and with all "
                          "core pixels finite; median reported",
                "bkg_ratio": "per comparison: 1.4826 MAD of diff/sqrt(var_A+var_B) on grid pixels > 3 px (scaled) "
                             "from every Gaia source with G < 18 (propagated to mjd_ref); median over comparisons",
                "masks": "browser = website BAD_DATA_MASK bits 0,2,6,7,9,10,11,14,15,26,27; prereg = phase A "
                         "rejection list (wp.registration.reject_mask). The 5x5 star rule uses the same bits.",
                "products": "P1 kernels bilinear/lanczos3/adaptive/exact; P2 and M1 use bilinear",
            },
            "star_sample": {**stars.meta["cut_counts"], "mjd_ref": mjd_ref, "n_bright_G12_13.5": int(np.sum(
                (np.asarray(stars["phot_g_mean_mag"]) >= phaseb.BRIGHT_G[0]) & (np.asarray(stars["phot_g_mean_mag"]) <= phaseb.BRIGHT_G[1])))},
            "comparison_counts": counts,
            "pixel_metrics": {key: mm(key) for key in sorted(res)},
            "m1_no_value_fraction": {k: metric(v["nodiff"] / max(v["pix"], 1), "fraction of grid pixels with exposure-i "
                                               "wavelength but no M1 difference value", n=v["pix"], script=SCRIPT,
                                               note=f"no model A {v['noA'] / max(v['pix'], 1):.4f}, no model B "
                                                    f"{v['noB'] / max(v['pix'], 1):.4f}")
                                     for k, v in novalue.items()},
            "variance_correlation_factor": {f"{k}|{s:g}|{m}": metric(v[0], "exact/naive aperture variance (median)",
                                                                       n=v[1], script=SCRIPT, note=f"16-84%: {v[2]:.3f}-{v[3]:.3f}")
                                            for (k, s, m), v in cfac.items()},
            "quick_flux_metrics": {k: {"z_width": metric(v["z_width"], "1.4826 MAD of z", n=v["n"], script=SCRIPT),
                                       "frac_scatter": metric(v["frac_scatter"], "1.4826 MAD of (F_A-F_B)/mean", n=v["n"], script=SCRIPT)}
                                   for k, v in scale_cmp.items()},
            "psf_vs_wavelength": psf,
            "frame_background_plain_minus_masked": fb,
            "verification": ver,
            "figure_choice": {"pair": list(fp), "detector": 2, "frame": fig_frame},
            "runtime_s": TIMES,
        }
        update_results(f"phaseb_pixel_{field}", payload)
        log(f"\nwrote results section phaseb_pixel_{field}")
    log("\nRuntime per stage (s): " + ", ".join(f"{k} {v}" for k, v in TIMES.items()))


if __name__ == "__main__":
    main()
