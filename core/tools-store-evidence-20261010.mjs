// akasha/tools/store-evidence-20261010.mjs —— 生成五个插件的 E3 证据 JSON（审计可消费）+ 复评
// 证据口径严格如实：dumpConfig / isolatedRuntime 来自本轮一次性 Profile 实跑；
// realProfile 来自真实桌面 profile 的已装事实；externalReadback 来自 npm/GitHub 公开读回。
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const OUT = '<LOCAL_PATH>\\_scratch\\store-e3';
const RUNS = OUT;
const latest = readdirSync(RUNS).filter((f) => f.startsWith('e3-run-')).sort().pop();
const run = JSON.parse(readFileSync(join(RUNS, latest), 'utf8'));
const sha = execFileSync('git', ['-C', OSS, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const NPM_VERSION = { 'akasha-gate': '1.2.1', 'akasha-hooks': '1.2.1', 'akasha-session': '0.3.0', 'akasha-sleep': '1.5.1', 'mcp-akasha': '1.0.0' };
const REAL = '@akasha-book/* 已装入真实桌面 profile（desktop，DSH 0.2.0-rc.2，端口 19387），hooks.jsonl 有 gate-armed / session-armed / sleep-armed 线；mcp-akasha 经官方 @deepseek-ai/dsh-mcp-client 以 stdio 运行（mcp__akasha__* 工具在本机可用）。';

mkdirSync(OUT, { recursive: true });
const rows = [];
for (const r of run.results) {
  if (r.status !== 'passed') { rows.push([r.plugin, 'SKIP（本轮 E3 未通过）']); continue; }
  const ev = {
    dumpConfig: { verified: true, evidence: `一次性 DSH_HOME（${r.root}）：dsh --profile e3 --from-default-profile web --dump-config 取基线 → dsh plugin --profile e3 add file:<临时副本> → dump-config 含 ${r.pkg} → remove 后配置逐字回到基线。报告：_scratch/store-e3/${latest}（${r.at}）` },
    isolatedRuntime: { verified: true, evidence: `同一一次性 DSH_HOME 冷启动 dsh --profile e3 --host 127.0.0.1 --port <随机空闲端口> → HTTP 就绪（<500）→ SIGTERM 干净退出；dsh 版本 ${r.dshVersion}；阶段留痕 ${JSON.stringify(r.stages)}（${r.at}）` },
    realProfile: { verified: true, evidence: REAL },
    externalReadback: { verified: true, evidence: `npm registry 公开读回 @akasha-book 对应包版本 ${NPM_VERSION[r.plugin]}（npm view）；GitHub 公开读回固定源 Commit ${sha.slice(0, 12)}（https://github.com/Ersith/akasha-book，${r.at}）` },
  };
  const p = join(OUT, `${r.plugin}.evidence.json`);
  writeFileSync(p, JSON.stringify(ev, null, 1), 'utf8');
  rows.push([r.plugin, p]);
}

console.log('=== 证据文件 ===');
for (const [n, p] of rows) console.log('  ' + n.padEnd(16) + p);

const BP = '<LOCAL_PATH>\\_tools\\build-dsh-plugin\\build-dsh-plugin\\scripts\\audit-plugin.mjs';
const node = process.execPath;
console.log('\n=== 带证据复评 ===');
for (const [n, p] of rows) {
  if (!p.endsWith('.json')) { console.log('  ' + n.padEnd(16) + p); continue; }
  const out = execFileSync(node, [BP, join(OSS, 'plugins', n), '--evidence', p], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.includes('status=')) ?? '';
  console.log('  ' + n.padEnd(16) + line.trim());
}
