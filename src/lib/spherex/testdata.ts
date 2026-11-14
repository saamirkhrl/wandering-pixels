// Test-only helper: where the large sample files used by tests live (outside the repo).
// Override with the WP_SAMPLES_DIR environment variable; default is <repo>/../research/samples.
// Tests that need these files skip themselves when the files are missing (hasSamples).
// Tests that touch the network run only when WP_NET_TESTS=1 (NET_TESTS); any download they
// cache goes under SAMPLES_DIR, never into the repo. Only test files import this module.
// @ts-ignore node types are not installed
import { existsSync } from 'node:fs';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

export const SAMPLES_DIR: string = (
  env?.WP_SAMPLES_DIR ?? decodeURIComponent(new URL('../../../../research/samples', import.meta.url).pathname)
).replace(/\/+$/, '');

export const SPHEREX_TESTS_DIR = `${SAMPLES_DIR}/spherex-tests`;

/** True only when WP_NET_TESTS=1: network tests are skipped otherwise. */
export const NET_TESTS: boolean = env?.WP_NET_TESTS === '1';

/** True when every given path (relative to SPHEREX_TESTS_DIR, or absolute) exists. */
export function hasSamples(...relPaths: string[]): boolean {
  return relPaths.every((p) => existsSync(p.startsWith('/') ? p : `${SPHEREX_TESTS_DIR}/${p}`));
}
