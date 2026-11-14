"""Phase C injection of fake point sources into SPHEREx Level 2 cutouts (docs/method.md, "Choices fixed
before any phase C result was computed", items 1-4).

Stable API (imported by other phase C scripts):
  ab_to_mjy(mag)                                      AB magnitude -> flux density in MJy
  load_spectrum(name, lam_um)                         relative F_nu at lam ('flat' or 'browndwarf')
  spectrum_mjy(name, lam_um, mag_ab, norm_lam_um=4.5) F_nu in MJy with AB mag `mag_ab` at norm_lam
  get_epsf(field, obs_id, detector)                   archive ePSF table of that exposure (cached)
  psf_stamp(epsf_rows, x_det, y_det, dx, dy, size=15) native-pixel stamp of a unit-flux source
  inject_point(arrays, wcs, ra, dec, flux_mjy, epsf_rows, x0y0, rng) -> (image_new, var_new)
  fit_k(image, var, flags)                            photon-noise gain k (VARIANCE = a + k IMAGE)

Conventions: pixels 0-based, data[y, x], pixel (i, j) covers [i-0.5, i+0.5] (as wp/m2ref.py).
Cutout pixel + (X0, Y0) = detector pixel. Surface brightness in MJy/sr.

ePSF (EPSF extension of each Level 2 file; one row per detector zone; built with photutils
EPSFBuilder: header MAXIT, SMOOTH='quartic', KEEPNAT/KEEPOS, OVSMPX/OVSMPY = 5). Findings that this
module relies on (checked by scripts/10_injection.py --checks and reported there):
  * The table is identical for every exposure of a detector, in both releases (same calibration file
    epsf_<det>_20260507.fits); it is cached once per detector and release under data/epsf/.
  * Each 33 x 33 array sums to 1.0000 at the OVERSAMPLED sampling (not to OVSMPX*OVSMPY = 25 as in the
    photutils ImagePSF convention). It is an effective PSF (pixel-convolved, as built by EPSFBuilder):
    the native-pixel flux fraction of a pixel whose centre is offset (u, v) native pixels from the
    source is 25 x EPSF at array index (c + 5 v, c + 5 u), c = 16 (array centre; the flux centroid of
    the arrays is within 0.06 native px of it). A native stamp sampled this way sums to about 1. Checked
    on real stars (G 12.5 to 14, unsaturated, 26 to 32 per detector, Barnard visit 0): least-squares fits
    with this reading have a lower chi2 than with the alternative reading (array = oversampled image,
    native pixel = sum of a 5 x 5 block) for 83 to 100 percent of the stars on every detector.
  * DETCOORD = 'sky' ("MWIR pixels flipped on X to match SWIR view"): the Level 2 images of all six
    detectors have the same WCS parity, i.e. they are already in that view, and the zone CWAVE matches
    the calibration CWAVE at (XCENTER, YCENTER) unmirrored (D4: median |diff| 0.0000 um against 0.0017 um
    mirrored). Real-star fits on D4 to D6 prefer the arrays as stored over x-flipped ones (77 to 100
    percent of stars). So arrays and zone centres are used as stored, for every detector.
"""
from __future__ import annotations

import hashlib
import io as _io
from functools import lru_cache

import numpy as np

from .config import DATA

EPSF_DIR = DATA / "epsf"
PHASEC_DIR = DATA / "phasec"
PIXEL_ARCSEC_NOMINAL = 6.15
NPIX_DET = 2040
MWIR = (4, 5, 6)

# Sonora Bobcat (Marley et al. 2021, ApJ 920, 85; Zenodo doi:10.5281/zenodo.5063476, CC BY 4.0),
# solar metallicity, cloudless, Teff 650 K, g = 1000 m/s^2 (log g = 5).
SONORA_MEMBER = "sp_t650g1000nc_m0.0"
SONORA_DIR = PHASEC_DIR / "sonora_raw"
SPHEREX_R_SPLIT_UM = 3.8          # R ~ 40 below, ~ 120 above (smoothing resolution)


# ------------------------------------------------------------------ photometry units --
def ab_to_mjy(mag):
    """AB magnitude -> flux density in MJy (AB zero point 3631 Jy)."""
    return 3631.0e-6 * 10.0 ** (-0.4 * np.asarray(mag, float))


# ------------------------------------------------------------------ spectra --
def _sonora_path():
    for ext in ("", ".gz"):
        p = SONORA_DIR / (SONORA_MEMBER + ext)
        if p.exists():
            return p
    raise FileNotFoundError(f"{SONORA_MEMBER} not found in {SONORA_DIR}; see scripts/10_injection.py")


@lru_cache(maxsize=1)
def _browndwarf_smoothed():
    """Sonora spectrum (lam ascending, um) smoothed to SPHEREx resolution: Gaussian in ln(lam) with
    FWHM 1/R, R = 40 below 3.8 um and 120 above (two smoothed copies joined at 3.8 um).
    Returns (lam_um, fnu_relative) on a uniform ln(lam) grid from 0.6 to 5.2 um."""
    import gzip
    p = _sonora_path()
    opener = gzip.open if p.suffix == ".gz" else open
    with opener(p, "rt") as f:
        lines = f.read().splitlines()
    vals = []
    for ln in lines:
        parts = ln.split()
        if len(parts) < 2:
            continue
        try:
            vals.append((float(parts[0]), float(parts[1])))
        except ValueError:
            continue                      # header line(s)
    a = np.array(vals)
    lam, fnu = a[:, 0], a[:, 1]           # microns, erg/cm^2/s/Hz (wavelength descending in the file)
    o = np.argsort(lam)
    lam, fnu = lam[o], fnu[o]
    grid = np.exp(np.arange(np.log(0.6), np.log(5.2), 1.0 / 3000.0))   # dln(lam) = 1/3000
    # average the native spectrum into the ln grid bins (flux-conserving in F_nu per ln lam)
    edges = np.exp(np.log(grid) - 0.5 / 3000.0)
    edges = np.append(edges, grid[-1] * np.exp(0.5 / 3000.0))
    idx = np.digitize(lam, edges) - 1
    ok = (idx >= 0) & (idx < grid.size)
    s = np.bincount(idx[ok], weights=fnu[ok], minlength=grid.size)
    n = np.bincount(idx[ok], minlength=grid.size)
    f = np.where(n > 0, s / np.maximum(n, 1), np.nan)
    if np.any(np.isnan(f)):               # native sampling coarser than the grid somewhere: interpolate
        f = np.interp(np.log(grid), np.log(lam), fnu)

    def smooth(R):
        sig = (1.0 / R) / 2.3548 * 3000.0                  # sigma in grid steps
        half = int(np.ceil(5 * sig))
        k = np.exp(-0.5 * (np.arange(-half, half + 1) / sig) ** 2)
        k /= k.sum()
        pad = np.pad(f, half, mode="edge")
        return np.convolve(pad, k, mode="valid")

    sm = np.where(grid < SPHEREX_R_SPLIT_UM, smooth(40.0), smooth(120.0))
    return grid, sm


def load_spectrum(name, lam_um):
    """Relative F_nu at lam_um (any shape). 'flat': 1 everywhere (flat in AB). 'browndwarf': the Sonora
    Bobcat 650 K, log g 5 model smoothed to SPHEREx resolution, linear interpolation in ln(lam)."""
    lam = np.asarray(lam_um, float)
    if name == "flat":
        return np.ones_like(lam)
    if name == "browndwarf":
        g, s = _browndwarf_smoothed()
        return np.interp(np.log(lam), np.log(g), s, left=np.nan, right=np.nan)
    raise ValueError(f"unknown spectrum {name!r}")


def spectrum_mjy(name, lam_um, mag_ab, norm_lam_um=4.5):
    """F_nu in MJy at lam_um such that the AB magnitude at norm_lam_um is mag_ab."""
    rel = load_spectrum(name, lam_um)
    ref = load_spectrum(name, np.asarray(norm_lam_um, float))
    return ab_to_mjy(mag_ab) * rel / ref


# ------------------------------------------------------------------ ePSF --
def _index_row(field, obs_id, detector):
    from astropy.table import Table
    t = _index(field)
    m = (np.asarray(t["obs_id"]).astype(str) == str(obs_id)) & (np.asarray(t["detector"]) == int(detector))
    if not m.any():
        raise KeyError(f"{obs_id} D{detector} not in index_{field}.csv")
    r = t[np.nonzero(m)[0][0]]
    return str(r["s3_key"]), str(r["release"])


@lru_cache(maxsize=4)
def _index(field):
    from astropy.table import Table
    return Table.read(DATA / f"index_{field}.csv")


def fetch_epsf_hdu(s3_key):
    """Range-read the EPSF binary table HDU of one Level 2 file. Returns (BinTableHDU, md5 of EPSF col)."""
    from astropy.io import fits
    from . import io as wio
    lay = wio.get_layout(s3_key)
    e = [h for h in lay["hdus"] if h["name"] == "EPSF"][0]
    hlen = e["data_off"] - e["hdr_off"]
    raw, _ = wio.range_get(s3_key, e["hdr_off"], hlen + e["data_size"])
    body = raw + b"\0" * (wio._padded(e["data_size"]) - e["data_size"])
    hl = fits.open(_io.BytesIO(wio.prim_bytes() + body))
    hdu = hl[1]
    md5 = hashlib.md5(np.ascontiguousarray(hdu.data["EPSF"]).tobytes()).hexdigest()
    return hdu, md5


def _epsf_cache_path(detector, release):
    return EPSF_DIR / f"epsf_D{int(detector)}_{release}.npz"


@lru_cache(maxsize=24)
def _load_epsf_cached(detector, release):
    d = np.load(_epsf_cache_path(detector, release), allow_pickle=False)
    return {k: d[k] for k in d.files}


def get_epsf(field, obs_id, detector):
    """ePSF zone table for this exposure (cached per detector and release; the table is the same for
    every exposure, see module docstring). Returns dict:
      xcenter, ycenter (zone centres, 0-based detector pixels), epsf (n, 33, 33) float64 as stored
      (sums to 1 at oversampled sampling), oversampling (ovx, ovy), cwave, cband, md5 (raw EPSF column),
      detector, release, s3_key, flipped (always False, see module docstring).
    XCENTER/YCENTER of the file are taken as 0-based pixel coordinates (zone centres 48.07, 145.2, ...
    for 21 zones over 2040 px; the 0/1-based ambiguity is 1 px, irrelevant for picking a zone)."""
    s3_key, release = _index_row(field, obs_id, detector)
    p = _epsf_cache_path(detector, release)
    if not p.exists():
        hdu, md5 = fetch_epsf_hdu(s3_key)
        d = hdu.data
        h = hdu.header
        EPSF_DIR.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            p, binx=np.asarray(d["BINX"]), biny=np.asarray(d["BINY"]),
            xcenter_raw=np.asarray(d["XCENTER"], float), ycenter_raw=np.asarray(d["YCENTER"], float),
            xwidth=np.asarray(d["XWIDTH"], float), ywidth=np.asarray(d["YWIDTH"], float),
            nstar=np.asarray(d["NSTAR"]), cwave=np.asarray(d["CWAVE"], float), cband=np.asarray(d["CBAND"], float),
            epsf_raw=np.asarray(d["EPSF"], float), ovx=int(h["OVSMPX"]), ovy=int(h["OVSMPY"]),
            detcoord=str(h.get("DETCOORD", "")), md5=md5, s3_key=s3_key,
            calfile=str([c for c in h.get("HISTORY", []) if "Calibration source" in str(c)][-1:]))
    raw = _load_epsf_cached(int(detector), release)
    det = int(detector)
    return dict(xcenter=raw["xcenter_raw"], ycenter=raw["ycenter_raw"], epsf=raw["epsf_raw"],
                oversampling=(int(raw["ovx"]), int(raw["ovy"])), cwave=raw["cwave"], cband=raw["cband"],
                md5=str(raw["md5"]), detector=det, release=release, s3_key=str(raw["s3_key"]), flipped=False)


def nearest_zone(epsf_rows, x_det, y_det):
    d2 = (epsf_rows["xcenter"] - x_det) ** 2 + (epsf_rows["ycenter"] - y_det) ** 2
    return int(np.argmin(d2))


def psf_stamp(epsf_rows, x_det, y_det, dx, dy, size=15):
    """Native-pixel stamp (size x size, [y, x]) of a unit-flux point source, ePSF zone nearest to
    detector pixel (x_det, y_det). The source sits at (c + dx, c + dy) in stamp pixels, c = size // 2,
    with dx, dy the sub-pixel offset (any float; normally in [-0.5, 0.5]). Each pixel value is the ePSF
    at the pixel-centre offset times ovx*ovy (cubic spline interpolation of the 5x oversampled array,
    which sums to 1 at oversampled sampling), so the stamp sums to the fraction of the flux falling in
    it (pixels beyond the ePSF support, +-3.3 native px, get 0)."""
    from scipy.ndimage import map_coordinates
    k = nearest_zone(epsf_rows, x_det, y_det)
    ep = _prefiltered(id(epsf_rows["epsf"]), epsf_rows["epsf"], k)
    ovx, ovy = epsf_rows["oversampling"]
    ny_o, nx_o = epsf_rows["epsf"].shape[1:]
    cy, cx = (ny_o - 1) / 2.0, (nx_o - 1) / 2.0
    c = size // 2
    jj, ii = np.mgrid[0:size, 0:size]
    u = ii - (c + dx)                    # pixel-centre offset from the source, native px
    v = jj - (c + dy)
    yo = cy + ovy * v
    xo = cx + ovx * u
    val = map_coordinates(ep, [yo.ravel(), xo.ravel()], order=3, mode="constant", cval=0.0,
                          prefilter=False).reshape(size, size)
    inside = (yo >= 0) & (yo <= ny_o - 1) & (xo >= 0) & (xo <= nx_o - 1)
    return np.where(inside, val, 0.0) * (ovx * ovy)


_PF_CACHE = {}


def _prefiltered(key, arr, k):
    from scipy.ndimage import spline_filter
    ck = (key, k)
    if ck not in _PF_CACHE:
        if len(_PF_CACHE) > 4000:
            _PF_CACHE.clear()
        _PF_CACHE[ck] = spline_filter(np.asarray(arr[k], float), order=3, mode="constant")
    return _PF_CACHE[ck]


# ------------------------------------------------------------------ noise model --
def fit_k(image, var, flags, nbins=30):
    """Photon-noise gain k from VARIANCE = a + k IMAGE on unflagged pixels (FLAGS == 0, finite, var > 0).
    Robust: median VARIANCE in IMAGE quantile bins (equal counts, 1st to 99.5th percentile), then a
    straight-line least-squares fit to the bin medians. Returns dict(k, a, n, curvature, rms_frac):
    curvature = quadratic coefficient of a parabola through the bins relative to k / (IMAGE range),
    rms_frac = rms of the linear-fit residuals over the median VARIANCE (linearity diagnostics)."""
    im = np.asarray(image, float).ravel()
    v = np.asarray(var, float).ravel()
    fl = np.asarray(flags).ravel()
    m = (fl == 0) & np.isfinite(im) & np.isfinite(v) & (v > 0)
    im, v = im[m], v[m]
    lo, hi = np.percentile(im, [1.0, 99.5])
    s = (im >= lo) & (im <= hi)
    im, v = im[s], v[s]
    q = np.quantile(im, np.linspace(0, 1, nbins + 1))
    b = np.clip(np.searchsorted(q, im, side="right") - 1, 0, nbins - 1)
    xm = np.array([np.median(im[b == i]) for i in range(nbins)])
    ym = np.array([np.median(v[b == i]) for i in range(nbins)])
    k, a = np.polyfit(xm, ym, 1)
    c2 = np.polyfit(xm, ym, 2)
    span = xm.max() - xm.min()
    curv = float(c2[0] * span / k) if k != 0 else np.nan     # fractional change of slope over the range
    rms = float(np.sqrt(np.mean((ym - (a + k * xm)) ** 2)) / np.median(ym))
    return dict(k=float(k), a=float(a), n=int(im.size), curvature=curv, rms_frac=rms,
                image_range=(float(xm.min()), float(xm.max())))


def pixel_solid_angle_sr(wcs):
    """Nominal pixel solid angle (pixel scale from the WCS at the reference pixel)^2 in sr. The archive's
    solid_angle_pixel_map product would give a per-pixel refinement; not used."""
    from astropy.wcs.utils import proj_plane_pixel_area
    return float(proj_plane_pixel_area(wcs.celestial)) * (np.pi / 180.0) ** 2


# ------------------------------------------------------------------ injection --
def inject_point(cutout_hdul_arrays, wcs, ra, dec, flux_mjy, epsf_rows, x0y0, rng, *, size=15, k=None,
                 omega_sr=None, return_info=False):
    """Add a point source of flux density flux_mjy (MJy) at (ra, dec) to a cutout.

    cutout_hdul_arrays: dict with 'IMAGE' (or 'image'), 'VARIANCE' (or 'var'), 'FLAGS' (or 'flags')
    2-D arrays of the cutout (IMAGE not zodi-subtracted), or a sequence (image, flags, variance) in the
    cutout HDU order [1], [2], [3]. wcs: the cutout's spatial WCS (CRPIX already shifted by X0, Y0).
    x0y0: (X0, Y0). rng: numpy Generator for the photon noise. k: photon-noise gain (fitted with fit_k
    when None). omega_sr: pixel solid angle (nominal, from the WCS when None).

    signal [MJy/sr] = flux_mjy * psf_fraction / omega_sr; noise ~ N(0, k * signal) per pixel; VARIANCE
    gets + k * signal. Only a size x size window around the source changes. Returns copies
    (image_new, var_new) [and an info dict with x, y, window, signal stamp when return_info]."""
    image, var, flags = _unpack(cutout_hdul_arrays)
    if k is None:
        k = fit_k(image, var, flags)["k"]
    if omega_sr is None:
        omega_sr = pixel_solid_angle_sr(wcs)
    x, y = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
    img_new = np.array(image, dtype=float, copy=True)
    var_new = np.array(var, dtype=float, copy=True)
    sig, (ys, xs) = signal_stamp(x, y, flux_mjy, epsf_rows, x0y0, omega_sr, size=size)
    ny, nx = img_new.shape
    y0, y1 = max(0, ys.start), min(ny, ys.stop)
    x0, x1 = max(0, xs.start), min(nx, xs.stop)
    if y1 > y0 and x1 > x0:
        s = sig[y0 - ys.start:y1 - ys.start, x0 - xs.start:x1 - xs.start]
        noise = rng.normal(0.0, 1.0, s.shape) * np.sqrt(np.clip(k * s, 0.0, None))
        img_new[y0:y1, x0:x1] += s + noise
        var_new[y0:y1, x0:x1] += np.clip(k * s, 0.0, None)
    if return_info:
        return img_new, var_new, dict(x=x, y=y, k=k, omega_sr=omega_sr, window=(ys, xs), signal=sig)
    return img_new, var_new


def signal_stamp(x, y, flux_mjy, epsf_rows, x0y0, omega_sr, size=15):
    """Noise-free injected signal (MJy/sr) in a size x size window centred on the nearest pixel to
    cutout position (x, y). Returns (stamp, (yslice, xslice)) in cutout pixel coordinates."""
    xi, yi = int(np.rint(x)), int(np.rint(y))
    c = size // 2
    st = psf_stamp(epsf_rows, x + x0y0[0], y + x0y0[1], x - xi, y - yi, size=size)
    return flux_mjy * st / omega_sr, (slice(yi - c, yi - c + size), slice(xi - c, xi - c + size))


def _unpack(a):
    if isinstance(a, dict):
        g = lambda *ks: next(a[k] for k in ks if k in a)          # noqa: E731
        return g("IMAGE", "image"), g("VARIANCE", "var", "V"), g("FLAGS", "flags", "FL")
    image, flags, var = a[0], a[1], a[2]
    return image, var, flags
