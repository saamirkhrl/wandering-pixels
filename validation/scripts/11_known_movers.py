"""11: known movers: Barnard's Star, Eps Indi B (Ba+Bb), WISE 0855-0714.

usage: uv run python scripts/11_known_movers.py [--only barnard,epsindib,wise0855] [--refresh]
Inputs : data/cutouts/{barnard,epsindi}/ + data/index_<field>.csv (existing), SIA2 + S3 range reads
         for WISE 0855 (cutouts half=40 under data/wise0855/, index data/wise0855/index.csv)
Caches : data/phasec/movers_<target>.ecsv (per exposure), movers_<target>.json (section results)
Outputs: docs/figures/movers_barnard.png, movers_epsindib.png, wise0855_photometry.png,
         wise0855_stamps.png; results section "known_movers".

Everything uses the phase A / B machinery: Gaussian centroid of wp/registration.py (via
wp.movers.centroid_gauss), forced photometry and matched comparison of wp/m2ref.py
(2 px aperture, variance inflated by (0.02 F)^2), registration offsets per frame from the phase A
reference stars (data/reg/meas_<field>.ecsv).
"""
import argparse
import json
import sys
import time
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from astropy.table import Table

from wp import m2ref
from wp import registration as reg
from wp import movers as M
from wp.config import DATA, FIGURES
from wp.results import metric, update_results
from wp.wavelength import cal_lambda

warnings.filterwarnings("ignore")
SCRIPT = "scripts/11_known_movers.py"
PC = DATA / "phasec"
PC.mkdir(parents=True, exist_ok=True)
MJY_SR_PX_TO_MJY = (M.PIXEL_ARCSEC / 206264.806) ** 2 * 1e9     # MJy/sr summed over native pixels -> mJy
AS_PER_YR_BARNARD = None
TEXT = []


def say(*a):
    s = " ".join(str(x) for x in a)
    print(s)
    TEXT.append(s)


def fmt(x, d=3):
    return "nan" if x is None or not np.isfinite(x) else f"{x:.{d}f}"


def robust_clip(v, nsig=3.5):
    """Boolean keep mask: |v - median| <= nsig * 1.4826 MAD (everything kept when MAD = 0)."""
    v = np.asarray(v, float)
    m = np.isfinite(v)
    if m.sum() < 4:
        return m
    med = np.median(v[m])
    s = 1.4826 * np.median(np.abs(v[m] - med))
    if s <= 0:
        return m
    return m & (np.abs(v - med) <= nsig * s)


# ------------------------------------------------------------------ shared visit statistics
def visit_stats(T, visits, dets=range(1, 7), cols=("dra", "ddec")):
    """Per visit (pooled) and per visit x detector: N, mean, SEM of offsets after a 3.5 sigma clip."""
    out = {}
    for v in visits:
        for d in [None] + list(dets):
            m = (T["visit"] == v) & np.isfinite(T[cols[0]])
            if d is not None:
                m &= T["det"] == d
            if m.sum() == 0:
                continue
            vals = {c: np.asarray(T[c], float)[m] for c in cols}
            keep = robust_clip(vals[cols[0]]) & robust_clip(vals[cols[1]])
            rec = dict(n=int(keep.sum()), n_clipped=int((~keep).sum()), mjd=float(np.mean(np.asarray(T["mjd"], float)[m][keep])))
            for c in cols:
                mu, se, n = M.mean_sem(vals[c][keep])
                rec[c] = mu
                rec["e_" + c] = se
                rec["sd_" + c] = float(np.std(vals[c][keep], ddof=1)) if keep.sum() > 1 else np.nan
            out[(v, d)] = rec
    return out


def displacements(stats, tg, vpairs, dets=range(1, 7)):
    """Measured and predicted displacement (arcsec, dRA*, dDec) between visits, per detector and
    pooled over detectors (inverse-variance mean). Measured = predicted(mean MJDs) + change in the
    mean offset from prediction (so a constant per-detector bias cancels)."""
    res = []
    for a, b in vpairs:
        per = []
        for d in dets:
            sa, sb = stats.get((a, d)), stats.get((b, d))
            if not sa or not sb or sa["n"] < 3 or sb["n"] < 3:
                continue
            if not (np.isfinite(sa["e_dra"]) and np.isfinite(sb["e_dra"]) and sa["e_dra"] > 0 and sb["e_dra"] > 0):
                continue
            pr = M.sep_arcsec(tg, sa["mjd"], tg, sb["mjd"])
            meas = (pr[0] + sb["dra"] - sa["dra"], pr[1] + sb["ddec"] - sa["ddec"])
            e = (np.hypot(sa["e_dra"], sb["e_dra"]), np.hypot(sa["e_ddec"], sb["e_ddec"]))
            per.append(dict(det=d, pred=(float(pr[0]), float(pr[1])), meas=(float(meas[0]), float(meas[1])), err=e,
                            n=(sa["n"], sb["n"])))
        if not per:
            continue
        rec = dict(pair=(a, b), per_det=per)
        for k, nm in enumerate(("ra", "dec")):
            pm, pe = M.wmean([p["meas"][k] for p in per], [p["err"][k] for p in per])
            pp = float(np.mean([p["pred"][k] for p in per]))
            rec[nm] = dict(meas=pm, err=pe, pred=pp, diff=pm - pp,
                           chi2=float(np.sum(((np.array([p["meas"][k] for p in per]) - pm) / np.array([p["err"][k] for p in per])) ** 2)),
                           ndet=len(per))
        rec["n"] = int(sum(sum(p["n"]) for p in per))
        res.append(rec)
    return res


def print_displ(label, disp):
    for r in disp:
        a, b = r["pair"]
        ra, de = r["ra"], r["dec"]
        say(f"   {label} visit {a}->{b}: dRA* measured {ra['meas']:+.3f} +/- {ra['err']:.3f}\", predicted {ra['pred']:+.3f}\" "
            f"(diff {ra['diff']:+.3f}, {ra['diff'] / ra['err']:+.1f} sigma);  dDec measured {de['meas']:+.3f} +/- {de['err']:.3f}\", "
            f"predicted {de['pred']:+.3f}\" (diff {de['diff']:+.3f}, {de['diff'] / de['err']:+.1f} sigma);  "
            f"{ra['ndet']} detectors, n={r['n']}")


def fr_offset(fo, det, mjd):
    return fo.get((int(det), round(float(mjd), 4)), (np.nan, np.nan, 0))


# ------------------------------------------------------------------ A. Barnard's Star
def measure_barnard(refresh=False):
    p = PC / "movers_barnard.ecsv"
    if p.exists() and not refresh:
        return Table.read(p)
    tg = M.TARGETS["barnard"]
    rows = M.read_index(DATA / "index_barnard.csv")
    fo = M.frame_offsets("barnard")
    recs = []
    t0 = time.time()
    for i, r in enumerate(rows):
        fr = M.load_frame(DATA.parent / r["cutout_path"])
        ra, de = M.predict(tg, fr["mjd"])
        x, y = M.pixel_of(fr, ra, de)
        fs = M.flag_summary(fr, x, y)
        rec = dict(row=i, obs_id=fr["obs_id"], det=fr["detector"], visit=int(r["visit"]), mjd=fr["mjd"], x_pred=x, y_pred=y,
                   ra_pred=ra, dec_pred=de, inside=fs["inside"], overflow=fs["overflow"], nonlinear=fs["nonlinear"],
                   bloom=fs["bloom"], saturated=fs["saturated"], n_sat_px=fs["n_sat_px"],
                   ok=False, x=np.nan, y=np.nan, ex=np.nan, ey=np.nan, chi2r=np.nan, nwing=0, ra_m=np.nan, dec_m=np.nan,
                   dra=np.nan, ddec=np.nan, dra_c=np.nan, ddec_c=np.nan, reg_dra=np.nan, reg_ddec=np.nan,
                   gx=np.nan, gy=np.nan, g_ok=False, j_ra_x=np.nan, j_ra_y=np.nan, j_dec_x=np.nan, j_dec_y=np.nan)
        if fs["inside"]:
            J = reg.sky_jacobian(fr["wcs"], [x], [y])[0]
            rec.update(j_ra_x=J[0, 0], j_ra_y=J[0, 1], j_dec_x=J[1, 0], j_dec_y=J[1, 1])
            w = M.wings_fit(fr, x, y)
            rec.update(ok=w["ok"], x=w["x"], y=w["y"], ex=w["ex"], ey=w["ey"], chi2r=w["chi2r"], nwing=w["n"])
            if w["ok"]:
                ram, dem = M.sky_of(fr, w["x"], w["y"])
                dra, dde = M.sky_offset(ram, dem, ra, de)
                rd, rdd, _ = fr_offset(fo, fr["detector"], fr["mjd"])
                rec.update(ra_m=ram, dec_m=dem, dra=float(dra), ddec=float(dde), reg_dra=rd, reg_ddec=rdd,
                           dra_c=float(dra) - rd, ddec_c=float(dde) - rdd)
            if not fs["saturated"]:
                c = M.centroid_gauss(fr, x, y)
                rec.update(gx=c["x"], gy=c["y"], g_ok=c["ok"])
        recs.append(rec)
        if (i + 1) % 100 == 0:
            print(f"  barnard {i + 1}/{len(rows)}  {time.time() - t0:.0f}s", flush=True)
    T = Table(rows=recs)
    T.write(p, overwrite=True)
    return T


def validate_wings(field="barnard", nframes=90, refresh=False):
    """Wings method on UNSATURATED bright stars of the same field: compare the wings-only centre
    (core ignored by r_in = 2.5 px, same settings as for Barnard's Star) with the full Gaussian centroid
    (phase A) and with Gaia. Returns dict of arrays."""
    p = PC / "movers_wingstest_barnard.ecsv"
    if p.exists() and not refresh:
        return Table.read(p)
    from wp.gaia import gaia_path, propagate
    g = Table.read(gaia_path(field))
    G = np.asarray(g["phot_g_mean_mag"], float)
    cand = np.where((G >= 9.5) & (G <= 12.5) & (np.asarray(g["ruwe"], float) < 1.4)
                    & np.isfinite(np.asarray(g["pmra"], float)))[0]
    rows = M.read_index(DATA / f"index_{field}.csv")
    rng = np.random.default_rng(11)
    pick = sorted(rng.choice(len(rows), size=min(nframes, len(rows)), replace=False))
    out = []
    for i in pick:
        r = rows[i]
        if int(r["visit"]) not in (0, 2, 4):
            continue
        fr = M.load_frame(DATA.parent / r["cutout_path"])
        ra, de, _ = propagate(g, fr["mjd"])
        # neighbour test at this epoch against the whole table (G < G + 3 within 20 arcsec)
        ny, nx = fr["R"].shape
        xs, ys = fr["wcs"].world_to_pixel_values(ra[cand], de[cand])
        for j, x, y in zip(cand, xs, ys):
            if not (12 <= x < nx - 12 and 12 <= y < ny - 12):
                continue
            dra = (ra - ra[j]) * np.cos(np.deg2rad(de[j])) * 3600
            dde = (de - de[j]) * 3600
            near = (np.hypot(dra, dde) < 20.0) & (G < G[j] + 3.0)
            near[j] = False
            if near.any():
                continue
            fs = M.flag_summary(fr, x, y)
            if fs["saturated"]:
                continue
            c = M.centroid_gauss(fr, x, y)
            w = M.wings_fit(fr, x, y)
            if not (c["ok"] and w["ok"]):
                continue
            out.append(dict(row=i, det=fr["detector"], G=float(G[j]), xg=float(x), yg=float(y), x_gauss=c["x"], y_gauss=c["y"],
                            x_wing=w["x"], y_wing=w["y"], ex_wing=w["ex"], ey_wing=w["ey"], flux=c["flux"]))
    T = Table(rows=out)
    T.write(p, overwrite=True)
    return T


def barnard(refresh=False):
    say("\n=== A. Barnard's Star (field barnard) ===")
    tg = M.TARGETS["barnard"]
    say(f"Prediction: {tg['cite']}, ra {tg['ra']:.8f} dec {tg['dec']:.8f} (2016.0), pm ({tg['pmra']}, {tg['pmdec']}) mas/yr, "
        f"parallax {tg['parallax']} mas; our predict() equals wp.gaia.propagate to {M.check_against_propagate(tg, 61000.0):.1e} mas")
    T = measure_barnard(refresh)
    R = {}
    ins = np.asarray(T["inside"], bool)
    sat = np.asarray(T["saturated"], bool)
    say(f"Exposures with the predicted position in the cutout: {ins.sum()} of {len(T)}; central 5x5 carries OVERFLOW/NONLINEAR/BLOOM in "
        f"{(sat & ins).sum()} of {ins.sum()}")
    for d in range(1, 7):
        m = ins & (np.asarray(T["det"]) == d)
        say(f"   D{d}: {int((sat & m).sum())}/{int(m.sum())} saturated;  OVERFLOW {int(np.sum(np.asarray(T['overflow'])[m]))}, "
            f"NONLINEAR {int(np.sum(np.asarray(T['nonlinear'])[m]))}, BLOOM {int(np.sum(np.asarray(T['bloom'])[m]))}; "
            f"median saturated-flag pixels in 13x13: {np.median(np.asarray(T['n_sat_px'])[m]):.0f}")
    R["n_inside"] = metric(int(ins.sum()), "exposures", int(len(T)), SCRIPT)
    R["n_saturated"] = metric(int((sat & ins).sum()), "exposures", int(ins.sum()), SCRIPT,
                              "central 5x5 with OVERFLOW (bit 1), NONLINEAR (15) or BLOOM (26)")
    if (~sat & ins).sum() > 0:
        say(f"   {int((~sat & ins).sum())} unsaturated frames exist; centroid there as phase A")
    say("   => Barnard's Star (G 8.2, Ks 4.5) is saturated in every exposure and detector: no photometry (flux), no core centroid.")
    say("      What CAN be measured: a position from the unsaturated PSF wings (2.5 to 6 px, a symmetric profile, free centre).")
    say("      What CANNOT: its brightness or spectrum (the aperture is flagged), and a wings position carries a PSF-asymmetry systematic.")

    # ---- validation of the wings method on unsaturated stars
    V = validate_wings("barnard", refresh=refresh)
    say(f"Wings method check on {len(V)} unsaturated, isolated Gaia stars G 9.5 to 12.5 (Barnard field, 3 visits): wings centre minus Gaussian-core centre")
    vv = {}
    for d in list(range(1, 7)) + [0]:
        m = np.ones(len(V), bool) if d == 0 else np.asarray(V["det"]) == d
        if m.sum() < 5:
            continue
        dx = (np.asarray(V["x_wing"]) - np.asarray(V["x_gauss"]))[m]
        dy = (np.asarray(V["y_wing"]) - np.asarray(V["y_gauss"]))[m]
        k = robust_clip(dx, 4) & robust_clip(dy, 4)
        mx, sx = np.median(dx[k]), 1.4826 * np.median(np.abs(dx[k] - np.median(dx[k])))
        my, sy = np.median(dy[k]), 1.4826 * np.median(np.abs(dy[k] - np.median(dy[k])))
        lab = "all" if d == 0 else f"D{d}"
        say(f"   {lab}: n={int(k.sum())}: dx median {mx:+.3f} px (scatter {sx:.3f}), dy median {my:+.3f} px (scatter {sy:.3f})")
        vv[lab] = dict(n=int(k.sum()), dx=float(mx), sx=float(sx), dy=float(my), sy=float(sy))
    if "all" in vv:
        R["wings_check_scatter_px"] = metric(float(np.hypot(vv["all"]["sx"], vv["all"]["sy"]) / np.sqrt(2)), "px per axis",
                                             vv["all"]["n"], SCRIPT, "robust scatter of wings minus Gaussian-core centre on unsaturated G 9.5-12.5 stars (includes the core centroid error)")
        R["wings_check_bias_px"] = metric([vv["all"]["dx"], vv["all"]["dy"]], "px (x, y)", vv["all"]["n"], SCRIPT, "median wings minus core, all detectors")

    # wings bias split by brightness (is the bias the same for the brighter half?)
    Gv = np.asarray(V["G"], float)
    gm = np.median(Gv)
    for lab, mm in ((f"G < {gm:.1f}", Gv < gm), (f"G >= {gm:.1f}", Gv >= gm)):
        dx = (np.asarray(V["x_wing"]) - np.asarray(V["x_gauss"]))[mm]
        dy = (np.asarray(V["y_wing"]) - np.asarray(V["y_gauss"]))[mm]
        k = robust_clip(dx, 4) & robust_clip(dy, 4)
        say(f"   {lab}: n={int(k.sum())}: dx median {np.median(dx[k]):+.3f} px, dy median {np.median(dy[k]):+.3f} px")
    # per-detector bias (detector pixel frame) used as a correction; pooled value where n < 20
    bias = {}
    for d in range(1, 7):
        lab = f"D{d}"
        src = vv.get(lab) if vv.get(lab, {}).get("n", 0) >= 20 else vv.get("all")
        n = src["n"]
        bias[d] = dict(bx=src["dx"], by=src["dy"], sx=1.2533 * src["sx"] / np.sqrt(n), sy=1.2533 * src["sy"] / np.sqrt(n), n=n,
                       own=vv.get(lab, {}).get("n", 0) >= 20)
    say("   bias correction used (px, detector frame; error = 1.25 sigma/sqrt n; pooled all-detector value where the detector has n < 20): " +
        "; ".join(f"D{d} ({b['bx']:+.2f}+/-{b['sx']:.2f}, {b['by']:+.2f}+/-{b['sy']:.2f}{'' if b['own'] else ' pooled'})" for d, b in bias.items()))
    R["wings_bias_px"] = {f"D{d}": dict(bx=metric(b["bx"], "px", b["n"], SCRIPT, f"error {b['sx']:.3f}"), by=metric(b["by"], "px", b["n"], SCRIPT, f"error {b['sy']:.3f}")) for d, b in bias.items()}

    # ---- offsets per visit and per detector
    ok = np.asarray(T["ok"], bool) & ins
    nf = {d: (int(np.sum(ins & (np.asarray(T['det']) == d) & ~np.asarray(T['ok'], bool))), int(np.sum(ins & (np.asarray(T['det']) == d)))) for d in range(1, 7)}
    say(f"Wings fits accepted: {int(ok.sum())} of {int(ins.sum())} exposures (rejected: too few unflagged wing pixels or centre beyond 1.5 px of the prediction); rejected/total per detector: " +
        ", ".join(f"D{d} {a}/{b}" for d, (a, b) in nf.items()))
    TT = T[ok & np.isin(np.asarray(T["visit"]), [0, 2, 4])]
    for col in ("dra", "ddec"):
        pass
    TT["dra_raw"] = TT["dra_c"]
    TT["ddec_raw"] = TT["ddec_c"]
    bx = np.array([bias[int(d)]["bx"] for d in TT["det"]])
    by = np.array([bias[int(d)]["by"] for d in TT["det"]])
    sx = np.array([bias[int(d)]["sx"] for d in TT["det"]])
    sy = np.array([bias[int(d)]["sy"] for d in TT["det"]])
    TT["dra_c"] = TT["dra_raw"] - (TT["j_ra_x"] * bx + TT["j_ra_y"] * by)
    TT["ddec_c"] = TT["ddec_raw"] - (TT["j_dec_x"] * bx + TT["j_dec_y"] * by)
    # systematic from the bias uncertainty (per exposure, arcsec), added to the per-group error below
    TT["sys_ra"] = np.hypot(TT["j_ra_x"] * sx, TT["j_ra_y"] * sy)
    TT["sys_dec"] = np.hypot(TT["j_dec_x"] * sx, TT["j_dec_y"] * sy)
    good = np.isfinite(np.asarray(TT["dra_c"]))
    TC = TT[good]
    say(f"   with a per-frame registration offset available (>= 5 reference stars): {len(TC)} of {len(TT)}")
    st = visit_stats(TC, [0, 2, 4], cols=("dra_c", "ddec_c"))
    # rename for displacements()
    st2 = {}
    for (v, d), r_ in st.items():
        m_ = (np.asarray(TC["visit"]) == v) & ((np.asarray(TC["det"]) == d) if d is not None else True)
        sra = float(np.mean(np.asarray(TC["sys_ra"])[m_])) if d is not None else 0.0
        sde = float(np.mean(np.asarray(TC["sys_dec"])[m_])) if d is not None else 0.0
        st2[(v, d)] = dict(r_, dra=r_["dra_c"], ddec=r_["ddec_c"], e_dra=float(np.hypot(r_["e_dra_c"], sra)),
                           e_ddec=float(np.hypot(r_["e_ddec_c"], sde)), e_stat_dra=r_["e_dra_c"], e_stat_ddec=r_["e_ddec_c"])
    say("Per visit, pooled over detectors: mean offset measured - predicted (arcsec), error = scatter/sqrt(N) (statistical; bias-correction error enters the per-detector displacement errors)")
    pooled = {}
    for v in (0, 2, 4):
        s = st2.get((v, None))
        if s:
            say(f"   visit {v} (MJD {s['mjd']:.1f}): dRA* {s['dra']:+.3f} +/- {s['e_dra']:.3f}  dDec {s['ddec']:+.3f} +/- {s['e_ddec']:.3f}  "
                f"N={s['n']} (clipped {s['n_clipped']}); single-exposure scatter {s['sd_dra_c']:.2f} / {s['sd_ddec_c']:.2f}")
            pooled[v] = s
    say("Per visit and detector (dRA*, dDec in arcsec, N):")
    for d in range(1, 7):
        line = []
        for v in (0, 2, 4):
            s = st2.get((v, d))
            line.append(f"v{v}: {s['dra']:+.2f}/{s['ddec']:+.2f} (n={s['n']})" if s and s["n"] > 2 else f"v{v}: -")
        say(f"   D{d}: " + "; ".join(line))
    disp = displacements(st2, tg, [(0, 2), (2, 4), (0, 4)])
    say("Visit-to-visit displacement (per-detector change in offset, combined over detectors by inverse variance):")
    print_displ("Barnard", disp)
    for r in disp:
        a, b = r["pair"]
        pr = float(np.hypot(r["ra"]["pred"], r["dec"]["pred"]))
        ms = float(np.hypot(r["ra"]["meas"], r["dec"]["meas"]))
        dt = (st2[(b, None)]["mjd"] - st2[(a, None)]["mjd"]) / 365.25
        say(f"      total: predicted {pr:.2f}\" = {pr / M.PIXEL_ARCSEC:.2f} px ({pr / M.PIXEL_ARCSEC / dt:.2f} px/yr over {dt:.2f} yr); "
            f"measured {ms:.2f}\" = {ms / M.PIXEL_ARCSEC:.2f} px ({ms / M.PIXEL_ARCSEC / dt:.2f} px/yr)")
        R[f"disp_v{a}_v{b}"] = dict(
            dra_measured=metric(r["ra"]["meas"], "arcsec", r["n"], SCRIPT, f"error {r['ra']['err']:.3f}; predicted {r['ra']['pred']:.3f}"),
            ddec_measured=metric(r["dec"]["meas"], "arcsec", r["n"], SCRIPT, f"error {r['dec']['err']:.3f}; predicted {r['dec']['pred']:.3f}"),
            ddec_minus_predicted=metric(r["dec"]["diff"], "arcsec", r["n"], SCRIPT, f"error {r['dec']['err']:.3f}"),
            dra_minus_predicted=metric(r["ra"]["diff"], "arcsec", r["n"], SCRIPT, f"error {r['ra']['err']:.3f}"),
            speed_measured=metric(ms / M.PIXEL_ARCSEC / dt, "px/yr", r["n"], SCRIPT, f"predicted {pr / M.PIXEL_ARCSEC / dt:.2f} px/yr"))
    rms_ra = float(np.sqrt(np.mean([r["ra"]["diff"] ** 2 for r in disp])))
    rms_de = float(np.sqrt(np.mean([r["dec"]["diff"] ** 2 for r in disp])))
    say(f"   rms (measured - predicted) over the three visit pairs: dRA* {rms_ra:.2f}\" ({rms_ra / M.PIXEL_ARCSEC:.2f} px), dDec {rms_de:.2f}\" ({rms_de / M.PIXEL_ARCSEC:.2f} px). "
        f"The formal errors (0.12 to 0.15\") are smaller than the RA* residuals of visit pairs with a different roll, so the wings method has a systematic floor of about 0.5 to 0.9\" (0.1 px) in RA*; "
        f"the one-year pair 0->4 (same roll, bias cancels) agrees within 0.17\" in RA* and 0.03\" in Dec.")
    R["rms_disp_minus_pred"] = metric([rms_ra, rms_de], "arcsec (RA*, Dec)", 3, SCRIPT, "over visit pairs 0-2, 2-4, 0-4; the formal error is smaller than the RA* value (wings-method systematic)")
    # the same without the per-frame registration correction
    st_raw = visit_stats(TT, [0, 2, 4], cols=("dra_raw", "ddec_raw"))
    st_raw = {k: dict(v, dra=v["dra_raw"], ddec=v["ddec_raw"], e_dra=v["e_dra_raw"], e_ddec=v["e_ddec_raw"]) for k, v in st_raw.items()}
    disp_raw = displacements(st_raw, tg, [(0, 2), (2, 4), (0, 4)])
    say("   WITHOUT the wings-bias correction (the visit 2 spacecraft roll differs from visits 0 and 4, so a bias fixed in detector pixels shows up in sky coordinates):")
    print_displ("Barnard no-bias-corr", disp_raw)
    R["displacement_without_bias_correction"] = {f"v{r['pair'][0]}_v{r['pair'][1]}": dict(
        ra_minus_pred=metric(r["ra"]["diff"], "arcsec", r["n"], SCRIPT, f"error {r['ra']['err']:.3f}"),
        dec_minus_pred=metric(r["dec"]["diff"], "arcsec", r["n"], SCRIPT, f"error {r['dec']['err']:.3f}")) for r in disp_raw}
    R["pooled_offsets"] = {f"visit{v}": dict(
        dra=metric(s["dra"], "arcsec", s["n"], SCRIPT, f"error {s['e_dra']:.3f}"),
        ddec=metric(s["ddec"], "arcsec", s["n"], SCRIPT, f"error {s['e_ddec']:.3f}"),
        mjd=s["mjd"]) for v, s in pooled.items()}
    R["wings_exposure_scatter"] = metric(float(np.median([pooled[v]["sd_dra_c"] for v in pooled])), "arcsec (RA*, single exposure)", int(len(TC)), SCRIPT)

    # ---- figure
    fig, ax = plt.subplots(1, 3, figsize=(15, 4.6))
    cols = {0: "#1f77b4", 2: "#d95f02", 4: "#1b9e77"}
    for v in (0, 2, 4):
        m = np.asarray(TC["visit"]) == v
        ax[0].plot(np.asarray(TC["dra_c"])[m], np.asarray(TC["ddec_c"])[m], ".", ms=3, alpha=0.35, color=cols[v])
        s = pooled.get(v)
        if s:
            ax[0].errorbar(s["dra"], s["ddec"], xerr=s["e_dra"], yerr=s["e_ddec"], fmt="o", color=cols[v], mec="k", ms=8, label=f"visit {v} mean (N={s['n']})")
    ax[0].axhline(0, c="k", lw=0.5); ax[0].axvline(0, c="k", lw=0.5)
    ax[0].set_xlim(-3, 3); ax[0].set_ylim(-3, 3)
    ax[0].set_xlabel("measured - predicted, RA* [arcsec]"); ax[0].set_ylabel("Dec [arcsec]")
    ax[0].set_title("Wings-only position vs prediction (per exposure)"); ax[0].legend(fontsize=8)
    # track
    mj = np.linspace(60850, 61300, 200)
    ra, de = M.predict(tg, mj)
    dra_t, dde_t = M.sky_offset(ra, de, ra[0], de[0])
    ax[1].plot(dra_t, dde_t, "k-", lw=1, label="predicted track")
    ra0, de0 = M.predict(tg, pooled[0]["mjd"])
    for v in (0, 2, 4):
        s = pooled.get(v)
        if not s:
            continue
        rp, dp = M.predict(tg, s["mjd"])
        px, py = M.sky_offset(rp, dp, ra[0], de[0])
        ax[1].errorbar(px + s["dra"], py + s["ddec"], xerr=s["e_dra"], yerr=s["e_ddec"], fmt="o", color=cols[v], mec="k", ms=7, label=f"measured, visit {v}")
        ax[1].plot(px, py, "x", color=cols[v])
    ax[1].set_xlabel("RA* relative to first predicted point [arcsec]"); ax[1].set_ylabel("Dec [arcsec]")
    ax[1].set_title("Visit positions on the predicted track (x = prediction)"); ax[1].legend(fontsize=8)
    ax[1].set_aspect("equal", adjustable="datalim")
    for d in range(1, 7):
        for v in (0, 2, 4):
            s = st2.get((v, d))
            if s and s["n"] > 2:
                ax[2].errorbar(d + (v - 2) * 0.08, s["ddec"], yerr=s["e_ddec"], fmt="o", color=cols[v], ms=4)
    ax[2].axhline(0, c="k", lw=0.5)
    ax[2].set_xlabel("detector"); ax[2].set_ylabel("Dec offset measured - predicted [arcsec]")
    ax[2].set_title("Per detector, per visit (colours as left)")
    fig.suptitle("Barnard's Star: saturated in all exposures; wings-only positions (method limits in text)", fontsize=10)
    fig.tight_layout()
    fig.savefig(FIGURES / "movers_barnard.png", dpi=130)
    plt.close(fig)
    return R


# ------------------------------------------------------------------ B. Eps Indi B
def measure_epsindib(refresh=False):
    p = PC / "movers_epsindib.ecsv"
    if p.exists() and not refresh:
        return Table.read(p)
    tgs = {"gaia": M.TARGETS["epsindib_gaia"], "chen": M.TARGETS["epsindib_chen"]}
    rows = M.read_index(DATA / "index_epsindi.csv")
    fo = M.frame_offsets("epsindi")
    recs = []
    for i, r in enumerate(rows):
        if r["on_detector"] != "True":
            continue
        fr = M.load_frame(DATA.parent / r["cutout_path"])
        ra, de = M.predict(tgs["gaia"], fr["mjd"])
        rac, dec_ = M.predict(tgs["chen"], fr["mjd"])
        x, y = M.pixel_of(fr, rac, dec_)       # Chen 2022 system motion for the starting position
        fs = M.flag_summary(fr, x, y)
        rec = dict(row=i, obs_id=fr["obs_id"], det=fr["detector"], visit=int(r["visit"]), mjd=fr["mjd"], release=fr["release"],
                   x_pred=x, y_pred=y, inside=fs["inside"], saturated=fs["saturated"], ok=False, x=np.nan, y=np.nan, ex=np.nan, ey=np.nan,
                   flux=np.nan, eflux=np.nan, sigma=np.nan, chi2r=np.nan, snr=np.nan, bkg=np.nan, ra_m=np.nan, dec_m=np.nan,
                   dra_gaia=np.nan, ddec_gaia=np.nan, dra_chen=np.nan, ddec_chen=np.nan, reg_dra=np.nan, reg_ddec=np.nan,
                   lam=np.nan, bw=np.nan, f_ok=False, f_reason="", f_flux=np.nan, f_var=np.nan, f_sat=False,
                   dist_A=np.nan)
        if fs["inside"]:
            c = M.centroid_gauss(fr, x, y)
            rec.update(ok=c["ok"], x=c["x"], y=c["y"], ex=c["ex"], ey=c["ey"], flux=c["flux"], eflux=c["eflux"], sigma=c["sigma"],
                       chi2r=c["chi2r"], snr=c["snr"], bkg=c["bkg"])
            if c["ok"]:
                ram, dem = M.sky_of(fr, c["x"], c["y"])
                rec.update(ra_m=ram, dec_m=dem)
                a, b = M.sky_offset(ram, dem, ra, de)
                rec.update(dra_gaia=float(a), ddec_gaia=float(b))
                a, b = M.sky_offset(ram, dem, rac, dec_)
                rd, rdd, _ = fr_offset(fo, fr["detector"], fr["mjd"])
                rec.update(dra_chen=float(a), ddec_chen=float(b), reg_dra=rd, reg_ddec=rdd)
            lam, bw = cal_lambda(fr["release"], fr["detector"], x + fr["x0"], y + fr["y0"])
            rec.update(lam=lam, bw=bw)
            # forced photometry at the Chen-predicted position (m2ref machinery)
            ph = m2ref.measure_pixels(fr["R"], fr["V"], fr["FL"], x, y)
            rec.update(f_ok=ph["ok"], f_reason=ph["reason"], f_flux=ph["flux"], f_var=ph["var"], f_sat=ph["saturated"])
            # Eps Indi A distance at this epoch
            from wp.config import DATA as _D
            fc = json.loads((_D / "field_centres.json").read_text())["epsindi"]
            ta = dict(ra=fc["ra_ref"], dec=fc["dec_ref"], ref_mjd=57388.5, pmra=fc["pmra"], pmdec=fc["pmdec"], parallax=fc["parallax"])
            raA, deA = M.predict(ta, fr["mjd"])
            da, dd = M.sky_offset(raA, deA, rac, dec_)
            rec["dist_A"] = float(np.hypot(da, dd))
        recs.append(rec)
    T = Table(rows=recs)
    T.write(p, overwrite=True)
    return T


def epsindib(refresh=False):
    say("\n=== B. Eps Indi B (field epsindi; Ba+Bb unresolved) ===")
    tgg, tgc = M.TARGETS["epsindib_gaia"], M.TARGETS["epsindib_chen"]
    say(f"Predictions: Gaia DR3 6412596012146801152 (pm {tgg['pmra']}, {tgg['pmdec']} mas/yr, plx {tgg['parallax']} mas) and "
        f"Chen et al. 2022 AJ 163, 288 (system pm {tgc['pmra']}, {tgc['pmdec']}; plx {tgc['parallax']} mas), both from the Gaia 2016.0 position.")
    T = measure_epsindib(refresh)
    R = {}
    ins = np.asarray(T["inside"], bool)
    ok = np.asarray(T["ok"], bool)
    say(f"Exposures with B in the cutout: {int(ins.sum())} of {len(T)}; centroid fit accepted: {int(ok.sum())}; "
        f"saturation flags in 5x5: {int(np.sum(np.asarray(T['saturated'], bool) & ins))}")
    sat_ok = np.asarray(T["saturated"], bool) & ok
    vis = [0, 1, 2, 3]
    TT = T[ok & (np.asarray(T["flux"]) > 0)]
    # clip frames with a failed fit: chi2r absurd or position more than 1.5 px from the prediction
    pos_err = np.hypot(np.asarray(TT["x"]) - np.asarray(TT["x_pred"]), np.asarray(TT["y"]) - np.asarray(TT["y_pred"]))
    TT = TT[pos_err < 1.0]
    say(f"   accepted with |fit - predicted| < 1 px: {len(TT)}")
    for model in ("gaia", "chen"):
        TT["dra"] = TT[f"dra_{model}"]
        TT["ddec"] = TT[f"ddec_{model}"]
        TT["dra_c"] = TT["dra"] - TT["reg_dra"]
        TT["ddec_c"] = TT["ddec"] - TT["reg_ddec"]
        good = np.isfinite(np.asarray(TT["dra_c"]))
        TC = TT[good]
        st = visit_stats(TC, vis, cols=("dra_c", "ddec_c"))
        st2 = {k: dict(v, dra=v["dra_c"], ddec=v["ddec_c"], e_dra=v["e_dra_c"], e_ddec=v["e_ddec_c"]) for k, v in st.items()}
        tg = tgg if model == "gaia" else tgc
        say(f"--- prediction: {model}; offsets corrected for each frame's registration offset ({len(TC)} of {len(TT)} frames have >= 5 reference stars)")
        for v in vis:
            s = st2.get((v, None))
            if s:
                say(f"   visit {v} (MJD {s['mjd']:.1f}): dRA* {s['dra']:+.3f} +/- {s['e_dra']:.3f}\"  dDec {s['ddec']:+.3f} +/- {s['e_ddec']:.3f}\"  "
                    f"N={s['n']} (clipped {s['n_clipped']}); single-exposure scatter {s['sd_dra_c']:.2f} / {s['sd_ddec_c']:.2f}\"")
        disp = displacements(st2, tg, [(0, 1), (1, 2), (2, 3), (0, 2), (1, 3), (0, 3)], dets=[2, 3, 5, 6, 1, 4])
        say("Visit-to-visit displacement (per-detector changes in offset combined by inverse variance):")
        print_displ(model, disp)
        R[f"{model}_visit_offsets"] = {f"visit{v}": dict(dra=metric(st2[(v, None)]["dra"], "arcsec", st2[(v, None)]["n"], SCRIPT, f"error {st2[(v, None)]['e_dra']:.3f}"),
                                                        ddec=metric(st2[(v, None)]["ddec"], "arcsec", st2[(v, None)]["n"], SCRIPT, f"error {st2[(v, None)]['e_ddec']:.3f}"),
                                                        mjd=st2[(v, None)]["mjd"]) for v in vis if (v, None) in st2}
        R[f"{model}_displacements"] = {f"v{r['pair'][0]}_v{r['pair'][1]}": dict(
            ra_meas=metric(r["ra"]["meas"], "arcsec", r["n"], SCRIPT, f"error {r['ra']['err']:.3f}, predicted {r['ra']['pred']:.3f}"),
            dec_meas=metric(r["dec"]["meas"], "arcsec", r["n"], SCRIPT, f"error {r['dec']['err']:.3f}, predicted {r['dec']['pred']:.3f}"),
            ra_minus_pred=metric(r["ra"]["diff"], "arcsec", r["n"], SCRIPT, f"error {r['ra']['err']:.3f}"),
            dec_minus_pred=metric(r["dec"]["diff"], "arcsec", r["n"], SCRIPT, f"error {r['dec']['err']:.3f}")) for r in disp}
        if model == "chen":
            st_c, disp_c = st2, disp
            TC_c = TC
        else:
            st_g, disp_g = st2, disp
    # per-detector table for the Chen prediction
    say("Per visit and detector, Chen prediction (dRA*/dDec arcsec, N):")
    for d in range(1, 7):
        line = []
        for v in vis:
            s = st_c.get((v, d))
            line.append(f"v{v}: {s['dra']:+.2f}/{s['ddec']:+.2f} (n={s['n']})" if s and s["n"] > 2 else f"v{v}: -")
        say(f"   D{d}: " + "; ".join(line))

    # ---- Ba-Bb and the halo of Eps Indi A
    say("Checks on the offset:")
    say(f"   Ba-Bb separation about 0.9\" (0.15 px) in 2026 (Chen 2022; P 11.02 yr, a 0.66\"): unresolved at {M.PIXEL_ARCSEC}\" per pixel; a flux-ratio change between the two components with wavelength can move the photocentre by up to about half the separation (~0.45\" = 0.07 px) along the Ba-Bb axis.")
    lam = np.asarray(TC_c["lam"], float)
    bins = [(0.7, 1.8), (1.8, 3.2), (3.2, 5.1)]
    dist = np.asarray(TC_c["dist_A"], float)
    say(f"   distance to Eps Indi A: {np.nanmin(dist):.0f} to {np.nanmax(dist):.0f}\" ({np.nanmedian(dist) / 60:.2f} arcmin)")
    wl = {}
    for v in vis:
        line = []
        for lo, hi in bins:
            m = (np.asarray(TC_c["visit"]) == v) & (lam >= lo) & (lam < hi)
            if m.sum() >= 4:
                k = robust_clip(np.asarray(TC_c["dra_c"])[m]) & robust_clip(np.asarray(TC_c["ddec_c"])[m])
                a, ea, n = M.mean_sem(np.asarray(TC_c["dra_c"])[m][k])
                b, eb, _ = M.mean_sem(np.asarray(TC_c["ddec_c"])[m][k])
                line.append(f"{lo}-{hi} um: {a:+.2f}+/-{ea:.2f},{b:+.2f}+/-{eb:.2f} (n={n})")
                wl[(v, lo)] = (a, ea, b, eb, n)
            else:
                line.append(f"{lo}-{hi} um: -")
        say(f"   visit {v}: " + "; ".join(line))
    # offset change across wavelength bins, per visit (RA, Dec) as a photocentre indicator
    diffs = []
    for v in vis:
        for k0, k1 in ((bins[0][0], bins[2][0]),):
            if (v, k0) in wl and (v, k1) in wl:
                a0, e0, b0, f0, _ = wl[(v, k0)]
                a1, e1, b1, f1, _ = wl[(v, k1)]
                diffs.append((v, a1 - a0, np.hypot(e0, e1), b1 - b0, np.hypot(f0, f1)))
    for v, da, ea, db, eb in diffs:
        say(f"   visit {v}: long (3.2-5.1 um) minus short (0.7-1.8 um) offset: dRA* {da:+.2f} +/- {ea:.2f}\", dDec {db:+.2f} +/- {eb:.2f}\"")
    R["photocentre_long_minus_short"] = {f"visit{v}": dict(dra=metric(da, "arcsec", None, SCRIPT, f"error {ea:.3f}"),
                                                           ddec=metric(db, "arcsec", None, SCRIPT, f"error {eb:.3f}")) for v, da, ea, db, eb in diffs}
    # halo: correlation of the offset with the local background (A's wings) per detector
    from scipy.stats import spearmanr
    bkg = np.asarray(TC_c["bkg"], float)
    pk = np.asarray(TC_c["flux"], float)
    say(f"   local background at B (IMAGE-ZODI annulus) median {np.nanmedian(bkg):.3g} MJy/sr = {np.nanmedian(bkg / pk) * 100:.1f}% of B's fitted flux; "
        f"90th percentile {np.nanpercentile(bkg, 90):.3g} MJy/sr")
    rho_r = []
    for d in range(1, 7):
        m = (np.asarray(TC_c["det"]) == d) & np.isfinite(bkg)
        if m.sum() >= 15:
            r1 = spearmanr(bkg[m], np.asarray(TC_c["dra_c"])[m])
            r2 = spearmanr(bkg[m], np.asarray(TC_c["ddec_c"])[m])
            rho_r.append((d, int(m.sum()), r1.statistic, r1.pvalue, r2.statistic, r2.pvalue))
            say(f"   D{d}: n={int(m.sum())} Spearman(background, dRA*) {r1.statistic:+.2f} (p={r1.pvalue:.2g}), (background, dDec) {r2.statistic:+.2f} (p={r2.pvalue:.2g})")
    R["halo_background_fraction"] = metric(float(np.nanmedian(bkg / pk)), "background / fitted flux (median)", int(np.isfinite(bkg).sum()), SCRIPT,
                                           "IMAGE-ZODI annulus background at B relative to B's fitted flux; Eps Indi A is G 4.3 at ~6.6 arcmin")

    # ---- spectra
    say("Per-visit spectra (forced photometry m2ref.measure_pixels at the Chen position, 2 px aperture, inflated variance):")
    FT = T[np.asarray(T["f_ok"], bool) & np.isfinite(np.asarray(T["lam"], float))]
    say(f"   {len(FT)} of {int(ins.sum())} exposures accepted by measure_pixels; unaccepted reasons: "
        f"{dict(zip(*np.unique(np.asarray(T['f_reason'])[ins], return_counts=True)))}")
    cols = {0: "#1f77b4", 1: "#d95f02", 2: "#1b9e77", 3: "#7570b3"}
    fig, ax = plt.subplots(1, 2, figsize=(14, 5.3))
    # left: positions
    mj = np.linspace(60760, 61300, 300)
    for tg, ls, lab in ((tgg, "-", "Gaia DR3 pm"), (tgc, "--", "Chen 2022 pm")):
        ra, de = M.predict(tg, mj)
        r0, d0 = M.predict(tgc, 60789.0)
        a, b = M.sky_offset(ra, de, r0, d0)
        ax[0].plot(a, b, ls, c="k", lw=1, label="predicted track, " + lab)
    for v in vis:
        s = st_c.get((v, None))
        if not s:
            continue
        r0, d0 = M.predict(tgc, 60789.0)
        rp, dp = M.predict(tgc, s["mjd"])
        px, py = M.sky_offset(rp, dp, r0, d0)
        m = np.asarray(TC_c["visit"]) == v
        # single exposures
        ra_m, de_m = np.asarray(TC_c["ra_m"])[m], np.asarray(TC_c["dec_m"])[m]
        rr = np.asarray(TC_c["reg_dra"])[m]
        rd = np.asarray(TC_c["reg_ddec"])[m]
        ex, ey = M.sky_offset(ra_m, de_m, r0, d0)
        ax[0].plot(ex - rr, ey - rd, ".", ms=2.5, alpha=0.3, color=cols[v])
        ax[0].errorbar(px + s["dra"], py + s["ddec"], xerr=s["e_dra"], yerr=s["e_ddec"], fmt="o", ms=8, mec="k", color=cols[v], label=f"visit {v} mean, N={s['n']}")
        ax[0].plot(px, py, "x", color=cols[v], ms=9)
    ax[0].set_xlabel("RA* [arcsec] relative to the Chen position at MJD 60789"); ax[0].set_ylabel("Dec [arcsec]")
    ax[0].set_title("Eps Indi B positions per visit (x = prediction, dots = exposures)"); ax[0].legend(fontsize=7)
    ax[0].set_aspect("equal", adjustable="datalim")
    # right: spectra
    spec = {}
    for v in vis:
        for d in range(1, 7):
            m = (np.asarray(FT["visit"]) == v) & (np.asarray(FT["det"]) == d)
            if m.sum() == 0:
                continue
            lam = np.asarray(FT["lam"])[m]
            fl = np.asarray(FT["f_flux"])[m] * MJY_SR_PX_TO_MJY
            er = np.sqrt(np.asarray(FT["f_var"])[m]) * MJY_SR_PX_TO_MJY
            spec[(v, d)] = (lam, fl, er)
            ax[1].errorbar(lam, fl, er, fmt=".", ms=3.5, lw=0.5, color=cols[v], alpha=0.7, label=f"visit {v}" if d == min(dd for (vv, dd) in [(v, x) for x in range(1, 7)] if (v, dd) in spec or True) and False else None)
    for v in vis:
        ax[1].plot([], [], "o", color=cols[v], label=f"visit {v} (MJD {st_c[(v, None)]['mjd']:.0f})")
    ax[1].set_xlabel("wavelength [um]"); ax[1].set_ylabel("aperture flux [mJy] (2 px radius, not aperture corrected)")
    ax[1].set_yscale("symlog", linthresh=1.0); ax[1].set_title("Eps Indi B spectrum per visit (T1 + T6 pair)")
    ax[1].legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(FIGURES / "movers_epsindib.png", dpi=130)
    plt.close(fig)

    # ---- matched comparison per detector (m2ref.compare_visits)
    say("Matched comparison of the visits (m2ref.compare_visits, per detector; visits with fewer than 8 exposures skipped, 'partial_visit'):")
    cmp = {}
    zs, fs_, psz, clean = [], [], [], []
    for d in range(1, 7):
        samples = {}
        for v in vis:
            m = (np.asarray(FT["visit"]) == v) & (np.asarray(FT["det"]) == d)
            samples[v] = [dict(id=f"{FT['obs_id'][i]}_D{d}", lam=float(FT["lam"][i]), bw=float(FT["bw"][i]), mjd=float(FT["mjd"][i]),
                               flux=float(FT["f_flux"][i]), var=float(FT["f_var"][i]), saturated=bool(FT["f_sat"][i])) for i in np.where(m)[0]]
        for a, b in ((0, 1), (1, 2), (2, 3), (0, 2), (1, 3), (0, 3)):
            if len(samples[a]) < m2ref.MIN_EXPOSURES or len(samples[b]) < m2ref.MIN_EXPOSURES:
                continue
            res = m2ref.compare_visits(samples[a], samples[b])
            if res["n_w0"] == 0:
                continue
            cmp[(d, a, b)] = res
            zs.append(res["z"])
            fs_.append(res["frac"])
            say(f"   D{d} visits {a}->{b}: nA={res['n_exposures_A']} nB={res['n_exposures_B']} n_w0={res['n_w0']}  matched z {res['z']:+.2f}, "
                f"fractional diff {res['frac'] * 100:+.1f} %;  plain best-pair z {res['plain']['z']:+.2f};  paired stack z {fmt(res['ps']['z'], 2)}, frac {fmt(100 * res['ps']['frac'], 1)} % (n_pairs {res['ps']['n_pairs']}); flags {res['flags']}")
            psz.append(res["ps"]["z"])
            clean.append((res["z"], not res["flags"] or res["flags"] == ["saturated"]))
    if zs:
        zs, fs_ = np.array(zs), np.array(fs_)
        say(f"   {len(zs)} detector x visit-pair comparisons: |z|<3 in {int(np.sum(np.abs(zs) < 3))}; median z {np.median(zs):+.2f}; "
            f"rms z {np.sqrt(np.mean(zs ** 2)):.2f}; median fractional difference {np.median(fs_) * 100:+.1f} % (range {fs_.min() * 100:+.1f} to {fs_.max() * 100:+.1f})")
        psz = np.array(psz)
        cz = np.array([c[0] for c in clean if c[1]])
        say(f"   unflagged comparisons only (>= 3 evaluation wavelengths, no too_few_samples / no_bracket): n={len(cz)}, |z|<3 in {int(np.sum(np.abs(cz) < 3))}, rms z {np.sqrt(np.mean(cz ** 2)) if len(cz) else float('nan'):.2f}")
        say(f"   paired stack (nearest wavelength within one channel, no spectral model): rms z {np.sqrt(np.nanmean(psz ** 2)):.2f}; |z|<3 in {int(np.sum(np.abs(psz) < 3))} of {int(np.sum(np.isfinite(psz)))}")
        R["paired_stack_summary"] = dict(rms_z=metric(float(np.sqrt(np.nanmean(psz ** 2))), "z", int(np.sum(np.isfinite(psz))), SCRIPT),
                                         n_abs_z_lt_3=metric(int(np.sum(np.abs(psz) < 3)), "comparisons", int(np.sum(np.isfinite(psz))), SCRIPT))
        R["matched_comparisons"] = dict(
            n_unflagged=metric(int(len(cz)), "comparisons with no flags", None, SCRIPT, f"|z|<3 in {int(np.sum(np.abs(cz) < 3))}"),
            n=metric(int(len(zs)), "detector x visit pair comparisons", None, SCRIPT),
            n_abs_z_lt_3=metric(int(np.sum(np.abs(zs) < 3)), "comparisons", int(len(zs)), SCRIPT),
            rms_z=metric(float(np.sqrt(np.mean(zs ** 2))), "z", int(len(zs)), SCRIPT, "1 if constant and errors right (phase B z width on constant stars about 1.3-1.4)"),
            median_frac=metric(float(np.median(fs_) * 100), "percent", int(len(zs)), SCRIPT, "matched fractional flux difference A-B"))
    # spectral steepness: why a nearest-wavelength pair or a straight line can mislead on a T dwarf
    steep = {}
    for d in range(1, 7):
        sl = []
        for v in vis:
            m = (np.asarray(FT["visit"]) == v) & (np.asarray(FT["det"]) == d)
            if m.sum() < 8:
                continue
            o = np.argsort(np.asarray(FT["lam"])[m])
            lam_ = np.asarray(FT["lam"])[m][o]; f_ = np.asarray(FT["f_flux"])[m][o]; bw_ = np.asarray(FT["bw"])[m][o]
            dl = np.diff(lam_) / (0.5 * (bw_[1:] + bw_[:-1]))
            ok_ = (dl > 0.05) & (dl < 1.5) & (f_[1:] > 0) & (f_[:-1] > 0)
            sl += list(np.abs(np.log(f_[1:][ok_] / f_[:-1][ok_])) / dl[ok_])
        if sl:
            steep[d] = (float(np.median(sl) * 100), float(np.percentile(sl, 90) * 100), len(sl))
    say("Spectral steepness |d ln F| per channel width (median, 90th percentile, % per channel) from sorted exposures within a visit: " +
        "; ".join(f"D{d} {a:.1f}/{b:.1f}" for d, (a, b, n) in steep.items()))
    say("   => a half-channel wavelength mismatch changes the flux by that percentage per channel x 0.5: the 'same wavelength' condition matters far more than for a flat-spectrum star (phase B stars).")
    R["spectral_steepness_pct_per_channel"] = {f"D{d}": dict(median=metric(a, "percent per channel width", n, SCRIPT), p90=metric(b, "percent per channel width", n, SCRIPT)) for d, (a, b, n) in steep.items()}
    # control: the same paired-stack comparison for the constant phase B stars of the Eps Indi field, per detector
    say("Control: paired stack (nearest wavelength within one channel) on the constant phase B stars of the Eps Indi field (median fractional difference over stars, SEM = 1.2533 sigma/sqrt(n)):")
    P = Table.read(DATA / "phaseb" / "epsindi" / "forced_phot.ecsv")
    P = P[np.asarray(P["ok"], bool)]
    ctrl = {}
    sid = np.asarray(P["source_id"], np.int64)
    for d in (2, 3, 5, 6):
        for a, b in ((0, 1), (1, 3), (0, 3)):
            fr_ = []
            for sidv in np.unique(sid[np.asarray(P["detector"]) == d]):
                sm = {}
                for v in (a, b):
                    m = (sid == sidv) & (np.asarray(P["detector"]) == d) & (np.asarray(P["visit"]) == v)
                    sm[v] = [dict(id=f"{P['obs_id'][i]}", lam=float(P["lam"][i]), bw=float(P["bw"][i]), mjd=float(P["mjd"][i]),
                                  flux=float(P["flux"][i]), var=float(P["var"][i]) + (m2ref.FLUX_FLOOR * float(P["flux"][i])) ** 2, saturated=False) for i in np.where(m)[0]]
                if len(sm[a]) < m2ref.MIN_EXPOSURES or len(sm[b]) < m2ref.MIN_EXPOSURES:
                    continue
                ps = m2ref.paired_stack(sm[a], sm[b])
                if ps["n_pairs"] >= 8 and np.isfinite(ps["frac"]):
                    fr_.append(ps["frac"])
            if len(fr_) >= 5:
                fr_ = np.array(fr_)
                ctrl[(d, a, b)] = (float(np.median(fr_) * 100), float(1.2533 * 1.4826 * np.median(np.abs(fr_ - np.median(fr_))) / np.sqrt(len(fr_)) * 100), len(fr_))
    for (d, a, b), (m_, e_, n_) in sorted(ctrl.items()):
        say(f"   D{d} visits {a}->{b}: {m_:+.2f} +/- {e_:.2f} % (n={n_} stars)")
    R["control_stars_paired_stack_median_frac"] = {f"D{d}_v{a}_v{b}": metric(m_, "percent", n_, SCRIPT, f"error {e_:.2f}") for (d, a, b), (m_, e_, n_) in ctrl.items()}
    # spectrum summary numbers
    allsp = [(v, spec[(v, d)]) for (v, d) in spec]
    for v in vis:
        lam = np.concatenate([s[0] for vv, s in allsp if vv == v]) if any(vv == v for vv, _ in allsp) else np.array([])
        if len(lam):
            fl = np.concatenate([s[1] for vv, s in allsp if vv == v])
            say(f"   visit {v}: {len(lam)} exposures, flux range {fl.min():.2f} to {fl.max():.2f} mJy (aperture), lambda {lam.min():.2f}-{lam.max():.2f} um")
    return R


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="barnard,epsindib,wise0855")
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    which = a.only.split(",")
    t0 = time.time()
    results = {}
    cache = PC / "movers_results.json"
    if cache.exists():
        results = json.loads(cache.read_text())
    if "barnard" in which:
        results["barnard"] = barnard(a.refresh)
    if "epsindib" in which:
        results["epsindib"] = epsindib(a.refresh)
    if "wise0855" in which:
        from importlib import import_module  # noqa: F401
        results["wise0855"] = wise0855(a.refresh)
    cache.write_text(json.dumps(results, default=float))
    results["_citations"] = [
        "Gaia Collaboration 2023, A&A 674, A1 (Gaia DR3)",
        "Chen et al. 2022, AJ 163, 288 (arXiv:2205.08077)",
        "McCaughrean et al. 2004, A&A 413, 1029 (Eps Indi B 2MASS photometry)",
        "Luhman & Esplin 2016, ApJ 827, 52 (arXiv:1605.06655)",
        "Luhman et al. 2024, AJ 167, 5",
        "IRSA WISE explanatory supplement (W2 AB offset 3.339)"]
    update_results("known_movers", results)
    print(f"\nresults.json section known_movers written; runtime {time.time() - t0:.0f} s")


# ------------------------------------------------------------------ C. WISE 0855-0714
W_DIR = DATA / "wise0855"
W_HALF = 40
W_MJD_2026 = 61041.0
AB_ZERO_JY = 3631.0


def ab_mag_from_mjy(f_mjy):
    f = np.asarray(f_mjy, float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(f > 0, -2.5 * np.log10(f * 1e-3 / AB_ZERO_JY), np.nan)


def assign_stack_flags(mjd, visit, gap_days=7.0, min_exp=12):
    """Data seat rule: inside a visit, clusters separated by more than 7 days with fewer than 12
    exposures are not used in stacks. Returns bool array in_stack."""
    mjd = np.asarray(mjd, float)
    visit = np.asarray(visit, int)
    ins = np.ones(len(mjd), bool)
    for v in np.unique(visit):
        idx = np.where(visit == v)[0]
        idx = idx[np.argsort(mjd[idx])]
        cl = np.zeros(len(idx), int)
        for k in range(1, len(idx)):
            cl[k] = cl[k - 1] + (mjd[idx[k]] - mjd[idx[k - 1]] > gap_days)
        for c in np.unique(cl):
            if np.sum(cl == c) < min_exp:
                ins[idx[cl == c]] = False
    return ins


def wise_prepare(refresh=False):
    """SIA2 query at the predicted 2026.0 position, headers, cutouts (half=40, centred on the position at
    each exposure's epoch), index CSV. Returns (index rows list, bytes downloaded this run)."""
    import csv as _csv
    import time as _t
    from wp import io as wio
    from wp.exposures import assign_visits, query_exposures
    tg = M.TARGETS["wise0855"]
    idx_path = W_DIR / "index.csv"
    if idx_path.exists() and not refresh:
        return M.read_index(idx_path), 0
    ra26, de26 = M.predict(tg, W_MJD_2026)
    tab = None
    sia = PC / "wise0855_sia.ecsv"
    if sia.exists() and not refresh:
        tab = Table.read(sia)
    else:
        for k in range(8):
            try:
                tab, info = query_exposures(ra26, de26)
                break
            except Exception as e:  # noqa: BLE001
                print("SIA retry", repr(e)[:80])
                _t.sleep(8 * (k + 1))
        tab["visit"] = assign_visits(tab["mjd_mid"], gap=30.0)
        tab.write(sia, overwrite=True)
    print(f"WISE 0855: {len(tab)} exposures from SIA2 at predicted 2026.0 position ({ra26:.6f}, {de26:.6f})")
    mjd = np.asarray(tab["mjd_mid"], float)
    visit = np.asarray(tab["visit"], int)
    in_stack = assign_stack_flags(mjd, visit)
    jobs, rows = [], []
    b0 = wio.bytes_downloaded()
    for i, r in enumerate(tab):
        hdr = wio.read_image_header(str(r["s3_key"]))
        ra, de = M.predict(tg, float(r["mjd_mid"]))
        x, y, on = wio.target_pixel(hdr, ra, de)
        out = W_DIR / "cutouts" / f"{r['obs_id']}_D{int(r['detector'])}.fits"
        rows.append(dict(obs_id=str(r["obs_id"]), detector=int(r["detector"]), release=str(r["release"]), s3_key=str(r["s3_key"]),
                         t_min=float(r["t_min"]), t_max=float(r["t_max"]), mjd_mid=float(r["mjd_mid"]), visit=int(r["visit"]),
                         in_stack=bool(in_stack[i]), target_x=x, target_y=y, on_detector=on, cutout_path=str(out.relative_to(DATA.parent))))
        if on:
            jobs.append(dict(s3_key=str(r["s3_key"]), x_c=x, y_c=y, half=W_HALF, out_path=out,
                             meta=dict(release=str(r["release"]), field="wise0855", visit=int(r["visit"]))))
    print(f"   {len(jobs)} on detector; fetching cutouts half={W_HALF} ...")
    res = wio.fetch_many(jobs, workers=8, progress=lambda i, n: print(f"   fetch {i}/{n}", flush=True) if i % 40 == 0 else None)
    errs = [(j, e) for j, e in res if e]
    if errs:
        print("   fetch errors:", len(errs), errs[:2])
    W_DIR.mkdir(parents=True, exist_ok=True)
    with open(idx_path, "w", newline="") as f:
        w = _csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return M.read_index(idx_path), wio.bytes_downloaded() - b0


def gaia_cone(ra, dec, radius_arcsec, name):
    """Gaia DR3 sources around a position (anonymous TAP), cached."""
    import io as _io
    import requests
    from wp.config import USER_AGENT
    p = PC / f"gaia_cone_{name}.ecsv"
    if p.exists():
        t = Table.read(p)
        for c in t.colnames:
            if c != c.lower():
                t.rename_column(c, c.lower())
        return t
    q = (f"SELECT source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, phot_bp_mean_mag, phot_rp_mean_mag FROM gaiadr3.gaia_source "
         f"WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_arcsec / 3600.0}))")
    r = requests.post("https://gea.esac.esa.int/tap-server/tap/sync", timeout=300, headers={"User-Agent": USER_AGENT},
                      data=dict(REQUEST="doQuery", LANG="ADQL", FORMAT="votable", QUERY=q))
    r.raise_for_status()
    t = Table.read(_io.BytesIO(r.content), format="votable")
    t = Table(t, masked=False)
    for c in t.colnames:
        if c != c.lower():
            t.rename_column(c, c.lower())
    t.write(p, overwrite=True)
    return t


def stack_shifted(frames, positions, half=10):
    """Mean image of the (R - local background) cutouts, each shifted by bilinear interpolation so that
    its sky position lands on the central pixel. frames: list of load_cutout dicts, positions: list of
    (x, y) cutout pixels. Returns (mean, var_mean, n)."""
    from scipy.ndimage import shift as ndshift
    ims, vs = [], []
    for fr, (x, y) in zip(frames, positions):
        P, V, FL = fr["P"], fr["V"], fr["FL"]
        bad = ((FL & m2ref.BAD_DATA_MASK) != 0) | ~np.isfinite(P) | ~np.isfinite(V) | (V <= 0)
        xi, yi = int(round(x)), int(round(y))
        h = half + 3
        if not (h <= xi < P.shape[1] - h and h <= yi < P.shape[0] - h):
            continue
        sl = (slice(yi - h, yi + h + 1), slice(xi - h, xi + h + 1))
        sub, vsub, bsub = P[sl].copy(), V[sl].copy(), bad[sl]
        if bsub.mean() > 0.2:
            continue
        yy, xx = np.mgrid[yi - h:yi + h + 1, xi - h:xi + h + 1]
        rr = np.hypot(xx - x, yy - y)
        am = (rr >= 5) & (rr <= h) & ~bsub
        if am.sum() < 15:
            continue
        bkg = np.median(sub[am])
        sub = np.where(bsub, bkg, sub) - bkg
        vsub = np.where(bsub, np.nanmedian(vsub), vsub)
        dx, dy = xi - x, yi - y
        ims.append(ndshift(sub, (dy, dx), order=1, mode="nearest")[3:-3, 3:-3])
        vs.append(vsub[3:-3, 3:-3])
    if not ims:
        return None, None, 0
    ims, vs = np.array(ims), np.array(vs)
    w = 1.0 / vs
    mean = np.sum(w * ims, 0) / np.sum(w, 0)
    return mean, 1.0 / np.sum(w, 0), len(ims)


def wise0855(refresh=False):
    say("\n=== C. WISE 0855-0714 (new field, cutouts half=40) ===")
    tg = M.TARGETS["wise0855"]
    R = {}
    rows, nbytes = wise_prepare(refresh)
    say(f"Prediction: {tg['cite']} ra {tg['ra']} dec {tg['dec']} at MJD {tg['ref_mjd']}, pm ({tg['pmra']}, {tg['pmdec']}) mas/yr, parallax {tg['parallax']} mas "
        f"(Luhman & Esplin 2016; Kirkpatrick 2021 gives 439.0 mas and pm (-8123.7, 673.2))")
    ra26, de26 = M.predict(tg, W_MJD_2026)
    rows = [r for r in rows if r["on_detector"] == "True" and (DATA.parent / r["cutout_path"]).exists()]
    say(f"Exposures: {len(rows)} cutouts; downloaded this run {nbytes / 1e6:.0f} MB (headers + cutouts); predicted 2026.0 position ({ra26:.6f}, {de26:.6f}) deg")
    visit = np.array([int(r["visit"]) for r in rows])
    mjd = np.array([float(r["mjd_mid"]) for r in rows])
    ins = np.array([r["in_stack"] == "True" for r in rows])
    for v in sorted(set(visit)):
        m = visit == v
        say(f"   visit {v}: {int(m.sum())} exposures, MJD {mjd[m].min():.1f}-{mjd[m].max():.1f}, in stack {int((m & ins).sum())}; per detector " +
            ", ".join(f"D{d}:{int(np.sum(m & (np.array([int(r['detector']) for r in rows]) == d)))}" for d in range(1, 7)))
    vmean = {v: float(np.mean(mjd[visit == v])) for v in sorted(set(visit))}
    ra_f1, de_f1 = M.predict(tg, vmean[min(vmean)])
    say(f"   positions tested: moving (predicted at each exposure), fixed at 2026.0 ({ra26:.6f}, {de26:.6f}), fixed at the first visit mean MJD {vmean[min(vmean)]:.1f} ({ra_f1:.6f}, {de_f1:.6f})")
    say(f"   motion between visit means: " + ", ".join(
        f"v{a}->v{b} {np.hypot(*M.sep_arcsec(tg, vmean[a], tg, vmean[b])):.1f}\" ({np.hypot(*M.sep_arcsec(tg, vmean[a], tg, vmean[b])) / M.PIXEL_ARCSEC:.2f} px)"
        for a, b in ((0, 1), (1, 2), (0, 2))))

    # ---- Gaia and the cutouts: background source near the 2026 position
    gc = gaia_cone(ra26, de26, 60.0, "wise0855")
    say(f"Gaia DR3 within 60\" of the predicted 2026.0 position: {len(gc)} sources" + ("" if len(gc) == 0 else "; nearest:"))
    if len(gc):
        da, dd = M.sky_offset(np.asarray(gc["ra"], float), np.asarray(gc["dec"], float), ra26, de26)
        sep = np.hypot(da, dd)
        for i in np.argsort(sep)[:5]:
            say(f"   Gaia DR3 {int(gc['source_id'][i])}: {sep[i]:.1f}\" away, G {float(gc['phot_g_mean_mag'][i]):.2f}")
        R["gaia_within_60as"] = metric(int(len(gc)), "sources", None, SCRIPT, f"nearest {sep.min():.1f} arcsec")
        j = int(np.argmin(sep))
        cg = dict(ra=float(gc["ra"][j]), dec=float(gc["dec"][j]), ref_mjd=57388.5, pmra=float(np.nan_to_num(gc["pmra"][j])), pmdec=float(np.nan_to_num(gc["pmdec"][j])),
                  parallax=float(np.nan_to_num(gc["parallax"][j])))
        say(f"   Nearest Gaia source: DR3 {int(gc['source_id'][j])}, ra {cg['ra']:.6f} dec {cg['dec']:.6f} (2016.0), G {float(gc['phot_g_mean_mag'][j]):.2f}, "
            f"pm ({cg['pmra']:.1f}, {cg['pmdec']:.1f}) mas/yr, parallax {cg['parallax']:.2f} mas; {sep[j]:.1f}\" from the predicted 2026.0 position (dRA* {da[j]:+.1f}\", dDec {dd[j]:+.1f}\")")
        for v_, mj_ in sorted(vmean.items()):
            rm, dm = M.predict(tg, mj_)
            rg, dgc = M.predict(cg, mj_)
            a_, b_ = M.sky_offset(rg, dgc, rm, dm)
            say(f"      at visit {v_} mean MJD {mj_:.1f}: Gaia star is {np.hypot(a_, b_):.1f}\" ({np.hypot(a_, b_) / M.PIXEL_ARCSEC:.2f} px) from the moving WISE 0855 position")
        R["detector2_contaminant"] = dict(gaia_id=str(int(gc["source_id"][j])), ra=metric(cg["ra"], "deg (2016.0)", None, SCRIPT), dec=metric(cg["dec"], "deg (2016.0)", None, SCRIPT),
                                          G=metric(float(gc["phot_g_mean_mag"][j]), "mag", None, SCRIPT), sep_from_2026_position=metric(float(sep[j]), "arcsec", None, SCRIPT))
    else:
        say("   (none; WISE 0855 itself is not in Gaia: far too faint)")

    # ---- forced photometry per exposure at three positions
    cache = PC / "movers_wise0855.ecsv"
    if cache.exists() and not refresh:
        T = Table.read(cache)
    else:
        recs = []
        for i, r in enumerate(rows):
            fr = m2ref.load_cutout(DATA.parent / r["cutout_path"])
            rec = dict(row=i, obs_id=r["obs_id"], det=int(r["detector"]), visit=int(r["visit"]), mjd=float(r["mjd_mid"]), in_stack=r["in_stack"] == "True")
            ram, dem = M.predict(tg, fr["mjd"])
            pos = {"mov": (ram, dem), "f26": (ra26, de26), "f1": (ra_f1, de_f1)}
            for k, (ra_, de_) in pos.items():
                x, y = fr["wcs"].world_to_pixel_values(ra_, de_)
                x, y = float(x), float(y)
                ph = m2ref.measure_pixels(fr["P"], fr["V"], fr["FL"], x, y)
                rec.update({f"{k}_x": x, f"{k}_y": y, f"{k}_ok": ph["ok"], f"{k}_reason": ph["reason"], f"{k}_flux": ph["flux"],
                            f"{k}_var": ph["var"], f"{k}_sat": ph["saturated"]})
            lam, bw = cal_lambda(fr["release"], fr["detector"], rec["mov_x"] + fr["x0"], rec["mov_y"] + fr["y0"])
            rec.update(lam=lam, bw=bw)
            recs.append(rec)
        T = Table(rows=recs)
        T.write(cache, overwrite=True)
    say("Photometry accepted by measure_pixels (2 px aperture, 4-7 px annulus, inflated variance):")
    for k, nm in (("mov", "moving"), ("f26", "fixed 2026.0"), ("f1", "fixed first visit")):
        ok = np.asarray(T[f"{k}_ok"], bool)
        say(f"   {nm}: {int(ok.sum())} of {len(T)}; saturated flag {int(np.sum(np.asarray(T[f'{k}_sat'], bool)))}; reasons {dict(zip(*np.unique(np.asarray(T[f'{k}_reason']), return_counts=True)))}")

    # per visit and detector: inverse-variance mean flux, error, 3 sigma upper limit in AB
    stats = {}
    say("Per visit and detector, in-stack exposures, aperture flux [mJy] (not aperture corrected): inverse-variance mean +/- formal error, chi2/dof of the exposures about the mean, "
        "3 sigma limit (flux + 3 sigma) as AB mag")
    hdr_line = "   det visit    n  lam[um]   |  moving: flux +/- err (S/N) chi2r  AB(3s)    |  fixed 2026.0: flux +/- err (S/N) chi2r  AB(3s)  | fixed first visit: flux +/- err (S/N)"
    say(hdr_line)
    for d in range(1, 7):
        for v in sorted(set(visit)):
            m = (np.asarray(T["det"]) == d) & (np.asarray(T["visit"]) == v) & np.asarray(T["in_stack"], bool)
            rec = {}
            line = f"   D{d}  v{v}"
            for k in ("mov", "f26", "f1"):
                mk = m & np.asarray(T[f"{k}_ok"], bool)
                if mk.sum() < 2:
                    rec[k] = None
                    continue
                f = np.asarray(T[f"{k}_flux"], float)[mk] * MJY_SR_PX_TO_MJY
                e = np.sqrt(np.asarray(T[f"{k}_var"], float)[mk]) * MJY_SR_PX_TO_MJY
                mu, se = M.wmean(f, e)
                chi2r = float(np.sum(((f - mu) / e) ** 2) / (len(f) - 1))
                lim = mu + 3 * se
                rec[k] = dict(flux=mu, err=se, n=int(mk.sum()), chi2r=chi2r, lim_mjy=lim, lim_ab=float(ab_mag_from_mjy(lim)), snr=mu / se,
                              lam=float(np.median(np.asarray(T["lam"], float)[mk])), err_scaled=se * max(1.0, np.sqrt(chi2r)))
            stats[(d, v)] = rec
            if rec["mov"] is None:
                say(line + "  (too few exposures)")
                continue
            def cell(r):
                return "-" if r is None else f"{r['flux']:+.4f} +/- {r['err']:.4f} ({r['snr']:+.1f}) {r['chi2r']:.1f}"
            say(f"{line} {rec['mov']['n']:4d} {rec['mov']['lam']:6.2f}   | {cell(rec['mov'])}  {rec['mov']['lim_ab']:.2f}   | "
                f"{cell(rec['f26'])}  {rec['f26']['lim_ab'] if rec['f26'] else float('nan'):.2f}   | {cell(rec['f1'])}")
    # does flux follow the proper motion?  chi2 of constancy over visits, moving vs fixed
    say("Does a flux follow the proper motion? Constancy over the 3 visits of the weighted mean (chi2, dof = visits - 1; errors scaled by sqrt(chi2r) when chi2r > 1):")
    cons = {}
    for d in range(1, 7):
        line = f"   D{d}:"
        for k, nm in (("mov", "moving"), ("f26", "fixed 2026"), ("f1", "fixed first")):
            fl = [stats[(d, v)][k] for v in sorted(set(visit)) if stats.get((d, v), {}).get(k)]
            if len(fl) < 3:
                line += f"  {nm}: n/a"
                continue
            f = np.array([x["flux"] for x in fl]); e = np.array([x["err_scaled"] for x in fl])
            mu, se = M.wmean(f, e)
            chi2 = float(np.sum(((f - mu) / e) ** 2))
            cons[(d, k)] = (mu, se, chi2)
            line += f"  {nm}: mean {mu:+.4f} +/- {se:.4f} mJy, chi2 {chi2:.1f}"
        say(line)
    R["per_visit"] = {f"D{d}_v{v}": {k: (None if r is None else dict(
        flux=metric(r["flux"], "mJy (aperture)", r["n"], SCRIPT, f"error {r['err']:.5f}; chi2r {r['chi2r']:.2f}"),
        upper_limit_ab=metric(r["lim_ab"], "AB mag (flux + 3 sigma)", r["n"], SCRIPT))) for k, r in rec.items()} for (d, v), rec in stats.items()}
    # D6 versus the expected W2-band flux
    ab_w2 = 14.02 + 3.339
    f_w2 = AB_ZERO_JY * 1e3 * 10 ** (-0.4 * ab_w2)
    say(f"Expected: WISE W2 = 14.02 +/- 0.05 Vega (Luhman & Esplin 2016) + 3.339 (AB offset) = {ab_w2:.2f} AB = {f_w2:.3f} mJy; [4.5] 13.87 +/- 0.08 (Luhman et al. 2024). "
        f"Essentially undetectable below 3 um.")
    R["expected_w2"] = metric(ab_w2, "AB mag", None, SCRIPT, f"{f_w2:.3f} mJy; Luhman & Esplin 2016 W2 14.02 Vega + 3.339 (IRSA WISE explanatory supplement)")
    for d in (6, 3):
        ms = [stats[(d, v)]["mov"] for v in sorted(set(visit)) if stats.get((d, v), {}).get("mov")]
        if ms:
            f = np.array([x["flux"] for x in ms]); e = np.array([x["err_scaled"] for x in ms])
            mu, se = M.wmean(f, e)
            say(f"   D{d} moving-position flux over all visits: {mu:+.4f} +/- {se:.4f} mJy (median lambda {np.median([x['lam'] for x in ms]):.2f} um); 3 sigma limit {float(ab_mag_from_mjy(mu + 3 * se)):.2f} AB "
                f"vs expected {f_w2:.3f} mJy ({ab_w2:.2f} AB)")
            R[f"D{d}_all_visits_moving"] = dict(flux=metric(mu, "mJy (aperture)", int(sum(x['n'] for x in ms)), SCRIPT, f"error {se:.5f}"),
                                               limit_ab=metric(float(ab_mag_from_mjy(mu + 3 * se)), "AB mag (3 sigma)", int(sum(x['n'] for x in ms)), SCRIPT))
    # ---- stacks: centroid test for the D2 source and picture
    say("Stacks (bilinear-shifted, inverse-variance mean, in-stack exposures) and the position of any D2 / D6 source:")
    frames_cache = {}
    def get_frames(d, v):
        key = (d, v)
        if key not in frames_cache:
            fl, pm, pf = [], [], []
            for i in np.where((np.asarray(T["det"]) == d) & (np.asarray(T["visit"]) == v) & np.asarray(T["in_stack"], bool))[0]:
                fr = m2ref.load_cutout(DATA.parent / rows[int(T["row"][i])]["cutout_path"])
                fl.append(fr)
                pm.append((float(T["mov_x"][i]), float(T["mov_y"][i])))
                pf.append((float(T["f26_x"][i]), float(T["f26_y"][i])))
            frames_cache[key] = (fl, pm, pf)
        return frames_cache[key]
    stacks = {}
    cen = {}
    for d in (2, 6):
        for v in sorted(set(visit)):
            fl, pm, pf = get_frames(d, v)
            for kind, pos in (("mov", pm), ("f26", pf)):
                mean, var, n = stack_shifted(fl, pos, half=10)
                stacks[(d, v, kind)] = (mean, var, n)
                if mean is None:
                    continue
                fr0 = dict(R=np.pad(mean, 10, mode="constant"), V=np.pad(var, 10, mode="edge"), FL=np.zeros((mean.shape[0] + 20,) * 2, np.int64),
                           bits={}, rmask=0, fwhm_as=m2ref.PIXEL_ARCSEC * 1.2)
                c = M.centroid_gauss(fr0, 10 + 10, 10 + 10, fwhm_px=1.2, bkg_override=0.0)
                cen[(d, v, kind)] = dict(c, n=n)
                if c["ok"]:
                    say(f"   D{d} visit {v} stack aligned on {'moving' if kind == 'mov' else 'fixed 2026.0'} position (n={n}): Gaussian peak at ({c['x'] - 20:+.2f}, {c['y'] - 20:+.2f}) +/- ({c['ex']:.2f}, {c['ey']:.2f}) px from the aligned position, "
                        f"flux {c['flux'] * MJY_SR_PX_TO_MJY:+.3f} +/- {c['eflux'] * MJY_SR_PX_TO_MJY:.3f} mJy")
    # source displacement test on D2: fixed-aligned centroid should stay put; moving-aligned should drift
    for d in (2, 6):
        for kind, nm in (("f26", "fixed"), ("mov", "moving")):
            pts = [(v, cen[(d, v, kind)]) for v in sorted(set(visit)) if (d, v, kind) in cen and cen[(d, v, kind)]["ok"]]
            if len(pts) >= 2:
                xs = np.array([p[1]["x"] - 20 for p in pts]); ys = np.array([p[1]["y"] - 20 for p in pts])
                exs = np.array([p[1]["ex"] for p in pts])
                R[f"D{d}_{kind}_stack_centroids_px"] = metric([[float(a), float(b)] for a, b in zip(xs, ys)], "px (x, y) from aligned position, per visit", len(pts), SCRIPT,
                                                              f"errors x {', '.join(f'{e:.2f}' for e in exs)}")
    R["download_bytes"] = metric(int(nbytes), "bytes", None, SCRIPT, "cutouts and headers fetched in this run (0 when cached)")

    # ---- figures
    fig, axs = plt.subplots(2, 3, figsize=(14, 7.5), sharex=False)
    vcol = {0: "#1f77b4", 1: "#d95f02", 2: "#1b9e77"}
    for ai, d in enumerate(range(1, 7)):
        ax = axs.flat[ai]
        for k, c, nm, off in (("mov", "#c0392b", "moving position", -0.12), ("f26", "#2c3e50", "fixed 2026.0", 0.0), ("f1", "#7f8c8d", "fixed first visit", 0.12)):
            for v in sorted(set(visit)):
                r = stats.get((d, v), {}).get(k)
                if r is None:
                    continue
                ax.errorbar(v + off, r["flux"], yerr=r["err_scaled"], fmt="o", color=c, ms=5, label=nm if v == min(visit) else None)
                ax.plot(v + off, r["flux"] + 3 * r["err_scaled"], "v", color=c, ms=4, mfc="none")
        if d == 6:
            ax.axhline(f_w2, color="g", ls="--", lw=1, label=f"expected W2-like {f_w2:.2f} mJy ({ab_w2:.1f} AB)")
        ax.axhline(0, c="k", lw=0.4)
        ax.set_title(f"D{d} (about {np.nanmedian([r['mov']['lam'] for (dd, vv), r in stats.items() if dd == d and r['mov']]):.1f} um)" if any(r["mov"] for (dd, vv), r in stats.items() if dd == d) else f"D{d}")
        ax.set_xticks(sorted(set(visit))); ax.set_xlabel("visit"); ax.set_ylabel("aperture flux [mJy]")
        if ai in (0, 5):
            ax.legend(fontsize=7)
    fig.suptitle("WISE 0855-0714: forced photometry per visit; filled = mean +/- error, open triangle = flux + 3 sigma", fontsize=10)
    fig.tight_layout()
    fig.savefig(FIGURES / "wise0855_photometry.png", dpi=130)
    plt.close(fig)

    fig, axs = plt.subplots(4, 3, figsize=(10.5, 13))
    for ci, v in enumerate(sorted(set(visit))):
        for ri, (d, kind) in enumerate(((2, "mov"), (2, "f26"), (6, "mov"), (6, "f26"))):
            ax = axs[ri, ci]
            mean, var, n = stacks.get((d, v, kind), (None, None, 0))
            if mean is None:
                ax.axis("off")
                continue
            sig = np.sqrt(np.median(var))
            ax.imshow(mean * MJY_SR_PX_TO_MJY, origin="lower", cmap="gray", vmin=-3 * sig * MJY_SR_PX_TO_MJY, vmax=max(8 * sig, 3 * sig) * MJY_SR_PX_TO_MJY,
                      extent=(-10.5, 10.5, -10.5, 10.5))
            # predicted positions in this stack's frame: moving position and fixed 2026.0
            fl, pm, pf = get_frames(d, v)
            if kind == "mov":
                tx = np.mean([f[0] - m[0] for f, m in zip(pf, pm)]); ty = np.mean([f[1] - m[1] for f, m in zip(pf, pm)])
                ax.plot(0, 0, "o", mfc="none", mec="#e74c3c", ms=14, label="moving")
                ax.plot(tx, ty, "s", mfc="none", mec="#3498db", ms=14, label="fixed 2026.0")
            else:
                tx = np.mean([m[0] - f[0] for f, m in zip(pf, pm)]); ty = np.mean([m[1] - f[1] for f, m in zip(pf, pm)])
                ax.plot(0, 0, "s", mfc="none", mec="#3498db", ms=14)
                ax.plot(tx, ty, "o", mfc="none", mec="#e74c3c", ms=14)
            ax.set_title(f"D{d} v{v} aligned on {'moving' if kind == 'mov' else 'fixed 2026.0'} (n={n})", fontsize=8)
            ax.set_xticks([]); ax.set_yticks([])
    axs[0, 0].legend(fontsize=7, loc="upper right")
    fig.suptitle("WISE 0855 stacks (21x21 px, 6.15\"/px): red circle = predicted moving position, blue square = fixed 2026.0", fontsize=9)
    fig.tight_layout()
    fig.savefig(FIGURES / "wise0855_stamps.png", dpi=120)
    plt.close(fig)
    return R

if __name__ == "__main__":
    main()
