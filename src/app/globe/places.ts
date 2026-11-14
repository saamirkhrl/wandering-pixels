export interface Place {
  name: string;
  country: string;
  lat: number;
  lon: number;
  tz: string;
  observatory: boolean;
}

export const PLACES: readonly Place[] = [
  { name: 'Mauna Kea Observatories', country: 'United States', lat: 19.82, lon: -155.47, tz: 'Pacific/Honolulu', observatory: true },
  { name: 'Cerro Pachon', country: 'Chile', lat: -30.24, lon: -70.74, tz: 'America/Santiago', observatory: true },
  { name: 'La Silla Observatory', country: 'Chile', lat: -29.26, lon: -70.73, tz: 'America/Santiago', observatory: true },
  { name: 'Paranal Observatory', country: 'Chile', lat: -24.63, lon: -70.4, tz: 'America/Santiago', observatory: true },
  { name: 'Palomar Observatory', country: 'United States', lat: 33.36, lon: -116.86, tz: 'America/Los_Angeles', observatory: true },
  { name: 'Kitt Peak National Observatory', country: 'United States', lat: 31.96, lon: -111.6, tz: 'America/Phoenix', observatory: true },
  { name: 'Siding Spring Observatory', country: 'Australia', lat: -31.27, lon: 149.07, tz: 'Australia/Sydney', observatory: true },
  { name: 'Roque de los Muchachos Observatory', country: 'Spain', lat: 28.76, lon: -17.89, tz: 'Atlantic/Canary', observatory: true },
  { name: 'Sutherland (SALT)', country: 'South Africa', lat: -32.38, lon: 20.81, tz: 'Africa/Johannesburg', observatory: true },
  { name: 'Pasadena', country: 'United States', lat: 34.15, lon: -118.14, tz: 'America/Los_Angeles', observatory: false },
  { name: 'Greenwich', country: 'United Kingdom', lat: 51.48, lon: 0, tz: 'Europe/London', observatory: false },
  { name: 'Chicago', country: 'United States', lat: 41.88, lon: -87.63, tz: 'America/Chicago', observatory: false },
  { name: 'New York', country: 'United States', lat: 40.71, lon: -74.01, tz: 'America/New_York', observatory: false },
  { name: 'Los Angeles', country: 'United States', lat: 34.05, lon: -118.24, tz: 'America/Los_Angeles', observatory: false },
  { name: 'Houston', country: 'United States', lat: 29.76, lon: -95.37, tz: 'America/Chicago', observatory: false },
  { name: 'Anchorage', country: 'United States', lat: 61.22, lon: -149.9, tz: 'America/Anchorage', observatory: false },
  { name: 'Honolulu', country: 'United States', lat: 21.31, lon: -157.86, tz: 'Pacific/Honolulu', observatory: false },
  { name: 'Vancouver', country: 'Canada', lat: 49.28, lon: -123.12, tz: 'America/Vancouver', observatory: false },
  { name: 'Toronto', country: 'Canada', lat: 43.65, lon: -79.38, tz: 'America/Toronto', observatory: false },
  { name: 'Mexico City', country: 'Mexico', lat: 19.43, lon: -99.13, tz: 'America/Mexico_City', observatory: false },
  { name: 'Bogota', country: 'Colombia', lat: 4.71, lon: -74.07, tz: 'America/Bogota', observatory: false },
  { name: 'Lima', country: 'Peru', lat: -12.05, lon: -77.04, tz: 'America/Lima', observatory: false },
  { name: 'Sao Paulo', country: 'Brazil', lat: -23.55, lon: -46.63, tz: 'America/Sao_Paulo', observatory: false },
  { name: 'Buenos Aires', country: 'Argentina', lat: -34.6, lon: -58.38, tz: 'America/Argentina/Buenos_Aires', observatory: false },
  { name: 'Santiago', country: 'Chile', lat: -33.45, lon: -70.67, tz: 'America/Santiago', observatory: false },
  { name: 'Ponta Delgada', country: 'Portugal', lat: 37.74, lon: -25.67, tz: 'Atlantic/Azores', observatory: false },
  { name: 'Dakar', country: 'Senegal', lat: 14.72, lon: -17.47, tz: 'Africa/Dakar', observatory: false },
  { name: 'Recife', country: 'Brazil', lat: -8.05, lon: -34.88, tz: 'America/Recife', observatory: false },
  { name: 'Papeete', country: 'French Polynesia', lat: -17.54, lon: -149.57, tz: 'Pacific/Tahiti', observatory: false },
  { name: 'Male', country: 'Maldives', lat: 4.18, lon: 73.51, tz: 'Indian/Maldives', observatory: false },
  { name: 'Reykjavik', country: 'Iceland', lat: 64.15, lon: -21.94, tz: 'Atlantic/Reykjavik', observatory: false },
  { name: 'London', country: 'United Kingdom', lat: 51.51, lon: -0.13, tz: 'Europe/London', observatory: false },
  { name: 'Paris', country: 'France', lat: 48.86, lon: 2.35, tz: 'Europe/Paris', observatory: false },
  { name: 'Madrid', country: 'Spain', lat: 40.42, lon: -3.7, tz: 'Europe/Madrid', observatory: false },
  { name: 'Munich', country: 'Germany', lat: 48.14, lon: 11.58, tz: 'Europe/Berlin', observatory: false },
  { name: 'Moscow', country: 'Russia', lat: 55.76, lon: 37.62, tz: 'Europe/Moscow', observatory: false },
  { name: 'Cairo', country: 'Egypt', lat: 30.04, lon: 31.24, tz: 'Africa/Cairo', observatory: false },
  { name: 'Lagos', country: 'Nigeria', lat: 6.52, lon: 3.38, tz: 'Africa/Lagos', observatory: false },
  { name: 'Nairobi', country: 'Kenya', lat: -1.29, lon: 36.82, tz: 'Africa/Nairobi', observatory: false },
  { name: 'Cape Town', country: 'South Africa', lat: -33.92, lon: 18.42, tz: 'Africa/Johannesburg', observatory: false },
  { name: 'Dubai', country: 'United Arab Emirates', lat: 25.2, lon: 55.27, tz: 'Asia/Dubai', observatory: false },
  { name: 'Mumbai', country: 'India', lat: 19.08, lon: 72.88, tz: 'Asia/Kolkata', observatory: false },
  { name: 'Delhi', country: 'India', lat: 28.61, lon: 77.21, tz: 'Asia/Kolkata', observatory: false },
  { name: 'Bangkok', country: 'Thailand', lat: 13.76, lon: 100.5, tz: 'Asia/Bangkok', observatory: false },
  { name: 'Singapore', country: 'Singapore', lat: 1.35, lon: 103.82, tz: 'Asia/Singapore', observatory: false },
  { name: 'Beijing', country: 'China', lat: 39.9, lon: 116.41, tz: 'Asia/Shanghai', observatory: false },
  { name: 'Tokyo', country: 'Japan', lat: 35.68, lon: 139.69, tz: 'Asia/Tokyo', observatory: false },
  { name: 'Sydney', country: 'Australia', lat: -33.87, lon: 151.21, tz: 'Australia/Sydney', observatory: false },
  { name: 'Perth', country: 'Australia', lat: -31.95, lon: 115.86, tz: 'Australia/Perth', observatory: false },
  { name: 'Auckland', country: 'New Zealand', lat: -36.85, lon: 174.76, tz: 'Pacific/Auckland', observatory: false },
  { name: 'McMurdo Station', country: 'Antarctica', lat: -77.85, lon: 166.67, tz: 'Antarctica/McMurdo', observatory: false },
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
