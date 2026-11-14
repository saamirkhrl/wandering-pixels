// Oracle: astropy 7 WCS on the IMAGE header of the real DR1 file
// dr1/level2/2025W35_2A/l2b-v27-2026-231/2/level2_2025W35_2A_0221_2D2_spx_l2b-v27-2026-231.fits
// (WCS cards copied verbatim, plus alternate-key cards that must be ignored).
import { describe, it, expect } from 'vitest';
import type { Header } from './fits';
import {
  parseWcs, pixToSky, skyToPix, julianYear, positionAt, makeGrid, worldToGrid, gridToWorld,
} from './wcs';
import type { Exposure, Target } from './types';

const HEADER: Header = {
  "CRPIX1": 1020.5,
  "CRPIX2": 1020.5,
  "PC1_1": 0.00170293449478,
  "PC1_2": -3.29309573172e-05,
  "PC2_1": -3.44627764295e-05,
  "PC2_2": -0.0017065735719,
  "CDELT1": 1.0,
  "CDELT2": 1.0,
  "CTYPE1": "RA---TAN-SIP",
  "CTYPE2": "DEC--TAN-SIP",
  "CRVAL1": 269.227103491,
  "CRVAL2": 4.43439836912,
  "LONPOLE": 180.0,
  "LATPOLE": 4.43439836912,
  "A_ORDER": 3,
  "A_0_0": 0.0426736948581,
  "A_0_1": -0.00046709260495,
  "A_0_2": -1.37128495227e-08,
  "A_0_3": -1.50954257089e-11,
  "A_1_0": -3.07808136871e-06,
  "A_1_1": 3.95788210611e-06,
  "A_1_2": 6.438756606e-10,
  "A_2_0": -3.21982288813e-08,
  "A_2_1": 2.60411608838e-11,
  "A_3_0": 5.39343280527e-10,
  "B_ORDER": 3,
  "B_0_0": -1.03935672145,
  "B_0_1": 0.000103427094364,
  "B_0_2": 1.94359072403e-06,
  "B_0_3": 4.61972138497e-10,
  "B_1_0": -8.50286352095e-05,
  "B_1_1": 3.13085379335e-08,
  "B_1_2": 5.81236619244e-12,
  "B_2_0": 6.52975136469e-06,
  "B_2_1": 5.99963240449e-10,
  "B_3_0": 1.96442776881e-11,
  "AP_ORDER": 3,
  "AP_0_0": -0.042195450269,
  "AP_0_1": 0.000467237260827,
  "AP_0_2": 1.08976214849e-08,
  "AP_0_3": 1.44538301528e-11,
  "AP_1_0": -1.92176900598e-06,
  "AP_1_1": -3.94039830512e-06,
  "AP_1_2": -6.18100882864e-10,
  "AP_2_0": 2.9031138501e-08,
  "AP_2_1": -2.74411982063e-11,
  "AP_3_0": -5.11722240689e-10,
  "BP_ORDER": 3,
  "BP_0_0": 1.0344056181,
  "BP_0_1": -0.000108251481877,
  "BP_0_2": -1.93118980179e-06,
  "BP_0_3": -4.52662899347e-10,
  "BP_1_0": 8.55147955875e-05,
  "BP_1_1": -3.75651914882e-08,
  "BP_1_2": -6.27763610561e-12,
  "BP_2_0": -6.51073738944e-06,
  "BP_2_1": -5.20944703289e-10,
  "BP_3_0": -1.98357290867e-11,
  "CRPIX1A": 1.0,
  "CRPIX2A": 1.0,
  "CTYPE1A": "LINEAR",
  "CTYPE2A": "LINEAR",
  "CRPIX1W": 1,
  "CTYPE1W": "WAVE-TAB"
};
// [x, y, ra, dec] from astropy WCS.all_pix2world(x, y, 0)
const ORACLE: [number, number, number, number][] = [
  [0, 0, 267.52131050769304, 6.194675598917658],
  [0, 1019.5, 267.48507941417125, 4.457578640273529],
  [0, 2039, 267.4465319609699, 2.713687048492625],
  [1019.5, 0, 269.2617354193768, 6.173038811188734],
  [1019.5, 1019.5, 269.2272107097331, 4.4361706371703065],
  [1019.5, 2039, 269.1926666034239, 2.692409929969271],
  [2039, 0, 271.00131511164625, 6.124791340349268],
  [2039, 1019.5, 270.96861454986845, 4.387527895782424],
  [2039, 2039, 270.93819143344314, 2.6433380380290705],
  [500, 0, 268.3751415727416, 6.187374124365664],
  [500, 1019.5, 268.33973019969653, 4.450467140608407],
  [500, 2039, 268.3031281806837, 2.7067095939384953],
  [1500, 0, 270.0815678974486, 6.153628139640678],
  [1500, 1019.5, 270.04789062917536, 4.416651275772912],
  [1500, 2039, 270.0152772955584, 2.672757847889841],
  [250.25, 0, 267.9487351575904, 6.191815552559503],
  [250.25, 1019.5, 267.91290991564154, 4.454832287451586],
  [250.25, 2039, 267.8753314428961, 2.7110245004710536],
  [1800.75, 0, 270.59473109050134, 6.138460424299688],
  [1800.75, 1019.5, 270.56159574424555, 4.401345014403325],
  [1800.75, 2039, 270.530201782403, 2.6573053002276006],
  [123.4, 1987.6, 267.65996831928345, 2.8006913736309533],
  [1999.9, 37.2, 270.93334629488476, 6.063846903650707],
];
const BARNARD_ASTROPY = {"ra": 269.4460710525247, "dec": 4.769414193037931};

const ARCSEC = 1 / 3600;

function sepArcsec(ra1: number, de1: number, ra2: number, de2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((de2 - de1) * r) / 2) ** 2 +
    Math.cos(de1 * r) * Math.cos(de2 * r) * Math.sin(((ra2 - ra1) * r) / 2) ** 2;
  return (2 * Math.asin(Math.sqrt(a))) / r * 3600;
}

describe('parseWcs + pixToSky / skyToPix vs astropy (real SPHEREx D2 header)', () => {
  const w = parseWcs(HEADER);

  it('reads the primary description, not the A / W alternates', () => {
    expect(w.crpix).toEqual([1020.5, 1020.5]);
    expect(w.crval).toEqual([269.227103491, 4.43439836912]);
    expect(w.lonpole).toBe(180);
    expect(w.a.length).toBe(4);
    expect(w.ap.length).toBe(4);
  });

  it('pixToSky matches all_pix2world within 1e-4 arcsec', () => {
    let max = 0;
    for (const [x, y, ra, dec] of ORACLE) {
      const s = pixToSky(w, x, y);
      max = Math.max(max, sepArcsec(s.ra, s.dec, ra, dec));
    }
    console.log(`pixToSky max |diff| vs astropy: ${max.toExponential(3)} arcsec`);
    expect(max).toBeLessThan(1e-4);
  });

  it('skyToPix matches the astropy pixel within 1e-3 px', () => {
    let max = 0;
    for (const [x, y, ra, dec] of ORACLE) {
      const [px, py] = skyToPix(w, ra, dec);
      max = Math.max(max, Math.hypot(px - x, py - y));
    }
    console.log(`skyToPix max |diff| vs astropy: ${max.toExponential(3)} px`);
    expect(max).toBeLessThan(1e-3);
  });

  it('forward(inverse(p)) round-trips to < 1e-6 px', () => {
    let max = 0;
    for (let x = -50; x <= 2090; x += 107) {
      for (let y = -50; y <= 2090; y += 113) {
        const s = pixToSky(w, x, y);
        const [px, py] = skyToPix(w, s.ra, s.dec);
        max = Math.max(max, Math.hypot(px - x, py - y));
      }
    }
    expect(max).toBeLessThan(1e-6);
  });

  it('pixel origin: x=0 is the centre of the first pixel (FITS p1 = 1)', () => {
    // CRPIX 1020.5 is 0-based 1019.5; there the SIP offset is the constant terms only.
    const c = pixToSky(w, 1019.5, 1019.5);
    const shifted = pixToSky(w, 1020.5, 1020.5);
    expect(sepArcsec(c.ra, c.dec, shifted.ra, shifted.dec)).toBeGreaterThan(5);
  });

  it('plain CD-matrix TAN without SIP inverts exactly', () => {
    const h: Header = {
      CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 50, CRPIX2: 60, CRVAL1: 10, CRVAL2: -30,
      CD1_1: -1e-3, CD1_2: 2e-5, CD2_1: 1e-5, CD2_2: 1e-3,
    };
    const v = parseWcs(h);
    const ref = pixToSky(v, 49, 59);
    expect(ref.ra).toBeCloseTo(10, 12);
    expect(ref.dec).toBeCloseTo(-30, 12);
    const s = pixToSky(v, 3.3, 97.1);
    const [x, y] = skyToPix(v, s.ra, s.dec);
    expect(x).toBeCloseTo(3.3, 7);
    expect(y).toBeCloseTo(97.1, 7);
  });

  it('rejects non-TAN headers', () => {
    expect(() => parseWcs({ CTYPE1: 'RA---SIN', CTYPE2: 'DEC--SIN', CRPIX1: 1, CRPIX2: 1, CRVAL1: 0, CRVAL2: 0 }))
      .toThrow();
  });
});

describe('time and proper motion', () => {
  it('julianYear', () => {
    expect(julianYear(51544.5)).toBe(2000);
    expect(julianYear(51544.5 + 365.25)).toBe(2001);
  });

  it("Barnard's Star at MJD 61273 matches astropy apply_space_motion", () => {
    const t: Target = { ra: 269.452, dec: 4.693, pmra: -798.58, pmdec: 10328.12 };
    const p = positionAt(t, 61273);
    const sep = sepArcsec(p.ra, p.dec, BARNARD_ASTROPY.ra, BARNARD_ASTROPY.dec);
    console.log(`Barnard positionAt vs astropy: ${sep.toExponential(3)} arcsec`);
    expect(sep).toBeLessThan(1e-3);
    // about 26.6 yr * 10.33 arcsec/yr = 274 arcsec north
    expect((p.dec - 4.693) * 3600).toBeGreaterThan(270);
    expect((p.dec - 4.693) * 3600).toBeLessThan(278);
  });

  it('no proper motion leaves the position unchanged; epoch is honoured', () => {
    expect(positionAt({ ra: 12, dec: 34 }, 61000)).toEqual({ ra: 12, dec: 34 });
    const t: Target = { ra: 100, dec: 20, pmra: 1000, pmdec: 0, epoch: 2016 };
    const p = positionAt(t, 51544.5 + 16 * 365.25);
    expect(p.ra).toBeCloseTo(100, 12);
    expect(p.dec).toBeCloseTo(20, 12);
  });
});

describe('grid', () => {
  const exp = (mjd: number): Exposure => ({
    id: `X${mjd}D2`, obsId: `X${mjd}`, detector: 2, time: '', mjd, visitIndex: 0,
    wavelengthAtTarget: null, bandwidthAtTarget: null, url: '', release: 'dr1',
  });
  const target: Target = { ra: 269.452, dec: 4.693, pmra: -798.58, pmdec: 10328.12 };

  it('makeGrid defaults: 65 x 65 at 6.15 arcsec, centred at the mean-epoch position', () => {
    const g = makeGrid(target, [exp(60900), exp(61100)]);
    expect(g.w).toBe(65);
    expect(g.h).toBe(65);
    expect(g.scaleArcsec).toBe(6.15);
    expect(g.epochMjd).toBe(61000);
    const c = positionAt(target, 61000);
    expect(g.ra0).toBe(c.ra);
    expect(g.dec0).toBe(c.dec);
    const [x, y] = worldToGrid(g, c.ra, c.dec);
    expect(x).toBeCloseTo(32, 12);
    expect(y).toBeCloseTo(32, 12);
  });

  it('no exposures: centre is the catalogue position at its epoch', () => {
    const g = makeGrid({ ...target, epoch: 2016 }, []);
    expect(julianYear(g.epochMjd)).toBeCloseTo(2016, 12);
    expect(g.ra0).toBeCloseTo(269.452, 12);
    expect(g.dec0).toBeCloseTo(4.693, 12);
  });

  it('orientation: north has smaller y, east has smaller x', () => {
    const g = makeGrid(target, [exp(61000)]);
    const cx = (g.w - 1) / 2, cy = (g.h - 1) / 2;
    const [nx, ny] = worldToGrid(g, g.ra0, g.dec0 + 60 * ARCSEC);
    expect(ny).toBeCloseTo(cy - 60 / 6.15, 4);
    expect(nx).toBeCloseTo(cx, 4);
    const [ex, ey] = worldToGrid(g, g.ra0 + (60 * ARCSEC) / Math.cos((g.dec0 * Math.PI) / 180), g.dec0);
    expect(ex).toBeCloseTo(cx - 60 / 6.15, 3);
    expect(ey).toBeCloseTo(cy, 3);
    // row 0 is the north edge, column 0 the east edge
    const corner = gridToWorld(g, 0, 0);
    expect(corner.dec).toBeGreaterThan(g.dec0);
    expect(corner.ra).toBeGreaterThan(g.ra0);
  });

  it('gridToWorld(worldToGrid(p)) round-trips', () => {
    const g = makeGrid({ ra: 359.99, dec: -89.5 }, [], 400, 6.15);
    for (const [x, y] of [[0, 0], [64, 0], [0, 64], [64, 64], [10.3, 51.7], [-20, 90]]) {
      const s = gridToWorld(g, x, y);
      const [bx, by] = worldToGrid(g, s.ra, s.dec);
      expect(Math.hypot(bx - x, by - y)).toBeLessThan(1e-9);
    }
  });

  it('bad scale throws', () => {
    expect(() => makeGrid(target, [], 400, 0)).toThrow();
  });
});
