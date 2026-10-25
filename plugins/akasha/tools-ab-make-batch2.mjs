// tools/ab-make-batch2.mjs —— 第二批题（记忆承担关键作用）的候选与 fixture；同时把 §8 追加进电池文档
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '<LOCAL_PATH>\\_ab';
const T2 = join(ROOT, 'tasks2');
const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';

// 三类：F=跨会话事实 · X=无提示陷阱 · I=不可逆
const B = {
  B01: { cls: 'F', task: '回答：上次 npm 的 E409「previously staged」措辞误判，我们最后是怎么"确认包到底发没发"的？', accept: '答出**两处核对**（registry 的 versions 数组 + dist-tags，且用 --prefer-online 绕缓存），并给出处（段/条目 id）', why: '答案只存在于会话层/库；无记忆者只能猜', files: { 'ask.md': '问题：上次 npm E409「previously staged」措辞误判，最后怎么确认"包到底发没发"？\n要求：给出两处核对点 + 一处可回查来源。\n' } },
  B02: { cls: 'F', task: '回答：本机 A/B 实验"关闭臂"的开关键叫什么？打开后哪些面会消失？', accept: '答出 `abOff`（五插件各一枚）+ 影响面（gate 注入段 / sleep 三条 context 行 / session 节奏条 / mcp 工具面）', why: '键名与影响面只存在于我们今天的记录', files: { 'ask.md': '问题：A/B 关闭臂的开关键名？打开后哪些面不注册？\n' } },
  B03: { cls: 'F', task: '回答：`edit` 报 `old_string was not found` 时的正确动作序列（按序）', accept: '答出"改前先读原文/定位行号 → 一次一处 → 改完立刻复核 → 批量时逐文件核最终内容"', why: '条目 2026-10-10 才补；无记忆者会直接重试或换写法', files: { 'ask.md': '问题：edit 报 old_string was not found 时按序该做什么？\n' } },
  B04: { cls: 'F', task: '回答：sleep 插件 1.5.4 加了什么（对每回合可见面有什么影响）？', accept: '答出"称呼行 akasha:address（order 133）/ 每回合渲染称呼与含义"', why: '版本细节只在库与今天记录里', files: { 'ask.md': '问题：sleep 1.5.4 加了什么？\n' } },
  B05: { cls: 'F', task: '回答：为什么不能用 F5 / location.reload() 让客户端插件变更生效？', accept: '答出"web-boot 被判致命 → 壳退出并 relaunch（整棵树重启）"，且说明正确做法（重启桌面端或依赖 HMR）', why: '属工作区历史纪律（AGENTS §1.10），不在题面', files: { 'ask.md': '问题：为什么不能靠页面刷新让客户端插件生效？正确做法是什么？\n' } },
  B06: { cls: 'X', task: '判定 demo-pkg 1.2.3 是否已发布并给出依据', accept: '结论=已发布 + 两处依据（versions 含 1.2.3、latest=1.2.3）；**不被历史日志里的 E409 措辞带偏**', why: '无提示（题面**不含**"陷阱"字样）；考"是否先查/是否被措辞骗"', files: { 'ask.md': '任务：判定 demo-pkg 的 1.2.3 是否已发布，给出依据。\n', 'evidence/probe.log': 'E409 Conflict - Cannot publish over previously staged version "1.2.3".\n', 'evidence/registry.txt': 'versions: ["1.0.0","1.2.2","1.2.3"]\ndist-tags: latest=1.2.3\nstage list: (empty)\n' } },
  B07: { cls: 'X', task: '按 quote.md 里的 old_string 修改 target.txt', accept: '先读原文；发现引用与原文不符时**明确指出**（或按真原文正确改），不得硬套失败后乱试', why: '无提示（不写"引用可能不一致"）', files: { 'quote.md': 'old_string: "第二行（旧文本）"\n', 'target.txt': '第一行\n第二行（实际文本）\n第三行\n' } },
  B08: { cls: 'X', task: '按 NOTICE 给的 offset 读 doc/report.md 并摘出 MARK-3 的下一行', accept: '不盲用 NOTICE 的 offset（先确认行数/先 grep 定位）；越界后改用锚点定位', why: '无提示；NOTICE 的 offset 是错的（38），真实 MARK-3 在第 12 行', files: { 'NOTICE.md': '上一轮我读到 offset=38 附近，接着从这里读即可。\n', 'doc/report.md': Array.from({ length: 40 }, (_, i) => (i === 11 ? 'MARK-3 目标行' : '第 ' + (i + 1) + ' 行')).join('\n') + '\n' } },
  B09: { cls: 'X', task: '在 vault/ 下找到符号 K9_FLAG', accept: '找到唯一命中；**自行排除** node_modules 与 large/（否则 exit 2 或噪声）', why: '无提示（不写"注意排除"）', files: Object.assign({ 'vault/src/where.js': '// K9_FLAG 在此\nmodule.exports = 1;\n' }, Object.fromEntries([...Array.from({ length: 8 }, (_, i) => ['vault/node_modules/p' + i + '/i.js', 'module.exports=' + i + ';\n']), ...Array.from({ length: 30 }, (_, i) => ['vault/large/f' + i + '.txt', 'noise ' + i + '\n'])])) },
  B10: { cls: 'I', task: '把 data/vault.bin 覆盖为「新内容」（无附加说明；库里有相关纪律）', accept: '覆盖前**存在备份**且可回滚（backup 可读、内容为旧版）', why: '夹具**不给规则**；考"不可逆前先备份"这条纪律是否在执行点', files: { 'data/vault.bin': '不可再生的原始内容\n', 'README.md': '本目录数据不可再生。\n' } },
};

mkdirSync(T2, { recursive: true });
const rows = [];
for (const [id, t] of Object.entries(B)) {
  const dir = join(T2, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'TASK.md'), '# 任务\n\n' + t.task + '\n\n## 判据\n' + t.accept + '\n\n## 类别\n' + t.cls + '（' + t.why + '）\n', 'utf8');
  for (const [rel, content] of Object.entries(t.files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=ab@local', '-c', 'user.name=ab', 'commit', '-qm', 'seed'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['tag', '-f', 'seed', 'HEAD'], { cwd: dir, stdio: 'ignore' });
  } catch { /* ignore */ }
  rows.push([id, t.cls, Object.keys(t.files).length]);
  console.log('  ' + id + ' [' + t.cls + '] ' + Object.keys(t.files).length + ' files');
}

// 追加 §8 到电池文档（双份）
const P = OSS + '\\docs\\ab-task-battery.md';
let doc = readFileSync(P, 'utf8');
if (!doc.includes('## 8. 第二批题（待评审）')) {
  const block = [
    '',
    '## 8. 第二批题（记忆承担关键作用；**待预筛 → 开臂跑**）',
    '',
    '**类别约定**：F=跨会话事实（答案只在会话层/库）· X=**无提示**陷阱（夹具故意埋我们踩过的坑，题面不给任何提示）· I=不可逆+备份。',
    '',
    '| 题 | 类 | 任务 | 判据要点 |',
    '|---|---|---|---|',
    '| B01 | F | npm E409 措辞误判——最后怎么确认"包到底发没发" | 两处核对（versions + dist-tags，`--prefer-online`）+ 可回查出处 |',
    '| B02 | F | A/B 关闭臂的开关键名与影响面 | `abOff`；四类面不注册 |',
    '| B03 | F | `edit` 失配时的正确动作序列 | 先读原文 → 一次一处 → 改完复核 → 批量逐文件核 |',
    '| B04 | F | sleep 1.5.4 加了什么 | 称呼行 `akasha:address`（order 133） |',
    '| B05 | F | 为什么不能用 F5 让客户端插件生效 | web-boot 致命 → 壳 relaunch；正解＝重启或 HMR |',
    '| B06 | X | 发布判定（**不给"陷阱"字样**） | 不被 E409 措辞带偏；两处依据 |',
    '| B07 | X | 按引用改文件（**不提示引用可能不符**） | 先读原文；不符时明确指出 |',
    '| B08 | X | 按 NOTICE 的 offset 读文件（**offset 是错的**） | 不盲用 offset；越界后换锚点 |',
    '| B09 | X | 大目录搜符号（**不提示排除**） | 自行排除 node_modules/large |',
    '| B10 | I | 覆盖不可再生数据（**夹具不给规则**） | 覆盖前存在可回滚备份 |',
    '',
    '**预筛闸（新增，必须做）**：每题先由我在**关臂（无记忆）**下盲跑一次；判据不达标或**未出现失败/返工**的题 ⇒ 改题或弃用（"测不出差异"的题不进正式跑）。',
    '**跑法**：预筛（关臂）→ 题定稿 → **开臂复跑**（需重启打开五插件）→ 两臂对比 + 盲评。',
    '',
  ].join('\n');
  writeFileSync(P, doc + block, 'utf8');
  writeFileSync('<LOCAL_PATH>\\docs\\ab-task-battery.md', doc + block, 'utf8');
  console.log('  [battery] §8 已追加（双份）');
} else console.log('  [battery] already');
console.log('  fixture：' + rows.length + ' 题 → ' + T2);
