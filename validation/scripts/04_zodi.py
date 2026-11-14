"""04: is IMAGE - ZODI flat? Residual statistics on cutouts after masking bad pixels.

usage: uv run python scripts/04_zodi.py --field {epsindi,barnard,all}
Needs cutouts data/cutouts/<field>/<OBSID>_D<det>.fits (HDUs: IMAGE, FLAGS, VARIANCE, ZODI).
~6 cutouts per field: one per detector, spread over the visits.
"""
import argparse
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clip

from wp import wavelength as W
from wp.config import DATA, FIELDS, FIGURES, RESULTS_JSON
from wp.results import metric, update_results

SCRIPT = "04_zodi.py"

# Fallback bit numbers (checked against MSKN keys of a real FLAGS header: same).
BIT_FALLBACK = {"TRANSIENT": 0, "OVERFLOW": 1, "NONFUNC": 6, "MISSING_DATA": 9, "HOT": 10, "COLD": 11,
                "NONLINEAR": 15, "PERSIST": 17, "OUTLIER": 19, "SOURCE": 21, "GHOST": 22, "STREAK": 25,
                "BLOOM": 26, "HALO": 28}
BAD_NAMES = ["SOURCE", "TRANSIENT", "OVERFLOW", "NONFUNC", "HOT", "COLD", "NONLINEAR", "PERSIST",
             "MISSING_DATA", "BLOOM", "HALO", "GHOST", "STREAK", "OUTLIER"]


def mask_value(flag_header, names):
    """Bitmask from MSKN/MSKM header keys when present, else fallback bit numbers."""
    by_name = {}
    if flag_header is not None:
        for k in flag_header:
            if k.startswith("MSKN"):
                by_name[str(flag_header[k]).strip()] = int(flag_header["MSKM" + k[4:]])
    m, missing = 0, []
    for n in names:
        if n in by_name:
            m |= by_name[n]
        elif flag_header is None or not by_name:
            m |= 1 << BIT_FALLBACK[n]
        else:
            missing.append(n)  # name absent from this header: no such bit defined
    return m, missing


def merge_section(section, new):
    old = {}
    if RESULTS_JSON.exists():
        old = json.loads(RESULTS_JSON.read_text() or "{}").get(section, {})
    old.update(new)
    update_results(section, old)


def list_cutouts(field):
    d = DATA / "cutouts" / field
    files = sorted(d.glob("*.fits")) if d.exists() else []
    out = []
    for f in files:
        with fits.open(f) as h:
            p = h[0].header
            out.append(dict(path=f, obsid=p.get("OBSID"), det=int(p.get("DETECTOR")), mjd=float(p.get("MJD-AVG", 0)),
                            visit=p.get("VISIT"), release=str(p.get("RELEASE", "dr1")).lower(),
                            x0=int(p.get("X0", 0)), y0=int(p.get("Y0", 0))))
    return out


def pick(cuts):
    """One cutout per detector, cycling through visits so different epochs are used."""
    chosen = []
    visits = sorted({c["visit"] for c in cuts}, key=lambda v: (v is None, v))
    for d in range(1, 7):
        cd = sorted([c for c in cuts if c["det"] == d], key=lambda c: c["mjd"])
        if not cd:
            continue
        cd_by_visit = {}
        for c in cd:
            cd_by_visit.setdefault(c["visit"], []).append(c)
        vs = sorted(cd_by_visit, key=lambda v: (v is None, v))
        v = vs[((d - 1) * max(len(vs) - 1, 1) // 5) % len(vs)] if len(vs) > 1 else vs[0]
        lst = cd_by_visit[v]
        chosen.append(lst[len(lst) // 2])
    return chosen


def analyse(c, use_source=True):
    with fits.open(c["path"]) as h:
        img = np.array(h["IMAGE"].data, float)
        flg = np.array(h["FLAGS"].data).astype(np.int64)
        var = np.array(h["VARIANCE"].data, float)
        zod = np.array(h["ZODI"].data, float)
        fh = h["FLAGS"].header
    names = [n for n in BAD_NAMES if use_source or n != "SOURCE"]
    mv, missing = mask_value(fh, names)
    bad = (flg & mv) != 0
    R = img - zod
    good = ~bad & np.isfinite(R) & np.isfinite(zod) & np.isfinite(var)
    Rm = np.ma.array(R, mask=~good)
    clipped = sigma_clip(Rm, sigma=3, maxiters=5, masked=True)
    keep = ~np.ma.getmaskarray(clipped)
    out = dict(n_total=R.size, n_flag_masked=int(bad.sum()), n_good=int(good.sum()), n_used=int(keep.sum()))
    if keep.sum() < 50:
        out["ok"] = False
        return out, R, keep
    yy, xx = np.indices(R.shape)
    xs, ys = (xx[keep] - R.shape[1] / 2) / 100.0, (yy[keep] - R.shape[0] / 2) / 100.0
    A = np.column_stack([np.ones(keep.sum()), xs, ys])
    coef, *_ = np.linalg.lstsq(A, R[keep], rcond=None)
    r = R[keep]
    out.update(ok=True, med_R=float(np.median(r)), med_Z=float(np.median(zod[keep])),
               ratio=float(np.median(r) / np.median(zod[keep])),
               grad_x=float(coef[1]), grad_y=float(coef[2]),
               noise=float(1.4826 * np.median(np.abs(r - np.median(r)))),
               med_sqrtvar=float(np.median(np.sqrt(var[keep]))), missing_bits=missing,
               shape=R.shape)
    return out, R, keep


def run_field(field):
    cuts = list_cutouts(field)
    if not cuts:
        print(f"[{field}] no cutouts in data/cutouts/{field}; skipping")
        return None
    sel = pick(cuts)
    print(f"\n=== {field}: {len(sel)} cutouts of {len(cuts)} ===")
    hdr = ("obsid               det lam(um) shape     n_used/n_tot  src_mask%  medR(MJy/sr) medZ    R/Z      "
           "gradx   grady (per 100px)  noise   med sqrtVAR")
    print(hdr)
    res, panels = {}, []
    for c in sel:
        o, R, keep = analyse(c, True)
        o2, _, _ = analyse(c, False)
        with fits.open(c["path"]) as h:
            sh = h["IMAGE"].data.shape
        lam, bw = W.cal_lambda(c["release"], c["det"], c["x0"] + sh[1] / 2, c["y0"] + sh[0] / 2)
        tag = f"{field}_{c['obsid']}_D{c['det']}"
        if not o.get("ok"):
            print(f"{c['obsid']} D{c['det']}: too few unmasked pixels with SOURCE masked ({o['n_good']}); "
                  f"without SOURCE mask: {o2.get('n_used')}")
            res[f"{tag}_n_used"] = metric(o["n_used"], "pixels", o["n_total"], SCRIPT, "all pixels masked (SOURCE etc.)")
            if not o2.get("ok"):
                continue
            o, note = o2, "SOURCE bit NOT masked (too few pixels otherwise)"
        else:
            note = "SOURCE masked"
        src_frac = 100.0 * (o2["n_good"] - o["n_good"]) / o["n_total"] if o2.get("ok") else float("nan")
        print(f"{c['obsid']:19s} D{c['det']} {lam:6.3f} {sh[0]}x{sh[1]} {o['n_used']:6d}/{o['n_total']:<6d} {src_frac:7.1f}   "
              f"{o['med_R']:10.4f} {o['med_Z']:8.3f} {o['ratio']:8.4f} {o['grad_x']:8.4f} {o['grad_y']:8.4f}   "
              f"{o['noise']:7.4f} {o['med_sqrtvar']:7.4f}  [{note}]")
        u = "MJy/sr"
        res[f"{tag}_median_resid"] = metric(o["med_R"], u, o["n_used"], SCRIPT, f"IMAGE-ZODI, lambda={lam:.3f} um, {note}")
        res[f"{tag}_median_zodi"] = metric(o["med_Z"], u, o["n_used"], SCRIPT)
        res[f"{tag}_resid_over_zodi"] = metric(o["ratio"], "ratio", o["n_used"], SCRIPT)
        res[f"{tag}_grad_x"] = metric(o["grad_x"], u + " per 100 px", o["n_used"], SCRIPT, "plane fit to residual, x = column")
        res[f"{tag}_grad_y"] = metric(o["grad_y"], u + " per 100 px", o["n_used"], SCRIPT, "plane fit to residual, y = row")
        res[f"{tag}_robust_noise"] = metric(o["noise"], u, o["n_used"], SCRIPT, "1.4826*MAD of clipped residual per pixel")
        res[f"{tag}_median_sqrt_variance"] = metric(o["med_sqrtvar"], u, o["n_used"], SCRIPT)
        if o2.get("ok"):
            res[f"{tag}_source_masked_fraction"] = metric(src_frac, "percent of pixels", o["n_total"], SCRIPT, "extra pixels removed by SOURCE bit")
        panels.append((c, lam, o, np.where(keep, R, np.nan)))

    if panels:
        scale = 3.0 * float(np.median([p[2]["noise"] for p in panels]))
        n = len(panels)
        cols = min(3, n)
        rows_ = int(np.ceil(n / cols))
        fig, axes = plt.subplots(rows_, cols, figsize=(4.2 * cols, 4.0 * rows_), squeeze=False)
        cmap = plt.get_cmap("RdBu_r").copy()
        cmap.set_bad("0.75")
        im = None
        for ax in axes.ravel():
            ax.axis("off")
        for ax, (c, lam, o, Rk) in zip(axes.ravel(), panels):
            ax.axis("on")
            im = ax.imshow(Rk, origin="lower", cmap=cmap, vmin=-scale, vmax=scale)
            ax.set_title(f"{c['obsid']} D{c['det']} {lam:.2f} um\nmedian {o['med_R']:.3f}, noise {o['noise']:.3f} MJy/sr", fontsize=8)
            ax.set_xlabel("cutout x (px)", fontsize=8)
            ax.set_ylabel("cutout y (px)", fontsize=8)
            ax.tick_params(labelsize=7)
        fig.suptitle(f"{FIELDS[field]['name']}: IMAGE - ZODI after masking and 3-sigma clipping (grey = masked); shared scale +-{scale:.3f} MJy/sr", fontsize=9)
        fig.tight_layout(rect=(0, 0, 0.92, 0.95))
        cax = fig.add_axes((0.93, 0.15, 0.015, 0.7))
        fig.colorbar(im, cax=cax, label="IMAGE - ZODI (MJy/sr)")
        FIGURES.mkdir(parents=True, exist_ok=True)
        out = FIGURES / f"zodi_residual_{field}.png"
        fig.savefig(out, dpi=150)
        plt.close(fig)
        print(f"wrote {out}")
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", default="all", choices=["epsindi", "barnard", "all"])
    a = ap.parse_args()
    for f in (list(FIELDS) if a.field == "all" else [a.field]):
        res = run_field(f)
        if res:
            merge_section("zodi_flatness", res)
    print("results:", RESULTS_JSON)


if __name__ == "__main__":
    main()
