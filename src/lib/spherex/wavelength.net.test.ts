import { describe, expect, it } from 'vitest';
import { annotateWavelengths } from './wavelength';
import type { Exposure } from './types';
import { NET_TESTS } from './testdata';

const BASE = 'https://nasa-irsa-spherex.s3.amazonaws.com/';
const mk = (obsId: string, key: string, release: 'dr1' | 'qr3'): Exposure => ({
  id: obsId + 'D2', obsId, detector: 2, time: '', mjd: 0, visitIndex: 0,
  wavelengthAtTarget: null, bandwidthAtTarget: null, url: BASE + key, release,
});

describe.skipIf(!NET_TESTS)('annotateWavelengths (network)', () => {
  it('reads Barnard wavelengths from S3 headers', async () => {
    const exps = [
      mk('2025W35_2A_0221_2', 'dr1/level2/2025W35_2A/l2b-v27-2026-231/2/level2_2025W35_2A_0221_2D2_spx_l2b-v27-2026-231.fits', 'dr1'),
      mk('2026W34_2A_0233_3', 'qr3/level2/2026W34_2A/l2b-v27-2026-243/2/level2_2026W34_2A_0233_3D2_spx_l2b-v27-2026-243.fits', 'qr3'),
    ];
    const res = await annotateWavelengths(exps, 269.4545, 4.7686);
    // astropy oracle (see spherex-tests/oracle.json): 1.39269 and 1.34421 um
    expect(res[0].wavelengthAtTarget).toBeCloseTo(1.39269, 2);
    expect(Math.abs((res[0].wavelengthAtTarget as number) - 1.39269)).toBeLessThan(0.002);
    expect(Math.abs((res[1].wavelengthAtTarget as number) - 1.34421)).toBeLessThan(0.002);
    expect(res[0].bandwidthAtTarget as number).toBeGreaterThan(0.02);
  }, 60000);
});
