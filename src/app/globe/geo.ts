import * as Astronomy from 'astronomy-engine';
import { Vector3 } from 'three';

const RAD = Math.PI / 180;

export function latLonToVec(lat: number, lon: number, out = new Vector3()): Vector3 {
  const la = lat * RAD;
  const lo = lon * RAD;
  return out.set(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
}

export function vecToLatLon(v: Vector3): { lat: number; lon: number } {
  const n = v.clone().normalize();
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, n.y))) / RAD,
    lon: Math.atan2(-n.z, n.x) / RAD,
  };
}

export function localBasis(lat: number, lon: number): { up: Vector3; east: Vector3; north: Vector3 } {
  const lo = lon * RAD;
  const up = latLonToVec(lat, lon);
  const east = new Vector3(-Math.sin(lo), 0, -Math.cos(lo));
  const north = new Vector3().crossVectors(up, east).normalize();
  return { up, east, north };
}

export function subsolarPoint(date: Date): { lat: number; lon: number } {
  const eq = Astronomy.Equator(Astronomy.Body.Sun, date, new Astronomy.Observer(0, 0, 0), true, true);
  const gst = Astronomy.SiderealTime(date);
  let lon = (eq.ra - gst) * 15;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: eq.dec, lon };
}
