const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function pad(n: number, w = 2): string {
  return String(Math.floor(n)).padStart(w, '0');
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function wrap360(a: number): number {
  return ((a % 360) + 360) % 360;
}

export function fmtRa(raDeg: number): string {
  const totalSec = Math.round((raDeg / 15) * 3600);
  const s = ((totalSec % 86400) + 86400) % 86400;
  return pad(s / 3600) + 'h ' + pad((s % 3600) / 60) + 'm ' + pad(s % 60) + 's';
}

export function fmtDeg(v: number, digits = 2, signed = false): string {
  const s = v.toFixed(digits);
  return signed && v >= 0 ? '+' + s : s;
}

export function fmtPlace(lat: number, lon: number): string {
  return (
    Math.abs(lat).toFixed(2) + ' ' + (lat >= 0 ? 'N' : 'S') + ', ' +
    Math.abs(lon).toFixed(2) + ' ' + (lon >= 0 ? 'E' : 'W')
  );
}

function shifted(d: Date, lon: number): Date {
  return new Date(d.getTime() + (lon / 15) * 3600000);
}

export function fmtClock(d: Date, lon: number): string {
  const s = shifted(d, lon);
  return pad(s.getUTCHours()) + ':' + pad(s.getUTCMinutes());
}

export function fmtDay(d: Date, lon: number): string {
  const s = shifted(d, lon);
  return s.getUTCDate() + ' ' + MONTHS[s.getUTCMonth()] + ' ' + s.getUTCFullYear();
}

export function fmtUtcClock(d: Date): string {
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

export function localDayNumber(d: Date, lon: number): number {
  return Math.floor((d.getTime() + (lon / 15) * 3600000) / 86400000);
}

export function toInputValue(d: Date): string {
  return d.toISOString().slice(0, 16);
}

export function fromInputValue(v: string): Date | null {
  if (!v) return null;
  const d = new Date(v.length === 16 ? v + ':00Z' : v + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 19) + 'Z';
}
