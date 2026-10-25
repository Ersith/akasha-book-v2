// Standalone regression entry point. Exit status is the real node:test result.
// Run from any cwd: node tests/run-review5.mjs
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = ['redaction', 'retrieval', 'sleep', 'identity'].map(name => join(here, `review5-${name}.test.mjs`));
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: dirname(here), env: process.env, stdio: 'inherit', windowsHide: true,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
