"""13b: why do the browser's 'changed' rates (|z| >= 3) exceed the 0.9 percent of docs/method.md?

usage: cd validation && uv run python scripts/13b_false_alarm_fields.py path/to/readouts [--no-recompute]

Inputs : <readouts>/{barnards-star,eps-indi-b,rw-aur,wise-0855,r-dra}.json (the data seat's readouts: target plus
         up to 40 Gaia stars per cutout, default detector, every visit pair),
         data/gaia_{barnard,epsindi}.ecsv (cached Gaia cones), Gaia TAP (anonymous) for the other three fields
         (cached in data/phasec/readouts_gaia_<slug>.ecsv) and for phot_variable_flag of every star in the files
         (cached in data/phasec/readouts_varflag.json), data/phasec/inj_thresholds_{barnard,epsindi}.ecsv
         (our steady-star M2 results), the local cutouts for the position / saturation checks.
Output : results section browser_false_alarms (docs/results.json) and a printed report. Headless, no plots.

Steps (see the printed headings): 1 rates per field and cut, 2 what our 0.9 percent is and the like-for-like rate,
3 top offenders, 4 WISE 0855 binomial, 5 RW Aur -29 percent pair.
Steady-star cuts (wp/registration.star_quality, scripts/10_thresholds.py): not blended (no other Gaia source with
G < G_star + 3 within 20 arcsec, as m2ref.is_blended), no Gaia source with G < 9 within 180 arcsec, Gaia
phot_variable_flag != VARIABLE, G between 12 and 16.5; the target star itself is never a steady star. Variant c2 adds
RUWE < 1.4 (the phase B sample also has it).
"""
import argparse
import importlib.util
import io
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from astropy.table import Table  # noqa: E402
from scipy.stats import binom  # noqa: E402

from wp import m2ref  # noqa: E402
from wp.config import DATA, ROOT  # noqa: E402
from wp.gaia import propagate  # noqa: E402
from wp.results import metric, update_results  # noqa: E402

SCRIPT = "13b_false_alarm_fields.py"
FIELDS = {  # slug: (our field name for cached Gaia, cutout dir)
    "barnards-star": ("barnard", DATA / "cutouts" / "barnard"),
    "eps-indi-b": ("epsindi", DATA / "cutouts" / "epsindi"),
    "rw-aur": (None, DATA / "rwaur" / "cutouts"),
    "wise-0855": (None, DATA / "wise0855" / "cutouts"),
    "r-dra": (None, DATA / "rdra" / "cutouts"),
}
DIST_BINS = [(0, 1), (1, 2), (2, 3), (3, 1e9)]
G_BINS = [(12.5, 14), (14, 15.5), (15.5, 17), (17, 99)]
BRIGHT_G, BRIGHT_ARCSEC = 9.0, 180.0
OUT = DATA / "phasec"


# ------------------------------------------------------------------ stats --
def wilson(k, n, z=1.0):
    """Wilson score interval; z = 1 is the 68.3 percent interval."""
    if n == 0:
        return (np.nan, np.nan)
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (c - h, c + h)


def rate(rows, pred=lambda r: True):
    sel = [r for r in rows if pred(r)]
    k = sum(abs(r["z"]) >= 3 for r in sel)
    n = len(sel)
    lo, hi = wilson(k, n)
    return dict(k=int(k), n=int(n), pct=100.0 * k / n if n else None,
                lo68=100 * lo if n else None, hi68=100 * hi if n else None)


def fmt(r):
    if r["n"] == 0:
        return "0/0"
    return f"{r['k']}/{r['n']} = {r['pct']:.1f}% [{r['lo68']:.1f},{r['hi68']:.1f}]"


# ------------------------------------------------------------------ Gaia --
def tap_cone(slug, ra, dec, radius=0.5, gmax=19.5):
    p = OUT / f"readouts_gaia_{slug}.ecsv"
    if p.exists():
        return Table.read(p)
    import requests
    from wp.config import USER_AGENT
    adql = ("SELECT source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, ruwe, phot_variable_flag "
            f"FROM gaiadr3.gaia_source WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius})) "
            f"AND phot_g_mean_mag < {gmax}")
    r = requests.post("https://gea.esac.esa.int/tap-server/tap/sync", timeout=600,
                      data=dict(REQUEST="doQuery", LANG="ADQL", FORMAT="votable", QUERY=adql),
                      headers={"User-Agent": USER_AGENT})
    r.raise_for_status()
    t = Table.read(io.BytesIO(r.content), format="votable")
    t = Table(t, masked=False)
    keep = Table()
    lower = {n.lower(): n for n in t.colnames}
    for c in ("source_id", "ra", "dec", "pmra", "pmdec", "parallax", "phot_g_mean_mag", "ruwe", "phot_variable_flag"):
        col = t[lower[c]]
        if hasattr(col, "filled"):
            col = col.filled(np.nan) if col.dtype.kind == "f" else (col.filled(0) if col.dtype.kind in "iu" else col.filled(""))
        keep[c] = np.asarray(col)
    OUT.mkdir(parents=True, exist_ok=True)
    keep.write(p, overwrite=True)
    return keep


def var_flags(ids):
    """Gaia phot_variable_flag for ids (anonymous TAP, cached in data/phasec/readouts_varflag.json)."""
    import requests
    from wp.config import USER_AGENT
    p = OUT / "readouts_varflag.json"
    have = json.loads(p.read_text()) if p.exists() else {}
    need = [int(i) for i in ids if str(int(i)) not in have]
    for i in range(0, len(need), 300):
        ch = need[i:i + 300]
        q = "SELECT source_id, phot_variable_flag FROM gaiadr3.gaia_source WHERE source_id IN (" + ",".join(map(str, ch)) + ")"
        r = requests.post("https://gea.esac.esa.int/tap-server/tap/sync", timeout=300,
                          data=dict(REQUEST="doQuery", LANG="ADQL", FORMAT="csv", QUERY=q), headers={"User-Agent": USER_AGENT})
        r.raise_for_status()
        for line in r.text.strip().splitlines()[1:]:
            sid, flag = line.split(",", 1)
            have[sid.strip()] = flag.strip().strip('"')
        for c in ch:
            have.setdefault(str(c), "MISSING")
    if need:
        p.write_text(json.dumps(have))
    return have


# ------------------------------------------------------------------ load --
def load_field(slug, readouts):
    d = json.load(open(readouts / f"{slug}.json"))
    tgt = [s for s in d["stars"] if s["star"]["isTarget"]][0]["star"]
    cached, _ = FIELDS[slug]
    if cached:
        g = Table.read(DATA / f"gaia_{cached}.ecsv")
    else:
        g = tap_cone(slug, tgt["ra"], tgt["dec"])
    gid = {int(s): i for i, s in enumerate(np.asarray(g["source_id"], np.int64))}
    ids = [int(s["star"]["id"]) for s in d["stars"] if s["star"]["id"].isdigit()]
    vf = var_flags(ids)
    cosd = np.cos(np.deg2rad(tgt["dec"]))
    G = np.asarray(g["phot_g_mean_mag"], float)
    gra, gde = np.asarray(g["ra"], float), np.asarray(g["dec"], float)
    rows, stars = [], {}
    for s in d["stars"]:
        st = s["star"]
        sid = st["id"]
        gi = gid.get(int(sid)) if sid.isdigit() else None
        dist = float(np.hypot((st["ra"] - tgt["ra"]) * cosd, st["dec"] - tgt["dec"]) * 60.0)
        # neighbours: blend (other source, G < G* + 3 within 20") and bright (G < 9 within 3')
        sep = np.hypot((gra - st["ra"]) * cosd, gde - st["dec"]) * 3600.0
        selfm = sep < 0.5
        gm = st["gmag"] if st["gmag"] is not None else np.nan
        bl = (~selfm) & (sep <= 20.0) & (G < gm + 3.0)
        br = (~selfm) & (sep <= BRIGHT_ARCSEC) & (G < BRIGHT_G)
        nb = None
        if bl.any():
            j = int(np.argmin(np.where(bl, sep, 1e9)))
            nb = dict(G=float(G[j]), sep_arcsec=float(sep[j]), source_id=str(int(g["source_id"][j])))
        bb = None
        if br.any():
            j = int(np.argmin(np.where(br, sep, 1e9)))
            bb = dict(G=float(G[j]), sep_arcsec=float(sep[j]))
        ruwe = float(g["ruwe"][gi]) if gi is not None else np.nan
        stars[sid] = dict(id=sid, isTarget=bool(st["isTarget"]), G=st["gmag"], ra=st["ra"], dec=st["dec"], dist_arcmin=dist,
                          blended_theirs=bool(s["blended"]), blended_ours=bool(bl.any()) if gi is not None else None,
                          neighbour=nb, bright=bb, var=vf.get(sid, "n/a") if sid.isdigit() else "n/a", ruwe=ruwe,
                          accepted=s["accepted"], gaia_row=gi,
                          meas=s["measurements"])
        for p in s["pairs"]:
            r = p["result"]
            if not r or r.get("z") is None:
                continue
            rows.append(dict(slug=slug, star=sid, a=int(p["a"]), b=int(p["b"]), z=float(r["z"]), frac=r["fractionalChange"],
                             flags=list(r["flags"]), nW0=r["nW0"], nA=r["nExposuresA"], nB=r["nExposuresB"],
                             plain_frac=(r.get("plain") or {}).get("fractionalChange"),
                             ps_frac=(r.get("ps") or {}).get("fractionalChange"), res=r))
    for r in rows:
        r["st"] = stars[r["star"]]
    return d, g, rows, stars, tgt


def steady(r, ruwe=False):
    st = r["st"]
    if st["isTarget"] or st["G"] is None or st["gaia_row"] is None:
        return False
    ok = (not st["blended_theirs"]) and st["bright"] is None and st["var"] != "VARIABLE" and 12.0 <= st["G"] <= 16.5
    if ruwe:
        ok = ok and np.isfinite(st["ruwe"]) and st["ruwe"] < 1.4
    return ok


# ------------------------------------------------------------------ step 1 --
def step1(name, rows):
    out = dict(
        a_all=rate(rows), b_noflags=rate(rows, lambda r: not r["flags"]),
        c_steady=rate(rows, steady), c2_steady_ruwe=rate(rows, lambda r: steady(r, True)),
        d_distance_arcmin={f"{lo}-{hi if hi < 1e8 else 'inf'}": rate(rows, lambda r, lo=lo, hi=hi: lo <= r["st"]["dist_arcmin"] < hi)
                           for lo, hi in DIST_BINS},
        e_G={f"{lo}-{hi if hi < 90 else 'inf'}": rate(rows, lambda r, lo=lo, hi=hi: r["st"]["G"] is not None and lo <= r["st"]["G"] < hi)
             for lo, hi in G_BINS},
        n_stars_with_results=len({r["star"] for r in rows}),
        n_not_blended_flag=rate(rows, lambda r: not r["st"]["blended_theirs"]),
        n_blended_flag=rate(rows, lambda r: r["st"]["blended_theirs"]))
    # extra diagnostics: flag-specific rates
    for fl in ("saturated", "blended", "too_few_samples", "no_bracket", "partial_visit"):
        out[f"flag_{fl}"] = rate(rows, lambda r, fl=fl: fl in r["flags"])
    sts = {r["star"]: r["st"] for r in rows}
    out["blend_theirs_only_stars"] = sum(1 for x in sts.values() if x["blended_ours"] is not None and x["blended_theirs"] and not x["blended_ours"])
    out["blend_ours_only_stars"] = sum(1 for x in sts.values() if x["blended_ours"] is not None and x["blended_ours"] and not x["blended_theirs"])
    out["blend_flag_mismatch_stars"] = sum(1 for s in {r["star"]: r["st"] for r in rows}.values()
                                           if s["blended_ours"] is not None and s["blended_ours"] != s["blended_theirs"])
    return out


# ------------------------------------------------------------------ step 2 --
def load_thresholds_module():
    spec = importlib.util.spec_from_file_location("thr10", Path(__file__).with_name("10_thresholds.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def step2(recompute):
    thr = load_thresholds_module() if recompute else None
    out = {}
    for field in ("barnard", "epsindi"):
        t = Table.read(DATA / "phasec" / f"inj_thresholds_{field}.ecsv")
        info = {}
        if recompute:
            meas, visits, sids, G, blended = thr.measure_field(field)
            t2 = thr.compare_all(meas, visits, sids, G, blended)
            z1, z2 = np.asarray(t["M2_z"], float), np.asarray(t2["M2_z"], float)
            same_rows = len(t) == len(t2) and np.all(np.asarray(t["source_id"]) == np.asarray(t2["source_id"]))
            diff = float(np.nanmax(np.abs(z1 - z2))) if same_rows else None
            info["recompute_max_abs_dz_vs_cache"] = diff
            info["recompute_same_rows"] = bool(same_rows)
            info["recompute_nan_pattern_equal"] = bool(same_rows and np.array_equal(np.isfinite(z1), np.isfinite(z2)))
            t = t2
        z = np.asarray(t["M2_z"], float)
        fl = np.asarray([str(x) for x in t["flags"]])
        det = np.asarray(t["detector"])
        sat = np.asarray(t["saturated"], bool)
        rows = [dict(z=v, fl=f, det=d, sat=s_) for v, f, d, s_ in zip(z, fl, det, sat) if np.isfinite(v)]
        info.update(
            n_stars=int(len(set(np.asarray(t["source_id"])))),
            all_detectors=rate(rows), detector2=rate(rows, lambda r: r["det"] == 2),
            all_detectors_unflagged=rate(rows, lambda r: r["fl"] in ("", "--")),
            all_detectors_unsaturated=rate(rows, lambda r: not r["sat"]),
            detector2_unflagged=rate(rows, lambda r: r["det"] == 2 and r["fl"] in ("", "--")))
        out[field] = info
    pooled = rate(out_rows(out, "barnard") + out_rows(out, "epsindi")) if False else None
    k = sum(out[f]["all_detectors"]["k"] for f in out)
    n = sum(out[f]["all_detectors"]["n"] for f in out)
    lo, hi = wilson(k, n)
    out["pooled_all_detectors"] = dict(k=int(k), n=int(n), pct=100 * k / n, lo68=100 * lo, hi68=100 * hi)
    k2 = sum(out[f]["detector2"]["k"] for f in ("barnard", "epsindi"))
    n2 = sum(out[f]["detector2"]["n"] for f in ("barnard", "epsindi"))
    lo, hi = wilson(k2, n2)
    out["pooled_detector2"] = dict(k=int(k2), n=int(n2), pct=100 * k2 / n2, lo68=100 * lo, hi68=100 * hi)
    return out


def out_rows(*a):  # placeholder kept trivial (pooled computed from counts)
    return []


# ------------------------------------------------------------------ step 3 --
def cutout_position(slug, det, st, obs_ids, cutdir):
    """Star pixel position and margin in the local cutouts (for the exposures we have)."""
    xs, ys, mar, shape = [], [], [], None
    for o in obs_ids:
        p = cutdir / f"{o}_D{det}.fits"
        if not p.exists():
            continue
        c = m2ref.load_cutout(p)
        ny, nx = c["P"].shape
        shape = (nx, ny)
        ra, dec = st["ra"], st["dec"]
        x, y = c["wcs"].world_to_pixel_values(ra, dec)
        xs.append(float(x))
        ys.append(float(y))
        mar.append(min(float(x), nx - 1 - float(x), float(y), ny - 1 - float(y)))
    if not xs:
        return None
    return dict(n_cutouts=len(xs), x_median=float(np.median(xs)), y_median=float(np.median(ys)), cutout_nx_ny=shape,
                min_margin_px=float(np.min(mar)), median_margin_px=float(np.median(mar)),
                covers_star=bool(np.min(mar) >= -0.5))


def offenders(slug, d, rows, stars, tgt, k=5):
    cutdir = FIELDS[slug][1]
    det = d["detector"]
    tgt_sat = None
    tg = stars[tgt["id"]]
    ms = tg["meas"]
    tgt_sat = float(np.mean([m["measurement"]["saturated"] for m in ms])) if ms else None
    best = {}
    for r in sorted(rows, key=lambda r: -abs(r["z"])):
        best.setdefault(r["star"], r)
    top = list(best.values())[:k]
    res = []
    for r in top:
        st = r["st"]
        reasons = []
        if st["var"] == "VARIABLE":
            reasons.append("Gaia phot_variable_flag VARIABLE")
        if st["blended_theirs"]:
            nb = st["neighbour"]
            reasons.append("blend" + (f" (neighbour G {nb['G']:.2f} at {nb['sep_arcsec']:.1f} arcsec)" if nb else ""))
        if st["bright"] is not None:
            reasons.append(f"bright neighbour G {st['bright']['G']:.2f} at {st['bright']['sep_arcsec']/60:.2f} arcmin")
        if not st["isTarget"] and st["dist_arcmin"] < 3.0 and (tg["G"] is not None and tg["G"] < 12.0):
            reasons.append(f"{st['dist_arcmin']:.2f} arcmin from the G {tg['G']:.2f} target "
                           f"(saturated in {100 * (tgt_sat or 0):.0f}% of its exposures)")
        if st["isTarget"]:
            reasons.append(f"the target itself (G {st['G']}, saturated in {100 * (tgt_sat or 0):.0f}% of exposures)")
        v = [r["a"], r["b"]]
        rej = Counter(m["measurement"]["reason"] for m in st["meas"] if m["visit"] in v)
        edge = rej.get("edge", 0) + rej.get("outside_cutout", 0)
        obs = [m["id"] for m in st["meas"] if m["visit"] in v]
        pos = cutout_position(slug, det, st, obs, cutdir) if st["G"] is not None or st["isTarget"] else None
        if pos is not None and not pos["covers_star"]:
            pos["note"] = "our local cutouts (target-centred, small) do not cover this star; position not usable"
        # edge: annulus (r < 7 px) truncated when the margin is below 7 px, or their own edge rejections
        if edge >= 3 or (pos and pos["covers_star"] and pos["min_margin_px"] < 7.0):
            reasons.append(f"cutout edge: {edge} edge/outside rejections" + (
                f", x,y median ({pos['x_median']:.0f},{pos['y_median']:.0f}) in {pos['cutout_nx_ny']} cutouts, min margin {pos['min_margin_px']:.0f} px"
                if pos and pos["covers_star"] else ""))
        acc = [st["accepted"].get(str(i), 0) for i in v]
        if any(f in r["flags"] for f in ("too_few_samples", "no_bracket", "partial_visit")) or min(acc) < 8:
            reasons.append(f"few points: accepted {acc}, flags {[f for f in r['flags'] if f in ('too_few_samples','no_bracket','partial_visit')]}")
        if "saturated" in r["flags"] and not st["isTarget"]:
            reasons.append("saturated flag (a measured exposure of this star carries the flag)")
        res.append(dict(star=r["star"], G=st["G"], dist_arcmin=round(st["dist_arcmin"], 2), pair=[r["a"], r["b"]], z=r["z"],
                        frac=r["frac"], flags=r["flags"], gaia_var=st["var"], reasons=reasons or ["none found"],
                        reject_reasons_in_pair_visits=dict(rej), position=pos))
    return res


# ------------------------------------------------------------------ step 5 --
def rwaur_analysis(d, rows, stars, tgt, g):
    out = {}
    cands = [r for r in rows if r["frac"] is not None and -0.33 <= r["frac"] <= -0.25 and r["plain_frac"] is not None
             and r["ps_frac"] is not None and abs(r["plain_frac"] - r["frac"]) < 0.06 and abs(r["ps_frac"] - r["frac"]) < 0.06]
    out["candidates"] = [dict(star=r["star"], G=r["st"]["G"], pair=[r["a"], r["b"]], z=r["z"], frac=r["frac"], plain=r["plain_frac"],
                              ps=r["ps_frac"], flags=r["flags"]) for r in cands]
    t = [r for r in cands if r["st"]["isTarget"]]
    if not t:
        return out
    r = t[0]
    st = r["st"]
    out["pair"] = [r["a"], r["b"]]
    # neighbour in the same candidate list
    others = [c for c in cands if not c["st"]["isTarget"] and (c["a"], c["b"]) == (r["a"], r["b"])]
    if others:
        o = others[0]["st"]
        cosd = np.cos(np.deg2rad(st["dec"]))
        out["second_star_same_result"] = dict(star=o["id"], G=o["G"], sep_arcsec=float(np.hypot((o["ra"] - st["ra"]) * cosd,
                                                                                         o["dec"] - st["dec"]) * 3600),
                                              note="the two Gaia sources fall in the same 12.3 arcsec aperture, so the two results "
                                                   "are one measurement counted twice")
    a, b = r["a"], r["b"]
    mm = {m["id"]: m for m in st["meas"]}
    res = r["res"]
    per = res["perWavelength"]
    out["per_wavelength"] = [dict(w0=p["w0"], fluxA=p["fluxA"], errA=p["errA"], fluxB=p["fluxB"], errB=p["errB"], nA=p["nA"],
                                  nB=p["nB"], D=p["D"], z=p["z"], idA=p["idA"]) for p in per]
    out["skipped"] = res.get("skipped")
    out["verdict"] = res.get("verdict")
    out["accepted"] = st["accepted"]
    cutdir = FIELDS["rw-aur"][1]
    det = d["detector"]
    # empirical saturation level from every local detector cutout of the field
    ov, nov = [], []
    cache = {}
    for p in sorted(cutdir.glob(f"*_D{det}.fits")):
        c = m2ref.load_cutout(p)
        from astropy.io import fits
        with fits.open(p, memmap=False) as hl:
            im = np.asarray(hl["IMAGE"].data, float)
        FL = c["FL"]
        sat = (FL & (1 << 1)) != 0
        okp = ((FL & (m2ref.SATURATED_MASK | m2ref.BAD_DATA_MASK)) == 0) & np.isfinite(im)
        ov.append(im[sat & np.isfinite(im)])
        nov.append(im[okp])
        cache[p.name[:-8]] = (c, im)
    ov, nov = np.concatenate(ov), np.concatenate(nov)
    out["saturation_empirical_MJy_per_sr"] = dict(
        note="no saturation keyword in the cutout headers (IMAGE is in MJy/sr, not counts); empirical level from every "
             "local detector-2 cutout of the field: IMAGE where raw FLAGS bit 1 (OVERFLOW) is set versus pixels without bits "
             "1, 15, 26 or BAD_DATA",
        overflow_pixels=dict(n=int(ov.size), min=float(ov.min()) if ov.size else None,
                             p5=float(np.percentile(ov, 5)) if ov.size else None, median=float(np.median(ov)) if ov.size else None),
        clean_pixels_max=float(nov.max()))
    # exposures feeding the model: window of each selected w0 in each visit
    feed = []
    for p in per:
        w0, b0 = p["w0"], p["b0"]
        for v in (a, b):
            for m in st["meas"]:
                if m["visit"] != v:
                    continue
                me = m["measurement"]
                if me["ok"] and abs(m["wavelength"] - w0) <= 2.5 * b0:
                    feed.append(dict(w0=w0, visit=v, id=m["id"], lam=m["wavelength"], flux=me["flux"], err=float(np.sqrt(me["variance"])),
                                     their_saturated=bool(me["saturated"])))
    # local-cutout evidence for each fed exposure
    for f in feed:
        key = f["id"]
        if key in cache:
            c, im = cache[key]
            ra, dec, _ = propagate(g[g["source_id"] == int(st["id"])], c["mjd"]) if (g["source_id"] == int(st["id"])).any() else ([st["ra"]], [st["dec"]], None)
            x, y = c["wcs"].world_to_pixel_values(ra[0], dec[0])
            m = m2ref.measure_pixels(c["P"], c["V"], c["FL"], float(x), float(y))
            xi, yi = int(np.rint(x)), int(np.rint(y))
            sl = (slice(max(0, yi - 2), yi + 3), slice(max(0, xi - 2), xi + 3))
            flo = int(np.bitwise_or.reduce(c["FL"][sl].ravel()))
            f.update(our_flux=m["flux"], our_ok=bool(m["ok"]), our_saturated=bool(m["saturated"]),
                     peak_IMAGE_5x5=float(np.nanmax(im[sl])), peak_P_5x5=float(np.nanmax(c["P"][sl])),
                     bits_5x5=[int(i) for i in range(32) if flo >> i & 1 and i in (1, 15, 26)],
                     overflow_pixels_5x5=int(((c["FL"][sl] >> 1) & 1).sum()))
    out["feeding_exposures"] = feed
    out["n_feed"] = len(feed)
    out["n_feed_their_saturated"] = sum(f["their_saturated"] for f in feed)
    out["n_feed_overflow_in_5x5"] = sum(f.get("overflow_pixels_5x5", 0) > 0 for f in feed)
    # all exposures of both visits: rejected vs accepted
    allx = []
    for m in st["meas"]:
        if m["visit"] in (a, b):
            me = m["measurement"]
            allx.append(dict(id=m["id"], visit=m["visit"], ok=me["ok"], reason=me["reason"], saturated=me["saturated"],
                             flux=me["flux"], lam=m["wavelength"]))
    out["all_exposures_in_pair"] = allx
    out["counts"] = dict(accepted=sum(x["ok"] for x in allx), rejected=sum(not x["ok"] for x in allx),
                         rejected_reasons=dict(Counter(x["reason"] for x in allx if not x["ok"])),
                         saturated_flag_any=sum(x["saturated"] for x in allx),
                         accepted_with_saturated_flag=sum(x["ok"] and x["saturated"] for x in allx))
    return out


# ------------------------------------------------------------------ main --
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("readouts", help="directory holding the five readout JSON files")
    ap.add_argument("--no-recompute", action="store_true")
    a = ap.parse_args()
    readouts = Path(a.readouts)
    paper = dict(Barnard="barnards-star", EpsIndi="eps-indi-b", RWAur="rw-aur", WISE0855="wise-0855", RDra="r-dra")
    expect = {"barnards-star": (10, 117), "eps-indi-b": (6, 123), "rw-aur": (9, 119), "wise-0855": (2, 41), "r-dra": (34, 114)}
    res = dict(fields={}, reproduce={})
    data = {}
    print("== Step 0: reproduce the counts")
    for slug in FIELDS:
        d, g, rows, stars, tgt = load_field(slug, readouts)
        data[slug] = (d, g, rows, stars, tgt)
        r = rate(rows)
        res["reproduce"][slug] = dict(k=r["k"], n=r["n"], expected=list(expect[slug]), match=(r["k"], r["n"]) == expect[slug])
        print(f"  {slug:14s} k/N = {r['k']}/{r['n']} (expected {expect[slug][0]}/{expect[slug][1]}) "
              f"{'OK' if (r['k'], r['n']) == expect[slug] else 'DIFFERS'}")

    print("\n== Step 1: |z| >= 3 rates, k/N = pct [Wilson 68%]")
    for slug, (d, g, rows, stars, tgt) in data.items():
        s1 = step1(slug, rows)
        res["fields"][slug] = dict(step1=s1)
        print(f"\n-- {slug}  ({s1['n_stars_with_results']} stars with results, blend-flag mismatch vs ours: "
              f"{s1['blend_flag_mismatch_stars']} stars: {s1['blend_theirs_only_stars']} only theirs, {s1['blend_ours_only_stars']} only ours)")
        print(f"   (a) all                         {fmt(s1['a_all'])}")
        print(f"   (b) no flags                    {fmt(s1['b_noflags'])}")
        print(f"   (c) steady cuts                 {fmt(s1['c_steady'])}")
        print(f"   (c2) steady cuts + RUWE < 1.4   {fmt(s1['c2_steady_ruwe'])}")
        print(f"   blended flag / not blended      {fmt(s1['n_blended_flag'])} / {fmt(s1['n_not_blended_flag'])}")
        print("   flag subsets: " + "; ".join(f"{k[5:]} {fmt(v)}" for k, v in s1.items() if k.startswith("flag_")))
        print("   (d) distance from target [arcmin]: " + "; ".join(f"{k}: {fmt(v)}" for k, v in s1["d_distance_arcmin"].items()))
        print("   (e) G bin: " + "; ".join(f"{k}: {fmt(v)}" for k, v in s1["e_G"].items()))

    print("\n== Step 2: our 0.9 percent and the like-for-like statistic")
    res["step2"] = step2(not a.no_recompute)
    for f in ("barnard", "epsindi"):
        s = res["step2"][f]
        print(f"  {f}: {s['n_stars']} stars; M2 all detectors {fmt(s['all_detectors'])}; detector 2 only {fmt(s['detector2'])}; "
              f"all-det unflagged {fmt(s['all_detectors_unflagged'])}; unsaturated {fmt(s['all_detectors_unsaturated'])}; "
              f"det 2 unflagged {fmt(s['detector2_unflagged'])}")
        if "recompute_max_abs_dz_vs_cache" in s:
            print(f"     recomputed with m2ref.compare_visits: same rows {s['recompute_same_rows']}, "
                  f"max |dz| vs cache {s['recompute_max_abs_dz_vs_cache']}")
    print(f"  pooled all detectors {fmt(res['step2']['pooled_all_detectors'])}; pooled detector 2 {fmt(res['step2']['pooled_detector2'])}")

    print("\n== Step 3: top offenders (distinct stars, ranked by max |z|)")
    for slug, (d, g, rows, stars, tgt) in data.items():
        off = offenders(slug, d, rows, stars, tgt)
        res["fields"][slug]["step3_offenders"] = off
        print(f"-- {slug}")
        for o in off:
            print(f"   ...{o['star'][-8:]} G={o['G']} d={o['dist_arcmin']}' pair {o['pair']} z={o['z']:.1f} frac={o['frac']:.3f} "
                  f"var={o['gaia_var']} flags={o['flags']}\n      -> " + "; ".join(o["reasons"]))

    print("\n== Step 4: WISE 0855 binomial")
    wd, wg, wrows, wstars, wtgt = data["wise-0855"]
    n = len(wrows)
    k = sum(abs(r["z"]) >= 3 for r in wrows)
    p_ours = res["step2"]["pooled_all_detectors"]["pct"] / 100.0
    p_d2 = res["step2"]["pooled_detector2"]["pct"] / 100.0
    stars_w = Counter(r["star"] for r in wrows)
    w = dict(N=n, k=int(k), n_distinct_stars=len(stars_w), max_results_per_star=max(stars_w.values()),
             P_ge2_p0p009=float(binom.sf(1, n, 0.009)), P_ge2_p_like_all_det=float(binom.sf(1, n, p_ours)),
             P_ge2_p_like_det2=float(binom.sf(1, n, p_d2)), p_like_all_det=p_ours, p_like_det2=p_d2,
             P_ge2_p_their_c_steady=None)
    c = rate(wrows, steady)
    w["steady_cut_rate_in_their_file"] = c
    w["independence"] = ("each star contributes exactly one visit pair (two visits), so the 41 results are 41 different stars, "
                         "no repeated star; they are not fully independent noise draws because every star is measured in the "
                         "same 21 + 21 exposures (common-mode background or zodi errors, and the target aperture neighbours), "
                         "and the 'target' entry is not a Gaia star")
    res["step4_wise0855"] = w
    print(f"  N={n} k={k} distinct stars {len(stars_w)} (max {max(stars_w.values())} per star)")
    print(f"  P(k>=2 | N={n}, p=0.009) = {w['P_ge2_p0p009']:.4f}; with p={100 * p_ours:.2f}% (like-for-like, all detectors) = "
          f"{w['P_ge2_p_like_all_det']:.4f}; with p={100 * p_d2:.2f}% (detector 2) = {w['P_ge2_p_like_det2']:.4f}")

    print("\n== Step 5: RW Aur -29 percent pair")
    d, g, rows, stars, tgt = data["rw-aur"]
    rw = rwaur_analysis(d, rows, stars, tgt, g)
    res["step5_rwaur"] = rw
    print(f"  candidates (all three estimators within 0.06 of each other, fractional change -0.25 to -0.33): "
          f"{[(c['star'][-6:], c['pair'], round(c['frac'], 3), round(c['plain'], 3), round(c['ps'], 3), c['flags']) for c in rw['candidates']]}")
    if "pair" in rw:
        print(f"  target pair {rw['pair']} verdict {rw['verdict']}; accepted per visit {rw['accepted']}; second star: "
              f"{rw.get('second_star_same_result')}")
        print(f"  per wavelength: {[(round(p['w0'], 3), round(p['fluxA'], 1), round(p['fluxB'], 1), round(p['z'], 1), p['nA'], p['nB']) for p in rw['per_wavelength']]}")
        print(f"  skipped: {rw['skipped']}")
        print(f"  counts in the two visits: {rw['counts']}")
        print(f"  saturation: {json.dumps(rw['saturation_empirical_MJy_per_sr'])}")
        print(f"  {rw['n_feed']} exposures feed the model; their saturated flag set in {rw['n_feed_their_saturated']}; "
              f"OVERFLOW bit in the 5x5 in {rw['n_feed_overflow_in_5x5']}")
        for f in rw["feeding_exposures"]:
            print("   ", {k: (round(v, 3) if isinstance(v, float) else v) for k, v in f.items()})
    out = dict(
        input_dir="<readouts-dir>", input_files=[f"{k}.json" for k in FIELDS], cuts=("steady star: not blended (their blended flag = m2ref.is_blended), no Gaia source G < 9 within "
                                       "180 arcsec, phot_variable_flag != VARIABLE, 12 <= G <= 16.5, not the target; c2 adds RUWE < 1.4"),
        interval="Wilson score, z = 1 (68.3 percent)", **res)
    update_results("browser_false_alarms", out)
    print("\nwrote docs/results.json section browser_false_alarms")


if __name__ == "__main__":
    main()
