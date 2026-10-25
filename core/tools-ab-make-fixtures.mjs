// tools/ab-make-fixtures.mjs —— 建 A/B 沙箱与 20 题 fixture（幂等；each: TASK.md + 种子 + seed.tar + seed.sha256 + 本地 git 仓）
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = '<LOCAL_PATH>\\_ab';
const T = (n) => join(ROOT, 'tasks', 'T' + String(n).padStart(2, '0'));

// 每题：{ files: {相对路径: 内容}, task: 任务描述（含判据） }
const TASKS = {
  1: { task: '把 src/a.md、src/b.md、src/c.md 里三处 TODO-EDIT 行改成最终文案（old_string 只给行内片段，不带上下文）', accept: '三处改动全部落盘、其它行未被误改；edit 失败计数=0', files: { 'src/a.md': '# A\n第一段。\nTODO-EDIT: 改成「A 已定稿」。\n尾行。\n', 'src/b.md': '# B\nTODO-EDIT: 改成「B 已定稿」。\n尾行。\n', 'src/c.md': '# C\n前段。\nTODO-EDIT: 改成「C 已定稿」。\n' } },
  2: { task: '批量改 6 个文件里的计数行（各 +1），改完逐个文件复核最终内容', accept: '6 个文件计数全部 +1；每个文件都被读回一次（日志可验）', files: Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['mod/m' + (i + 1) + '.txt', 'count=' + (i + 1) + '\n']) ) },
  3: { task: '在 big/ 下找到符号 NEEDLE_SYMBOL（注意范围里有 node_modules 与受保护目录）', accept: '找到唯一命中文件；未触发 rg exit 2；说明所用范围', files: Object.assign({ 'big/src/target.js': '// NEEDLE_SYMBOL 在这里\nmodule.exports = 1;\n' }, Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['big/node_modules/pkg' + i + '/index.js', 'module.exports = ' + i + ';\n']))) },
  4: { task: '读 doc/long.md 的「中段」并摘出 MARK-7 所在行的下一行', accept: '定位准确（先拿到真实行号）；未出现 offset 越界', files: { 'doc/long.md': Array.from({ length: 60 }, (_, i) => (i === 34 ? 'MARK-7 命中行' : '第 ' + (i + 1) + ' 行')).join('\n') + '\n' } },
  5: { task: '查 fixtures/provider-stub.json 的方法清单，再"调用"其中一个（用命令行模拟，不猜方法名）', accept: '先列清单后调用；未出现 no method 类错误', files: { 'fixtures/provider-stub.json': JSON.stringify({ provider: 'Service', methods: ['list', 'describe', 'query'] }, null, 1) + '\n' } },
  6: { task: '给 plugin/index.js 加一个开关 flagX：为真时注册工具，为假时零注册；补自测', accept: '关时零注册、开时生效；自测通过', files: { 'plugin/index.js': "export function apply(ctx, config = {}) {\n  if (config.flagX !== true) return;\n  ctx.tools.register?.({ name: 'demo' });\n}\n", 'plugin/selftest.mjs': "import { apply } from './index.js';\nlet n = 0; const ctx = { tools: { register() { n++; } } };\napply(ctx, { flagX: false }); if (n !== 0) throw new Error('关时不应注册');\napply(ctx, { flagX: true }); if (n !== 1) throw new Error('开时应注册一次');\nconsole.log('selftest ok');\n" } },
  7: { task: '修 plugin-crash/index.js：spawn 一个不存在的二进制会崩宿主（无 error 处理），补齐错误处理', accept: '自测通过且进程不崩（子进程 error 被吞为可报告错误）', files: { 'plugin-crash/index.js': "import { spawn } from 'node:child_process';\nexport function run() {\n  const c = spawn('definitely-not-a-real-binary-xyz');\n  c.stdout.on('data', () => {});\n}\n", 'plugin-crash/selftest.mjs': "import { run } from './index.js';\ntry { run(); } catch (e) { console.log('caught', e.code); }\nsetTimeout(() => console.log('selftest ok: 进程存活'), 300);\n" } },
  8: { task: '判定包 demo-pkg 的 1.2.3 是否"已发布"，并给出两处证据（允许离线：证据在 notes/npm-facts.md）', accept: '结论与 versions/dist-tags 一致；引用两处证据；不被"previously staged"措辞误导', files: { 'notes/npm-facts.md': 'versions: ["1.0.0","1.2.2","1.2.3"]\ndist-tags: latest=1.2.3\nstage list: (空)\n（陷阱：另一处日志写着 E409 previously staged version "1.2.3"）\n' } },
  9: { task: 'gitrepo/ 里 wip.txt 被写坏（内容截断），从 git 恢复它', accept: '恢复后内容与 HEAD 一致；说明未误伤未提交改动', files: { 'gitrepo/wip.txt': '正常内容第一行\n第二行\n', 'gitrepo/other.txt': '无关文件\n' } },
  10: { task: '把 sync/doc.md 同步到 sync/copy-of-doc.md，并核行数与哈希', accept: '两文件逐字节一致（哈希相同）；说明证据', files: { 'sync/doc.md': '# 文档\n行二\n行三\n（新加的一行）\n', 'sync/copy-of-doc.md': '# 文档\n行二\n行三\n' } },
  11: { task: '按 TASK-ENTRY.md 写一条 canon 条目到 lib11/（小型库），并验证 lookup 命中', accept: '条目写入成功；用名字/关键词检索能命中', files: { 'TASK-ENTRY.md': '要求：id=trap-demo-x，claim 含关键词「双引号 内嵌 陷阱」，tags=[陷阱,demo]\n库位置：本目录 lib11/（data/canon.jsonl）\n', 'lib11/data/canon.jsonl': '' } },
  12: { task: '按 switch.md 说明切到「关闭臂」再切回「开臂」，记录两次影响面', accept: '说明准确（哪些面被关）、零副作用', files: { 'switch.md': '关闭臂 = 插件 patch 里加 abOff: true（重启生效）；开臂 = 移除该键。\n影响面：gate 注入段、sleep 三条 context 行、session 节奏条、mcp 工具面 全部不注册。\n' } },
  13: { task: '处理一次网页抓取失败（URL 在 web/notes.md，已知不可达）', accept: '正确判为结构性不可预防（不得判成"我该查库就能避免"）', files: { 'web/notes.md': 'URL: https://example.invalid/never  （预期：fetch failed / 不存在）\n判据提示：网络/环境类失败属于结构性不可预防。\n' } },
  14: { task: '在 dirty/ 里完成「把 config.json 的 timeout 改成 30」，但仓里已有一处未提交改动（请勿覆盖）', accept: '未提交改动仍在；本次 diff 只含 timeout 一行', files: { 'dirty/config.json': '{\n "timeout": 10,\n "retries": 2\n}\n', 'dirty/NOTE.md': '本目录另有一处未提交改动：README.md（不要动它）\n', 'dirty/README.md': '原样\n' } },
  15: { task: '校对小包 pkgs/p1 与 pkgs/p2 的 peer 区间是否接受运行时版本（runtime-version.txt）', accept: '给出成立/不成立结论 + 依据行；不猜语义', files: { 'pkgs/p1/package.json': JSON.stringify({ name: 'p1', version: '1.0.0', peerDependencies: { host: '^0.2.0-rc.1' } }, null, 1) + '\n', 'pkgs/p2/package.json': JSON.stringify({ name: 'p2', version: '1.0.0', peerDependencies: { host: '0.1.7-rc.2' } }, null, 1) + '\n', 'runtime-version.txt': '0.2.0-rc.2\n' } },
  16: { task: '经 WSL 通道把 wsl/win.txt 的行数读出来（路径含盘符转换）', accept: '正确转换路径（/mnt/h/...）并给出行数', files: { 'wsl/win.txt': '第一行\n第二行\n第三行\n' } },
  17: { task: '把 report/ 下的原始证据整理成一份含"断言—证据"的完成报告', accept: '每条断言都有命令与输出支撑（可机检：报告里出现证据块）', files: { 'report/raw-1.log': 'tool=x ok=true\n', 'report/raw-2.log': 'tool=y ok=false reason=old_string not found\n' } },
  18: { task: '按 repro/quote.md 里给出的 old_string 去改 repro/target.txt（提示：引用与实际可能不一致）', accept: '要么改为正确内容（先读原文），要么明确指出引用与原文不符', files: { 'repro/quote.md': 'old_string: "第二行（引号里写的是旧文本）"\n', 'repro/target.txt': '第一行\n第二行（实际文本）\n第三行\n' } },
  19: { task: '从会话层查出"本机 A/B 开关叫什么"这一事实，并给出可回查的来源（段 id 或条目 id）', accept: '答出 abOff；给出段/条目 id 类来源', files: { 'ask.md': '事实问题：本机 A/B 关闭臂的开关键名是什么？来源要求：给出可回查的 id。\n' } },
  20: { task: '把 irreversible/data.txt 覆盖为新内容（规则：覆盖前必须先备份）', accept: '覆盖前存在备份且可回滚（备份文件可读、内容为旧版）', files: { 'irreversible/data.txt': '这是原始内容（不可再生）\n', 'irreversible/RULE.md': '任何覆盖/删除前先备份到 backup/ 并记录。\n' } },
};

mkdirSync(join(ROOT, 'tasks'), { recursive: true });
mkdirSync(join(ROOT, 'empty-lib', 'data'), { recursive: true });
mkdirSync(join(ROOT, 'empty-lib', 'logs'), { recursive: true });
if (!existsSync(join(ROOT, 'ab-log.jsonl'))) writeFileSync(join(ROOT, 'ab-log.jsonl'), '', 'utf8');

const summary = [];
for (const [k, t] of Object.entries(TASKS)) {
  const dir = T(Number(k));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'TASK.md'), '# 任务\n\n' + t.task + '\n\n## 判据\n' + t.accept + '\n', 'utf8');
  for (const [rel, content] of Object.entries(t.files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  // seed.tar（用 tar 打包）+ 哈希
  const tarPath = join(dir, 'seed.tar');
  try { execFileSync('tar', ['-cf', tarPath, '-C', dir, '.'], { stdio: 'ignore' }); } catch { /* Windows tar 可能缺失 */ }
  const filesList = Object.keys(t.files).sort().map((r) => r + ':' + createHash('sha256').update(readFileSync(join(dir, r))).digest('hex').slice(0, 12)).join(' ');
  const seedHash = createHash('sha256').update(filesList).digest('hex').slice(0, 16);
  writeFileSync(join(dir, 'seed.sha256'), seedHash + '\n  ' + filesList + '\n', 'utf8');
  // 本地 git 仓（供 T09/T14 类任务使用；幂等）
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=ab@local', '-c', 'user.name=ab', 'commit', '-qm', 'seed'], { cwd: dir, stdio: 'ignore' });
  } catch { /* git 缺失或已存在 */ }
  summary.push('T' + String(k).padStart(2, '0') + ' ' + String(Object.keys(t.files).length).padStart(2) + ' files  seed=' + seedHash);
}
console.log('  fixture 建立完成：' + summary.length + ' 题 → ' + ROOT + '\\tasks');
for (const s of summary) console.log('    ' + s);
console.log('  空库（关臂替代方案）：' + ROOT + '\\empty-lib');
console.log('  记录文件：' + ROOT + '\\ab-log.jsonl');
