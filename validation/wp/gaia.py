"""Gaia DR3 reference catalogue for the registration check.

query_field(field)  -> astropy Table cached at data/gaia_<field>.ecsv
propagate(gaia, mjd) -> (ra_deg, dec_deg, has_pm) at the given epoch

Propagation model (Gaia DR3 reference epoch J2016.0 = MJD 57388.5 TDB):
  u(t) = r0 + dt * (pmra* p + pmdec q) - parallax * E(t)
with r0 the unit vector at 2016.0, (p, q) the local east/north unit vectors, dt in Julian
years, pm and parallax in radians(/yr), and E(t) Earth's barycentric position in au
(astropy get_body_barycentric). u is then normalised. Radial velocity / perspective
acceleration is ignored (sub-mas for field stars over ~10 yr). SPHEREx is in low Earth
orbit (~7000 km from the geocentre = 5e-5 au), so using Earth's position is good to
<< 1 mas for any star with parallax < 20 mas.

Stars without a 5/6-parameter solution (pmra/pmdec/parallax NaN) are propagated with zero
proper motion and zero parallax; has_pm=False flags them.
"""
from __future__ import annotations

import numpy as np
from astropy.table import Table
from astropy.time import Time
import astropy.units as u

from .config import DATA, FIELDS

GAIA_EPOCH_MJD = 57388.5          # J2016.0 (JD 2457389.0), TDB
JULIAN_YEAR_D = 365.25
MAS2RAD = np.pi / 180.0 / 3.6e6

COLUMNS = ["source_id", "ra", "dec", "ra_error", "dec_error", "pmra", "pmdec",
           "pmra_error", "pmdec_error", "parallax", "phot_g_mean_mag", "bp_rp", "ruwe"]

# Query radius covers a 320x320 px cutout at 6.15"/px (half diagonal 0.387 deg) plus
# 3 arcmin of margin for the bright-star isolation test and the motion of Barnard's Star
# since J2000 (~4.5 arcmin).
QUERY_RADIUS_DEG = 0.50
# Catalogue magnitude limit. The task asks for G < 18; we go to G < 19.5 so that the
# neighbour test (no source with G < G_star + 3 within 20") is complete for the faintest
# reference stars (G_star = 16.5). Reference stars themselves are cut at G <= 16.5 later.
QUERY_GMAX = 19.5


def gaia_path(field: str):
    return DATA / f"gaia_{field}.ecsv"


def query_field(field: str, radius_deg: float = QUERY_RADIUS_DEG, gmax: float = QUERY_GMAX,
                refresh: bool = False) -> Table:
    """Cone query of gaiadr3.gaia_source around the field centre (anonymous TAP), cached."""
    path = gaia_path(field)
    if path.exists() and not refresh:
        t = Table.read(path)
        if t.meta.get("radius_deg", 0) >= radius_deg and t.meta.get("gmax", 0) >= gmax:
            return t
    # Synchronous anonymous TAP POST with requests (certifi CA bundle). astroquery's async client
    # fails the ESA TLS chain on the python.org framework build and hung in job polling.
    import io
    import requests
    from .config import USER_AGENT
    f = FIELDS[field]
    adql = (
        f"SELECT {', '.join(COLUMNS)} FROM gaiadr3.gaia_source "
        f"WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {f['ra']}, {f['dec']}, {radius_deg})) "
        f"AND phot_g_mean_mag < {gmax}"
    )
    resp = requests.post("https://gea.esac.esa.int/tap-server/tap/sync", timeout=600,
                         data=dict(REQUEST="doQuery", LANG="ADQL", FORMAT="votable", QUERY=adql),
                         headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    t = Table.read(io.BytesIO(resp.content), format="votable")
    t = Table(t, masked=False)
    keep = Table()
    lower = {n.lower(): n for n in t.colnames}
    for c in COLUMNS:
        col = t[lower[c]]
        if hasattr(col, "filled"):
            col = col.filled(np.nan) if col.dtype.kind == "f" else col.filled(0)
        keep[c] = np.asarray(col)
    keep.meta.update({"field": field, "ra_c": f["ra"], "dec_c": f["dec"], "radius_deg": radius_deg,
                      "gmax": gmax, "table": "gaiadr3.gaia_source", "adql": adql,
                      "retrieved_utc": Time.now().isot})
    path.parent.mkdir(parents=True, exist_ok=True)
    keep.write(path, overwrite=True)
    return keep


def earth_bary_au(mjd) -> np.ndarray:
    """Earth's barycentric ICRS position in au, shape (3,) or (N,3)."""
    from astropy.coordinates import get_body_barycentric
    t = Time(np.atleast_1d(mjd), format="mjd", scale="tdb")
    pos = get_body_barycentric("earth", t)
    xyz = pos.xyz.to_value(u.au).T     # (N,3)
    return xyz[0] if np.ndim(mjd) == 0 else xyz


def propagate(gaia: Table, mjd: float, parallax: bool = True):
    """Apparent (astrometric, barycentric-ICRS-axes, as seen from Earth) RA/Dec at `mjd`.

    Returns (ra_deg, dec_deg, has_pm). Aberration is NOT applied: SPHEREx WCS solutions are
    fit against catalogue positions, so the WCS is in the same (astrometric) frame.
    """
    ra0 = np.deg2rad(np.asarray(gaia["ra"], float))
    de0 = np.deg2rad(np.asarray(gaia["dec"], float))
    pmra = np.asarray(gaia["pmra"], float)
    pmde = np.asarray(gaia["pmdec"], float)
    plx = np.asarray(gaia["parallax"], float)
    has_pm = np.isfinite(pmra) & np.isfinite(pmde)
    pmra = np.where(has_pm, pmra, 0.0) * MAS2RAD
    pmde = np.where(has_pm, pmde, 0.0) * MAS2RAD
    plx = np.where(np.isfinite(plx), plx, 0.0) * MAS2RAD
    dt = (float(mjd) - GAIA_EPOCH_MJD) / JULIAN_YEAR_D

    ca, sa, cd, sd = np.cos(ra0), np.sin(ra0), np.cos(de0), np.sin(de0)
    r = np.stack([cd * ca, cd * sa, sd], axis=-1)
    p = np.stack([-sa, ca, np.zeros_like(ra0)], axis=-1)
    q = np.stack([-sd * ca, -sd * sa, cd], axis=-1)
    uvec = r + dt * (pmra[:, None] * p + pmde[:, None] * q)
    if parallax:
        E = earth_bary_au(float(mjd))
        uvec = uvec - plx[:, None] * E[None, :]
    uvec /= np.linalg.norm(uvec, axis=1)[:, None]
    ra = np.rad2deg(np.arctan2(uvec[:, 1], uvec[:, 0])) % 360.0
    dec = np.rad2deg(np.arcsin(np.clip(uvec[:, 2], -1, 1)))
    return ra, dec, has_pm


def check_propagation(gaia: Table, mjd: float, verbose: bool = True) -> dict:
    """Independent check on one star: proper motion only vs SkyCoord.apply_space_motion,
    and the parallax term vs the closed-form parallax factors."""
    from astropy.coordinates import SkyCoord
    g = np.asarray(gaia["phot_g_mean_mag"])
    ok = np.isfinite(np.asarray(gaia["pmra"], float)) & (np.asarray(gaia["parallax"], float) > 0)
    # the highest proper-motion star with a positive parallax makes the most sensitive test
    pmtot = np.hypot(np.asarray(gaia["pmra"], float), np.asarray(gaia["pmdec"], float))
    i = int(np.nanargmax(np.where(ok & (g < 18), pmtot, -1)))
    row = gaia[i:i + 1]
    ra_pm, de_pm, _ = propagate(row, mjd, parallax=False)
    ra_all, de_all, _ = propagate(row, mjd, parallax=True)
    c0 = SkyCoord(ra=row["ra"][0] * u.deg, dec=row["dec"][0] * u.deg,
                  pm_ra_cosdec=row["pmra"][0] * u.mas / u.yr, pm_dec=row["pmdec"][0] * u.mas / u.yr,
                  distance=(1000.0 / row["parallax"][0]) * u.pc, radial_velocity=0 * u.km / u.s,
                  obstime=Time(2016.0, format="jyear", scale="tdb"), frame="icrs")
    c1 = c0.apply_space_motion(new_obstime=Time(mjd, format="mjd", scale="tdb"))
    cosd = np.cos(np.deg2rad(row["dec"][0]))
    d_pm = ((ra_pm[0] - c1.ra.deg) * cosd * 3.6e6, (de_pm[0] - c1.dec.deg) * 3.6e6)
    # closed-form parallax factors (Green 1985): dRA* = plx (X sin a - Y cos a),
    # dDec = plx (X cos a sin d + Y sin a sin d - Z cos d), X,Y,Z = Earth bary position (au)
    E = earth_bary_au(float(mjd))
    a, d = np.deg2rad(ra_pm[0]), np.deg2rad(de_pm[0])
    plx = row["parallax"][0]
    exp_dra = plx * (E[0] * np.sin(a) - E[1] * np.cos(a))
    exp_dde = plx * (E[0] * np.cos(a) * np.sin(d) + E[1] * np.sin(a) * np.sin(d) - E[2] * np.cos(d))
    got_dra = (ra_all[0] - ra_pm[0]) * np.cos(d) * 3.6e6
    got_dde = (de_all[0] - de_pm[0]) * 3.6e6
    out = {"source_id": int(row["source_id"][0]), "G": float(g[i]), "pmra": float(row["pmra"][0]),
           "pmdec": float(row["pmdec"][0]), "parallax": float(plx), "mjd": float(mjd),
           "pm_diff_mas": d_pm, "plx_term_mas": (float(got_dra), float(got_dde)),
           "plx_expected_mas": (float(exp_dra), float(exp_dde))}
    if verbose:
        print(f"  Propagation check, Gaia DR3 {out['source_id']} (G={out['G']:.2f}, "
              f"pm=({out['pmra']:.1f},{out['pmdec']:.1f}) mas/yr, plx={plx:.2f} mas) to MJD {mjd:.4f}:")
        print(f"    PM-only: ours - SkyCoord.apply_space_motion = dRA* {d_pm[0]:+.4f} mas, dDec {d_pm[1]:+.4f} mas")
        print(f"    parallax term: ours ({got_dra:+.3f}, {got_dde:+.3f}) mas vs parallax-factor formula "
              f"({exp_dra:+.3f}, {exp_dde:+.3f}) mas")
    return out
