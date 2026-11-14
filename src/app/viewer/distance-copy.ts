export const COPY = {
  planetTitle: 'Distant bodies',
  find: 'Find: compare a year apart',
  measure: 'Measure: follow at a distance',
  step1Title: 'Compare images a year apart',
  step1Body:
    "A year apart, Earth is back in the same place, so stars cancel. A distant body would have moved along its orbit and would show as a bright and dark pair: about 19 pixels apart at 500 au, 41 at 300, 7 at 1000. No star moves that fast; Barnard's Star moves 1.7 pixels a year.",
  ringsToggle: 'Show measuring rings',
  ring1000: '1000 au',
  ring300: '300 au',
  limit1:
    'One pair gives candidates only. Two unrelated things 19 pixels apart, a variable star, a cosmic ray or an artefact can look the same. Visits are not exactly a year apart, which leaves a few pixels of parallax.',
  gap: 'These two images are {n} days apart.',
  gapShort: 'These two images are {n} days apart, {um} um apart in wavelength.',
  gapFull: 'These two images are {n} days apart, {um} um apart in wavelength ({ch} channels).',
  loadRest: 'Load the rest of these two visits ({n} images, about {mb} MB)',
  noYear: 'No two visits here are about a year apart.',
  noHalf: 'No two visits here are about six months apart.',
  step2Title: 'Check with the visit six months away',
  step2Lead:
    'A real body must also appear six months later at the spot its distance predicts: on the line between its two positions from step 1, shifted by parallax. Set the distance until it sits in the middle.',
  fine: 'Changing the distance by 1 percent moves the centre {px} px for this pair.',
  lowTol:
    'These two images are about a year apart, so Earth is back in the same place and the distance setting changes almost nothing. Choose images about six months apart.',
  limitsTitle: 'Limits of this method',
  limit2: 'These two images are {n} days apart, which leaves a few pixels of parallax.',
  limit3: 'At 300 au the yearly motion is 41 pixels, so a body away from the centre can leave the cutout.',
  limit4:
    'Orbital motion is not modelled when following at a distance (about 9 pixels per six months at 500 au), so the body lands near, not exactly at, the predicted spot.',
  limit6:
    'Pairs six months apart are usually several channels apart in wavelength; the colour-matched comparison works per star, not on the image.',
  fewVisits: 'This detector has only {n} visits here, so this step needs another detector.',
  simExample: 'See a simulated example',
  simLabelMock: 'Simulated object in simulated images',
  simLabelReal: 'Simulated object added to real SPHEREx images',
  loadingTracked: 'Re-centring the images',
  title: 'Follow a body at an assumed distance',
  example: '500 au is an example, not a prediction',
  on: 'Images are centred on where a body {D} au away would be on each date. Stars jump between images; a body at that distance stays in the middle.',
  tolerance: 'A 1 percent change in distance moves the centre by {px} px between these two images.',
  jump: 'Stars jump {arcsec} arcsec ({px} px) between A and B.',
  orbital: 'Orbital motion is not modelled here, so the centre drifts by about 9 px per six months at 500 au.',
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
