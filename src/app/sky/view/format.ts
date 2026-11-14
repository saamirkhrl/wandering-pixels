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

export interface Clock {
  label: string;
  offset(d: Date): number;
  full(d: Date): string;
  time(d: Date): string;
  dayNumber(d: Date): number;
  toInput(d: Date): string;
  fromInput(v: string): Date | null;
}

export function makeClock(lon: number, tz: string | null): Clock {
  let dtf: Intl.DateTimeFormat | null = null;
  if (tz) {
    try {
      dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      dtf = null;
    }
  }
  const offset = (d: Date): number => {
    if (!dtf) return (lon / 15) * 3600000;
    const parts = dtf.formatToParts(d);
    const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const wall = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
    return wall - Math.floor(d.getTime() / 1000) * 1000;
  };
  const clock = (s: Date): string => {
    const h = s.getUTCHours();
    return (h % 12 || 12) + ':' + pad(s.getUTCMinutes()) + ' ' + (h >= 12 ? 'pm' : 'am');
  };
  const shift = (d: Date): Date => new Date(d.getTime() + offset(d));
  return {
    label: dtf ? 'local' : 'local solar time',
    offset,
    full(d) {
      const s = shift(d);
      return s.getUTCDate() + ' ' + MONTHS[s.getUTCMonth()] + ' ' + s.getUTCFullYear() + ', ' + clock(s);
    },
    time: (d) => clock(shift(d)),
    dayNumber: (d) => Math.floor((d.getTime() + offset(d)) / 86400000),
    toInput: (d) => shift(d).toISOString().slice(0, 16),
    fromInput(v) {
      if (!v) return null;
      const t0 = Date.parse(v.length === 16 ? v + ':00Z' : v + 'Z');
      if (Number.isNaN(t0)) return null;
      const t1 = t0 - offset(new Date(t0));
      return new Date(t0 - offset(new Date(t1)));
    },
  };
}
