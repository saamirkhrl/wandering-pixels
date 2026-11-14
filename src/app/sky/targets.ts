export interface Target {
  slug: string;
  name: string;
  ra: number; // degrees, ICRS, position near epoch 2026.0 (where SPHEREx sees it)
  dec: number;
  note: string;
}

export const TARGETS: Target[] = [
  { slug: 'barnards-star', name: "Barnard's Star", ra: 269.446, dec: 4.768, note: 'Fastest moving star in our sky' },
  { slug: 'eps-indi-b', name: 'Eps Indi B', ra: 331.097, dec: -56.801, note: 'Pair of nearby brown dwarfs' },
  { slug: 'wise-0855', name: 'WISE 0855-0714', ra: 133.76, dec: -7.242, note: 'Coldest known brown dwarf' },
  { slug: 'rw-aur', name: 'RW Aur', ra: 76.95653, dec: 30.40144, note: 'Young star that dims and brightens' },
  { slug: 'r-dra', name: 'R Dra', ra: 248.16761, dec: 66.75498, note: 'Pulsating red giant' },
];
