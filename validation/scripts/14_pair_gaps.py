"""14: best single-exposure wavelength gap between two visits, per detector (index only, no pixel downloads).

usage: uv run python scripts/14_pair_gaps.py [--refresh-rdra]

For Eps Indi and Barnard (data/index_<field>.csv) and R Dra (SIA2 query, then the IMAGE header of every
exposure for the WCS; stored in data/rdra_index.csv): wavelength and bandwidth of every exposure at the target
pixel from the spectral WCS calibration (wp.wavelength.cal_lambda, nearest pixel). Visits: a gap of more than
30 d starts a visit, clusters of fewer than 12 exposures are excluded (the library's inStack rule). For every
visit pair about 6 months (120-240 d between visit mean epochs) or 12 months (300-430 d) apart, and for every
detector, the best pair is the minimum over exposure pairs (one from each visit, same detector) of
|lam_A - lam_B| / mean(bw_A, bw_B), a gap in channel widths. The question (roundtable 11): is the best pair
always under 0.95 channel, and do partial visits break that? Partial visits (fewer than 12 exposures, or a
detector with very few exposures) are listed separately.
Outputs: docs/figures/pair_gaps.png, data/rdra_index.csv, docs/results.json section "pair_gaps".
"""
import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from astropy.table import Table  # noqa: E402

from wp import io as wio  # noqa: E402
from wp.config import DATA, FIGURES, REPO  # noqa: E402
from wp.exposures import assign_visits, pair_class, query_exposures  # noqa: E402
from wp.results import metric, update_results  # noqa: E402
from wp.wavelength import cal_lambda  # noqa: E402

VISIT_GAP_D = 30.0
MIN_EXPOSURES = 12
THRESH = 0.95
RDRA = dict(ra=248.1673783672889, dec=66.75500674547219)     # research/samples/exposure-lists/r-dra.json, 2016.0
RDRA_CSV = DATA / "rdra_index.csv"


def log(*a):
    print(*a, flush=True)


def rdra_index(refresh=False):
    """SIA2 query + IMAGE header per exposure -> target pixel; cached as data/rdra_index.csv."""
    if RDRA_CSV.exists() and not refresh:
        return Table.read(RDRA_CSV)
    import time
    for k in range(6):
        try:
            tab, info = query_exposures(RDRA["ra"], RDRA["dec"])
            break
        except Exception as e:      # noqa: BLE001  (IRSA returns transient 502/504)
            log(f"SIA2 attempt {k + 1} failed: {e!r}")
            time.sleep(10 * (k + 1))
    else:
        raise SystemExit("IRSA SIA2 unavailable")
    log(f"R Dra SIA2: {info['n_raw']} raw rows, {len(tab)} science exposures after dedup "
        f"(dr1 {info['n_dr1']}, qr3 {info['n_qr3']})")

    def one(r):
        try:
            h = wio.read_image_header(str(r["s3_key"]))
            x, y, on = wio.target_pixel(h, RDRA["ra"], RDRA["dec"])
            return x, y, on
        except Exception as e:      # noqa: BLE001
            return np.nan, np.nan, False

    rows = list(tab)
    with ThreadPoolExecutor(max_workers=12) as ex:
        out = list(ex.map(one, rows))
    tab["target_x"] = [o[0] for o in out]
    tab["target_y"] = [o[1] for o in out]
    tab["on_detector"] = [bool(o[2]) for o in out]
    tab["visit"] = -1
    tab.write(RDRA_CSV, overwrite=True)
    return tab


def with_wavelength(tab):
    lam = np.full(len(tab), np.nan)
    bw = np.full(len(tab), np.nan)
    det = np.asarray(tab["detector"]).astype(int)
    rel = np.asarray(tab["release"]).astype(str)
    for d in np.unique(det):
        for r in np.unique(rel):
            m = (det == d) & (rel == r) & np.asarray(tab["on_detector"]).astype(bool)
            if m.any():
                l, b = cal_lambda(r, int(d), np.asarray(tab["target_x"])[m], np.asarray(tab["target_y"])[m])
                lam[m], bw[m] = l, b
    return lam, bw


def analyse(name, tab):
    on = np.asarray(tab["on_detector"]).astype(bool)
    tab = tab[on]
    lam, bw = with_wavelength(tab)
    mjd = np.asarray(tab["mjd_mid"], float)
    det = np.asarray(tab["detector"]).astype(int)
    vis = assign_visits(mjd, gap=VISIT_GAP_D)
    nv = vis.max() + 1
    cnt = np.bincount(vis, minlength=nv)
    visits = []
    for v in range(nv):
        m = vis == v
        per_det = {int(d): int(np.sum(m & (det == d))) for d in range(1, 7)}
        visits.append(dict(visit=v, n=int(cnt[v]), mjd_mean=float(mjd[m].mean()), mjd_span=float(np.ptp(mjd[m])),
                           per_detector=per_det, full=bool(cnt[v] >= MIN_EXPOSURES)))
    pairs = []
    for i in range(nv):
        for j in range(i + 1, nv):
            dt = visits[j]["mjd_mean"] - visits[i]["mjd_mean"]
            cl = pair_class(dt)
            if cl not in ("6mo", "12mo"):
                continue
            rec = dict(a=i, b=j, dt=float(dt), cls=cl, both_full=bool(visits[i]["full"] and visits[j]["full"]), det={})
            for d in range(1, 7):
                ma = (vis == i) & (det == d) & np.isfinite(lam)
                mb = (vis == j) & (det == d) & np.isfinite(lam)
                na, nb = int(ma.sum()), int(mb.sum())
                if na == 0 or nb == 0:
                    rec["det"][d] = dict(na=na, nb=nb, best=None, frac_within_1=None)
                    continue
                gap = np.abs(lam[ma][:, None] - lam[mb][None, :]) / (0.5 * (bw[ma][:, None] + bw[mb][None, :]))
                best = float(gap.min())
                partner_a = gap.min(axis=1)
                partner_b = gap.min(axis=0)
                allp = np.concatenate([partner_a, partner_b])
                rec["det"][d] = dict(na=na, nb=nb, best=best, frac_within_1=float(np.mean(allp <= 1.0)),
                                     partner_gaps=allp.tolist())
            pairs.append(rec)
    return dict(name=name, n_exposures=int(len(tab)), visits=visits, pairs=pairs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh-rdra", action="store_true")
    args = ap.parse_args()
    FIGURES.mkdir(parents=True, exist_ok=True)
    fields = {}
    for f in ("epsindi", "barnard"):
        fields[f] = Table.read(DATA / f"index_{f}.csv")
    fields["rdra"] = rdra_index(args.refresh_rdra)
    out = {}
    for f, t in fields.items():
        out[f] = analyse(f, t)
        log(f"\n=== {f}: {out[f]['n_exposures']} on-detector exposures, visits (gap > {VISIT_GAP_D:.0f} d):")
        for v in out[f]["visits"]:
            log("  visit %d: n=%3d  mean MJD %.1f  span %5.1f d  per detector %s  %s" % (
                v["visit"], v["n"], v["mjd_mean"], v["mjd_span"], [v["per_detector"][d] for d in range(1, 7)],
                "" if v["full"] else "(partial, excluded from the stack rule)"))
        log("  best single-exposure pair gap (channel widths), per detector D1..D6; n = exposures in visit A / visit B")
        for p in out[f]["pairs"]:
            cells = []
            for d in range(1, 7):
                r = p["det"][d]
                cells.append("  --  " if r["best"] is None else "%.3f" % r["best"])
            ns = " ".join("%d/%d" % (p["det"][d]["na"], p["det"][d]["nb"]) for d in range(1, 7))
            log("  %-4s visits %d-%d dt %6.1f d %s  best: %s  n: %s" % (
                p["cls"], p["a"], p["b"], p["dt"], "full   " if p["both_full"] else "PARTIAL", "  ".join(cells), ns))

    # summary against the 0.95 channel question
    summ = {}
    for f in out:
        full = [(p, d, p["det"][d]) for p in out[f]["pairs"] if p["both_full"] for d in range(1, 7) if p["det"][d]["best"] is not None]
        part = [(p, d, p["det"][d]) for p in out[f]["pairs"] if not p["both_full"] for d in range(1, 7) if p["det"][d]["best"] is not None]
        miss = [(p, d) for p in out[f]["pairs"] if p["both_full"] for d in range(1, 7) if p["det"][d]["best"] is None]
        bf = np.array([r["best"] for _, _, r in full]) if full else np.array([])
        bp = np.array([r["best"] for _, _, r in part]) if part else np.array([])
        fw = [r["frac_within_1"] for _, _, r in full]
        summ[f] = dict(
            n_full_pair_detectors=len(full),
            full_max_best_gap=float(bf.max()) if bf.size else None,
            full_all_under_095=bool(np.all(bf < THRESH)) if bf.size else None,
            full_n_over_095=int(np.sum(bf >= THRESH)) if bf.size else 0,
            partial_n=len(part), partial_max_best_gap=float(bp.max()) if bp.size else None,
            partial_n_over_095=int(np.sum(bp >= THRESH)) if bp.size else 0,
            missing_detector_in_full_pairs=[(p["a"], p["b"], d) for p, d in miss],
            median_frac_partner_within_1=float(np.median(fw)) if fw else None,
            min_frac_partner_within_1=float(np.min(fw)) if fw else None)
        log(f"\n{f}: full-visit pairs {len(full)} (pair x detector): worst best-gap {summ[f]['full_max_best_gap']}; "
            f"all < {THRESH}: {summ[f]['full_all_under_095']}; over {THRESH}: {summ[f]['full_n_over_095']}; "
            f"partial-visit pairs {len(part)}: worst {summ[f]['partial_max_best_gap']}, over {THRESH}: {summ[f]['partial_n_over_095']}; "
            f"missing detector in full pairs: {summ[f]['missing_detector_in_full_pairs']}; "
            f"share of exposures with a same-detector partner within 1 channel: median {summ[f]['median_frac_partner_within_1']}, "
            f"min {summ[f]['min_frac_partner_within_1']}")

    # figure
    fig, ax = plt.subplots(1, 3, figsize=(17, 5.2))
    cols = dict(epsindi="tab:red", barnard="tab:blue", rdra="tab:green")
    mk = {"6mo": "o", "12mo": "s"}
    off = dict(epsindi=-0.22, barnard=0.0, rdra=0.22)
    for f in out:
        for p in out[f]["pairs"]:
            for d in range(1, 7):
                r = p["det"][d]
                if r["best"] is None:
                    ax[0].plot(d + off[f], 0.0, "x", c="k", ms=6)
                    continue
                ax[0].plot(d + off[f] + (0.04 if p["cls"] == "12mo" else -0.04), r["best"], mk[p["cls"]], c=cols[f],
                           mfc=cols[f] if p["both_full"] else "none", ms=6, alpha=0.85)
    ax[0].axhline(THRESH, c="k", ls="--", lw=0.8)
    ax[0].axhline(1.0, c="gray", ls=":", lw=0.8)
    ax[0].set_xlabel("detector")
    ax[0].set_ylabel("best single-exposure pair gap (channel widths)")
    ax[0].set_title("best pair per detector and visit pair\n(red Eps Indi, blue Barnard, green R Dra; circle 6 mo, square 12 mo; open = partial visit; x = detector missing)", fontsize=8)
    ax[0].set_xticks(range(1, 7))
    # distribution of partner gaps
    for cls, a in (("6mo", ax[1]), ("12mo", ax[2])):
        for f in out:
            g = []
            for p in out[f]["pairs"]:
                if p["cls"] != cls or not p["both_full"]:
                    continue
                for d in range(1, 7):
                    if p["det"][d]["best"] is not None:
                        g += p["det"][d]["partner_gaps"]
            if g:
                g = np.sort(np.array(g))
                a.plot(g, np.arange(1, len(g) + 1) / len(g), c=cols[f], label=f"{f} (n={len(g)})")
        a.axvline(1.0, c="gray", ls=":")
        a.axvline(THRESH, c="k", ls="--", lw=0.8)
        a.set_xlim(0, 6)
        a.set_xlabel("gap to the best partner in the other visit (channel widths)")
        a.set_ylabel("cumulative fraction of exposures")
        a.set_title(f"every exposure of a full-visit {cls} pair", fontsize=9)
        a.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(FIGURES / "pair_gaps.png", dpi=110)
    plt.close(fig)
    log("wrote pair_gaps.png")

    res = dict(script="14_pair_gaps.py", visit_gap_d=VISIT_GAP_D, min_exposures=MIN_EXPOSURES, threshold_channels=THRESH,
               summary=summ, fields={f: dict(n_exposures=out[f]["n_exposures"], visits=out[f]["visits"],
                                             pairs=[{k: (v if k != "det" else {d: {kk: vv for kk, vv in r.items() if kk != "partner_gaps"} for d, r in v.items()}) for k, v in p.items()} for p in out[f]["pairs"]])
                                    for f in out})
    update_results("pair_gaps", json.loads(json.dumps(res, default=float)))
    log("wrote results section pair_gaps")


if __name__ == "__main__":
    main()
