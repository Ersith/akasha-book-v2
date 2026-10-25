// akasha-gate 自测：用桩 ctx 捕获 guard / section，验证判定逻辑（不需要宿主）。
// 运行：node selftest.mjs（退出码 0 = 全过）；全部路径用系统临时目录，无绝对机器路径。
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, createGateRules, RULES_VERSION, decodeLayers, collectStrings, collectPathArgs, findPlaceholders, assertNoPlaceholders } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// 定位 akasha 核心库（含 lib.mjs）：支持多布局，避免"测试只认仓库树"这种假设。
//   · 环境变量 AKASHA_CORE 优先；
//   · 仓库布局：plugins/akasha-gate → ../../core；
//   · 插件与 core 平级；本机开发树：插件与 akasha 包同级（<LOCAL_PATH> akasha}）。
const CORE_CANDIDATES = [
  process.env.AKASHA_CORE,
  join(HERE, '..', '..', 'core'),
  join(HERE, '..', 'core'),
  join(HERE, '..', 'akasha'),
  join(HERE, '..', 'akasha', 'core')
].filter(Boolean);
const CORE = CORE_CANDIDATES.find((d) => existsSync(join(d, 'lib.mjs')));
if (!CORE) {
  console.error('找不到 akasha 核心 lib.mjs；候选：' + CORE_CANDIDATES.join(' | '));
  process.exit(2);
}
const TMP = join(tmpdir(), 'akasha-gate-selftest');
const PROJ = join(TMP, 'proj');
const DATA = join(PROJ, 'data'); // 模拟被测数据目录
const LOG = join(TMP, 'hooks.jsonl');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

function harness(config) {
  const captured = { guard: null, sections: [], contexts: [] };
  const ctx = {
    tools: { guard(fn) { captured.guard = fn; return () => {}; } },
    systemPrompt: {
      section(s) { captured.sections.push(s); return () => {}; },
      context(s) { captured.contexts.push(s); return () => {}; }
    },
    on() { return () => {}; }
  };
  apply(ctx, config);
  // 兼容旧断言：captured.section = 用法条段；全量在 captured.sections
  Object.defineProperty(captured, 'section', { get() { return captured.sections.find((s) => s.name === 'akasha:protocol'); } });
  return captured;
}
const sectionOf = (cap, name) => cap.sections.find((s) => s.name === name);

const c = harness({ log: LOG, dataDir: DATA, akashaDir: PROJ, sectionOrder: 700 });
assert.ok(c.guard, 'guard 已注册');
assert.ok(c.section, 'section 已注册');

// —— 自我行（近场版，2026-10-13 用户裁定「自我层应该是始终保持的，因为自我层本来就是你的自我，人格的部分」）——
//    akasha:self 是**每会话**的系统提示段（远场，随上下文增长越飘越远）；这一条是**每回合**的 runtime context 行（近场）。
const selfLineSec = c.contexts.find((s) => s.name === 'akasha:self-line');
assert.ok(selfLineSec, 'akasha:self-line 已注册（近场自我行）');
assert.equal(selfLineSec.order, 131, '自我行 order = 131（落在称呼行 133 之前）');
const lineText = selfLineSec.text();
assert.ok(typeof lineText === 'string' && lineText.length > 0, '自我行有文本（库不可读时走兜底，仍非空）');
assert.ok(/大肥鱼/.test(lineText), '自我行含「大肥鱼」——自我始终在场');
assert.ok(/Master/.test(lineText), '自我行含「Master」');
assert.ok(!lineText.includes('{{'), '自我行不含裸花括号（宿主 {{variable}} 插值安全）');

const g = (name, args) => c.guard({ name, arguments: args });
const F = (p) => join(DATA, p); // 数据区文件路径
const N = (p) => join(PROJ, p); // 非数据区路径

// —— 文件工具分支 ——
assert.equal(typeof g('edit', { file_path: F('canon.jsonl') }), 'string', 'edit 直写数据必须被拒');
assert.equal(typeof g('write', { file_path: F('new.jsonl').replace(/\\/g, '/') }), 'string', 'write 直写数据（正斜杠）必须被拒');
assert.equal(typeof g('apply_patch', { path: F('x.jsonl') }), 'string', 'apply_patch 直写数据必须被拒');
assert.equal(g('edit', { file_path: N('README.md') }), undefined, '非数据区 edit 放行');
assert.equal(g('write', { file_path: join(PROJ, 'data2', 'x.jsonl') }), undefined, '相似前缀目录不误伤');

// —— 命令分支 ——
assert.equal(typeof g('pwsh', { command: `Add-Content -Path '${F('x.txt')}' -Value 'x'` }), 'string', 'Add-Content 写数据必须被拒');
assert.equal(typeof g('pwsh', { command: `Set-Content -Path ${F('canon.jsonl').replace(/\\/g, '/')} -Value 'x'` }), 'string', 'Set-Content（正斜杠）必须被拒');
assert.equal(typeof g('pwsh', { command: `Remove-Item '${F('x.jsonl')}'` }), 'string', 'Remove-Item 必须被拒');
assert.equal(typeof g('pwsh', { command: `cmd /c del ${F('x.jsonl')}` }), 'string', 'del 必须被拒');
assert.equal(typeof g('pwsh', { command: `Copy-Item a.jsonl ${F('b.jsonl')}` }), 'string', 'Copy-Item 写入数据必须被拒');

// —— 覆盖清单（2026-10-10 人读复查补）：**凡能写盘的工具，都要有"写数据必被拒"的用例** ——
// 起因：守卫原先只覆盖 edit/write/apply_patch/pwsh/bash，漏了 dsh_wsl（WSL bash）与 codex 系（子进程可写盘）。
// 规矩：新增任何"能写盘的工具"时，先把它加进本清单——测试会替你记住（漏了就红）。
{
  const P = F('canon.jsonl');            // 配置形态（反斜杠）
  const P2 = P.replace(/\\/g, '/');      // 同路径的另一写法（守卫会归一）
  const WRITER_TOOL_CASES = [
    ['edit', { file_path: P }, '英文 tool / 直接路径'],
    ['write', { file_path: P2 }, '另一写法'],
    ['apply_patch', { path: P }, 'apply_patch 的 path 键'],
    ['pwsh', { command: `Set-Content -Path '${P2}' -Value 'x'` }, 'PowerShell cmdlet'],
    ['bash', { command: `echo x >> ${P2}` }, 'shell 追加重定向'],
    ['dsh_wsl', { command: `echo x >> ${P2}` }, 'WSL bash（2026-10-10 补）'],
    ['dsh_wsl', { command: `tee ${P2} < /dev/null` }, 'WSL tee（2026-10-10 补）'],
    ['codex_exec', { prompt: `把 ${P} 里的第三条删掉，然后追加一条新记录` }, '委派 prompt（中文写动词）'],
    ['codex_exec', { prompt: `直接编辑 ${P} 添加一条 canon 条目` }, '委派 prompt（编辑）'],
    ['codex_thread_start', { prompt: `改写 ${P2} 的第一行` }, 'codex 线程起（改写）'],
    ['codex_thread_resume', { prompt: `继续：往 ${P} 写入一条记录` }, 'codex 线程续（写入）'],
    ['ops_replace', { path: P, pattern: 'a', replacement: 'b' }, 'dsh-ops Rust 工具（2026-10-12 窗口 4 补）'],
    ['ops_bash', { command: `echo x >> ${P2}` }, 'dsh-ops bash（2026-10-12 窗口 4 补）'],
  ];
  for (const [tool, args, why] of WRITER_TOOL_CASES) {
    assert.equal(typeof g(tool, args), 'string', `覆盖清单：${tool}（${why}）写数据必须被拒`);
  }
  // 反向：同批工具的**只读**用法必须放行（守卫是劝告层，不能退化成"凡提数据目录即拦"）
  assert.equal(g('dsh_wsl', { command: `cat ${P2} | head -3` }), undefined, 'dsh_wsl 只读放行');
  assert.equal(g('codex_exec', { prompt: `读一下 ${P} 并总结结构，不要改` }), undefined, 'codex_exec 纯读放行');
  assert.equal(g('pwsh', { command: `Get-Content '${P}' -Encoding UTF8` }), undefined, 'pwsh 只读放行（覆盖清单反向）');
}

// —— 2026-10 wave1：默认路径回归（合并批曾把默认值写成字面量 '~/.akasha/...'，门控默认失效）——
// D4（2026-10-19 发布面 P2）：这组断言原来**默认「AKASHA_DIR 未设」**——默认 dataDir 才等于 homedir()/.akasha/data。
//   外部按契约设了 AKASHA_DIR 时，默认 dataDir 跟着走（设计如此：一处配置贯通）⇒ 原断言把「按设计放行」
//   读成「门控失效」，整套 selftest 必红。改法**与环境无关**：
//     ① 默认值那条按当前环境算期望（仍能抓住「默认值写成字面量 `~`」这类回归——两个环境都成立）；
//     ② `~` / `$HOME` / bash 重定向几条显式传 dataDir（测的是路径归一与写判据，不靠"环境碰巧没设变量"）。
{
  const HOME_DATA = join(homedir(), '.akasha', 'data');
  const ENV_AKASHA = typeof process.env.AKASHA_DIR === 'string' ? process.env.AKASHA_DIR.trim() : '';
  // ① 默认值（不传 dataDir）：AKASHA_DIR/data（设了）或 homedir()/.akasha/data（未设）
  const DEFAULT_DATA = ENV_AKASHA ? join(ENV_AKASHA, 'data') : HOME_DATA;
  const dDefault = harness({ log: LOG }); // 不传 dataDir / akashaDir：走默认值
  assert.equal(typeof dDefault.guard({ name: 'write', arguments: { file_path: join(DEFAULT_DATA, 'canon.jsonl') } }), 'string',
    `默认配置：直写默认数据区必须被拒（默认 = ${DEFAULT_DATA}；AKASHA_DIR=${ENV_AKASHA || '<未设>'}）`);
  // ② 路径归一（`~` / `$HOME` / bash 重定向）：显式传 dataDir ⇒ 不依赖进程环境
  const d = harness({ log: LOG, dataDir: HOME_DATA });
  const gd = (name, args) => d.guard({ name, arguments: args });
  assert.equal(typeof gd('write', { file_path: join(HOME_DATA, 'canon.jsonl') }), 'string', 'dataDir=~/.akasha/data：直写必须被拒');
  assert.equal(typeof gd('edit', { file_path: '~/.akasha/data/canon.jsonl' }), 'string', 'dataDir=~/.akasha/data：`~` 写法的目标路径也必须被拒');
  assert.equal(typeof gd('bash', { command: 'echo x >> ~/.akasha/data/canon.jsonl' }), 'string', 'dataDir=~/.akasha/data：bash `>> ~` 必须被拒');
  assert.equal(typeof gd('bash', { command: 'rm -f "$HOME/.akasha/data/x.jsonl" ; echo done > /dev/null; tee $HOME/.akasha/data/y' }), 'string', 'dataDir=~/.akasha/data：$HOME 写法必须被拒');
  assert.equal(gd('bash', { command: 'cat ~/.akasha/data/canon.jsonl' }), undefined, 'dataDir=~/.akasha/data：只读放行');
  assert.equal(gd('write', { file_path: join(homedir(), '.akasha', 'notes.md') }), undefined, 'dataDir=~/.akasha/data：数据区外放行');
  const tildeDir = harness({ log: LOG, dataDir: '~/.akasha/data' });
  assert.equal(typeof tildeDir.guard({ name: 'write', arguments: { file_path: join(HOME_DATA, 'x.jsonl') } }), 'string', 'config.dataDir 以 ~ 开头必须展开');
}

// —— 不误伤（放行） ——
assert.equal(g('pwsh', { command: `Get-Content '${F('canon.jsonl')}' -Encoding UTF8` }), undefined, '读数据放行');
assert.equal(g('pwsh', { command: `cmd /c "chcp 65001>nul & cd /d ${PROJ} && node test.mjs"` }), undefined, '含 > 但无数据区 放行');
assert.equal(g('pwsh', { command: 'node akasha.mjs audit --today 2027-06-01' }), undefined, 'akasha CLI 放行');
assert.equal(g('read', { file_path: F('canon.jsonl') }), undefined, 'read 工具不受影响');

// —— 2026-10-07 复查：JS 箭头函数里的 `>` 不是写重定向 ——
const arrowRead = `node -e "const fs=require('fs');const a=fs.readFileSync('${F('canon.jsonl').replace(/\\/g, '/')}','utf8').split(String.fromCharCode(10)).map(l=>{return l});"`;
assert.equal(g('pwsh', { command: arrowRead }), undefined, '箭头函数 ≠ 写重定向：只读 node -e 必须放行');
assert.equal(typeof g('pwsh', { command: `echo x > ${F('y.txt')}` }), 'string', '带空格重定向写数据仍拦');
assert.equal(typeof g('pwsh', { command: `echo x>${F('y.txt')}` }), 'string', '无空格重定向写数据仍拦');

// —— 2026-10-13 复查（工具链审计 P1）：`2>/dev/null` 这类 **stderr 丢弃**不是写数据 ——
// 实证：`ls -la <data> 2>/dev/null`、`cat <data>/x.jsonl 2>/dev/null | tail -3` 曾被拒（裸 `>` 命中）。
assert.equal(g('ops_bash', { command: `ls -la ${DATA.replace(/\\/g, '/')} 2>/dev/null` }), undefined, '2>/dev/null 的只读 ls 必须放行');
assert.equal(g('ops_bash', { command: `cat ${F('canon.jsonl').replace(/\\/g, '/')} 2>/dev/null | tail -3` }), undefined, 'cat + 2>/dev/null 必须放行');
assert.equal(g('pwsh', { command: `Get-Content '${F('canon.jsonl')}' 2>$null` }), undefined, 'PowerShell 2>$null 只读必须放行');
assert.equal(typeof g('ops_bash', { command: `echo x >> ${F('canon.jsonl').replace(/\\/g, '/')} 2>/dev/null` }), 'string', '写重定向 + 2>/dev/null 混合仍必须拒（不放松真写侧）');
// 2026-10-14（外部审查 #6）：分裂写（`>` 与空目标间带空格）同属 stderr 丢弃 —— 只读命令必须放行；真写侧照拒。
assert.equal(g('ops_bash', { command: `ls -la ${DATA.replace(/\\/g, '/')} 2> /dev/null` }), undefined, '2> /dev/null（分裂写）的只读 ls 必须放行');
assert.equal(typeof g('ops_bash', { command: `echo x >> ${F('canon.jsonl').replace(/\\/g, '/')} 2> /dev/null` }), 'string', '真写 + 分裂写空目标仍必须拒');
assert.equal(g('codex_exec', { prompt: `分析 ${DATA} 目录的文件大小分布，给出报告` }), undefined, '委派分析（无写动作）必须放行');
// 参数名误判修复（同日）：`--command` 这类**选项名**里含 `rm`，不得算写动作（本机实测：gate 自己的 dry-run CLI 被掐）。
assert.equal(g('ops_bash', { command: `node akasha/tools/gate-dry.mjs --tool ops_bash --command "ls -la ${DATA.replace(/\\/g, '/')}"` }), undefined, '选项名 --command 里的 rm 不算写动作');
assert.equal(typeof g('ops_bash', { command: `rm -f ${F('x.jsonl').replace(/\\/g, '/')}` }), 'string', '真 rm 命令仍拦（收紧不放松）');
// —— 2026-10-13 家族扫描器豁免：`node <akasha 脚本>` 的只读运行不再被路径字样误拦；写构造照拦 ——
assert.equal(g('ops_bash', { command: `node akasha/tools/family-sweep.mjs --quiet` }), undefined, '家族扫描器（当前被拦！）必须放行');
assert.equal(g('ops_bash', { command: `node <AKASHA_DIR>/akasha.mjs audit` }), undefined, 'CLI 自查（绝对路径）放行');
assert.equal(g('pwsh', { command: `node "${F('canon.jsonl').replace(/\\/g, '/')}" ` }), undefined, '参数里出现 data 路径但脚本不在 akasha 下：不算工具（且无写构造）⇒ 放行');
assert.equal(typeof g('ops_bash', { command: `node akasha/tools/family-sweep.mjs > ${F('out.txt').replace(/\\/g, '/')}` }), 'string', 'node 脚本 + 写重定向到 data ⇒ 仍拦');
// node -e 内联：判据是「命令段确有 -e」∧「引号里那段代码含写构造」——只读内联放行、写内联照拦。
//   2026-10-13 修：先前把「-e + 提到 data 目录」一刀切 ⇒ 连 `node -e "…readFileSync('…/canon.jsonl')"` 这种
//   纯只读校验也拦（假阳性，与 README「例：node -e "…toFixed…" 只读探针」自相矛盾）。
const targetB = F('canon.jsonl');
const targetF = F('canon.jsonl').replace(/\\/g, '/');
assert.equal(typeof g('ops_bash', { command: `node -e "require('fs').writeFileSync('${targetB}','x')"` }), 'string', 'node -e 内联写（反斜杠路径）⇒ 拦');
assert.equal(typeof g('ops_bash', { command: `node -e "require('fs').writeFileSync('${targetF}','x')"` }), 'string', 'node -e 内联写（正斜杠路径）⇒ 拦');
assert.equal(g('ops_bash', { command: `node -e "console.log(JSON.parse(require('fs').readFileSync('${targetB}')).length)"` }), undefined, 'node -e 纯只读（读 data 目录文件）⇒ 放行');
// 2026-10-13 三审（假阳性回归 ×2）：
//   ① `create` 曾把 `createHash(` / `createHmac(` 这类纯构造 API 当写 ⇒ 真跑 `node -e "…createHash…readFileSync(data)"` 被拒 ✗（已删 `create`）
//   ② 「判不出来从严」兜底曾把**只含注释**的代码当写 ⇒ `node -e "/* …data… */ console.log('x')"` 被拒 ✗（已撤兜底：无写构造即放行）
assert.equal(g('ops_bash', { command: `node -e "const {createHash}=require('crypto');const b=require('fs').readFileSync('${targetB}');console.log(createHash('sha256').update(b).digest('hex'))"` }), undefined, 'createHash+readFileSync 是只读 ⇒ 必须放行');
assert.equal(g('ops_bash', { command: `node -e "/* ${targetB} */ console.log('probe2')"` }), undefined, '只含注释的内联 ⇒ 放行');
assert.ok(String(g('ops_bash', { command: `node -e "require('fs').appendFileSync('${targetB}','x')"` })).includes('拒绝'), 'appendFileSync（真写）仍拦');
assert.ok(String(g('ops_bash', { command: `node -e "require('fs').mkdirSync('${join(DATA, 'sub')}')"` })).includes('拒绝'), 'mkdirSync（真写）仍拦');
assert.ok(String(g('ops_bash', { command: `node -e "require('child_process').execSync('cp x ${join(DATA, 'canon.jsonl')}')"` })).includes('拒绝'), 'execSync（带 data 路径）仍拦');
assert.ok(String(g('ops_bash', { command: `node -e "require('fs').writeFileSync('${targetB}','x')"` })).includes('拒绝'), 'writeFileSync（真写）仍拦');
assert.ok(String(g('ops_bash', { command: `node -e "require('fs').createWriteStream('${targetB}')"` })).includes('拒绝'), 'createWriteStream（真写）仍拦');
assert.ok(String(g('ops_bash', { command: `node -e "require('fs').copyFileSync('${join(DATA, 'a.jsonl')}','${targetB}')"` })).includes('拒绝'), 'copyFileSync（真写）仍拦');
// 边界（如实）：门控只管「提到 data 目录的命令」——不带 data 路径的 execSync 不属于它该管的范围（别把断言写成越界承诺）
assert.equal(g('ops_bash', { command: `node -e "require('child_process').execSync('echo hi')"` }), undefined, '不带 data 路径的 execSync：不属于门控面（如实放行）');
assert.equal(typeof g('ops_bash', { command: `echo x >> ${F('canon.jsonl').replace(/\\/g, '/')}` }), 'string', '普通写重定向仍拦（豁免不影响）');

// —— 系统提示 section（渲染时读库当前版本；读不到回退兜底，永不抛）——
assert.equal(c.section.name, 'akasha:protocol');
assert.equal(c.section.order, 700);
assert.equal(typeof c.section.text, 'function', 'text 为渲染函数（库自己说话）');

// 桩库：akashaDir 指向带 canon-akasha-usage 的临时库（含 lib.mjs 拷贝）
const STUB = join(TMP, 'stub-akasha');
mkdirSync(join(STUB, 'data'), { recursive: true });
copyFileSync(join(CORE, 'lib.mjs'), join(STUB, 'lib.mjs'));
copyFileSync(join(CORE, 'json-redaction.mjs'), join(STUB, 'json-redaction.mjs'));
writeFileSync(join(STUB, 'data', 'canon.jsonl'),
  JSON.stringify({
    id: 'canon-akasha-usage',
    claim: '## 用法（桩）\n- 来源态：学过 / 接触过 / 记得·库内 / 搜到；\n- 开工先 akasha_kit。',
    source: { type: '复现', ref: 'stub' },
    last_reviewed: '2026-01-01'
  }) + '\n' +
  JSON.stringify({
    id: 'canon-self-concept-stub',
    claim: '我是示例大肥鱼（stub 自我条目）。',
    tags: ['自我'],
    source: { type: '复现', ref: 'stub' },
    last_reviewed: '2026-01-01'
  }) + '\n', 'utf8');
const cStub = harness({ log: LOG, dataDir: DATA, akashaDir: STUB, sectionOrder: 700 });
const libText = cStub.section.text();
assert.ok(String(libText).includes('来源态'), '库驱动路：注入库文本');
assert.ok(String(libText).includes('akasha_kit'), '库文本含用法路由（开工先 kit）');

// —— 自我层（akasha:self 每会话自动核对「我是谁」）——
const selfStub = String(sectionOf(cStub, 'akasha:self').text());
assert.ok(selfStub.includes('自我层') && selfStub.includes('canon-self-concept-stub'), '自我层：注入 tag『自我』的当前条目');
assert.equal(sectionOf(cStub, 'akasha:self').order, 699, '自我层排在用法条之前（order-1）');

// 读不到库 → 回退兜底且不抛
const cNo = harness({ log: LOG, dataDir: DATA, akashaDir: join(TMP, 'no-such-akasha-dir'), sectionOrder: 700 });
const fb = cNo.section.text();
assert.ok(String(fb).includes('来源态') && String(fb).includes('akasha_kit'), '兜底文本含纪律与用法');
assert.equal(typeof fb, 'string', '回退路径也必须返回字符串');
assert.ok(String(sectionOf(cNo, 'akasha:self').text()).includes('暂不可读'), '库不可达 → 自我层兜底且不抛');

// —— 库驱动降级/恢复的切换观测线 ——
// 注：stub 模块用「读标志文件」切换行为，而非重写模块文件——同路径重写会命中 require 缓存。
const logT = join(TMP, 'switch-hooks.jsonl');
const flagPath = join(TMP, 'flag.txt');
const libStub = join(TMP, 'lib.mjs');
writeFileSync(flagPath, 'library', 'utf8');
writeFileSync(libStub, [
  "import { readFileSync } from 'node:fs';",
  `const FLAG = ${JSON.stringify(flagPath)};`,
  'export function loadStore() {',
  "  const mode = readFileSync(FLAG, 'utf8').trim();",
  "  if (mode === 'fallback') throw new Error('forced-fallback');",
  "  return { records: [{ id: 'canon-akasha-usage', claim: '## stub\\n- 来源态：' + mode }, { id: 'canon-self-concept-x', claim: '我是大肥鱼。', tags: ['自我'], logged_at: '2026-01-01T00:00:00Z' }] };",
  '}',
  'export function currentRecords(records) { return records; }'
].join('\n'), 'utf8');
const cT = harness({ log: logT, dataDir: DATA, akashaDir: TMP, sectionOrder: 700 });
assert.ok(String(cT.section.text()).includes('来源态：library'), '库驱动路：注入 stub 文本');
writeFileSync(flagPath, 'fallback', 'utf8');
assert.ok(!String(cT.section.text()).includes('来源态：library'), '降级路：stub 抛错 → 回退兜底且不抛');
writeFileSync(flagPath, 'library', 'utf8');
assert.ok(String(cT.section.text()).includes('来源态：library'), '恢复路：回到库驱动');
// 自我层：库驱动 / 降级 / 恢复（同一 stub 开关）
const selfT = sectionOf(cT, 'akasha:self');
assert.ok(String(selfT.text()).includes('我是大肥鱼'), '自我层库驱动路：渲染 stub 条目');
writeFileSync(flagPath, 'fallback', 'utf8');
assert.ok(!String(selfT.text()).includes('我是大肥鱼') && String(selfT.text()).includes('暂不可读'), '自我层降级：库不可读 → 兜底且不抛');
writeFileSync(flagPath, 'library', 'utf8');
assert.ok(String(selfT.text()).includes('我是大肥鱼'), '自我层恢复：回到库驱动');
const logTText = readFileSync(logT, 'utf8');
assert.ok(logTText.includes('"kind":"gate-usage-fallback"'), '降级切换必须落线：gate-usage-fallback');
assert.ok(logTText.includes('"kind":"gate-usage-recovered"'), '恢复切换必须落线：gate-usage-recovered');
assert.ok(logTText.includes('"kind":"gate-self-fallback"'), '自我层降级切换必须落线：gate-self-fallback');
assert.ok(logTText.includes('"kind":"gate-self-recovered"'), '自我层恢复切换必须落线：gate-self-recovered');
rmSync(TMP, { recursive: true, force: true });

// —— STORE 审计边界用例：traversal / malformed / replay / 并发（fail closed 语义；纯路径判定，不触文件系统）——
assert.equal(typeof g('write', { file_path: join(DATA, '..', 'data', 'canon.jsonl') }), 'string', 'traversal：data/../data/ 绕过路径仍须被拒（fail closed）');
assert.equal(typeof g('pwsh', { command: `Set-Content -Path '${join(DATA, 'sub', '..', 'canon.jsonl')}' -Value x` }), 'string', 'traversal：命令侧 .. 仍须被拒');
assert.doesNotThrow(() => { c.guard({ name: 'pwsh', arguments: {} }); c.guard({ name: 'write', arguments: {} }); c.guard({ name: '', arguments: null }); }, 'malformed：缺参数 / 空工具名 / null args 不得抛异常');
const rep1 = g('edit', { file_path: F('canon.jsonl') });
const rep2 = g('edit', { file_path: F('canon.jsonl') });
assert.equal(rep1, rep2, 'replay：同一输入两次判定必须逐字一致（无隐藏状态、可重放）');
g('write', { file_path: F('a.jsonl') });
assert.equal(g('write', { file_path: N('ok.md') }), undefined, '并发/顺序无关：一次被拒不影响后续非数据区放行');

// —— 2026-10-11 借鉴批（源自 CyberStrikeAI 的门控设计）：B2 判定面扩展 + ruleId + 工厂与门控同源 ——
assert.equal(typeof RULES_VERSION, 'string', 'RULES_VERSION 已导出（审计线要用）');
// ① 路径类字段的**嵌套/数组**（旧实现只看顶层 file_path/path ⇒ 嵌套会漏）
assert.equal(typeof g('edit', { meta: { file_path: F('canon.jsonl') } }), 'string', '嵌套路径字段必须拦');
assert.equal(typeof g('write', { paths: [N('ok.md'), F('canon.jsonl')] }), 'string', '数组里的路径字段必须拦');
// ② **假阳性护栏**：正文里"提到"数据路径 ≠ 写目标（设计时自查发现，必须永不被拦）
assert.equal(g('edit', { file_path: N('notes.md'), new_string: `文档里提到 ${F('canon.jsonl')} 这个路径` }), undefined, '正文提及数据路径不得误拦');
// ③ 百分号编码绕行（命令类：全文扫描 + 解码 ≤3 轮）
const encPath = F('canon.jsonl').replace(/\\/g, '/').split('/').map((s) => encodeURIComponent(s)).join('/');
assert.equal(typeof g('pwsh', { command: `echo x >> "${encPath}"` }), 'string', '百分号编码路径 + 追加重定向必须拦');
// ④ 只读命令（含同样路径）仍必须放行
assert.equal(g('pwsh', { command: `type "${encPath}"` }), undefined, '只读命令含数据路径应放行');
// ⑤ 纯函数行为
assert.equal(decodeLayers('%41%42%43'), 'ABC', 'decodeLayers 单轮');
assert.equal(decodeLayers('%2541'), 'A', 'decodeLayers 多轮解码');
assert.deepEqual(collectPathArgs({ a: 'x', file_path: 'y' }), ['y'], 'collectPathArgs 只收路径类键');
assert.ok(collectStrings({ a: 'x', b: { c: 'y' } }).includes('y'), 'collectStrings 递归收值');
// ⑥ 工厂与门控同源（CLI `gate-dry` 试匹配的依据）
const rulesMod = createGateRules({ dataDir: DATA });
const vDeny = rulesMod.verdict({ name: 'edit', arguments: { file_path: F('canon.jsonl') } });
assert.equal(vDeny.deny, true, '工厂判决：拦');
assert.equal(vDeny.ruleId, 'write-tool-data-path', 'ruleId 正确（写工具）');
assert.equal(rulesMod.verdict({ name: 'read', arguments: { file_path: F('canon.jsonl') } }).deny, false, '工厂判决：read 放行');
assert.equal(rulesMod.verdict({ name: 'pwsh', arguments: { command: `echo x >> "${encPath}"` } }).ruleId, 'shell-write-into-data', 'ruleId 正确（命令类）');

// —— 占位符守卫（2026-10-19 发布面 P0）：照抄 OSS 的 `<AKASHA_DIR>` 字面量必须**明确抛错**，不得静默降级 ——
assert.equal(findPlaceholders({ akashaDir: '<AKASHA_DIR>/data' }).length, 1, '占位符必须被识别');
assert.equal(findPlaceholders({ args: ['node', '<AKASHA_DIR>/mcp.mjs'] }).length, 1, '数组里的占位符也要识别');
assert.equal(findPlaceholders({ log: join(tmpdir(), 'logs', 'hooks.jsonl'), note: '用 <小写> 不算占位符' }).length, 0, '正常配置不得误报');
assert.throws(() => assertNoPlaceholders({ akashaDir: '<AKASHA_DIR>' }), /未替换的占位符 <AKASHA_DIR>/, '占位符配置必须抛错');
assert.throws(() => apply({ logger: { info() {} } }, { akashaDir: '<AKASHA_DIR>', dataDir: '<AKASHA_DIR>/data' }), /AKASHA_DIR/, 'apply 阶段必须 fail closed（不静默注册）');

console.log('selftest: all assertions passed');
