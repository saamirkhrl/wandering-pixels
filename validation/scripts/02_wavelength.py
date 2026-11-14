"""02: per-pixel wavelength at the field centre for every exposure, cross-visit channel
matching, and per-visit spectral sampling density.

Primary wavelength = calibration file CWAVE/CBAND (science grade, nearest pixel).
Secondary = WCS-WAVE table (own bilinear interpolation).

usage: uv run python scripts/02_wavelength.py --field {epsindi,barnard,all}
Needs data/index_<field>.csv (from 00_index.py). The source check (WCS-WAVE vs calibration,
random pixels) runs even without an index.
"""
import argparse
import csv
import json
import sys
from itertools import combinations
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import requests
from astropy.io import fits
from astropy.time import Time

from wp import wavelength as W
from wp.config import DATA, FIELDS, FIGURES, RESULTS_JSON, S3_HTTPS, USER_AGENT
from wp.results import metric, update_results

SCRIPT = "02_wavelength.py"
LMIN, LMAX = 0.75, 5.0
DET_COLORS = {1: "#1f77b4", 2: "#2ca02c", 3: "#bcbd22", 4: "#ff7f0e", 5: "#d62728", 6: "#8c564b"}
CLASSES = ["same_visit", "6mo", "12mo", "18mo"]


def pair_class(dt):
    d = abs(dt)
    if d < 20:
        return "same_visit"
    if 120 <= d <= 240:
        return "6mo"
    if 300 <= d <= 430:
        return "12mo"
    if 480 <= d <= 620:
        return "18mo"
    return None


def merge_section(section, new):
    """update_results replaces a whole section; keep entries of other fields."""
    old = {}
    if RESULTS_JSON.exists():
        old = json.loads(RESULTS_JSON.read_text() or "{}").get(section, {})
    old.update(new)
    update_results(section, old)


def load_index(field):
    p = DATA / f"index_{field}.csv"
    if not p.exists():
        return None
    rows = list(csv.DictReader(open(p)))
    out = []
    for r in rows:
        r["detector"] = int(r["detector"])
        r["mjd_mid"] = float(r["mjd_mid"])
        r["target_x"] = float(r["target_x"])
        r["target_y"] = float(r["target_y"])
        r["on_detector"] = str(r["on_detector"]).strip().lower() in ("1", "true", "yes")
        out.append(r)
    return out


def fetch_table(key):
    """WCS-WAVE is the last HDU of a Level 2 file: range-read the tail and parse the final
    BINTABLE (grid size differs per detector, so look for the last XTENSION card)."""
    u = f"{S3_HTTPS}/{key}"
    h = {"User-Agent": USER_AGENT}
    n = int(requests.head(u, headers=h, timeout=60).headers["Content-Length"])
    tail = 65536
    r = requests.get(u, headers={**h, "Range": f"bytes={n - tail}-{n - 1}"}, timeout=60)
    r.raise_for_status()
    i = r.content.rindex(b"XTENSION= 'BINTABLE'")
    hdu = fits.BinTableHDU.fromstring(r.content[i:])
    assert hdu.header.get("EXTNAME") == "WCS-WAVE", hdu.header.get("EXTNAME")
    return W.table_from(hdu)


# ----------------------------------------------------------------------------- step 2
def source_check(indices):
    print("\n=== WCS-WAVE vs calibration (CWAVE/CBAND), random pixels ===")
    rng = np.random.default_rng(42)
    x = rng.uniform(0, 2039, 2000)
    y = rng.uniform(0, 2039, 2000)
    res = {}
    print("det  n   med(nm) rsig(nm) max|d|(nm)  med|d|/band  max|d|/band   cal range um   hdr WLERRMAX/P99 (nm)")
    for d in range(1, 7):
        c = W.compare_sources("dr1", d, x, y)
        dn = c["dwave"] * 1e3
        fr = np.abs(c["dwave"] / c["cal_band"])
        with fits.open(W.cal_path("dr1", d)) as h:
            hh = h[0].header
            err = (hh.get("WLERRMAX"), hh.get("WLERRP99"))
        print(f"D{d} {len(x)} {np.median(dn):7.3f} {W.robust_sigma(dn):7.3f} {np.max(np.abs(dn)):9.3f}"
              f"   {np.median(fr):9.4f}  {np.max(fr):9.4f}   {np.nanmin(c['cal_wave']):.3f}-{np.nanmax(c['cal_wave']):.3f}"
              f"   {err[0] * 1e3:.0f}/{err[1] * 1e3:.2f}")
        res[f"random_D{d}_median_dwave"] = metric(float(np.median(dn)), "nm", len(x), SCRIPT, "WCS-WAVE minus CWAVE, 2000 random pixels, seed 42")
        res[f"random_D{d}_robust_sigma_dwave"] = metric(W.robust_sigma(dn), "nm", len(x), SCRIPT)
        res[f"random_D{d}_max_abs_dwave"] = metric(float(np.max(np.abs(dn))), "nm", len(x), SCRIPT)
        res[f"random_D{d}_max_abs_dwave_over_band"] = metric(float(np.max(fr)), "fraction of local CBAND", len(x), SCRIPT)
        res[f"random_D{d}_median_abs_dwave_over_band"] = metric(float(np.median(fr)), "fraction of local CBAND", len(x), SCRIPT)
        res[f"cal_header_D{d}_WLERRMAX"] = metric(float(err[0] * 1e3), "nm", None, SCRIPT, "header of CWAVE: max error of CWAVE lookup vs SpecCal (not WCS-WAVE vs CWAVE)")
        res[f"cal_header_D{d}_WLERRP99"] = metric(float(err[1] * 1e3), "nm", None, SCRIPT)

    # table node values equal the calibration file's own table?
    print("\n=== calibration versions (dr1 vs qr3) ===")
    vs = W.cal_versions_summary()
    same = True
    for d in range(1, 7):
        a, b = vs[f"dr1_D{d}"], vs[f"qr3_D{d}"]
        same &= (a["version"] == b["version"] and a["etag"] == b["etag"])
        print(f"D{d}: dr1 {a['version']} etag {a['etag'][:10]} | qr3 {b['version']} etag {b['etag'][:10]} identical={a['etag'] == b['etag']}")
    res["cal_dr1_qr3_identical"] = metric(bool(same), "bool", 6, SCRIPT,
                                          f"version {vs['dr1_D1']['version']} under both dr1/ and qr3/, byte-identical (same ETag) for all 6 detectors")

    # per-exposure WCS-WAVE tables of the same detector
    print("\n=== WCS-WAVE table identical across exposures of the same detector? ===")
    n_chk = n_eq = 0
    for d in range(1, 7):
        rows = [r for f in indices for r in indices[f] if r["detector"] == d]
        rows.sort(key=lambda r: r["mjd_mid"])
        if not rows:
            continue
        pick = [rows[int(i)] for i in np.unique(np.linspace(0, len(rows) - 1, 4).astype(int))]
        ref = W.cal_table("dr1", d)
        flags = []
        for r in pick:
            try:
                t = fetch_table(r["s3_key"])
            except Exception as e:  # noqa
                flags.append(f"{r['obs_id']}:ERR {e}")
                continue
            eq = W.tables_equal(t, ref)
            n_chk += 1
            n_eq += int(eq)
            flags.append(f"{r['obs_id']}({r['release']}):{'same' if eq else 'DIFFERS maxdiff %.4g um' % np.max(np.abs(t['values'] - ref['values']))}")
        print(f"D{d}: " + "; ".join(flags))
    if n_chk:
        res["wcswave_table_identical_across_exposures"] = metric(f"{n_eq}/{n_chk}", "tables equal to calibration file table", n_chk, SCRIPT,
                                                                 "exposures spread over time per detector; compared to table inside the calibration file")
    else:
        print("(no index yet; cross-exposure check uses only the single downloaded dr1 D2 file: identical)")
        try:
            with fits.open(DATA / "t1b" / "l2_D2.fits") as h:
                eq = W.tables_equal(h["WCS-WAVE"], W.cal_table("dr1", 2))
            res["wcswave_table_identical_across_exposures"] = metric("1/1" if eq else "0/1", "tables equal", 1, SCRIPT, "only one exposure checked (no index)")
        except Exception:
            pass
    return res


def field_target_check(field, rows, res):
    """WCS-WAVE vs cal at the actual target pixels."""
    d_nm, fr = [], []
    for r in rows:
        if not r["on_detector"]:
            continue
        t = W.cal_table(r["release"], r["detector"])
        c = W.compare_sources(r["release"], r["detector"], r["target_x"], r["target_y"], t)
        d_nm.append(c["dwave"] * 1e3)
        fr.append(abs(c["dwave"] / c["cal_band"]))
    d_nm, fr = np.array(d_nm), np.array(fr)
    if not len(d_nm):
        return
    print(f"[{field}] at target pixels (n={len(d_nm)}): median {np.median(d_nm):.3f} nm, robust sigma {W.robust_sigma(d_nm):.3f} nm, "
          f"max|d| {np.max(np.abs(d_nm)):.3f} nm, max|d|/band {np.max(fr):.4f}")
    res[f"{field}_target_median_dwave"] = metric(float(np.median(d_nm)), "nm", len(d_nm), SCRIPT)
    res[f"{field}_target_robust_sigma_dwave"] = metric(W.robust_sigma(d_nm), "nm", len(d_nm), SCRIPT)
    res[f"{field}_target_max_abs_dwave"] = metric(float(np.max(np.abs(d_nm))), "nm", len(d_nm), SCRIPT)
    res[f"{field}_target_max_abs_dwave_over_band"] = metric(float(np.max(fr)), "fraction of local CBAND", len(d_nm), SCRIPT)


# ----------------------------------------------------------------------------- step 3
def merge_samples(lam, band):
    """Sort and merge samples closer than half a local bandwidth. Returns (lam_m, band_m)."""
    o = np.argsort(lam)
    lam, band = lam[o], band[o]
    groups = [[0]]
    for i in range(1, len(lam)):
        if lam[i] - lam[groups[-1][0]] < 0.5 * band[i]:   # anchored at the group's first sample (no chaining)
            groups[-1].append(i)
        else:
            groups.append([i])
    return (np.array([lam[g].mean() for g in groups]), np.array([band[g].mean() for g in groups]))


def sampling_stats(lam, band):
    lm, bm = merge_samples(lam, band)
    gaps = np.diff(lm)
    gb = gaps / (0.5 * (bm[:-1] + bm[1:])) if len(gaps) else np.array([])
    # coverage of [LMIN, LMAX] within +-0.5 bandwidth of some sample
    iv = sorted((max(l - 0.5 * b, LMIN), min(l + 0.5 * b, LMAX)) for l, b in zip(lam, band))
    cov, cur = 0.0, None
    for a, b in iv:
        if b <= a:
            continue
        if cur is None or a > cur[1]:
            if cur:
                cov += cur[1] - cur[0]
            cur = [a, b]
        else:
            cur[1] = max(cur[1], b)
    if cur:
        cov += cur[1] - cur[0]
    top = np.argsort(-gaps)[:3] if len(gaps) else []
    return dict(n_exp=len(lam), n_distinct=len(lm), coverage=cov / (LMAX - LMIN),
                max_gap_um=float(gaps.max()) if len(gaps) else float("nan"),
                max_gap_bw=float(gb.max()) if len(gb) else float("nan"),
                top_gaps=[(float(lm[i]), float(lm[i + 1]), float(gaps[i]), float(gb[i])) for i in top],
                lam_min=float(lam.min()), lam_max=float(lam.max()))


def analyse_field(field, rows, res):
    rows = [r for r in rows if r["on_detector"]]
    for r in rows:
        r["lam"], r["band"] = W.cal_lambda(r["release"], r["detector"], r["target_x"], r["target_y"])
        tab = W.cal_table(r["release"], r["detector"])
        r["lam2"], r["band2"] = W.wcswave_lambda(tab, r["target_x"], r["target_y"])
    ok = [r for r in rows if np.isfinite(r["lam"])]
    visits = sorted({int(r["visit"]) for r in ok})
    vdate = {v: Time(np.mean([r["mjd_mid"] for r in ok if int(r["visit"]) == v]), format="mjd").iso[:10] for v in visits}
    print(f"\n=== {field}: {len(ok)} on-detector exposures, {len(visits)} visits ===")

    # per visit and detector listing
    print("-- wavelengths (um) per visit and detector (cal CWAVE) --")
    for v in visits:
        print(f"visit {v} ({vdate[v]}):")
        for d in range(1, 7):
            ls = sorted(r["lam"] for r in ok if int(r["visit"]) == v and r["detector"] == d)
            if ls:
                print(f"   D{d} n={len(ls)}: " + " ".join(f"{x:.4f}" for x in ls))
        res[f"{field}_visit{v}_n_exposures"] = metric(sum(1 for r in ok if int(r["visit"]) == v), "exposures", None, SCRIPT, f"visit date {vdate[v]}")

    # primary vs secondary lambda at the target
    dd = np.array([(r["lam2"] - r["lam"]) * 1e3 for r in ok])
    print(f"-- WCS-WAVE minus CWAVE at the field pixel: median {np.median(dd):.3f} nm, max|.| {np.max(np.abs(dd)):.3f} nm (n={len(dd)})")
    field_target_check(field, rows, res)

    if field == "barnard":
        print("-- explicit check pair (Barnard D2) --")
        for oid in ("2025W35_2A_0221_2", "2026W34_2A_0233_3"):
            for r in rows:
                if r["obs_id"] == oid and r["detector"] == 2:
                    print(f"{oid} D2 {r['release']} target_x={r['target_x']:.2f} target_y={r['target_y']:.2f} "
                          f"cal={r['lam']:.4f} um (band {r['band']:.4f}) WCS-WAVE={r['lam2']:.4f} um mjd={r['mjd_mid']:.2f}")

    # pair statistics
    print("-- same-detector pair statistics --")
    print("class        N_pairs  frac<1w  frac<0.5w | N_expA  frac(A has partner in B within 1w)  frac(0.5w)")
    dist = {}
    for cls in CLASSES:
        tot = hit1 = hit05 = 0
        dl_um, dl_w = [], []
        for d in range(1, 7):
            ex = [r for r in ok if r["detector"] == d]
            for a, b in combinations(ex, 2):
                if pair_class(a["mjd_mid"] - b["mjd_mid"]) != cls:
                    continue
                w = 0.5 * (a["band"] + b["band"])
                dl = abs(a["lam"] - b["lam"])
                tot += 1
                dl_um.append(dl)
                dl_w.append(dl / w)
                hit1 += dl < w
                hit05 += dl < 0.5 * w
        # directional: exposures in earlier visit A with a partner in later visit B of this class
        nA = pA1 = pA05 = 0
        if cls != "same_visit":
            for va, vb in combinations(visits, 2):
                A = [r for r in ok if int(r["visit"]) == va]
                B = [r for r in ok if int(r["visit"]) == vb]
                if not A or not B:
                    continue
                if pair_class(np.mean([r["mjd_mid"] for r in A]) - np.mean([r["mjd_mid"] for r in B])) != cls:
                    continue
                for a in A:
                    cand = [b for b in B if b["detector"] == a["detector"]]
                    nA += 1
                    if cand:
                        dmin = min(abs(a["lam"] - b["lam"]) / (0.5 * (a["band"] + b["band"])) for b in cand)
                        pA1 += dmin < 1.0
                        pA05 += dmin < 0.5
        dist[cls] = (np.array(dl_um), np.array(dl_w))
        f1 = hit1 / tot if tot else float("nan")
        f05 = hit05 / tot if tot else float("nan")
        g1 = pA1 / nA if nA else float("nan")
        g05 = pA05 / nA if nA else float("nan")
        print(f"{cls:10s} {tot:8d}  {f1:7.4f}  {f05:8.4f}  | {nA:6d}  {g1:8.4f}  {g05:8.4f}")
        res[f"{field}_{cls}_pairs_within_1width"] = metric(f1, "fraction of same-detector pairs", tot, SCRIPT, "|dlambda| < mean CBAND of the two exposures")
        res[f"{field}_{cls}_pairs_within_0p5width"] = metric(f05, "fraction of same-detector pairs", tot, SCRIPT)
        if cls != "same_visit":
            res[f"{field}_{cls}_expA_with_partner_1width"] = metric(g1, "fraction of earlier-visit exposures", nA, SCRIPT, "partner = same detector, later visit of this dt class, within 1 width")
            res[f"{field}_{cls}_expA_with_partner_0p5width"] = metric(g05, "fraction of earlier-visit exposures", nA, SCRIPT)

    # full |dlambda| distributions
    qs = [10, 25, 50, 75, 90]
    print("-- |dlambda| distribution of same-detector pairs: quantiles 10/25/50/75/90 %, max --")
    for cls in CLASSES:
        du, dw = dist[cls]
        if not len(du):
            continue
        qu, qw = np.percentile(du, qs), np.percentile(dw, qs)
        print(f"{cls:10s} N={len(du):5d} um: " + " ".join(f"{x:.4f}" for x in qu) + f" max {du.max():.4f} | widths: "
              + " ".join(f"{x:.2f}" for x in qw) + f" max {dw.max():.2f}")
        for q, a, b in zip(qs, qu, qw):
            res[f"{field}_{cls}_dlambda_q{q}_um"] = metric(float(a), "um", len(du), SCRIPT, "|dlambda| of same-detector pairs")
            res[f"{field}_{cls}_dlambda_q{q}_widths"] = metric(float(b), "channel widths", len(du), SCRIPT, "width = mean CBAND of the pair")
        res[f"{field}_{cls}_dlambda_max_um"] = metric(float(du.max()), "um", len(du), SCRIPT)
        res[f"{field}_{cls}_dlambda_max_widths"] = metric(float(dw.max()), "channel widths", len(du), SCRIPT)
    fig, axs = plt.subplots(2, 4, figsize=(14, 6))
    for j, cls in enumerate(CLASSES):
        du, dw = dist[cls]
        for i, (arr, lab, rng_) in enumerate(((du, "|dlambda| (um)", None), (dw, "|dlambda| (channel widths)", None))):
            ax = axs[i, j]
            if len(arr):
                ax.hist(arr, bins=60, color="#1f77b4")
                ax.axvline(np.median(arr), color="k", ls="--", lw=1)
                if i == 1:
                    ax.axvline(1.0, color="#d62728", lw=1)
            ax.set_xlabel(lab, fontsize=8)
            ax.set_title(f"{cls} (N={len(arr)})" if i == 0 else "", fontsize=9)
            ax.tick_params(labelsize=7)
    axs[0, 0].set_ylabel("pairs")
    axs[1, 0].set_ylabel("pairs")
    fig.suptitle(f"{FIELDS[field]['name']}: |dlambda| of same-detector exposure pairs (dashed = median, red = 1 channel width)", fontsize=10)
    fig.tight_layout()
    fig.savefig(FIGURES / f"wavelength_pair_dlambda_{field}.png", dpi=130)
    plt.close(fig)

    # sampling density per visit
    print("-- spectral sampling per visit (0.75-5.0 um) --")
    print("visit date        n_exp n_distinct coverage  max_gap(um) max_gap(bw)  lam range")
    for v in visits:
        sel = [r for r in ok if int(r["visit"]) == v]
        s = sampling_stats(np.array([r["lam"] for r in sel]), np.array([r["band"] for r in sel]))
        print(f"{v:3d}   {vdate[v]}  {s['n_exp']:5d} {s['n_distinct']:9d} {s['coverage']:8.3f} {s['max_gap_um']:10.4f} {s['max_gap_bw']:10.2f}   "
              f"{s['lam_min']:.3f}-{s['lam_max']:.3f}")
        for g in s["top_gaps"]:
            print(f"        gap {g[0]:.3f} -> {g[1]:.3f} um: {g[2]:.4f} um = {g[3]:.2f} bandwidths")
        res[f"{field}_visit{v}_n_distinct_wavelengths"] = metric(s["n_distinct"], "wavelengths", s["n_exp"], SCRIPT, f"samples merged within 0.5 bandwidth; date {vdate[v]}")
        res[f"{field}_visit{v}_coverage_0p75_5p0"] = metric(s["coverage"], "fraction of 0.75-5.0 um", s["n_exp"], SCRIPT, "within +-0.5 bandwidth of a sample")
        res[f"{field}_visit{v}_max_gap"] = metric(s["max_gap_um"], "um", s["n_distinct"], SCRIPT)
        res[f"{field}_visit{v}_max_gap_bandwidths"] = metric(s["max_gap_bw"], "local bandwidths", s["n_distinct"], SCRIPT)
    # all visits together
    s = sampling_stats(np.array([r["lam"] for r in ok]), np.array([r["band"] for r in ok]))
    print(f"all visits: n_exp={s['n_exp']} distinct={s['n_distinct']} coverage={s['coverage']:.3f} max_gap={s['max_gap_um']:.4f} um = {s['max_gap_bw']:.2f} bw")
    res[f"{field}_all_visits_n_distinct_wavelengths"] = metric(s["n_distinct"], "wavelengths", s["n_exp"], SCRIPT)
    res[f"{field}_all_visits_coverage_0p75_5p0"] = metric(s["coverage"], "fraction of 0.75-5.0 um", s["n_exp"], SCRIPT)

    # figure
    FIGURES.mkdir(parents=True, exist_ok=True)
    fig, axes = plt.subplots(len(visits), 1, figsize=(10, 1.3 * len(visits) + 1.6), sharex=True, squeeze=False)
    for ax, v in zip(axes[:, 0], visits):
        for d in range(1, 7):
            sel = [r for r in ok if int(r["visit"]) == v and r["detector"] == d]
            if sel:
                ax.errorbar([r["lam"] for r in sel], np.zeros(len(sel)), xerr=[0.5 * r["band"] for r in sel], fmt="o", ms=4,
                            color=DET_COLORS[d], ecolor=DET_COLORS[d], elinewidth=1.2, capsize=0, label=f"D{d}")
        ax.set_yticks([])
        ax.set_ylim(-1, 1)
        ax.set_xscale("log")
        ax.set_ylabel(f"visit {v}\n{vdate[v]}", rotation=0, ha="right", va="center", fontsize=8)
        for sp in ("left", "right", "top"):
            ax.spines[sp].set_visible(False)
    axes[-1, 0].set_xlim(0.7, 5.3)
    axes[-1, 0].set_xticks([0.75, 1, 1.5, 2, 3, 4, 5])
    axes[-1, 0].set_xticklabels(["0.75", "1", "1.5", "2", "3", "4", "5"])
    axes[-1, 0].set_xlabel("wavelength at the field position (um); bars = channel bandwidth")
    h = [plt.Line2D([], [], marker="o", ls="", color=DET_COLORS[d], label=f"D{d}") for d in range(1, 7)]
    axes[0, 0].legend(handles=h, ncol=6, fontsize=8, loc="lower center", bbox_to_anchor=(0.5, 1.05), frameon=False)
    fig.suptitle(f"{FIELDS[field]['name']}: SPHEREx wavelengths sampled at the field centre, by visit", fontsize=10, y=0.995)
    fig.tight_layout()
    out = FIGURES / f"wavelength_sampling_{field}.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f"wrote {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", default="all", choices=["epsindi", "barnard", "all"])
    a = ap.parse_args()
    fields = list(FIELDS) if a.field == "all" else [a.field]
    indices = {}
    for f in fields:
        idx = load_index(f)
        if idx is None:
            print(f"[{f}] index missing: data/index_{f}.csv (run 00_index.py); skipping field analysis")
        else:
            indices[f] = idx
    res = source_check(indices)
    merge_section("wavelength_source_check", res)
    for f, rows in indices.items():
        sres = {}
        analyse_field(f, rows, sres)
        merge_section("wavelength_sampling", sres)
        # target-pixel comparison belongs to source check
        merge_section("wavelength_source_check", {k: v for k, v in sres.items() if "_target_" in k})
    print("\nresults written to", RESULTS_JSON)


if __name__ == "__main__":
    main()
