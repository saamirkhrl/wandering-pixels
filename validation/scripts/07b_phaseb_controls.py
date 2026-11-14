"""07b: phase B controls: (1) gap dependence over the full range, (2) fair-averaging control P1avg,
(3) why are the forced-photometry errors too small.

usage: uv run python scripts/07b_phaseb_controls.py --field {barnard,epsindi,all} [--recompute] [--nboot N]
Inputs : data/phaseb/<field>/{forced_phot,fluxes_M2,fluxes_P1native,fluxes_M2flat,fluxes_M2unmatched}.ecsv
Caches : data/phaseb/<field>/controls_allpairs.npz, controls_p1avg.ecsv
Outputs: docs/figures/phaseb_{gap_full,controls,errors}_<field>.png, results section phaseb_controls_<field>.

Definitions (docs/method.md item 8): z = (F_A-F_B)/sqrt(var_A+var_B), width = 1.4826 MAD(z);
f = (F_A-F_B)/(0.5(F_A+F_B)), scatter = 1.4826 MAD(f) in percent. All bootstraps resample STARS.
"""
import argparse
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.table import Table
import astropy.units as u

from wp import phaseb
from wp.config import DATA, FIGURES
from wp.gaia import gaia_path
from wp.metrics import BOOT_SEED, frac_values, mad_sigma, z_values
from wp.results import metric, update_results

SCRIPT = "07b_phaseb_controls.py"
GAP_EDGES = np.array([0, 0.5, 1, 2, 4, 7, 10, np.inf])
GAP_LAB = ["0-0.5", "0.5-1", "1-2", "2-4", "4-7", "7-10", ">10"]
WIN = phaseb.WINDOW_BW


# ------------------------------------------------------------------ helpers
def fmt(x, d=3):
    return "nan" if not np.isfinite(x) else f"{x:.{d}f}"


def width_scatter(F_A, F_B, vA, vB):
    z = z_values(F_A, F_B, vA, vB)
    f = frac_values(F_A, F_B)
    return mad_sigma(z), 100 * mad_sigma(f)


def boot_counts(nstars, nboot, seed=BOOT_SEED):
    rng = np.random.default_rng(seed)
    return rng.multinomial(nstars, np.full(nstars, 1.0 / nstars), size=nboot)


def boot_ws(z, f, sidx, C):
    """Bootstrap (over stars, multiplicity matrix C) of width of z and scatter of f. Returns (nboot,2)."""
    out = np.empty((C.shape[0], 2))
    for b in range(C.shape[0]):
        m = C[b][sidx]
        out[b, 0] = mad_sigma(np.repeat(z, m))
        out[b, 1] = 100 * mad_sigma(np.repeat(f, m))
    return out


def sig_str(d, e):
    if not np.isfinite(e) or e <= 0:
        return "n/a"
    s = abs(d) / e
    return f"{s:.1f} sigma" + (" SIGNIFICANT" if s > 2 else " (not significant)")


def load_field(field):
    d = phaseb.PHASEB / field
    phot = Table.read(d / "forced_phot.ecsv")
    ok = phot[np.asarray(phot["ok"], bool)]
    gaia = Table.read(gaia_path(field))
    info = {int(s): (float(g), float(c)) for s, g, c in zip(gaia["source_id"], gaia["phot_g_mean_mag"], gaia["bp_rp"])}
    sids = np.unique(np.asarray(ok["source_id"], np.int64))
    col = {int(s): i for i, s in enumerate(sids)}
    exps = np.unique(np.asarray(ok["obs_id"]).astype(str) + "_D" + np.asarray(ok["detector"]).astype(str))
    expid = {f: i for i, f in enumerate(exps)}
    frame = np.asarray(ok["obs_id"]).astype(str) + "_D" + np.asarray(ok["detector"]).astype(str)
    return d, ok, gaia, info, sids, col, exps, expid, frame


# ------------------------------------------------------------------ 1. all pairs
def build_allpairs(field, ok, sids, col, expid, frame, info):
    P = phaseb.VISIT_PAIRS[field]
    vis = np.asarray(ok["visit"], int)
    det = np.asarray(ok["detector"], int)
    sid = np.asarray(ok["source_id"], np.int64)
    lam, bw = np.asarray(ok["lam"], float), np.asarray(ok["bw"], float)
    fl, vr = np.asarray(ok["flux"], float), np.asarray(ok["var"], float)
    fid = np.array([expid[f] for f in frame])
    # index rows by (visit, det, star)
    idx = defaultdict(list)
    for i in range(len(ok)):
        idx[(vis[i], det[i], sid[i])].append(i)
    cols = defaultdict(list)

    def add(kind, pi, d, s, ia, ib):
        ia, ib = np.repeat(ia, len(ib)), np.tile(ib, len(ia) // 1 if False else 1)
        return ia, ib

    def run(kind, pi, a, b):
        for d in range(1, 7):
            for s in sids:
                ia = np.array(idx.get((a, d, s), []), int)
                ib = np.array(idx.get((b, d, s), []), int)
                if not len(ia) or not len(ib):
                    continue
                A = np.repeat(ia, len(ib))
                B = np.tile(ib, len(ia))
                if a == b:
                    keep = A < B
                    A, B = A[keep], B[keep]
                    if not len(A):
                        continue
                n = len(A)
                for nm, v in (("kind", kind), ("pair", pi), ("det", d), ("star", col[int(s)])):
                    cols[nm].append(np.full(n, v, np.int32))
                cols["expA"].append(fid[A].astype(np.int32))
                cols["expB"].append(fid[B].astype(np.int32))
                for nm, arr in (("lamA", lam), ("lamB", lam), ("bwA", bw), ("bwB", bw), ("FA", fl), ("FB", fl),
                                ("vA", vr), ("vB", vr)):
                    cols[nm].append(arr[A if nm.endswith("A") else B])
                cols["G"].append(np.full(n, info[int(s)][0]))
                cols["bprp"].append(np.full(n, info[int(s)][1]))

    for pi, (a, b, cls) in enumerate(P):
        run(0, pi, a, b)
    for v in sorted({v for a, b, _ in P for v in (a, b)}):
        run(1, -1, v, v)    # within-visit pairs (kind 1)
    out = {k: np.concatenate(v) for k, v in cols.items()}
    out["gap"] = np.abs(out["lamA"] - out["lamB"]) / (0.5 * (out["bwA"] + out["bwB"]))
    return out


def slope_through(x, y):
    m = np.isfinite(y)
    if m.sum() < 3:
        return np.nan
    return float(np.polyfit(x[m], y[m], 1)[0])


def gap_analysis(field, AP, M2one, sids, col, expid, C, res, log):
    """M2one: dict of arrays for M2 'one' prereg comparisons incl. key arrays."""
    ns = len(sids)
    k0 = AP["kind"] == 0
    gap = AP["gap"][k0]
    bins = np.digitize(gap, GAP_EDGES[1:-1])
    z = z_values(AP["FA"][k0], AP["FB"][k0], AP["vA"][k0], AP["vB"][k0])
    f = frac_values(AP["FA"][k0], AP["FB"][k0])
    sidx = AP["star"][k0]
    pair, det, expA = AP["pair"][k0], AP["det"][k0], AP["expA"][k0]
    nexp = len(expid)
    key = ((pair.astype(np.int64) * 7 + det) * ns + sidx) * nexp + expA
    Mkey = M2one["key"]
    rows = []
    xs = np.full(len(GAP_LAB), np.nan)
    pl = np.full((len(GAP_LAB), 2), np.nan)
    m2 = np.full((len(GAP_LAB), 2), np.nan)
    pl_b = np.full((C.shape[0], len(GAP_LAB), 2), np.nan)
    m2_b = np.full((C.shape[0], len(GAP_LAB), 2), np.nan)
    npl = np.zeros(len(GAP_LAB), int)
    nm2 = np.zeros(len(GAP_LAB), int)
    spl = np.zeros(len(GAP_LAB), int)
    sm2 = np.zeros(len(GAP_LAB), int)
    for b in range(len(GAP_LAB)):
        mb = bins == b
        npl[b] = mb.sum()
        if npl[b] < 30:
            continue
        spl[b] = np.unique(sidx[mb]).size
        xs[b] = np.median(gap[mb])
        pl[b] = width_scatter(AP["FA"][k0][mb], AP["FB"][k0][mb], AP["vA"][k0][mb], AP["vB"][k0][mb])
        pl_b[:, b] = boot_ws(z[mb], f[mb], sidx[mb], C)
        mm = np.isin(Mkey, np.unique(key[mb]))
        nm2[b] = mm.sum()
        if nm2[b] >= 30:
            sm2[b] = np.unique(M2one["star"][mm]).size
            m2[b] = width_scatter(M2one["F_A"][mm], M2one["F_B"][mm], M2one["var_A"][mm], M2one["var_B"][mm])
            m2_b[:, b] = boot_ws(M2one["z"][mm], M2one["f"][mm], M2one["star"][mm], C)
    # within-visit pairs (noise-only diagnostic)
    kw = AP["kind"] == 1
    gw = AP["gap"][kw]
    bw_bins = np.digitize(gw, GAP_EDGES[1:-1])
    zw = z_values(AP["FA"][kw], AP["FB"][kw], AP["vA"][kw], AP["vB"][kw])
    within = np.full((len(GAP_LAB), 2), np.nan)
    nwith = np.zeros(len(GAP_LAB), int)
    for b in range(len(GAP_LAB)):
        mb = bw_bins == b
        nwith[b] = mb.sum()
        if nwith[b] >= 30:
            within[b] = width_scatter(AP["FA"][kw][mb], AP["FB"][kw][mb], AP["vA"][kw][mb], AP["vB"][kw][mb])
    # slopes (per channel of gap) of z width and f scatter vs bin x
    sl = {}
    for nm, arr, ab in (("plain", pl, pl_b), ("M2", m2, m2_b)):
        for j, q in enumerate(("width", "scatter")):
            s0 = slope_through(xs, arr[:, j])
            sb = np.array([slope_through(xs, ab[i, :, j]) for i in range(C.shape[0])])
            sl[(nm, q)] = (s0, float(np.nanstd(sb, ddof=1)), sb)
    for j, q in enumerate(("width", "scatter")):
        sd = sl[("plain", q)][2] - sl[("M2", q)][2]
        sl[("diff", q)] = (sl[("plain", q)][0] - sl[("M2", q)][0], float(np.nanstd(sd, ddof=1)), sd)
    lines = [f"[{field}] GAP DEPENDENCE (plain all-pairs vs M2 'one', prereg). Construction: plain = every same-detector",
             "  (A exposure, B exposure) pair of each visit pair, gap=|lamA-lamB|/mean(bwA,bwB). M2 = the M2(one) comparison",
             "  at w0=lam(A exposure i) for every (pair,det,star,i) that has >=1 plain pair in the bin (unique M2 values; the",
             "  same M2 value can appear in several bins). x = median plain gap in the bin; slopes by OLS over bins; err = bootstrap over stars.",
             f"  {'gap bin':>8} {'x':>5} | {'N plain':>8} {'stars':>5} {'z width':>8} {'f scat%':>8} | {'N M2':>6} {'stars':>5} {'z width':>8} {'f scat%':>8}"
             f" | {'within-visit N':>14} {'z width':>8}"]
    for b in range(len(GAP_LAB)):
        lines.append(f"  {GAP_LAB[b]:>8} {fmt(xs[b], 2):>5} | {npl[b]:8d} {spl[b]:5d} {fmt(pl[b, 0]):>8} {fmt(pl[b, 1], 2):>8} | "
                     f"{nm2[b]:6d} {sm2[b]:5d} {fmt(m2[b, 0]):>8} {fmt(m2[b, 1], 2):>8} | {nwith[b]:14d} {fmt(within[b, 0]):>8}")
    for q in ("width", "scatter"):
        for nm in ("plain", "M2", "diff"):
            s0, e, _ = sl[(nm, q)]
            lines.append(f"  slope of {q:7s} vs gap [{nm:5s}] = {s0:+.4f} +/- {e:.4f} per channel  -> {sig_str(s0, e)}")
    s0, e, _ = sl[("plain", "width")]
    s1, e1, _ = sl[("M2", "width")]
    claim = ("SUPPORTED" if (s0 / e > 2 and abs(s1 / e1) < 2) else
             "PARTLY: plain degrades but M2 also trends" if (s0 / e > 2) else "NOT SUPPORTED by z width")
    lines.append(f"  Claim 'plain pair degrades with gap, matched does not': {claim} (z width slopes: plain {s0/e:+.1f} sigma, M2 {s1/e1:+.1f} sigma)")
    for l in lines:
        log(l)
    # results
    for b in range(len(GAP_LAB)):
        tag = GAP_LAB[b].replace(">", "gt")
        res[f"gap_plain_width_{tag}"] = metric(None if not np.isfinite(pl[b, 0]) else float(pl[b, 0]), "sigma", int(npl[b]), SCRIPT,
                                               f"plain all-pairs z width, gap {GAP_LAB[b]} ch; n_stars={int(spl[b])}")
        res[f"gap_plain_scatter_{tag}"] = metric(None if not np.isfinite(pl[b, 1]) else float(pl[b, 1]), "percent", int(npl[b]), SCRIPT,
                                                 f"plain all-pairs fractional scatter, gap {GAP_LAB[b]} ch; n_stars={int(spl[b])}")
        res[f"gap_m2_width_{tag}"] = metric(None if not np.isfinite(m2[b, 0]) else float(m2[b, 0]), "sigma", int(nm2[b]), SCRIPT,
                                            f"M2(one) z width for the comparisons replacing plain pairs in gap {GAP_LAB[b]}; n_stars={int(sm2[b])}")
        res[f"gap_m2_scatter_{tag}"] = metric(None if not np.isfinite(m2[b, 1]) else float(m2[b, 1]), "percent", int(nm2[b]), SCRIPT,
                                              f"M2(one) fractional scatter, gap {GAP_LAB[b]}")
        res[f"gap_withinvisit_width_{tag}"] = metric(None if not np.isfinite(within[b, 0]) else float(within[b, 0]), "sigma", int(nwith[b]), SCRIPT,
                                                     f"within-visit same-detector pairs z width, gap {GAP_LAB[b]}")
    for q in ("width", "scatter"):
        for nm in ("plain", "M2", "diff"):
            s0, e, _ = sl[(nm, q)]
            res[f"gap_slope_{q}_{nm}"] = metric(float(s0), "sigma_per_channel" if q == "width" else "percent_per_channel", None, SCRIPT,
                                                f"OLS slope vs gap-bin x; bootstrap err {e:.4f}; {sig_str(s0, e)}")
    res["gap_claim_verdict"] = metric(claim, "text", None, SCRIPT, "plain degrades with gap / matched does not")
    # figure
    fig, ax = plt.subplots(1, 2, figsize=(11, 4.2))
    xp = np.arange(len(GAP_LAB))
    for j, (a, nm) in enumerate(zip(ax, ("z width (robust sigma)", "fractional scatter (%)"))):
        for arr, ab, lab, c, off in ((pl, pl_b, "plain all-pairs (P1native-style)", "tab:red", -0.08),
                                     (m2, m2_b, "M2 (one) matched", "tab:blue", 0.08)):
            e = np.nanstd(ab[:, :, j], axis=0, ddof=1)
            a.errorbar(xp + off, arr[:, j], e, fmt="o-", color=c, label=lab, capsize=2)
        if j == 0:
            a.plot(xp, within[:, 0], "s--", color="gray", ms=4, label="within-visit pairs (no epoch change)")
            a.axhline(1, color="k", lw=0.6, ls=":")
        a.set_xticks(xp)
        a.set_xticklabels([f"{l}\nN={npl[i]}/{nm2[i]}" for i, l in enumerate(GAP_LAB)], fontsize=7)
        a.set_xlabel("wavelength gap (channels)   N plain / N M2")
        a.set_ylabel(nm)
        a.set_title(f"{field}: {nm.split(' (')[0]} vs gap")
        a.grid(alpha=0.3)
    ax[0].legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(FIGURES / f"phaseb_gap_full_{field}.png", dpi=130)
    plt.close(fig)


# ------------------------------------------------------------------ 2. P1avg
def build_p1avg(field, d, ok, M2one_t, p1n_t, unm_t, col, frame, recompute):
    cache = d / "controls_p1avg.ecsv"
    if cache.exists() and not recompute:
        return Table.read(cache)
    sid = np.asarray(ok["source_id"], np.int64)
    vis = np.asarray(ok["visit"], int)
    det = np.asarray(ok["detector"], int)
    lam, fl, vr = np.asarray(ok["lam"], float), np.asarray(ok["flux"], float), np.asarray(ok["var"], float)
    meas = {}   # (frame, sid) -> (lam, flux, var)
    byvsd = defaultdict(list)
    for i in range(len(ok)):
        meas[(frame[i], int(sid[i]))] = (lam[i], fl[i], vr[i])
        byvsd[(int(vis[i]), int(det[i]), int(sid[i]))].append((frame[i], lam[i], fl[i], vr[i]))
    # partner mapping (visitA, visitB, det, frame_A) -> frame_B (same field-centre-nearest rule as P1native)
    pmap = {}
    for t in (p1n_t, unm_t):
        for a, b, dd, fa, fb in zip(t["visitA"], t["visitB"], t["detector"], t["frame_A"], t["frame_B"]):
            pmap[(int(a), int(b), int(dd), str(fa))] = str(fb)
    rows = []
    for r in M2one_t:
        A, B, dd, s = int(r["visitA"]), int(r["visitB"]), int(r["detector"]), int(r["source_id"])
        w0, b0 = float(r["lam_eval"]), float(r["bw_eval"])
        dk, wk, vk, vj, jk = [], [], [], [], []
        for (fr, l, f, v) in byvsd.get((A, dd, s), []):
            if abs(l - w0) > WIN * b0 or not (v > 0):
                continue
            fj = pmap.get((A, B, dd, fr))
            if fj is None or (fj, s) not in meas:
                continue
            _, fbv, vbv = meas[(fj, s)]
            dk.append(f - fbv)
            vk.append(v)
            vj.append(vbv)
            jk.append(fj)
        if not dk:
            continue
        dk, vk, vj = np.array(dk), np.array(vk), np.array(vj)
        w = 1.0 / (vk + vj)
        W = w.sum()
        mean = float((w * dk).sum() / W)
        var_naive = float(1.0 / W)
        grp = defaultdict(float)
        vjj = {}
        for q, fj in enumerate(jk):
            grp[fj] += w[q]
            vjj[fj] = vj[q]
        var_prop = float(((w ** 2 * vk).sum() + sum(vjj[fj] * g ** 2 for fj, g in grp.items())) / W ** 2)
        # represent as F_A = mean, F_B = 0 (difference product); fractional diff needs a mean flux
        FAm = float(np.mean([meas[(fr, s)][1] for (fr, l, f, v) in byvsd[(A, dd, s)] if abs(l - w0) <= WIN * b0 and v > 0]))
        rows.append((A, B, dd, s, str(r["frame_A"]), len(dk), mean, var_prop, var_naive, FAm))
    t = Table(rows=rows, names=["visitA", "visitB", "detector", "source_id", "frame_A", "n_k", "diff", "var_prop",
                                "var_naive", "FA_mean"])
    t.write(cache, overwrite=True)
    return t


def controls_analysis(field, d, ok, sids, col, C, res, log, recompute):
    def rd(nm):
        t = Table.read(d / f"fluxes_{nm}.ecsv")
        m = np.array([str(x) == "prereg" for x in t["mask"]])
        return t[m]
    M2 = rd("M2")
    M2one_t = M2[np.array([str(x) == "one" for x in M2["mode"]])]
    P1 = rd("P1native")
    FL = rd("M2flat")
    FL = FL[np.array([str(x) == "one" for x in FL["mode"]])]
    UN = rd("M2unmatched")
    UN = UN[np.array([str(x) == "one" for x in UN["mode"]])]
    frame = np.asarray(ok["obs_id"]).astype(str) + "_D" + np.asarray(ok["detector"]).astype(str)
    PA = build_p1avg(field, d, ok, M2one_t, P1, UN, col, frame, recompute)

    def key(t, fa="frame_A"):
        return [(int(a), int(b), int(dd), int(s), str(f)) for a, b, dd, s, f in
                zip(t["visitA"], t["visitB"], t["detector"], t["source_id"], t[fa])]

    kM, kP, kF, kU, kA = key(M2one_t), key(P1), key(FL), key(UN), key(PA)
    common = set(kM) & set(kP) & set(kF) & set(kU) & set(kA)
    log(f"[{field}] CONTROLS: comparison sets M2one={len(kM)} P1native={len(kP)} M2flat={len(kF)} M2unm={len(kU)} "
        f"P1avg={len(kA)}; intersection (star,pair,det,A exposure) = {len(common)}")
    comp = sorted(common)
    order = {k: i for i, k in enumerate(comp)}
    n = len(comp)
    prods = {}

    def fill(t, kk, fa_col="F_A", fb_col="F_B", va="var_A", vb="var_B"):
        A = np.full(n, np.nan), np.full(n, np.nan), np.full(n, np.nan), np.full(n, np.nan)
        for i, k in enumerate(kk):
            if k in order:
                j = order[k]
                A[0][j], A[1][j], A[2][j], A[3][j] = t[fa_col][i], t[fb_col][i], t[va][i], t[vb][i]
        return A
    for nm, t, kk in (("P1native", P1, kP), ("M2flat", FL, kF), ("M2unmatched", UN, kU), ("M2", M2one_t, kM)):
        prods[nm] = fill(t, kk)
    # P1avg (proper covariance) and naive variant: F_A = mean plain flux of A, F_B = F_A - diff
    for nm, vc in (("P1avg", "var_prop"), ("P1avg_naive", "var_naive")):
        FA, FB, VA, VB = (np.full(n, np.nan) for _ in range(4))
        for i, k in enumerate(kA):
            if k in order:
                j = order[k]
                FA[j] = PA["FA_mean"][i]
                FB[j] = PA["FA_mean"][i] - PA["diff"][i]
                VA[j] = PA[vc][i]
                VB[j] = 0.0
        prods[nm] = (FA, FB, VA, VB)
    star = np.array([col[k[3]] for k in comp])
    Z = {p: z_values(*[v for v in (a[0], a[1], a[2], a[3])]) for p, a in prods.items()}
    Fr = {p: frac_values(a[0], a[1]) for p, a in prods.items()}
    names = ["P1native", "P1avg", "M2flat", "M2unmatched", "M2"]
    allnames = names + ["P1avg_naive"]
    base = {p: (mad_sigma(Z[p]), 100 * mad_sigma(Fr[p])) for p in allnames}
    bt = {p: boot_ws(Z[p], Fr[p], star, C) for p in allnames}
    nst = np.unique(star).size
    lines = [f"[{field}] CONTROLS on the identical set: N comparisons={n}, N stars={nst}, bootstrap over stars x{C.shape[0]}",
             f"  {'product':12s} {'z width':>8} {'+/-':>6} | {'f scat %':>8} {'+/-':>6}   | M2 minus product: dwidth (sig)  dscatter% (sig)"]
    for p in allnames:
        e = np.std(bt[p], axis=0, ddof=1)
        if p == "M2":
            ds = ""
        else:
            dw = bt["M2"][:, 0] - bt[p][:, 0]
            dsc = bt["M2"][:, 1] - bt[p][:, 1]
            d0w, d0s = base["M2"][0] - base[p][0], base["M2"][1] - base[p][1]
            ds = f"{d0w:+.3f} ({sig_str(d0w, dw.std(ddof=1))})   {d0s:+.2f} ({sig_str(d0s, dsc.std(ddof=1))})"
            res[f"diff_M2_minus_{p}_width"] = metric(float(d0w), "sigma", n, SCRIPT, f"bootstrap err {dw.std(ddof=1):.4f}; {sig_str(d0w, dw.std(ddof=1))}")
            res[f"diff_M2_minus_{p}_scatter"] = metric(float(d0s), "percent", n, SCRIPT, f"bootstrap err {dsc.std(ddof=1):.3f}; {sig_str(d0s, dsc.std(ddof=1))}")
        lines.append(f"  {p:12s} {base[p][0]:8.3f} {e[0]:6.3f} | {base[p][1]:8.2f} {e[1]:6.2f}   | {ds}")
        res[f"ctrl_{p}_width"] = metric(float(base[p][0]), "sigma", n, SCRIPT, f"z width; bootstrap err {e[0]:.4f}; n_stars={nst}")
        res[f"ctrl_{p}_scatter"] = metric(float(base[p][1]), "percent", n, SCRIPT, f"fractional scatter; bootstrap err {e[1]:.3f}; n_stars={nst}")
    # fraction of the improvement P1native -> M2 reproduced by P1avg
    for j, q in enumerate(("width", "scatter")):
        tot = base["P1native"][j] - base["M2"][j]
        avg = base["P1native"][j] - base["P1avg"][j]
        frac = avg / tot if tot != 0 else np.nan
        bt_tot = bt["P1native"][:, j] - bt["M2"][:, j]
        bt_avg = bt["P1native"][:, j] - bt["P1avg"][:, j]
        with np.errstate(invalid="ignore", divide="ignore"):
            bf = bt_avg / bt_tot
        e = float(np.nanstd(bf, ddof=1))
        lines.append(f"  improvement P1native->M2 in {q}: total {tot:+.3f}; reproduced by P1avg (more data, no matching) "
                     f"{avg:+.3f} = {100*frac:.0f}% +/- {100*e:.0f}%; remaining (matching) {100*(1-frac):.0f}%")
        res[f"improvement_{q}_total"] = metric(float(tot), "sigma" if q == "width" else "percent", n, SCRIPT, "P1native minus M2")
        res[f"improvement_{q}_frac_by_P1avg"] = metric(float(frac), "fraction", n, SCRIPT, f"bootstrap err {e:.3f}; P1avg = more data, no matching")
    for l in lines:
        log(l)
    # figure
    fig, ax = plt.subplots(1, 2, figsize=(10, 4))
    xp = np.arange(len(names))
    cols = ["tab:red", "tab:orange", "tab:olive", "tab:purple", "tab:blue"]
    for j, (a, ttl) in enumerate(zip(ax, ("z width (robust sigma)", "fractional scatter (%)"))):
        v = [base[p][j] for p in names]
        e = [np.std(bt[p][:, j], ddof=1) for p in names]
        a.bar(xp, v, yerr=e, color=cols, capsize=3)
        for i, (vv, ee) in enumerate(zip(v, e)):
            a.text(i, vv + ee, f"{vv:.2f}", ha="center", va="bottom", fontsize=8)
        a.set_xticks(xp)
        a.set_xticklabels(names, rotation=20, fontsize=8)
        a.set_ylabel(ttl)
        a.set_title(f"{field}: {ttl.split(' (')[0]}, N={n}, {nst} stars")
        a.grid(alpha=0.3, axis="y")
    ax[0].axhline(1, color="k", lw=0.6, ls=":")
    fig.tight_layout()
    fig.savefig(FIGURES / f"phaseb_controls_{field}.png", dpi=130)
    plt.close(fig)
    return M2one_t


# ------------------------------------------------------------------ 3. errors
def pad(lam, flux, var, bw, rid, c, ns):
    order = np.argsort(c, kind="stable")
    cc = c[order]
    cnt = np.bincount(cc, minlength=ns)
    nmax = max(1, cnt.max())
    start = np.concatenate([[0], np.cumsum(cnt)[:-1]])
    pos = np.arange(len(cc)) - start[cc]
    out = []
    for arr, fill, dt in ((lam, np.nan, float), (flux, np.nan, float), (var, np.nan, float), (bw, np.nan, float), (rid, -1, int)):
        a = np.full((nmax, ns), fill, dt)
        a[pos, cc] = arr[order]
        out.append(a)
    return out


def loo_resid(ok, col, ns, mode, bfrac=0.0):
    """Leave-one-out residuals about spec_model. Returns (resid, var_model, var_used) arrays over rows of ok (nan if none)."""
    N = len(ok)
    lam, flux, var, bw = (np.asarray(ok[k], float) for k in ("lam", "flux", "var", "bw"))
    vu = var + (bfrac * flux) ** 2
    vis, det = np.asarray(ok["visit"], int), np.asarray(ok["detector"], int)
    c = np.array([col[int(s)] for s in ok["source_id"]])
    res, vm = np.full(N, np.nan), np.full(N, np.nan)
    groups = [(vis == v) for v in np.unique(vis)] if mode == "six" else \
        [(vis == v) & (det == dd) for v in np.unique(vis) for dd in range(1, 7)]
    rows = np.arange(N)
    for g in groups:
        if not g.any():
            continue
        L, Fx, V, Bw, R = pad(lam[g], flux[g], vu[g], bw[g], rows[g], c[g], ns)
        for k in range(L.shape[0]):
            l2, f2, v2 = L.copy(), Fx.copy(), V.copy()
            l2[k], f2[k], v2[k] = np.nan, np.nan, np.nan
            with np.errstate(all="ignore"):
                M, VM, _ = phaseb.spec_model(l2, f2, v2, L[k], Bw[k])
            good = np.isfinite(M) & np.isfinite(Fx[k]) & (R[k] >= 0)
            res[R[k][good]] = Fx[k][good] - M[good]
            vm[R[k][good]] = VM[good]
    return res, vm, vu


def zres(res, vm, vu):
    with np.errstate(all="ignore"):
        return res / np.sqrt(vu + vm)


def binstat(z, bins, nmin=30):
    out = []
    for b in np.unique(bins):
        m = (bins == b) & np.isfinite(z)
        out.append((b, int(m.sum()), mad_sigma(z[m]) if m.sum() >= nmin else np.nan))
    return out


def solve_width1(bs, ws):
    """b where width(b)=1 by linear interpolation on the grid (0 if already <=1)."""
    ws = np.asarray(ws)
    if ws[0] <= 1:
        return 0.0
    for i in range(1, len(bs)):
        if ws[i] <= 1 < ws[i - 1]:
            return float(bs[i - 1] + (ws[i - 1] - 1) / (ws[i - 1] - ws[i]) * (bs[i] - bs[i - 1]))
    return float("nan")


def errors_analysis(field, ok, gaia, sids, col, AP, res, log):
    ns = len(sids)
    N = len(ok)
    sid = np.asarray(ok["source_id"], np.int64)
    det = np.asarray(ok["detector"], int)
    flux, var = np.asarray(ok["flux"], float), np.asarray(ok["var"], float)
    lam = np.asarray(ok["lam"], float)
    gmap = {int(s): float(g) for s, g in zip(gaia["source_id"], gaia["phot_g_mean_mag"])}
    G = np.array([gmap[int(s)] for s in sid])
    phr = np.hypot(np.asarray(ok["phase_x"], float), np.asarray(ok["phase_y"], float))
    # neighbours within 30" to G+5
    sc = SkyCoord(gaia["ra"] * u.deg, gaia["dec"] * u.deg)
    row_of = {int(s): i for i, s in enumerate(gaia["source_id"])}
    stars_i = np.array([row_of[int(s)] for s in sids])
    i1, i2, d2, _ = sc.search_around_sky(sc[stars_i], 30 * u.arcsec)
    nn = np.zeros(ns, int)
    gg = np.asarray(gaia["phot_g_mean_mag"], float)
    for a, b in zip(i1, i2):
        if stars_i[a] != b and gg[b] < gg[stars_i[a]] + 5:
            nn[a] += 1
    nneigh = np.array([nn[col[int(s)]] for s in sid])
    cstar = np.array([col[int(s)] for s in sid])

    r6, v6, vu6 = loo_resid(ok, col, ns, "six")
    z6 = zres(r6, v6, vu6)
    r1, v1, vu1 = loo_resid(ok, col, ns, "one")
    z1 = zres(r1, v1, vu1)
    w6, w1 = mad_sigma(z6), mad_sigma(z1)
    n6, n1 = int(np.isfinite(z6).sum()), int(np.isfinite(z1).sum())
    lines = [f"[{field}] ERROR INVESTIGATION: LOO residuals of single-exposure fluxes about spec_model, normalised by sqrt(var+var_model)",
             f"  samples: six-detector model N={n6} width={w6:.3f}; one-detector model N={n1} width={w1:.3f}; stars={np.unique(sid[np.isfinite(z6)]).size}"]
    res["err_width_six"] = metric(float(w6), "sigma", n6, SCRIPT, "LOO normalised-residual width, model from all 6 detectors of the visit")
    res["err_width_one"] = metric(float(w1), "sigma", n1, SCRIPT, "LOO width, model from the same detector only")

    def table(title, bins, labels, z=z6):
        lines.append(f"  by {title}: " + "  ".join(f"{lab}:{w:.2f}(n={n})" for lab, (b, n, w) in zip(labels, binstat(z, bins))))
    gb = np.floor((G - G.min()) / 0.5).astype(int)
    gl = [f"G{G.min() + 0.5 * b:.1f}" for b in np.unique(gb)]
    table("G (0.5 mag)", gb, gl)
    table("detector", det, [f"D{d}" for d in np.unique(det)])
    pb = np.digitize(phr, [0.1, 0.2, 0.3, 0.4])
    table("pixel-phase radius (0-.1,.1-.2,.2-.3,.3-.4,>.4 px)", pb, ["p0", "p1", "p2", "p3", "p4"])
    nb = np.minimum(nneigh, 3)
    table("Gaia neighbours <30\" to G+5 (0,1,2,3+)", nb, ["0", "1", "2", "3+"])
    lamb = np.digitize(lam, np.quantile(lam, [0.2, 0.4, 0.6, 0.8]))
    table("wavelength quintile", lamb, [f"L{q}" for q in range(5)])
    lines.append("  one-detector model by detector: " + "  ".join(f"D{d}:{mad_sigma(z1[det == d]):.2f}" for d in np.unique(det)))
    for nm, b, labs in (("G", gb, gl), ("detector", det, [f"D{d}" for d in np.unique(det)])):
        for lab, (bb, nn_, w) in zip(labs, binstat(z6, b)):
            res[f"err_width_{nm}_{lab}"] = metric(None if not np.isfinite(w) else float(w), "sigma", nn_, SCRIPT, f"six-model LOO width, {nm} bin {lab}")
    for lab, (bb, nn_, w) in zip(["p0", "p1", "p2", "p3", "p4"], binstat(z6, pb)):
        res[f"err_width_phase_{lab}"] = metric(None if not np.isfinite(w) else float(w), "sigma", nn_, SCRIPT, "phase radius bins 0-.1,.1-.2,.2-.3,.3-.4,>.4 px")
    for lab, (bb, nn_, w) in zip(["0", "1", "2", "3plus"], binstat(z6, nb)):
        res[f"err_width_neigh_{lab}"] = metric(None if not np.isfinite(w) else float(w), "sigma", nn_, SCRIPT, "Gaia neighbours within 30 arcsec to G+5")
    # per-star
    sw = np.full(ns, np.nan)
    sn = np.zeros(ns, int)
    for s in range(ns):
        m = (cstar == s) & np.isfinite(z6)
        sn[s] = m.sum()
        if m.sum() >= 15:
            sw[s] = mad_sigma(z6[m])
    ok_s = np.isfinite(sw)
    order = np.argsort(-np.where(ok_s, sw, -1))
    top = order[:5]
    cut = np.nanquantile(sw[ok_s], 0.9)
    keep = np.isin(cstar, np.where(ok_s & (sw <= cut))[0])
    gmed = mad_sigma(z6[keep & np.isfinite(z6)])
    lines.append(f"  per star (n>=15): N={ok_s.sum()} median width {np.nanmedian(sw):.2f}, 16-84% {np.nanquantile(sw[ok_s],0.16):.2f}-{np.nanquantile(sw[ok_s],0.84):.2f}; "
                 f"stars with width>1.5: {(sw[ok_s] > 1.5).sum()}; worst 5: " +
                 ", ".join(f"{sids[i]}(G{gmap[int(sids[i])]:.1f}):{sw[i]:.2f}" for i in top) +
                 f"; global width without worst-10% stars {gmed:.3f}")
    res["err_star_width_median"] = metric(float(np.nanmedian(sw)), "sigma", int(ok_s.sum()), SCRIPT, "median over stars of per-star LOO width")
    res["err_star_frac_gt1p5"] = metric(float((sw[ok_s] > 1.5).mean()), "fraction", int(ok_s.sum()), SCRIPT, "fraction of stars with LOO width > 1.5")
    res["err_width_without_worst10pct_stars"] = metric(float(gmed), "sigma", None, SCRIPT, "global width after dropping the 10% stars with the largest width")
    snr0 = flux / np.sqrt(var)
    # inflation models
    bgrid = np.array([0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.045, 0.06, 0.08, 0.12])
    zb = []
    for b in bgrid:
        r, v, vu_ = loo_resid(ok, col, ns, "six", b)
        zb.append(zres(r, v, vu_))
    zb = np.array(zb)
    wb = np.array([mad_sigma(z) for z in zb])
    b_glob = solve_width1(bgrid, wb)
    k_glob = w6
    # fit over G bins for the two models
    sel = [b for (b, n_, w) in binstat(z6, gb) if np.isfinite(w) and n_ >= 40]
    wG = np.array([[mad_sigma(zb[i][(gb == bb)]) for bb in sel] for i in range(len(bgrid))])
    nG = np.array([int(((gb == bb) & np.isfinite(z6)).sum()) for bb in sel])
    rmsb = np.sqrt((nG * np.log(wG) ** 2).sum(1) / nG.sum())
    bi = int(np.argmin(rmsb))
    # refine additive fit by interpolation of the rms minimum on grid (parabola through 3 pts if interior)
    b_fit = float(bgrid[bi])
    wraw = wG[0]
    kfit = float(np.exp((nG * np.log(wraw)).sum() / nG.sum()))
    rms_mult = float(np.sqrt((nG * np.log(wraw / kfit) ** 2).sum() / nG.sum()))
    rms_add = float(rmsb[bi])
    rms_raw = float(np.sqrt((nG * np.log(wraw) ** 2).sum() / nG.sum()))
    better = "multiplicative factor" if rms_mult < rms_add else "added fractional term"
    lines.append(f"  inflation fits (six model, G bins with n>=40): global-width=1 criterion: multiplicative k={k_glob:.3f}; "
                 f"additive var'=var+(bF)^2 b={100*b_glob:.2f}% (width(b) grid: " +
                 " ".join(f"{100*b:.1f}%:{w:.2f}" for b, w in zip(bgrid, wb)) + ")")
    lines.append(f"  G-bin consistency (weighted rms of log width after correction; 0 = perfectly flat at 1): raw {rms_raw:.3f}, "
                 f"multiplicative (best k={kfit:.3f}) {rms_mult:.3f}, additive (best b={100*b_fit:.1f}% on grid) {rms_add:.3f} -> {better} describes the G-dependence better")
    lines.append("  width by G bin raw vs after multiplicative vs after additive(best b): " +
                 "  ".join(f"G{G.min() + 0.5 * bb:.1f}:{wraw[i]:.2f}/{wraw[i]/kfit:.2f}/{wG[bi][i]:.2f}" for i, bb in enumerate(sel)))
    res["err_k_mult_global"] = metric(float(k_glob), "factor", n6, SCRIPT, "multiply sigma by this to make LOO width 1 (global)")
    res["err_b_add_global"] = metric(float(100 * b_glob), "percent", n6, SCRIPT, "added fractional error: var'=var+(b F)^2 giving width 1 (global)")
    res["err_b_add_best_Gbins"] = metric(float(100 * b_fit), "percent", n6, SCRIPT, "grid b minimising G-bin flatness")
    res["err_k_mult_best_Gbins"] = metric(kfit, "factor", n6, SCRIPT, "k minimising G-bin flatness")
    res["err_rms_logwidth_mult"] = metric(rms_mult, "dex_ln", None, SCRIPT, "weighted rms ln(width) over G bins after multiplicative correction")
    res["err_rms_logwidth_add"] = metric(rms_add, "dex_ln", None, SCRIPT, "after additive correction")
    res["err_rms_logwidth_raw"] = metric(rms_raw, "dex_ln", None, SCRIPT, "before correction")
    res["err_better_model"] = metric(better, "text", None, SCRIPT, "model that flattens width vs G better")
    # per detector recipes
    lines.append("  per-detector recipe (six model, width=1 criterion): det: k_mult / b_add% / width raw")
    for dd in range(1, 7):
        m = det == dd
        wd = np.array([mad_sigma(z[m]) for z in zb])
        bdd = solve_width1(bgrid, wd)
        lines.append(f"    D{dd}: k={wd[0]:.3f}  b={100*bdd:.2f}%  (N={int((m & np.isfinite(z6)).sum())})")
        res[f"err_recipe_D{dd}_k"] = metric(float(wd[0]), "factor", int((m & np.isfinite(z6)).sum()), SCRIPT, "per-detector multiplicative factor")
        res[f"err_recipe_D{dd}_b"] = metric(float(100 * bdd), "percent", int((m & np.isfinite(z6)).sum()), SCRIPT, "per-detector added fractional term")
    zbest = zb[bi]
    lines.append(f"  detector widths after one universal additive term b={100*b_fit:.1f}%: " +
                 "  ".join(f"D{dd}:{mad_sigma(zbest[det == dd]):.2f}" for dd in range(1, 7)) +
                 f"; after universal mult k={kfit:.2f}: " + "  ".join(f"D{dd}:{mad_sigma(z6[det == dd])/kfit:.2f}" for dd in range(1, 7)))
    for dd in range(1, 7):
        res[f"err_width_after_universal_b_D{dd}"] = metric(float(mad_sigma(zbest[det == dd])), "sigma", int((det == dd).sum()), SCRIPT, f"after var+(b F)^2, b={100*b_fit:.1f}%")
    # median flux per detector (S/N confound check)
    lines.append("  median flux and S/N by detector: " + "  ".join(f"D{dd}:F={np.nanmedian(flux[det == dd]):.1f},S/N={np.nanmedian(snr0[det == dd]):.0f}" for dd in range(1, 7)))
    # within-visit pair noise-only check
    kw = AP["kind"] == 1
    gap = AP["gap"][kw]
    zw = z_values(AP["FA"][kw], AP["FB"][kw], AP["vA"][kw], AP["vB"][kw])
    m = gap < 1.0
    lines.append(f"  within-visit same-detector pairs (no epoch change, no spectral gap beyond 1 ch): N={int(m.sum())}, z width {mad_sigma(zw[m]):.3f}; all within-visit pairs N={len(zw)}, width {mad_sigma(zw):.3f}")
    res["err_within_visit_gap_lt1_width"] = metric(float(mad_sigma(zw[m])), "sigma", int(m.sum()), SCRIPT, "within-visit pairs with gap<1 channel")
    # S/N relation: variance floor fit: median var vs flux
    snr = flux / np.sqrt(var)
    lines.append(f"  median S/N per exposure {np.nanmedian(snr):.1f}; S/N quartiles of normalised width: " +
                 "  ".join(f"Q{q}:{mad_sigma(z6[np.digitize(snr, np.nanquantile(snr, [.25, .5, .75])) == q]):.2f}" for q in range(4)))
    for l in lines:
        log(l)
    # figure
    fig, ax = plt.subplots(2, 3, figsize=(13, 7))
    a = ax[0, 0]
    gx = np.array([G.min() + 0.5 * b + 0.25 for b in sel])
    a.plot(gx, wraw, "o-", label="raw")
    a.plot(gx, wraw / kfit, "s-", label=f"x1/{kfit:.2f} (mult.)")
    a.plot(gx, wG[bi], "^-", label=f"add b={100*b_fit:.1f}%")
    a.axhline(1, color="k", lw=0.6, ls=":")
    a.set_xlabel("Gaia G")
    a.set_ylabel("LOO normalised-residual width")
    a.legend(fontsize=7)
    a.set_title("vs brightness (additive term should flatten if flux-proportional)")
    a = ax[0, 1]
    dd_ = np.arange(1, 7)
    a.bar(dd_ - 0.2, [mad_sigma(z6[det == d]) for d in dd_], 0.4, label="six-det model")
    a.bar(dd_ + 0.2, [mad_sigma(z1[det == d]) for d in dd_], 0.4, label="one-det model")
    a.axhline(1, color="k", lw=0.6, ls=":")
    a.set_xlabel("detector")
    a.set_ylabel("width")
    a.legend(fontsize=7)
    a.set_title("vs detector")
    a = ax[0, 2]
    pw = [mad_sigma(z6[pb == k]) for k in range(5)]
    a.plot(range(5), pw, "o-", label="phase radius bin")
    nw = [mad_sigma(z6[nb == k]) for k in range(4)]
    a.plot(range(4), nw, "s-", label="neighbours 0,1,2,3+")
    a.axhline(1, color="k", lw=0.6, ls=":")
    a.set_xlabel("bin index")
    a.legend(fontsize=7)
    a.set_title("pixel phase (0-.1..>.4 px) / crowding")
    a = ax[1, 0]
    a.hist(sw[ok_s], bins=20, color="tab:gray")
    a.axvline(1, color="k", lw=0.6, ls=":")
    a.set_xlabel("per-star LOO width")
    a.set_title(f"per star: median {np.nanmedian(sw):.2f}, {(sw[ok_s] > 1.5).sum()} stars >1.5")
    a = ax[1, 1]
    a.semilogx(bgrid[1:] * 100, wb[1:], "o-")
    a.axhline(1, color="k", lw=0.6, ls=":")
    a.set_xlabel("added fractional error b (%)")
    a.set_ylabel("global width")
    a.set_title(f"width(b); k_mult={k_glob:.2f}, b(width=1)={100*b_glob:.1f}%")
    a = ax[1, 2]
    gwv = np.array([mad_sigma(zw[(gap >= lo) & (gap < hi)]) if ((gap >= lo) & (gap < hi)).sum() > 30 else np.nan
                    for lo, hi in zip(GAP_EDGES[:-1], GAP_EDGES[1:])])
    a.plot(range(len(GAP_LAB)), gwv, "o-")
    a.axhline(1, color="k", lw=0.6, ls=":")
    a.set_xticks(range(len(GAP_LAB)))
    a.set_xticklabels(GAP_LAB, fontsize=7)
    a.set_xlabel("gap (channels)")
    a.set_title("within-visit pairs z width")
    fig.suptitle(f"{field}: forced-photometry error underestimate")
    fig.tight_layout()
    fig.savefig(FIGURES / f"phaseb_errors_{field}.png", dpi=130)
    plt.close(fig)


# ------------------------------------------------------------------ 4. paired stack (PS)
PS_RULE = ("PS rule: per (pair A-B, detector d, star) candidate (i in A, j in B) with gap=|lam_i-lam_j|/mean(bw_i,bw_j) "
           "(lam at the star) <= tol; sorted by gap, then |mjd_i-mjd_j|, then obs_id_i, obs_id_j; greedy, each exposure used at most once; "
           "PS = inverse-variance mean of d_ij=F_i-F_j (var_i+var_j), var=1/sum(w), fractional denominator 0.5(wmean F_i + wmean F_j) = ivw mean of 0.5(F_i+F_j).")


def ps_build(field, ok, tol):
    """Returns accepted-pair arrays (pairkey, det, sid, diff, var, mean) and counts of A measurements / partnered ones."""
    vis = np.asarray(ok["visit"], int)
    det = np.asarray(ok["detector"], int)
    sid = np.asarray(ok["source_id"], np.int64)
    lam, bw = np.asarray(ok["lam"], float), np.asarray(ok["bw"], float)
    fl, vr = np.asarray(ok["flux"], float), np.asarray(ok["var"], float)
    mjd = np.asarray(ok["mjd"], float)
    obs = np.asarray(ok["obs_id"]).astype(str)
    idx = defaultdict(list)
    for i in range(len(ok)):
        idx[(vis[i], det[i], sid[i])].append(i)
    out = defaultdict(list)
    cnt = defaultdict(lambda: [0, 0])      # (pairkey) -> [n A star-measurements, n partnered]
    for a, b, cls in phaseb.VISIT_PAIRS[field]:
        pk = a * 10 + b
        for dd in range(1, 7):
            for s_ in np.unique(sid):
                ia = idx.get((a, dd, s_), [])
                ib = idx.get((b, dd, s_), [])
                cnt[(pk, cls)][0] += len(ia)
                cands = []
                for i in ia:
                    for j in ib:
                        g = abs(lam[i] - lam[j]) / (0.5 * (bw[i] + bw[j]))
                        if g <= tol:
                            cands.append((g, abs(mjd[i] - mjd[j]), obs[i], obs[j], i, j))
                cands.sort()
                ui, uj = set(), set()
                for g, _, _, _, i, j in cands:
                    if i in ui or j in uj:
                        continue
                    ui.add(i)
                    uj.add(j)
                    out["pk"].append(pk)
                    out["det"].append(dd)
                    out["sid"].append(int(s_))
                    out["diff"].append(fl[i] - fl[j])
                    out["var"].append(vr[i] + vr[j])
                    out["mean"].append(0.5 * (fl[i] + fl[j]))
                    cnt[(pk, cls)][1] += 1
    return {k: np.array(v) for k, v in out.items()}, dict(cnt)


def aggregate(pk, det, sid, diff, var, mean, mode):
    """Inverse-variance aggregate per (pair, det, star) for 'one' or per (pair, star) for 'six'. Returns dict key->(diff,var,mean)."""
    d_ = det if mode == "one" else np.zeros_like(det)
    keys = np.stack([pk, d_, sid], 1)
    u, inv = np.unique(keys, axis=0, return_inverse=True)
    inv = inv.ravel()
    w = 1.0 / var
    W = np.bincount(inv, w)
    D = np.bincount(inv, w * diff) / W
    M = np.bincount(inv, w * mean) / W
    return {tuple(int(x) for x in k): (D[i], 1.0 / W[i], M[i]) for i, k in enumerate(u)}


def rows_agg(t, mode, ncol=None):
    pk = np.array([int(a) * 10 + int(b) for a, b in zip(t["visitA"], t["visitB"])])
    return aggregate(pk, np.asarray(t["detector"], int), np.asarray(t["source_id"], np.int64),
                     np.asarray(t["F_A"], float) - np.asarray(t["F_B"], float),
                     np.asarray(t["var_A"], float) + np.asarray(t["var_B"], float),
                     0.5 * (np.asarray(t["F_A"], float) + np.asarray(t["F_B"], float)), mode)


def agg_vals(ag, keys):
    arr = np.array([ag[k] for k in keys])
    z = arr[:, 0] / np.sqrt(arr[:, 1])
    with np.errstate(all="ignore"):
        f = np.where(arr[:, 2] > 0, arr[:, 0] / arr[:, 2], np.nan)
    return z, f


def ps_analysis(field, d, ok, sids, col, C, res, log):
    def rd(nm, mode=None):
        t = Table.read(d / f"fluxes_{nm}.ecsv")
        m = np.array([str(x) == "prereg" for x in t["mask"]])
        if mode is not None:
            m &= np.array([str(x) == mode for x in t["mode"]])
        return t[m]
    PA = Table.read(d / "controls_p1avg.ecsv")
    pa_pk = np.array([int(a) * 10 + int(b) for a, b in zip(PA["visitA"], PA["visitB"])])
    pa = (pa_pk, np.asarray(PA["detector"], int), np.asarray(PA["source_id"], np.int64), np.asarray(PA["diff"], float),
          np.asarray(PA["var_prop"], float), np.asarray(PA["FA_mean"], float) - 0.5 * np.asarray(PA["diff"], float))
    log(f"[{field}] PAIRED STACK (PS). " + PS_RULE)
    P1 = rd("P1native")
    base = {}
    for mode in ("one", "six"):
        base[mode] = {"M2": rows_agg(rd("M2", mode), mode), "M2flat": rows_agg(rd("M2flat", mode), mode),
                      "M2unmatched": rows_agg(rd("M2unmatched", mode), mode), "P1native": rows_agg(P1, mode),
                      "P1avg": aggregate(*pa, mode)}
    psres = {}
    cover = {}
    for tol in (0.5, 1.0, 2.0):
        r, cnt = ps_build(field, ok, tol)
        cover[tol] = cnt
        psres[tol] = {m: aggregate(r["pk"], r["det"], r["sid"], r["diff"], r["var"], r["mean"], m) for m in ("one", "six")}
    # partner coverage
    lines = [f"[{field}] PS coverage: fraction of visit-A star-measurements (per A exposure, star) that found a PS partner (greedy, unique B)"]
    for tol in (0.5, 1.0, 2.0):
        cls_tot = defaultdict(lambda: [0, 0])
        for (pk, cls), (na, npart) in cover[tol].items():
            cls_tot[cls][0] += na
            cls_tot[cls][1] += npart
            cls_tot["all"][0] += na
            cls_tot["all"][1] += npart
        s_ = "  ".join(f"{c}: {100*v[1]/max(v[0],1):.0f}% (N={v[0]})" for c, v in sorted(cls_tot.items()))
        lines.append(f"  tol {tol:g} ch: {s_}")
        for c, v in cls_tot.items():
            res[f"ps_cover_tol{tol:g}_{c}"] = metric(float(v[1] / max(v[0], 1)), "fraction", int(v[0]), SCRIPT, "A star-measurements with a PS partner")
    # zero-PS counts at tol=1 where M2 gives a value
    for mode in ("one", "six"):
        mk = set(base[mode]["M2"])
        pk_ = set(psres[1.0][mode])
        lost = mk - pk_
        lines.append(f"  mode {mode}: M2 aggregates {len(mk)}, PS(tol=1) aggregates {len(pk_)}; M2 value but zero PS pairs: {len(lost)} "
                     f"({100*len(lost)/max(len(mk),1):.0f}%) in {len({k[-1] for k in lost})} stars")
        res[f"ps_zero_pairs_tol1_{mode}"] = metric(int(len(lost)), "count", int(len(mk)), SCRIPT, "(star,d,pair) [one] or (star,pair) [six] with an M2 value and no PS pair at tol=1 ch")
    for l in lines:
        log(l)
    # comparison tables at tol=1: all products on common set, plus PS vs M2 at each tol on their own intersection
    for mode in ("one", "six"):
        prods = {"PS": psres[1.0][mode], **base[mode]}
        order = ["PS", "M2", "M2flat", "M2unmatched", "P1native", "P1avg"]
        common = set.intersection(*[set(prods[p]) for p in order])
        keys = sorted(common)
        star = np.array([col[k[2]] for k in keys])
        zs, fs, bt = {}, {}, {}
        for p in order:
            zs[p], fs[p] = agg_vals(prods[p], keys)
            bt[p] = boot_ws(zs[p], fs[p], star, C)
        nst = np.unique(star).size
        lines = [f"[{field}] AGGREGATE comparison, mode {mode}, tol=1 ch: one value per "
                 f"{'(star, detector, pair)' if mode == 'one' else '(star, pair)'}; common set N={len(keys)}, {nst} stars, bootstrap x{C.shape[0]}",
                 "  (M2 aggregate variance is underestimated because its per-w0 comparisons share samples; fractional scatter is the primary metric)",
                 f"  {'product':12s} {'z width':>8} {'+/-':>6} | {'f scat %':>8} {'+/-':>6} | PS minus product: dwidth (sig) ; dscatter% (sig)"]
        for p in order:
            w0_, s0_ = mad_sigma(zs[p]), 100 * mad_sigma(fs[p])
            e = bt[p].std(0, ddof=1)
            txt = ""
            if p != "PS":
                dw = bt["PS"][:, 0] - bt[p][:, 0]
                dsc = bt["PS"][:, 1] - bt[p][:, 1]
                d0w, d0s = mad_sigma(zs["PS"]) - w0_, 100 * mad_sigma(fs["PS"]) - s0_
                txt = f"{d0w:+.3f} ({sig_str(d0w, dw.std(ddof=1))}) ; {d0s:+.2f} ({sig_str(d0s, dsc.std(ddof=1))})"
                res[f"ps_{mode}_diff_PS_minus_{p}_scatter"] = metric(float(d0s), "percent", len(keys), SCRIPT, f"tol=1 common set; bootstrap err {dsc.std(ddof=1):.3f}; {sig_str(d0s, dsc.std(ddof=1))}")
                res[f"ps_{mode}_diff_PS_minus_{p}_width"] = metric(float(d0w), "sigma", len(keys), SCRIPT, f"tol=1 common set; bootstrap err {dw.std(ddof=1):.4f}; {sig_str(d0w, dw.std(ddof=1))}")
            lines.append(f"  {p:12s} {w0_:8.3f} {e[0]:6.3f} | {s0_:8.2f} {e[1]:6.2f} | {txt}")
            res[f"ps_{mode}_{p}_width"] = metric(float(w0_), "sigma", len(keys), SCRIPT, f"aggregate z width, tol=1 common set; boot err {e[0]:.4f}; n_stars={nst}")
            res[f"ps_{mode}_{p}_scatter"] = metric(float(s0_), "percent", len(keys), SCRIPT, f"aggregate frac scatter, tol=1 common set; boot err {e[1]:.3f}; n_stars={nst}")
        for l in lines:
            log(l)
        # PS vs M2 at each tol on their own intersection
        for tol in (0.5, 1.0, 2.0):
            psA, m2A = psres[tol][mode], base[mode]["M2"]
            kk = sorted(set(psA) & set(m2A))
            if len(kk) < 20:
                continue
            st = np.array([col[k[2]] for k in kk])
            zp, fp = agg_vals(psA, kk)
            zm, fm = agg_vals(m2A, kk)
            bp, bm = boot_ws(zp, fp, st, C), boot_ws(zm, fm, st, C)
            dw, dsc = bp[:, 0] - bm[:, 0], bp[:, 1] - bm[:, 1]
            d0w, d0s = mad_sigma(zp) - mad_sigma(zm), 100 * (mad_sigma(fp) - mad_sigma(fm))
            better = "PS better (lower scatter)" if d0s < 0 else "M2 better (lower scatter)"
            sig = abs(d0s) / dsc.std(ddof=1) > 2
            log(f"  PS vs M2, mode {mode}, tol {tol:g}: N={len(kk)} stars={np.unique(st).size}; PS width {mad_sigma(zp):.3f} scatter {100*mad_sigma(fp):.2f}% | "
                f"M2 width {mad_sigma(zm):.3f} scatter {100*mad_sigma(fm):.2f}% | PS-M2 dscatter {d0s:+.2f}% ({sig_str(d0s, dsc.std(ddof=1))}), "
                f"dwidth {d0w:+.3f} ({sig_str(d0w, dw.std(ddof=1))}) -> {better}, {'significant' if sig else 'not significant'}")
            t_ = f"tol{tol:g}_{mode}"
            res[f"ps_vs_m2_{t_}_PS_scatter"] = metric(float(100 * mad_sigma(fp)), "percent", len(kk), SCRIPT, f"PS on PS&M2 intersection; boot err {bp[:,1].std(ddof=1):.3f}")
            res[f"ps_vs_m2_{t_}_M2_scatter"] = metric(float(100 * mad_sigma(fm)), "percent", len(kk), SCRIPT, f"M2 aggregate; boot err {bm[:,1].std(ddof=1):.3f}")
            res[f"ps_vs_m2_{t_}_PS_width"] = metric(float(mad_sigma(zp)), "sigma", len(kk), SCRIPT, f"boot err {bp[:,0].std(ddof=1):.4f}")
            res[f"ps_vs_m2_{t_}_M2_width"] = metric(float(mad_sigma(zm)), "sigma", len(kk), SCRIPT, f"boot err {bm[:,0].std(ddof=1):.4f} (underestimated variance)")
            res[f"ps_vs_m2_{t_}_diff_scatter"] = metric(float(d0s), "percent", len(kk), SCRIPT, f"PS minus M2; boot err {dsc.std(ddof=1):.3f}; {sig_str(d0s, dsc.std(ddof=1))}; {better}")
            res[f"ps_vs_m2_{t_}_diff_width"] = metric(float(d0w), "sigma", len(kk), SCRIPT, f"PS minus M2; boot err {dw.std(ddof=1):.4f}; {sig_str(d0w, dw.std(ddof=1))}")
    res["ps_rule"] = metric(PS_RULE, "text", None, SCRIPT, "pairing rule")


# ------------------------------------------------------------------ main
def run_field(field, recompute, nboot):
    t0 = time.time()
    FIGURES.mkdir(parents=True, exist_ok=True)
    d, ok, gaia, info, sids, col, exps, expid, frame = load_field(field)
    ns = len(sids)
    C = boot_counts(ns, nboot)
    res = {}
    out = []

    def log(s):
        print(s, flush=True)
        out.append(s)
    cache = d / "controls_allpairs.npz"
    if cache.exists() and not recompute:
        z = np.load(cache)
        AP = {k: z[k] for k in z.files}
    else:
        AP = build_allpairs(field, ok, sids, col, expid, frame, info)
        np.savez_compressed(cache, **AP)
    log(f"[{field}] all-pairs table: {int((AP['kind']==0).sum())} cross-visit pairs, {int((AP['kind']==1).sum())} within-visit pairs; {ns} stars")
    # M2 one prereg with keys
    M2 = Table.read(d / "fluxes_M2.ecsv")
    M2 = M2[np.array([(str(a) == "one") and (str(b) == "prereg") for a, b in zip(M2["mode"], M2["mask"])])]
    pairs = {(a, b): i for i, (a, b, _) in enumerate(phaseb.VISIT_PAIRS[field])}
    pi = np.array([pairs[(int(a), int(b))] for a, b in zip(M2["visitA"], M2["visitB"])])
    star = np.array([col[int(s)] for s in M2["source_id"]])
    eid = np.array([expid[str(f)] for f in M2["frame_A"]])
    key = ((pi.astype(np.int64) * 7 + np.asarray(M2["detector"], int)) * ns + star) * len(expid) + eid
    M2one = {"key": key, "star": star}
    for c in ("F_A", "F_B", "var_A", "var_B"):
        M2one[c] = np.asarray(M2[c], float)
    M2one["z"] = z_values(M2one["F_A"], M2one["F_B"], M2one["var_A"], M2one["var_B"])
    M2one["f"] = frac_values(M2one["F_A"], M2one["F_B"])
    gap_analysis(field, AP, M2one, sids, col, expid, C, res, log)
    controls_analysis(field, d, ok, sids, col, C, res, log, recompute)
    ps_analysis(field, d, ok, sids, col, C, res, log)
    errors_analysis(field, ok, gaia, sids, col, AP, res, log)
    res["_runtime_s"] = metric(round(time.time() - t0, 1), "s", None, SCRIPT, "wall time for this field")
    update_results(f"phaseb_controls_{field}", res)
    log(f"[{field}] done in {time.time()-t0:.0f}s; results section phaseb_controls_{field}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", default="all", choices=["barnard", "epsindi", "all"])
    ap.add_argument("--recompute", action="store_true")
    ap.add_argument("--nboot", type=int, default=1000)
    a = ap.parse_args()
    for f in (["barnard", "epsindi"] if a.field == "all" else [a.field]):
        run_field(f, a.recompute, a.nboot)


if __name__ == "__main__":
    main()
