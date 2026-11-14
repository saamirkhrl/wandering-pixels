"""Phase C mover statistic at fixed sky positions (docs/method.md, phase C items 2, 5 and 6).

For one trial: an old position (visit A position at visit A's mean epoch) and a new position (visit B
position at visit B's mean epoch). Both are measured with wp.m2ref.measure_pixels in every exposure
(both visits, all detectors) whose cutout contains the position at least MARGIN_PX native pixels from
its edges. Per detector, wp.m2ref.compare_visits gives for each position
  M2 : matched spectral model, combined over the selected w0 (D, var)
  P1 : plain best pair, combined over the selected w0 (res['plain'])
  PS : paired stack (res['ps'])
with D = visit A minus visit B. The statistic is S = (D_old - D_new) / sqrt(var_old + var_new).
Pooling: 'd2' = detector 2 only; 'six' = inverse-variance mean of D over the detectors where both
positions have a value (separately for old and new, same detector set), then S.

Speed: every measurement runs on a small window around the two positions (results identical to the
full cutout because the window keeps >= 9 px around each position, more than measure_pixels reads,
and positions are >= MARGIN_PX inside the cutout); the injected source is added only to that window.
"""
from __future__ import annotations

import numpy as np

from . import m2ref

METHODS = ("P1", "PS", "M2")
POOLS = ("d2", "six")
MARGIN_PX = 15          # positions must be this far inside a cutout (method.md phase C item 2)
WIN_PAD = 9             # measure_pixels reads xi +/- 8 (annulus < 7 px); keep 9


def method_values(res):
    """(D, var) per method from one m2ref.compare_visits result (NaN when no value)."""
    out = {}
    out["M2"] = (res["D"], res["var"]) if res.get("per_w0") else (np.nan, np.nan)
    pl = res.get("plain")
    out["P1"] = (pl["D"], pl["var"]) if pl else (np.nan, np.nan)
    ps = res["ps"]
    out["PS"] = (ps["D"], ps["var"]) if ps["n_pairs"] > 0 else (np.nan, np.nan)
    return out


def samples_from(meas, exp_meta, lam, bw):
    """Accepted measurements -> m2ref samples. meas: list of measure_pixels dicts (or None)."""
    s = []
    for m, e, la, b in zip(meas, exp_meta, lam, bw):
        if m is None or not m["ok"] or not np.isfinite(la):
            continue
        s.append(dict(id=e["obs_id"], lam=float(la), bw=float(b), mjd=e["mjd"], flux=m["flux"], var=m["var"],
                      saturated=m["saturated"]))
    return s


def per_detector(meas_by_exp, exp_meta, lam, bw, visit_a, visit_b, detectors=range(1, 7)):
    """meas_by_exp: list over exposures of measure dicts (None = not measured). Returns
    {det: {method: (D, var)}} for one position."""
    out = {}
    for d in detectors:
        ia = [i for i, e in enumerate(exp_meta) if e["detector"] == d and e["visit"] == visit_a]
        ib = [i for i, e in enumerate(exp_meta) if e["detector"] == d and e["visit"] == visit_b]
        sa = samples_from([meas_by_exp[i] for i in ia], [exp_meta[i] for i in ia], lam[ia], bw[ia])
        sb = samples_from([meas_by_exp[i] for i in ib], [exp_meta[i] for i in ib], lam[ib], bw[ib])
        if not sa or not sb:
            out[d] = {m: (np.nan, np.nan) for m in METHODS}
            continue
        out[d] = method_values(m2ref.compare_visits(sa, sb))
    return out


def statistic(old, new, detectors=range(1, 7)):
    """S per method and pooling from per_detector() outputs of the old and new positions.
    Returns dict {f'{method}_{pool}': dict(S, D_old, D_new, var_old, var_new, n_det)}."""
    out = {}
    for m in METHODS:
        for pool in POOLS:
            dets = [2] if pool == "d2" else list(detectors)
            Do, vo, Dn, vn = [], [], [], []
            for d in dets:
                a, va = old[d][m]
                b, vb = new[d][m]
                if np.isfinite(a) and np.isfinite(b) and va > 0 and vb > 0:
                    Do.append(a); vo.append(va); Dn.append(b); vn.append(vb)
            if not Do:
                out[f"{m}_{pool}"] = dict(S=np.nan, D_old=np.nan, D_new=np.nan, var_old=np.nan, var_new=np.nan, n_det=0)
                continue
            Do, vo, Dn, vn = map(np.asarray, (Do, vo, Dn, vn))
            wo, wn = 1 / vo, 1 / vn
            Dom, vom = float(np.sum(wo * Do) / wo.sum()), float(1 / wo.sum())
            Dnm, vnm = float(np.sum(wn * Dn) / wn.sum()), float(1 / wn.sum())
            out[f"{m}_{pool}"] = dict(S=(Dom - Dnm) / np.sqrt(vom + vnm), D_old=Dom, D_new=Dnm, var_old=vom,
                                      var_new=vnm, n_det=len(Do))
    return out


def inside_margin(x, y, shape, margin=MARGIN_PX):
    ny, nx = shape
    return np.isfinite(x) & np.isfinite(y) & (x >= margin) & (x <= nx - 1 - margin) & (y >= margin) & (y <= ny - 1 - margin)


def measure_trial(P, V, FL, shapes, pos_old, pos_new, signal=None):
    """Measure the old and new positions in every exposure.

    P, V, FL: per-exposure 2-D arrays (any indexable sequence). shapes: true cutout shapes.
    pos_old, pos_new: (n_exp, 2) cutout pixel (x, y); NaN or outside the margin = not measured.
    signal: optional per-exposure (stamp, y0, x0) noise-included additive image (MJy/sr) and the
    matching variance increment, as a tuple (sig_img, sig_var, y0, x0) or None.
    Returns (meas_old, meas_new) lists of measure dicts or None."""
    n = len(shapes)
    mo, mn = [None] * n, [None] * n
    same = np.allclose(pos_old, pos_new, equal_nan=True)
    for e in range(n):
        xo, yo = pos_old[e]
        xn, yn = pos_new[e]
        ok_o = bool(inside_margin(xo, yo, shapes[e]))
        ok_n = bool(inside_margin(xn, yn, shapes[e]))
        if not (ok_o or ok_n):
            continue
        xs = [v for v, ok in ((xo, ok_o), (xn, ok_n)) if ok]
        ys = [v for v, ok in ((yo, ok_o), (yn, ok_n)) if ok]
        x0 = max(0, int(np.floor(min(xs))) - WIN_PAD)
        x1 = min(shapes[e][1], int(np.ceil(max(xs))) + WIN_PAD + 1)
        y0 = max(0, int(np.floor(min(ys))) - WIN_PAD)
        y1 = min(shapes[e][0], int(np.ceil(max(ys))) + WIN_PAD + 1)
        p = np.array(P[e][y0:y1, x0:x1], dtype=float)
        v = np.array(V[e][y0:y1, x0:x1], dtype=float)
        f = np.asarray(FL[e][y0:y1, x0:x1])
        if signal is not None and signal[e] is not None:
            simg, svar, sy0, sx0 = signal[e]
            _add_window(p, simg, sy0 - y0, sx0 - x0)
            _add_window(v, svar, sy0 - y0, sx0 - x0)
        if ok_o:
            mo[e] = m2ref.measure_pixels(p, v, f, xo - x0, yo - y0)
        if ok_n:
            mn[e] = mo[e] if (same and ok_o) else m2ref.measure_pixels(p, v, f, xn - x0, yn - y0)
    return mo, mn


def _add_window(dst, src, oy, ox):
    """dst[oy:oy+h, ox:ox+w] += src, clipped to dst."""
    h, w = src.shape
    ys0, xs0 = max(0, -oy), max(0, -ox)
    yd0, xd0 = max(0, oy), max(0, ox)
    yd1, xd1 = min(dst.shape[0], oy + h), min(dst.shape[1], ox + w)
    if yd1 <= yd0 or xd1 <= xd0:
        return
    dst[yd0:yd1, xd0:xd1] += src[ys0:ys0 + (yd1 - yd0), xs0:xs0 + (xd1 - xd0)]


# ------------------------------------------------------------------ statistics helpers --
def binom_ci68(k, n):
    """Clopper-Pearson central 68.27 percent interval for k successes in n trials -> (lo, hi)."""
    from scipy.stats import beta
    k, n = np.asarray(k, float), np.asarray(n, float)
    a = (1 - 0.6827) / 2
    with np.errstate(invalid="ignore", divide="ignore"):
        lo = np.where(k > 0, beta.ppf(a, k, n - k + 1), 0.0)
        hi = np.where(k < n, beta.ppf(1 - a, k + 1, n - k), 1.0)
    lo = np.where(n > 0, lo, np.nan)
    hi = np.where(n > 0, hi, np.nan)
    return (float(lo), float(hi)) if lo.ndim == 0 else (lo, hi)


def mad_width(z):
    z = np.asarray(z, float)
    z = z[np.isfinite(z)]
    return float(1.4826 * np.median(np.abs(z - np.median(z)))) if z.size else np.nan
