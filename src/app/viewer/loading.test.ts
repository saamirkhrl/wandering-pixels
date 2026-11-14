import { describe, expect, it } from 'vitest';
import { bytesFromProgress, loadingLine } from './loading';

describe('loadingLine', () => {
  it('shows bytes of total when the total is known', () => {
    expect(loadingLine("Barnard's Star", { bytes: 1.2e6, total: 5.0e6 })).toBe("Loading Barnard's Star, 1.2 of 5.0 MB");
  });
  it('shows bytes so far without a total', () => {
    expect(loadingLine("Barnard's Star", { bytes: 1.2e6, total: null })).toBe("Loading Barnard's Star, 1.2 MB so far");
  });
  it('shows just the name before any bytes arrive', () => {
    expect(loadingLine("Barnard's Star", { bytes: null, total: null })).toBe("Loading Barnard's Star");
  });
  it('treats small totals as counts, not bytes', () => {
    expect(bytesFromProgress({ stage: 'pixels', done: 1, total: 2, bytes: 3e6 })).toEqual({ bytes: 3e6, total: null });
    expect(bytesFromProgress({ stage: 'pixels', done: 1e6, total: 5e6, bytes: 1e6 })).toEqual({ bytes: 1e6, total: 5e6 });
  });
});
