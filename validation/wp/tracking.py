"""Distant-body geometry: parallax, a Keplerian heliocentric orbit, and the data seat's linear model.

Conventions (roundtable files 10 and 11, implemented exactly):
  apparent direction = normalize(D * u(t) - E(t))
    u(t)  heliocentric ICRS unit vector of the body, D in au,
    E(t)  Earth's HELIOCENTRIC position in au, ICRS equatorial axes
          = get_body_barycentric('earth') - get_body_barycentric('sun'),
    geocentric observer, no light-time, no aberration.
  linear heliocentric motion model:
    u(t) = normalize(u_ref + motion * (t - ref) / 365.25 d), motion = (dRA*cos dec, dDec) in
    arcsec/yr, tangent plane at u_ref (components along the east and north unit vectors).
  parallax offset = apparent minus heliocentric direction, (dRA*cos dec, dDec).

Orbit: circular, Kepler's third law (P[yr] = a[au]^1.5), prograde (angular momentum toward the north
ecliptic pole), inclination chosen so the body sits at the highest ecliptic latitude of its orbit at a
chosen epoch (so its apparent latitude can equal the field's, which an orbit in the ecliptic plane
could not reach for a field at +-28 or -40 deg ecliptic latitude).
"""
from __future__ import annotations

import numpy as np
from astropy.time import Time
import astropy.units as u

ARCSEC = np.pi / 180.0 / 3600.0
PIX_ARCSEC = 6.15
YEAR_D = 365.25
OBLIQUITY = np.deg2rad(23.4392911)       # mean obliquity J2000 (only defines OUR orbit's plane)


# ------------------------------------------------------------------ vectors -----------------
def radec_to_u(ra_deg, dec_deg):
    a, d = np.deg2rad(ra_deg), np.deg2rad(dec_deg)
    return np.stack([np.cos(d) * np.cos(a), np.cos(d) * np.sin(a), np.sin(d)], axis=-1)


def u_to_radec(v):
    v = np.asarray(v, float)
    n = np.linalg.norm(v, axis=-1)
    ra = np.rad2deg(np.arctan2(v[..., 1], v[..., 0])) % 360.0
    dec = np.rad2deg(np.arcsin(np.clip(v[..., 2] / n, -1, 1)))
    return ra, dec


def basis(ra_deg, dec_deg):
    """East and north unit vectors of the tangent plane at (ra, dec)."""
    a, d = np.deg2rad(ra_deg), np.deg2rad(dec_deg)
    e = np.stack([-np.sin(a), np.cos(a), np.zeros_like(a)], axis=-1)
    n = np.stack([-np.sin(d) * np.cos(a), -np.sin(d) * np.sin(a), np.cos(d)], axis=-1)
    return e, n


def tangent_offset_arcsec(ref_u, v):
    """(dRA*cos dec, dDec) in arcsec of direction(s) v relative to ref_u, gnomonic (tangent plane)."""
    ref_u = np.asarray(ref_u, float)
    ra, dec = u_to_radec(ref_u)
    e, n = basis(ra, dec)
    v = np.asarray(v, float)
    v = v / np.linalg.norm(v, axis=-1, keepdims=True)
    c = v @ ref_u
    return np.stack([(v @ e) / c, (v @ n) / c], axis=-1) / ARCSEC


def sph_offset_arcsec(ref_u, v):
    """(dRA*cos dec_ref, dDec) in arcsec as RA/Dec differences (the library's parallaxOffset
    convention; differs from the gnomonic offset at second order, ~1" at dec -57 for a 400" offset)."""
    ra0, de0 = u_to_radec(np.asarray(ref_u, float))
    ra1, de1 = u_to_radec(np.asarray(v, float))
    dra = (ra1 - ra0 + 540.0) % 360.0 - 180.0
    return np.stack([dra * np.cos(np.deg2rad(de0)), de1 - de0], axis=-1) * 3600.0


def add_tangent_offset(ref_u, off_arcsec):
    """Inverse of tangent_offset_arcsec: unit vector at tangent-plane offset (arcsec) from ref_u."""
    ref_u = np.asarray(ref_u, float)
    ra, dec = u_to_radec(ref_u)
    e, n = basis(ra, dec)
    off = np.asarray(off_arcsec, float) * ARCSEC
    v = ref_u + off[..., 0:1] * e + off[..., 1:2] * n
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


# ------------------------------------------------------------------ Earth -------------------
def earth_helio_au(mjd):
    """Earth's heliocentric position, ICRS axes, au. Shape (3,) for a scalar, (N,3) otherwise."""
    from astropy.coordinates import get_body_barycentric
    scalar = np.ndim(mjd) == 0
    t = Time(np.atleast_1d(np.asarray(mjd, float)), format="mjd", scale="tdb")
    e = get_body_barycentric("earth", t).xyz.to_value(u.au).T
    s = get_body_barycentric("sun", t).xyz.to_value(u.au).T
    r = e - s
    return r[0] if scalar else r


def sun_bary_au(mjd):
    from astropy.coordinates import get_body_barycentric
    t = Time(np.atleast_1d(np.asarray(mjd, float)), format="mjd", scale="tdb")
    return get_body_barycentric("sun", t).xyz.to_value(u.au).T


# ------------------------------------------------------------------ apparent position -------
def apparent_vec(u_helio, D, E):
    """normalize(D*u - E); u_helio (...,3) or (3,), E (...,3)."""
    v = D * np.asarray(u_helio, float) - np.asarray(E, float)
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def apparent_radec(u_helio, D, mjd):
    """Apparent (ra, dec) deg of a body with heliocentric direction u_helio at distance D au."""
    E = earth_helio_au(mjd)
    return u_to_radec(apparent_vec(u_helio, D, E))


def parallax_offset(u_helio, D, mjd):
    """apparent minus heliocentric, (dRA*cos dec, dDec) in DEGREES (the library's parallaxOffset)."""
    E = earth_helio_au(mjd)
    return sph_offset_arcsec(u_helio, apparent_vec(u_helio, D, E)) / 3600.0


def helio_from_apparent(a_vec, D, E):
    """Heliocentric unit vector u with normalize(D u - E) = a_vec (the nearer root, s > 0)."""
    a_vec = np.asarray(a_vec, float)
    a_vec = a_vec / np.linalg.norm(a_vec, axis=-1, keepdims=True)
    E = np.asarray(E, float)
    ea = np.sum(E * a_vec, axis=-1)
    disc = ea ** 2 - np.sum(E * E, axis=-1) + D ** 2
    s = -ea + np.sqrt(disc)
    w = E + s[..., None] * a_vec if np.ndim(s) else E + s * a_vec
    return w / np.linalg.norm(w, axis=-1, keepdims=True)


# ------------------------------------------------------------------ orbit -------------------
def kepler_period_yr(a_au):
    return float(a_au) ** 1.5


def ecl_to_eq(v):
    v = np.asarray(v, float)
    c, s = np.cos(OBLIQUITY), np.sin(OBLIQUITY)
    return np.stack([v[..., 0], v[..., 1] * c - v[..., 2] * s, v[..., 1] * s + v[..., 2] * c], axis=-1)


def eq_to_ecl(v):
    v = np.asarray(v, float)
    c, s = np.cos(OBLIQUITY), np.sin(OBLIQUITY)
    return np.stack([v[..., 0], v[..., 1] * c + v[..., 2] * s, -v[..., 1] * s + v[..., 2] * c], axis=-1)


class CircularOrbit:
    """Circular heliocentric orbit of radius a (au), prograde, with the body at u0 (heliocentric ICRS
    unit vector) at mjd0 and at the highest ecliptic latitude of its orbit there (inclination =
    |ecliptic latitude of u0|; motion at that moment is parallel to the ecliptic, eastward)."""

    def __init__(self, a_au, u0_eq, mjd0):
        self.a = float(a_au)
        self.mjd0 = float(mjd0)
        self.period_yr = kepler_period_yr(a_au)
        self.rate_arcsec_yr = 360.0 / self.period_yr * 3600.0
        self.n = 2 * np.pi / (self.period_yr * YEAR_D)            # rad per day
        u0e = eq_to_ecl(u0_eq)
        lam, beta = np.arctan2(u0e[1], u0e[0]), np.arcsin(u0e[2])
        self.ecl_lon_deg, self.ecl_lat_deg = np.rad2deg(lam), np.rad2deg(beta)
        self.inc_deg = abs(self.ecl_lat_deg)
        self._u0e = u0e
        self._te = np.array([-np.sin(lam), np.cos(lam), 0.0])     # eastward (increasing longitude)

    def u(self, mjd):
        phi = self.n * (np.asarray(mjd, float) - self.mjd0)
        ue = self._u0e * np.cos(phi)[..., None] + self._te * np.sin(phi)[..., None]
        return ecl_to_eq(ue)


def orbit_through(ra, dec, mjd0, D):
    """Orbit whose APPARENT position at mjd0 is (ra, dec) for a body at distance D."""
    a = radec_to_u(ra, dec)
    u0 = helio_from_apparent(a, D, earth_helio_au(mjd0))
    return CircularOrbit(D, u0, mjd0)


def orbit_centered(ra, dec, D, mjd_ref, mjds):
    """Orbit (apparent position at mjd_ref chosen) so that the body's apparent track over `mjds`
    is centred on the field centre (ra, dec): the midpoint of the min and max tangent-plane offsets
    (east, north) over all epochs is moved to the centre. Returns (orbit, shift_arcsec)."""
    c = radec_to_u(ra, dec)
    orb = orbit_through(ra, dec, mjd_ref, D)
    for _ in range(3):
        offs = np.array([tangent_offset_arcsec(c, apparent_vec(orb.u(m), D, earth_helio_au(m))) for m in mjds])
        mid = 0.5 * (offs.min(0) + offs.max(0))
        a_ref = add_tangent_offset(c, tangent_offset_arcsec(c, apparent_vec(orb.u(mjd_ref), D, earth_helio_au(mjd_ref))) - mid)
        ra2, dec2 = u_to_radec(a_ref)
        orb = orbit_through(ra2, dec2, mjd_ref, D)
    return orb


# ------------------------------------------------------------------ linear model ------------
def linear_model_u(u_ref, motion_arcsec_yr, mjd, ref_mjd):
    """The data seat's recovery model: u(t) = normalize(u_ref + motion*(t-ref)/365.25)."""
    t = (np.asarray(mjd, float) - ref_mjd) / YEAR_D
    off = np.asarray(motion_arcsec_yr, float)[None, :] * np.atleast_1d(t)[:, None]
    return add_tangent_offset(u_ref, off)


def fit_linear_motion(orbit, mjds, ref_mjd):
    """Least-squares (dRA*cos dec, dDec) arcsec/yr of the best linear model through the true track.
    Returns (motion, u_ref, residual_arcsec (N,2)); u_ref is the true direction at ref_mjd and the
    fit is unconstrained in slope (the model passes through u_ref at ref)."""
    mjds = np.asarray(mjds, float)
    u_ref = orbit.u(ref_mjd)
    off = tangent_offset_arcsec(u_ref, orbit.u(mjds))
    t = (mjds - ref_mjd) / YEAR_D
    m = (t[:, None] * off).sum(0) / (t ** 2).sum()
    res = off - t[:, None] * m[None, :]
    return m, u_ref, res


# ------------------------------------------------------------------ astropy cross-check -----
def astropy_parallax_offset(ra, dec, D, mjd):
    """Independent parallax: astropy SkyCoord at barycentric position P_b = D*u + S (S = Sun's
    barycentric position, so the body is the same physical body as ours), ICRS -> GCRS at mjd.
    Returns (offset_vs_barycentric_direction_arcsec (dRA*cos, dDec), gcrs apparent (ra, dec) deg,
    barycentric direction (ra, dec) deg). The offset is GCRS(distance D) minus GCRS(same direction at
    infinite distance), so astropy's aberration and light deflection cancel and only parallax stays."""
    from astropy.coordinates import SkyCoord, GCRS, CartesianRepresentation, ICRS
    t = Time(float(mjd), format="mjd", scale="tdb")
    uh = radec_to_u(ra, dec)
    Pb = D * uh + sun_bary_au(mjd)[0]
    dist = np.linalg.norm(Pb)
    rab, decb = u_to_radec(Pb)
    near = SkyCoord(ra=rab * u.deg, dec=decb * u.deg, distance=dist * u.au, frame="icrs")
    far = SkyCoord(ra=rab * u.deg, dec=decb * u.deg, frame="icrs")
    gn = near.transform_to(GCRS(obstime=t))
    gf = far.transform_to(GCRS(obstime=t))
    dra = (gn.ra.deg - gf.ra.deg + 540) % 360 - 180
    dra *= np.cos(np.deg2rad(gf.dec.deg)) * 3600.0
    ddec = (gn.dec.deg - gf.dec.deg) * 3600.0
    return np.array([dra, ddec]), (gn.ra.deg, gn.dec.deg), (rab, decb)


def crosscheck_vs_astropy(ra, dec, D, mjds):
    """Per epoch compare parallax offsets (arcsec, RA/Dec-difference convention):
      ours_helio   our offset, apparent minus HELIOCENTRIC direction (the library's definition)
      astropy_bary astropy GCRS(distance D) minus GCRS(infinity), same barycentric direction
      ours_bary    our apparent vector minus the BARYCENTRIC direction (same reference as astropy)
    d_earth = |ours_bary - astropy_bary| (Earth vector + frame handling), d_convention =
    |ours_helio - astropy_bary| (adds the heliocentric-vs-barycentric reference), d_ref = angle
    between heliocentric and barycentric direction of the body (the Sun's barycentric offset / D)."""
    uh = radec_to_u(ra, dec)
    out = dict(ours_helio=[], astropy_bary=[], ours_bary=[], ref_shift=[])
    for m in np.atleast_1d(mjds):
        E = earth_helio_au(m)
        app = apparent_vec(uh, D, E)
        ap, _, (rab, decb) = astropy_parallax_offset(ra, dec, D, m)
        ub = radec_to_u(rab, decb)
        out["ours_helio"].append(sph_offset_arcsec(uh, app))
        out["astropy_bary"].append(ap)
        out["ours_bary"].append(sph_offset_arcsec(ub, app))
        out["ref_shift"].append(sph_offset_arcsec(uh, ub))
    out = {k: np.array(v) for k, v in out.items()}
    out["d_earth"] = np.hypot(*(out["ours_bary"] - out["astropy_bary"]).T)
    out["d_convention"] = np.hypot(*(out["ours_helio"] - out["astropy_bary"]).T)
    out["d_ref"] = np.hypot(*out["ref_shift"].T)
    return out


def px_per_percent(u_helio, D, mjd_a, mjd_b, pct=1.0):
    """Shift (px) of the tracked position between two dates for a pct percent change of D
    (the library's trackingTolerance): |dP(D(1+pct/100)) - dP(D)|, dP = offset(mjd_b) - offset(mjd_a)."""
    def dP(d):
        pa = tangent_offset_arcsec(u_helio, apparent_vec(u_helio, d, earth_helio_au(mjd_a)))
        pb = tangent_offset_arcsec(u_helio, apparent_vec(u_helio, d, earth_helio_au(mjd_b)))
        return pb - pa
    return float(np.linalg.norm(dP(D * (1 + pct / 100)) - dP(D)) / PIX_ARCSEC)
