"""07: phase B metrics for plain (P1, P2) vs spectrally matched (M1, M2) differences + PSF vs wavelength.

usage: uv run python scripts/07_metrics.py --field {barnard,epsindi,all} [--selftest]
Inputs: data/phaseb/<field>/fluxes_<product>.ecsv, product in P1 P2 M1 M2 P1native (missing ones
are skipped with a note). Metric definitions: wp/metrics.py (docs/method.md, item 8).
--selftest: build a synthetic table with a planted colour slope and a planted wavelength-gap trend,
run the same pipeline on it (nothing written to results.json or docs/figures) and check recovery.
"""
import argparse
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from astropy.table import Table, vstack

from wp import wavelength as W
from wp.config import DATA, FIGURES
from wp.metrics import (CLEAN_SIGMA, CLEAN_WIDTH, clipped_line, frac_values, mad_sigma, star_medians,
                        subset_metrics, z_values)
from wp.results import metric, update_results

SCRIPT = "07_metrics.py"
PRODUCTS = ["P1", "P2", "M1", "M2", "P1native", "M2flat", "M2unmatched"]  # last two: labelled controls
CLASSES = ["6mo", "12mo", "18mo"]
GAP_BINS = [0, 0.5, 1, 2, 4, 8, np.inf]
GAP_LABELS = ["0-0.5", "0.5-1", "1-2", "2-4", "4-8", ">8"]
OUTLIER_Z = 5.0


def glabel(k):
    p, m, kern, ps, mk = k
    return f"{p}/{m}/{kern}/{ps:g}/{mk}"


# ---------------------------------------------------------------- loading

def load_tables(indir):
    tabs, missing = [], []
    for p in PRODUCTS:
        f = Path(indir) / f"fluxes_{p}.ecsv"
        if not f.exists():
            missing.append(p)
            continue
        t = Table.read(f)
        if "mask" not in t.colnames:
            t["mask"] = "prereg"
        for c in ("product", "mode", "kernel", "pair_class", "mask"):
            t[c] = np.array([str(x) for x in t[c]])
        tabs.append(t)
    if not tabs:
        return None, missing
    keep = ["product", "mode", "kernel", "pixscale", "mask", "pair_class", "source_id", "G", "bp_rp", "dlam_ch",
            "F_A", "F_B", "var_A", "var_B"]
    return vstack([t[keep] for t in tabs], metadata_conflicts="silent"), missing


def split_groups(T):
    key = np.array([f"{p}|{m}|{k}|{s:.4f}|{mk}" for p, m, k, s, mk in
                    zip(T["product"], T["mode"], T["kernel"], T["pixscale"], T["mask"])])
    groups = {}
    for u in sorted(set(key)):
        i = np.where(key == u)[0]
        r = T[i[0]]
        groups[(str(r["product"]), str(r["mode"]), str(r["kernel"]), round(float(r["pixscale"]), 4), str(r["mask"]))] = i
    return groups


def default_scale(k):
    """Groups used in figures and the variability check: 6.15 arcsec grid products, and the
    native-pixel products at their (single) scale."""
    return k[0] in ("M2", "P1native") or abs(k[3] - 6.15) < 0.01


# ---------------------------------------------------------------- analysis

def analyse(T, groups):
    res = {}
    for k, idx in groups.items():
        sub = T[idx]
        res[k] = {"all": subset_metrics(sub)}
        for c in CLASSES:
            m = sub["pair_class"] == c
            if m.any():
                res[k][c] = subset_metrics(sub[m])
    return res


def gap_bins(T, groups):
    out = {}
    for k, idx in groups.items():
        if k[0] not in ("P1", "P1native"):
            continue
        sub = T[idx]
        g = np.asarray(sub["dlam_ch"], float)
        rows = []
        for lo, hi, lab in zip(GAP_BINS[:-1], GAP_BINS[1:], GAP_LABELS):
            m = (g >= lo) & (g < hi)
            if m.sum() < 5:
                rows.append(dict(label=lab, n=int(m.sum()), z_width=np.nan, f_scatter_pct=np.nan))
                continue
            s = sub[m]
            z = z_values(s["F_A"], s["F_B"], s["var_A"], s["var_B"])
            f = frac_values(s["F_A"], s["F_B"])
            rows.append(dict(label=lab, n=int(np.isfinite(z).sum()), z_width=mad_sigma(z),
                             f_scatter_pct=100 * mad_sigma(f)))
        out[k] = rows
    return out


def variability(T, groups):
    """Per-star median z per group (default-scale groups). Stars with |median z| > 5 in every group
    in which they appear (and at least two groups) are flagged."""
    med = {}
    for k, idx in groups.items():
        if not default_scale(k):
            continue
        s = T[idx]
        z = z_values(s["F_A"], s["F_B"], s["var_A"], s["var_B"])
        ids = np.asarray(s["source_id"])
        ok = np.isfinite(z)
        u = np.unique(ids[ok])
        d = {}
        for sid in u:
            d[int(sid)] = float(np.median(z[ok & (ids == sid)]))
        med[k] = d
    allids = sorted(set().union(*[set(d) for d in med.values()])) if med else []
    flagged = []
    for sid in allids:
        vals = [d[sid] for d in med.values() if sid in d]
        if len(vals) >= 2 and all(abs(v) > OUTLIER_Z for v in vals):
            flagged.append((sid, len(vals)))
    # cross-product correlation of per-star median z
    keys = list(med)
    corr = {}
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            common = sorted(set(med[a]) & set(med[b]))
            if len(common) >= 10:
                va = np.array([med[a][s] for s in common])
                vb = np.array([med[b][s] for s in common])
                corr[(a, b)] = (float(np.corrcoef(va, vb)[0, 1]), len(common))
    return flagged, corr, med


def print_table(field, res, title="HEADLINE (variable-candidate stars kept)"):
    print(f"\n=== {field}: {title} ===")
    print(f"{'group':26s} {'cls':5s} {'N':>7s} {'Nstar':>5s} {'zmed':>6s} {'zwid':>5s} {'fmed%':>6s} "
          f"{'fscat%':>6s} {'slope%/mag':>18s} {'sig':>5s} {'clean':>5s}")
    for k in sorted(res, key=lambda k: (PRODUCTS.index(k[0]), k[1], k[2], k[3], k[4])):
        for c in ["all"] + CLASSES:
            if c not in res[k]:
                continue
            r = res[k][c]
            sl = f"{r['slope_pct_per_mag']:+.3f}+-{r['slope_err']:.3f}"
            print(f"{glabel(k):26s} {c:5s} {r['n']:7d} {r['n_stars']:5d} {r['z_median']:+6.2f} {r['z_width']:5.2f} "
                  f"{r['f_median_pct']:+6.2f} {r['f_scatter_pct']:6.2f} {sl:>18s} {r['slope_sigma']:+5.1f} "
                  f"{'YES' if r['clean'] else 'no':>5s}")


def print_gap(field, gb):
    print(f"\n=== {field}: P1 / P1native vs wavelength gap (channels) ===")
    for k, rows in gb.items():
        print(glabel(k))
        print("  gap bin   " + "  ".join(f"{r['label']:>8s}" for r in rows))
        print("  N         " + "  ".join(f"{r['n']:8d}" for r in rows))
        print("  z width   " + "  ".join(f"{r['z_width']:8.2f}" for r in rows))
        print("  frac %    " + "  ".join(f"{r['f_scatter_pct']:8.2f}" for r in rows))


def print_one_six(field, res):
    print(f"\n=== {field}: 'one' vs 'six' (all pair classes pooled) ===")
    for p in ("M1", "M2"):
        for ps in sorted({k[3] for k in res if k[0] == p and k[4] == "prereg"}):
            ks = {k[1]: k for k in res if k[0] == p and k[3] == ps and k[4] == "prereg"}
            if "one" in ks and "six" in ks:
                a, b = res[ks["one"]]["all"], res[ks["six"]]["all"]
                print(f"{p} {ps:g}\": one: N={a['n']} zwid={a['z_width']:.2f} fscat={a['f_scatter_pct']:.2f}% "
                      f"slope={a['slope_sigma']:+.1f} sig | six: N={b['n']} zwid={b['z_width']:.2f} "
                      f"fscat={b['f_scatter_pct']:.2f}% slope={b['slope_sigma']:+.1f} sig")


# ---------------------------------------------------------------- figures

FIG_SET = [("P1 bilinear", ("P1", "-", "bilinear")), ("P1 browser mask", ("P1", "-", "bilinear", "browser")), ("P1native", ("P1native", None, None)),
           ("P2", ("P2", None, None)), ("M1 six", ("M1", "six", None)), ("M1 one", ("M1", "one", None)),
           ("M2 six", ("M2", "six", None)), ("M2 one", ("M2", "one", None))]


def pick(groups, spec):
    p, m, kern = spec[:3]
    mask = spec[3] if len(spec) > 3 else "prereg"
    cand = [k for k in groups if k[4] == mask and k[0] == p and (m is None or k[1] == m or (p == "P1" and k[1] in ("-", m)))
            and (kern is None or k[2] == kern) and default_scale(k)]
    if p == "P1":
        cand = [k for k in cand if k[2] == kern]
    return sorted(cand)[0] if cand else None


def fig_zhist(field, T, groups, path):
    present = [(lab, pick(groups, spec)) for lab, spec in FIG_SET]
    present = [(lab, k) for lab, k in present if k is not None]
    classes = [c for c in CLASSES if any((np.asarray(T[groups[k]]["pair_class"]) == c).any() for _, k in present)]
    if not present or not classes:
        return
    fig, axs = plt.subplots(1, len(classes), figsize=(5.2 * len(classes), 4.4), squeeze=False)
    bins = np.linspace(-6, 6, 61)
    xx = np.linspace(-6, 6, 400)
    cols = plt.cm.tab10(np.arange(len(present)))
    for ax, c in zip(axs[0], classes):
        for (lab, k), col in zip(present, cols):
            s = T[groups[k]]
            s = s[np.asarray(s["pair_class"]) == c]
            z = z_values(s["F_A"], s["F_B"], s["var_A"], s["var_B"])
            z = z[np.isfinite(z)]
            if z.size < 5:
                continue
            ax.hist(np.clip(z, -6, 6), bins=bins, density=True, histtype="step", color=col, lw=1.4,
                    label=f"{lab} w={mad_sigma(z):.2f} (N={z.size})")
        ax.plot(xx, np.exp(-xx**2 / 2) / np.sqrt(2 * np.pi), "k--", lw=1, label="unit normal")
        ax.set_xlabel("z = (F_A - F_B) / sqrt(var_A + var_B)")
        ax.set_ylabel("density")
        ax.set_title(f"{field}: pair class {c}")
        ax.legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def fig_color(field, T, groups, res, path):
    present = [(lab, pick(groups, spec)) for lab, spec in FIG_SET]
    present = [(lab, k) for lab, k in present if k is not None]
    if not present:
        return
    n = len(present)
    nc = min(4, n)
    nr = (n + nc - 1) // nc
    fig, axs = plt.subplots(nr, nc, figsize=(4.2 * nc, 3.6 * nr), squeeze=False, sharey=True)
    for ax in axs.ravel():
        ax.axis("off")
    for ax, (lab, k) in zip(axs.ravel(), present):
        ax.axis("on")
        s = T[groups[k]]
        f = frac_values(s["F_A"], s["F_B"])
        u, med, col = star_medians(np.asarray(s["source_id"]), 100 * f, s["bp_rp"])
        ax.plot(col, med, ".", ms=3, alpha=0.6, color="C0")
        r = res[k]["all"]
        if np.isfinite(r["slope_pct_per_mag"]) and u.size > 2:
            xs = np.array([col.min(), col.max()])
            ymid = np.median(med)
            ax.plot(xs, ymid + r["slope_pct_per_mag"] * (xs - np.median(col)), "r-", lw=1.5)
        ax.axhline(0, color="k", lw=0.6)
        ax.set_title(f"{lab}\nslope {r['slope_pct_per_mag']:+.3f}+-{r['slope_err']:.3f} %/mag "
                     f"({r['slope_sigma']:+.1f} sig)", fontsize=8)
        ax.set_xlabel("BP-RP")
        ax.set_ylabel("per-star median frac. diff. (%)")
        if u.size > 5:
            lim = 6 * mad_sigma(med) + 1e-9
            ax.set_ylim(np.median(med) - lim, np.median(med) + lim)
    fig.suptitle(f"{field}: fractional difference vs colour (all pair classes)", fontsize=10)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def fig_gap(field, groups, res, gb, path):
    if not gb:
        return
    fig, axs = plt.subplots(1, 2, figsize=(10, 4.2))
    x = np.arange(len(GAP_LABELS))
    for k, rows in gb.items():
        axs[0].plot(x, [r["z_width"] for r in rows], "o-", label=glabel(k))
        axs[1].plot(x, [r["f_scatter_pct"] for r in rows], "o-", label=glabel(k))
    for lab, spec in FIG_SET[4:]:
        k = pick(groups, spec)
        if k is None:
            continue
        r = res[k]["all"]
        ls = "--" if lab.endswith("six") else ":"
        axs[0].axhline(r["z_width"], ls=ls, color="C%d" % (3 + FIG_SET.index((lab, spec))), lw=1, label=lab)
        axs[1].axhline(r["f_scatter_pct"], ls=ls, color="C%d" % (3 + FIG_SET.index((lab, spec))), lw=1, label=lab)
    axs[0].axhline(1.0, color="k", lw=0.5)
    axs[0].set_ylabel("robust width of z")
    axs[1].set_ylabel("robust frac. scatter (%)")
    axs[1].set_yscale("log")
    for a in axs:
        a.set_xticks(x)
        a.set_xticklabels(GAP_LABELS)
        a.set_xlabel("wavelength gap (channels)")
    axs[0].legend(fontsize=7)
    fig.suptitle(f"{field}: plain differences vs wavelength gap; matched levels as lines")
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


# ---------------------------------------------------------------- results payload

def pack_group(r):
    out = {}
    for c, m in r.items():
        n = m["n"]
        out[c] = {
            "n_stars": m["n_stars"],
            "z_width": metric(m["z_width"], "1 (unit-normal = 1)", n, SCRIPT),
            "z_median": metric(m["z_median"], "1", n, SCRIPT),
            "frac_scatter": metric(m["f_scatter_pct"], "percent", n, SCRIPT),
            "frac_median": metric(m["f_median_pct"], "percent", n, SCRIPT),
            "slope": metric(m["slope_pct_per_mag"], "percent per mag BP-RP", m["n_stars_slope"], SCRIPT,
                            note=f"err {m['slope_err']:.4g}, {m['slope_sigma']:+.2f} sigma, "
                                 f"BP-RP {m['color_min']:.2f}-{m['color_max']:.2f}; clipped LS on per-star median, bootstrap over stars"),
            "slope_err": metric(m["slope_err"], "percent per mag BP-RP", m["n_stars_slope"], SCRIPT),
            "clean": bool(m["clean"]),
        }
    return out


# ---------------------------------------------------------------- driver

def run_field(field, indir, figdir, write=True, quiet=False):
    T, missing = load_tables(indir)
    if missing:
        print(f"[{field}] note: missing input tables, skipped: {', '.join(missing)}")
    if T is None:
        print(f"[{field}] no input tables in {indir}; nothing to do")
        return None
    groups = split_groups(T)
    res = analyse(T, groups)
    gb = gap_bins(T, groups)
    print_table(field, res)
    print_gap(field, gb)
    print_one_six(field, res)

    flagged, corr, med = variability(T, groups)
    print(f"\n=== {field}: variability check (|median z| > {OUTLIER_Z:g} in every product group where measured) ===")
    print(f"stars flagged: {len(flagged)}")
    if flagged:
        gaia = {}
        for sid, _ in flagged:
            i = np.where(np.asarray(T["source_id"]) == sid)[0][0]
            gaia[sid] = (float(T["G"][i]), float(T["bp_rp"][i]))
        for sid, ng in flagged:
            print(f"  source_id {sid}  G={gaia[sid][0]:.2f}  BP-RP={gaia[sid][1]:.2f}  groups={ng}")
    print("per-star median z correlation between product groups (Pearson r, N stars):")
    for (a, b), (r, n) in corr.items():
        print(f"  {glabel(a):24s} vs {glabel(b):24s} r={r:+.2f} N={n}")

    res2 = None
    if flagged:
        bad = {sid for sid, _ in flagged}
        keep = ~np.isin(np.asarray(T["source_id"]), list(bad))
        T2 = T[keep]
        res2 = analyse(T2, split_groups(T2))
        print_table(field, res2, title=f"SECONDARY: {len(bad)} flagged stars REMOVED")

    fig_zhist(field, T, groups, figdir / f"phaseb_z_hist_{field}.png")
    fig_color(field, T, groups, res, figdir / f"phaseb_frac_vs_color_{field}.png")
    fig_gap(field, groups, res, gb, figdir / f"phaseb_p1_vs_gap_{field}.png")
    print(f"figures written to {figdir}")

    if write:
        payload = {
            "script": SCRIPT,
            "definition": "z=(F_A-F_B)/sqrt(var_A+var_B), width=1.4826*MAD; frac=(F_A-F_B)/mean; slope: per-star median, "
                          "clipped LS, bootstrap(1000, seed) over stars; clean = width<1.5 and |slope|<2 sigma",
            "missing_products": missing,
            "groups": {glabel(k): pack_group(r) for k, r in res.items()},
            "gap_bins": {glabel(k): {r["label"]: {"n": r["n"], "z_width": metric(r["z_width"], "1", r["n"], SCRIPT),
                                                  "frac_scatter": metric(r["f_scatter_pct"], "percent", r["n"], SCRIPT)}
                                     for r in rows} for k, rows in gb.items()},
            "variability": {
                "n_flagged": metric(len(flagged), "stars", len(np.unique(T["source_id"])), SCRIPT,
                                    note=f"|median z|>{OUTLIER_Z:g} in every product group where measured, >=2 groups; kept in headline"),
                "flagged": [{"source_id": int(s), "G": float(T["G"][np.where(np.asarray(T['source_id']) == s)[0][0]]),
                             "bp_rp": float(T["bp_rp"][np.where(np.asarray(T['source_id']) == s)[0][0]]), "n_groups": g}
                            for s, g in flagged],
                "median_z_correlation": {f"{glabel(a)} vs {glabel(b)}": {"r": r, "n_stars": n} for (a, b), (r, n) in corr.items()},
            },
            "secondary_flagged_removed": ({glabel(k): pack_group(r) for k, r in res2.items()} if res2 else None),
        }
        update_results(f"phaseb_metrics_{field}", payload)
        print(f"results section phaseb_metrics_{field} written")
    return res, gb


# ---------------------------------------------------------------- synthetic test

SYN_SLOPE = -0.6        # percent per mag BP-RP planted in P1 bilinear
SYN_SIG_F = 0.01        # fractional noise per measurement (consistent with var)
SYN_GAP_EXTRA = 0.006   # extra fractional scatter per channel of gap in P1


def make_synthetic(outdir, seed=3):
    rng = np.random.default_rng(seed)
    nst = 300
    sid = np.arange(1000, 1000 + nst)
    G = rng.uniform(12, 16, nst)
    col = rng.uniform(0.8, 3.2, nst)
    flux = 3000 * 10 ** (-0.4 * (G - 13))
    rows = {p: [] for p in PRODUCTS}
    for pc, ncmp in (("6mo", 4), ("12mo", 4)):
        for i in range(nst):
            for j in range(ncmp):
                gap = float(rng.choice([0.2, 0.7, 1.5, 3, 6, 12]))
                for p, mode, kern, ps in (("P1", "-", "bilinear", 6.15), ("P1native", "-", "none", 6.15),
                                          ("M1", "six", "none", 6.15), ("M1", "one", "none", 6.15),
                                          ("M2", "six", "none", 6.15), ("P2", "-", "none", 6.15)):
                    F0 = flux[i]
                    sf = SYN_SIG_F
                    ftrue = 0.0
                    extra = 0.0
                    if p == "P1":
                        ftrue = SYN_SLOPE / 100 * (col[i] - 2.0)
                        extra = SYN_GAP_EXTRA * gap
                    if p == "P1native":
                        extra = SYN_GAP_EXTRA * gap * 0.5
                    # one star planted as variable in every product
                    if sid[i] == 1005:
                        ftrue += 0.3
                    FA = F0 * (1 + rng.normal(0, sf) + rng.normal(0, extra) / 2 ** 0.5)
                    FB = F0 * (1 - ftrue) * (1 + rng.normal(0, sf) + rng.normal(0, extra) / 2 ** 0.5)
                    var = (sf * F0) ** 2
                    rows[p].append((p, mode, kern, ps, "prereg", pc, int(sid[i]), G[i], col[i], gap, FA, FB, var, var))
                    if p == "P1":
                        rows[p].append((p, mode, kern, ps, "browser", pc, int(sid[i]), G[i], col[i], gap, FA, FB, var, var))
    names = ["product", "mode", "kernel", "pixscale", "mask", "pair_class", "source_id", "G", "bp_rp", "dlam_ch",
             "F_A", "F_B", "var_A", "var_B"]
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    for p, r in rows.items():
        t = Table(rows=r, names=names)
        t.write(outdir / f"fluxes_{p}.ecsv", overwrite=True)


def selftest():
    d = Path(tempfile.mkdtemp(prefix="wp_synth_"))
    make_synthetic(d)
    print(f"synthetic tables in {d}")
    out = run_field("synthetic", d, d, write=False)
    res, gb = out
    k = ("P1", "-", "bilinear", 6.15, "prereg")
    r = res[k]["all"]
    # planted slope: f = SYN_SLOPE/100*(c-2) with f in percent -> -1.5 %/mag
    dev = (r["slope_pct_per_mag"] - SYN_SLOPE) / r["slope_err"]
    ok_slope = abs(dev) < 3
    print(f"\nSELFTEST slope: planted {SYN_SLOPE:+.3f} %/mag, recovered {r['slope_pct_per_mag']:+.3f} +- "
          f"{r['slope_err']:.3f} ({dev:+.1f} sigma off) -> {'PASS' if ok_slope else 'FAIL'}")
    # gap trend: expected z width per bin for P1: sqrt(1 + (extra^2)/(2 sf^2)) with extra averaged over the bin
    gaps = {"0-0.5": 0.2, "0.5-1": 0.7, "1-2": 1.5, "2-4": 3, "4-8": 6, ">8": 12}
    ok_gap = True
    for row in gb[k]:
        ex = SYN_GAP_EXTRA * gaps[row["label"]]
        # FA, FB each carry extra/sqrt2 (so combined diff extra) ; var-based sigma = sqrt(2)*sf
        colvar = (SYN_SLOPE / 100) ** 2 * (2.4 ** 2 / 12)   # planted colour term adds variance too
        exp = np.sqrt((2 * SYN_SIG_F ** 2 + ex ** 2 + colvar) / (2 * SYN_SIG_F ** 2))
        good = abs(row["z_width"] - exp) / exp < 0.10
        ok_gap &= good
        print(f"SELFTEST gap bin {row['label']:>6s}: expected width {exp:.2f}, measured {row['z_width']:.2f} "
              f"(N={row['n']}) {'ok' if good else 'BAD'}")
    mono = all(gb[k][i]["z_width"] < gb[k][i + 1]["z_width"] for i in range(len(GAP_LABELS) - 1))
    print(f"SELFTEST gap trend monotonic increase: {mono}")
    m1 = res[("M1", "six", "none", 6.15, "prereg")]["all"]
    print(f"SELFTEST control M1 six: width {m1['z_width']:.2f}, slope {m1['slope_sigma']:+.1f} sigma, clean={m1['clean']}")
    print("SELFTEST overall:", "PASS" if (ok_slope and ok_gap and mono) else "FAIL")


# ---------------------------------------------------------------- PSF vs wavelength

def psf_vs_wavelength(figdir, write=True):
    """Median FWHM (2.355 sigma_gauss, arcsec) vs wavelength, G 12-14 stars, by detector."""
    root = DATA.parent
    fig, axs = plt.subplots(1, 2, figsize=(11, 4.4), squeeze=False)
    payload = {"script": SCRIPT, "selection": "phase A meas_<field>.ecsv, G 12-14, snr >= 10, finite sigma_gauss; "
               "FWHM = 2.355 * sigma_gauss * pixscale (pixel-integrated Gaussian fit)"}
    printed = []
    for ax, field in zip(axs[0], ["barnard", "epsindi"]):
        mf = DATA / "reg" / f"meas_{field}.ecsv"
        xf = DATA / f"index_{field}.csv"
        if not (mf.exists() and xf.exists()):
            ax.set_title(f"{field}: no phase A table")
            continue
        M = Table.read(mf)
        idx = Table.read(xf, format="ascii.csv")
        cuts = [(i, str(c)) for i, c in enumerate(idx["cutout_path"]) if str(c) and (root / str(c)).exists()]
        release = {fid: str(idx["release"][i]) for fid, (i, c) in enumerate(cuts)}
        G = np.asarray(M["G"], float)
        sig = np.asarray(M["sigma_gauss"], float)
        sel = (G >= 12) & (G <= 14) & (np.asarray(M["snr"], float) >= 10) & np.isfinite(sig) & (sig > 0)
        M = M[sel]
        lam = np.full(len(M), np.nan)
        bw = np.full(len(M), np.nan)
        fr = np.asarray(M["frame"]).astype(int)
        det = np.asarray(M["detector"]).astype(int)
        rel = np.array([release[f] for f in fr])
        for r in sorted(set(rel)):
            for d in sorted(set(det)):
                m = (rel == r) & (det == d)
                if m.any():
                    lam[m], bw[m] = W.cal_lambda(r, d, np.asarray(M["xdet_pred"])[m], np.asarray(M["ydet_pred"])[m])
        fwhm = 2.355 * np.asarray(M["sigma_gauss"], float) * np.asarray(M["pixscale"], float)
        good = np.isfinite(lam) & np.isfinite(fwhm)
        fp = {}
        print(f"\n=== PSF vs wavelength: {field} ({good.sum()} star-frame measurements, G 12-14) ===")
        print(f"{'det':>3s} {'lam range um':>14s} {'N':>6s} {'FWHM med as':>11s} {'slope as/um':>11s} "
              f"{'+-2.5bw frac change':>20s}")
        for d in sorted(set(det)):
            m = good & (det == d)
            if m.sum() < 50:
                continue
            L, F, B = lam[m], fwhm[m], bw[m]
            q = np.quantile(F, [0.01, 0.99])
            keep = (F > q[0]) & (F < q[1])
            L, F, B = L[keep], F[keep], B[keep]
            edges = np.quantile(L, np.linspace(0, 1, 9))
            cen, med, err = [], [], []
            for lo, hi in zip(edges[:-1], edges[1:]):
                b = (L >= lo) & (L <= hi)
                if b.sum() >= 10:
                    cen.append(np.median(L[b]))
                    med.append(np.median(F[b]))
                    err.append(1.2533 * mad_sigma(F[b]) / np.sqrt(b.sum()))
            ax.errorbar(cen, med, err, fmt="o-", ms=3, label=f"D{d}")
            slope = clipped_line(L, F)
            fmed = float(np.median(F))
            frac = slope * 5 * float(np.median(B)) / fmed
            print(f"{d:3d} {L.min():6.2f}-{L.max():5.2f} {len(L):6d} {fmed:11.2f} {slope:11.2f} {100 * frac:+19.1f}%")
            fp[f"D{d}"] = {
                "lam_range_um": [float(L.min()), float(L.max())],
                "fwhm_median": metric(fmed, "arcsec", len(L), SCRIPT),
                "fwhm_at_bins": {f"{c:.2f}um": float(v) for c, v in zip(cen, med)},
                "fwhm_slope": metric(float(slope), "arcsec per um", len(L), SCRIPT),
                "median_bandwidth": metric(float(np.median(B)), "um", len(L), SCRIPT),
                "frac_fwhm_change_pm2p5bw": metric(float(frac), "fraction", len(L), SCRIPT,
                                                   note="slope * 5 * median bandwidth / median FWHM"),
            }
        payload[field] = fp
        ax.set_xlabel("wavelength (um)")
        ax.set_ylabel("median FWHM (arcsec)")
        ax.set_title(f"{field}: G 12-14 PSF FWHM vs wavelength")
        ax.legend(fontsize=8, ncol=2)
        ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(figdir / "phaseb_psf_vs_lambda.png", dpi=130)
    plt.close(fig)
    if write:
        update_results("psf_vs_wavelength", payload)
        print("results section psf_vs_wavelength written")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", choices=["barnard", "epsindi", "all"], default="barnard")
    ap.add_argument("--selftest", action="store_true", help="synthetic recovery test; writes nothing to docs")
    ap.add_argument("--no-psf", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
        return
    FIGURES.mkdir(parents=True, exist_ok=True)
    fields = ["barnard", "epsindi"] if a.field == "all" else [a.field]
    for f in fields:
        run_field(f, DATA / "phaseb" / f, FIGURES, write=True)
    if not a.no_psf:
        psf_vs_wavelength(FIGURES)


if __name__ == "__main__":
    main()
