import { describe, it, expect } from 'vitest';
// @ts-ignore node types are not installed
import { readFileSync, existsSync } from 'node:fs';
import { readFlagsBlock } from './flags';
import { bytesTransferred, setFetch } from './fits';

import { SPHEREX_TESTS_DIR } from './testdata';
const DIR = SPHEREX_TESTS_DIR;
const ORACLE = `${DIR}/flags_oracle.json`;
const URL =
  'https://nasa-irsa-spherex.s3.amazonaws.com/dr1/level2/2025W35_2A/l2b-v27-2026-231/2/' +
  'level2_2025W35_2A_0221_2D2_spx_l2b-v27-2026-231.fits';

describe.skipIf(!existsSync(ORACLE))('readFlagsBlock against real S3', () => {
  it('reads rows 990..1010 and matches astropy', async () => {
    setFetch(fetch);
    const o = JSON.parse(readFileSync(ORACLE, 'utf8')) as {
      block: { x0: number; x1: number; y0: number; y1: number; data: number[] };
    };
    const { x0, x1, y0, y1, data } = o.block;
    const t0 = Date.now();
    const b0 = bytesTransferred();
    const got = await readFlagsBlock(URL, x0, x1, y0, y1);
    console.log(`FLAGS ${y1 - y0} rows: ${bytesTransferred() - b0} bytes (incl. header walk), ${Date.now() - t0} ms`);
    // second read: HDU table cached, only the two data Ranges
    const t1 = Date.now();
    const b1 = bytesTransferred();
    await readFlagsBlock(URL, x0, x1, y0 + 5, y1 + 5);
    console.log(`FLAGS cached-header read: ${bytesTransferred() - b1} bytes, ${Date.now() - t1} ms`);
    const t2 = Date.now();
    const b2 = bytesTransferred();
    const big = await readFlagsBlock(URL, 0, 2040, 970, 1040);
    console.log(`FLAGS 70 full rows (cached header): ${bytesTransferred() - b2} bytes, ${Date.now() - t2} ms`);
    expect(big.length).toBe(2040 * 70);
    expect(Array.from(got)).toEqual(data);
  }, 60000);
});
