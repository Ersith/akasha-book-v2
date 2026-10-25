// gate-dry.mjs —— 门控「试匹配」（dry-run）：给一个工具调用，**只报判决、绝不拦截**。
// 为什么需要它：改规则 / 修假阳性时，"这条到底会不会被拦"必须能离线问清楚（2026-10-10 曾被假阳性来回折腾）。
// **与门控同源**：本工具 import 的是门控自己的规则工厂 createGateRules（gate-dry 说会拦 ⇒ 运行时就一定拦）。
// 用法：
//   node tools/gate-dry.mjs --tool edit  --json '{"file_path":"<AKASHA_DIR>\\data\\canon.jsonl"}'
//   node tools/gate-dry.mjs --tool pwsh  --command "echo x >> <AKASHA_DIR>\data\canon.jsonl"
//   node tools/gate-dry.mjs --tool codex_exec --prompt "把 akasha\data\canon.jsonl 追加一行"
//   echo '{"name":"write","arguments":{"file_path":"..."}}' | node tools/gate-dry.mjs --stdin
// 可选：--data-dir <路径>（默认 AKASHA_DIR/data，其次 <脚本>/../data）
// 退出码：0 = 放行 · 3 = 会拦 · 2 = 用法错误
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] ?? '') : d; };
const has = (n) => argv.includes(n);

async function loadGate() {
  const cands = [
    process.env.AKASHA_GATE_DIR,
    join(HERE, '..', '..', 'dsh-akasha-gate'),
    join(HERE, '..', '..', 'plugins', 'akasha-gate'),
    join(HERE, '..', 'dsh-akasha-gate')
  ].filter(Boolean);
  for (const d of cands) {
    const p = join(d, 'index.js');
    if (existsSync(p)) return { mod: await import(pathToFileURL(p).href), dir: d };
  }
  console.error('找不到门控 index.js；候选目录：' + cands.join(' | ') + '（可用 AKASHA_GATE_DIR 覆盖）');
  process.exit(2);
}

const dataDir = flag('--data-dir')
  || (process.env.AKASHA_DIR ? join(process.env.AKASHA_DIR, 'data') : join(HERE, '..', 'data'));

let exec = null;
if (has('--stdin')) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  exec = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} else {
  const tool = flag('--tool');
  if (!tool) { console.error('用法：--tool <名> [--json <参数JSON> | --command <命令> | --prompt <委派prompt>] 或 --stdin'); process.exit(2); }
  let args = {};
  if (flag('--json')) { try { args = JSON.parse(flag('--json')); } catch (e) { console.error('--json 解析失败：' + e.message); process.exit(2); } }
  if (flag('--command')) args.command = flag('--command');
  if (flag('--prompt')) args.prompt = flag('--prompt');
  exec = { name: tool, arguments: args };
}

const { mod, dir } = await loadGate();
const rules = mod.createGateRules({ dataDir: String(dataDir) });
const v = rules.verdict(exec);

console.log('门控试匹配（dry-run，未拦截任何东西）');
console.log('  规则版本   : ' + mod.RULES_VERSION);
console.log('  门控目录   : ' + dir);
console.log('  数据目录   : ' + String(dataDir));
console.log('  工具       : ' + String(exec?.name ?? ''));
console.log('  判决       : ' + (v.deny ? '会拦' : '放行'));
if (v.deny) {
  console.log('  命中规则   : ' + v.ruleId);
  console.log('  目标       : ' + v.target);
  console.log('  文案       : ' + v.message);
} else {
  // 顺手告知"为什么放行"（便于排假阴性/假阳性）
  const known = ['write-tool-data-path', 'shell-write-into-data', 'agent-prompt-write-into-data'];
  console.log('  规则覆盖   : ' + known.join(' / ') + '（未命中任何一条）');
}
process.exit(v.deny ? 3 : 0);
