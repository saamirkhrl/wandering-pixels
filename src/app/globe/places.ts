export interface Place {
  name: string;
  country: string;
  lat: number;
  lon: number;
}

export const PLACES: readonly Place[] = [
  { name: 'Mauna Kea Observatories', country: 'United States', lat: 19.82, lon: -155.47 },
  { name: 'Cerro Pachon', country: 'Chile', lat: -30.24, lon: -70.74 },
  { name: 'La Silla Observatory', country: 'Chile', lat: -29.26, lon: -70.73 },
  { name: 'Paranal Observatory', country: 'Chile', lat: -24.63, lon: -70.4 },
  { name: 'Palomar Observatory', country: 'United States', lat: 33.36, lon: -116.86 },
  { name: 'Kitt Peak National Observatory', country: 'United States', lat: 31.96, lon: -111.6 },
  { name: 'Siding Spring Observatory', country: 'Australia', lat: -31.27, lon: 149.07 },
  { name: 'Roque de los Muchachos Observatory', country: 'Spain', lat: 28.76, lon: -17.89 },
  { name: 'Sutherland (SALT)', country: 'South Africa', lat: -32.38, lon: 20.81 },
  { name: 'Pasadena', country: 'United States', lat: 34.15, lon: -118.14 },
  { name: 'Greenwich', country: 'United Kingdom', lat: 51.48, lon: 0 },
  { name: 'Chicago', country: 'United States', lat: 41.88, lon: -87.63 },
  { name: 'New York', country: 'United States', lat: 40.71, lon: -74.01 },
  { name: 'Los Angeles', country: 'United States', lat: 34.05, lon: -118.24 },
  { name: 'Houston', country: 'United States', lat: 29.76, lon: -95.37 },
  { name: 'Anchorage', country: 'United States', lat: 61.22, lon: -149.9 },
  { name: 'Honolulu', country: 'United States', lat: 21.31, lon: -157.86 },
  { name: 'Vancouver', country: 'Canada', lat: 49.28, lon: -123.12 },
  { name: 'Toronto', country: 'Canada', lat: 43.65, lon: -79.38 },
  { name: 'Mexico City', country: 'Mexico', lat: 19.43, lon: -99.13 },
  { name: 'Bogota', country: 'Colombia', lat: 4.71, lon: -74.07 },
  { name: 'Lima', country: 'Peru', lat: -12.05, lon: -77.04 },
  { name: 'Sao Paulo', country: 'Brazil', lat: -23.55, lon: -46.63 },
  { name: 'Buenos Aires', country: 'Argentina', lat: -34.6, lon: -58.38 },
  { name: 'Santiago', country: 'Chile', lat: -33.45, lon: -70.67 },
  { name: 'Ponta Delgada', country: 'Portugal', lat: 37.74, lon: -25.67 },
  { name: 'Dakar', country: 'Senegal', lat: 14.72, lon: -17.47 },
  { name: 'Recife', country: 'Brazil', lat: -8.05, lon: -34.88 },
  { name: 'Papeete', country: 'French Polynesia', lat: -17.54, lon: -149.57 },
  { name: 'Male', country: 'Maldives', lat: 4.18, lon: 73.51 },
  { name: 'Reykjavik', country: 'Iceland', lat: 64.15, lon: -21.94 },
  { name: 'London', country: 'United Kingdom', lat: 51.51, lon: -0.13 },
  { name: 'Paris', country: 'France', lat: 48.86, lon: 2.35 },
  { name: 'Madrid', country: 'Spain', lat: 40.42, lon: -3.7 },
  { name: 'Munich', country: 'Germany', lat: 48.14, lon: 11.58 },
  { name: 'Moscow', country: 'Russia', lat: 55.76, lon: 37.62 },
  { name: 'Cairo', country: 'Egypt', lat: 30.04, lon: 31.24 },
  { name: 'Lagos', country: 'Nigeria', lat: 6.52, lon: 3.38 },
  { name: 'Nairobi', country: 'Kenya', lat: -1.29, lon: 36.82 },
  { name: 'Cape Town', country: 'South Africa', lat: -33.92, lon: 18.42 },
  { name: 'Dubai', country: 'United Arab Emirates', lat: 25.2, lon: 55.27 },
  { name: 'Mumbai', country: 'India', lat: 19.08, lon: 72.88 },
  { name: 'Delhi', country: 'India', lat: 28.61, lon: 77.21 },
  { name: 'Bangkok', country: 'Thailand', lat: 13.76, lon: 100.5 },
  { name: 'Singapore', country: 'Singapore', lat: 1.35, lon: 103.82 },
  { name: 'Beijing', country: 'China', lat: 39.9, lon: 116.41 },
  { name: 'Tokyo', country: 'Japan', lat: 35.68, lon: 139.69 },
  { name: 'Sydney', country: 'Australia', lat: -33.87, lon: 151.21 },
  { name: 'Perth', country: 'Australia', lat: -31.95, lon: 115.86 },
  { name: 'Auckland', country: 'New Zealand', lat: -36.85, lon: 174.76 },
  { name: 'McMurdo Station', country: 'Antarctica', lat: -77.85, lon: 166.67 },
];

const R_KM = 6371;
const RAD = Math.PI / 180;

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function nearestPlace(lat: number, lon: number): { place: Place; km: number } {
  let best = PLACES[0]!;
  let bestKm = Infinity;
  for (const p of PLACES) {
    const km = distanceKm(lat, lon, p.lat, p.lon);
    if (km < bestKm) {
      best = p;
      bestKm = km;
    }
  }
  return { place: best, km: bestKm };
}

export function formatLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return Math.abs(lat).toFixed(2) + ' ' + ns + ', ' + Math.abs(lon).toFixed(2) + ' ' + ew;
}
