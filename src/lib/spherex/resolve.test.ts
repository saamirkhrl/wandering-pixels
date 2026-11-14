import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHALLENGE_TARGETS, parseSesameXml, resolveTarget, slugForName } from './resolve';
import { SpherexError } from './types';
import type { Progress } from './types';

const VEGA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Sesame xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
 xsi:noNamespaceSchemaLocation="https://vizier.cds.unistra.fr/xml/sesame_4x.xsd">
<Target option="SNV">
  <name>Vega</name>
  <!-- Q286629 #1 -->
  <Resolver name="Sc=Simbad (CDS, via client/server)"><!--delay: 0ms [0] -->
    <INFO>from cache</INFO>
    <oid>2900336</oid>
    <otype>dS*</otype>
    <jpos>18:36:56.33 +38:47:01.2</jpos>
    <jradeg>279.23473479</jradeg>
    <jdedeg>38.78368896</jdedeg>
    <refPos>2007A&amp;A...474..653V</refPos>
    <pm>
      <v>349.72</v><e>0.51</e><q>A</q><r>2007A&amp;A...474..653V</r>
      <pa>35.1</pa>
      <pmRA>200.94</pmRA><epmRA>0.40</epmRA>
      <pmDE>286.23</pmDE><epmDE>0.32</epmDE>
    </pm>
    <oname>* alf Lyr</oname>
  </Resolver>
</Target>
</Sesame>`;

const NOTHING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Sesame><Target option="SNV"><name>zzz</name>
  <INFO> *** NNNothing found *** </INFO>
</Target></Sesame>`;

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => {
    throw new Error('unexpected fetch');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof SpherexError ? e.code : 'OTHER';
  }
  return 'NO_THROW';
}

describe('coordinates', () => {
  it('decimal degrees', async () => {
    for (const s of ['269.45 4.69', '269.45, +4.69', '269.45,4.69', '  269.45   +4.69 ']) {
      const t = await resolveTarget(s);
      expect(t.ra).toBeCloseTo(269.45, 9);
      expect(t.dec).toBeCloseTo(4.69, 9);
      expect(t.source).toBe('coordinates');
      expect(t.epoch).toBe(2000);
      expect(t.pmra).toBeUndefined();
      expect(t.pmdec).toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sexagesimal in several spellings', async () => {
    const ra = (17 + 57 / 60 + 48.5 / 3600) * 15;
    const dec = 4 + 41 / 60 + 36 / 3600;
    for (const s of [
      '17 57 48.5 +04 41 36',
      '17:57:48.5 +04:41:36',
      '17h57m48.5s +04d41m36s',
      '17 57 48.5, +04 41 36',
      '17:57:48.5 04:41:36',
    ]) {
      const t = await resolveTarget(s);
      expect(t.ra).toBeCloseTo(ra, 9);
      expect(t.dec).toBeCloseTo(dec, 9);
      expect(t.source).toBe('coordinates');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('negative declination and negative zero degrees', async () => {
    const t = await resolveTarget('00 10 00 -00 30 00');
    expect(t.ra).toBeCloseTo(2.5, 9);
    expect(t.dec).toBeCloseTo(-0.5, 9);
    const u = await resolveTarget('12:00:00 -23:26:21');
    expect(u.dec).toBeCloseTo(-(23 + 26 / 60 + 21 / 3600), 9);
    const v = await resolveTarget('10h00m00s -00d00m36s');
    expect(v.dec).toBeCloseTo(-0.01, 9);
  });

  it('rejects out-of-range values with BAD_INPUT', async () => {
    for (const s of [
      '400 5', '-5 10', '360 0', '10 91', '10 -91',
      '25 00 00 +04 00 00', '17 60 00 +04 00 00', '17 00 00 +04 00 60', '17 00 00 +91 00 00',
      '', '   ',
    ]) {
      expect(await code(resolveTarget(s))).toBe('BAD_INPUT');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not mistake catalogue names for coordinates', async () => {
    fetchMock.mockImplementation(async () => xmlResponse(NOTHING_XML));
    expect(await code(resolveTarget('M31'))).toBe('NOT_FOUND');
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('built-in table', () => {
  const aliases: Record<string, string[]> = {
    'barnards-star': ["Barnard's Star", 'barnards star', 'barnards-star', 'GJ 699', "BARNARD'S STAR", 'Barnard\u2019s Star'],
    'eps-indi-b': ['eps indi b', 'epsilon indi b', 'eps ind b', 'eps-indi-b', 'Eps Indi B', 'Epsilon Indi B'],
    'wise-0855': ['WISE 0855-0714', 'WISE J085510.83-071442.5', 'wise-0855', 'wise 0855', 'wise j0855-0714'],
    'rw-aur': ['RW Aur', 'RW Aurigae', 'rw-aur', 'rw aur'],
    'r-dra': ['R Dra', 'R Draconis', 'r-dra', 'r dra'],
  };

  it('every alias resolves offline', async () => {
    for (const [slug, list] of Object.entries(aliases)) {
      for (const a of list) {
        expect(slugForName(a)).toBe(slug);
        const t = await resolveTarget(a);
        const e = CHALLENGE_TARGETS.find((x) => x.slug === slug)!;
        expect(t.ra).toBe(e.ra);
        expect(t.dec).toBe(e.dec);
        expect(t.pmra).toBe(e.pmra);
        expect(t.pmdec).toBe(e.pmdec);
        expect(t.epoch).toBe(e.epoch);
        expect(t.source).toBe(e.source);
        expect(t.name).toBe(e.name);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('has five entries with sane values', () => {
    expect(CHALLENGE_TARGETS.map((e) => e.slug).sort()).toEqual(
      ['barnards-star', 'eps-indi-b', 'r-dra', 'rw-aur', 'wise-0855'],
    );
    for (const e of CHALLENGE_TARGETS) {
      expect(e.ra).toBeGreaterThanOrEqual(0);
      expect(e.ra).toBeLessThan(360);
      expect(Math.abs(e.dec)).toBeLessThanOrEqual(90);
      expect(e.epoch).toBeGreaterThan(2000);
    }
    const wise = CHALLENGE_TARGETS.find((e) => e.slug === 'wise-0855')!;
    expect(wise.pmra).toBeLessThan(-8000);
    expect(wise.source).toBe('simbad');
  });

  it('slugForName returns null for other names', () => {
    expect(slugForName('Vega')).toBeNull();
    expect(slugForName('eps indi')).toBeNull();
    expect(slugForName('')).toBeNull();
  });
});

describe('name resolvers', () => {
  it('parses Sesame XML', () => {
    const t = parseSesameXml(VEGA_XML)!;
    expect(t.ra).toBeCloseTo(279.23473479, 8);
    expect(t.dec).toBeCloseTo(38.78368896, 8);
    expect(t.pmra).toBeCloseTo(200.94, 6);
    expect(t.pmdec).toBeCloseTo(286.23, 6);
    expect(t.epoch).toBe(2000);
    expect(t.source).toBe('sesame');
    expect(parseSesameXml(NOTHING_XML)).toBeNull();
  });

  it('resolves through Sesame first', async () => {
    fetchMock.mockImplementation(async () => xmlResponse(VEGA_XML));
    const stages: Progress[] = [];
    const t = await resolveTarget('Vega', { onProgress: (p) => stages.push(p) });
    expect(t.source).toBe('sesame');
    expect(t.name).toBe('Vega');
    expect(t.pmra).toBeCloseTo(200.94, 6);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SNV?Vega');
    expect(stages.length).toBeGreaterThan(0);
    expect(stages.every((p) => p.stage === 'resolve')).toBe(true);
    expect(stages[stages.length - 1].done).toBe(1);
  });

  it('falls back to the relay when Sesame fails', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('nph-sesame')) throw new TypeError('network down');
      if (u.includes('/api/resolve')) {
        return jsonResponse({
          name: 'HD 189733', ra: 300.1821, dec: 22.7097, pmra: -3.2, pmdec: -250.2, epoch: 2000, source: 'simbad',
        });
      }
      throw new Error('unexpected ' + u);
    });
    const t = await resolveTarget('HD 189733');
    expect(t).toMatchObject({ ra: 300.1821, dec: 22.7097, pmra: -3.2, pmdec: -250.2, epoch: 2000, source: 'simbad' });
    expect(t.name).toBe('HD 189733');
    const relayCall = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/api/resolve'))!;
    expect(relayCall).toContain('name=HD%20189733');
  });

  it('falls back to the relay when Sesame returns an error status', async () => {
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url).includes('nph-sesame')
        ? xmlResponse('busy', 503)
        : jsonResponse({ name: 'X', ra: 1, dec: 2 }),
    );
    const t = await resolveTarget('some star');
    expect(t.ra).toBe(1);
    expect(t.dec).toBe(2);
    expect(t.pmra).toBeUndefined();
    expect(t.epoch).toBe(2000);
  });

  it('NOT_FOUND when nothing knows the name', async () => {
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url).includes('nph-sesame')
        ? xmlResponse(NOTHING_XML)
        : jsonResponse({ error: { code: 'NOT_FOUND', message: 'no such object' } }, 404),
    );
    expect(await code(resolveTarget('zzzznotanobject'))).toBe('NOT_FOUND');
  });

  it('NOT_FOUND when Sesame says nothing and the relay is down', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes('nph-sesame')) return xmlResponse(NOTHING_XML);
      return jsonResponse({}, 500);
    });
    expect(await code(resolveTarget('zzzznotanobject'))).toBe('NOT_FOUND');
  });

  it('keeps the relay error when both resolvers just failed', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes('nph-sesame')) throw new TypeError('down');
      return jsonResponse({}, 500);
    });
    expect(await code(resolveTarget('some star'))).toBe('UPSTREAM_ERROR');
  });

  it('ABORTED when the signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    expect(await code(resolveTarget('Vega', { signal: ctl.signal }))).toBe('ABORTED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
