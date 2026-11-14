import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Exposure, Grid, Target, Detector, Frame } from './types';

vi.mock('./frame', () => ({ loadFrames: vi.fn() }));
import { loadFrames } from './frame';
import { loadFirstLook } from './firstlook';

const mocked = vi.mocked(loadFrames);
const target: Target = { ra: 10, dec: 20 };
const grid: Grid = { ra0: 10, dec0: 20, w: 5, h: 5, scaleArcsec: 6.15, epochMjd: 60000 };

function ex(id: string, detector: Detector, visitIndex: number, mjd: number, wl: number | null = 1.0, bw: number | null = null): Exposure {
  return { id, obsId: id, detector, time: '', mjd, visitIndex, wavelengthAtTarget: wl, bandwidthAtTarget: bw, url: 'u', release: 'dr1' };
}

/** Mock loader: succeeds for every exposure unless its id is in `fail`. */
function mockLoad(fail: string[] = []) {
  mocked.mockImplementation(async (exps: Exposure[]) => ({
    frames: exps.filter((e) => !fail.includes(e.id)).map((e) => ({ exposure: e }) as unknown as Frame),
    failed: exps.filter((e) => fail.includes(e.id)).map((e) => ({ exposure: e, error: { message: 'boom ' + e.id } as never })),
  }));
}
const ids = (r: { frames: Frame[] }) => r.frames.map((f) => f.exposure.id);

beforeEach(() => {
  mocked.mockReset();
});

describe('loadFirstLook detector choice', () => {
  it('picks the detector with most distinct visits', async () => {
    mockLoad();
    const exps = [ex('a1', 1, 0, 1), ex('a2', 1, 0, 1.1), ex('a3', 1, 0, 1.2), ex('b1', 3, 0, 2), ex('b2', 3, 1, 50)];
    const r = await loadFirstLook(target, exps, grid);
    expect(r.detector).toBe(3);
    expect(ids(r)).toEqual(['b1', 'b2']);
  });
  it('breaks visit ties by exposure count, then lowest number', async () => {
    mockLoad();
    const exps = [ex('a1', 2, 0, 1), ex('a2', 2, 1, 40), ex('b1', 4, 0, 1), ex('b2', 4, 1, 40), ex('b3', 4, 1, 40.1)];
    expect((await loadFirstLook(target, exps, grid)).detector).toBe(4);
    const eq = [ex('a1', 5, 0, 1), ex('a2', 5, 1, 40), ex('b1', 2, 0, 1), ex('b2', 2, 1, 40)];
    expect((await loadFirstLook(target, eq, grid)).detector).toBe(2);
  });
  it('honours an explicit detector', async () => {
    mockLoad();
    const exps = [ex('a1', 1, 0, 1), ex('a2', 1, 1, 40), ex('b1', 6, 0, 3)];
    const r = await loadFirstLook(target, exps, grid, { detector: 6 });
    expect(r.detector).toBe(6);
    expect(ids(r)).toEqual(['b1']);
  });
  it('throws NO_COVERAGE with no exposures on the detector', async () => {
    await expect(loadFirstLook(target, [], grid)).rejects.toMatchObject({ code: 'NO_COVERAGE' });
    await expect(loadFirstLook(target, [ex('a', 1, 0, 1)], grid, { detector: 2 })).rejects.toMatchObject({ code: 'NO_COVERAGE' });
  });
});

describe('loadFirstLook visit choice', () => {
  it('takes the first exposure by mjd of the earliest and latest visits', async () => {
    mockLoad();
    const exps = [
      ex('v1b', 2, 1, 130.2), ex('v1a', 2, 1, 130.1),
      ex('v0b', 2, 0, 10.5), ex('v0a', 2, 0, 10.0),
      ex('v2b', 2, 2, 250.3), ex('v2a', 2, 2, 250.0),
      ex('mid', 2, 3, 100),
    ];
    const r = await loadFirstLook(target, exps, grid);
    expect(ids(r)).toEqual(['v0a', 'v2a']);
    const call = mocked.mock.calls[0];
    expect(call[0].map((e) => e.id).sort()).toEqual(['v0a', 'v2a']);
  });
  it('passes target and options through', async () => {
    mockLoad();
    const signal = new AbortController().signal;
    const onProgress = () => {};
    await loadFirstLook(target, [ex('a', 1, 0, 1), ex('b', 1, 1, 50)], grid, { signal, onProgress, background: 'none', wavelengthMap: true, detector: 1 });
    const opts = mocked.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.target).toBe(target);
    expect(opts.signal).toBe(signal);
    expect(opts.onProgress).toBe(onProgress);
    expect(opts.background).toBe('none');
    expect(opts.wavelengthMap).toBe(true);
    expect('detector' in opts).toBe(false);
    expect(mocked.mock.calls[0][1]).toBe(grid);
  });
  it('uses one exposure when there is one visit', async () => {
    mockLoad();
    const r = await loadFirstLook(target, [ex('b', 1, 0, 2), ex('a', 1, 0, 1)], grid);
    expect(ids(r)).toEqual(['a']);
    expect(r.matched).toBe(false);
  });
  it('returns frames sorted by mjd', async () => {
    mocked.mockImplementation(async (exps: Exposure[]) => ({
      frames: [...exps].reverse().map((e) => ({ exposure: e }) as unknown as Frame), failed: [],
    }));
    const r = await loadFirstLook(target, [ex('a', 1, 0, 1), ex('b', 1, 1, 50)], grid);
    expect(ids(r)).toEqual(['a', 'b']);
  });
});

describe('loadFirstLook failures', () => {
  it('returns one frame when one load fails', async () => {
    mockLoad(['b']);
    const r = await loadFirstLook(target, [ex('a', 1, 0, 1), ex('b', 1, 1, 50)], grid);
    expect(ids(r)).toEqual(['a']);
    expect(r.matched).toBe(false);
  });
  it('throws NO_COVERAGE with the first failure message when all fail', async () => {
    mockLoad(['a', 'b']);
    await expect(loadFirstLook(target, [ex('a', 1, 0, 1), ex('b', 1, 1, 50)], grid)).rejects.toMatchObject({
      code: 'NO_COVERAGE',
      message: expect.stringContaining('boom'),
    });
  });
});

describe('loadFirstLook matched', () => {
  it('is true when wavelengths differ by less than the mean bandwidth (channelBandwidth fallback)', async () => {
    mockLoad();
    // detector 2: R=41, bw ~ 0.0244 at 1.0 um
    const r = await loadFirstLook(target, [ex('a', 2, 0, 1, 1.0), ex('b', 2, 1, 50, 1.02)], grid);
    expect(r.matched).toBe(true);
  });
  it('is false when the gap exceeds the bandwidth', async () => {
    mockLoad();
    const r = await loadFirstLook(target, [ex('a', 2, 0, 1, 1.0), ex('b', 2, 1, 50, 1.05)], grid);
    expect(r.matched).toBe(false);
  });
  it('prefers bandwidthAtTarget when finite', async () => {
    mockLoad();
    const wide = await loadFirstLook(target, [ex('a', 2, 0, 1, 1.0, 0.2), ex('b', 2, 1, 50, 1.1, 0.2)], grid);
    expect(wide.matched).toBe(true);
    const narrow = await loadFirstLook(target, [ex('a', 2, 0, 1, 1.0, 0.01), ex('b', 2, 1, 50, 1.02, 0.01)], grid);
    expect(narrow.matched).toBe(false);
  });
  it('is false when a wavelength is not finite', async () => {
    mockLoad();
    expect((await loadFirstLook(target, [ex('a', 2, 0, 1, null), ex('b', 2, 1, 50, 1.0)], grid)).matched).toBe(false);
    expect((await loadFirstLook(target, [ex('a', 2, 0, 1, NaN), ex('b', 2, 1, 50, 1.0)], grid)).matched).toBe(false);
  });
});
