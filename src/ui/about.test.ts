import { describe, expect, it } from 'vitest';
import { ABOUT_COPY, shouldAutoOpen } from './about';

describe('ABOUT_COPY', () => {
  it('has a heading, three paragraphs with leads, and a button', () => {
    expect(ABOUT_COPY.heading).toBe('Wandering Pixels');
    expect(ABOUT_COPY.paragraphs).toHaveLength(3);
    for (const p of ABOUT_COPY.paragraphs) {
      expect(p.lead.length).toBeGreaterThan(0);
      expect(p.text.length).toBeGreaterThan(0);
    }
    expect(ABOUT_COPY.button).toBe('Close');
  });
});

describe('shouldAutoOpen', () => {
  const store = (v: string | null) => ({ getItem: () => v });
  it('opens when nothing is stored', () => {
    expect(shouldAutoOpen('', store(null))).toBe(true);
  });
  it('stays closed once dismissed', () => {
    expect(shouldAutoOpen('', store('1'))).toBe(false);
  });
  it('stays closed in the viewer', () => {
    expect(shouldAutoOpen('?view=viewer', store(null))).toBe(false);
  });
  it('opens without storage or when storage throws', () => {
    expect(shouldAutoOpen('', null)).toBe(true);
    const bad = { getItem: (): string | null => { throw new Error('blocked'); } };
    expect(shouldAutoOpen('', bad)).toBe(true);
  });
});
