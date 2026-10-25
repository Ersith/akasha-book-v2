// 测试入口（2026-10-19 P1）：OSS 仓把「中性示例」与「真库脱敏快照」分开了——
//   core/data/ = init-example 的中性示例；core/data-snapshot/ = 测试基线。
// ESM 的静态 import 会在模块体之前求值，故必须在导入 test-core 之前设 AKASHA_ROOT。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { existsSync as __existsSync } from 'node:fs';
if (__existsSync(new URL('./data-snapshot/.synthetic', import.meta.url))) process.env.AKASHA_OSS_SYNTHETIC = '1';
import { spawnSync } from 'node:child_process';

const snapshot = fileURLToPath(new URL('./data-snapshot', import.meta.url));
// 2026-10-19 人工复检：有脱敏快照时强制用它，避免外部 AKASHA_ROOT 指活库；
// 只有显式 AKASHA_ALLOW_LIVE_TESTS=1 才允许跑外部库（例如活树自己的全量测试）。
if (existsSync(snapshot) && process.env.AKASHA_ALLOW_LIVE_TESTS !== '1') process.env.AKASHA_ROOT = snapshot;
if (process.env.AKASHA_TEST_ECHO === '1') console.log('AKASHA_ROOT=' + process.env.AKASHA_ROOT);
// Filesystem instrumentation stays in isolated test processes; never import it into core.
const sessionRegression = spawnSync(process.execPath, ['--test',
  fileURLToPath(new URL('./session-tree-streaming.test.mjs', import.meta.url)),
  fileURLToPath(new URL('./session-index-safety.test.mjs', import.meta.url)),
  fileURLToPath(new URL('./session-index-streaming.test.mjs', import.meta.url)),
], { stdio: 'inherit', windowsHide: true, timeout: 30000 });
if (sessionRegression.error) throw sessionRegression.error;
if (sessionRegression.status !== 0) process.exit(sessionRegression.status || 1);
await import('./test-core.mjs');
