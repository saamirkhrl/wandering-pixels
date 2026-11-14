"""10_injection: injection and recovery of fake movers (docs/method.md, "Choices fixed before any phase C
result was computed", items 1-6).

usage: uv run python scripts/10_injection.py --field {barnard,epsindi,all} [--ntrial 50] [--workers N] [--reanalyse]

Visits : Barnard's Star field visits 0 (A) and 2 (B); Eps Indi field visits 0 (A) and 1 (B); all six
         detectors; native cutout pixels.
Grid   : AB 14.0 to 19.5 step 0.5; motion 0, 0.25, 0.5, 1, 2, 4 px (6.15 arcsec) per 182.6 days; spectra
         'flat' (flat in AB) and 'browndwarf' (Sonora Bobcat 650 K, log g 5, normalised at 4.5 um);
         ntrial per cell (50).
Trials : per motion, n_conf = max(500, 24 ntrial) configurations (position, direction) from one fixed
         seed. Configuration i < 24 ntrial is injected in cell (spectrum, mag) = divmod(i // ntrial, 12);
         EVERY configuration is also measured without injection: these are the null trials ("same
         positions and motion"), >= 500 per field and motion.
Position: uniform in a reference cutout (the first full-size visit-A detector-2 cutout), >= 15 px from
         its edges; no Gaia source G < 18 within 20 arcsec and none G < 9 within 3 arcmin of the old
         (catalogue at visit A's mean epoch) or new (visit B's mean epoch) position. Direction uniform.
         Position linear in time: p(t) = p_old + mu (t - tA), mu = motion / 182.6 d; old = p(tA), new =
         p(tB), tA, tB = mean MJD of the visits' exposures. A position is measured in an exposure only
         when it lies >= 15 px inside that exposure's cutout (cutouts near detector edges are clipped).
Injection: wp.inject (archive ePSF, zone nearest the source; nominal pixel solid angle; photon noise
         k x signal with k fitted per frame).
Statistic: wp.detect (m2ref photometry and comparisons; S per P1, PS, M2; detector 2 and six pooled).
         Threshold: 99th percentile of the null S per field, motion, method and pooling; detected means
         S > threshold (strict: for motion 0, S = 0 identically because old = new); also S >= 5.
Outputs: data/phasec/inj_trials_<field>.ecsv (one row per configuration and kind null/inj),
         data/phasec/inj_stack_<field>_*.npy (cutout planes), results section injection_<field>,
         figures docs/figures/completeness_<field>_<spectrum>.png.
"""
import argparse
import json
import os
import sys
import time
import warnings
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
from astropy.io import fits
from astropy.table import Table
from astropy.wcs import WCS, FITSFixedWarning

from wp import detect, inject, m2ref
from wp.config import DATA, FIGURES, ROOT
from wp.gaia import propagate
from wp.results import metric, update_results
from wp.wavelength import cal_lambda

warnings.simplefilter("ignore", FITSFixedWarning)
SCRIPT = "10_injection.py"
OUT = DATA / "phasec"
SEED = 20261114
VISITS = {"barnard": (0, 2), "epsindi": (0, 1)}
FIELD_ID = {"barnard": 1, "epsindi": 2}
MAGS = np.round(np.arange(14.0, 19.5 + 1e-9, 0.5), 2)
MOTIONS = (0.0, 0.25, 0.5, 1.0, 2.0, 4.0)
SPECTRA = ("flat", "browndwarf")
PERIOD_D = 182.6
PIX_AS = 6.15
NULL_MIN = 500
ACTIVE_MOTIONS = MOTIONS          # --motions subset (seeds keep the index in MOTIONS)
REF_DET = 2
KEYS = [f"{m}_{p}" for m in detect.METHODS for p in detect.POOLS]


# ================================================================== field setup
def load_field(field):
    """Exposures of the two visits (all detectors), stacked planes, per-exposure metadata."""
    va, vb = VISITS[field]
    index = Table.read(DATA / f"index_{field}.csv")
    sel = np.isin(np.asarray(index["visit"]), [va, vb]) & np.array([str(x) == "True" for x in index["on_detector"]])
    rows = sorted(index[sel], key=lambda r: (int(r["visit"]), float(r["mjd_mid"]), int(r["detector"]), str(r["obs_id"])))
    n = len(rows)
    S = 320
    P = np.full((n, S, S), np.nan, np.float32)
    V = np.full((n, S, S), np.nan, np.float32)
    FL = np.zeros((n, S, S), np.int32)
    meta = []
    kcache_p = OUT / f"inj_kfit_{field}.json"
    kcache = json.loads(kcache_p.read_text()) if kcache_p.exists() else {}
    for i, r in enumerate(rows):
        path = ROOT / str(r["cutout_path"])
        c = m2ref.load_cutout(path)
        ny, nx = c["P"].shape
        P[i, :ny, :nx] = c["P"]
        V[i, :ny, :nx] = c["V"]
        FL[i, :ny, :nx] = c["FL"]
        key = f"{c['obs_id']}_D{c['detector']}"
        if key not in kcache:
            with fits.open(path, memmap=False) as hl:
                img = np.asarray(hl["IMAGE"].data, float)
            kcache[key] = inject.fit_k(img, c["V"], c["FL"])
        meta.append(dict(obs_id=c["obs_id"], detector=c["detector"], release=c["release"], visit=int(r["visit"]),
                         mjd=c["mjd"], x0=c["x0"], y0=c["y0"], shape=(ny, nx), k=kcache[key]["k"],
                         omega=inject.pixel_solid_angle_sr(c["wcs"]), wcs_header=c["wcs"].to_header(relax=True).tostring(),
                         path=str(path)))
    OUT.mkdir(parents=True, exist_ok=True)
    kcache_p.write_text(json.dumps(kcache))
    for nm, arr in (("P", P), ("V", V), ("FL", FL)):
        np.save(OUT / f"inj_stack_{field}_{nm}.npy", arr)
    return meta, kcache


def wcs_of(m):
    return WCS(fits.Header.fromstring(m["wcs_header"]))


# ================================================================== positions
def offsets_to_radec(ra0, dec0, dx_as, dy_as):
    """Small-angle tangent-plane offsets (east, north, arcsec) -> (ra, dec) deg (error << 1 mas at 30")."""
    dec = dec0 + dy_as / 3600.0
    ra = ra0 + dx_as / 3600.0 / np.cos(np.deg2rad(dec0))
    return ra, dec


def gaia_clear(gaia, mjd, ra, dec):
    """True where no Gaia G < 18 within 20 arcsec and no G < 9 within 180 arcsec (catalogue at mjd)."""
    gra, gde, _ = propagate(gaia, mjd)
    g = np.asarray(gaia["phot_g_mean_mag"], float)
    out = np.ones(len(ra), bool)
    for i in range(len(ra)):
        d = np.hypot((gra - ra[i]) * np.cos(np.deg2rad(dec[i])), gde - dec[i]) * 3600.0
        out[i] = not (np.any((d < 20.0) & (g < 18.0)) or np.any((d < 180.0) & (g < 9.0)))
    return out


def make_configs(field, meta, gaia, motion_idx, n_conf):
    """n_conf configurations for one motion: dict of arrays ra_old, dec_old, ra_new, dec_new, theta, mu."""
    va, vb = VISITS[field]
    tA = float(np.mean([m["mjd"] for m in meta if m["visit"] == va]))
    tB = float(np.mean([m["mjd"] for m in meta if m["visit"] == vb]))
    ref = next(m for m in meta if m["visit"] == va and m["detector"] == REF_DET and m["shape"] == (320, 320))
    w = wcs_of(ref)
    ny, nx = ref["shape"]
    motion = MOTIONS[motion_idx]
    rng = np.random.default_rng([SEED, FIELD_ID[field], motion_idx])
    out = dict(ra_old=[], dec_old=[], ra_new=[], dec_new=[], theta=[])
    mu_as_d = motion * PIX_AS / PERIOD_D
    n_drawn = 0
    while len(out["ra_old"]) < n_conf:
        nb = 256
        x = rng.uniform(detect.MARGIN_PX, nx - 1 - detect.MARGIN_PX, nb)
        y = rng.uniform(detect.MARGIN_PX, ny - 1 - detect.MARGIN_PX, nb)
        th = rng.uniform(0, 2 * np.pi, nb)
        n_drawn += nb
        ra0, de0 = w.pixel_to_world_values(x, y)
        ra0, de0 = np.asarray(ra0, float), np.asarray(de0, float)
        d = mu_as_d * (tB - tA)
        ra1, de1 = offsets_to_radec(ra0, de0, d * np.sin(th), d * np.cos(th))
        ok = gaia_clear(gaia, tA, ra0, de0) & gaia_clear(gaia, tB, ra1, de1)
        for k in np.nonzero(ok)[0]:
            if len(out["ra_old"]) >= n_conf:
                break
            out["ra_old"].append(ra0[k]); out["dec_old"].append(de0[k])
            out["ra_new"].append(ra1[k]); out["dec_new"].append(de1[k]); out["theta"].append(th[k])
    out = {k: np.asarray(v) for k, v in out.items()}
    out.update(mu_as_d=mu_as_d, tA=tA, tB=tB, n_drawn=n_drawn, motion=motion)
    return out


def geometry(meta, cf):
    """Per exposure and configuration: pixel (x, y) of old, new and source position, and lam, bw there."""
    n_e, n_c = len(meta), len(cf["ra_old"])
    g = {k: np.full((n_e, n_c), np.nan) for k in ("xo", "yo", "xn", "yn", "xs", "ys", "lo", "bo", "ln", "bn", "ls")}
    for e, m in enumerate(meta):
        w = wcs_of(m)
        dt = m["mjd"] - cf["tA"]
        d = cf["mu_as_d"] * dt
        ras, des = offsets_to_radec(cf["ra_old"], cf["dec_old"], d * np.sin(cf["theta"]), d * np.cos(cf["theta"]))
        for (kx, ky, ra, de) in (("xo", "yo", cf["ra_old"], cf["dec_old"]), ("xn", "yn", cf["ra_new"], cf["dec_new"]),
                                 ("xs", "ys", ras, des)):
            x, y = w.world_to_pixel_values(ra, de)
            g[kx][e], g[ky][e] = x, y
        for kx, ky, kl, kb in (("xo", "yo", "lo", "bo"), ("xn", "yn", "ln", "bn"), ("xs", "ys", "ls", None)):
            la, bw = cal_lambda(m["release"], m["detector"], g[kx][e] + m["x0"], g[ky][e] + m["y0"])
            g[kl][e] = la
            if kb:
                g[kb][e] = bw
    return g


# ================================================================== workers
_W = {}


def _init_worker(field, meta):
    _W["field"] = field
    _W["meta"] = meta
    _W["P"] = np.load(OUT / f"inj_stack_{field}_P.npy", mmap_mode="r")
    _W["V"] = np.load(OUT / f"inj_stack_{field}_V.npy", mmap_mode="r")
    _W["FL"] = np.load(OUT / f"inj_stack_{field}_FL.npy", mmap_mode="r")
    _W["epsf"] = [inject.get_epsf(field, m["obs_id"], m["detector"]) for m in meta]


def _signals(cidx, xs, ys, flux, seed):
    """Per exposure (signal + noise, variance increment, y0, x0) for one configuration, or None."""
    meta = _W["meta"]
    rng = np.random.default_rng(seed)
    out = []
    for e, m in enumerate(meta):
        x, y, f = xs[e], ys[e], flux[e]
        ny, nx = m["shape"]
        if not (np.isfinite(x) and np.isfinite(y) and np.isfinite(f)) or f <= 0 or x < -8 or y < -8 \
                or x > nx + 7 or y > ny + 7:
            out.append(None)
            continue
        sig, (sy, sx) = inject.signal_stamp(x, y, f, _W["epsf"][e], (m["x0"], m["y0"]), m["omega"])
        vinc = np.clip(m["k"] * sig, 0.0, None)
        noisy = sig + rng.normal(0.0, 1.0, sig.shape) * np.sqrt(vinc)
        out.append((noisy, vinc, sy.start, sx.start))
    return out


def _run_chunk(task):
    """task: dict(va, vb, cidx list, arrays (n_e, nchunk) xo yo xn yn xs ys lo bo ln bn, flux (n_e, nchunk) or
    None per config, seeds). Returns list of (cidx, kind, stats, n_old, n_new)."""
    meta = _W["meta"]
    shapes = [m["shape"] for m in meta]
    P, V, FL = _W["P"], _W["V"], _W["FL"]
    out = []
    for j, ci in enumerate(task["cidx"]):
        po = np.stack([task["xo"][:, j], task["yo"][:, j]], 1)
        pn = np.stack([task["xn"][:, j], task["yn"][:, j]], 1)
        kinds = [("null", None)]
        if task["flux"][j] is not None:
            kinds.append(("inj", _signals(ci, task["xs"][:, j], task["ys"][:, j], task["flux"][j], task["seeds"][j])))
        for kind, sig in kinds:
            mo, mn = detect.measure_trial(P, V, FL, shapes, po, pn, signal=sig)
            old = detect.per_detector(mo, meta, task["lo"][:, j], task["bo"][:, j], task["va"], task["vb"])
            new = detect.per_detector(mn, meta, task["ln"][:, j], task["bn"][:, j], task["va"], task["vb"])
            st = detect.statistic(old, new)
            n_old = sum(1 for m in mo if m is not None and m["ok"])
            n_new = sum(1 for m in mn if m is not None and m["ok"])
            out.append((ci, kind, st, n_old, n_new))
    return out


# ================================================================== grid
def cell_of(i, ntrial):
    """Configuration index -> (spectrum, mag, trial) or None (null-only configuration)."""
    if i >= len(SPECTRA) * len(MAGS) * ntrial:
        return None
    c, t = divmod(i, ntrial)
    s, mi = divmod(c, len(MAGS))
    return SPECTRA[s], float(MAGS[mi]), t


def run_grid(field, meta, gaia, ntrial, workers):
    va, vb = VISITS[field]
    n_inj = len(SPECTRA) * len(MAGS) * ntrial
    n_conf = max(NULL_MIN, n_inj)
    rows = []
    t0 = time.time()
    ctx = get_context("spawn")
    cfg_info = {}
    with ProcessPoolExecutor(max_workers=workers, mp_context=ctx, initializer=_init_worker,
                             initargs=(field, meta)) as ex:
        for motion in ACTIVE_MOTIONS:
            mi = MOTIONS.index(motion)
            cf = make_configs(field, meta, gaia, mi, n_conf)
            g = geometry(meta, cf)
            cfg_info[motion] = dict(n_conf=n_conf, n_drawn=cf["n_drawn"], tA=cf["tA"], tB=cf["tB"],
                                    shift_px=motion * (cf["tB"] - cf["tA"]) / PERIOD_D)
            fluxes = []
            for i in range(n_conf):
                c = cell_of(i, ntrial)
                if c is None:
                    fluxes.append(None)
                else:
                    f = inject.spectrum_mjy(c[0], g["ls"][:, i], c[1])
                    fluxes.append(np.where(np.isfinite(f), f, 0.0))
            seeds = [[SEED, FIELD_ID[field], mi, i, 7] for i in range(n_conf)]
            CH = 12
            tasks = []
            for s0 in range(0, n_conf, CH):
                sl = slice(s0, min(n_conf, s0 + CH))
                t = dict(va=va, vb=vb, cidx=list(range(sl.start, sl.stop)), flux=fluxes[sl], seeds=seeds[sl])
                for k in ("xo", "yo", "xn", "yn", "xs", "ys", "lo", "bo", "ln", "bn"):
                    t[k] = np.ascontiguousarray(g[k][:, sl])
                tasks.append(t)
            for res in ex.map(_run_chunk, tasks):
                for ci, kind, st, n_old, n_new in res:
                    c = cell_of(ci, ntrial)
                    row = dict(field=field, motion=motion, config=ci, kind=kind,
                               spectrum=c[0] if c else "", mag=c[1] if c else np.nan, trial=c[2] if c else -1,
                               ra_old=cf["ra_old"][ci], dec_old=cf["dec_old"][ci], ra_new=cf["ra_new"][ci],
                               dec_new=cf["dec_new"][ci], theta_deg=np.rad2deg(cf["theta"][ci]),
                               n_meas_old=n_old, n_meas_new=n_new)
                    for k in KEYS:
                        for q in ("S", "D_old", "D_new", "var_old", "var_new", "n_det"):
                            row[f"{k}_{q}"] = st[k][q]
                    rows.append(row)
            print(f"  motion {motion:4.2f} px: {n_conf} configurations ({cf['n_drawn']} drawn), "
                  f"elapsed {time.time() - t0:.0f} s", flush=True)
    t = Table(rows=rows)
    t.meta.update(dict(field=field, ntrial=ntrial, seed=SEED, visits=list(VISITS[field]),
                       configs={str(k): v for k, v in cfg_info.items()}, grid_runtime_s=round(time.time() - t0, 1)))
    t.write(OUT / f"inj_trials_{field}.ecsv", overwrite=True)
    return t, time.time() - t0, cfg_info


# ================================================================== analysis
def m50_from(c, n, mags=MAGS):
    """Faint-ward first crossing of 0.5 by linear interpolation in magnitude. Returns (m50, status)."""
    c = np.asarray(c, float)
    if c[0] < 0.5:
        return np.nan, "below_grid"
    for i in range(len(c) - 1):
        if c[i] >= 0.5 and c[i + 1] < 0.5:
            return float(mags[i] + (c[i] - 0.5) / (c[i] - c[i + 1]) * (mags[i + 1] - mags[i])), "ok"
    return np.nan, "above_grid"


def m50_with_error(k, n, rng, ndraw=2000):
    c = k / n
    m, st = m50_from(c, n)
    draws = []
    for _ in range(ndraw):
        cs = rng.binomial(n.astype(int), c) / n
        v, s = m50_from(cs, n)
        draws.append(v if s == "ok" else (-np.inf if s == "below_grid" else np.inf))
    d = np.asarray(draws)
    lo, hi = np.percentile(d, [15.865, 84.135])
    return dict(m50=m, status=st, lo68=float(lo), hi68=float(hi),
                err=float(0.5 * (hi - lo)) if np.isfinite(lo) and np.isfinite(hi) else np.nan)


def analyse(field, t, ntrial):
    rng = np.random.default_rng(SEED + 1)
    res = dict(thresholds={}, false_positive={}, completeness={}, m50={})
    motion = np.asarray(t["motion"], float)
    kind = np.asarray(t["kind"]).astype(str)
    spec = np.asarray(t["spectrum"]).astype(str)
    mag = np.asarray(t["mag"], float)
    for mo in ACTIVE_MOTIONS:
        nm = (motion == mo) & (kind == "null")
        res["thresholds"][str(mo)] = {}
        res["false_positive"][str(mo)] = {}
        for k in KEYS:
            S0 = np.asarray(t[f"{k}_S"], float)[nm]
            fin = np.isfinite(S0)
            thr = float(np.percentile(S0[fin], 99)) if fin.any() else np.nan
            nnull = int(nm.sum())
            fp = int(np.sum(S0[fin] > thr))
            fp5 = int(np.sum(S0[fin] >= 5))
            res["thresholds"][str(mo)][k] = dict(value=thr, n_null=nnull, n_finite=int(fin.sum()))
            res["false_positive"][str(mo)][k] = dict(
                frac_gt_thr=fp / nnull, ci68_thr=binom(fp, nnull), frac_ge5=fp5 / nnull, ci68_5=binom(fp5, nnull))
    for sp in SPECTRA:
        res["completeness"][sp] = {}
        res["m50"][sp] = {}
        for mo in ACTIVE_MOTIONS:
            res["completeness"][sp][str(mo)] = {}
            res["m50"][sp][str(mo)] = {}
            for k in KEYS:
                thr = res["thresholds"][str(mo)][k]["value"]
                ks, k5, ns = [], [], []
                for mg in MAGS:
                    sel = (motion == mo) & (kind == "inj") & (spec == sp) & (mag == mg)
                    S = np.asarray(t[f"{k}_S"], float)[sel]
                    n = int(sel.sum())
                    det = np.isfinite(S) & (S > thr)          # no value counts as not detected
                    ks.append(int(det.sum())); k5.append(int(np.sum(np.isfinite(S) & (S >= 5)))); ns.append(n)
                ks, k5, ns = np.array(ks), np.array(k5), np.array(ns)
                lo, hi = detect.binom_ci68(ks, ns)
                lo5, hi5 = detect.binom_ci68(k5, ns)
                res["completeness"][sp][str(mo)][k] = dict(
                    mags=MAGS.tolist(), n=ns.tolist(), k=ks.tolist(), frac=(ks / ns).tolist(),
                    lo68=np.round(lo, 4).tolist(), hi68=np.round(hi, 4).tolist(),
                    k_ge5=k5.tolist(), frac_ge5=(k5 / ns).tolist(), lo68_ge5=np.round(lo5, 4).tolist(),
                    hi68_ge5=np.round(hi5, 4).tolist())
                res["m50"][sp][str(mo)][k] = dict(thr=m50_with_error(ks, ns, rng), ge5=m50_with_error(k5, ns, rng))
    return res


def binom(k, n):
    lo, hi = detect.binom_ci68(k, n)
    return [round(lo, 5), round(hi, 5)]


def plot_completeness(field, res):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    cols = {"P1": "#c0392b", "PS": "#2471a3", "M2": "#1e8449"}
    paths = []
    for sp in SPECTRA:
        nmo = len(ACTIVE_MOTIONS)
        ncol = min(3, nmo)
        nrow = int(np.ceil(nmo / ncol))
        fig, axes = plt.subplots(nrow, ncol, figsize=(4.4 * ncol, 3.8 * nrow), sharex=True, sharey=True, squeeze=False)
        for ax in axes.ravel()[nmo:]:
            ax.set_visible(False)
        for ax, mo in zip(axes.ravel(), ACTIVE_MOTIONS):
            for m in detect.METHODS:
                for pool, ls in (("six", "-"), ("d2", "--")):
                    c = res["completeness"][sp][str(mo)][f"{m}_{pool}"]
                    f = np.array(c["frac"]); lo = np.array(c["lo68"]); hi = np.array(c["hi68"])
                    ax.plot(MAGS, f, ls=ls, color=cols[m], lw=1.6 if pool == "six" else 1.1,
                            label=f"{m} {'six detectors' if pool == 'six' else 'detector 2'}")
                    if pool == "six":
                        ax.fill_between(MAGS, lo, hi, color=cols[m], alpha=0.15, lw=0)
            ax.axhline(0.5, color="0.7", lw=0.8)
            ax.set_title(f"motion {mo:g} px / 182.6 d", fontsize=10)
            ax.set_ylim(-0.03, 1.03)
            ax.grid(alpha=0.25)
            ax.tick_params(labelbottom=True)
        for ax in axes[-1]:
            ax.set_xlabel("AB magnitude" + (" at 4.5 um" if sp == "browndwarf" else ""))
        for ax in axes[:, 0]:
            ax.set_ylabel("completeness (S > null 99th pct)")
        axes[0, 0].legend(fontsize=7.5, loc="lower left")
        lab = "flat in AB" if sp == "flat" else "Sonora Bobcat 650 K, log g 5"
        va, vb = VISITS[field]
        fig.suptitle(f"Injected movers, {field} visits {va} and {vb}, {lab} (68% binomial band on six-detector curves)",
                     fontsize=11)
        fig.tight_layout()
        p = FIGURES / f"completeness_{field}_{sp}.png"
        fig.savefig(p, dpi=130)
        plt.close(fig)
        paths.append(p)
    return paths


# ================================================================== checks
def run_checks(field, meta, gaia):
    """EPSF findings, k fits, injection verification (aperture fraction, FWHM vs real star) and the hand
    check of one injected source. Returns a dict for the results section."""
    from astropy.modeling import fitting, models
    from photutils.aperture import CircularAperture
    from photutils.centroids import centroid_2dg
    out = {}
    # ---- ePSF findings
    ep = {}
    for det in range(1, 7):
        m = next(x for x in meta if x["detector"] == det)
        rows = inject.get_epsf(field, m["obs_id"], det)
        raw = inject._load_epsf_cached(det, rows["release"])
        arr = raw["epsf_raw"]
        s = arr.sum(axis=(1, 2))
        yy, xx = np.mgrid[0:arr.shape[1], 0:arr.shape[2]]
        cx = (arr * xx).sum((1, 2)) / s
        cy = (arr * yy).sum((1, 2)) / s
        cw_d, _ = cal_lambda(rows["release"], det, raw["xcenter_raw"], raw["ycenter_raw"])
        cw_f, _ = cal_lambda(rows["release"], det, 2039 - raw["xcenter_raw"], raw["ycenter_raw"])
        # identity across exposures: compare the cached table with one other exposure per release
        others = [x for x in meta if x["detector"] == det and x["release"] == rows["release"] and x["obs_id"] != m["obs_id"]]
        same = None
        if others:
            hcp = inject.EPSF_DIR / f"hash_{field}_D{det}_{others[-1]['obs_id']}.txt"
            if not hcp.exists():
                key, _ = inject._index_row(field, others[-1]["obs_id"], det)
                _, md5 = inject.fetch_epsf_hdu(key)
                hcp.write_text(md5)
            same = hcp.read_text().strip() == str(raw["md5"])
        ep[f"D{det}"] = dict(release=rows["release"], n_zones=int(arr.shape[0]), shape=list(arr.shape[1:]),
                             oversampling=list(rows["oversampling"]), sum_median=float(np.median(s)),
                             sum_min=float(s.min()), sum_max=float(s.max()),
                             centroid_x_median=float(np.median(cx)), centroid_y_median=float(np.median(cy)),
                             negative_pixel_frac=float((arr < 0).mean()),
                             cwave_vs_cal_direct_median_abs_um=float(np.nanmedian(np.abs(raw["cwave"] - cw_d))),
                             cwave_vs_cal_xmirrored_median_abs_um=float(np.nanmedian(np.abs(raw["cwave"] - cw_f))),
                             detcoord=str(raw["detcoord"]), flipped_in_use=bool(rows["flipped"]),
                             md5=str(raw["md5"]), identical_to_other_exposure=same,
                             other_exposure=others[-1]["obs_id"] if others else None, calfile=str(raw["calfile"]))
    out["epsf"] = ep
    # ---- k fits
    kc = json.loads((OUT / f"inj_kfit_{field}.json").read_text())
    kk = {}
    for det in range(1, 7):
        ks = [kc[f"{m['obs_id']}_D{det}"] for m in meta if m["detector"] == det]
        kv = np.array([x["k"] for x in ks])
        kk[f"D{det}"] = dict(n=len(ks), k_median=float(np.median(kv)), k_p16=float(np.percentile(kv, 16)),
                             k_p84=float(np.percentile(kv, 84)),
                             curvature_median=float(np.median([x["curvature"] for x in ks])),
                             rms_frac_median=float(np.median([x["rms_frac"] for x in ks])),
                             intercept_median=float(np.median([x["a"] for x in ks])),
                             image_range_median=[float(np.median([x["image_range"][0] for x in ks])),
                                                 float(np.median([x["image_range"][1] for x in ks]))])
    out["k_fit"] = kk
    # ---- injection verification at blank positions (motion-0 configurations)
    cf = make_configs(field, meta, gaia, 0, 40)
    rng = np.random.default_rng(SEED + 3)
    ver = []
    va = VISITS[field][0]
    for det in range(1, 7):
        exps = [i for i, m in enumerate(meta) if m["detector"] == det and m["visit"] == va][:4]
        for e in exps:
            m = meta[e]
            c = m2ref.load_cutout(m["path"])
            w = c["wcs"]
            rows = inject.get_epsf(field, m["obs_id"], det)
            for j in range(len(cf["ra_old"])):
                x, y = (float(v) for v in w.world_to_pixel_values(cf["ra_old"][j], cf["dec_old"][j]))
                if detect.inside_margin(x, y, c["P"].shape):
                    break
            else:
                continue
            la, _ = cal_lambda(m["release"], det, x + m["x0"], y + m["y0"])
            flux = float(inject.spectrum_mjy("flat", la, 14.0))
            with fits.open(m["path"], memmap=False) as hl:
                img = np.asarray(hl["IMAGE"].data, float)
                zod = np.asarray(hl["ZODI"].data, float)
            arrs = dict(IMAGE=img, VARIANCE=c["V"], FLAGS=c["FL"])
            new_img, new_var, info = inject.inject_point(arrs, w, cf["ra_old"][j], cf["dec_old"][j], flux, rows,
                                                         (m["x0"], m["y0"]), rng, k=m["k"], omega_sr=m["omega"],
                                                         return_info=True)
            m0 = m2ref.measure_pixels(c["P"], c["V"], c["FL"], x, y)
            m1 = m2ref.measure_pixels(new_img - zod, new_var, c["FL"], x, y)
            # noise-free: signal only
            nf = c["P"].copy()
            ys_, xs_ = info["window"]
            nf[ys_, xs_] += info["signal"]
            m2 = m2ref.measure_pixels(nf, c["V"], c["FL"], x, y)
            # aperture fraction of the ePSF at this sub-pixel position
            xi, yi = int(np.rint(x)), int(np.rint(y))
            st = inject.psf_stamp(rows, x + m["x0"], y + m["y0"], x - xi, y - yi, size=15)
            am = CircularAperture((7 + (x - xi), 7 + (y - yi)), m2ref.APER_R).to_mask(method="exact")
            apw = am.to_image((15, 15))
            ap_frac = float(np.sum(st * apw))
            exp_mjy = flux * ap_frac
            rec = (m1["flux"] - m0["flux"]) * m["omega"] if (m0["ok"] and m1["ok"]) else np.nan
            rec_nf = (m2["flux"] - m0["flux"]) * m["omega"] if (m0["ok"] and m2["ok"]) else np.nan
            ver.append(dict(obs_id=m["obs_id"], detector=det, x=x, y=y, lam=float(la), flux_mjy=flux,
                            stamp_sum=float(st.sum()), ap_frac=ap_frac, expected_ap_mjy=exp_mjy,
                            recovered_ap_mjy=rec, ratio=rec / exp_mjy, ratio_noise_free=rec_nf / exp_mjy,
                            k=m["k"], snr=(m1["flux"] - m0["flux"]) / np.sqrt(m1["var_raw"]) if m1["ok"] else np.nan))
    out["aperture_check"] = ver
    # ---- FWHM: injected vs real star of similar flux in the same frame
    phot = Table.read(DATA / "phaseb" / field / "forced_phot.ecsv")
    sids = np.array(sorted({int(s) for s in phot["source_id"]}))
    gs = np.asarray(gaia["source_id"], np.int64)
    stars = gaia[np.array([int(np.nonzero(gs == s)[0][0]) for s in sids])]
    fitter = fitting.TRFLSQFitter()

    def fwhm(stamp):
        if not np.all(np.isfinite(stamp)):
            return np.nan, np.nan, np.nan
        h = stamp.shape[0] // 2
        yy, xx = np.mgrid[0:stamp.shape[0], 0:stamp.shape[1]]
        g0 = models.Gaussian2D(amplitude=float(stamp.max()), x_mean=h, y_mean=h, x_stddev=0.6, y_stddev=0.6) \
            + models.Const2D(0.0)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            f = fitter(g0, xx, yy, stamp, maxiter=2000)
        sx, sy = abs(f[0].x_stddev.value), abs(f[0].y_stddev.value)
        return 2.3548 * np.sqrt(sx * sy), f[0].x_mean.value, f[0].y_mean.value

    fw = []
    g_st = np.asarray(stars["phot_g_mean_mag"], float)
    pick = (g_st > 13.0) & (g_st < 14.5)
    for det in range(1, 7):
        exps = [i for i, m in enumerate(meta) if m["detector"] == det and m["visit"] == va][:3]
        for e in exps:
            m = meta[e]
            c = m2ref.load_cutout(m["path"])
            w = c["wcs"]
            ra, de, _ = propagate(stars, m["mjd"])
            xs, ys = w.world_to_pixel_values(ra, de)
            cand = [i for i in np.nonzero(pick)[0] if detect.inside_margin(xs[i], ys[i], c["P"].shape)]
            best = None
            for i in cand:
                ms = m2ref.measure_pixels(c["P"], c["V"], c["FL"], float(xs[i]), float(ys[i]))
                xr_, yr_ = int(np.rint(xs[i])), int(np.rint(ys[i]))
                if ms["ok"] and not ms["saturated"] and np.isfinite(c["P"][yr_ - 4:yr_ + 5, xr_ - 4:xr_ + 5]).all():
                    best = (i, ms)
                    break
            if best is None:
                continue
            i, ms = best
            rows = inject.get_epsf(field, m["obs_id"], det)
            # blank position (for this profile check only: also no pixel above 5 robust sigma of the local
            # background in the 9 x 9 window, so that a non-Gaia object cannot distort the fit)
            found = False
            for j in range(len(cf["ra_old"])):
                x, y = (float(v) for v in w.world_to_pixel_values(cf["ra_old"][j], cf["dec_old"][j]))
                if not detect.inside_margin(x, y, c["P"].shape):
                    continue
                bx, by = int(np.rint(x)), int(np.rint(y))
                win = c["P"][by - 4:by + 5, bx - 4:bx + 5]
                if not np.isfinite(win).all():
                    continue
                med = np.median(win)
                rs = 1.4826 * np.median(np.abs(win - med))
                if np.max(win - med) < 5 * rs:
                    found = True
                    break
            if not found:
                continue
            # same sub-pixel phase as the real star (a pixel-sampled FWHM depends on the phase)
            xi, yi = int(np.rint(x)), int(np.rint(y))
            x = xi + float(xs[i] - np.rint(xs[i]))
            y = yi + float(ys[i] - np.rint(ys[i]))
            st = inject.psf_stamp(rows, x + m["x0"], y + m["y0"], x - xi, y - yi, size=15)
            apw = CircularAperture((7 + (x - xi), 7 + (y - yi)), m2ref.APER_R).to_mask(method="exact").to_image((15, 15))
            flux = ms["flux"] * m["omega"] / float(np.sum(st * apw))     # same aperture flux as the star
            P2 = c["P"].copy()
            sig, (sy, sx) = inject.signal_stamp(x, y, flux, rows, (m["x0"], m["y0"]), m["omega"])
            P2[sy, sx] += sig + rng.normal(0, 1, sig.shape) * np.sqrt(np.clip(m["k"] * sig, 0, None))
            H = 4
            sxr, syr = int(np.rint(xs[i])), int(np.rint(ys[i]))
            real = c["P"][syr - H:syr + H + 1, sxr - H:sxr + H + 1] - ms["bkg"]
            mi_ = m2ref.measure_pixels(P2, c["V"], c["FL"], x, y)
            inj = P2[yi - H:yi + H + 1, xi - H:xi + H + 1] - mi_["bkg"]
            fr, _, _ = fwhm(real)
            fi, _, _ = fwhm(inj)
            if not (np.isfinite(fr) and np.isfinite(fi)):
                continue
            fw.append(dict(obs_id=m["obs_id"], detector=det, star=int(sids[i]), G=float(g_st[i]),
                           star_ap_flux=ms["flux"], inj_ap_flux=mi_["flux"], fwhm_real_px=float(fr),
                           fwhm_inj_px=float(fi), ratio=float(fi / fr)))
    out["fwhm_check"] = fw
    # ---- hand check: one injected source (motion 2 px, AB 15 flat), one exposure
    cf2 = make_configs(field, meta, gaia, MOTIONS.index(2.0), 1)
    e = next(i for i, m in enumerate(meta) if m["detector"] == 2 and m["visit"] == va)
    m = meta[e]
    c = m2ref.load_cutout(m["path"])
    w = c["wcs"]
    dt = m["mjd"] - cf2["tA"]
    d = cf2["mu_as_d"] * dt
    ras, des = offsets_to_radec(cf2["ra_old"][0], cf2["dec_old"][0], d * np.sin(cf2["theta"][0]),
                                d * np.cos(cf2["theta"][0]))
    x, y = (float(v) for v in w.world_to_pixel_values(ras, des))
    la, _ = cal_lambda(m["release"], 2, x + m["x0"], y + m["y0"])
    flux = float(inject.spectrum_mjy("flat", la, 15.0))
    rows = inject.get_epsf(field, m["obs_id"], 2)
    with fits.open(m["path"], memmap=False) as hl:
        img = np.asarray(hl["IMAGE"].data, float)
        zod = np.asarray(hl["ZODI"].data, float)
    new_img, new_var = inject.inject_point(dict(IMAGE=img, VARIANCE=c["V"], FLAGS=c["FL"]), w, ras, des, flux, rows,
                                           (m["x0"], m["y0"]), np.random.default_rng(SEED + 5), k=m["k"],
                                           omega_sr=m["omega"])
    Pn = new_img - zod
    mm = m2ref.measure_pixels(Pn, new_var, c["FL"], x, y)
    xi, yi = int(np.rint(x)), int(np.rint(y))
    H = 3
    stamp = Pn[yi - H:yi + H + 1, xi - H:xi + H + 1] - mm["bkg"]
    cxg, cyg = centroid_2dg(stamp)
    xm, ym = xi - H + cxg, yi - H + cyg
    ram, dem = w.pixel_to_world_values(xm, ym)
    sep = float(np.hypot((float(ram) - ras) * np.cos(np.deg2rad(des)), float(dem) - des) * 3600.0)
    # same centroid on the noise-free injected signal alone (separates placement from noise)
    sig, (sy, sx) = inject.signal_stamp(x, y, flux, rows, (m["x0"], m["y0"]), m["omega"])
    c0 = 7
    nfx, nfy = centroid_2dg(sig[c0 - H:c0 + H + 1, c0 - H:c0 + H + 1])
    nf_x, nf_y = sx.start + c0 - H + nfx, sy.start + c0 - H + nfy
    out["hand_check"] = dict(obs_id=m["obs_id"], detector=2, mjd=m["mjd"], mag_ab=15.0, motion_px=2.0,
                             ra_injected=float(ras), dec_injected=float(des), x_injected=x, y_injected=y,
                             x_centroid_2dg=float(xm), y_centroid_2dg=float(ym), ra_measured=float(ram),
                             dec_measured=float(dem), offset_arcsec=sep, offset_px=sep / PIX_AS,
                             x_centroid_noise_free=float(nf_x), y_centroid_noise_free=float(nf_y),
                             offset_noise_free_px=float(np.hypot(nf_x - x, nf_y - y)),
                             aperture_flux=mm["flux"], aperture_snr=mm["flux"] / np.sqrt(mm["var_raw"]))
    return out


# ================================================================== reporting
def headline_independent(field):
    """Recompute M2 six-detector, motion 2, flat m50 from the saved per-trial table with plain numpy."""
    t = Table.read(OUT / f"inj_trials_{field}.ecsv")
    mo, kd, sp, mg = (np.asarray(t[c]) for c in ("motion", "kind", "spectrum", "mag"))
    S = np.asarray(t["M2_six_S"], float)
    s0 = S[(mo == 2.0) & (kd == "null")]
    thr = np.percentile(s0[np.isfinite(s0)], 99)
    mags = np.unique(mg[(kd == "inj")])
    c = np.array([np.mean(np.nan_to_num(S[(mo == 2.0) & (kd == "inj") & (sp == "flat") & (mg == x)], nan=-np.inf) > thr)
                  for x in mags])
    i = int(np.argmax(c < 0.5))                       # first magnitude below 50 percent
    m50 = mags[i - 1] + (c[i - 1] - 0.5) / (c[i - 1] - c[i]) * (mags[i] - mags[i - 1]) if i > 0 else np.nan
    return float(thr), float(m50), c


def print_tables(field, res):
    print(f"\n== injection_{field}: thresholds (null 99th pct of S) and false positives")
    print("  motion  " + "  ".join(f"{k:>8s}" for k in KEYS))
    for mo in ACTIVE_MOTIONS:
        print(f"  {mo:5.2f}   " + "  ".join(f"{res['thresholds'][str(mo)][k]['value']:8.2f}" for k in KEYS))
    print("  null fraction S >= 5:")
    for mo in ACTIVE_MOTIONS:
        print(f"  {mo:5.2f}   " + "  ".join(f"{100 * res['false_positive'][str(mo)][k]['frac_ge5']:7.2f}%" for k in KEYS))
    for sp in SPECTRA:
        print(f"\n  50% completeness AB magnitude, {sp} (threshold = null 99th pct; +- half 68% range; '<14' or '>19.5' off grid)")
        print("  motion  " + "  ".join(f"{k:>13s}" for k in KEYS))
        for mo in ACTIVE_MOTIONS:
            cells = []
            for k in KEYS:
                r = res["m50"][sp][str(mo)][k]["thr"]
                if r["status"] == "ok":
                    cells.append(f"{r['m50']:6.2f}+-{r['err']:.2f}" if np.isfinite(r["err"]) else f"{r['m50']:6.2f}+-?")
                else:
                    cells.append("<14" if r["status"] == "below_grid" else ">19.5")
            print(f"  {mo:5.2f}   " + "  ".join(f"{c:>13s}" for c in cells))


def run_field(field, ntrial, workers, reanalyse=False):
    t0 = time.time()
    print(f"\n#### {field}: visits {VISITS[field]}, ntrial {ntrial}, workers {workers}", flush=True)
    gaia = Table.read(DATA / f"gaia_{field}.ecsv")
    meta, _ = load_field(field)
    print(f"  {len(meta)} exposures loaded ({time.time() - t0:.0f} s)", flush=True)
    for m in meta:                                   # fill the ePSF cache before the workers start
        inject.get_epsf(field, m["obs_id"], m["detector"])
    checks = run_checks(field, meta, gaia)
    print(f"  checks done ({time.time() - t0:.0f} s)", flush=True)
    tp = OUT / f"inj_trials_{field}.ecsv"
    if reanalyse and tp.exists():
        t = Table.read(tp)
        ntrial = int(t.meta["ntrial"])
        cfg_info = {float(k): v for k, v in t.meta["configs"].items()}
        t_grid = float(t.meta.get("grid_runtime_s", np.nan))
        print(f"  re-analysing saved trials {tp.name} (ntrial {ntrial})", flush=True)
    else:
        t, t_grid, cfg_info = run_grid(field, meta, gaia, ntrial, workers)
    res = analyse(field, t, ntrial)
    figs = plot_completeness(field, res)
    thr_i, m50_i, c_i = headline_independent(field)
    head = res["m50"]["flat"]["2.0"]["M2_six"]["thr"]   # motion 2 and flat are always run
    runtime = time.time() - t0
    va, vb = VISITS[field]
    ap = checks["aperture_check"]
    fwc = checks["fwhm_check"]
    payload = dict(
        script=SCRIPT, field=field, visits=[va, vb], ntrial=ntrial, mags=MAGS.tolist(), motions_px=list(ACTIVE_MOTIONS),
        scope=dict(spectra=list(SPECTRA), motions_px=list(ACTIVE_MOTIONS), null_min=NULL_MIN,
                   preregistered=dict(spectra=["flat", "browndwarf"], motions_px=list(MOTIONS), ntrial=50, null_min=500),
                   note=None if (len(SPECTRA) == 2 and ACTIVE_MOTIONS == MOTIONS and ntrial == 50 and NULL_MIN >= 500)
                   else "REDUCED SCOPE (time cut by the lead, machine heavily loaded): see spectra, motions_px, ntrial, null_min"),
        spectra=dict(flat="flat in AB (F_nu constant)",
                     browndwarf=f"Sonora Bobcat {inject.SONORA_MEMBER} (Teff 650 K, log g 5, [M/H]=0, cloudless; "
                                "Marley et al. 2021, ApJ 920, 85; doi:10.5281/zenodo.5063476, CC BY 4.0), smoothed to "
                                "R=40 below 3.8 um and R=120 above, normalised to the AB magnitude at 4.5 um"),
        n_exposures=len(meta), configs=cfg_info,
        headline=metric(round(head["m50"], 3) if np.isfinite(head["m50"]) else None, "AB mag", n=ntrial, script=SCRIPT,
                        note=f"50% completeness, M2 six detectors, motion 2 px / 182.6 d, flat spectrum; 68% range "
                             f"{head['lo68']:.2f} to {head['hi68']:.2f}; independent recomputation {m50_i:.3f}"),
        thresholds=res["thresholds"], false_positive=res["false_positive"], m50=res["m50"],
        completeness=res["completeness"], checks=dict(
            epsf=checks["epsf"], k_fit=checks["k_fit"],
            aperture_ratio_median=float(np.nanmedian([a["ratio"] for a in ap])),
            aperture_ratio_noise_free_median=float(np.nanmedian([a["ratio_noise_free"] for a in ap])),
            aperture_ratio_noise_free_range=[float(np.nanmin([a["ratio_noise_free"] for a in ap])),
                                             float(np.nanmax([a["ratio_noise_free"] for a in ap]))],
            aperture_check=ap, fwhm_ratio_median=float(np.median([f["ratio"] for f in fwc])) if fwc else None,
            fwhm_check=fwc, hand_check=checks["hand_check"],
            headline_recomputed=dict(threshold=thr_i, m50=m50_i, completeness=c_i.tolist())),
        definitions=dict(
            S="(D_old - D_new) / sqrt(var_old + var_new), D = visit A minus visit B",
            pooling="d2: detector 2; six: inverse-variance mean of D over detectors with a value at both positions",
            detected="S > null 99th percentile (strict; trials without a value count as not detected); also S >= 5",
            positions="uniform in the reference cutout (first full-size visit-A detector-2 cutout) >= 15 px from its "
                      "edges; a position is measured in an exposure only when >= 15 px inside that cutout",
            m50="first faint-ward crossing of 0.5, linear in magnitude; 68% range from 2000 binomial redraws"),
        figures=[str(p.relative_to(FIGURES.parent.parent)) for p in figs],
        runtime_s=round(runtime, 1), grid_runtime_s=round(t_grid, 1))
    update_results(f"injection_{field}", payload)
    print_tables(field, res)
    print("\n  checks:")
    for det, e in checks["epsf"].items():
        print(f"   ePSF {det}: {e['n_zones']} zones, sum med {e['sum_median']:.4f} [{e['sum_min']:.4f},{e['sum_max']:.4f}], "
              f"centroid ({e['centroid_x_median']:.3f},{e['centroid_y_median']:.3f}), dCWAVE direct "
              f"{e['cwave_vs_cal_direct_median_abs_um']:.4f} mirrored {e['cwave_vs_cal_xmirrored_median_abs_um']:.4f} um, "
              f"flipped {e['flipped_in_use']}, identical to {e['other_exposure']}: {e['identical_to_other_exposure']}")
    for det, k in checks["k_fit"].items():
        print(f"   k {det}: median {k['k_median']:.4g} [{k['k_p16']:.4g},{k['k_p84']:.4g}] (MJy/sr), curvature "
              f"{k['curvature_median']:+.3f}, rms_frac {k['rms_frac_median']:.4f}, IMAGE range {k['image_range_median']}")
    print(f"   aperture recovered / expected: median {payload['checks']['aperture_ratio_median']:.4f} (noisy), "
          f"noise-free median {payload['checks']['aperture_ratio_noise_free_median']:.5f} range "
          f"{payload['checks']['aperture_ratio_noise_free_range']}")
    for a in ap[:: max(1, len(ap) // 6)]:
        print(f"     D{a['detector']} {a['obs_id']}: ap_frac {a['ap_frac']:.4f} stamp_sum {a['stamp_sum']:.4f} "
              f"ratio {a['ratio']:.4f} noise-free {a['ratio_noise_free']:.5f} SNR {a['snr']:.0f}")
    for f in fwc:
        print(f"     FWHM D{f['detector']} {f['obs_id']}: real {f['fwhm_real_px']:.3f} px (G {f['G']:.2f}) injected "
              f"{f['fwhm_inj_px']:.3f} px ratio {f['ratio']:.3f}")
    h = checks["hand_check"]
    print(f"   hand check {h['obs_id']} D2 MJD {h['mjd']:.5f}: injected ({h['ra_injected']:.6f}, {h['dec_injected']:.6f}) "
          f"pixel ({h['x_injected']:.3f}, {h['y_injected']:.3f}); centroid_2dg ({h['x_centroid_2dg']:.3f}, "
          f"{h['y_centroid_2dg']:.3f}); offset {h['offset_arcsec']:.3f} arcsec = {h['offset_px']:.3f} px (SNR {h['aperture_snr']:.0f})")
    print(f"   headline M2 six, motion 2, flat: pipeline m50 {head['m50']:.3f} [{head['lo68']:.2f},{head['hi68']:.2f}]; "
          f"independent recomputation threshold {thr_i:.3f}, m50 {m50_i:.3f}")
    print(f"  runtime {runtime / 60:.1f} min (grid {t_grid / 60:.1f} min)", flush=True)
    return payload


def main():
    global SPECTRA, ACTIVE_MOTIONS, NULL_MIN
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", default="all", choices=["barnard", "epsindi", "all"])
    ap.add_argument("--ntrial", type=int, default=50)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--reanalyse", action="store_true", help="re-use data/phasec/inj_trials_<field>.ecsv")
    ap.add_argument("--spectra", default=",".join(SPECTRA), help="scope cut: subset of flat,browndwarf")
    ap.add_argument("--motions", default=",".join(f"{m:g}" for m in MOTIONS), help="scope cut: subset of motions (px)")
    ap.add_argument("--null-min", type=int, default=NULL_MIN, help="minimum null trials per motion")
    a = ap.parse_args()
    SPECTRA = tuple(x for x in a.spectra.split(",") if x)
    ACTIVE_MOTIONS = tuple(float(x) for x in a.motions.split(","))
    assert all(m in MOTIONS for m in ACTIVE_MOTIONS) and 2.0 in ACTIVE_MOTIONS and "flat" in SPECTRA
    NULL_MIN = a.null_min
    if "browndwarf" in SPECTRA:
        inject.load_spectrum("browndwarf", 4.5)      # fail early if the template is missing
    for f in (["barnard", "epsindi"] if a.field == "all" else [a.field]):
        run_field(f, a.ntrial, a.workers, a.reanalyse)


if __name__ == "__main__":
    main()
