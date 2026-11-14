import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Exposure, Grid, Target, Detector, Frame } from './types';

vi.mock('./frame', () => ({ loadFrame: vi.fn() }));
vi.mock('./wavelength', () => ({ annotateWavelengths: vi.fn() }));
import { loadFrame } from './frame';
import { annotateWavelengths } from './wavelength';
import { loadFirstLook, loadBestPair } from './firstlook';

const mocked = vi.mocked(loadFrame);
const annotate = vi.mocked(annotateWavelengths);
const target: Target = { ra: 10, dec: 20 };
const grid: Grid = { ra0: 10, dec0: 20, w: 5, h: 5, scaleArcsec: 6.15, epochMjd: 60000 };

function ex(id: string, detector: Detector, visitIndex: number, mjd: number, wl: number | null = 1.0, bw: number | null = null): Exposure {
  return { id, obsId: id, detector, time: '', mjd, visitIndex, wavelengthAtTarget: wl, bandwidthAtTarget: bw, url: 'u', release: 'dr1' };
}

/** Mock loader: succeeds for every exposure unless its id is in `fail`; coverage from `cov` (default 1). */
function mockLoad(fail: string[] = [], cov: Record<string, number> = {}) {
  mocked.mockImplementation(async (e: Exposure) => {
    if (fail.includes(e.id)) throw { message: 'boom ' + e.id };
    return { exposure: e, coverage: cov[e.id] ?? 1 } as unknown as Frame;
  });
}
const loaded = () => mocked.mock.calls.map((c) => c[0].id);
const ids = (r: { frames: Frame[] }) => r.frames.map((f) => f.exposure.id);

beforeEach(() => {
  mocked.mockReset();
  annotate.mockReset();
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
    expect(loaded().sort()).toEqual(['v0a', 'v2a']);
  });
  it('passes target and options through', async () => {
    mockLoad();
    const signal = new AbortController().signal;
    const onProgress = () => {};
    await loadFirstLook(target, [ex('a', 1, 0, 1), ex('b', 1, 1, 50)], grid, { signal, onProgress, background: 'none', wavelengthMap: true, detector: 1 });
    const opts = mocked.mock.calls[0][2] as unknown as Record<string, unknown>;
    expect(opts.target).toBe(target);
    expect(opts.signal).toBe(signal);
    expect(opts.onProgress).toBe(onProgress);
    expect(opts.background).toBe('none');
    expect(opts.wavelengthMap).toBe(true);
    expect('detector' in opts).toBe(false);
    expect(mocked.mock.calls[0][1]).toBe(grid);
  });
  it('passes distanceAu and referenceMjd through to loadFrame', async () => {
    mockLoad();
    await loadFirstLook(target, [ex('a', 1, 0, 1), ex('b', 1, 1, 50)], grid, { distanceAu: 3.2, referenceMjd: 60500 });
    expect(mocked.mock.calls.length).toBe(2);
    for (const c of mocked.mock.calls) {
      const o = c[2] as unknown as Record<string, unknown>;
      expect(o.distanceAu).toBe(3.2);
      expect(o.referenceMjd).toBe(60500);
    }
  });
  it('uses one exposure when there is one visit', async () => {
    mockLoad();
    const r = await loadFirstLook(target, [ex('b', 1, 0, 2), ex('a', 1, 0, 1)], grid);
    expect(ids(r)).toEqual(['a']);
    expect(r.matched).toBe(false);
  });
  it('returns frames sorted by mjd', async () => {
    mocked.mockImplementation(async (e: Exposure) => {
      await new Promise((r) => setTimeout(r, e.id === 'a' ? 5 : 0));
      return { exposure: e, coverage: 1 } as unknown as Frame;
    });
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

describe('loadFirstLook low-coverage retry', () => {
  const exps = [ex('a1', 1, 0, 1), ex('a2', 1, 0, 2), ex('a3', 1, 0, 3), ex('a4', 1, 0, 4), ex('b1', 1, 1, 50), ex('b2', 1, 1, 51)];
  it('retries on low coverage and keeps the best', async () => {
    mockLoad([], { a1: 0.3, a2: 0.7, a3: 0.5, b1: 1 });
    const r = await loadFirstLook(target, exps, grid);
    expect(ids(r)).toEqual(['a2', 'b1']);
    expect(loaded()).toEqual(expect.arrayContaining(['a1', 'a2', 'a3', 'b1']));
    expect(loaded()).not.toContain('b2');
  });
  it('stops early once coverage reaches 0.9', async () => {
    mockLoad([], { a1: 0.3, a2: 0.95 });
    const r = await loadFirstLook(target, exps, grid);
    expect(ids(r)).toEqual(['a2', 'b1']);
    expect(loaded()).not.toContain('a3');
  });
  it('makes at most 2 extra attempts per slot', async () => {
    mockLoad([], { a1: 0.1, a2: 0.2, a3: 0.3, a4: 0.4, b1: 0.1, b2: 0.2 });
    const r = await loadFirstLook(target, exps, grid);
    expect(loaded()).not.toContain('a4');
    expect(ids(r)).toEqual(['a3', 'b2']);
  });
  it('counts a failed load as an attempt and uses a later one', async () => {
    mockLoad(['a1'], {});
    const r = await loadFirstLook(target, exps, grid);
    expect(ids(r)).toEqual(['a2', 'b1']);
  });
});

describe('loadBestPair', () => {
  it('passes distanceAu and referenceMjd through to loadFrame', async () => {
    mockLoad();
    const exps = [ex('a1', 2, 0, 1, 1.0), ex('b1', 2, 1, 50, 1.01)];
    await loadBestPair(target, exps, grid, { distanceAu: 2.5, referenceMjd: 60400 });
    expect(mocked.mock.calls.length).toBeGreaterThan(0);
    for (const c of mocked.mock.calls) {
      const o = c[2] as unknown as Record<string, unknown>;
      expect(o.distanceAu).toBe(2.5);
      expect(o.referenceMjd).toBe(60400);
    }
  });
  const pairExps = [
    ex('a1', 2, 0, 1, 1.0), ex('a2', 2, 0, 2, 1.5),
    ex('b1', 2, 1, 50, 1.01), ex('b2', 2, 1, 51, 1.49), ex('b3', 2, 1, 52, 2.0),
  ];
  it('takes the smallest wavelength gap pair when coverage is fine', async () => {
    mockLoad();
    const r = await loadBestPair(target, pairExps, grid);
    expect(ids(r)).toEqual(['a1', 'b1']);
    expect(r.detector).toBe(2);
    expect(annotate).not.toHaveBeenCalled();
  });
  it('skips to the next pair on low coverage and reuses loaded exposures', async () => {
    mockLoad([], { b1: 0.2 });
    const r = await loadBestPair(target, pairExps, grid);
    // gaps: a1-b1 .01, a2-b2 .01 (tie: larger dt => a1-b1 first), a2-b1 .49 ...
    expect(ids(r)).toEqual(['a2', 'b2']);
    expect(loaded().sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
  });
  it('respects the 4-extra cap and returns the best seen', async () => {
    const many = [
      ex('a1', 2, 0, 1, 1.0), ex('a2', 2, 0, 2, 1.1), ex('a3', 2, 0, 3, 1.2), ex('a4', 2, 0, 4, 1.3), ex('a5', 2, 0, 5, 1.4),
      ex('b1', 2, 1, 50, 1.0), ex('b2', 2, 1, 51, 1.1), ex('b3', 2, 1, 52, 1.2), ex('b4', 2, 1, 53, 1.3), ex('b5', 2, 1, 54, 1.4),
    ];
    mockLoad([], { a1: 0.1, b1: 0.1, a2: 0.5, b2: 0.6, a3: 0.3, b3: 0.3, a4: 0.2, b4: 0.2, a5: 0.8, b5: 0.8 });
    const r = await loadBestPair(target, many, grid);
    expect(mocked.mock.calls.length).toBe(6); // first pair (2) + 4 extra
    expect(ids(r)).toEqual(['a2', 'b2']);
  });
  it('filters pairs by maxWavelengthGapUm and falls back to first look when none remain', async () => {
    mockLoad();
    const r = await loadBestPair(target, pairExps, grid, { maxWavelengthGapUm: 0.001 });
    expect(ids(r)).toEqual(['a1', 'b1']); // first look: first exposure of each visit
    expect(loaded().sort()).toEqual(['a1', 'b1']);
    const r2 = await loadBestPair(target, pairExps, grid, { maxWavelengthGapUm: 0.2 });
    expect(r2.frames.length).toBe(2);
  });
  it('calls annotateWavelengths when wavelengths are missing', async () => {
    const bare = [ex('a1', 2, 0, 1, null), ex('b1', 2, 1, 50, null)];
    annotate.mockResolvedValue([ex('a1', 2, 0, 1, 1.0), ex('b1', 2, 1, 50, 1.0)]);
    mockLoad();
    const r = await loadBestPair(target, bare, grid);
    expect(annotate).toHaveBeenCalledTimes(1);
    expect(annotate.mock.calls[0][1]).toBe(target.ra);
    expect(annotate.mock.calls[0][2]).toBe(target.dec);
    expect(ids(r)).toEqual(['a1', 'b1']);
    expect(r.matched).toBe(true);
  });
  it('throws NO_COVERAGE when all loads fail', async () => {
    mockLoad(pairExps.map((e) => e.id));
    await expect(loadBestPair(target, pairExps, grid)).rejects.toMatchObject({ code: 'NO_COVERAGE' });
  });
});
