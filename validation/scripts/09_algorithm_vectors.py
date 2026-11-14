"""09: regenerate docs/algorithm_test_vectors.json (test vectors for docs/algorithm.md).

usage: uv run python scripts/09_algorithm_vectors.py

Inputs : data/index_barnard.csv, data/cutouts/barnard/*_D2.fits, data/gaia_barnard.ecsv,
         data/phaseb/barnard/forced_phot.ecsv (wavelength and bandwidth at the star, from the spectral
         WCS calibration, and the cross-check).
Output : docs/algorithm_test_vectors.json (deterministic: no timestamps).
Star choice (fixed before any output was looked at). Eligible: phaseb sample stars (the stars of
forced_phot.ecsv) with at least 8 browser-mask measurements on detector 2 in each of visits 0 and 2.
  saturated star (vector 4): eligible star with G closest to 12.5.
  stars 2 and 3: eligible stars with G closest to 14.0 and 15.5 (distinct, in that order).
  star 1: eligible star with G closest to 12.5 that has no saturation flag (raw bits 1, 15, 26 in the
          central 5x5) in any detector-2 exposure of visits 0 and 2 and at least 12 accepted exposures per
          visit.
Everything in the JSON is written at full float64 precision; the script ends with a self-check that
reloads the JSON and recomputes every expected value from the JSON inputs alone.
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


def clean(o):
    """JSON-safe copy: numpy -> python, non-finite -> None. No rounding."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (float, np.floating)):
        return float(o) if np.isfinite(o) else None
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def close(a, b, path=""):
    """Assert a == b: floats to 1e-6 relative (1e-9 absolute near zero), everything else exactly."""
    if isinstance(a, dict):
        assert isinstance(b, dict) and a.keys() == b.keys(), f"keys differ at {path}"
        for k in a:
            close(a[k], b[k], f"{path}/{k}")
    elif isinstance(a, list):
        assert isinstance(b, list) and len(a) == len(b), f"length differs at {path}"
        for i, (x, y) in enumerate(zip(a, b)):
            close(x, y, f"{path}[{i}]")
    elif isinstance(a, float) or isinstance(b, float):
        assert a is not None and b is not None, f"None mismatch at {path}: {a} {b}"
        assert abs(a - b) <= max(1e-6 * max(abs(a), abs(b)), 1e-9), f"{path}: {a} vs {b}"
    else:
        assert a == b, f"{path}: {a!r} vs {b!r}"


def eligible_stars(phot):
    m = (np.asarray(phot["detector"]) == DET) & np.asarray(phot["ok_browser"], bool)
    cnt = {}
    for s, v in zip(np.asarray(phot["source_id"])[m], np.asarray(phot["visit"])[m]):
        cnt[(int(s), int(v))] = cnt.get((int(s), int(v)), 0) + 1
    return [s for s in sorted({int(s) for s in phot["source_id"]})
            if cnt.get((s, VISIT_A), 0) >= 8 and cnt.get((s, VISIT_B), 0) >= 8]


def build_vector(sid, meas, grow, gaia, gi, cut):
    """The JSON record of one star. expected = compare_visits on the accepted exposures."""
    samples = {v: [dict(id=s["id"], lam=s["lam"], bw=s["bw"], mjd=s["mjd"], flux=s["flux"], var=s["var"],
                        saturated=s["saturated"]) for s in meas[v] if s["ok"]] for v in meas}
    any_sat = any(s["saturated"] for v in meas for s in meas[v])
    blended = m2ref.is_blended(float(grow["ra"][0]), float(grow["dec"][0]), float(grow["phot_g_mean_mag"][0]),
                               gaia["ra"], gaia["dec"], gaia["phot_g_mean_mag"], star_index=gi)
    res = m2ref.compare_visits(samples[VISIT_A], samples[VISIT_B], blended=blended, saturated=any_sat)
    exps = {str(v): [dict(obs_id=s["id"], mjd=s["mjd"], x=s["x"], y=s["y"], lam=s["lam"], bw=s["bw"],
                          accepted=bool(s["ok"]), reason=s["reason"], saturated=s["saturated"], flux=s["flux"],
                          var_raw=s["var_raw"], var=s["var"], bkg=s["bkg"], n_bkg=s["n_bkg"])
                     for s in meas[v]] for v in meas}
    # stamp: 17 x 17 pixels of the first accepted visit-A exposure that fits
    stamp = None
    for s in meas[VISIT_A]:
        c = cut[s["id"]]
        ny, nx = c["P"].shape
        xi, yi = int(np.rint(s["x"])), int(np.rint(s["y"]))
        if s["ok"] and HALF <= xi < nx - HALF and HALF <= yi < ny - HALF:
            sl = (slice(yi - HALF, yi + HALF + 1), slice(xi - HALF, xi + HALF + 1))
            # 9 significant figures: more than the float32 file values carry; the stamp INPUT is
            # defined as these numbers and the expected photometry is computed from them
            r9 = np.vectorize(lambda v: float(f"{v:.9g}"))
            P, V, FL = r9(c["P"][sl]), r9(c["V"][sl]), c["FL"][sl].copy()
            xs, ys = s["x"] - (xi - HALF), s["y"] - (yi - HALF)
            m = m2ref.measure_pixels(P, V, FL, xs, ys)
            stamp = dict(obs_id=s["id"], x=xs, y=ys, P=P.tolist(), V=V.tolist(), FLAGS=FL.tolist(),
                         expected=dict(ok=m["ok"], flux=m["flux"], var_raw=m["var_raw"], var=m["var"],
                                       bkg=m["bkg"], s_bkg=m["s_bkg"], n_bkg=m["n_bkg"],
                                       saturated=m["saturated"]))
            break
    return clean(dict(
        source_id=int(sid),
        gaia=dict(epoch=2016.0, ra=float(grow["ra"][0]), dec=float(grow["dec"][0]),
                  pmra=float(grow["pmra"][0]), pmdec=float(grow["pmdec"][0]),
                  parallax=float(grow["parallax"][0]), G=float(grow["phot_g_mean_mag"][0])),
        blended=blended, exposures=exps, stamp=stamp,
        expected=dict(per_w0=res["per_w0"], skipped=res["skipped"], n_exposures_A=res["n_exposures_A"],
                      n_exposures_B=res["n_exposures_B"], n_w0=res["n_w0"], D=res["D"], var=res["var"],
                      z=res["z"], frac=res["frac"], plain=res["plain"], ps=res["ps"],
                      verdict=res["verdict"], flags=res["flags"])))


def recompute_from_json(star):
    """Expected block recomputed from the JSON inputs alone."""
    samples = {}
    for v, lst in star["exposures"].items():
        samples[int(v)] = [dict(id=e["obs_id"], lam=e["lam"], bw=e["bw"], mjd=e["mjd"], flux=e["flux"],
                                var=e["var"], saturated=e["saturated"]) for e in lst if e["accepted"]]
    any_sat = any(e["saturated"] for lst in star["exposures"].values() for e in lst)
    res = m2ref.compare_visits(samples[VISIT_A], samples[VISIT_B], blended=star["blended"], saturated=any_sat)
    return clean(dict(per_w0=res["per_w0"], skipped=res["skipped"], n_exposures_A=res["n_exposures_A"],
                      n_exposures_B=res["n_exposures_B"], n_w0=res["n_w0"], D=res["D"], var=res["var"],
                      z=res["z"], frac=res["frac"], plain=res["plain"], ps=res["ps"],
                      verdict=res["verdict"], flags=res["flags"]))


def self_check(path):
    doc = json.loads(path.read_text())
    n = 0
    for star in doc["stars"]:
        close(star["expected"], recompute_from_json(star), f"star {star['source_id']}")
        st = star["stamp"]
        m = m2ref.measure_pixels(np.array(st["P"]), np.array(st["V"]), np.array(st["FLAGS"]), st["x"], st["y"])
        close(st["expected"], clean(dict(ok=m["ok"], flux=m["flux"], var_raw=m["var_raw"], var=m["var"],
                                         bkg=m["bkg"], s_bkg=m["s_bkg"], n_bkg=m["n_bkg"],
                                         saturated=m["saturated"])), f"stamp {star['source_id']}")
        # the per-exposure inflation must follow from var_raw and flux
        for lst in star["exposures"].values():
            for e in lst:
                if e["accepted"]:
                    close(e["var"], e["var_raw"] + (m2ref.FLUX_FLOOR * e["flux"]) ** 2, "inflation")
        n += 1
    print(f"self-check PASS: {n} stars, expected outputs of compare_visits/paired_stack and the stamp "
          f"photometry reproduced from the JSON inputs (1e-6 relative)")


def main():
    index = Table.read(DATA / f"index_{FIELD}.csv")
    phot = Table.read(DATA / "phaseb" / FIELD / "forced_phot.ecsv")
    gaia = Table.read(DATA / f"gaia_{FIELD}.ecsv")
    gsid = np.asarray(gaia["source_id"], np.int64)
    G = {int(s): float(g) for s, g in zip(gaia["source_id"], gaia["phot_g_mean_mag"])}

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
        return out

    elig = eligible_stars(phot)
    meas_all = {s: measure_star(s) for s in elig}

    sat_star = min(elig, key=lambda e: (abs(G[e] - TARGET_G[0]), e))
    star2 = min((e for e in elig if e != sat_star), key=lambda e: (abs(G[e] - TARGET_G[1]), e))
    star3 = min((e for e in elig if e not in (sat_star, star2)), key=lambda e: (abs(G[e] - TARGET_G[2]), e))

    def clean_enough(e):
        m = meas_all[e]
        return (not any(s["saturated"] for v in m for s in m[v])
                and all(sum(s["ok"] for s in m[v]) >= 12 for v in m))
    star1 = min((e for e in elig if clean_enough(e) and e not in (star2, star3)),
                key=lambda e: (abs(G[e] - TARGET_G[0]), e))
    chosen = [star1, star2, star3, sat_star]
    print("stars (1..4):", [(s, round(G[s], 3)) for s in chosen])

    stars_out = []
    for sid in chosen:
        gi = int(np.nonzero(gsid == sid)[0][0])
        stars_out.append(build_vector(sid, meas_all[sid], gaia[gsid == sid][:1], gaia, gi, cut))

    # ---------------------------------------------------------------- cross-check vs forced_phot.ecsv
    def cross_check(star_ids):
        rel, vr, nboth, ndiff_acc = [], [], 0, 0
        for sid in star_ids:
            for v, lst in meas_all[sid].items():
                for s in lst:
                    ft = lamtab[(s["id"], sid)][2]
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
    cc = dict(four_stars=cross_check(chosen), all_70_stars=cross_check(elig))
    for k, v in cc.items():
        print("cross-check", k, json.dumps(v))

    doc = dict(
        description="Test vectors for docs/algorithm.md (matched photometry). Barnard field, detector 2, "
                    "visit A = 0 (earlier) and visit B = 2 (about 6 months later). Generated by "
                    "validation/scripts/09_algorithm_vectors.py with validation/wp/m2ref.py. Nothing is "
                    "rounded: every number is a float64 written with its shortest round-trip repr, and the "
                    "expected outputs are exactly what compare_visits returns for the inputs in this file "
                    "(a port should match to 1e-6 relative). Fluxes are MJy/sr summed over native pixels "
                    "(IMAGE - ZODI); var is the inflated variance (var_raw + (0.02 flux)^2), var_raw before "
                    "the 2 percent term. lam and bw are micrometres at the star's detector pixel (spectral "
                    "WCS calibration). Star positions are Gaia DR3 propagated to MJD-AVG with proper motion "
                    "and parallax. x, y are 0-based cutout pixels. Stars 1-3 are unsaturated; star 4 has the "
                    "saturated flag. Inputs of the matched comparison are the exposures with accepted=true "
                    "(id=obs_id, lam, bw, mjd, flux, var, saturated); the 'saturated' output flag is set when "
                    "ANY exposure listed (accepted or not) has saturated=true. stamp: a 17 x 17 pixel excerpt "
                    "of the first accepted visit-A exposure (P, V, raw FLAGS; x, y in stamp pixels) with the "
                    "expected photometry, a pixel-level test of steps 1-2.",
        constants=dict(aperture_radius_px=m2ref.APER_R, annulus_px=[m2ref.ANN_IN, m2ref.ANN_OUT],
                       flux_floor=m2ref.FLUX_FLOOR, window_bw=m2ref.WINDOW_BW, clip_sigma=m2ref.CLIP_SIGMA,
                       separation_bw=m2ref.SEP_BW, pair_gap_bw=m2ref.PAIR_GAP_BW,
                       bad_data_bits=list(m2ref.BAD_DATA_BITS), saturated_bits=list(m2ref.SATURATED_BITS)),
        visit_pair=dict(field=FIELD, detector=DET, visit_A=VISIT_A, visit_B=VISIT_B),
        cross_check_vs_forced_phot=clean(cc),
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
    self_check(out)


if __name__ == "__main__":
    main()
