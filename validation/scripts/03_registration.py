"""SPHEREx frame-to-frame registration precision measured on Gaia DR3 stars.

usage: uv run python scripts/03_registration.py --field {epsindi,barnard,all} [--method gauss|win]
                                                [--jobs N] [--refresh]

For every cutout in data/index_<field>.csv: centroid isolated Gaia stars (wp.registration),
compare to Gaia DR3 propagated to MJD-AVG (wp.gaia.propagate), then:
  * absolute per-frame offsets and scatter,
  * frame-to-frame pair differences d = r_i - r_j (r = measured - Gaia, so true motion cancels),
    by pair class (wp.exposures.pair_class), detector, raw and after a leave-one-out per-frame
    median shift correction, with an equal-weight-per-star bootstrap,
  * pair scatter vs G with the formal-error noise floor, error calibration, excess term,
  * centroid method comparison (Gaussian fit vs windowed moments),
  * one-star hand check.
Writes docs/figures/registration_{pairs,vs_mag}_<field>.png and section registration_<field> of
docs/results.json. Per-cutout measurements are cached in data/reg/<field>/.
"""
import argparse
import json
import os
import sys
import time
import warnings
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from astropy.table import Table, vstack  # noqa: E402

from wp import registration as reg  # noqa: E402
from wp.config import DATA, FIGURES, ROOT  # noqa: E402
from wp.gaia import GAIA_EPOCH_MJD, JULIAN_YEAR_D, check_propagation, gaia_path, propagate, query_field  # noqa: E402
from wp.results import metric, update_results  # noqa: E402

try:
    from wp.exposures import pair_class
except ImportError:  # identical local copy (contract)
    def pair_class(dt_days):
        d = abs(float(dt_days))
        if d < 20:
            return "same_visit"
        if 120 <= d <= 240:
            return "6mo"
        if 300 <= d <= 430:
            return "12mo"
        if 480 <= d <= 620:
            return "18mo"
        return "other"

SCRIPT = "scripts/03_registration.py"
REG_DIR = DATA / "reg"
CLASSES = ["same_visit", "6mo", "12mo", "18mo", "other"]
INTER = ("6mo", "12mo", "18mo")
G_EDGES = [12.0, 13.0, 14.0, 15.0, 16.0, 16.5]
K_PER_STAR = 20          # pairs per star (per class) in the equal-weight bootstrap sample
N_BOOT = 300
MIN_FRAME_STARS = 5      # frames with fewer accepted stars get no per-frame stats / correction
RNG = np.random.default_rng(20261114)

G_WINDOW_REASON = (
    "G 12.0-16.5. Bright end: SPHEREx non-linearity starts near 11.5 AB (bands 1-4) and ~10 AB "
    "(bands 5-6); G=12 stars, even very red ones (G-K ~ 3, i.e. ~1-2 mag brighter than G in AB at "
    "1-2 um), stay below the bands 1-4 onset only marginally, so NONLINEAR/OVERFLOW flags are also "
    "required clean in the 5x5 stamp. Faint end: G=16.5 still gives peak S/N >= 10 in the SWIR "
    "detectors for typical colours; fainter stars are mostly removed by the S/N cut anyway.")


def rsd(a):
    """Robust standard deviation 1.4826 * MAD."""
    a = np.asarray(a, float)
    a = a[np.isfinite(a)]
    if a.size < 3:
        return np.nan
    return float(1.4826 * np.median(np.abs(a - np.median(a))))


def wmedian(a, w):
    o = np.argsort(a)
    a, w = a[o], w[o]
    c = np.cumsum(w)
    return float(a[np.searchsorted(c, 0.5 * c[-1])])


def pair_class_vec(dt):
    dt = np.abs(np.asarray(dt, float))
    out = np.full(dt.shape, "other", dtype=object)
    out[(dt >= 480) & (dt <= 620)] = "18mo"
    out[(dt >= 300) & (dt <= 430)] = "12mo"
    out[(dt >= 120) & (dt <= 240)] = "6mo"
    out[dt < 20] = "same_visit"
    return out


# ------------------------------------------------------------------ measurement ----------
_W = {}


def _init_worker(field, mjd_ref):
    warnings.simplefilter("ignore")
    g = query_field(field)
    _W["gaia"] = g
    _W["sq"] = reg.star_quality(g, mjd_ref)
    _W["field"] = field


def _cache_path(field, cut):
    return REG_DIR / field / (Path(cut).stem + ".ecsv")


def _measure_one(cut):
    field = _W["field"]
    cp = _cache_path(field, cut)
    t, _ = reg.measure_cutout(ROOT / cut, _W["gaia"], _W["sq"], field)
    cp.parent.mkdir(parents=True, exist_ok=True)
    t.write(cp, overwrite=True)
    return cut


def _cache_ok(field, cut):
    cp = _cache_path(field, cut)
    if not cp.exists():
        return False
    src = ROOT / cut
    if cp.stat().st_mtime < max(src.stat().st_mtime, gaia_path(field).stat().st_mtime,
                                 Path(reg.__file__).stat().st_mtime):
        return False
    return True


def load_field(field, jobs, refresh):
    idx = Table.read(DATA / f"index_{field}.csv", format="ascii.csv")
    cuts = [str(c) for c in idx["cutout_path"] if str(c) and (ROOT / str(c)).exists()]
    vis = {str(c): int(v) for c, v in zip(idx["cutout_path"], idx["visit"])}
    mjd_ref = float(np.median(idx["mjd_mid"]))
    todo = [c for c in cuts if refresh or not _cache_ok(field, c)]
    print(f"[{field}] index rows {len(idx)}, cutouts on disk {len(cuts)}, to measure {len(todo)} "
          f"(cached {len(cuts) - len(todo)})")
    t0 = time.time()
    if todo:
        if jobs > 1:
            with ProcessPoolExecutor(jobs, initializer=_init_worker, initargs=(field, mjd_ref)) as ex:
                for k, _ in enumerate(ex.map(_measure_one, todo, chunksize=4), 1):
                    if k % 100 == 0:
                        print(f"  measured {k}/{len(todo)}  {time.time() - t0:.0f}s", flush=True)
        else:
            _init_worker(field, mjd_ref)
            for c in todo:
                _measure_one(c)
    print(f"  measurement done in {time.time() - t0:.0f}s")
    tabs, frames = [], []
    for fid, c in enumerate(cuts):
        t = Table.read(_cache_path(field, c))
        m = dict(t.meta)
        frames.append(dict(frame=fid, obs_id=m["obs_id"], detector=int(m["detector"]), mjd=float(m["mjd"]),
                           visit=vis.get(c, int(m.get("visit", -1))), pixscale=float(m["pixscale"]),
                           psf_fwhm_as=float(m["psf_fwhm_as"]), finast=m.get("finast"),
                           counts=m["counts"], surv=m["surv"], flag_hits=m.get("flag_hits", {}),
                           flag_hits_accepted=m.get("flag_hits_accepted", {}),
                           missing_flag_names=m.get("missing_flag_names", []), path=c,
                           x0=int(m["x0"]), y0=int(m["y0"])))
        if len(t):
            t.meta = {}
            t["frame"] = fid
            t["detector"] = int(m["detector"])
            t["mjd"] = float(m["mjd"])
            t["visit"] = frames[-1]["visit"]
            t["pixscale"] = float(m["pixscale"])
            t["xdet_pred"] = np.asarray(t["x_pred"]) + int(m["x0"])
            t["ydet_pred"] = np.asarray(t["y_pred"]) + int(m["y0"])
            tabs.append(t)
    T = vstack(tabs, metadata_conflicts="silent") if tabs else Table()
    return T, frames, mjd_ref


# ------------------------------------------------------------------ statistics -----------
def loo_correct(T, m, base=None):
    """Subtract each frame's median residual computed from the OTHER stars (leave-one-out).
    base: optional dict of residual arrays (dra, ddec, dx, dy) to start from instead of T."""
    frame = np.asarray(T["frame"])
    out = {}
    for c in ("dra", "ddec", "dx", "dy"):
        r = np.asarray(base[c] if base is not None else T[f"{c}_{m}"], float)
        corr = np.full(r.shape, np.nan)
        for f in np.unique(frame):
            ii = np.where(frame == f)[0]
            if ii.size < MIN_FRAME_STARS:
                continue
            a = r[ii]
            for k, i in enumerate(ii):
                corr[i] = a[k] - np.median(np.delete(a, k))
        out[c] = corr
    return out


PHASE_BINS = 10


def phase_correct(T, m):
    """Cross-validated empirical pixel-phase (S-curve) correction, per detector and axis.

    The S-curve (median pixel residual vs Gaia-predicted sub-pixel phase, PHASE_BINS bins,
    periodic linear interpolation) is derived from a random half of the stars (fixed seed) and
    applied to the other half, and vice versa, so no star corrects itself. (Gaia DR3 source_id
    parity cannot be used: the low bit is 0 for every source in these fields.) The pixel correction
    is mapped to sky with the local WCS Jacobian. Returns dict of corrected dra, ddec, dx, dy."""
    det = np.asarray(T["detector"])
    sid = np.asarray(T["source_id"])
    usid = np.unique(sid)
    half_of = dict(zip(usid, np.random.default_rng(12345).permutation(len(usid)) % 2))
    half = np.array([half_of[k] for k in sid])
    out = {"dx": np.asarray(T[f"dx_{m}"], float).copy(), "dy": np.asarray(T[f"dy_{m}"], float).copy()}
    cx = np.zeros(len(T))
    cy = np.zeros(len(T))
    edges = np.linspace(-0.5, 0.5, PHASE_BINS + 1)
    cen = 0.5 * (edges[:-1] + edges[1:])
    for ax, corr in (("x", cx), ("y", cy)):
        ph = (np.asarray(T[f"{ax}_pred"], float) + 0.5) % 1.0 - 0.5
        r = np.asarray(T[f"d{ax}_{m}"], float)
        for d in np.unique(det):
            for h in (0, 1):
                train = (det == d) & (half != h)
                apply = (det == d) & (half == h)
                if train.sum() < 20 * PHASE_BINS or not apply.any():
                    continue
                med = np.array([np.median(r[train & (ph >= a) & (ph < b)]) if np.any(train & (ph >= a) & (ph < b))
                                else 0.0 for a, b in zip(edges[:-1], edges[1:])])
                xp = np.r_[cen[-1] - 1, cen, cen[0] + 1]
                fp = np.r_[med[-1], med, med[0]]
                corr[apply] = np.interp(ph[apply], xp, fp)
    out["dx"] -= cx
    out["dy"] -= cy
    out["dra"] = np.asarray(T[f"dra_{m}"], float) - (np.asarray(T["j_ra_x"]) * cx + np.asarray(T["j_ra_y"]) * cy)
    out["ddec"] = np.asarray(T[f"ddec_{m}"], float) - (np.asarray(T["j_dec_x"]) * cx + np.asarray(T["j_dec_y"]) * cy)
    return out


def build_pairs(T):
    sid = np.asarray(T["source_id"])
    order = np.argsort(sid, kind="stable")
    s_sorted = sid[order]
    starts = np.r_[0, np.where(np.diff(s_sorted) != 0)[0] + 1]
    ends = np.r_[starts[1:], len(s_sorted)]
    I, J = [], []
    for a, b in zip(starts, ends):
        n = b - a
        if n < 2:
            continue
        iu, ju = np.triu_indices(n, 1)
        I.append(order[a + iu])
        J.append(order[a + ju])
    if not I:
        return np.zeros(0, int), np.zeros(0, int)
    return np.concatenate(I), np.concatenate(J)


def pair_stats(d, sid, sel):
    """Robust scatter of d[sel] plus equal-weight-per-star bootstrap (value, err)."""
    dd = d[sel]
    ss = sid[sel]
    good = np.isfinite(dd)
    dd, ss = dd[good], ss[good]
    out = dict(n=int(dd.size), nstar=int(np.unique(ss).size), rsd=rsd(dd), med=float(np.median(dd)) if dd.size else np.nan)
    if dd.size < 10:
        out.update(eq=np.nan, eq_err=np.nan)
        return out
    # equal weight: at most K_PER_STAR random pairs per star
    o = np.argsort(ss, kind="stable")
    ss, dd = ss[o], dd[o]
    st = np.r_[0, np.where(np.diff(ss) != 0)[0] + 1]
    en = np.r_[st[1:], ss.size]
    groups = []
    for a, b in zip(st, en):
        if b - a > K_PER_STAR:
            groups.append(dd[a + RNG.choice(b - a, K_PER_STAR, replace=False)])
        else:
            groups.append(dd[a:b])
    eq = rsd(np.concatenate(groups))
    boots = []
    ng = len(groups)
    for _ in range(N_BOOT):
        pick = RNG.integers(0, ng, ng)
        boots.append(rsd(np.concatenate([groups[k] for k in pick])))
    out.update(eq=eq, eq_err=float(np.nanstd(boots)))
    return out


def fmt(x, nd=3):
    return "   nan" if x is None or not np.isfinite(x) else f"{x:.{nd}f}"


def analyse(field, T, frames, method, mjd_ref):
    m = method
    other = "win" if m == "gauss" else "gauss"
    pix = float(np.median([f["pixscale"] for f in frames]))
    print(f"\n================ {field}: method={m}  (pixel scale median {pix:.4f} arcsec/px) ================")
    res = {"script": SCRIPT, "method": m, "pixscale_arcsec": metric(round(pix, 4), "arcsec/px", n=len(frames), script=SCRIPT)}

    # ---------- cut counts
    print("\nSelection (cumulative; star-frame instances, and distinct Gaia stars surviving in >= 1 frame):")
    cc, cs = {}, {}
    for k in reg.CUT_ORDER:
        cc[k] = int(sum(f["counts"][k] for f in frames))
        u = set()
        for f in frames:
            u.update(f["surv"][k])
        cs[k] = len(u)
        print(f"  {k:15s} {cc[k]:8d}   stars {cs[k]:6d}")
    fh = {}
    for f in frames:
        for k, v in f["flag_hits"].items():
            fh[k] = fh.get(k, 0) + v
    fha = {}
    for f in frames:
        for k, v in f["flag_hits_accepted"].items():
            fha[k] = fha.get(k, 0) + v
    missing = sorted({n for f in frames for n in f["missing_flag_names"]})
    print(f"  5x5-stamp flag hits among the {cc['isolated']} star-frames reaching the flag cut "
          f"(a star can hit several): {json.dumps(fh)}")
    print(f"  not-rejected flags present in ACCEPTED stamps: {json.dumps(fha)}")
    if missing:
        print(f"  reject-list names absent from MSKN keys (bit unused): {missing}")
    sel = {"g_window": [reg.G_MIN, reg.G_MAX], "g_window_reason": G_WINDOW_REASON,
           "ruwe_max": reg.RUWE_MAX, "isolation": f"no Gaia source with G < G_star+{reg.ISO_DMAG} within "
           f"{reg.ISO_RADIUS_AS} arcsec; none with G < {reg.BRIGHT_G} within {reg.BRIGHT_RADIUS_AS} arcsec",
           "edge_px": reg.EDGE_PX, "snr_min_peak": reg.SNR_MIN, "chi2r_max": reg.CHI2R_MAX,
           "max_resid_px": reg.MAX_RESID_PX, "flags_rejected_5x5": list(reg.REJECT_FLAG_NAMES),
           "cut_counts_star_frames": cc, "cut_counts_distinct_stars": cs, "flag_hits_5x5": fh,
           "flag_hits_in_accepted": fha}
    res["selection"] = sel
    if len(T) == 0:
        print("  no accepted measurements")
        return res

    fr = np.asarray(T["frame"])
    sid = np.asarray(T["source_id"])
    det = np.asarray(T["detector"])
    mjd = np.asarray(T["mjd"])
    G = np.asarray(T["G"])
    dra, ddec = np.asarray(T[f"dra_{m}"]), np.asarray(T[f"ddec_{m}"])
    dx, dy = np.asarray(T[f"dx_{m}"]), np.asarray(T[f"dy_{m}"])
    era, edec = np.asarray(T[f"era_{m}"]), np.asarray(T[f"edec_{m}"])
    nfr = len(np.unique(fr))
    nst = len(np.unique(sid))
    print(f"\nAccepted: {len(T)} measurements, {nst} stars, {nfr} frames with >= 1 star "
          f"(of {len(frames)} cutouts)")
    res["n_measurements"] = metric(len(T), "count", script=SCRIPT)
    res["n_stars"] = metric(nst, "count", script=SCRIPT)
    res["n_frames"] = metric(nfr, "count", script=SCRIPT, note=f"of {len(frames)} cutouts")

    # ---------- absolute per frame
    rows = []
    for f in np.unique(fr):
        ii = fr == f
        if ii.sum() < MIN_FRAME_STARS:
            continue
        rows.append((f, det[ii][0], frames[f]["visit"], ii.sum(), np.median(dra[ii]), np.median(ddec[ii]),
                     rsd(dra[ii]), rsd(ddec[ii]), np.median(dx[ii]), np.median(dy[ii]), rsd(dx[ii]), rsd(dy[ii])))
    A = np.array(rows, float)
    print(f"\nAbsolute residual (measured - Gaia), per frame with >= {MIN_FRAME_STARS} stars: {len(A)} frames")
    print("                        RA* [\"]   Dec [\"]    x [px]    y [px]")
    print(f"  median |frame median|  {np.median(np.abs(A[:, 4])):.3f}     {np.median(np.abs(A[:, 5])):.3f}"
          f"     {np.median(np.abs(A[:, 8])):.4f}    {np.median(np.abs(A[:, 9])):.4f}")
    print(f"  median of frame medians{np.median(A[:, 4]):+.3f}    {np.median(A[:, 5]):+.3f}"
          f"    {np.median(A[:, 8]):+.4f}   {np.median(A[:, 9]):+.4f}")
    print(f"  rsd of frame medians   {rsd(A[:, 4]):.3f}     {rsd(A[:, 5]):.3f}     {rsd(A[:, 8]):.4f}    {rsd(A[:, 9]):.4f}")
    for lab, c in (("per-frame scatter p16", 16), ("per-frame scatter p50", 50), ("per-frame scatter p84", 84)):
        print(f"  {lab:22s} {np.percentile(A[:, 6], c):.3f}     {np.percentile(A[:, 7], c):.3f}"
              f"     {np.percentile(A[:, 10], c):.4f}    {np.percentile(A[:, 11], c):.4f}")
    print(f"  stars per frame: min {int(A[:, 3].min())}, median {int(np.median(A[:, 3]))}, max {int(A[:, 3].max())}")
    # expected scatter of a frame median from noise alone: 1.2533 * per-frame rsd / sqrt(n)
    exp_ra = np.median(1.2533 * A[:, 6] / np.sqrt(A[:, 3]))
    exp_de = np.median(1.2533 * A[:, 7] / np.sqrt(A[:, 3]))
    print(f"  frame-median scatter expected from star noise alone: RA* {exp_ra:.3f}\"  Dec {exp_de:.3f}\" "
          f"(observed {rsd(A[:, 4]):.3f}\", {rsd(A[:, 5]):.3f}\")")
    print("  frame medians by detector (median and rsd over frames, arcsec):")
    for d in sorted(np.unique(A[:, 1]).astype(int)):
        s = A[:, 1] == d
        print(f"    D{d}: nframes {s.sum():4d}  RA* {np.median(A[s, 4]):+.3f} (rsd {rsd(A[s, 4]):.3f})  "
              f"Dec {np.median(A[s, 5]):+.3f} (rsd {rsd(A[s, 5]):.3f})  per-frame scatter RA* {np.median(A[s, 6]):.3f} "
              f"Dec {np.median(A[s, 7]):.3f}")
    print("  frame medians by visit (arcsec):")
    for v in sorted(np.unique(A[:, 2]).astype(int)):
        s = A[:, 2] == v
        mj = np.median([frames[int(f)]["mjd"] for f in A[s, 0]])
        print(f"    visit {v:2d} (MJD {mj:.0f}): nframes {s.sum():4d}  RA* {np.median(A[s, 4]):+.3f} "
              f"(rsd {rsd(A[s, 4]):.3f})  Dec {np.median(A[s, 5]):+.3f} (rsd {rsd(A[s, 5]):.3f})")
    res["absolute"] = {
        "median_abs_frame_offset_ra": metric(round(float(np.median(np.abs(A[:, 4]))), 4), "arcsec", n=len(A), script=SCRIPT),
        "median_abs_frame_offset_dec": metric(round(float(np.median(np.abs(A[:, 5]))), 4), "arcsec", n=len(A), script=SCRIPT),
        "rsd_frame_offsets_ra": metric(round(rsd(A[:, 4]), 4), "arcsec", n=len(A), script=SCRIPT),
        "rsd_frame_offsets_dec": metric(round(rsd(A[:, 5]), 4), "arcsec", n=len(A), script=SCRIPT),
        "expected_rsd_frame_offsets_noise_only_ra": metric(round(float(exp_ra), 4), "arcsec", n=len(A), script=SCRIPT),
        "expected_rsd_frame_offsets_noise_only_dec": metric(round(float(exp_de), 4), "arcsec", n=len(A), script=SCRIPT),
        "per_frame_scatter_median_ra": metric(round(float(np.median(A[:, 6])), 4), "arcsec", n=len(A), script=SCRIPT),
        "per_frame_scatter_median_dec": metric(round(float(np.median(A[:, 7])), 4), "arcsec", n=len(A), script=SCRIPT),
        "per_frame_scatter_median_x": metric(round(float(np.median(A[:, 10])), 5), "px", n=len(A), script=SCRIPT),
        "per_frame_scatter_median_y": metric(round(float(np.median(A[:, 11])), 5), "px", n=len(A), script=SCRIPT),
        "stars_per_frame_median": metric(int(np.median(A[:, 3])), "count", n=len(A), script=SCRIPT),
    }

    # ---------- pairs
    corr = loo_correct(T, m)
    I, J = build_pairs(T)
    dt = np.abs(mjd[I] - mjd[J])
    cls = pair_class_vec(dt)
    # verify the vectorised classes against wp.exposures.pair_class on a sample
    chk = RNG.choice(len(I), min(2000, len(I)), replace=False) if len(I) else []
    assert all(pair_class(dt[k]) == cls[k] for k in chk), "pair_class_vec disagrees with pair_class"
    same_det = det[I] == det[J]
    simul = dt < 0.01
    psid = sid[I]
    pc = phase_correct(T, m)
    pcl = loo_correct(T, m, base=pc)
    D = {"ra": dra[I] - dra[J], "dec": ddec[I] - ddec[J], "x": dx[I] - dx[J], "y": dy[I] - dy[J]}
    DP = {"ra": pcl["dra"][I] - pcl["dra"][J], "dec": pcl["ddec"][I] - pcl["ddec"][J],
          "x": pcl["dx"][I] - pcl["dx"][J], "y": pcl["dy"][I] - pcl["dy"][J]}
    DC = {"ra": corr["dra"][I] - corr["dra"][J], "dec": corr["ddec"][I] - corr["ddec"][J],
          "x": corr["dx"][I] - corr["dx"][J], "y": corr["dy"][I] - corr["dy"][J]}
    SIG = {"ra": np.hypot(era[I], era[J]), "dec": np.hypot(edec[I], edec[J])}
    print(f"\nFrame-to-frame pairs: {len(I)} pairs from {len(np.unique(psid))} stars. d = r_i - r_j, "
          f"r = measured - Gaia(t). Per-PAIR scatter (= sqrt(2) x single-frame scatter if frames are independent).")
    print("  'corr' = after subtracting each frame's leave-one-out median residual (other stars only).")
    print("  eq = equal weight per star (<= %d random pairs/star), +- = bootstrap over stars (%d resamples)." % (K_PER_STAR, N_BOOT))
    hdr = ("  class                 Npairs  Nstars | raw RA*  raw Dec [\"] | raw RA* raw Dec [px] | corr RA* corr Dec [\"]"
           " | corr RA* corr Dec [px] | eq raw RA*      eq raw Dec      | eq corr RA*     eq corr Dec")
    print(hdr)
    res["pairs"] = {}

    def row(label, s, key=None):
        if s.sum() < 3:
            print(f"  {label:20s} {int(s.sum()):7d}  (too few)")
            return
        r_ra, r_de = pair_stats(D["ra"], psid, s), pair_stats(D["dec"], psid, s)
        c_ra, c_de = pair_stats(DC["ra"], psid, s), pair_stats(DC["dec"], psid, s)
        print(f"  {label:20s} {r_ra['n']:7d} {r_ra['nstar']:6d} | {fmt(r_ra['rsd'])}   {fmt(r_de['rsd'])}      |"
              f" {fmt(r_ra['rsd'] / pix, 4)}  {fmt(r_de['rsd'] / pix, 4)}       | {fmt(c_ra['rsd'])}    {fmt(c_de['rsd'])}"
              f"        | {fmt(c_ra['rsd'] / pix, 4)}   {fmt(c_de['rsd'] / pix, 4)}         |"
              f" {fmt(r_ra['eq'])}+-{fmt(r_ra['eq_err'])} {fmt(r_de['eq'])}+-{fmt(r_de['eq_err'])} |"
              f" {fmt(c_ra['eq'])}+-{fmt(c_ra['eq_err'])} {fmt(c_de['eq'])}+-{fmt(c_de['eq_err'])}")
        if key:
            n, ns = r_ra["n"], r_ra["nstar"]
            note = "per-pair robust scatter (1.4826 MAD); single-frame equivalent = value / sqrt(2)"
            res["pairs"][key] = {
                "n_pairs": n, "n_stars": ns,
                "raw_ra_arcsec": metric(round(r_ra["rsd"], 4), "arcsec", n=n, script=SCRIPT, note=note),
                "raw_dec_arcsec": metric(round(r_de["rsd"], 4), "arcsec", n=n, script=SCRIPT, note=note),
                "raw_ra_px": metric(round(r_ra["rsd"] / pix, 5), "px", n=n, script=SCRIPT),
                "raw_dec_px": metric(round(r_de["rsd"] / pix, 5), "px", n=n, script=SCRIPT),
                "corr_ra_arcsec": metric(round(c_ra["rsd"], 4), "arcsec", n=c_ra["n"], script=SCRIPT, note=note + "; leave-one-out per-frame median shift removed"),
                "corr_dec_arcsec": metric(round(c_de["rsd"], 4), "arcsec", n=c_de["n"], script=SCRIPT, note=note + "; leave-one-out per-frame median shift removed"),
                "corr_ra_px": metric(round(c_ra["rsd"] / pix, 5), "px", n=c_ra["n"], script=SCRIPT),
                "corr_dec_px": metric(round(c_de["rsd"] / pix, 5), "px", n=c_de["n"], script=SCRIPT),
                "single_frame_equiv_corr_ra_arcsec": metric(round(c_ra["rsd"] / np.sqrt(2), 4), "arcsec", n=c_ra["n"], script=SCRIPT),
                "single_frame_equiv_corr_dec_arcsec": metric(round(c_de["rsd"] / np.sqrt(2), 4), "arcsec", n=c_de["n"], script=SCRIPT),
                "eqweight_raw_ra_arcsec": metric(round(r_ra["eq"], 4), "arcsec", n=ns, script=SCRIPT, note=f"<= {K_PER_STAR} pairs/star; err = bootstrap over stars: {r_ra['eq_err']:.4f}"),
                "eqweight_raw_dec_arcsec": metric(round(r_de["eq"], 4), "arcsec", n=ns, script=SCRIPT, note=f"err {r_de['eq_err']:.4f}"),
                "eqweight_corr_ra_arcsec": metric(round(c_ra["eq"], 4), "arcsec", n=ns, script=SCRIPT, note=f"err {c_ra['eq_err']:.4f}"),
                "eqweight_corr_dec_arcsec": metric(round(c_de["eq"], 4), "arcsec", n=ns, script=SCRIPT, note=f"err {c_de['eq_err']:.4f}"),
            }

    for c in CLASSES:
        row(c, cls == c, c)
    inter = np.isin(cls, INTER)
    row("inter-visit 6/12/18", inter, "inter_visit")
    row("all pairs", np.ones(len(I), bool), "all")
    print("  -- same_visit split:")
    row("  simultaneous(<15m)", (cls == "same_visit") & simul, "same_visit_simultaneous")
    row("  same det", (cls == "same_visit") & same_det, "same_visit_same_det")
    row("  diff det", (cls == "same_visit") & ~same_det, "same_visit_diff_det")
    row("  diff det, not sim.", (cls == "same_visit") & ~same_det & ~simul)
    print("  -- inter-visit split:")
    row("  same det", inter & same_det, "inter_visit_same_det")
    row("  diff det", inter & ~same_det, "inter_visit_diff_det")
    print("  -- by detector (both frames on that detector):")
    for d in sorted(np.unique(det)):
        row(f"  D{d} same_visit", (cls == "same_visit") & same_det & (det[I] == d))
        row(f"  D{d} inter-visit", inter & same_det & (det[I] == d))

    print("\n  Detector-axis pair scatter (same detector only, px; x/y are detector axes):")
    print("  class                 Npairs | raw x   raw y  | corr x  corr y")
    for lab, s in (("same_visit", (cls == "same_visit") & same_det), ("inter-visit", inter & same_det)):
        if s.sum() >= 3:
            print(f"  {lab:20s} {int(s.sum()):7d} | {rsd(D['x'][s]):.4f}  {rsd(D['y'][s]):.4f} | "
                  f"{rsd(DC['x'][s]):.4f}  {rsd(DC['y'][s]):.4f}")

    print("\n  Diagnostic: pixel-phase (S-curve) + frame-shift corrected, cross-validated (S-curve from the other, "
          "random half of the stars). Per pair:")
    print("  class                 Npairs | RA*  Dec [\"] | RA*  Dec [px] | det x  det y [px, same det] | eq RA* +- err   eq Dec +- err")
    res["pairs_phase_corrected"] = {}
    for lab, s in (("same_visit", cls == "same_visit"), ("6mo", cls == "6mo"), ("12mo", cls == "12mo"),
                   ("18mo", cls == "18mo"), ("other", cls == "other"), ("inter_visit", inter)):
        if s.sum() < 10:
            continue
        a, b = pair_stats(DP["ra"], psid, s), pair_stats(DP["dec"], psid, s)
        sd = s & same_det
        print(f"  {lab:20s} {a['n']:7d} | {a['rsd']:.3f} {b['rsd']:.3f} | {a['rsd'] / pix:.4f} {b['rsd'] / pix:.4f} |"
              f" {rsd(DP['x'][sd]):.4f} {rsd(DP['y'][sd]):.4f}              | {a['eq']:.3f}+-{a['eq_err']:.3f}  {b['eq']:.3f}+-{b['eq_err']:.3f}")
        note = "diagnostic; cross-validated empirical pixel-phase correction per detector/axis + LOO frame shift"
        res["pairs_phase_corrected"][lab] = {
            "n_pairs": a["n"], "n_stars": a["nstar"],
            "ra_arcsec": metric(round(a["rsd"], 4), "arcsec", n=a["n"], script=SCRIPT, note=note),
            "dec_arcsec": metric(round(b["rsd"], 4), "arcsec", n=b["n"], script=SCRIPT, note=note),
            "ra_px": metric(round(a["rsd"] / pix, 5), "px", n=a["n"], script=SCRIPT),
            "dec_px": metric(round(b["rsd"] / pix, 5), "px", n=b["n"], script=SCRIPT),
        }
    for lab, s in (("same_visit", cls == "same_visit"), ("inter_visit", inter)):
        if s.sum() >= 10:
            fl = {q: float(np.median(SIG[q][s])) for q in ("ra", "dec")}
            zz = {q: rsd(DP[q][s] / SIG[q][s]) for q in ("ra", "dec")}
            ex = {q: float(np.sqrt(max(0.0, rsd(DP[q][s]) ** 2 - fl[q] ** 2))) for q in ("ra", "dec")}
            print(f"  {lab}: rsd(z) RA* {zz['ra']:.2f} Dec {zz['dec']:.2f}; excess over floor RA* {ex['ra']:.3f}\" "
                  f"Dec {ex['dec']:.3f}\" per pair")
            res["pairs_phase_corrected"][lab]["z_rsd_ra"] = metric(round(zz["ra"], 3), "dimensionless", n=int(s.sum()), script=SCRIPT)
            res["pairs_phase_corrected"][lab]["z_rsd_dec"] = metric(round(zz["dec"], 3), "dimensionless", n=int(s.sum()), script=SCRIPT)
            res["pairs_phase_corrected"][lab]["excess_ra_arcsec"] = metric(round(ex["ra"], 4), "arcsec", n=int(s.sum()), script=SCRIPT)
            res["pairs_phase_corrected"][lab]["excess_dec_arcsec"] = metric(round(ex["dec"], 4), "arcsec", n=int(s.sum()), script=SCRIPT)

    # ---------- noise floor, calibration, excess
    print("\nNoise floor from formal errors (method %s): floor = median sqrt(sigma_i^2 + sigma_j^2); "
          "z = d / sqrt(sigma_i^2 + sigma_j^2); excess = sqrt(max(0, obs^2 - floor^2)), obs = corrected pair rsd." % m)
    print("  class            Npairs | floor RA*  Dec [\"] | obs corr RA*  Dec | rsd(z) raw RA* Dec | rsd(z) corr RA* Dec | excess RA*  Dec [\"] (single-frame: /sqrt2)")
    res["noise"] = {}
    for lab, s in (("same_visit", cls == "same_visit"), ("6mo", cls == "6mo"), ("12mo", cls == "12mo"),
                   ("18mo", cls == "18mo"), ("inter_visit", inter)):
        if s.sum() < 10:
            continue
        fl = {a: float(np.median(SIG[a][s])) for a in ("ra", "dec")}
        ob = {a: rsd(DC[a][s]) for a in ("ra", "dec")}
        zr = {a: rsd(D[a][s] / SIG[a][s]) for a in ("ra", "dec")}
        zc = {a: rsd(DC[a][s] / SIG[a][s]) for a in ("ra", "dec")}
        ex = {a: float(np.sqrt(max(0.0, ob[a] ** 2 - fl[a] ** 2))) for a in ("ra", "dec")}
        print(f"  {lab:15s} {int(s.sum()):7d} | {fl['ra']:.3f}  {fl['dec']:.3f}       | {ob['ra']:.3f}  {ob['dec']:.3f}"
              f"       | {zr['ra']:.2f}  {zr['dec']:.2f}           | {zc['ra']:.2f}  {zc['dec']:.2f}            |"
              f" {ex['ra']:.3f}  {ex['dec']:.3f}")
        n = int(s.sum())
        res["noise"][lab] = {
            "floor_ra_arcsec": metric(round(fl["ra"], 4), "arcsec", n=n, script=SCRIPT, note="median per-pair formal sigma"),
            "floor_dec_arcsec": metric(round(fl["dec"], 4), "arcsec", n=n, script=SCRIPT),
            "z_rsd_raw_ra": metric(round(zr["ra"], 3), "dimensionless", n=n, script=SCRIPT, note="1 if formal errors calibrated and WCS adds nothing"),
            "z_rsd_raw_dec": metric(round(zr["dec"], 3), "dimensionless", n=n, script=SCRIPT),
            "z_rsd_corr_ra": metric(round(zc["ra"], 3), "dimensionless", n=n, script=SCRIPT),
            "z_rsd_corr_dec": metric(round(zc["dec"], 3), "dimensionless", n=n, script=SCRIPT),
            "excess_pair_ra_arcsec": metric(round(ex["ra"], 4), "arcsec", n=n, script=SCRIPT, note="per pair, after LOO frame-shift correction"),
            "excess_pair_dec_arcsec": metric(round(ex["dec"], 4), "arcsec", n=n, script=SCRIPT),
        }

    # ---------- vs G
    print("\nPair scatter vs G (corrected; per pair, arcsec; floor = median formal pair sigma):")
    print("  G bin       class        Npairs Nstars | obs RA*  Dec  | floor RA*  Dec | rsd(z) RA* Dec | raw RA*  Dec | phase+frame corr RA* Dec")
    gb = []
    for lo, hi in zip(G_EDGES[:-1], G_EDGES[1:]):
        gs = (G[I] >= lo) & (G[I] < hi)
        for lab, s0 in (("same_visit", cls == "same_visit"), ("inter_visit", inter)):
            s = gs & s0
            if s.sum() < 10:
                continue
            ob = [rsd(DC["ra"][s]), rsd(DC["dec"][s])]
            fl = [float(np.median(SIG["ra"][s])), float(np.median(SIG["dec"][s]))]
            zc = [rsd(DC["ra"][s] / SIG["ra"][s]), rsd(DC["dec"][s] / SIG["dec"][s])]
            rw = [rsd(D["ra"][s]), rsd(D["dec"][s])]
            pp = [rsd(DP["ra"][s]), rsd(DP["dec"][s])]
            ns = len(np.unique(psid[s]))
            print(f"  {lo:4.1f}-{hi:4.1f}  {lab:12s} {int(s.sum()):7d} {ns:5d} | {ob[0]:.3f}  {ob[1]:.3f} | "
                  f"{fl[0]:.3f}  {fl[1]:.3f} | {zc[0]:.2f}  {zc[1]:.2f}    | {rw[0]:.3f}  {rw[1]:.3f} | {pp[0]:.3f}  {pp[1]:.3f}")
            gb.append(dict(g_lo=lo, g_hi=hi, cls=lab, n=int(s.sum()), nstar=ns, obs_ra=ob[0], obs_dec=ob[1],
                           floor_ra=fl[0], floor_dec=fl[1], z_ra=zc[0], z_dec=zc[1], raw_ra=rw[0], raw_dec=rw[1], ph_ra=pp[0], ph_dec=pp[1]))
    res["vs_mag"] = [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items()} for r in gb]

    # ---------- method comparison
    print("\nCentroid method comparison (same stars, same frames):")
    ddx = np.asarray(T["x_gauss"]) - np.asarray(T["x_win"])
    ddy = np.asarray(T["y_gauss"]) - np.asarray(T["y_win"])
    dra_gw = np.asarray(T["dra_gauss"]) - np.asarray(T["dra_win"])
    dde_gw = np.asarray(T["ddec_gauss"]) - np.asarray(T["ddec_win"])
    print(f"  gauss - win: median x {np.median(ddx):+.4f} px, y {np.median(ddy):+.4f} px; rsd x {rsd(ddx):.4f} px, "
          f"y {rsd(ddy):.4f} px; sky rsd RA* {rsd(dra_gw):.3f}\", Dec {rsd(dde_gw):.3f}\"")
    phx = (np.asarray(T["x_pred"]) + 0.5) % 1.0 - 0.5
    phy = (np.asarray(T["y_pred"]) + 0.5) % 1.0 - 0.5
    print("  pixel-phase dependence (phase = Gaia-predicted x - nearest pixel centre):")
    print("   phase bin      N   med dx_gauss  med dx_win  med(gauss-win) | (y axis) med dy_gauss  med dy_win")
    pb = np.linspace(-0.5, 0.5, 6)
    ph_rows = []
    for a, b in zip(pb[:-1], pb[1:]):
        s = (phx >= a) & (phx < b)
        sy = (phy >= a) & (phy < b)
        r = (a, b, int(s.sum()), np.median(T["dx_gauss"][s]), np.median(T["dx_win"][s]), np.median(ddx[s]),
             np.median(T["dy_gauss"][sy]), np.median(T["dy_win"][sy]))
        ph_rows.append(r)
        print(f"   {a:+.1f}..{b:+.1f} {r[2]:6d}   {r[3]:+.4f}       {r[4]:+.4f}     {r[5]:+.4f}        |"
              f"          {r[6]:+.4f}     {r[7]:+.4f}")
    res["method_comparison"] = {
        "median_gauss_minus_win_x": metric(round(float(np.median(ddx)), 5), "px", n=len(T), script=SCRIPT),
        "median_gauss_minus_win_y": metric(round(float(np.median(ddy)), 5), "px", n=len(T), script=SCRIPT),
        "rsd_gauss_minus_win_x": metric(round(rsd(ddx), 5), "px", n=len(T), script=SCRIPT),
        "rsd_gauss_minus_win_y": metric(round(rsd(ddy), 5), "px", n=len(T), script=SCRIPT),
        "phase_bias_peak_to_peak_x_gauss": metric(round(float(max(r[3] for r in ph_rows) - min(r[3] for r in ph_rows)), 5), "px", n=len(T), script=SCRIPT),
        "phase_bias_peak_to_peak_x_win": metric(round(float(max(r[4] for r in ph_rows) - min(r[4] for r in ph_rows)), 5), "px", n=len(T), script=SCRIPT),
    }
    # pair scatter for both methods, corrected, compact
    print("  corrected per-pair scatter by method (arcsec RA*, Dec):")
    for mm in ("gauss", "win"):
        cm = corr if mm == m else loo_correct(T, mm)
        out = []
        for lab, s in (("same_visit", cls == "same_visit"), ("inter_visit", inter)):
            a = cm["dra"][I] - cm["dra"][J]
            b = cm["ddec"][I] - cm["ddec"][J]
            out.append(f"{lab} {rsd(a[s]):.3f} {rsd(b[s]):.3f}")
            res["method_comparison"][f"{mm}_{lab}_corr_pair_rsd_ra"] = metric(round(rsd(a[s]), 4), "arcsec", n=int(s.sum()), script=SCRIPT)
            res["method_comparison"][f"{mm}_{lab}_corr_pair_rsd_dec"] = metric(round(rsd(b[s]), 4), "arcsec", n=int(s.sum()), script=SCRIPT)
        print(f"   {mm:6s} " + " | ".join(out))

    # ---------- headline
    sv = res["pairs"].get("same_visit", {})
    iv = res["pairs"].get("inter_visit", {})
    res["headline"] = {
        "note": "Per-pair robust scatter of frame-to-frame differences of Gaia residuals after leave-one-out "
                "frame-shift correction, Gaussian-fit centroids. Divide by sqrt(2) for single-frame precision.",
        "same_visit_corr_ra_arcsec": sv.get("corr_ra_arcsec"),
        "same_visit_corr_dec_arcsec": sv.get("corr_dec_arcsec"),
        "inter_visit_corr_ra_arcsec": iv.get("corr_ra_arcsec"),
        "inter_visit_corr_dec_arcsec": iv.get("corr_dec_arcsec"),
        "inter_visit_raw_ra_arcsec": iv.get("raw_ra_arcsec"),
        "inter_visit_raw_dec_arcsec": iv.get("raw_dec_arcsec"),
    }

    figures(field, D, DC, DP, cls, inter, gb, pix, m)
    hand_check(field, T, frames, m)
    return res


# ------------------------------------------------------------------ figures --------------
def figures(field, D, DC, DP, cls, inter, gb, pix, m):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    FIGURES.mkdir(parents=True, exist_ok=True)
    present = [c for c in ("same_visit", "6mo", "12mo", "18mo") if np.sum(cls == c) >= 10]
    fig, axes = plt.subplots(len(present), 2, figsize=(10, 2.6 * len(present) + 0.8), squeeze=False)
    for r, c in enumerate(present):
        s = cls == c
        for k, (a, lab) in enumerate((("ra", "RA*"), ("dec", "Dec"))):
            ax = axes[r, k]
            raw, cor, php = D[a][s], DC[a][s], DP[a][s]
            cor = cor[np.isfinite(cor)]
            php = php[np.isfinite(php)]
            lim = max(4 * rsd(raw), 0.3)
            bins = np.linspace(-lim, lim, 61)
            ax.hist(raw, bins, histtype="step", color="0.45", lw=1.4, label=f"raw  rsd {rsd(raw):.3f}\"")
            ax.hist(cor, bins, histtype="step", color="C0", lw=1.6, label=f"frame-shift corrected  rsd {rsd(cor):.3f}\"")
            ax.hist(php, bins, histtype="step", color="C2", lw=1.3, ls="--",
                    label=f"+ pixel-phase corrected (diagnostic)  rsd {rsd(php):.3f}\"")
            ax.set_title(f"{c}: d{lab} (N = {s.sum()} pairs)", fontsize=10)
            ax.set_xlabel(f"pair difference d{lab} [arcsec]  (1 px = {pix:.2f}\")")
            ax.set_ylabel("pairs")
            ax.legend(fontsize=8, frameon=False, loc="upper left")
    fig.suptitle(f"{field}: frame-to-frame differences of (measured - Gaia DR3) star positions, method {m}",
                 fontsize=11)
    fig.tight_layout()
    p1 = FIGURES / f"registration_pairs_{field}.png"
    fig.savefig(p1, dpi=130)
    plt.close(fig)

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.4), sharey=True)
    for k, (a, lab) in enumerate((("ra", "RA*"), ("dec", "Dec"))):
        ax = axes[k]
        for cl, col in (("same_visit", "C0"), ("inter_visit", "C3")):
            rr = [r for r in gb if r["cls"] == cl]
            if not rr:
                continue
            gx = np.array([(r["g_lo"] + r["g_hi"]) / 2 for r in rr])
            ax.plot(gx, [r[f"obs_{a}"] for r in rr], "o-", color=col, label=f"{cl}, corrected")
            ax.plot(gx, [r[f"raw_{a}"] for r in rr], "x:", color=col, alpha=0.7, label=f"{cl}, raw")
            ax.plot(gx, [r[f"ph_{a}"] for r in rr], "s-.", color=col, alpha=0.6, ms=4, label=f"{cl}, + phase corrected")
            ax.plot(gx, [r[f"floor_{a}"] for r in rr], "--", color=col, alpha=0.6, label=f"{cl}, noise floor")
            for x_, r in zip(gx, rr):
                ax.annotate(f"{r['n'] / 1000:.0f}k pairs, {r['nstar']} stars", (x_, r[f"obs_{a}"]), textcoords="offset points",
                            xytext=(4, 6 if cl == "same_visit" else -12), fontsize=7, color=col)
        ax.set_yscale("log")
        ax.set_xlabel("Gaia G [mag]")
        ax.set_title(f"d{lab}", fontsize=10)
        ax.grid(alpha=0.3, which="both")
        sec = ax.secondary_yaxis("right", functions=(lambda v: v / pix, lambda v: v * pix))
        sec.set_ylabel("[px]")
    axes[0].set_ylabel("per-pair robust scatter [arcsec]")
    axes[0].legend(fontsize=7, frameon=False)
    fig.suptitle(f"{field}: per-pair scatter vs brightness (labels on corrected points: N pairs, N stars), method {m}", fontsize=11)
    fig.tight_layout()
    p2 = FIGURES / f"registration_vs_mag_{field}.png"
    fig.savefig(p2, dpi=130)
    plt.close(fig)
    print(f"\nFigures: {p1}\n         {p2}")


# ------------------------------------------------------------------ hand check -----------
def hand_check(field, T, frames, m):
    from astropy.io import fits
    gaia = query_field(field)
    fr = np.asarray(T["frame"])
    nper = np.bincount(fr)
    f = int(np.argmax(nper))
    s = np.where((fr == f) & (np.asarray(T["G"]) > 13) & (np.asarray(T["G"]) < 15))[0]
    if s.size == 0:
        s = np.where(fr == f)[0]
    k = s[np.argmax(np.asarray(T["snr"])[s])]
    row = T[k]
    fm = frames[f]
    gi = int(np.where(np.asarray(gaia["source_id"]) == row["source_id"])[0][0])
    g = gaia[gi]
    with fits.open(ROOT / fm["path"]) as hl:
        h0 = hl[0].header
        w = reg.load_wcs(hl["IMAGE"].header)
        mjd = float(h0["MJD-AVG"])
    dt = (mjd - GAIA_EPOCH_MJD) / JULIAN_YEAR_D
    ra_p, de_p, _ = propagate(gaia[gi:gi + 1], mjd)
    ra_pm, de_pm, _ = propagate(gaia[gi:gi + 1], mjd, parallax=False)
    cosd = np.cos(np.deg2rad(g["dec"]))
    ra_lin = g["ra"] + g["pmra"] * dt / 3.6e6 / cosd
    de_lin = g["dec"] + g["pmdec"] * dt / 3.6e6
    x, y = float(row[f"x_{m}"]), float(row[f"y_{m}"])
    ra_m, de_m = w.pixel_to_world_values(x, y)
    ra_m1, de_m1 = w.all_pix2world([[x + 1, y + 1]], 1)[0]
    xg, yg = w.world_to_pixel_values(ra_p[0], de_p[0])
    dra = (ra_m - ra_p[0]) * np.cos(np.deg2rad(de_p[0])) * 3600
    dde = (de_m - de_p[0]) * 3600
    print(f"\nHand check ({field}): Gaia DR3 {g['source_id']}, G = {g['phot_g_mean_mag']:.3f}, frame {fm['obs_id']} D{fm['detector']}")
    print(f"  Gaia DR3 at J2016.0 (MJD {GAIA_EPOCH_MJD}): RA {g['ra']:.8f} deg, Dec {g['dec']:.8f} deg, "
          f"pmRA* {g['pmra']:.3f} mas/yr, pmDec {g['pmdec']:.3f} mas/yr, plx {g['parallax']:.3f} mas")
    print(f"  MJD-AVG = {mjd:.6f} (UTC; TDB differs by ~69 s, negligible) -> dt = ({mjd:.6f} - {GAIA_EPOCH_MJD}) / 365.25 = {dt:.6f} yr")
    print(f"  PM shift: east {g['pmra']:.3f} x {dt:.4f} = {g['pmra'] * dt:+.2f} mas, north {g['pmdec']:.3f} x {dt:.4f} = {g['pmdec'] * dt:+.2f} mas")
    print(f"  linear: RA = {g['ra']:.8f} + {g['pmra'] * dt:+.2f} mas / cos({g['dec']:.4f}) / 3.6e6 = {ra_lin:.8f}; "
          f"Dec = {g['dec']:.8f} + {g['pmdec'] * dt:+.2f}/3.6e6 = {de_lin:.8f}")
    print(f"  propagate() PM only:  RA {ra_pm[0]:.8f}, Dec {de_pm[0]:.8f}  (linear minus this: "
          f"{(ra_lin - ra_pm[0]) * cosd * 3.6e6:+.3f}, {(de_lin - de_pm[0]) * 3.6e6:+.3f} mas)")
    print(f"  parallax term: dRA* {(ra_p[0] - ra_pm[0]) * cosd * 3.6e6:+.3f} mas, dDec {(de_p[0] - de_pm[0]) * 3.6e6:+.3f} mas")
    print(f"  propagated position:  RA {ra_p[0]:.8f}, Dec {de_p[0]:.8f}  -> WCS pixel (0-based cutout) "
          f"x {float(xg):.4f}, y {float(yg):.4f}")
    print(f"  measured centroid ({m}): cutout x {x:.4f}, y {y:.4f} (0-based) = detector x {x + fm['x0']:.4f}, "
          f"y {y + fm['y0']:.4f}  (X0={fm['x0']}, Y0={fm['y0']}); formal err {row[f'ex_{m}']:.4f}, {row[f'ey_{m}']:.4f} px")
    print(f"  WCS(pixel_to_world_values, origin 0): RA {float(ra_m):.8f}, Dec {float(de_m):.8f}; "
          f"cross-check all_pix2world(x+1, y+1, origin 1): RA {ra_m1:.8f}, Dec {de_m1:.8f}")
    print(f"  residual: dRA* = ({float(ra_m):.8f} - {ra_p[0]:.8f}) x cos({de_p[0]:.5f}) x 3600 = {float(dra):+.4f} arcsec; "
          f"dDec = ({float(de_m):.8f} - {de_p[0]:.8f}) x 3600 = {float(dde):+.4f} arcsec")
    print(f"  pixel residual: x {x - float(xg):+.4f} px, y {y - float(yg):+.4f} px; table: "
          f"dRA* {row[f'dra_{m}']:+.4f}\", dDec {row[f'ddec_{m}']:+.4f}\"")


# ------------------------------------------------------------------ main -----------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", choices=["epsindi", "barnard", "all"], default="all")
    ap.add_argument("--method", choices=["gauss", "win"], default="gauss")
    ap.add_argument("--jobs", type=int, default=max(1, min(8, (os.cpu_count() or 2) - 1)))
    ap.add_argument("--refresh", action="store_true", help="re-measure all cutouts")
    a = ap.parse_args()
    warnings.simplefilter("ignore")
    fields = ["epsindi", "barnard"] if a.field == "all" else [a.field]
    t0 = time.time()
    for field in fields:
        if not (DATA / f"index_{field}.csv").exists():
            print(f"[{field}] no index, skipped")
            continue
        g = query_field(field)
        idx = Table.read(DATA / f"index_{field}.csv", format="ascii.csv")
        print(f"\n[{field}] Gaia DR3: {len(g)} sources (G < {g.meta.get('gmax')}, r = {g.meta.get('radius_deg')} deg)")
        check_propagation(g, float(np.median(idx["mjd_mid"])))
        T, frames, mjd_ref = load_field(field, a.jobs, a.refresh)
        if not frames:
            print(f"[{field}] no cutouts yet, skipped")
            continue
        res = analyse(field, T, frames, a.method, mjd_ref)
        res["n_cutouts"] = metric(len(frames), "count", script=SCRIPT, note=f"of {len(idx)} index rows")
        update_results(f"registration_{field}", res)
        REG_DIR.mkdir(parents=True, exist_ok=True)
        T.write(REG_DIR / f"meas_{field}.ecsv", overwrite=True)
        print(f"[{field}] results.json section registration_{field} written; measurements data/reg/meas_{field}.ecsv")
    print(f"\nTotal runtime {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
