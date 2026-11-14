export const COPY = {
  planetTitle: 'Distant bodies',
  find: '1. Find: compare a year apart',
  measure: '2. Measure: follow at a distance',
  step1Title: 'Step 1: compare images a year apart',
  step1Body:
    "A year apart, Earth is back in the same place, so stars cancel. A distant body would have moved along its orbit and would show as a bright and dark pair: about 19 pixels apart at 500 au, 41 at 300, 7 at 1000 (one image pixel is about 6 arcseconds). No star moves that fast; Barnard's Star moves 1.7 pixels a year.",
  ringsToggle: 'Show measuring rings',
  ring1000: '1000 au',
  ring300: '300 au',
  limit1:
    'One pair gives candidates only. Two unrelated things 19 pixels apart, a variable star, a cosmic ray or an artefact can look the same. Visits are not exactly a year apart, which leaves a few pixels of parallax (the shift caused by Earth moving round the Sun).',
  gap: 'These two images are {n} days apart.',
  gapShort: 'These two images are {n} days apart, {um} um apart in wavelength.',
  gapFull:
    'These two images are {n} days apart, {um} um apart in wavelength ({ch} channels; a channel is one of the narrow colour bands an image is taken in).',
  loadRest: 'Load the rest of these two visits ({n} images, about {mb} MB)',
  noYear: 'No two visits here are about a year apart.',
  noHalf: 'No two visits here are about six months apart.',
  reading: 'Still reading the list of visits. The steps unlock when a matching pair has arrived.',
  notLoaded: 'Not every visit here is loaded yet. Load the rest of the visits to look for a matching pair.',
  partial: 'The archive answered only in part, so some visits may be missing.',
  step2Title: 'Step 2: check with the visit six months away',
  step2Lead:
    'A real body must also appear six months later where its distance predicts. Parallax (the shift caused by Earth moving round the Sun) is undone here for one assumed distance. Turn the distance until the body lands on the line between its two positions from step 1, at the point for that date.',
  willJump: 'Every star will jump by about {px} px. Only something at this distance stays in the ring.',
  refReal: 'Centred on your chosen point as seen on {date}.',
  refSim: 'Centred on the simulated body as seen on {date}.',
  simTry: 'Try it with a simulated body',
  simOff: 'Use the real images only',
  simTag: 'Simulated object, added to real SPHEREx images',
  simHow:
    'The simulated body is 500 au away, about magnitude 12.8, and moves about 19 pixels a year. In step 1 it shows as a bright and dark pair. In step 2, at 500 au it stays in the middle while every star jumps; turn the distance and watch it slide off.',
  simResult:
    'In our test, a simulated body was found as a bright and dark pair 22 pixels apart, and its distance was read back as 505 au against 500 au put in.',
  limit7:
    'In one test field, simulated movers shifted by 2 pixels or more were found half the time at about magnitude 18.3 to 19.1 (small sample).',
  fine: 'Changing the distance by 1 percent moves the centre {px} px for this pair.',
  lowTol:
    'For these two images the distance setting changes almost nothing: they are close in time or about a year apart, so Earth is in nearly the same place. Choose images about six months apart.',
  limitsTitle: 'Limits of this method',
  limit2: 'These two images are {n} days apart, which leaves a few pixels of parallax.',
  limit3: 'At 300 au the yearly motion is 41 pixels, so a body away from the centre can leave the cutout.',
  limit4:
    'Orbital motion is not modelled when following at a distance (about 9 pixels per six months at 500 au), so a real body lands near, not exactly at, the predicted spot.',
  limit6:
    'Pairs six months apart are usually several channels apart in wavelength; the colour-matched comparison works per star, not on the image.',
  fewVisits: 'This detector has only {n} visits here, so this step needs another detector.',
  simExample: 'See a simulated example',
  simLabelMock: 'Simulated object in simulated images',
  simLabelReal: 'Simulated object added to real SPHEREx images',
  loadingTracked: 'Re-centring the images',
  title: 'Follow a body at an assumed distance',
  example: 'Opens at 500 au as an example, not a prediction.',
  on: 'Images are centred on where a body {D} au away would be on each date. Stars jump between images; a body at that distance stays almost still. If the jump is wider than the image, the two images show different stars; that is expected.',
  tolerance: 'A 1 percent change in distance moves the centre by {px} px between these two images.',
  jump: 'Stars jump {arcsec} arcsec ({px} px) between A and B.',
  orbital: 'Orbital motion is not modelled here, so the centre drifts by about 9 px per six months at 500 au.',
  orbitalSim: "The simulated body's own motion is known, so it is applied here.",
  brightness:
    'SPHEREx single images reach about magnitude 18.5 to 19. Published models put Planet Nine between about 19 and 27 at these wavelengths, and an earlier WISE search already covered most of the sky to 19.4. This mode shows how such a search works; it is not expected to find the planet.',
  sources: 'Sources: Crill et al. 2025; Fortney et al. 2016; Meisner et al. 2018. Depths are pre-launch figures.',
  deeper:
    "Single images cannot reach past earlier searches. Stacking every frame in the body's own frame could in principle go about one magnitude deeper than the WISE search at 3 to 4 microns. That would test only the warmest models, and it is not done here.",
  unavailablePrepared: 'Not available on prepared targets',
  ringLabel: 'Look within this ring',
} as const;

export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function mjdDate(mjd: number): string {
  const d = new Date((mjd - 40587) * 86400000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
