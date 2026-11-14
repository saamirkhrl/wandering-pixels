"""Phase B: is the 2 percent error floor a visit-to-visit (release-to-release) zero-point offset?

One command: uv run python scripts/07d_zeropoint.py [--write-results]

Sample and fluxes: exactly those of 07c_error_floor.py (M2one): the stars of
data/phaseb/<field>/forced_phot.ecsv with ok, per (visit pair, detector, star) the pre-registered
local spectral model (wp.phaseb.spec_model) of each visit evaluated at every wavelength of visit A.
Floor, if any, is applied to the raw samples before the model, as in 07c: var' = var + (floor F)^2.

Per-star fractional difference (F_b - F_a)/F_a: inverse-variance weighted over the star's matched
wavelengths, w = 1/(var_a + var_b) (no floor): sum w (mb - ma) / sum w ma.
Offset test: per (field, pair, detector), median over stars, SE from a 2000-resample bootstrap over
stars (seed 20261114), robust scatter 1.4826 MAD, significant if |median|/SE > 3.
Multiplicative vs additive: per (pair, detector) fit D = k F + a on per-star D = sum w (mb - ma)/sum w
and F = sum w ma / sum w, with 3-sigma MAD clipping (up to 5 passes) and a 1000-star-resample bootstrap.
  k != 0 : offset proportional to flux (multiplicative); a != 0 : constant offset (additive, 1/F in fraction).
Wavelength dependence: within each (pair, detector), 4 wavelength bins (quantiles of lam_A), per-star
median fractional difference in the bin, median over stars, bootstrap SE.
Correction: B flux divided by (1 + median offset) and its variance by (1 + median offset)^2 before the
model; then z width without floor, and the floor refit on the 07b grid with solve_width1's rule
(width(b) = 1 by linear interpolation).
"""
import argparse
import json
import sys
import pathlib
import warnings

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: F401  (Agg only; no figures shown)
from astropy.table import Table

from wp.config import DATA
from wp.phaseb import spec_model, VISIT_PAIRS
from wp.results import metric, update_results

warnings.simplefilter("ignore")
SCRIPT = "07d_zeropoint.py"
OUT_JSON = pathlib.Path(__file__).resolve().parents[1] / "data" / "phaseb" / "zeropoint.json"
NB = 2000
SEED = 20261114
FLOOR_GRID = [0.0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.045]


def rs(x):
    x = np.asarray(x, float)
    return 1.4826 * np.median(np.abs(x - np.median(x)))


def boot_median(v, rng, nb=NB):
    v = np.asarray(v, float)
    if v.size < 3:
        return float("nan")
    k = rng.integers(0, v.size, (nb, v.size))
    return float(np.std(np.median(v[k], axis=1), ddof=1))


def boot_width(z, sid, rng, n=300):
    us, inv = np.unique(sid, return_inverse=True)
    idx = [np.where(inv == i)[0] for i in range(len(us))]
    out = []
    for _ in range(n):
        pick = rng.integers(0, len(us), len(us))
        out.append(rs(z[np.concatenate([idx[p] for p in pick])]))
    return float(np.std(out))


def solve_width1(bs, ws):
    """Same rule as 07b_phaseb_controls.solve_width1."""
    ws = np.asarray(ws)
    if ws[0] <= 1:
        return 0.0
    for i in range(1, len(bs)):
        if ws[i] <= 1 < ws[i - 1]:
            return float(bs[i - 1] + (ws[i - 1] - 1) / (ws[i - 1] - ws[i]) * (bs[i] - bs[i - 1]))
    return float("nan")


def clipped_fit(F, D, rng=None):
    """OLS D = k F + a with 3-sigma MAD clipping. Returns (k, a)."""
    m = np.ones(F.size, bool)
    k = a = np.nan
    for _ in range(5):
        if m.sum() < 4 or np.ptp(F[m]) == 0:
            return np.nan, np.nan
        A = np.vstack([F[m], np.ones(m.sum())]).T
        (k, a), *_ = np.linalg.lstsq(A, D[m], rcond=None)
        r = D - (k * F + a)
        s = rs(r[m])
        if not np.isfinite(s) or s == 0:
            break
        m2 = np.abs(r) < 3 * s
        if (m2 == m).all():
            break
        m = m2
    return float(k), float(a)


def load_groups(field):
    t = Table.read(DATA / "phaseb" / field / "forced_phot.ecsv")
    t = t[t["ok"]]
    groups = []
    for (a, b, cls) in VISIT_PAIRS[field]:
        for d in range(1, 7):
            A = t[(t["visit"] == a) & (t["detector"] == d)]
            B = t[(t["visit"] == b) & (t["detector"] == d)]
            for s in np.unique(A["source_id"]):
                x = A[A["source_id"] == s]
                y = B[B["source_id"] == s]
                if len(y) < 3 or len(x) < 3:
                    continue
                groups.append(dict(pair=(a, b, cls), det=d, sid=int(s),
                                   lx=np.array(x["lam"], float), fx=np.array(x["flux"], float),
                                   vx=np.array(x["var"], float), bx=np.array(x["bw"], float),
                                   ly=np.array(y["lam"], float), fy=np.array(y["flux"], float),
                                   vy=np.array(y["var"], float)))
    return groups


def models(g, floor, delta):
    """Matched model values of A and B at every lam of A. delta: B scale correction (1+delta)."""
    vx = g["vx"] + (floor * g["fx"]) ** 2
    fy, vy = g["fy"] / (1 + delta), g["vy"] / (1 + delta) ** 2
    vy = vy + (floor * fy) ** 2
    lx, bx = g["lx"], g["bx"]
    ma, va, _ = spec_model(lx[:, None], g["fx"][:, None], vx[:, None], lx, bx)
    mb, vb, _ = spec_model(g["ly"][:, None], fy[:, None], vy[:, None], lx, bx)
    ok = np.isfinite(ma) & np.isfinite(mb)
    return ma, va, mb, vb, ok


def run_samples(groups, floor, deltas):
    z, sid, pair, det = [], [], [], []
    for g in groups:
        ma, va, mb, vb, ok = models(g, floor, deltas.get((g["pair"], g["det"]), 0.0))
        z.append(((ma - mb) / np.sqrt(va + vb))[ok])
        sid += [g["sid"]] * int(ok.sum())
    return np.concatenate(z), np.array(sid)


def star_stats(groups):
    """Per (pair, det, star): fractional diff, D, F, plus per-sample fractions for wavelength bins."""
    rows = []
    for g in groups:
        ma, va, mb, vb, ok = models(g, 0.0, 0.0)
        ok &= ma > 0
        if ok.sum() < 1:
            continue
        w = 1.0 / (va[ok] + vb[ok])
        D = np.sum(w * (mb[ok] - ma[ok])) / w.sum()
        F = np.sum(w * ma[ok]) / w.sum()
        rows.append(dict(pair=g["pair"], det=g["det"], sid=g["sid"], frac=D / F, D=D, F=F,
                         lam=g["lx"][ok], sfrac=(mb[ok] - ma[ok]) / ma[ok]))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write-results", action="store_true")
    args = ap.parse_args()
    rng = np.random.default_rng(SEED)
    out = {"offsets": [], "fits": [], "wavelength": [], "widths": {}, "releases": {}}
    for field in ("barnard", "epsindi"):
        idx = Table.read(DATA / f"index_{field}.csv")
        rel = {}
        for v in np.unique(idx["visit"]):
            m = idx["visit"] == v
            rel[int(v)] = dict(release=sorted(set(str(r).upper() for r in idx["release"][m])), n_exp=int(m.sum()),
                               mjd=float(np.median(idx["mjd_mid"][m])))
        out["releases"][field] = rel
        print(f"{field} visits:", {v: (r["release"], r["n_exp"], round(r["mjd"], 1)) for v, r in rel.items()})
        groups = load_groups(field)
        # reproduction of the 07c M2one width, floor 0 and 0.02
        for fl in (0.0, 0.02):
            z, sid = run_samples(groups, fl, {})
            e = boot_width(z, sid, np.random.default_rng(3))
            print(f"  {field} reproduce 07c M2one floor {fl}: width {rs(z):.3f}+-{e:.3f} n={len(z)}")
            out["widths"].setdefault(field, {})[f"uncorrected_floor{fl}"] = dict(width=float(rs(z)), err=e, n=int(len(z)))
        rows = star_stats(groups)
        deltas = {}
        keys = sorted({(r["pair"], r["det"]) for r in rows}, key=lambda k: (k[0][0], k[0][1], k[1]))
        for key in keys:
            sub = [r for r in rows if (r["pair"], r["det"]) == key]
            fr = np.array([r["frac"] for r in sub])
            if len(sub) < 5:
                continue
            med, se = float(np.median(fr)), boot_median(fr, rng)
            deltas[key] = med
            rel_a, rel_b = rel[key[0][0]]["release"], rel[key[0][1]]["release"]
            out["offsets"].append(dict(field=field, pair=f"{key[0][0]}-{key[0][1]}", cls=key[0][2], det=key[1],
                                       rel_a="/".join(rel_a), rel_b="/".join(rel_b), n=len(sub),
                                       median_pct=100 * med, se_pct=100 * se, scatter_pct=100 * rs(fr),
                                       significant=bool(abs(med) / se > 3) if se > 0 else False))
            # multiplicative vs additive
            F = np.array([r["F"] for r in sub]); D = np.array([r["D"] for r in sub])
            k0, a0 = clipped_fit(F, D)
            bk = []
            for _ in range(1000):
                i = rng.integers(0, len(sub), len(sub))
                bk.append(clipped_fit(F[i], D[i]))
            bk = np.array(bk)
            kerr, aerr = np.nanstd(bk[:, 0], ddof=1), np.nanstd(bk[:, 1], ddof=1)
            out["fits"].append(dict(field=field, pair=f"{key[0][0]}-{key[0][1]}", det=key[1], n=len(sub),
                                    k_pct=100 * k0, k_err_pct=100 * kerr, k_sigma=k0 / kerr,
                                    a=a0, a_err=aerr, a_sigma=a0 / aerr, medF=float(np.median(F))))
            # wavelength dependence: 4 bins of lam_A (quantiles over the group samples)
            lam_all = np.concatenate([r["lam"] for r in sub])
            edges = np.quantile(lam_all, [0, .25, .5, .75, 1.0])
            for bi in range(4):
                vals = []
                for r in sub:
                    m = (r["lam"] >= edges[bi]) & (r["lam"] <= edges[bi + 1] if bi == 3 else r["lam"] < edges[bi + 1])
                    if m.any():
                        vals.append(np.median(r["sfrac"][m]))
                vals = np.array(vals)
                if len(vals) >= 5:
                    out["wavelength"].append(dict(field=field, pair=f"{key[0][0]}-{key[0][1]}", det=key[1], bin=bi,
                                                  lam_lo=float(edges[bi]), lam_hi=float(edges[bi + 1]), n=int(len(vals)),
                                                  median_pct=100 * float(np.median(vals)),
                                                  se_pct=100 * boot_median(vals, rng)))
        # corrected widths
        zc, sidc = run_samples(groups, 0.0, deltas)
        e = boot_width(zc, sidc, np.random.default_rng(3))
        out["widths"][field]["corrected_floor0.0"] = dict(width=float(rs(zc)), err=e, n=int(len(zc)))
        grid_u, grid_c = [], []
        for fl in FLOOR_GRID:
            zu, _ = run_samples(groups, fl, {})
            zk, _ = run_samples(groups, fl, deltas)
            grid_u.append(float(rs(zu))); grid_c.append(float(rs(zk)))
        out["widths"][field]["floor_grid"] = FLOOR_GRID
        out["widths"][field]["grid_uncorrected"] = grid_u
        out["widths"][field]["grid_corrected"] = grid_c
        out["widths"][field]["floor_needed_uncorrected_pct"] = 100 * solve_width1(FLOOR_GRID, grid_u)
        out["widths"][field]["floor_needed_corrected_pct"] = 100 * solve_width1(FLOOR_GRID, grid_c)
        print(f"  {field} widths: no floor/no corr {grid_u[0]:.3f}; floor 2% {grid_u[4]:.3f}; corrected no floor {grid_c[0]:.3f}"
              f" +-{e:.3f}; corrected+2% {grid_c[4]:.3f}")
        print(f"  grid uncorrected {np.round(grid_u, 3).tolist()}\n  grid corrected   {np.round(grid_c, 3).tolist()}")
        print(f"  floor needed (width=1): uncorrected {out['widths'][field]['floor_needed_uncorrected_pct']:.2f}%,"
              f" corrected {out['widths'][field]['floor_needed_corrected_pct']:.2f}%")
    print("\nfield pair cls det releases N median+-SE(%) scatter(%) sig")
    cls = {(o["field"], o["pair"]): o["cls"] for o in out["offsets"]}
    for o in out["offsets"]:
        print(f"{o['field']} {o['pair']} {o['cls']} D{o['det']} {o['rel_a']}->{o['rel_b']} N={o['n']} "
              f"{o['median_pct']:+.2f}+-{o['se_pct']:.2f} sc={o['scatter_pct']:.2f} {'YES' if o['significant'] else 'no'}")
    print("\nfits D = k F + a: field pair det n k%+-err (sigma) | a+-err (sigma)")
    for f in out["fits"]:
        print(f"{f['field']} {f['pair']} D{f['det']} n={f['n']} k={f['k_pct']:+.2f}+-{f['k_err_pct']:.2f} ({f['k_sigma']:+.1f}) | "
              f"a={f['a']:+.2f}+-{f['a_err']:.2f} ({f['a_sigma']:+.1f}) medF={f['medF']:.1f}")
    # wavelength summary per group: chi2 of constant and trend
    print("\nwavelength dependence: field pair det bins(median%+-se) chi2/dof")
    grp = {}
    for w in out["wavelength"]:
        grp.setdefault((w["field"], w["pair"], w["det"]), []).append(w)
    out["wavelength_summary"] = []
    for k, ws in grp.items():
        m = np.array([w["median_pct"] for w in ws]); s = np.array([w["se_pct"] for w in ws])
        if len(ws) < 4 or not np.all(s > 0):
            continue
        mu = np.sum(m / s ** 2) / np.sum(1 / s ** 2)
        chi = float(np.sum(((m - mu) / s) ** 2) / (len(ws) - 1))
        out["wavelength_summary"].append(dict(field=k[0], pair=k[1], det=k[2], chi2_dof=chi, bins=m.tolist(), errs=s.tolist()))
        print(k, " ".join(f"{a:+.2f}+-{b:.2f}" for a, b in zip(m, s)), f"chi2/dof={chi:.1f}")
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(out, indent=1, default=float))
    print("saved", OUT_JSON)
    if args.write_results:
        res = {}
        for field, w in out["widths"].items():
            for kk in ("uncorrected_floor0.0", "uncorrected_floor0.02", "corrected_floor0.0"):
                v = w[kk]
                res[f"{field}_width_{kk}"] = metric(v["width"], "z width", n=v["n"], script=SCRIPT, note=f"bootstrap err {v['err']:.3f}")
            res[f"{field}_floor_needed_uncorrected"] = metric(w["floor_needed_uncorrected_pct"], "percent", script=SCRIPT,
                                                              note="width(b)=1 by interpolation, M2one")
            res[f"{field}_floor_needed_after_offset_removal"] = metric(w["floor_needed_corrected_pct"], "percent", script=SCRIPT,
                                                                       note="after removing per (pair, detector) median offset")
        nsig = sum(o["significant"] for o in out["offsets"])
        res["offsets_significant"] = metric(int(nsig), "count", n=len(out["offsets"]), script=SCRIPT,
                                            note="(field, pair, detector) groups with |median|/SE > 3")
        update_results("phaseb_zeropoint", res)


if __name__ == "__main__":
    main()
