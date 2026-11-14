// writeCacheDir keeps readouts across a cache rebuild and still removes stale hashed files.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeCacheDir } from './cache-io';

const READOUTS = { file: 'readouts.d2.aaaaaaaa.json', bytes: 3, detector: 2, count: 1 };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cache-io-'));
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function newFiles() {
  return {
    'frames.d2.cccccccc.bin': new Uint8Array([1, 2, 3]),
    'index.json': JSON.stringify({ format: 'wp-cache-2', files: ['frames.d2.cccccccc.bin'] }),
  };
}

describe('writeCacheDir', () => {
  it('keeps readouts file and key, deletes stale hashed files', () => {
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ format: 'wp-cache-2', readouts: READOUTS }));
    writeFileSync(join(dir, READOUTS.file), '[1]');
    writeFileSync(join(dir, 'frames.d2.bbbbbbbb.bin'), 'old');
    writeCacheDir(dir, newFiles());
    expect(existsSync(join(dir, 'frames.d2.bbbbbbbb.bin'))).toBe(false);
    expect(existsSync(join(dir, READOUTS.file))).toBe(true);
    expect(existsSync(join(dir, 'frames.d2.cccccccc.bin'))).toBe(true);
    const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    expect(idx.readouts).toEqual(READOUTS);
    expect(idx.format).toBe('wp-cache-2');
    expect(idx.files).toEqual(['frames.d2.cccccccc.bin']);
  });

  it('does not carry the key when the readouts file is missing', () => {
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ format: 'wp-cache-2', readouts: READOUTS }));
    writeCacheDir(dir, newFiles());
    const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    expect('readouts' in idx).toBe(false);
  });

  it('works with no old index', () => {
    writeCacheDir(dir, newFiles());
    expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).format).toBe('wp-cache-2');
  });
});
