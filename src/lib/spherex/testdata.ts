// Test-only helper: where the large sample files used by tests live (outside the repo).
// Override with the WP_SAMPLES_DIR environment variable; default is <repo>/../research/samples.
// Tests that need these files skip themselves when the files are missing.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

export const SAMPLES_DIR: string = (
  env?.WP_SAMPLES_DIR ?? decodeURIComponent(new URL('../../../../research/samples', import.meta.url).pathname)
).replace(/\/+$/, '');

export const SPHEREX_TESTS_DIR = `${SAMPLES_DIR}/spherex-tests`;
