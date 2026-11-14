import { describe, expect, it, vi } from 'vitest';
import type { Frame, Grid, MovieFrame } from '../data';

vi.hoisted(() => {
  (globalThis as { location?: unknown }).location = { search: '' };
});

import {
  describeSource,
  hitTest,
  MASK_BAD_BITS,
  maskFor,
  projectSources,
  sourcesFromGaia,
  sourcesFromWise,
  type OverlaySource,
} from './overlays';
import { ADVISORY_MASK, BAD_DATA_MASK } from '../data';

const grid: Grid = { ra0: 150, dec0: 20, w: 101, h: 101, scaleArcsec: 6.2, epochMjd: 57388 };
const EPOCH_MJD = 51544.5 + 16 * 365.25;

const base: OverlaySource = {
  kind: 'gaia',
  id: '1',
  ra: 150,
  dec: 20,
  pmra: 0,
  pmdec: 0,
  epochYear: 2016,
  mag: 10,
  magLabel: 'G 10.0',
};

describe('projectSources', () => {
  it('moves north (y decreases) as time passes with positive pmdec', () => {
    const s = { ...base, pmdec: 3000 };
    const a = projectSources([s], grid, EPOCH_MJD)[0];
    const b = projectSources([s], grid, EPOCH_MJD + 3 * 365.25)[0];
    expect(b.y).toBeLessThan(a.y);
    expect(b.x).toBeCloseTo(a.x, 3);
  });

  it('moves east (x decreases) with positive pmra', () => {
    const s = { ...base, pmra: 3000 };
    const a = projectSources([s], grid, EPOCH_MJD)[0];
    const b = projectSources([s], grid, EPOCH_MJD + 3 * 365.25)[0];
    expect(b.x).toBeLessThan(a.x);
    expect(b.y).toBeCloseTo(a.y, 3);
  });

  it('ignores proper motion for WISE sources', () => {
    const s: OverlaySource = { ...base, kind: 'wise', epochYear: 2015.4, pmdec: 3000, pmra: 3000 };
    const a = projectSources([s], grid, EPOCH_MJD)[0];
    const b = projectSources([s], grid, EPOCH_MJD + 3 * 365.25)[0];
    expect(b.y).toBeCloseTo(a.y, 6);
    expect(b.x).toBeCloseTo(a.x, 6);
  });

  it('drops sources well outside the grid', () => {
    const far = { ...base, ra: 151, dec: 21 };
    expect(projectSources([far], grid, EPOCH_MJD)).toHaveLength(0);
  });
});

describe('hitTest', () => {
  const pts = [
    { src: base, x: 10, y: 10 },
    { src: { ...base, id: '2' }, x: 12, y: 10 },
  ];
  it('finds the nearest source inside the radius', () => {
    expect(hitTest(pts, 11.6, 10, 2)?.src.id).toBe('2');
  });
  it('returns null outside the radius', () => {
    expect(hitTest(pts, 30, 30, 2)).toBeNull();
  });
});

describe('maskFor', () => {
  it('unions flags of member frames only', () => {
    const mk = (id: string, set: number[], bit = 2): Frame => {
      const flags = new Uint8Array(4);
      for (const i of set) flags[i] = bit;
      return { exposure: { id } as Frame['exposure'], flags, w: 2, h: 2 } as Frame;
    };
    const frames = [mk('a', [0]), mk('b', [3], 4), mk('c', [1]), mk('d', [2], 16)];
    const mf = { w: 2, h: 2, exposureIds: ['a', 'b', 'd'] } as MovieFrame;
    expect(Array.from(maskFor(mf, frames))).toEqual([1, 0, 0, 1]);
    expect(MASK_BAD_BITS).toBe(BAD_DATA_MASK);
    expect(Array.from(maskFor(mf, frames, ADVISORY_MASK))).toEqual([0, 0, 1, 0]);
  });
});

describe('source helpers', () => {
  it('labels and describes sources', () => {
    const g = sourcesFromGaia([
      { sourceId: '447', ra: 1, dec: 2, pmra: -801.6, pmdec: 10362.4, parallax: 1, gmag: 9.5 },
    ])[0];
    expect(g.epochYear).toBe(2016);
    expect(describeSource(g)).toBe('Gaia DR3 447. G 9.5. Proper motion -801.6, +10362.4 mas/yr.');
    const w = sourcesFromWise([
      { id: 'J0855', ra: 1, dec: 2, pmra: null, pmdec: null, w1mag: 17.3, w2mag: null },
    ])[0];
    expect(w.magLabel).toBe('W1 17.3');
    expect(describeSource(w)).toBe('CatWISE2020 J0855. W1 17.3. CatWISE2020 position, about 2015.');
  });
});
