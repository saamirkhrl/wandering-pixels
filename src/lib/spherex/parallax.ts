import type { Grid } from './types';
import { SpherexError } from './types';
const NI = (): never => { throw new SpherexError('BAD_INPUT', 'not implemented'); };
export function parallaxOffset(_ra: number, _dec: number, _mjd: number, _d: number): { dRa: number; dDec: number } { return NI(); }
export function positionAtDistance(_ra: number, _dec: number, _mjd: number, _d: number): { ra: number; dec: number } { return NI(); }
export function gridAt(_base: Grid, _mjd: number, _d: number, _referenceMjd?: number): Grid { return NI(); }
export function trackingTolerance(_d: number, _a: number, _b: number, _ra: number, _dec: number): { pxPerPercent: number } { return NI(); }
