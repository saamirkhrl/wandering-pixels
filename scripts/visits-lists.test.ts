import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assignVisits } from '../src/lib/spherex/search';
import type { Exposure } from '../src/lib/spherex/types';

// Visit rule checked against the exposure lists saved from the live archive.
const stack = (e: Exposure) => (e as { inStack?: boolean }).inStack;

describe('assignVisits on saved exposure lists', () => {
  const dir = '/Users/samir/Desktop/spaceapps/research/samples/exposure-lists';
  const expected: Record<string, number> = {
    'barnards-star': 3, 'eps-indi-b': 4, 'wise-0855': 3, 'rw-aur': 3, 'r-dra': 8,
  };
  for (const [slug, visits] of Object.entries(expected)) {
    it.skipIf(!existsSync(`${dir}/${slug}.json`))(`saved list ${slug}: ${visits} visits`, () => {
      const ex = JSON.parse(readFileSync(`${dir}/${slug}.json`, 'utf8')).exposures as Exposure[];
      const out = assignVisits(ex);
      const ids = new Set(out.map((e) => e.visitIndex));
      const off = out.filter((e) => stack(e) === false).length;
      console.log(slug, 'visits', ids.size, 'inStack false', off,
        [...ids].map((v) => out.filter((e) => e.visitIndex === v && stack(e) !== false).length).join(','));
      expect(ids.size).toBe(visits);
      // Sub-clusters at Barnard: 108+10, 112+2+8, 119+4 (qr3 adds the trailing 4).
      if (slug === 'barnards-star') expect(off).toBe(24);
      if (slug === 'r-dra') expect(off).toBe(0);
    });
  }
});
