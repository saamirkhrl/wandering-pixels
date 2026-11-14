"""13: cross-check the data seat's TypeScript change readouts against the Python reference (wp/m2ref.py).

usage: cd validation && uv run python scripts/13_crosscheck_readouts.py <their-readout.json>
       (e.g. /Users/samir/Desktop/spaceapps/research/samples/readouts/barnards-star.json)

Their file: Barnard field, detector 2, per star (Gaia id, position) the per-exposure photometry
(`measurements`: id, visit, mjd, wavelength, bandwidth, ok/reason/saturated/flux/varRaw/variance/...) and
per visit pair (`pairs`: a, b, result with perWavelength, ps, flags, D, var, z, plain, verdict).
Inputs here: data/index_barnard.csv, data/cutouts/barnard/*_D2.fits, data/gaia_barnard.ecsv,
data/cal/swcs_D2_*.fits (local calibration cache, no network). Nothing outside this script is modified
except the results.json section "browser_crosscheck_barnard" (via wp.results.update_results).

What is computed (headless, no plotting):
  * visit mapping: their visit index -> our index visit by obs_id (majority) and MJD range.
  * for every star (matched by Gaia id) and every visit pair in their file: m2ref.compare_visits on OUR
    per-exposure photometry (m2ref.measure_pixels on native cutouts, Gaia position propagated with proper
    motion and parallax) with two wavelength sources: pass "cal" (CWAVE/CBAND nearest pixel, the reference
    default) and pass "wcs" (bilinear WCS-WAVE table of each cutout, which is what the browser uses).
  * statistics of D, sigma, z, plain pair, PS, common wavelengths, points per visit, flags, verdict band.
  * every disagreement (|dz| > 0.1, or verdict band, or flags differ) with both sets of numbers and a
    diagnosis found by re-running with controlled changes (a ladder of variants, see LADDER).
  * per-exposure comparison of the photometry itself (accept/reject, flux, variance, wavelength).
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import csv  # noqa: E402

from astropy.table import Table  # noqa: E402

from wp import m2ref, wavelength as wl  # noqa: E402
from wp.config import DATA, ROOT  # noqa: E402
from wp.gaia import propagate  # noqa: E402
from wp.results import metric, update_results  # noqa: E402

SCRIPT = "13_crosscheck_readouts.py"
FIELD, DET = "barnard", 2
DZ_TOL = 0.1


# ------------------------------------------------------------------ helpers --
def band(z):
    if z is None or not np.isfinite(z):
        return "none"
    a = abs(z)
    return "<3" if a < 3 else ("3-5" if a < 5 else ">=5")


def pct(a, q):
    a = np.asarray(a, float)
    return float(np.percentile(a, q)) if a.size else None


def dist_signed(a):
    a = np.asarray(a, float)
    if not a.size:
        return dict(n=0)
    return dict(n=int(a.size), median=float(np.median(a)), p16=pct(a, 16), p84=pct(a, 84),
                max_abs=float(np.max(np.abs(a))))


def dist_abs(a):
    a = np.abs(np.asarray(a, float))
    if not a.size:
        return dict(n=0)
    return dict(n=int(a.size), median=float(np.median(a)), p95=pct(a, 95), max=float(np.max(a)))


def fnum(x, w=8, p=3):
    return f"{x:{w}.{p}f}" if x is not None and np.isfinite(x) else " " * (w - 3) + "n/a"


# ------------------------------------------------------------------ their file --
def load_theirs(path):
    d = json.load(open(path))
    th = {}  # their per-exposure measurements: th[sid][oid] = dict
    for s in d["stars"]:
        sid = int(s["star"]["id"])
        th[sid] = {m["id"]: dict(visit=int(m["visit"]), mjd=float(m["mjd"]), lam=float(m["wavelength"]),
                                 bw=float(m["bandwidth"]), **m["measurement"]) for m in s["measurements"]}
    return d, th


def their_pair(rec):
    """Normalise one 'result' block of their file into flat fields (None where absent)."""
    r = rec["result"]
    if r is None:
        return None
    per = {}
    for p in r.get("perWavelength", []):
        per[p["idA"]] = dict(w0=p["w0"], b0=p["b0"], D=p["D"], var=p["var"], z=p["z"], nA=p["nA"], nB=p["nB"],
                             plain_idB=p.get("plainIdB"), plain_D=p.get("plainD"), plain_var=p.get("plainVar"),
                             plain_z=p.get("plainZ"))
    ps = r.get("ps") or {}
    pl = r.get("plain") or {}
    return dict(per=per, skipped=r.get("skipped", []), nA=r.get("nExposuresA"), nB=r.get("nExposuresB"),
                nW0=r.get("nW0"), D=r.get("D"), var=r.get("var"), z=r.get("z"), frac=r.get("fractionalChange"),
                verdict=r.get("verdict"), flags=list(r.get("flags", [])),
                plain_D=pl.get("D"), plain_var=pl.get("var"), plain_z=pl.get("z"),
                ps_n=ps.get("nPairs"), ps_D=ps.get("D"), ps_var=ps.get("var"), ps_z=ps.get("z"))


# ------------------------------------------------------------------ our measurements --
def load_ours(stars_gaia, their_ids):
    """Load all detector-2 cutouts of the index and measure every star in every exposure.

    Returns cut (oid -> dict), idx (oid -> our visit), meas[(sid, oid, pos)] with pos in
    ('pmplx', 'pm'): dict(x, y, **measure_pixels), lam[(sid, oid, pos, src)] = (lam, bw), src in
    ('cal', 'wcs')."""
    rows = [r for r in csv.DictReader(open(DATA / f"index_{FIELD}.csv"))
            if int(r["detector"]) == DET and r["on_detector"] == "True"]
    cal = sorted((DATA / "cal").glob(f"swcs_D{DET}_*.fits"))
    assert cal, "no local calibration file for detector 2 in data/cal"
    cw, cb = wl._load_cal(str(cal[-1]))[:2]

    def cal_lam(x, y):
        xi = np.clip(np.rint(x).astype(int), 0, wl.NPIX - 1)
        yi = np.clip(np.rint(y).astype(int), 0, wl.NPIX - 1)
        return cw[yi, xi].astype(float), cb[yi, xi].astype(float)

    from astropy.io import fits
    cut, idx = {}, {}
    for r in rows:
        c = m2ref.load_cutout(ROOT / r["cutout_path"])
        with fits.open(ROOT / r["cutout_path"], memmap=False) as hl:
            c["table"] = wl.table_from(hl["WCS-WAVE"])
        cut[r["obs_id"]] = c
        idx[r["obs_id"]] = int(r["visit"])
    gsub = stars_gaia
    meas, lam = {}, {}
    sids = [int(s) for s in gsub["source_id"]]
    for oid, c in cut.items():
        for pos in ("pmplx", "pm"):
            ra, dec, _ = propagate(gsub, c["mjd"], parallax=(pos == "pmplx"))
            xs, ys = c["wcs"].world_to_pixel_values(ra, dec)
            xs, ys = np.asarray(xs, float), np.asarray(ys, float)
            lc, bc = cal_lam(xs + c["x0"], ys + c["y0"])
            lw, bw_ = wl.wcswave_lambda(c["table"], xs + c["x0"], ys + c["y0"])
            for k, sid in enumerate(sids):
                m = m2ref.measure_pixels(c["P"], c["V"], c["FL"], float(xs[k]), float(ys[k]))
                m["x"], m["y"] = float(xs[k]), float(ys[k])
                meas[(sid, oid, pos)] = m
                lam[(sid, oid, pos, "cal")] = (float(lc[k]), float(bc[k]))
                lam[(sid, oid, pos, "wcs")] = (float(lw[k]), float(bw_[k]))
    return cut, idx, meas, lam


# ------------------------------------------------------------------ the main object --
class Cross:
    def __init__(self, path):
        self.d, self.th = load_theirs(path)
        self.stars = self.d["stars"]
        g = Table.read(DATA / f"gaia_{FIELD}.ecsv")
        self.gaia = g
        gsid = np.asarray(g["source_id"], np.int64)
        # star matching: Gaia id; else nearest Gaia source to their position
        self.match = {}
        for s in self.stars:
            st = s["star"]
            sid = int(st["id"])
            if sid in set(gsid.tolist()):
                self.match[sid] = (sid, "id", 0.0)
            else:
                dra = (np.asarray(g["ra"]) - st["ra"]) * np.cos(np.deg2rad(st["dec"])) * 3600
                dde = (np.asarray(g["dec"]) - st["dec"]) * 3600
                j = int(np.argmin(np.hypot(dra, dde)))
                self.match[sid] = (int(gsid[j]), "nearest", float(np.hypot(dra[j], dde[j])))
        ours_ids = sorted({self.match[int(s["star"]["id"])][0] for s in self.stars})
        sel = np.isin(gsid, ours_ids)
        order = [int(np.nonzero(gsid == s)[0][0]) for s in ours_ids]
        self.gsub = g[order]
        self.gidx = {int(s): int(np.nonzero(gsid == s)[0][0]) for s in ours_ids}
        print(f"loading and measuring {len(ours_ids)} stars in all detector-{DET} cutouts ...", flush=True)
        self.cut, self.idx, self.meas, self.lam = load_ours(self.gsub, ours_ids)
        self.map_visits()
        self.blend = {}
        for s in self.stars:
            sid = self.match[int(s["star"]["id"])][0]
            gi = self.gidx[sid]
            self.blend[sid] = m2ref.is_blended(float(g["ra"][gi]), float(g["dec"][gi]), float(g["phot_g_mean_mag"][gi]),
                                               g["ra"], g["dec"], g["phot_g_mean_mag"], star_index=gi)

    # visit mapping --------------------------------------------------------------------------
    def map_visits(self):
        by = defaultdict(list)  # their visit -> list of oid
        mjd = defaultdict(list)
        seen = set()
        for sid, ex in self.th.items():
            for oid, m in ex.items():
                if oid in seen:
                    continue
                seen.add(oid)
                by[m["visit"]].append(oid)
                mjd[m["visit"]].append(m["mjd"])
        self.their_ids = {v: sorted(o) for v, o in by.items()}
        self.vmap, self.vinfo = {}, {}
        for v, oids in sorted(by.items()):
            cnt = Counter(self.idx[o] for o in oids if o in self.idx)
            ours_v = cnt.most_common(1)[0][0]
            self.vmap[v] = ours_v
            ours_all = sorted(o for o, k in self.idx.items() if k == ours_v)
            self.vinfo[v] = dict(their_visit=v, our_visit=ours_v, their_n_exposures=len(oids),
                                 our_n_exposures=len(ours_all),
                                 their_mjd_range=[min(mjd[v]), max(mjd[v])],
                                 our_mjd_range=[min(self.cut[o]["mjd"] for o in ours_all),
                                                max(self.cut[o]["mjd"] for o in ours_all)],
                                 in_theirs_not_ours=sorted(set(oids) - set(ours_all)),
                                 in_ours_not_theirs=sorted(set(ours_all) - set(oids)),
                                 id_votes=dict(cnt))
        print("visit mapping (their -> our index visit):")
        for v, i in self.vinfo.items():
            print(f"  {v} -> {i['our_visit']}: their {i['their_n_exposures']} exposures, ours {i['our_n_exposures']}; "
                  f"only theirs {i['in_theirs_not_ours']}, only ours {i['in_ours_not_theirs']}")

    # samples --------------------------------------------------------------------------------
    def samples(self, tsid, v, flux="ours", lam="cal", pos="pmplx", set_="ours"):
        """(accepted samples, any-saturated) of their star `tsid` in their visit `v`.
        flux: 'ours' (m2ref on our cutouts) or 'theirs' (their per-exposure flux/variance);
        lam: 'cal', 'wcs' (ours) or 'theirs'; set_: 'ours' (all our exposures of the mapped visit),
        'theirs' (their exposure ids that we have a cutout for), 'theirs_all' (all their ids)."""
        sid = self.match[tsid][0]
        thx = self.th[tsid]
        if set_ == "ours":
            oids = [o for o, k in self.idx.items() if k == self.vmap[v]]
        elif set_ == "theirs":
            oids = [o for o in self.their_ids[v] if o in self.idx]
        else:
            oids = list(self.their_ids[v])
        out, sat = [], False
        for o in oids:
            if flux == "ours":
                if o not in self.idx:
                    continue
                m = self.meas[(sid, o, pos)]
                mjd = self.cut[o]["mjd"]
                f, var, ok, sa = m["flux"], m["var"], m["ok"], m["saturated"]
            else:
                if o not in thx:
                    continue
                m = thx[o]
                mjd = m["mjd"]
                ok, sa = bool(m["ok"]), bool(m["saturated"])
                f = m["flux"] if ok else np.nan
                var = m["variance"] if ok else np.nan
            if lam == "theirs":
                if o not in thx:
                    continue
                lm, bw = thx[o]["lam"], thx[o]["bw"]
            else:
                lm, bw = self.lam[(sid, o, "pmplx" if pos == "pmplx" else "pm", lam)]
            sat = sat or sa
            if ok and np.isfinite(lm) and np.isfinite(bw):
                out.append(dict(id=o, lam=lm, bw=bw, mjd=mjd, flux=float(f), var=float(var), saturated=bool(sa)))
        return out, sat

    def run(self, tsid, a, b, **kw):
        sa, sata = self.samples(tsid, a, **kw)
        sb, satb = self.samples(tsid, b, **kw)
        bl = self.blend[self.match[tsid][0]]
        return m2ref.compare_visits(sa, sb, blended=bl, saturated=sata or satb)

    # comparison -----------------------------------------------------------------------------
    @staticmethod
    def compare(o, t):
        """Flat comparison record of our compare_visits dict `o` against their normalised block `t`."""
        has_o = o["n_w0"] > 0
        has_t = t["z"] is not None
        c = dict(has_o=has_o, has_t=has_t)
        c["nW0_o"], c["nW0_t"] = o["n_w0"], t["nW0"]
        ido = {p["id_A"]: p for p in o["per_w0"]}
        c["w0_same"] = set(ido) == set(t["per"])
        c["w0_common"] = sorted(set(ido) & set(t["per"]))
        if has_o and has_t:
            c["D_o"], c["D_t"] = o["D"], t["D"]
            c["s_o"], c["s_t"] = float(np.sqrt(o["var"])), float(np.sqrt(t["var"]))
            c["z_o"], c["z_t"] = o["z"], t["z"]
            c["dz"] = o["z"] - t["z"]
            c["rel_D"] = (o["D"] - t["D"]) / abs(t["D"]) if t["D"] else np.nan
            c["rel_s"] = c["s_o"] / c["s_t"] - 1.0
            c["dD_sig"] = (o["D"] - t["D"]) / c["s_t"]
        else:
            c["z_o"] = o["z"] if has_o else None
            c["z_t"] = t["z"]
            c["dz"] = np.nan
        c["band_o"], c["band_t"] = band(c["z_o"]), band(c["z_t"])
        c["flags_o"], c["flags_t"] = list(o["flags"]), list(t["flags"])
        c["flags_same"] = c["flags_o"] == c["flags_t"]
        c["nexp_o"] = (o["n_exposures_A"], o["n_exposures_B"])
        c["nexp_t"] = (t["nA"], t["nB"])
        # per-w0 on the common set
        c["per"] = []
        for k in c["w0_common"]:
            po, pt = ido[k], t["per"][k]
            c["per"].append(dict(id=k, dD=po["D"] - pt["D"], rel_D=(po["D"] - pt["D"]) / abs(pt["D"]) if pt["D"] else np.nan,
                                 dz=po["z"] - pt["z"], rel_s=np.sqrt(po["var"] / pt["var"]) - 1.0,
                                 nA=(po["n_A"], pt["nA"]), nB=(po["n_B"], pt["nB"]),
                                 dw0=po["w0"] - pt["w0"], plain_same_B=(po["plain_id_B"] == pt["plain_idB"]),
                                 plain_dD=po["plain_D"] - pt["plain_D"], plain_dz=po["plain_z"] - pt["plain_z"]))
        # plain combined
        if has_o and has_t and o.get("plain") and t["plain_D"] is not None:
            c["plain_dz"] = o["plain"]["z"] - t["plain_z"]
            c["plain_rel_D"] = (o["plain"]["D"] - t["plain_D"]) / abs(t["plain_D"]) if t["plain_D"] else np.nan
            c["plain_z_o"], c["plain_z_t"] = o["plain"]["z"], t["plain_z"]
        # PS
        ps = o["ps"]
        if ps["n_pairs"] and t["ps_D"] is not None:
            c["ps_dz"] = ps["z"] - t["ps_z"]
            c["ps_rel_D"] = (ps["D"] - t["ps_D"]) / abs(t["ps_D"]) if t["ps_D"] else np.nan
            c["ps_n"] = (ps["n_pairs"], t["ps_n"])
            c["ps_z_o"], c["ps_z_t"] = ps["z"], t["ps_z"]
        else:
            c["ps_n"] = (ps["n_pairs"], t["ps_n"])
        return c

    @staticmethod
    def agrees(c):
        if c["has_o"] != c["has_t"]:
            return False
        if c["has_o"] and not (abs(c["dz"]) <= DZ_TOL):
            return False
        return c["band_o"] == c["band_t"] and c["flags_same"]

    @staticmethod
    def disagrees(c):
        reasons = []
        if c["has_o"] != c["has_t"]:
            reasons.append("result present in one only")
        elif c["has_o"] and abs(c["dz"]) > DZ_TOL:
            reasons.append("|dz|>0.1")
        if c["band_o"] != c["band_t"]:
            reasons.append("band")
        if not c["flags_same"]:
            reasons.append("flags")
        return reasons


# Variants tried in order to find which change removes a disagreement. Each is the full set of m2ref
# arguments that differ from the pass baseline; the first that agrees (|dz|<=0.1, same band, same
# flags) is the reported cause. 'theirs' flux/lam means their own per-exposure numbers fed through
# m2ref.compare_visits (which tests their readout port separately from their photometry).
LADDER = [
    ("their exposure set", dict(set_="theirs")),
    ("their exposure set + PM-only position", dict(set_="theirs", pos="pm")),
    ("their exposure set + WCS-WAVE wavelength", dict(set_="theirs", lam="wcs")),
    ("their set + WCS-WAVE + PM-only", dict(set_="theirs", lam="wcs", pos="pm")),
    ("their set + their wavelength (our flux)", dict(set_="theirs", lam="theirs")),
    ("their set + their wavelength + PM-only", dict(set_="theirs", lam="theirs", pos="pm")),
    ("their flux and wavelength, only exposures we have a cutout for", dict(flux="theirs", lam="theirs", set_="theirs")),
    ("their flux, our wavelength (cal), their set", dict(flux="theirs", lam="cal", set_="theirs")),
    ("their flux, WCS-WAVE wavelength, their set", dict(flux="theirs", lam="wcs", set_="theirs")),
    ("their flux and wavelength, all their exposures", dict(flux="theirs", lam="theirs", set_="theirs_all")),
]


def fmt_pair_line(tag, sid_short, a, b, c):
    return (f"{tag} {sid_short:>6} {a}-{b} | th D={fnum(c.get('D_t'))} s={fnum(c.get('s_t'))} z={fnum(c.get('z_t'),7,2)} "
            f"| ours D={fnum(c.get('D_o'))} s={fnum(c.get('s_o'))} z={fnum(c.get('z_o'),7,2)} "
            f"| dz={fnum(c['dz'],7,3)} nw {c['nW0_o']}/{c['nW0_t']} n {c['nexp_o']}/{c['nexp_t']} "
            f"fl {'=' if c['flags_same'] else 'DIFF'}")


def stats_block(rows):
    """rows: list of (key, comparison dict). Aggregates the agreement numbers."""
    both = [c for _, c in rows if c["has_o"] and c["has_t"]]
    out = dict(
        n_pairs=len(rows), n_both_result=len(both),
        n_result_only_ours=sum(c["has_o"] and not c["has_t"] for _, c in rows),
        n_result_only_theirs=sum(c["has_t"] and not c["has_o"] for _, c in rows),
        n_no_result_both=sum((not c["has_o"]) and (not c["has_t"]) for _, c in rows),
        n_same_w0_set=sum(c["w0_same"] for _, c in rows),
        n_same_nW0=sum(c["nW0_o"] == c["nW0_t"] for _, c in rows),
        n_same_points_per_visit=sum(c["nexp_o"] == c["nexp_t"] for _, c in rows),
        n_same_flags=sum(c["flags_same"] for _, c in rows),
        n_same_band=sum(c["band_o"] == c["band_t"] for _, c in rows),
        n_dz_gt_0p1=sum((c["has_o"] and c["has_t"] and abs(c["dz"]) > DZ_TOL) for _, c in rows),
        rel_D=dist_signed([c["rel_D"] for c in both if np.isfinite(c["rel_D"])]),
        rel_sigma=dist_signed([c["rel_s"] for c in both]),
        dD_in_their_sigma=dist_signed([c["dD_sig"] for c in both]),
        dz=dist_abs([c["dz"] for c in both]),
        dz_signed=dist_signed([c["dz"] for c in both]),
    )
    per = [p for c in both for p in c["per"]]
    out["per_w0"] = dict(
        n=len(per),
        n_points_equal_A=sum(p["nA"][0] == p["nA"][1] for p in per),
        n_points_equal_B=sum(p["nB"][0] == p["nB"][1] for p in per),
        rel_D=dist_signed([p["rel_D"] for p in per if np.isfinite(p["rel_D"])]),
        rel_sigma=dist_signed([p["rel_s"] for p in per]),
        dz=dist_abs([p["dz"] for p in per]),
        n_plain_partner_same=sum(p["plain_same_B"] for p in per),
        plain_dz=dist_abs([p["plain_dz"] for p in per]),
        dw0_nm=dist_abs([1e3 * p["dw0"] for p in per]))
    pl = [c for c in both if "plain_dz" in c]
    out["plain_combined"] = dict(n=len(pl), dz=dist_abs([c["plain_dz"] for c in pl]),
                                 rel_D=dist_signed([c["plain_rel_D"] for c in pl if np.isfinite(c["plain_rel_D"])]))
    ps = [c for c in both if "ps_dz" in c]
    out["ps"] = dict(n=len(ps), dz=dist_abs([c["ps_dz"] for c in ps]),
                     rel_D=dist_signed([c["ps_rel_D"] for c in ps if np.isfinite(c["ps_rel_D"])]),
                     n_same_nPairs=sum(c["ps_n"][0] == c["ps_n"][1] for c in ps))
    bands = Counter((c["band_t"], c["band_o"]) for _, c in rows)
    out["band_matrix_theirs_ours"] = {f"{k[0]} | {k[1]}": v for k, v in sorted(bands.items())}
    return out


def exposure_check(X, lam_key):
    """Compare per-exposure photometry and wavelengths for every (star, exposure) both have."""
    n = n_acc_differs = 0
    rel, vr, vrv, dlam, dbw = [], [], [], [], []
    reasons = Counter()
    sat_differs = 0
    diffs = defaultdict(list)
    for s in X.stars:
        tsid = int(s["star"]["id"])
        sid = X.match[tsid][0]
        for o, t in X.th[tsid].items():
            if o not in X.idx:
                continue
            m = X.meas[(sid, o, "pmplx")]
            n += 1
            sat_differs += bool(m["saturated"]) != bool(t["saturated"])
            if bool(m["ok"]) != bool(t["ok"]):
                n_acc_differs += 1
                reasons[f"ours {m['reason']} / theirs {t['reason']}"] += 1
                diffs[tsid].append(o)
            elif m["ok"]:
                rel.append((m["flux"] - t["flux"]) / abs(t["flux"]))
                vr.append(m["var_raw"] / t["varRaw"])
                vrv.append(m["var"] / t["variance"])
            lm, bw = X.lam[(sid, o, "pmplx", lam_key)]
            dlam.append(1e3 * (lm - t["lam"]))
            dbw.append(1e3 * (bw - t["bw"]))
    rel, vr, vrv, dlam, dbw = map(np.array, (rel, vr, vrv, dlam, dbw))
    return dict(
        n_exposure_star_pairs=n, n_accept_differs=n_acc_differs, accept_diff_reasons=dict(reasons),
        n_saturated_flag_differs=int(sat_differs),
        flux_rel_diff=dict(n=int(rel.size), median=float(np.median(rel)), abs_median=float(np.median(np.abs(rel))),
                           abs_p90=pct(np.abs(rel), 90), abs_p99=pct(np.abs(rel), 99), abs_max=float(np.max(np.abs(rel)))),
        var_raw_ratio=dict(median=float(np.median(vr)), p16=pct(vr, 16), p84=pct(vr, 84), min=float(vr.min()), max=float(vr.max())),
        var_ratio=dict(median=float(np.median(vrv)), p16=pct(vrv, 16), p84=pct(vrv, 84), min=float(vrv.min()), max=float(vrv.max())),
        lam_ours_minus_theirs_nm=dict(median=float(np.median(dlam)), p16=pct(dlam, 16), p84=pct(dlam, 84),
                                      abs_max=float(np.max(np.abs(dlam)))),
        bw_ours_minus_theirs_nm=dict(median=float(np.median(dbw)), abs_max=float(np.max(np.abs(dbw)))),
        stars_with_accept_diff={str(k): v for k, v in diffs.items()},
    )


def main(path):
    X = Cross(path)
    print(f"their file: slug={X.d['slug']} detector={X.d['detector']} stars={len(X.stars)} visits={len(X.d['visits'])}")
    mm = Counter(v[1] for v in X.match.values())
    print(f"star matching: {dict(mm)} (id = Gaia id found in our Gaia table; nearest = nearest source)")

    # their pair blocks
    jobs = []
    for s in X.stars:
        tsid = int(s["star"]["id"])
        for p in s["pairs"]:
            jobs.append((tsid, int(p["a"]), int(p["b"]), their_pair(p)))
    stars_without_pairs = [int(s["star"]["id"]) for s in X.stars if not s["pairs"]]
    print(f"{len(X.stars)} stars, {len(jobs)} visit-pair blocks; stars with no pair blocks: "
          f"{[(str(i)[-6:], X.stars[[int(s['star']['id']) for s in X.stars].index(i)]['accepted']) for i in stars_without_pairs]}")

    # blended flag
    bl_diff = [(str(t)[-6:], bool(s["blended"]), X.blend[X.match[t][0]]) for s in X.stars
               for t in [int(s["star"]["id"])] if bool(s["blended"]) != X.blend[X.match[t][0]]]
    print(f"blended flag per star: their vs ours differ for {len(bl_diff)} of {len(X.stars)} stars {bl_diff}")

    # accepted counts per (star, visit)
    acc_diff = []
    for s in X.stars:
        tsid = int(s["star"]["id"])
        for v, n in s["accepted"].items():
            ours_n = len(X.samples(tsid, int(v), set_="ours")[0])
            if ours_n != n:
                acc_diff.append((str(tsid)[-6:], int(v), ours_n, n))

    passes = {}
    for pname, lamsrc, extra in (("cal", "cal", {}), ("wcs", "wcs", {}), ("wcs_theirset", "wcs", dict(set_="theirs"))):
        print(f"\n================ PASS {pname}: our wavelength = "
              f"{'CWAVE/CBAND calibration (nearest pixel)' if pname == 'cal' else 'WCS-WAVE table (bilinear)'}"
              f"{', exposures restricted to the ids in their file' if extra else ''} ================")
        rows, diag = [], []
        for tsid, a, b, t in jobs:
            o = X.run(tsid, a, b, lam=lamsrc, **extra)
            if t is None:
                continue
            c = X.compare(o, t)
            rows.append(((tsid, a, b), c))
        for (tsid, a, b), c in rows:
            print(fmt_pair_line("  ", str(tsid)[-6:], a, b, c))
        st = stats_block(rows)
        ex = exposure_check(X, lamsrc)
        # disagreements and their diagnosis
        dis = []
        for (tsid, a, b), c in rows:
            reasons = X.disagrees(c)
            if not reasons:
                continue
            t = [j[3] for j in jobs if j[0] == tsid and j[1] == a and j[2] == b][0]
            causes, first = [], None
            for label, kw in LADDER:
                kw2 = dict(kw)
                kw2.setdefault("lam", lamsrc)
                try:
                    c2 = X.compare(X.run(tsid, a, b, **kw2), t)
                except Exception as e:  # noqa: BLE001
                    causes.append((label, f"error {e}"))
                    continue
                ok = X.agrees(c2)
                causes.append((label, ok, c2["dz"] if c2["has_o"] and c2["has_t"] else None, c2["flags_same"], c2["band_o"]))
                if ok and first is None:
                    first = label
            # exposure level differences for this star
            sid = X.match[tsid][0]
            ndiff = []
            for v in (a, b):
                for o_ in X.their_ids[v]:
                    if o_ not in X.idx:
                        ndiff.append(f"{o_} (not in our index)")
                        continue
                    m = X.meas[(sid, o_, "pmplx")]
                    tm = X.th[tsid].get(o_)
                    if tm is None:
                        continue
                    if bool(m["ok"]) != bool(tm["ok"]):
                        ndiff.append(f"{o_} ours {m['reason']} theirs {tm['reason']}")
                    elif m["ok"] and abs(m["flux"] / tm["flux"] - 1) > 1e-3:
                        ndiff.append(f"{o_} flux rel {m['flux'] / tm['flux'] - 1:+.2e}")
            extra_o = [o_ for v in (a, b) for o_ in X.vinfo[v]["in_ours_not_theirs"]]
            dis.append(dict(star=str(tsid), gmag=[s["star"]["gmag"] for s in X.stars if int(s["star"]["id"]) == tsid][0],
                            pair=[a, b], reasons=reasons,
                            theirs=dict(D=c.get("D_t"), sigma=c.get("s_t"), z=c.get("z_t"), nW0=c["nW0_t"], n=c["nexp_t"],
                                        flags=c["flags_t"], band=c["band_t"]),
                            ours=dict(D=c.get("D_o"), sigma=c.get("s_o"), z=c.get("z_o"), nW0=c["nW0_o"], n=c["nexp_o"],
                                      flags=c["flags_o"], band=c["band_o"]),
                            dz=None if not np.isfinite(c["dz"]) else float(c["dz"]),
                            w0_same=c["w0_same"], exposure_differences=ndiff, our_extra_exposures_in_visit=extra_o,
                            first_variant_that_agrees=first,
                            ladder=[dict(variant=x[0], agrees=x[1], dz=x[2] if len(x) > 2 else None,
                                         flags_same=x[3] if len(x) > 3 else None, band=x[4] if len(x) > 4 else None)
                                    if len(x) > 2 else dict(variant=x[0], error=x[1]) for x in causes])
                       )
        passes[pname] = dict(stats=st, exposures=ex, disagreements=dis,
                             pair_table=[dict(star=str(k[0]), a=k[1], b=k[2], D_t=c.get("D_t"), s_t=c.get("s_t"),
                                              z_t=c.get("z_t"), D_o=c.get("D_o"), s_o=c.get("s_o"), z_o=c.get("z_o"),
                                              dz=None if not np.isfinite(c["dz"]) else float(c["dz"]))
                                         for k, c in rows])
        print(f"\n-- {pname}: summary")
        for k in ("n_pairs", "n_both_result", "n_result_only_ours", "n_result_only_theirs", "n_no_result_both",
                  "n_same_w0_set", "n_same_nW0", "n_same_points_per_visit", "n_same_flags", "n_same_band", "n_dz_gt_0p1"):
            print(f"   {k:28s} {st[k]}")
        for k in ("rel_D", "rel_sigma", "dz", "dD_in_their_sigma"):
            print(f"   {k:28s} {json.dumps(st[k])}")
        print(f"   per_w0 {json.dumps(st['per_w0'])}")
        print(f"   plain_combined {json.dumps(st['plain_combined'])}")
        print(f"   ps {json.dumps(st['ps'])}")
        print(f"   bands (theirs | ours) {st['band_matrix_theirs_ours']}")
        print(f"   per-exposure: {json.dumps({k: v for k, v in ex.items() if k != 'stars_with_accept_diff'})}")
        print(f"\n-- {pname}: {len(dis)} disagreements (|dz|>{DZ_TOL}, band, flags, or result presence)")
        for dd in dis:
            print(f"  star ...{dd['star'][-6:]} G{dd['gmag']} pair {dd['pair']}: {dd['reasons']}")
            print(f"     theirs {dd['theirs']}")
            print(f"     ours   {dd['ours']}  dz={dd['dz']}  same w0 set={dd['w0_same']}")
            print(f"     first agreeing variant: {dd['first_variant_that_agrees']}; exposure diffs: {dd['exposure_differences']}")

    # decomposition: do their own per-exposure numbers fed to m2ref reproduce their readout? (port check)
    port = []
    for tsid, a, b, t in jobs:
        if t is None:
            continue
        c = X.compare(X.run(tsid, a, b, flux="theirs", lam="theirs", set_="theirs_all"), t)
        port.append(((tsid, a, b), c))
    pst = stats_block(port)
    pbad = [(str(k[0])[-6:], k[1], k[2], c["dz"], c["flags_t"], c["flags_o"]) for k, c in port if not X.agrees(c)]
    print(f"\nPORT CHECK: m2ref.compare_visits on THEIR per-exposure flux/variance/wavelength vs THEIR readout: "
          f"{len(port)} pairs, dz {json.dumps(pst['dz'])}, rel_D {json.dumps(pst['rel_D'])}, "
          f"rel_sigma {json.dumps(pst['rel_sigma'])}, same flags {pst['n_same_flags']}/{len(port)}, "
          f"same w0 set {pst['n_same_w0_set']}/{len(port)}, same nexp {pst['n_same_points_per_visit']}/{len(port)}, "
          f"disagreeing: {pbad[:8]}")

    # ---- results.json section
    def headline(p):
        st = passes[p]["stats"]
        return dict(
            n_pairs=metric(st["n_pairs"], "pairs", st["n_pairs"], SCRIPT),
            n_both_result=metric(st["n_both_result"], "pairs", st["n_pairs"], SCRIPT),
            n_dz_gt_0p1=metric(st["n_dz_gt_0p1"], "pairs", st["n_both_result"], SCRIPT, "|z_ours - z_theirs| > 0.1"),
            n_same_band=metric(st["n_same_band"], "pairs", st["n_pairs"], SCRIPT),
            n_same_flags=metric(st["n_same_flags"], "pairs", st["n_pairs"], SCRIPT),
            n_same_w0_set=metric(st["n_same_w0_set"], "pairs", st["n_pairs"], SCRIPT),
            n_same_points_per_visit=metric(st["n_same_points_per_visit"], "pairs", st["n_pairs"], SCRIPT),
            rel_D_median=metric(st["rel_D"].get("median"), "fraction", st["rel_D"]["n"], SCRIPT, "(ours - theirs) / |theirs|"),
            rel_sigma_median=metric(st["rel_sigma"].get("median"), "fraction", st["rel_sigma"]["n"], SCRIPT),
            dz_abs_median=metric(st["dz"].get("median"), "sigma", st["dz"]["n"], SCRIPT),
            dz_abs_p95=metric(st["dz"].get("p95"), "sigma", st["dz"]["n"], SCRIPT),
            dz_abs_max=metric(st["dz"].get("max"), "sigma", st["dz"]["n"], SCRIPT),
            stats=st, per_exposure=passes[p]["exposures"], disagreements=passes[p]["disagreements"],
            pair_table=passes[p]["pair_table"])
    payload = dict(
        input=dict(file=str(path), slug=X.d["slug"], detector=X.d["detector"], n_stars=len(X.stars),
                   n_pair_blocks=len(jobs), stars_without_pairs=[str(i) for i in stars_without_pairs]),
        n_stars=metric(len(X.stars), "stars", None, SCRIPT),
        n_pairs=metric(len(jobs), "pairs", None, SCRIPT),
        method=dict(
            ours="wp/m2ref.measure_pixels + compare_visits on native cutouts, Gaia position at MJD-AVG with proper "
                 "motion and parallax (wp.gaia.propagate), browser FLAGS mask, per-exposure wavelength at the star's "
                 "detector pixel (x + X0, y + Y0)",
            star_matching=dict(by_gaia_id=int(mm.get("id", 0)), by_nearest_position=int(mm.get("nearest", 0))),
            visit_mapping="by obs_id (majority vote of our index visit over their exposure ids), checked against the "
                          "MJD range of each visit; their visit definition (gap > 30 d, clusters < 12 out) gives the "
                          "same memberships as our index visits 0, 2, 4 apart from the exposures listed in visit_map",
            visit_map={str(k): v for k, v in X.vinfo.items()},
            pass_cal="our wavelength = CWAVE/CBAND nearest pixel", pass_wcs="our wavelength = WCS-WAVE table of each "
            "cutout, own bilinear interpolation (wp.wavelength.wcswave_lambda)",
            ladder=[l for l, _ in LADDER], dz_tolerance=DZ_TOL),
        blended_flag=dict(n_stars_differ=len(bl_diff), differ=[dict(star=a, theirs=b, ours=c) for a, b, c in bl_diff]),
        accepted_counts_differ=[dict(star=a, visit=b, ours=c, theirs=d) for a, b, c, d in acc_diff],
        port_check=dict(note="m2ref.compare_visits fed with THEIR per-exposure flux, variance, wavelength and bandwidth "
                             "(all their exposures) against THEIR readout: isolates the readout algorithm from the "
                             "photometry",
                        n=len(port), stats=pst, n_disagree=len(pbad),
                        disagreements=[dict(star=a, a=b, b=c, dz=None if not np.isfinite(d) else d, flags_theirs=e, flags_ours=f)
                                       for a, b, c, d, e, f in pbad]),
        pass_cal=headline("cal"), pass_wcs=headline("wcs"), pass_wcs_theirset=headline("wcs_theirset"))
    update_results("browser_crosscheck_barnard", payload)
    print("\nwrote docs/results.json section browser_crosscheck_barnard")
    return payload


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
