export const COPY = {
  title: 'Follow a body at an assumed distance',
  intro: 'This shows how a possible distant planet would behave between visits.',
  example: '500 au is an example, not a prediction',
  on: 'Images are centred on where a body {D} au away would be on each date. Stars jump between images; a body at that distance stays in the middle.',
  why: 'A body stays within 1 pixel between six-month visits only if the distance is right to about 1 percent at 500 au.',
  tolerance: 'A 1 percent change in distance moves the centre by {px} px between these two images.',
  jump: 'Stars jump {arcsec} arcsec ({px} px) between A and B.',
  orbital:
    'Orbital motion (about 9 px per six months at 500 au, direction unknown) is not modelled, so alignment across visits is approximate; within one visit it is sound.',
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
