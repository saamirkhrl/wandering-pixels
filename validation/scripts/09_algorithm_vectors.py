"""09: regenerate docs/algorithm_test_vectors.json (test vectors for docs/algorithm.md).

usage: uv run python scripts/09_algorithm_vectors.py

Inputs : data/index_barnard.csv, data/cutouts/barnard/*_D2.fits, data/gaia_barnard.ecsv,
         data/phaseb/barnard/forced_phot.ecsv (wavelength and bandwidth at the star, from the spectral
         WCS calibration, and the cross-check).
Output : docs/algorithm_test_vectors.json (deterministic: no timestamps).
Star choice (fixed before any output was looked at): among the phaseb sample stars (the stars of
forced_phot.ecsv) with at least 8 browser-mask measurements on detector 2 in each of visits 0 and 2,
the three whose Gaia G is closest to 12.5, 14.0 and 15.5 (distinct stars, taken in that order).
Barnard field, visit pair 0 (A) - 2 (B), about 6 months, detector 2. Algorithm: wp/m2ref.py.
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from astropy.table import Table  # noqa: E402

from wp import m2ref  # noqa: E402
from wp.config import DATA, DOCS, ROOT  # noqa: E402
from wp.gaia import propagate  # noqa: E402

FIELD, DET, VISIT_A, VISIT_B = "barnard", 2, 0, 2
TARGET_G = (12.5, 14.0, 15.5)
HALF = 8   # stamp half width: 17 x 17 pixels


def sig(v, n=4):
    """Round to n significant figures; NaN -> None."""
    if v is None:
        return None
    v = float(v)
    if not np.isfinite(v):
        return None
    return float(f"{v:.{n}g}")


def sig_tree(o, n=4):
    if isinstance(o, dict):
        return {k: sig_tree(v, n) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [sig_tree(v, n) for v in o]
    if isinstance(o, (float, np.floating)):
        return sig(o, n)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    return o


def pick_stars(phot, gaia):
    G = {int(s): float(g) for s, g in zip(gaia["source_id"], gaia["phot_g_mean_mag"])}
    m = (np.asarray(phot["detector"]) == DET) & np.asarray(phot["ok_browser"], bool)
    cnt = {}
    for s, v in zip(np.asarray(phot["source_id"])[m], np.asarray(phot["visit"])[m]):
        cnt[(int(s), int(v))] = cnt.get((int(s), int(v)), 0) + 1
    elig = [s for s in sorted({int(s) for s in phot["source_id"]})
            if cnt.get((s, VISIT_A), 0) >= 8 and cnt.get((s, VISIT_B), 0) >= 8]
    chosen = []
    for t in TARGET_G:
        s = min((e for e in elig if e not in chosen), key=lambda e: (abs(G[e] - t), e))
        chosen.append(s)
    return chosen


def main():
    index = Table.read(DATA / f"index_{FIELD}.csv")
    phot = Table.read(DATA / "phaseb" / FIELD / "forced_phot.ecsv")
    gaia = Table.read(DATA / f"gaia_{FIELD}.ecsv")
    gsid = np.asarray(gaia["source_id"], np.int64)
    chosen = pick_stars(phot, gaia)
    print("stars:", [(s, round(float(gaia['phot_g_mean_mag'][gsid == s][0]), 3)) for s in chosen])

    # cutouts of detector 2 in visits A and B
    sel = (np.asarray(index["detector"]) == DET) & np.isin(np.asarray(index["visit"]), [VISIT_A, VISIT_B]) \
        & np.array([str(x) == "True" for x in index["on_detector"]])
    rows = sorted(index[sel], key=lambda r: (int(r["visit"]), float(r["mjd_mid"]), str(r["obs_id"])))
    cut = {}
    for r in rows:
        c = m2ref.load_cutout(ROOT / str(r["cutout_path"]))
        c["visit"] = int(r["visit"])
        cut[str(r["obs_id"])] = c
    print(f"{len(cut)} detector-{DET} cutouts: visit {VISIT_A} {sum(c['visit'] == VISIT_A for c in cut.values())}, "
          f"visit {VISIT_B} {sum(c['visit'] == VISIT_B for c in cut.values())}")

    # wavelength and bandwidth at the star: spectral WCS calibration values from forced_phot.ecsv
    lamtab = {}
    for r in phot[np.asarray(phot["detector"]) == DET]:
        lamtab[(str(r["obs_id"]), int(r["source_id"]))] = (float(r["lam"]), float(r["bw"]), r)

    def measure_star(sid):
        grow = gaia[gsid == sid][:1]
        out = {A: [] for A in (VISIT_A, VISIT_B)}
        for oid, c in cut.items():
            if (oid, sid) not in lamtab:
                continue
            ra, dec, _ = propagate(grow, c["mjd"])
            x, y = c["wcs"].world_to_pixel_values(ra[0], dec[0])
            x, y = float(x), float(y)
            lam, bw, _ = lamtab[(oid, sid)]
            m = m2ref.measure_pixels(c["P"], c["V"], c["FL"], x, y)
            out[c["visit"]].append(dict(id=oid, mjd=c["mjd"], x=x, y=y, lam=lam, bw=bw, **m))
        for v in out:
            out[v].sort(key=lambda s: (s["mjd"], s["id"]))
        return out, grow

    stars_out, cross = [], []
    for sid in chosen:
        meas, grow = measure_star(sid)
        samples = {v: [dict(id=s["id"], lam=s["lam"], bw=s["bw"], mjd=s["mjd"], flux=s["flux"], var=s["var"],
                            saturated=s["saturated"]) for s in meas[v] if s["ok"]] for v in meas}
        # 'saturated' of rejected exposures also counts (any measured exposure)
        for v in meas:
            if any(s["saturated"] and not s["ok"] for s in meas[v]) and samples[v]:
                samples[v][0] = dict(samples[v][0], saturated=True)
        gi = int(np.nonzero(gsid == sid)[0][0])
        blended = m2ref.is_blended(float(grow["ra"][0]), float(grow["dec"][0]), float(grow["phot_g_mean_mag"][0]),
                                   gaia["ra"], gaia["dec"], gaia["phot_g_mean_mag"], star_index=gi)
        res = m2ref.compare_visits(samples[VISIT_A], samples[VISIT_B], blended=blended)

        exps = {}
        for v in meas:
            exps[str(v)] = [dict(obs_id=s["id"], mjd=s["mjd"], x=round(s["x"], 4), y=round(s["y"], 4),
                                 lam=round(s["lam"], 6), bw=round(s["bw"], 6), accepted=bool(s["ok"]),
                                 reason=s["reason"], saturated=s["saturated"], flux=sig(s["flux"]),
                                 var_raw=sig(s["var_raw"]), var=sig(s["var"]), bkg=sig(s["bkg"]),
                                 n_bkg=s["n_bkg"])
                            for s in meas[v]]
        # stamp of the first accepted visit-A exposure that fits a 17 x 17 window
        stamp = None
        for s in meas[VISIT_A]:
            c = cut[s["id"]]
            ny, nx = c["P"].shape
            xi, yi = int(np.rint(s["x"])), int(np.rint(s["y"]))
            if s["ok"] and HALF <= xi < nx - HALF and HALF <= yi < ny - HALF:
                sl = (slice(yi - HALF, yi + HALF + 1), slice(xi - HALF, xi + HALF + 1))
                P = np.vectorize(lambda v: float(f"{v:.6g}"))(c["P"][sl])
                V = np.vectorize(lambda v: float(f"{v:.6g}"))(c["V"][sl])
                FL = c["FL"][sl]
                xs, ys = s["x"] - (xi - HALF), s["y"] - (yi - HALF)
                m = m2ref.measure_pixels(P, V, FL, xs, ys)
                stamp = dict(obs_id=s["id"], x=round(xs, 5), y=round(ys, 5), P=P.tolist(), V=V.tolist(),
                             FLAGS=FL.tolist(),
                             expected=sig_tree(dict(ok=m["ok"], flux=m["flux"], var_raw=m["var_raw"], var=m["var"],
                                                   bkg=m["bkg"], s_bkg=m["s_bkg"], n_bkg=m["n_bkg"],
                                                   saturated=m["saturated"])))
                break
        stars_out.append(dict(
            source_id=int(sid),
            gaia=dict(epoch=2016.0, ra=float(grow["ra"][0]), dec=float(grow["dec"][0]),
                      pmra=float(grow["pmra"][0]), pmdec=float(grow["pmdec"][0]),
                      parallax=float(grow["parallax"][0]), G=float(grow["phot_g_mean_mag"][0])),
            blended=blended, exposures=exps, stamp=stamp,
            expected=sig_tree(dict(per_w0=res["per_w0"], skipped=res["skipped"],
                                   n_exposures_A=res["n_exposures_A"], n_exposures_B=res["n_exposures_B"],
                                   n_w0=res["n_w0"], D=res["D"], var=res["var"], z=res["z"], frac=res["frac"],
                                   plain=res["plain"], ps=res["ps"], verdict=res["verdict"],
                                   flags=res["flags"]))))
        # keep the unrounded numbers for the cross-check
        cross.append((sid, meas))

    # ---------------------------------------------------------------- cross-check vs forced_phot.ecsv
    def cross_check(star_ids):
        rel, vr, nboth, ndiff_acc = [], [], 0, 0
        for sid in star_ids:
            meas, _ = measure_star(sid)
            for v in meas:
                for s in meas[v]:
                    key = (s["id"], sid)
                    ft = lamtab[key][2]
                    if not bool(ft["ok_browser"]) and not s["ok"]:
                        continue
                    nboth += 1
                    if bool(ft["ok_browser"]) != bool(s["ok"]):
                        ndiff_acc += 1
                        continue
                    rel.append((s["flux"] - float(ft["flux"])) / abs(float(ft["flux"])))
                    vr.append(s["var_raw"] / float(ft["var"]))
        rel, vr = np.array(rel), np.array(vr)
        return dict(n_compared=int(len(rel)), n_accept_differs=int(ndiff_acc), n_considered=int(nboth),
                    flux_rel_diff_median=float(np.median(rel)),
                    flux_rel_diff_abs_median=float(np.median(np.abs(rel))),
                    flux_rel_diff_abs_p90=float(np.quantile(np.abs(rel), 0.9)),
                    flux_rel_diff_abs_max=float(np.max(np.abs(rel))),
                    var_raw_ratio_median=float(np.median(vr)), var_raw_ratio_p10=float(np.quantile(vr, 0.1)),
                    var_raw_ratio_p90=float(np.quantile(vr, 0.9)))
    all_ids = sorted({int(s) for s in phot["source_id"]})
    cc = dict(three_stars=cross_check(chosen), all_70_stars=cross_check(all_ids))
    for k, v in cc.items():
        print("cross-check", k, json.dumps(sig_tree(v, 4)))

    doc = dict(
        description="Test vectors for docs/algorithm.md (matched photometry). Barnard field, detector 2, "
                    "visit A = 0 (earlier) and visit B = 2 (about 6 months later). Generated by "
                    "validation/scripts/09_algorithm_vectors.py with validation/wp/m2ref.py; all "
                    "computed numbers are rounded to 4 significant figures. Fluxes are MJy/sr summed over "
                    "native pixels (IMAGE - ZODI); var is the inflated variance, var_raw before the 2 percent "
                    "term. lam and bw are micrometres at the star's detector pixel (spectral WCS "
                    "calibration). Star positions are Gaia DR3 propagated to MJD-AVG with proper motion and "
                    "parallax. x, y are 0-based cutout pixels. stamp: a 17 x 17 pixel excerpt of the first "
                    "accepted visit-A exposure (P, V rounded to 6 significant figures, raw FLAGS) with "
                    "expected photometry for a pixel-level test of steps 1-2.",
        constants=dict(aperture_radius_px=m2ref.APER_R, annulus_px=[m2ref.ANN_IN, m2ref.ANN_OUT],
                       flux_floor=m2ref.FLUX_FLOOR, window_bw=m2ref.WINDOW_BW, clip_sigma=m2ref.CLIP_SIGMA,
                       separation_bw=m2ref.SEP_BW, pair_gap_bw=m2ref.PAIR_GAP_BW,
                       bad_data_bits=list(m2ref.BAD_DATA_BITS), saturated_bits=list(m2ref.SATURATED_BITS)),
        visit_pair=dict(field=FIELD, detector=DET, visit_A=VISIT_A, visit_B=VISIT_B),
        cross_check_vs_forced_phot=sig_tree(cc, 4),
    )
    out = DOCS / "algorithm_test_vectors.json"
    lines = ["{"]
    for k, v in doc.items():
        lines.append(f' "{k}": {json.dumps(v, separators=(",", ":"))},')
    lines.append(' "stars": [')
    for i, s in enumerate(stars_out):
        lines.append("  " + json.dumps(s, separators=(",", ":")) + ("," if i < len(stars_out) - 1 else ""))
    lines.append(" ]")
    lines.append("}")
    out.write_text("\n".join(lines) + "\n")
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
