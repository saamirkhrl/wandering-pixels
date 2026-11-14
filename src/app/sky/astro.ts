import { Matrix4, Vector3 } from 'three';
import { Body, Equator, Horizon, Observer, Rotation_EQJ_HOR } from 'astronomy-engine';

// Frames used across the sky view.
// EQJ: J2000 mean equator (ICRS for our purposes). Unit vector x toward RA 0 Dec 0,
//   y toward RA 90 Dec 0, z toward the north celestial pole.
// World (three.js scene of the sky view): observer at origin, X = east, Y = up (zenith),
//   Z = south. Right handed (east x up = south).

export interface Place {
  lat: number; // degrees, north positive
  lon: number; // degrees, east positive
}

export interface AltAz {
  alt: number; // degrees above the horizon
  az: number; // degrees from north through east, 0..360
}

export interface RaDec {
  ra: number; // degrees 0..360, J2000/ICRS
  dec: number; // degrees
}

export function radecToVec(ra: number, dec: number, out = new Vector3()): Vector3 {
  const r = (ra * Math.PI) / 180;
  const d = (dec * Math.PI) / 180;
  return out.set(Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d));
}

export function vecToRadec(v: Vector3): RaDec {
  const n = v.clone().normalize();
  let ra = (Math.atan2(n.y, n.x) * 180) / Math.PI;
  if (ra < 0) ra += 360;
  const dec = (Math.asin(Math.max(-1, Math.min(1, n.z))) * 180) / Math.PI;
  return { ra, dec };
}

export function altAzToWorld(alt: number, az: number, out = new Vector3()): Vector3 {
  const a = (alt * Math.PI) / 180;
  const z = (az * Math.PI) / 180;
  // north = -Z, east = +X, up = +Y
  return out.set(Math.cos(a) * Math.sin(z), Math.sin(a), -Math.cos(a) * Math.cos(z));
}

export function worldToAltAz(v: Vector3): AltAz {
  const n = v.clone().normalize();
  const alt = (Math.asin(Math.max(-1, Math.min(1, n.y))) * 180) / Math.PI;
  let az = (Math.atan2(n.x, -n.z) * 180) / Math.PI;
  if (az < 0) az += 360;
  return { alt, az };
}

// Matrix4 that maps an EQJ unit vector to the world frame for this place and time
// (precession and nutation included, refraction and aberration off).
// astronomy-engine rotations use rot[i][j] = contribution of source axis i to target axis j,
// so the usual matrix M (target = M * source) has M[j][i] = rot[i][j].
// HOR is x = north, y = west, z = zenith; world is X = east, Y = up, Z = south.
export function eqjToWorld(date: Date, place: Place, out = new Matrix4()): Matrix4 {
  const r = Rotation_EQJ_HOR(date, new Observer(place.lat, place.lon, 0)).rot;
  // world X = -y, Y = z, Z = -x
  return out.set(
    -r[0][1], -r[1][1], -r[2][1], 0,
    r[0][2], r[1][2], r[2][2], 0,
    -r[0][0], -r[1][0], -r[2][0], 0,
    0, 0, 0, 1,
  );
}

export type RiseState = 'up' | 'rises' | 'never' | 'circumpolar';

export interface RiseInfo {
  state: RiseState; // 'up' = above the horizon now (and not circumpolar)
  altNow: number;
  maxAlt: number; // altitude at upper culmination, degrees
  nextRise?: Date; // when state is 'rises'
}

const scratchM = new Matrix4();
const scratchV = new Vector3();

function altitudeAt(vec: Vector3, date: Date, place: Place): number {
  eqjToWorld(date, place, scratchM);
  scratchV.copy(vec).applyMatrix4(scratchM);
  return worldToAltAz(scratchV).alt;
}

export function riseInfo(target: RaDec, place: Place, date: Date): RiseInfo {
  const vec = radecToVec(target.ra, target.dec);
  const altNow = altitudeAt(vec, date, place);
  const maxAlt = 90 - Math.abs(place.lat - target.dec);
  const limit = 90 - Math.abs(place.lat);
  const sameHemisphere = target.dec * place.lat >= 0;
  if (sameHemisphere && Math.abs(target.dec) > limit) {
    return { state: 'circumpolar', altNow, maxAlt };
  }
  if (!sameHemisphere && Math.abs(target.dec) > limit) {
    return { state: 'never', altNow, maxAlt };
  }
  if (altNow > 0) return { state: 'up', altNow, maxAlt };

  const step = 10 * 60 * 1000;
  const t0 = date.getTime();
  let prevT = t0;
  let prevAlt = altNow;
  for (let k = 1; k <= 24 * 6 + 6; k++) {
    const t = t0 + k * step;
    const alt = altitudeAt(vec, new Date(t), place);
    if (prevAlt <= 0 && alt > 0) {
      let lo = prevT;
      let hi = t;
      while (hi - lo > 1000) {
        const mid = (lo + hi) / 2;
        if (altitudeAt(vec, new Date(mid), place) > 0) hi = mid;
        else lo = mid;
      }
      return { state: 'rises', altNow, maxAlt, nextRise: new Date(hi) };
    }
    prevT = t;
    prevAlt = alt;
  }
  return { state: 'rises', altNow, maxAlt };
}

// Sun altitude in degrees at this place and time, refraction off.
export function sunAltitude(place: Place, date: Date): number {
  const obs = new Observer(place.lat, place.lon, 0);
  const eq = Equator(Body.Sun, date, obs, true, true);
  return Horizon(date, obs, eq.ra, eq.dec, undefined).altitude;
}
