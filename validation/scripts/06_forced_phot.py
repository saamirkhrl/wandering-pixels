"""06: native-pixel forced photometry, the per-source spectrally matched product M2, and the
catalogue-level plain pair P1native (phase B).

usage: uv run python scripts/06_forced_phot.py --field {barnard,epsindi} [--refresh] [--jobs N]

Writes data/phaseb/<field>/{forced_phot,forced_star_summary,fluxes_M2,fluxes_P1native}.ecsv and the
section phaseb_forced_<field> of docs/results.json. Definitions: wp/phaseb.py (pre-registered) and
wp/forced.py. Verification checks (a) hand aperture, (b) hand spectral model, (c) D1/D4 ratio run last.
"""
import argparse
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from astropy.io import fits  # noqa: E402
from astropy.table import Table, vstack  # noqa: E402

from wp import phaseb  # noqa: E402
from wp.config import DATA  # noqa: E402
from wp.forced import REASONS, VERSION, measure_exposure, spec_model_flat  # noqa: E402
from wp.results import metric, update_results  # noqa: E402
from wp.wavelength import cal_lambda  # noqa: E402

SCRIPT = "06_forced_phot.py"
ROOT = Path(__file__).resolve().parents[1]


def _job(args):
    path, stars = args
    return path, *measure_exposure(path, stars)


def load_index(field):
    t = Table.read(DATA / f"index_{field}.csv")
    visits = sorted({v for a, b, _ in phaseb.VISIT_PAIRS[field] for v in (a, b)})
    keep = np.isin(np.asarray(t["visit"]), visits) & np.array([str(x) == "True" for x in t["on_detector"]])
    idx = []
    for r in t[keep]:
        idx.append(dict(obs_id=str(r["obs_id"]), detector=int(r["detector"]), release=str(r["release"]),
                        mjd_mid=float(r["mjd_mid"]), visit=int(r["visit"]), target_x=float(r["target_x"]),
                        target_y=float(r["target_y"]), frame=f"{r['obs_id']}_D{int(r['detector'])}",
                        path=str(ROOT / str(r["cutout_path"]))))
    return idx, visits


def run_photometry(field, idx, stars, mjd_ref, outdir, refresh, jobs):
    cache = outdir / "forced_phot.ecsv"
    if cache.exists() and not refresh:
        t = Table.read(cache)
        m = t.meta
        if (m.get("version") == VERSION and abs(float(m.get("mjd_ref", 0)) - mjd_ref) < 1e-9
                and int(m.get("n_stars", -1)) == len(stars) and int(m.get("n_frames", -1)) == len(idx)):
            print(f"[cache] forced_phot.ecsv ({len(t)} rows)")
            return t, Counter(json_counts(m))
    tabs, tot = [], Counter()
    todo = [(r['path'], stars) for r in idx]
    t0 = time.time()
    if jobs > 1:
        with ProcessPoolExecutor(jobs) as ex:
            results = list(ex.map(_job, todo, chunksize=4))
    else:
        results = [_job(a) for a in todo]
    for p, t, c in results:
        tabs.append(t)
        tot.update(c)
    t = vstack([x for x in tabs if len(x)])
    print(f"photometry {len(todo)} frames in {time.time() - t0:.0f}s")
    t.meta.update(version=VERSION, mjd_ref=mjd_ref, n_stars=len(stars), n_frames=len(idx),
                  counts_json=repr(dict(tot)))
    t.write(cache, overwrite=True)
    return t, tot


def json_counts(meta):
    return eval(meta["counts_json"], {"__builtins__": {}})  # written by us, a plain dict repr


def pad_samples(phot_ok, col_of, nstars, det=None):
    """(lam, val, var, bw) padded (nmax, nstars) NaN arrays from the ok rows of one visit
    (optionally one detector)."""
    t = phot_ok if det is None else phot_ok[phot_ok["detector"] == det]
    cols = np.array([col_of[int(s)] for s in t["source_id"]], int)
    order = np.argsort(cols, kind="stable")
    cols = cols[order]
    cnt = np.bincount(cols, minlength=nstars)
    nmax = max(1, cnt.max() if len(cnt) else 1)
    start = np.concatenate([[0], np.cumsum(cnt)[:-1]])
    pos = np.arange(len(cols)) - start[cols]
    out = []
    for name in ("lam", "flux", "var", "bw"):
        a = np.full((nmax, nstars), np.nan)
        a[pos, cols] = np.asarray(t[name], float)[order]
        out.append(a)
    return out


def build_comparisons(field, phot, stars, idx):
    col_of = {int(s): i for i, s in enumerate(stars["source_id"])}
    ns = len(stars)
    G = np.asarray(stars["phot_g_mean_mag"], float)
    bprp = np.asarray(stars["bp_rp"], float)
    sid = np.asarray(stars["source_id"], np.int64)
    ok = phot[phot["ok"]]
    visits = sorted({v for a, b, _ in phaseb.VISIT_PAIRS[field] for v in (a, b)})
    samp = {}  # (visit, det or None) -> arrays
    for v in visits:
        tv = ok[ok["visit"] == v]
        samp[(v, None)] = pad_samples(tv, col_of, ns)
        for d in range(1, 7):
            samp[(v, d)] = pad_samples(tv, col_of, ns, det=d)
    for r in idx:
        r["lam_fc"] = float(cal_lambda(r["release"], r["detector"], r["target_x"], r["target_y"])[0])
    # ok measurements grouped by frame
    fr_all = np.asarray(ok["obs_id"]).astype(str) + "_D" + np.asarray(ok["detector"]).astype(str)
    byframe = {}
    for f in np.unique(fr_all):
        byframe[f] = ok[fr_all == f]
    okb = phot[phot["ok_browser"]]
    frb = np.asarray(okb["obs_id"]).astype(str) + "_D" + np.asarray(okb["detector"]).astype(str)
    byframe_b = {f: okb[frb == f] for f in np.unique(frb)}
    rows_M2, rows_P1, rows_flat, rows_unm = [], [], [], []
    skips = Counter()
    for (A, B, cls) in phaseb.VISIT_PAIRS[field]:
        for d in range(1, 7):
            ia = [r for r in idx if r["visit"] == A and r["detector"] == d]
            ib = [r for r in idx if r["visit"] == B and r["detector"] == d]
            for ra_ in ia:
                mi = byframe.get(ra_["frame"])
                if mi is None or not len(mi):
                    continue
                c = np.array([col_of[int(s)] for s in mi["source_id"]])
                w0 = np.full(ns, np.nan)
                b0 = np.full(ns, np.nan)
                w0[c] = np.asarray(mi["lam"], float)
                b0[c] = np.asarray(mi["bw"], float)
                for mode in ("six", "one"):
                    key_d = None if mode == "six" else d
                    la, fa, va, _ = samp[(A, key_d)]
                    lb, fb, vb, _ = samp[(B, key_d)]
                    FA, VA, _n = phaseb.spec_model(la, fa, va, w0, b0)
                    FB, VB, _n = phaseb.spec_model(lb, fb, vb, w0, b0)
                    good = np.isfinite(FA) & np.isfinite(VA) & np.isfinite(FB) & np.isfinite(VB)
                    for cc in c:
                        if not good[cc]:
                            r = ("both_nan" if not (np.isfinite(FA[cc]) or np.isfinite(FB[cc]))
                                 else "A_nan" if not np.isfinite(FA[cc]) else "B_nan")
                            skips[("M2", mode, cls, r)] += 1
                    for cc in c[good[c]]:
                        rows_M2.append(("M2", mode, "prereg", "none", 6.15, A, B, cls, d, sid[cc], G[cc], bprp[cc],
                                        w0[cc], b0[cc], np.nan, 0.0, ra_["frame"], "model", FA[cc], FB[cc],
                                        VA[cc], VB[cc]))
                    # control M2flat: same, constant model
                    FA, VA, _n = spec_model_flat(la, fa, va, w0, b0)
                    FB, VB, _n = spec_model_flat(lb, fb, vb, w0, b0)
                    good = np.isfinite(FA) & np.isfinite(VA) & np.isfinite(FB) & np.isfinite(VB)
                    for cc in c:
                        if not good[cc]:
                            r = ("both_nan" if not (np.isfinite(FA[cc]) or np.isfinite(FB[cc]))
                                 else "A_nan" if not np.isfinite(FA[cc]) else "B_nan")
                            skips[("M2flat", mode, cls, r)] += 1
                    for cc in c[good[c]]:
                        rows_flat.append(("M2flat", mode, "prereg", "none", 6.15, A, B, cls, d, sid[cc], G[cc],
                                          bprp[cc], w0[cc], b0[cc], np.nan, 0.0, ra_["frame"], "model",
                                          FA[cc], FB[cc], VA[cc], VB[cc]))
                    # control M2unmatched: A model at w0, B model at lam_B of the P1native partner j
                    if ib:
                        j = ib[int(np.argmin([abs(r["lam_fc"] - ra_["lam_fc"]) for r in ib]))]
                        mj = byframe.get(j["frame"])
                        wB = np.full(ns, np.nan)
                        bB = np.full(ns, np.nan)
                        if mj is not None:
                            cj = np.array([col_of[int(s)] for s in mj["source_id"]])
                            wB[cj] = np.asarray(mj["lam"], float)
                            bB[cj] = np.asarray(mj["bw"], float)
                        FAu, VAu, _n = phaseb.spec_model(la, fa, va, w0, b0)
                        FBu, VBu, _n = phaseb.spec_model(lb, fb, vb, wB, bB)
                        for cc in c:
                            if not np.isfinite(wB[cc]):
                                skips[("M2unmatched", mode, cls, "B_missing")] += 1
                            elif not (np.isfinite(FAu[cc]) and np.isfinite(FBu[cc])):
                                skips[("M2unmatched", mode, cls, "A_nan" if not np.isfinite(FAu[cc]) else "B_nan")] += 1
                            else:
                                rows_unm.append(("M2unmatched", mode, "prereg", "none", 6.15, A, B, cls, d,
                                                 sid[cc], G[cc], bprp[cc], w0[cc], b0[cc], wB[cc],
                                                 abs(w0[cc] - wB[cc]) / b0[cc], ra_["frame"], j["frame"],
                                                 FAu[cc], FBu[cc], VAu[cc], VBu[cc]))
                for mask, bf in (("prereg", byframe), ("browser", byframe_b)):
                    mi_m = bf.get(ra_["frame"])
                    if mi_m is None or not len(mi_m):
                        continue
                    if not ib:
                        skips[("P1native", mask, cls, "no_partner_frame")] += len(mi_m)
                        continue
                    j = ib[int(np.argmin([abs(r["lam_fc"] - ra_["lam_fc"]) for r in ib]))]
                    mj = bf.get(j["frame"])
                    jmap = {int(s): k for k, s in enumerate(mj["source_id"])} if mj is not None else {}
                    for k in range(len(mi_m)):
                        s = mi_m[k]
                        if int(s["source_id"]) not in jmap:
                            skips[("P1native", mask, cls, "B_missing")] += 1
                            continue
                        sb = mj[jmap[int(s["source_id"])]]
                        cc = col_of[int(s["source_id"])]
                        rows_P1.append(("P1native", "-", mask, "none", 6.15, A, B, cls, d, sid[cc], G[cc], bprp[cc],
                                        float(s["lam"]), float(s["bw"]), float(sb["lam"]),
                                        abs(float(s["lam"]) - float(sb["lam"])) / float(s["bw"]), ra_["frame"],
                                        j["frame"], float(s["flux"]), float(sb["flux"]), float(s["var"]),
                                        float(sb["var"])))
    names = ["product", "mode", "mask", "kernel", "pixscale", "visitA", "visitB", "pair_class", "detector", "source_id",
             "G", "bp_rp", "lam_eval", "bw_eval", "lam_B", "dlam_ch", "frame_A", "frame_B", "F_A", "F_B",
             "var_A", "var_B"]
    mk = lambda rows: Table(rows=rows, names=names) if rows else Table(names=names)  # noqa: E731
    return mk(rows_M2), mk(rows_P1), skips, samp, col_of, mk(rows_flat), mk(rows_unm)


def star_summary(field, phot, stars, samp, col_of):
    """Per star and visit: n measurements and leave-one-out chi2/dof around the pre-registered
    local spectral model (the sample itself removed, evaluated at its own wavelength)."""
    ns = len(stars)
    sid = np.asarray(stars["source_id"], np.int64)
    out = []
    for v in sorted({v for a, b, _ in phaseb.VISIT_PAIRS[field] for v in (a, b)}):
        lam, flux, var, bw = samp[(v, None)]
        nmax = lam.shape[0]
        chi2 = np.zeros(ns)
        dof = np.zeros(ns, int)
        for k in range(nmax):
            l2, f2, v2 = lam.copy(), flux.copy(), var.copy()
            l2[k], f2[k], v2[k] = np.nan, np.nan, np.nan
            M, VM, _ = phaseb.spec_model(l2, f2, v2, lam[k], bw[k])
            good = np.isfinite(M) & np.isfinite(flux[k]) & np.isfinite(var[k])
            chi2 += np.where(good, (flux[k] - M) ** 2 / (var[k] + VM), 0.0)
            dof += good
        n = np.isfinite(flux).sum(0)
        with np.errstate(invalid="ignore", divide="ignore"):
            red = np.where(dof > 0, chi2 / dof, np.nan)
        for i in range(ns):
            out.append((sid[i], v, int(n[i]), int(dof[i]), float(chi2[i]), float(red[i])))
    return Table(rows=out, names=["source_id", "visit", "n_meas", "dof", "chi2", "chi2_dof"])


# ------------------------------------------------------------------ verification -------------
def check_hand_aperture(phot, idx):
    from wp.registration import flag_bits, reject_mask
    ok = phot[phot["ok"]]
    frames, cnt = np.unique(np.asarray(ok["obs_id"]) + "_D" + np.asarray(ok["detector"]).astype(str), return_counts=True)
    fr = frames[np.argmax(cnt)]
    row = [r for r in idx if r["frame"] == fr][0]
    tf = ok[(np.asarray(ok["obs_id"]) == row["obs_id"]) & (np.asarray(ok["detector"]) == row["detector"])]
    order = np.argsort(np.asarray(tf["flux"]))
    pick = [order[len(order) // 4], order[len(order) // 2], order[3 * len(order) // 4]]
    with fits.open(row["path"]) as hl:
        R = np.asarray(hl["IMAGE"].data, float) - np.asarray(hl["ZODI"].data, float)
        var = np.asarray(hl["VARIANCE"].data, float)
        fl = np.asarray(hl["FLAGS"].data, np.int64)
        rm = reject_mask(flag_bits(hl["FLAGS"].header))
    bad = ((fl & rm) != 0) | ~np.isfinite(R) | ~np.isfinite(var) | (var <= 0)
    yy, xx = np.mgrid[0:R.shape[0], 0:R.shape[1]]
    print(f"[check a] frame {fr}: hand aperture, own clipping loop, 200x200 sub-pixel overlap")
    worst = 0.0
    for k in pick:
        x, y = float(tf["x"][k]), float(tf["y"][k])  # float32 storage; recompute exactly below
        x, y = float(tf["x"][k]), float(tf["y"][k])
        rr = np.hypot(xx - x, yy - y)
        geo = (rr >= phaseb.ANN_IN) & (rr <= phaseb.ANN_OUT)
        nonfin = ~np.isfinite(R) | ~np.isfinite(var) | (var <= 0)
        ann = geo & ~bad & ((fl >> 21) & 1 == 0)
        if ann.sum() < 10:
            ann = geo & ~nonfin
        v = R[ann]
        keep = np.ones(v.size, bool)
        for _ in range(5):
            med = np.median(v[keep])
            sd = np.std(v[keep])
            nk = np.abs(v - med) <= 3 * sd
            if nk.sum() == keep.sum():
                break
            keep = nk
        med, sd, n = np.median(v[keep]), np.std(v[keep]), int(keep.sum())
        # exact overlap by supersampling each pixel of the 7x7 neighbourhood
        xi, yi = int(round(x)), int(round(y))
        S = 200
        sub = (np.arange(S) + 0.5) / S - 0.5
        wgt = np.zeros((7, 7))
        for jy in range(7):
            for jx in range(7):
                px, py = xi - 3 + jx, yi - 3 + jy
                gx, gy = np.meshgrid(px + sub, py + sub)
                wgt[jy, jx] = np.mean(np.hypot(gx - x, gy - y) <= phaseb.APER_R)
        sl = (slice(yi - 3, yi + 4), slice(xi - 3, xi + 4))
        fh = float(np.sum(wgt * (R[sl] - med)))
        vh = float(np.sum(wgt ** 2 * var[sl]) + wgt.sum() ** 2 * (np.pi / 2) * sd ** 2 / n)
        rel = abs(fh - float(tf["flux"][k])) / abs(float(tf["flux"][k]))
        relv = abs(vh - float(tf["var"][k])) / float(tf["var"][k])
        worst = max(worst, rel, relv)
        print(f"   star {int(tf['source_id'][k])}: table flux {float(tf['flux'][k]):.5g} hand {fh:.5g} "
              f"(rel {rel:.1e}); var table {float(tf['var'][k]):.5g} hand {vh:.5g} (rel {relv:.1e})")
    print(f"   max rel difference {worst:.2e}  ->  {'PASS' if worst < 2e-3 else 'FAIL'}")
    return worst < 2e-3


def check_spec_model(M2, phot, field):
    ok = phot[phot["ok"]]
    m = M2[M2["mode"] == "six"]
    r = m[len(m) // 2]
    t = ok[(np.asarray(ok["source_id"]) == r["source_id"]) & (np.asarray(ok["visit"]) == r["visitA"])]
    x = np.asarray(t["lam"], float) - r["lam_eval"]
    y = np.asarray(t["flux"], float)
    v = np.asarray(t["var"], float)
    sel = np.abs(x) <= phaseb.WINDOW_BW * r["bw_eval"]
    x, y, v = x[sel], y[sel], v[sel]

    def fit(x, y, v):
        p, cov = np.polyfit(x, y, 1, w=1 / np.sqrt(v), cov="unscaled")
        return p, cov
    p, cov = fit(x, y, v)
    res = np.abs(y - np.polyval(p, x)) / np.sqrt(v)
    k = int(np.argmax(res))
    clipped = res[k] > phaseb.CLIP_SIGMA
    if clipped:
        m_ = np.arange(len(x)) != k
        p, cov = fit(x[m_], y[m_], v[m_])
    ok_ = abs(p[1] - r["F_A"]) <= 1e-6 * abs(r["F_A"]) and abs(cov[1, 1] - r["var_A"]) <= 1e-6 * r["var_A"]
    print(f"[check b] star {int(r['source_id'])} visit {int(r['visitA'])} six-mode at {r['lam_eval']:.4f} um, "
          f"{len(x)} window samples, clipped={clipped}: spec_model F_A={r['F_A']:.6g} var={r['var_A']:.6g}; "
          f"polyfit F={p[1]:.6g} var={cov[1, 1]:.6g}  ->  {'PASS' if ok_ else 'FAIL'}")
    return ok_


def check_det_ratio(phot, stars):
    ok = phot[phot["ok"]]
    obs = np.asarray(ok["obs_id"]).astype(str)
    det = np.asarray(ok["detector"])
    d1 = {(o, int(s)): (f, l) for o, s, f, l in zip(obs[det == 1], ok["source_id"][det == 1], ok["flux"][det == 1], ok["lam"][det == 1])}
    bp = dict(zip(np.asarray(stars["source_id"]).astype(int), np.asarray(stars["bp_rp"], float)))
    rat, lam1, lam4, col = [], [], [], []
    for o, s, f, l in zip(obs[det == 4], ok["source_id"][det == 4], ok["flux"][det == 4], ok["lam"][det == 4]):
        k = (o, int(s))
        if k in d1 and d1[k][0] > 0 and f > 0:
            rat.append(d1[k][0] / f); lam1.append(d1[k][1]); lam4.append(l); col.append(bp[int(s)])
    rat, col = np.array(rat), np.array(col)
    print(f"[check c] simultaneous D1/D4 flux ratio (same obs_id, same star, both flux>0): n={len(rat)}, "
          f"median {np.median(rat):.2f}, lam1 {np.median(lam1):.2f} um, lam4 {np.median(lam4):.2f} um")
    if len(rat) > 10:
        edges = np.nanquantile(col, [0, 1 / 3, 2 / 3, 1])
        for lo, hi in zip(edges[:-1], edges[1:]):
            m = (col >= lo) & (col <= hi)
            print(f"   bp_rp {lo:.2f}..{hi:.2f}: n={m.sum()} median ratio {np.median(rat[m]):.2f}")
    return float(np.median(rat)) if len(rat) else float("nan")


def rwaur_main():
    """RW Aur (not in the main index): exposures listed in data/rwaur/exposures.ecsv (SIA2 query +
    headers + target pixel, see wp/exposures.py, wp/io.py) with 80x80 cutouts in data/rwaur/cutouts.
    Star = Gaia DR3 156430822114424576 (the A+B pair at 1.5 arcsec is unresolved in a 12.3 arcsec aperture)."""
    from wp.registration import flag_bits
    D = DATA / "rwaur"
    t = Table.read(D / "exposures.ecsv")
    ra0, dec0 = 76.95608119552952, 30.401204589097233
    star = Table(rows=[(156430822114424576, ra0, dec0, 2.6406431770317083, -27.397582540455325,
                        6.406249329219477, np.nan, np.nan, np.nan, np.nan, np.nan, 12.184072, 1.774)],
                 names=["source_id", "ra", "dec", "pmra", "pmdec", "parallax", "ra_error", "dec_error",
                        "pmra_error", "pmdec_error", "ruwe", "phot_g_mean_mag", "bp_rp"])
    idx = []
    for r in t:
        pth = D / "cutouts" / f"{r['obs_id']}_D{int(r['detector'])}.fits"
        if r["on"] and pth.exists():
            idx.append(dict(obs_id=str(r["obs_id"]), detector=int(r["detector"]), release=str(r["release"]),
                            mjd_mid=float(r["mjd_mid"]), visit=int(r["visit"]), target_x=float(r["x"]),
                            target_y=float(r["y"]), frame=f"{r['obs_id']}_D{int(r['detector'])}", path=str(pth)))
    print(f"RW Aur: {len(idx)} cutouts of {int(np.sum(t['on']))} on-detector exposures")
    # --- saturation flags in the central 5x5 per detector
    names = ("OVERFLOW", "NONLINEAR", "BLOOM", "PERSIST", "NONFUNC", "SNOWBALL", "TRANSIENT")
    fl = {d: Counter() for d in range(1, 7)}
    nfr = Counter()
    for r in idx:
        with fits.open(r["path"]) as hl:
            f = np.asarray(hl["FLAGS"].data, np.int64)
            bits = flag_bits(hl["FLAGS"].header)
            x0, y0 = int(hl[0].header["X0"]), int(hl[0].header["Y0"])
            from astropy.wcs import WCS
            xx, yy = WCS(hl["IMAGE"].header).world_to_pixel_values(ra0, dec0)
        xi, yi = int(round(float(xx))), int(round(float(yy)))
        o = int(np.bitwise_or.reduce(f[yi - 2:yi + 3, xi - 2:xi + 3].ravel()))
        nfr[r["detector"]] += 1
        for n in names:
            if o & (1 << bits[n]):
                fl[r["detector"]][n] += 1
    print("5x5 flag incidence per detector (n frames; flag counts):")
    for d in range(1, 7):
        print(f"   D{d}: n={nfr[d]}", dict(fl[d]))
    phaseb.VISIT_PAIRS["rwaur"] = [(0, 1, "6mo"), (1, 2, "6mo"), (0, 2, "12mo")]
    mjd_ref = float(np.mean([r["mjd_mid"] for r in idx]))
    tabs = [measure_exposure(r["path"], star)[0] for r in idx]
    phot = vstack([x for x in tabs if len(x)])
    print("photometry reasons:", dict(Counter(np.asarray(phot["reason"]))), " ok_browser:", int(np.sum(phot["ok_browser"])))
    # per visit / detector spectrum (browser mask: prereg drops saturated-flag frames)
    print("per visit, detector: n(prereg ok), n(browser ok), median flux (MJy/sr summed), median lam (um)")
    for v in range(3):
        for d in range(1, 7):
            m = (np.asarray(phot["visit"]) == v) & (np.asarray(phot["detector"]) == d)
            mp, mb = m & np.asarray(phot["ok"]), m & np.asarray(phot["ok_browser"])
            fm = np.median(np.asarray(phot["flux"])[mb]) if mb.any() else np.nan
            print(f"   v{v} D{d}: {int(mp.sum())}/{int(mb.sum())}/{int(m.sum())}  flux {fm:.4g}  lam {np.median(np.asarray(phot['lam'])[m]) if m.any() else np.nan:.2f}")
    phot.write(D / "forced_phot.ecsv", overwrite=True)
    # M2 and P1native on the single star (prereg and browser selections)
    for label, col in (("prereg", "ok"), ("browser", "ok_browser")):
        sub = phot.copy()
        sub["ok"] = sub[col]
        sub = sub[sub["ok"]]
        if not len(sub):
            print(label, "no usable measurements")
            continue
        M2, P1, skips, samp, col_of, _f, _u = build_comparisons("rwaur", sub, star, idx)
        print(f"--- RW Aur comparisons, selection {label}")
        for tab, nm in ((M2, "M2"), (P1, "P1native")):
            if not len(tab):
                print(f"   {nm}: none"); continue
            for mode in sorted(set(tab["mode"])):
                for d in range(1, 7):
                    for cls in ("6mo", "12mo"):
                        g = tab[(tab["mode"] == mode) & (tab["detector"] == d) & (tab["pair_class"] == cls)]
                        if not len(g):
                            continue
                        dF = np.asarray(g["F_A"] - g["F_B"], float)
                        sig = np.sqrt(np.asarray(g["var_A"] + g["var_B"], float))
                        z = dF / sig
                        w = 1 / sig ** 2
                        mean = np.sum(w * dF) / np.sum(w)
                        extra = (f" median dlam_ch {np.median(g['dlam_ch']):.2f}" if nm == "P1native" else "")
                        print(f"   {nm:8s} {mode:4s} D{d} {cls:4s} n={len(g):3d} weighted mean dF {mean:9.4g} +/- "
                              f"{np.sqrt(1 / np.sum(w)):.3g}  median z {np.median(z):6.2f}{extra}")
        for k, v in sorted(skips.items()):
            print("   skip", k, v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", default="barnard", choices=["barnard", "epsindi", "rwaur"])
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--jobs", type=int, default=4)
    a = ap.parse_args()
    field = a.field
    if field == "rwaur":
        return rwaur_main()
    T0 = time.time()
    outdir = phaseb.PHASEB / field
    outdir.mkdir(parents=True, exist_ok=True)
    idx, visits = load_index(field)
    # reference epoch of the star sample: mean MJD of all exposures of the visits used
    mjd_ref = float(np.mean([r["mjd_mid"] for r in idx]))
    stars = phaseb.phaseb_stars(field, mjd_ref)
    print(f"field {field}: visits {visits}, {len(idx)} frames, mjd_ref {mjd_ref:.3f}, "
          f"star sample {len(stars)} (cuts {stars.meta.get('cut_counts')})")
    phot, tot = run_photometry(field, idx, stars, mjd_ref, outdir, a.refresh, a.jobs)
    ok_n = int(np.asarray(phot["ok"]).sum())
    print(f"star-exposures: {len(phot)} inside a cutout (+{tot['outside_cutout']} centre outside a cutout); measured {ok_n}")
    print("drop reasons:", {r: int(tot[r]) for r in REASONS if r != "ok"}, "outside_cutout", int(tot["outside_cutout"]))
    M2, P1, skips, samp, col_of, M2f, M2u = build_comparisons(field, phot, stars, idx)
    M2.meta.update(mjd_ref=mjd_ref, field=field)
    P1.meta.update(mjd_ref=mjd_ref, field=field)
    M2.write(outdir / "fluxes_M2.ecsv", overwrite=True)
    P1.write(outdir / "fluxes_P1native.ecsv", overwrite=True)
    for tab, nm in ((M2f, "M2flat"), (M2u, "M2unmatched")):
        tab.meta.update(mjd_ref=mjd_ref, field=field)
        tab.write(outdir / f"fluxes_{nm}.ecsv", overwrite=True)
    summ = star_summary(field, phot, stars, samp, col_of)
    summ.write(outdir / "forced_star_summary.ecsv", overwrite=True)

    res = {"n_stars": metric(len(stars), "stars", script=SCRIPT, note="phaseb_stars at mjd_ref"),
           "mjd_ref": metric(mjd_ref, "MJD", script=SCRIPT),
           "n_star_exposures_in_cutout": metric(len(phot), "star-exposures", script=SCRIPT),
           "n_measured": metric(ok_n, "star-exposures", script=SCRIPT)}
    for r in REASONS:
        if r != "ok":
            res[f"dropped_{r}"] = metric(int(tot[r]), "star-exposures", script=SCRIPT)
    res["outside_cutout"] = metric(int(tot["outside_cutout"]), "star-exposures", script=SCRIPT)
    res["n_measured_browser"] = metric(int(tot["browser_ok"]), "star-exposures", script=SCRIPT)
    res["bkg_fallback"] = metric(int(tot["bkg_fallback"]), "star-exposures", script=SCRIPT,
                                 note="annulus < 10 unflagged pixels, flags not excluded")
    print(f"browser-mask measured: {int(tot['browser_ok'])}; background fallback used: {int(tot['bkg_fallback'])}")
    print("comparisons (product, mode, mask, pair class -> n):")
    for tab in (M2, M2f, M2u, P1):
        if not len(tab):
            continue
        for k in sorted(set(zip(tab["product"], tab["mode"], tab["mask"], tab["pair_class"]))):
            g = tab[(tab["product"] == k[0]) & (tab["mode"] == k[1]) & (tab["mask"] == k[2]) & (tab["pair_class"] == k[3])]
            print(f"   {k[0]:9s} {k[1]:4s} {k[2]:8s} {k[3]:5s} {len(g):7d}  stars {len(set(g['source_id']))}")
            res["n_" + "_".join(k)] = metric(len(g), "comparisons", script=SCRIPT)
    print("skipped comparisons (product, mode|mask, pair class, reason -> n):")
    for k, v in sorted(skips.items()):
        print("  ", k, v)
        res["skip_" + "_".join(k)] = metric(int(v), "comparisons", script=SCRIPT)
    chi = np.asarray(summ["chi2_dof"], float)
    good = np.isfinite(chi)
    res["loo_chi2_dof_median"] = metric(float(np.median(chi[good])) if good.any() else None, "chi2/dof",
                                        n=int(good.sum()), script=SCRIPT, note="leave-one-out, per star-visit")
    c1 = check_hand_aperture(phot, idx)
    c2 = check_spec_model(M2, phot, field)
    ratio = check_det_ratio(phot, stars)
    res["check_hand_aperture_pass"] = metric(bool(c1), "bool", script=SCRIPT)
    res["check_spec_model_pass"] = metric(bool(c2), "bool", script=SCRIPT)
    res["check_d1_d4_median_ratio"] = metric(ratio, "flux ratio", script=SCRIPT)
    update_results(f"phaseb_forced_{field}", res)
    print(f"runtime {time.time() - T0:.0f}s")


if __name__ == "__main__":
    main()
