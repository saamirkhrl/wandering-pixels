import { describe, expect, it } from 'vitest';
import { COPY } from './distance-copy';

const SIGNED_BRIGHTNESS =
  'SPHEREx single images reach about magnitude 18.5 to 19. Published models put Planet Nine between about 19 and 27 at these wavelengths, and an earlier WISE search already covered most of the sky to 19.4. This mode shows how such a search works; it is not expected to find the planet.';

describe('distant bodies copy', () => {
  it('keeps the signed brightness statement verbatim', () => {
    expect(COPY.brightness).toBe(SIGNED_BRIGHTNESS);
  });

  it('uses the word search only inside signed science text', () => {
    const signed = new Set<string>(['brightness', 'deeper']);
    for (const [k, v] of Object.entries(COPY)) {
      if (signed.has(k)) continue;
      expect(/search/i.test(v), k).toBe(false);
    }
  });

  it('never claims a detection and stays plain ASCII', () => {
    for (const [k, v] of Object.entries(COPY)) {
      expect(/^[\x20-\x7e]*$/.test(v), k).toBe(true);
      if (k === 'brightness') continue;
      expect(/detect(ed|ion)|discover|(found|find|finds) (a|the) planet/i.test(v), k).toBe(false);
    }
  });
});
