import { Observer, Horizon, Rotation_EQJ_EQD, RotateVector, VectorFromSphere, Spherical, EquatorFromVector, MakeTime } from 'astronomy-engine';
import { eqjToWorld, radecToVec, worldToAltAz, riseInfo, sunAltitude } from '../astro.ts';

const cases = [
  { name: 'Chicago', lat: 41.8781, lon: -87.6298, when: '2026-11-15T03:00:00Z' },
  { name: 'Mauna Kea', lat: 19.8207, lon: -155.4681, when: '2026-11-14T10:00:00Z' },
  { name: 'Cerro Pachon', lat: -30.2407, lon: -70.7366, when: '2026-11-15T06:00:00Z' },
];
const stars = [
  { name: 'Vega', ra: 279.2347, dec: 38.7837 },
  { name: 'Sirius', ra: 101.2872, dec: -16.7161 },
];

function independent(star, c, date) {
  const obs = new Observer(c.lat, c.lon, 0);
  const sph = new Spherical(star.dec, star.ra, 1);
  const v = VectorFromSphere(sph, MakeTime(date));
  const vd = RotateVector(Rotation_EQJ_EQD(date), v);
  const eq = EquatorFromVector(vd);
  const h = Horizon(date, obs, eq.ra, eq.dec, null);
  return { alt: h.altitude, az: h.azimuth };
}

function sepArcsec(a, b) {
  const d2r = Math.PI / 180;
  const c = Math.sin(a.alt * d2r) * Math.sin(b.alt * d2r) + Math.cos(a.alt * d2r) * Math.cos(b.alt * d2r) * Math.cos((a.az - b.az) * d2r);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 3600) / d2r;
}

let worst = 0;
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('place', 14) + pad('star', 8) + pad('mine alt/az', 22) + pad('astronomy-engine alt/az', 26) + 'diff arcsec');
for (const c of cases) {
  const date = new Date(c.when);
  const m = eqjToWorld(date, c);
  for (const s of stars) {
    const w = radecToVec(s.ra, s.dec).applyMatrix4(m);
    const mine = worldToAltAz(w);
    const ref = independent(s, c, date);
    const d = sepArcsec(mine, ref);
    worst = Math.max(worst, d);
    console.log(
      pad(c.name, 14) + pad(s.name, 8) +
      pad(mine.alt.toFixed(4) + ' / ' + mine.az.toFixed(4), 22) +
      pad(ref.alt.toFixed(4) + ' / ' + ref.az.toFixed(4), 26) +
      d.toFixed(2),
    );
  }
}

const chi = cases[0];
const pol = { ra: 37.9546, dec: 89.2641 };
const pw = radecToVec(pol.ra, pol.dec).applyMatrix4(eqjToWorld(new Date(chi.when), chi));
console.log('Polaris altitude at Chicago: ' + worldToAltAz(pw).alt.toFixed(3) + ' deg vs latitude ' + chi.lat + ' deg');

for (const c of cases) {
  const date = new Date(c.when);
  const vi = riseInfo(stars[0], c, date);
  const si = riseInfo(stars[1], c, date);
  console.log(c.name + ' riseInfo Vega ' + JSON.stringify(vi) + ' Sirius ' + JSON.stringify(si) + ' sunAlt ' + sunAltitude(c, date).toFixed(2));
}

const ok = worst < 60;
console.log('worst difference ' + worst.toFixed(2) + ' arcsec -> ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
