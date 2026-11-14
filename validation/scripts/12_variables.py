"""12: real-variable demonstration: R Dra saturation check, then known unsaturated Gaia variables in
the Barnard and Eps Indi cutouts measured with the matched readout next to constant partners.

usage: uv run python scripts/12_variables.py [--refresh]
Inputs : data/cutouts/{barnard,epsindi}, data/index_<field>.csv, data/gaia_<field>.ecsv, data/phaseb/<field>
         (phase B constant star sample); SIA2 + S3 range reads for R Dra (60 tiny cutouts, data/rdra/)
Caches : data/phasec/variables_*.ecsv
Outputs: docs/figures/variable_demo.png (only if a usable variable exists); results section "variable_demo".

Method (see docs/algorithm.md): forced photometry m2ref.measure_pixels per exposure (2 px aperture, inflated
variance), per detector and visit m2ref.compare_visits for every visit pair (matched = per-visit
straight-line spectral model evaluated at the same wavelengths; "plain" = the best nearest-wavelength pair).
"""
import argparse
import io
import sys
import time
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import requests
from astropy.table import Table

from wp import m2ref
from wp import movers as M
from wp import phaseb
from wp.config import DATA, FIGURES, USER_AGENT
from wp.gaia import gaia_path, propagate
from wp.results import metric, update_results
from wp.wavelength import cal_lambda

warnings.filterwarnings("ignore")
SCRIPT = "scripts/12_variables.py"
PC = DATA / "phasec"
PC.mkdir(parents=True, exist_ok=True)
RDRA = DATA / "rdra"
TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
MIN_ACCEPT = 0.5          # fraction of in-cutout exposures that must be accepted by measure_pixels
MAIN_VISITS = {"barnard": [0, 2, 4], "epsindi": [0, 1, 2, 3]}
TEXT = []


def say(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    TEXT.append(s)


def mad_sigma(v):
    v = np.asarray(v, float)
    v = v[np.isfinite(v)]
    return float(1.4826 * np.median(np.abs(v - np.median(v)))) if len(v) else np.nan


# ------------------------------------------------------------------ a. R Dra
def rdra(refresh=False):
    from wp import io as wio
    from wp.exposures import query_exposures
    from wp.registration import flag_bits
    say("\n=== a. R Dra saturation check ===")
    # Gaia DR3 1648328016354496384 (V* R Dra, Mira), values as used by the site (src/lib/spherex/resolve.ts)
    tg = dict(ra=248.1673783672889, dec=66.75500674547219, ref_mjd=M.GAIA_MJD, pmra=-20.642811719160797, pmdec=6.148818852711324, parallax=1.251)
    ra, de = M.predict(tg, 61041.0)
    sia = PC / "variables_rdra_sia.ecsv"
    if sia.exists() and not refresh:
        tab = Table.read(sia)
    else:
        tab = None
        for k in range(8):
            try:
                tab, info = query_exposures(ra, de)
                break
            except Exception as e:  # noqa: BLE001
                print("SIA retry", repr(e)[:80], flush=True)
                time.sleep(8 * (k + 1))
        tab.write(sia, overwrite=True)
    mjd = np.asarray(tab["mjd_mid"], float)
    say(f"R Dra (Gaia DR3 1648328016354496384, G 6.4, Mira) SIA2 at ({ra:.5f}, {de:.5f}): {len(tab)} exposures, MJD {mjd.min():.1f} to {mjd.max():.1f}")
    order = np.argsort(mjd)
    pick = order[np.unique(np.linspace(0, len(order) - 1, 60).round().astype(int))]
    b0 = wio.bytes_downloaded()
    jobs, rows = [], []
    for i in pick:
        r = tab[int(i)]
        hdr = wio.read_image_header(str(r["s3_key"]))
        rr, dd = M.predict(tg, float(r["mjd_mid"]))
        x, y, on = wio.target_pixel(hdr, rr, dd)
        out = RDRA / "cutouts" / f"{r['obs_id']}_D{int(r['detector'])}.fits"
        rows.append(dict(obs_id=str(r["obs_id"]), det=int(r["detector"]), mjd=float(r["mjd_mid"]), x=x, y=y, on=on, path=out))
        if on and 8 <= x <= 2031 and 8 <= y <= 2031:
            jobs.append(dict(s3_key=str(r["s3_key"]), x_c=x, y_c=y, half=6, out_path=out, meta=dict(release=str(r["release"]), field="rdra")))
    res = wio.fetch_many(jobs, workers=6)
    errs = [e for _, e in res if e]
    nbytes = wio.bytes_downloaded() - b0
    say(f"   sampled {len(pick)} exposures evenly in time (60), {len(jobs)} on detector with tiny cutouts (half=6); download {nbytes / 1e6:.1f} MB; errors {len(errs)}")
    n_ok = n_sat = 0
    per_det = {}
    peaks = []
    for r in rows:
        if not r["path"].exists():
            continue
        fr = M.load_frame(r["path"])
        x0, y0 = fr["x0"], fr["y0"]
        # position within the cutout from the detector position
        xc, yc = r["x"] - x0, r["y"] - y0
        fs = M.flag_summary(fr, xc, yc)
        if not fs["inside"]:
            continue
        n_ok += 1
        n_sat += fs["saturated"]
        d = per_det.setdefault(r["det"], [0, 0, 0, 0, 0])
        d[0] += 1
        d[1] += fs["saturated"]
        d[2] += fs["overflow"]
        d[3] += fs["nonlinear"]
        d[4] += fs["bloom"]
        xi, yi = int(round(xc)), int(round(yc))
        peaks.append(float(np.nanmax(fr["R"][max(0, yi - 1):yi + 2, max(0, xi - 1):xi + 2])))
    say(f"   exposures checked: {n_ok}; central 5x5 with OVERFLOW/NONLINEAR/BLOOM: {n_sat}")
    for d in sorted(per_det):
        a = per_det[d]
        say(f"   D{d}: {a[1]}/{a[0]} saturated (OVERFLOW {a[2]}, NONLINEAR {a[3]}, BLOOM {a[4]})")
    say(f"   median peak 3x3 value {np.nanmedian(peaks):.0f} MJy/sr where finite ({int(np.sum(~np.isfinite(peaks)))} of {len(peaks)} have NaN in the 3x3, i.e. masked); Barnard's Star peaks near 1000 MJy/sr")
    usable = n_ok - n_sat
    if usable == 0:
        say("   => R Dra is unusable for this readout: saturated in every sampled exposure (like Barnard's Star and RW Aur).")
    else:
        say(f"   => R Dra: {usable} of {n_ok} sampled exposures are unsaturated; see the per-detector counts above (usable only there).")
    return dict(n_exposures=metric(int(len(tab)), "exposures", None, SCRIPT, "SIA2, DR1+QR3 deduplicated"),
                n_sampled_checked=metric(int(n_ok), "exposures", 60, SCRIPT, "evenly spaced in time"),
                n_saturated=metric(int(n_sat), "exposures", int(n_ok), SCRIPT, "central 5x5 with OVERFLOW (1), NONLINEAR (15) or BLOOM (26)"),
                per_detector_saturated={f"D{d}": metric(int(a[1]), "exposures", int(a[0]), SCRIPT) for d, a in sorted(per_det.items())},
                download_bytes=metric(int(nbytes), "bytes", None, SCRIPT, "headers and cutouts fetched this run (0 when cached)"))


# ------------------------------------------------------------------ b. candidate variables
def gaia_variables(field, ra, dec, refresh=False):
    p = PC / f"variables_gaia_{field}.ecsv"
    if p.exists() and not refresh:
        return Table.read(p)
    q = f"""SELECT g.source_id AS sid, g.ra AS ra, g.dec AS dec, g.pmra AS pmra, g.pmdec AS pmdec, g.parallax AS parallax,
 g.phot_g_mean_mag AS gmag, g.bp_rp AS bp_rp, g.ruwe AS ruwe, g.phot_g_n_obs AS nobs, g.phot_variable_flag AS varflag,
 v.range_mag_g_fov AS range_g, v.std_dev_mag_g_fov AS std_g, v.num_selected_g_fov AS nsel, v.in_vari_classification_result AS in_class,
 v.in_vari_long_period_variable AS lpv, v.in_vari_eclipsing_binary AS ecl, v.in_vari_rotation_modulation AS rot, v.in_vari_rrlyrae AS rrl,
 v.in_vari_cepheid AS ceph, v.in_vari_short_timescale AS shortt
FROM gaiadr3.gaia_source AS g LEFT JOIN gaiadr3.vari_summary AS v ON g.source_id = v.source_id
WHERE 1 = CONTAINS(POINT('ICRS', g.ra, g.dec), CIRCLE('ICRS', {ra}, {dec}, 0.3)) AND g.phot_variable_flag = 'VARIABLE'
AND g.phot_g_mean_mag BETWEEN 10 AND 17"""
    r = requests.post(TAP, data=dict(REQUEST="doQuery", LANG="ADQL", FORMAT="votable", QUERY=q), headers={"User-Agent": USER_AGENT}, timeout=300)
    r.raise_for_status()
    t = Table.read(io.BytesIO(r.content), format="votable")
    t = Table(t, masked=False)
    out = Table()
    for c in t.colnames:
        col = t[c]
        out[c] = np.asarray(col.filled(np.nan) if col.dtype.kind == "f" and hasattr(col, "filled") else (col.filled(0) if hasattr(col, "filled") else col))
    out.meta["query"] = q
    out.write(p, overwrite=True)
    return out


def isolated(sid, ra_all, de_all, g_all, i, mjd):
    """No other Gaia source with G < G_star + 3 within 20 arcsec at `mjd`, none brighter than G=9 within 3 arcmin
    (the phase A isolation, evaluated at the epoch)."""
    dra = (ra_all - ra_all[i]) * np.cos(np.deg2rad(de_all[i])) * 3600
    dde = (de_all - de_all[i]) * 3600
    r = np.hypot(dra, dde)
    near = (r < 20.0) & (g_all < g_all[i] + 3.0)
    near[i] = False
    bright = (r < 180.0) & (g_all < 9.0)
    bright[i] = False
    return not near.any() and not bright.any()


def measure_star(field, star, rows, frames_cache):
    """Forced photometry (m2ref.measure_pixels) of one star (dict ra, dec, pmra, pmdec, parallax) in every
    exposure of the field index. Returns Table per exposure."""
    one = Table([dict(ra=star["ra"], dec=star["dec"], pmra=star["pmra"], pmdec=star["pmdec"], parallax=star["parallax"])])
    recs = []
    for i, r in enumerate(rows):
        fr = frames_cache(i)
        ra, de, _ = propagate(one, fr["mjd"])
        x, y = fr["wcs"].world_to_pixel_values(ra[0], de[0])
        x, y = float(x), float(y)
        ph = m2ref.measure_pixels(fr["P"], fr["V"], fr["FL"], x, y)
        lam, bw = (np.nan, np.nan)
        if ph["reason"] != "outside_cutout":
            lam, bw = cal_lambda(fr["release"], fr["detector"], x + fr["x0"], y + fr["y0"])
        recs.append(dict(row=i, obs_id=fr["obs_id"], det=fr["detector"], visit=int(r["visit"]), mjd=fr["mjd"], x=x, y=y, ok=ph["ok"], reason=ph["reason"],
                         flux=ph["flux"], var=ph["var"], sat=ph["saturated"], lam=lam, bw=bw))
    return Table(rows=recs)


def acceptance(T):
    inside = np.asarray(T["reason"]) != "outside_cutout"
    ok = np.asarray(T["ok"], bool)
    sat = np.asarray(T["sat"], bool) & inside
    return float(ok.sum() / max(inside.sum(), 1)), int(inside.sum()), int(sat.sum())


def make_samples(T, det, visit):
    m = (np.asarray(T["det"]) == det) & (np.asarray(T["visit"]) == visit) & np.asarray(T["ok"], bool) & np.isfinite(np.asarray(T["lam"], float))
    return [dict(id=f"{T['obs_id'][i]}_D{det}", lam=float(T["lam"][i]), bw=float(T["bw"][i]), mjd=float(T["mjd"][i]), flux=float(T["flux"][i]),
                 var=float(T["var"][i]), saturated=bool(T["sat"][i])) for i in np.where(m)[0]]


def compare_star(T, visits):
    """compare_visits for every detector and visit pair (earlier first). Returns list of dict."""
    out = []
    for d in range(1, 7):
        sm = {v: make_samples(T, d, v) for v in visits}
        for ia, a in enumerate(visits):
            for b in visits[ia + 1:]:
                if len(sm[a]) < m2ref.MIN_EXPOSURES or len(sm[b]) < m2ref.MIN_EXPOSURES:
                    continue
                res = m2ref.compare_visits(sm[a], sm[b])
                if res["n_w0"] == 0:
                    continue
                gap = (b - a)
                out.append(dict(det=d, a=a, b=b, nA=len(sm[a]), nB=len(sm[b]), n_w0=res["n_w0"], z=res["z"], frac=res["frac"], D=res["D"], err=float(np.sqrt(res["var"])),
                                pz=res["plain"]["z"], pfrac=res["plain"]["frac"], pD=res["plain"]["D"], perr=float(np.sqrt(res["plain"]["var"])),
                                psz=res["ps"]["z"], psfrac=res["ps"]["frac"], flags=",".join(res["flags"]),
                                mean_plain_gap_bw=float(np.mean([k["plain_dlam_bw"] for k in res["per_w0"]]))))
    return out


def common_wavelength_fluxes(T, visits, n_w0=3):
    """Per detector: up to n_w0 evaluation wavelengths (greedy independent set of the visit with the most
    exposures) at which every visit has a bracketed model; matched flux per visit at each. Returns list of dict."""
    out = []
    for d in range(1, 7):
        sm = {v: make_samples(T, d, v) for v in visits}
        if any(len(sm[v]) < m2ref.MIN_EXPOSURES for v in visits):
            continue
        vref = max(visits, key=lambda v: len(sm[v]))
        good = []
        for s in m2ref.select_wavelengths(sm[vref]):
            vals = {}
            for v in visits:
                lam = np.array([x["lam"] for x in sm[v]])
                fl = np.array([x["flux"] for x in sm[v]])
                va = np.array([x["var"] for x in sm[v]])
                a, vv, n, reason = m2ref.spec_model(lam, fl, va, s["lam"], s["bw"])
                if reason != "ok":
                    break
                vals[v] = (a, float(np.sqrt(vv)))
            else:
                good.append(dict(det=d, w0=s["lam"], flux=vals))
        if good:
            idx = np.unique(np.linspace(0, len(good) - 1, min(n_w0, len(good))).round().astype(int))
            out += [good[i] for i in idx]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    t0 = time.time()
    results = {}
    results["rdra"] = rdra(a.refresh)

    # ---------------- b. candidate variables in the fields we hold
    say("\n=== b. known Gaia variables in the Barnard and Eps Indi cutouts ===")
    cands = []
    for field in ("barnard", "epsindi"):
        fc = {"barnard": (269.446, 4.768), "epsindi": (330.8925, -56.804)}[field]
        gv = gaia_variables(field, fc[0], fc[1], a.refresh)
        g = Table.read(gaia_path(field))
        rows = M.read_index(DATA / f"index_{field}.csv")
        rows = [r for r in rows if r["on_detector"] == "True"]
        mref = float(np.mean([float(r["mjd_mid"]) for r in rows]))
        ra_all, de_all, _ = propagate(g, mref)
        gg = np.asarray(g["phot_g_mean_mag"], float)
        sid_all = np.asarray(g["source_id"]).astype(np.int64)
        say(f"{field}: Gaia DR3 phot_variable_flag = VARIABLE, G 10-17, within 0.3 deg: {len(gv)} sources")
        n_cut = dict(total=len(gv), g_window=0, ruwe=0, isolated=0, in_cutout=0)
        # frame used to place stars in the cutouts: the middle frame
        fr0 = M.load_frame(DATA.parent / rows[len(rows) // 2]["cutout_path"])
        for row in gv:
            G = float(row["gmag"])
            if not (11.0 <= G <= 16.0):
                continue
            n_cut["g_window"] += 1
            if not (np.isfinite(row["ruwe"]) and row["ruwe"] < 1.4):
                continue
            n_cut["ruwe"] += 1
            i = np.where(sid_all == int(row["sid"]))[0]
            if len(i) == 0:
                continue
            if not isolated(int(row["sid"]), ra_all, de_all, gg, int(i[0]), mref):
                continue
            n_cut["isolated"] += 1
            one = Table([dict(ra=row["ra"], dec=row["dec"], pmra=row["pmra"], pmdec=row["pmdec"], parallax=row["parallax"])])
            ra_, de_, _ = propagate(one, mref)
            x, y = fr0["wcs"].world_to_pixel_values(ra_[0], de_[0])
            if not (20 <= x <= 300 and 20 <= y <= 300):
                continue
            n_cut["in_cutout"] += 1
            cands.append(dict(field=field, sid=int(row["sid"]), ra=float(row["ra"]), dec=float(row["dec"]), pmra=float(row["pmra"]), pmdec=float(row["pmdec"]),
                              parallax=float(row["parallax"]), gmag=G, bp_rp=float(row["bp_rp"]), nobs=int(row["nobs"]), std_g=float(row["std_g"]),
                              range_g=float(row["range_g"]), in_class=bool(row["in_class"]), lpv=bool(row["lpv"]), ecl=bool(row["ecl"]), rot=bool(row["rot"]),
                              rrl=bool(row["rrl"]), ceph=bool(row["ceph"]), shortt=bool(row["shortt"])))
        say(f"   cuts: G 11-16 {n_cut['g_window']}, RUWE < 1.4 {n_cut['ruwe']}, isolated (no G < G+3 within 20\", none G<9 within 3') {n_cut['isolated']}, "
            f"inside the central 280 px of the cutout {n_cut['in_cutout']}")
        results[f"{field}_cuts"] = {k: metric(int(v), "stars", None, SCRIPT) for k, v in n_cut.items()}
    say(f"{len(cands)} isolated, unflagged candidate variables; measuring all of them in every exposure (flags checked by measure_pixels)")
    amp = "std_dev_mag_g_fov from gaiadr3.vari_summary (standard deviation of the G magnitudes of the field-of-view transits)"
    say(f"Amplitude measure: {amp}")

    meas = {}
    for field in ("barnard", "epsindi"):
        rows = [r for r in M.read_index(DATA / f"index_{field}.csv") if r["on_detector"] == "True"]
        cache = {}

        def frame(i, rows=rows, cache=cache):
            if i not in cache:
                if len(cache) > 3:
                    cache.clear()
                cache[i] = m2ref.load_cutout(DATA.parent / rows[i]["cutout_path"])
            return cache[i]
        # measure all candidates of this field frame by frame (one cutout read per frame)
        fc = [c for c in cands if c["field"] == field]
        tabs = {c["sid"]: [] for c in fc}
        p = PC / f"variables_phot_{field}.ecsv"
        if p.exists() and not a.refresh:
            big = Table.read(p)
            for c in fc:
                m = np.asarray(big["sid"]) == c["sid"]
                tabs[c["sid"]] = big[m]
            if all(len(tabs[c["sid"]]) for c in fc):
                for c in fc:
                    meas[(field, c["sid"])] = tabs[c["sid"]]
                continue
        allrecs = []
        for i, r in enumerate(rows):
            fr = frame(i)
            for c in fc:
                one = Table([dict(ra=c["ra"], dec=c["dec"], pmra=c["pmra"], pmdec=c["pmdec"], parallax=c["parallax"])])
                ra, de, _ = propagate(one, fr["mjd"])
                x, y = fr["wcs"].world_to_pixel_values(ra[0], de[0])
                x, y = float(x), float(y)
                ph = m2ref.measure_pixels(fr["P"], fr["V"], fr["FL"], x, y)
                lam, bw = (np.nan, np.nan)
                if ph["reason"] != "outside_cutout":
                    lam, bw = cal_lambda(fr["release"], fr["detector"], x + fr["x0"], y + fr["y0"])
                allrecs.append(dict(sid=c["sid"], row=i, obs_id=fr["obs_id"], det=fr["detector"], visit=int(r["visit"]), mjd=fr["mjd"], x=x, y=y, ok=ph["ok"],
                                    reason=ph["reason"], flux=ph["flux"], var=ph["var"], sat=ph["saturated"], lam=lam, bw=bw))
            if (i + 1) % 100 == 0:
                print(f"   {field}: {i + 1}/{len(rows)} frames, {time.time() - t0:.0f} s", flush=True)
        big = Table(rows=allrecs)
        big.write(p, overwrite=True)
        for c in fc:
            meas[(field, c["sid"])] = big[np.asarray(big["sid"]) == c["sid"]]

    # acceptance per candidate
    say("Candidates (sorted by amplitude): Gaia id, field, G, BP-RP, amplitude std (mag), range (mag), Gaia class flags, accepted/in-cutout exposures, saturated-flag frames")
    table = []
    for c in sorted(cands, key=lambda c: -c["std_g"] if np.isfinite(c["std_g"]) else 0):
        T = meas[(c["field"], c["sid"])]
        fa, nin, nsat = acceptance(T)
        c.update(accept=fa, n_in=nin, n_sat=nsat)
        cls = ",".join(k for k in ("lpv", "ecl", "rot", "rrl", "ceph", "shortt") if c[k]) or ("classified-none" if c["in_class"] else "no class")
        say(f"   {c['sid']} {c['field']:8s} G {c['gmag']:.2f} BP-RP {c['bp_rp']:.2f}  std {c['std_g']:.3f} range {c['range_g']:.3f}  [{cls}]  accepted {fa * 100:.0f}% of {nin}; saturated frames {nsat}")
        table.append(c)
    usable = [c for c in table if np.isfinite(c["std_g"]) and c["accept"] >= MIN_ACCEPT and c["n_sat"] <= 0.05 * c["n_in"]]
    say(f"Usable (accepted >= {MIN_ACCEPT * 100:.0f}% of in-cutout exposures and saturation flags in the 5x5 in at most 5% of them; those few frames, flagged by a bright neighbour, are dropped by measure_pixels): {len(usable)}")
    if not usable:
        say("No usable unsaturated known variable in these fields; no figure made.")
        results["outcome"] = "no usable variable"
        update_results("variable_demo", dict(results, _text=TEXT))
        return
    # choose up to 3 variables with the largest amplitude, at least one per field if available is NOT required
    chosen = usable[:3]
    results["amplitude_measure"] = amp
    # ---------------- constant partners
    partners = []
    for c in chosen:
        field = c["field"]
        rows = [r for r in M.read_index(DATA / f"index_{field}.csv") if r["on_detector"] == "True"]
        mref = float(np.mean([float(r["mjd_mid"]) for r in rows]))
        S = phaseb.phaseb_stars(field, mref)        # constant, isolated, G 12-16.5 sample of phase B
        used = {p["sid"] for p in partners} | {x["sid"] for x in chosen}
        S = S[[int(s) not in used for s in S["source_id"]]]
        dG = np.abs(np.asarray(S["phot_g_mean_mag"], float) - c["gmag"])
        dc = np.abs(np.asarray(S["bp_rp"], float) - c["bp_rp"])
        order = np.argsort(np.where(dG <= 0.3, dc, 1e3 + dG))
        cache = {}

        def frame(i, rows=rows, cache=cache):
            if i not in cache:
                if len(cache) > 3:
                    cache.clear()
                cache[i] = m2ref.load_cutout(DATA.parent / rows[i]["cutout_path"])
            return cache[i]
        got = None
        for k in order[:8]:
            s = S[int(k)]
            if abs(float(s["phot_g_mean_mag"]) - c["gmag"]) > 0.3:
                break
            star = dict(ra=float(s["ra"]), dec=float(s["dec"]), pmra=float(s["pmra"]), pmdec=float(s["pmdec"]), parallax=float(s["parallax"]))
            pp = PC / f"variables_partner_{field}_{int(s['source_id'])}.ecsv"
            if pp.exists() and not a.refresh:
                T = Table.read(pp)
            else:
                T = measure_star(field, star, rows, frame)
                T.write(pp, overwrite=True)
            fa, nin, nsat = acceptance(T)
            if fa >= MIN_ACCEPT and nsat <= 0.05 * nin:
                got = dict(sid=int(s["source_id"]), field=field, gmag=float(s["phot_g_mean_mag"]), bp_rp=float(s["bp_rp"]), T=T, accept=fa, n_in=nin, of=c["sid"])
                break
        partners.append(got)
        say(f"Partner for {c['sid']} (G {c['gmag']:.2f}, BP-RP {c['bp_rp']:.2f}): " + (f"Gaia {got['sid']} G {got['gmag']:.2f} BP-RP {got['bp_rp']:.2f}, accepted {got['accept'] * 100:.0f}% of {got['n_in']}" if got else "none found within 0.3 mag"))

    # ---------------- comparisons
    say("\n=== c. matched and plain visit-to-visit differences (per detector and visit pair) ===")
    out = {}
    summary = []
    for c, pt in zip(chosen, partners):
        field = c["field"]
        visits = MAIN_VISITS[field]
        pair = [("variable", c, meas[(field, c["sid"])]), ("constant", pt, pt["T"] if pt else None)]
        for kind, st, T in pair:
            if T is None:
                continue
            res = compare_star(T, visits)
            out[(c["sid"], kind)] = res
            z = np.array([r["z"] for r in res]); f = np.array([r["frac"] for r in res])
            pz = np.array([r["pz"] for r in res]); pf = np.array([r["pfrac"] for r in res])
            sz = np.array([r["psz"] for r in res]); sf = np.array([r["psfrac"] for r in res])
            say(f"{kind:8s} Gaia {st['sid']} ({field}, G {st['gmag']:.2f}): {len(res)} detector x visit-pair comparisons; matched: median |z| {np.median(np.abs(z)):.2f}, rms z {np.sqrt(np.mean(z ** 2)):.2f}, "
                f"median |frac| {np.median(np.abs(f)) * 100:.1f}%, max |frac| {np.max(np.abs(f)) * 100:.1f}%;  plain best pair: median |z| {np.median(np.abs(pz)):.2f}, rms z {np.sqrt(np.mean(pz ** 2)):.2f}, "
                f"median |frac| {np.median(np.abs(pf)) * 100:.1f}%;  paired stack: median |z| {np.nanmedian(np.abs(sz)):.2f}, median |frac| {np.nanmedian(np.abs(sf)) * 100:.1f}%")
            summary.append(dict(sid=st["sid"], kind=kind, field=field, G=st["gmag"], n=len(res), rms_z=float(np.sqrt(np.mean(z ** 2))), med_abs_z=float(np.median(np.abs(z))),
                                med_abs_frac=float(np.median(np.abs(f)) * 100), max_abs_frac=float(np.max(np.abs(f)) * 100), plain_rms_z=float(np.sqrt(np.mean(pz ** 2))),
                                plain_med_abs_frac=float(np.median(np.abs(pf)) * 100), ps_med_abs_z=float(np.nanmedian(np.abs(sz))), ps_med_abs_frac=float(np.nanmedian(np.abs(sf)) * 100)))
        say("   detail per detector and visit pair (matched frac +/- err, z | plain frac, z | n_w0):")
        for kind, st, T in pair:
            if T is None:
                continue
            for r in out[(c["sid"], kind)]:
                fe = r["err"] / max(abs(r["D"] / r["frac"]) if r["frac"] else np.nan, 1e-30) if r["frac"] else np.nan
                say(f"      {kind:8s} D{r['det']} v{r['a']}->v{r['b']}: matched {r['frac'] * 100:+6.1f}% (z {r['z']:+6.1f}) | plain {r['pfrac'] * 100:+6.1f}% (z {r['pz']:+6.1f}) | n_w0 {r['n_w0']}  nA/nB {r['nA']}/{r['nB']}")
        # per-visit matched fluxes at a few common wavelengths
        cw = common_wavelength_fluxes(meas[(c["sid"], )[0] if False else (field, c["sid"])], visits)
        say(f"   matched flux per visit at up to 3 common wavelengths per detector, variable Gaia {c['sid']} (MJy/sr summed): w0 [um]; flux relative to the first visit")
        for k in cw:
            f0 = k["flux"][visits[0]][0]
            say(f"      D{k['det']} w0 {k['w0']:.3f}: " + "  ".join(f"v{v} {k['flux'][v][0] / f0:.3f}+/-{k['flux'][v][1] / abs(f0):.3f}" for v in visits))
        if pt:
            cwp = common_wavelength_fluxes(pt["T"], visits)
            say(f"   same for the constant partner Gaia {pt['sid']}:")
            for k in cwp:
                f0 = k["flux"][visits[0]][0]
                say(f"      D{k['det']} w0 {k['w0']:.3f}: " + "  ".join(f"v{v} {k['flux'][v][0] / f0:.3f}+/-{k['flux'][v][1] / abs(f0):.3f}" for v in visits))
        out[(c["sid"], "cw_var")] = cw
        out[(c["sid"], "cw_const")] = cwp if pt else []

    # ---------------- results
    R = dict(results)
    R["candidates"] = {str(c["sid"]): dict(field=c["field"], G=metric(c["gmag"], "mag", None, SCRIPT), std_dev_mag_g_fov=metric(c["std_g"], "mag", c.get("nobs"), SCRIPT, "Gaia DR3 vari_summary"),
                                         accepted_fraction=metric(c["accept"], "fraction", c["n_in"], SCRIPT)) for c in table}
    R["chosen"] = {}
    for c, pt in zip(chosen, partners):
        entry = dict(variable_id=str(c["sid"]), field=c["field"], G=c["gmag"], std_dev_mag_g_fov=c["std_g"], range_mag_g_fov=c["range_g"], partner_id=str(pt["sid"]) if pt else None)
        for sm in summary:
            if sm["sid"] in (c["sid"], pt["sid"] if pt else -1):
                entry[sm["kind"]] = dict(rms_z_matched=metric(sm["rms_z"], "z", sm["n"], SCRIPT), median_abs_frac_matched=metric(sm["med_abs_frac"], "percent", sm["n"], SCRIPT),
                                         max_abs_frac_matched=metric(sm["max_abs_frac"], "percent", sm["n"], SCRIPT), rms_z_plain=metric(sm["plain_rms_z"], "z", sm["n"], SCRIPT),
                                         median_abs_frac_plain=metric(sm["plain_med_abs_frac"], "percent", sm["n"], SCRIPT),
                                         median_abs_z_paired_stack=metric(sm["ps_med_abs_z"], "z", sm["n"], SCRIPT))
        R["chosen"][str(c["sid"])] = entry

    # ---------------- figure
    n = len(chosen)
    fig, axs = plt.subplots(2, n, figsize=(5.2 * n, 8.2), squeeze=False)
    for j, (c, pt) in enumerate(zip(chosen, partners)):
        for rowi, (xs, title) in enumerate((("matched", "matched (M2): fractional difference [%]"), ("plain", "plain best pair: fractional difference [%]"))):
            ax = axs[rowi, j]
            for kind, col, mk, off in (("variable", "#c0392b", "o", -0.15), ("constant", "#2c3e50", "s", 0.15)):
                res = out.get((c["sid"], kind), [])
                if not res:
                    continue
                xpos = np.arange(len(res)) + off
                if xs == "matched":
                    fr = np.array([r["frac"] for r in res]) * 100
                    er = np.array([abs(r["err"] / (r["D"] / r["frac"])) if r["frac"] != 0 and np.isfinite(r["D"]) else np.nan for r in res]) * 100
                else:
                    fr = np.array([r["pfrac"] for r in res]) * 100
                    er = np.array([abs(r["perr"] / (r["pD"] / r["pfrac"])) if r["pfrac"] != 0 and np.isfinite(r["pD"]) else np.nan for r in res]) * 100
                lab = f"variable, Gaia {c['sid']}, G {c['gmag']:.1f}, sd {c['std_g']:.2f} mag" if kind == "variable" else (f"constant partner, G {pt['gmag']:.1f}" if pt else None)
                ax.errorbar(xpos, fr, yerr=er, fmt=mk, color=col, ms=4, lw=0.8, label=lab)
            ax.axhline(0, c="k", lw=0.5)
            res = out.get((c["sid"], "variable"), [])
            ax.set_xticks(np.arange(len(res)))
            ax.set_xticklabels([f"D{r['det']} {r['a']}-{r['b']}" for r in res], rotation=90, fontsize=6)
            ax.set_ylabel(title, fontsize=8)
            if rowi == 0:
                ax.set_title(f"{c['field']}", fontsize=9)
                ax.legend(fontsize=6)
    fig.suptitle("Known Gaia variables vs constant partners of matched G: visit-to-visit flux differences (detector, visit pair on the axis)", fontsize=10)
    fig.tight_layout()
    fig.savefig(FIGURES / "variable_demo.png", dpi=130)
    plt.close(fig)
    R["_text"] = TEXT
    R["_citations"] = ["Gaia Collaboration 2023, A&A 674, A1 (Gaia DR3 gaia_source, vari_summary)", "Eyer et al. 2023, A&A 674, A13 (Gaia DR3 variability)"]
    update_results("variable_demo", R)
    print(f"\nresults.json section variable_demo written; runtime {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
