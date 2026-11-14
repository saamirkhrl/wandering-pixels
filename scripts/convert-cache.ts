// Converts the format 1 cache (manifest.json + frames.bin) to format 2 without re-downloading.
//
//   npx -y vite-node scripts/convert-cache.ts <slug|all> [--delete-v1]
//
// Same as `npx -y vite-node scripts/build-cache.ts --convert <slug|all> [--delete-v1]`. Without
// --delete-v1 the format 1 files stay; with it they are removed once the check against format 1
// passes (they remain in git history).
import { ALL_SLUGS, convertOne } from './cache-io';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const deleteV1 = args.includes('--delete-v1');
  const arg = args.find((a) => !a.startsWith('--'));
  if (!arg) {
    console.error('usage: vite-node scripts/convert-cache.ts <slug|all> [--delete-v1]');
    process.exit(2);
  }
  const todo = arg === 'all' ? ALL_SLUGS : ALL_SLUGS.filter((s) => s === arg);
  if (todo.length === 0) {
    console.error(`unknown slug '${arg}'`);
    process.exit(2);
  }
  let code = 0;
  for (const slug of todo) {
    try {
      console.log(await convertOne(slug, deleteV1));
    } catch (e) {
      code = 1;
      console.error(`ERROR ${slug}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }
  process.exit(code);
}

void main();
