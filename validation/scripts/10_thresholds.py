"""10_thresholds: false-alarm calibration of the change readout on steady stars (docs/method.md, phase C
item 7).

usage: uv run python scripts/10_thresholds.py --field {barnard,epsindi,all} [--nboot N]

Sample : the phase B steady-star sample of each field (the stars of data/phaseb/<field>/forced_phot.ecsv:
         Gaia DR3 G 12 to 16.5, RUWE < 1.4, isolated, not VARIABLE). They are re-measured here with
         wp.m2ref (docs/algorithm.md, browser mask = BAD_DATA bits, inflated variance var + (0.02 F)^2)
         directly on the cutouts, at the Gaia position propagated to each exposure; lam and bw from the
         spectral WCS calibration at the star's detector pixel (wp.wavelength.cal_lambda).
Visits : every full visit (>= 12 exposures), every visit pair (A earlier, B later); per detector.
Unit   : one (star, detector, visit pair) with a combined result, for P1 (plain best pair, combined over
         the selected w0), PS (paired stack) and M2 (matched, combined). Also, as a supplement, the
         six-detector pooled value per (star, visit pair): inverse-variance mean of D over detectors.
Outputs: results section thresholds_<field>; figure docs/figures/thresholds_<field>.png;
         cache data/phasec/inj_thresholds_<field>.ecsv (one row per star, detector, pair).
Statistics: fraction of |z| >= 3, 4, 5 with Clopper-Pearson 68 percent intervals; robust width
1.4826 MAD(z); empirical 99th and 99.9th percentiles of |z| (thresholds for about 1 and 0.1 percent
false alarms) with 68 percent intervals from a bootstrap over stars.
"""
import argparse
import sys
import time
import warnings
from itertools import combinations
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from astropy.table import Table
from astropy.wcs import FITSFixedWarning
from scipy.stats import norm

from wp import m2ref
from wp.config import DATA, FIGURES, ROOT
from wp.detect import METHODS, binom_ci68, mad_width
from wp.gaia import propagate
from wp.results import metric, update_results
from wp.wavelength import cal_lambda

SCRIPT = "10_thresholds.py"
OUT_DIR = DATA / "phasec"
LEVELS = (3.0, 4.0, 5.0)
SEED = 20261114
warnings.simplefilter("ignore", FITSFixedWarning)


def full_visits(index):
    v, n = np.unique(np.asarray(index["visit"]), return_counts=True)
    return [int(a) for a, b in zip(v, n) if b >= m2ref.MIN_VISIT_EXPOSURES]


def measure_field(field):
    index = Table.read(DATA / f"index_{field}.csv")
    phot = Table.read(DATA / "phaseb" / field / "forced_phot.ecsv")
    gaia = Table.read(DATA / f"gaia_{field}.ecsv")
    sids = np.array(sorted({int(s) for s in phot["source_id"]}), np.int64)
    gsid = np.asarray(gaia["source_id"], np.int64)
    rows_g = np.array([int(np.nonzero(gsid == s)[0][0]) for s in sids])
    stars = gaia[rows_g]
    visits = full_visits(index)
    sel = np.isin(np.asarray(index["visit"]), visits) & np.array([str(x) == "True" for x in index["on_detector"]])
    meas = []           # (sid, det, visit, sample dict, saturated_any)
    for r in index[sel]:
        c = m2ref.load_cutout(ROOT / str(r["cutout_path"]))
        ra, dec, _ = propagate(stars, c["mjd"])
        xs, ys = c["wcs"].world_to_pixel_values(ra, dec)
        xs, ys = np.atleast_1d(xs), np.atleast_1d(ys)
        lam, bw = cal_lambda(c["release"], c["detector"], xs + c["x0"], ys + c["y0"])
        lam, bw = np.atleast_1d(lam), np.atleast_1d(bw)
        for k, sid in enumerate(sids):
            m = m2ref.measure_pixels(c["P"], c["V"], c["FL"], float(xs[k]), float(ys[k]))
            if m["reason"] == "outside_cutout":
                continue
            meas.append((int(sid), c["detector"], int(r["visit"]), dict(
                id=c["obs_id"], lam=float(lam[k]), bw=float(bw[k]), mjd=c["mjd"], flux=m["flux"], var=m["var"],
                saturated=m["saturated"]), bool(m["ok"]) and np.isfinite(lam[k])))
    G = dict(zip(sids.tolist(), np.asarray(stars["phot_g_mean_mag"], float).tolist()))
    blended = {int(s): m2ref.is_blended(float(stars["ra"][i]), float(stars["dec"][i]),
                                        float(stars["phot_g_mean_mag"][i]), gaia["ra"], gaia["dec"],
                                        gaia["phot_g_mean_mag"], star_index=int(rows_g[i]))
               for i, s in enumerate(sids)}
    return meas, visits, sids, G, blended


def compare_all(meas, visits, sids, G, blended):
    by = {}
    for sid, det, v, s, ok in meas:
        by.setdefault((sid, det, v), []).append((s, ok))
    rows = []
    for va, vb in combinations(sorted(visits), 2):
        for sid in sids:
            for det in range(1, 7):
                A = by.get((int(sid), det, va), [])
                B = by.get((int(sid), det, vb), [])
                sa = [s for s, ok in A if ok]
                sb = [s for s, ok in B if ok]
                if not sa or not sb:
                    continue
                # 'saturated' covers any measured exposure, also rejected ones (algorithm.md step 7)
                sat = any(s["saturated"] for s, _ in A + B)
                res = m2ref.compare_visits(sa, sb, blended=blended[int(sid)])
                flags = set(res["flags"]) | ({"saturated"} if sat else set())
                row = dict(source_id=int(sid), G=G[int(sid)], detector=det, visit_a=va, visit_b=vb,
                           n_a=len(sa), n_b=len(sb), n_w0=res["n_w0"], saturated="saturated" in flags,
                           flags=",".join(sorted(flags)))
                row["M2_D"], row["M2_var"] = (res["D"], res["var"]) if res["per_w0"] else (np.nan, np.nan)
                pl = res["plain"]
                row["P1_D"], row["P1_var"] = (pl["D"], pl["var"]) if pl else (np.nan, np.nan)
                ps = res["ps"]
                row["PS_D"], row["PS_var"] = (ps["D"], ps["var"]) if ps["n_pairs"] else (np.nan, np.nan)
                for m in METHODS:
                    row[f"{m}_z"] = row[f"{m}_D"] / np.sqrt(row[f"{m}_var"])
                rows.append(row)
    return Table(rows=rows)


def pooled(t):
    """Six-detector pooled z per (star, visit pair): inverse-variance mean of D over detectors."""
    out = []
    keys = sorted({(int(a), int(b), int(c)) for a, b, c in zip(t["source_id"], t["visit_a"], t["visit_b"])})
    sid, va, vb = (np.asarray(t[c]) for c in ("source_id", "visit_a", "visit_b"))
    for k in keys:
        m = (sid == k[0]) & (va == k[1]) & (vb == k[2])
        row = dict(source_id=k[0], visit_a=k[1], visit_b=k[2], saturated=bool(np.any(np.asarray(t["saturated"])[m])))
        for meth in METHODS:
            D = np.asarray(t[f"{meth}_D"])[m]
            v = np.asarray(t[f"{meth}_var"])[m]
            g = np.isfinite(D) & np.isfinite(v) & (v > 0)
            if g.any():
                w = 1 / v[g]
                Dm, vm = np.sum(w * D[g]) / w.sum(), 1 / w.sum()
                row[f"{meth}_z"] = Dm / np.sqrt(vm)
            else:
                row[f"{meth}_z"] = np.nan
            row[f"{meth}_ndet"] = int(g.sum())
        out.append(row)
    return Table(rows=out)


def summarize(z, star_ids, nboot, rng):
    """Fractions at the levels, robust width, empirical 99 / 99.9 percentiles of |z| with bootstrap."""
    z = np.asarray(z, float)
    ok = np.isfinite(z)
    z, star_ids = z[ok], np.asarray(star_ids)[ok]
    a = np.abs(z)
    n = int(a.size)
    res = dict(n=n, width=mad_width(z), median=float(np.median(z)) if n else np.nan)
    for L in LEVELS:
        k = int(np.sum(a >= L))
        lo, hi = binom_ci68(k, n)
        res[f"frac_ge{int(L)}"] = dict(k=k, frac=k / n if n else np.nan, lo68=lo, hi68=hi,
                                       normal=float(2 * norm.sf(L)))
    q = np.quantile(a, [0.99, 0.999]) if n else [np.nan, np.nan]
    us = np.unique(star_ids)
    groups = [np.nonzero(star_ids == s)[0] for s in us]
    bq = np.empty((nboot, 2))
    for b in range(nboot):
        pick = rng.integers(0, len(us), len(us))
        idx = np.concatenate([groups[i] for i in pick])
        bq[b] = np.quantile(a[idx], [0.99, 0.999])
    res["q99"] = dict(value=float(q[0]), lo68=float(np.percentile(bq[:, 0], 15.865)),
                      hi68=float(np.percentile(bq[:, 0], 84.135)))
    res["q999"] = dict(value=float(q[1]), lo68=float(np.percentile(bq[:, 1], 15.865)),
                       hi68=float(np.percentile(bq[:, 1], 84.135)),
                       note=f"{n} values: the 99.9th percentile rests on the top {max(1, round(n * 0.001))} value(s)")
    return res


def survival_plot(field, t, tp):
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.4), sharey=True)
    zz = np.linspace(0, 8, 400)
    cols = {"P1": "#c0392b", "PS": "#2471a3", "M2": "#1e8449"}
    for ax, tab, title in ((axes[0], t, "per (star, detector, visit pair)"),
                           (axes[1], tp, "six detectors pooled, per (star, visit pair)")):
        for m in METHODS:
            a = np.abs(np.asarray(tab[f"{m}_z"], float))
            a = np.sort(a[np.isfinite(a)])
            if not a.size:
                continue
            surv = 1.0 - np.arange(a.size) / a.size
            ax.step(a, surv, where="post", color=cols[m], label=f"{m} (N={a.size}, width {mad_width(np.asarray(tab[f'{m}_z'], float)):.2f})")
        ax.plot(zz, 2 * norm.sf(zz), "k--", lw=1, label="unit normal")
        for L in LEVELS:
            ax.axvline(L, color="0.8", lw=0.8, zorder=0)
        ax.set_yscale("log")
        ax.set_ylim(3e-4, 1.2)
        ax.set_xlim(0, 8)
        ax.set_xlabel("|z| (inflated variance)")
        ax.set_title(title, fontsize=10)
        ax.legend(fontsize=8)
    axes[0].set_ylabel("fraction with |z| >= value")
    fig.suptitle(f"False alarms on steady stars, {field}: |z| survival", fontsize=11)
    fig.tight_layout()
    FIGURES.mkdir(parents=True, exist_ok=True)
    p = FIGURES / f"thresholds_{field}.png"
    fig.savefig(p, dpi=130)
    plt.close(fig)
    return p


def run(field, nboot):
    t0 = time.time()
    meas, visits, sids, G, blended = measure_field(field)
    t = compare_all(meas, visits, sids, G, blended)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    t.write(OUT_DIR / f"inj_thresholds_{field}.ecsv", overwrite=True)
    tp = pooled(t)
    rng = np.random.default_rng(SEED)
    res = dict(script=SCRIPT, field=field, visits=visits,
               visit_pairs=[f"{a}-{b}" for a, b in combinations(sorted(visits), 2)],
               n_stars=int(len(sids)),
               sample="phase B steady-star sample (stars of forced_phot.ecsv), re-measured with wp.m2ref on the "
                      "cutouts (browser mask), inflated variance; one value per (star, detector, visit pair)",
               per_detector={}, six_pooled={}, per_detector_unsaturated={}, recommendation={})
    for m in METHODS:
        res["per_detector"][m] = summarize(t[f"{m}_z"], t["source_id"], nboot, rng)
        uns = ~np.asarray(t["saturated"], bool)
        res["per_detector_unsaturated"][m] = summarize(np.asarray(t[f"{m}_z"])[uns], np.asarray(t["source_id"])[uns],
                                                       nboot, rng)
        res["six_pooled"][m] = summarize(tp[f"{m}_z"], tp["source_id"], nboot, rng)
    for m in METHODS:
        s = res["per_detector"][m]
        res["recommendation"][m] = dict(
            threshold_1pct=metric(round(s["q99"]["value"], 2), "|z|", n=s["n"], script=SCRIPT,
                                  note=f"empirical 99th percentile of |z|, 68% bootstrap over stars "
                                       f"{s['q99']['lo68']:.2f} to {s['q99']['hi68']:.2f}"),
            threshold_0p1pct=metric(round(s["q999"]["value"], 2), "|z|", n=s["n"], script=SCRIPT,
                                    note=f"empirical 99.9th percentile of |z|, 68% bootstrap over stars "
                                         f"{s['q999']['lo68']:.2f} to {s['q999']['hi68']:.2f}; " + s["q999"]["note"]))
    res["figure"] = str(survival_plot(field, t, tp).relative_to(FIGURES.parent.parent))
    res["runtime_s"] = round(time.time() - t0, 1)
    update_results(f"thresholds_{field}", res)

    print(f"\n== thresholds_{field}: {len(sids)} stars, visits {visits}, runtime {res['runtime_s']} s")
    for lab, block in (("per (star, det, pair)", res["per_detector"]), ("unsaturated only", res["per_detector_unsaturated"]),
                       ("six pooled (star, pair)", res["six_pooled"])):
        print(f"  {lab}")
        print("    method     N  width  |z|>=3 [68%]            |z|>=4 [68%]            |z|>=5 [68%]            q99 [68%]          q99.9 [68%]")
        for m in METHODS:
            s = block[m]
            fr = "  ".join(f"{100 * s[f'frac_ge{L}']['frac']:5.2f}% [{100 * s[f'frac_ge{L}']['lo68']:.2f},{100 * s[f'frac_ge{L}']['hi68']:.2f}]"
                           for L in (3, 4, 5))
            print(f"    {m:4s} {s['n']:6d} {s['width']:6.3f}  {fr}   {s['q99']['value']:5.2f} [{s['q99']['lo68']:.2f},{s['q99']['hi68']:.2f}]"
                  f"   {s['q999']['value']:5.2f} [{s['q999']['lo68']:.2f},{s['q999']['hi68']:.2f}]")
    print(f"  unit normal: |z|>=3 {100 * 2 * norm.sf(3):.3f}%, >=4 {100 * 2 * norm.sf(4):.4f}%, >=5 {100 * 2 * norm.sf(5):.5f}%")
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", default="all", choices=["barnard", "epsindi", "all"])
    ap.add_argument("--nboot", type=int, default=1000)
    a = ap.parse_args()
    for f in (["barnard", "epsindi"] if a.field == "all" else [a.field]):
        run(f, a.nboot)


if __name__ == "__main__":
    main()
