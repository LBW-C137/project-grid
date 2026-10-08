import { pruneTestOutput } from './test-output.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--all')) {
  console.error('Usage: node scripts/clean-test-output.mjs [--all]');
  process.exitCode = 1;
} else {
  const { removed, bytesFreed } = await pruneTestOutput({ all: args.includes('--all') });
  for (const entry of removed) console.log(`Removed ${entry.path} (${entry.bytes} bytes)`);
  console.log(`Removed ${removed.length} folder(s); freed ${bytesFreed} bytes (${(bytesFreed / 1024 / 1024).toFixed(2)} MiB).`);
}
