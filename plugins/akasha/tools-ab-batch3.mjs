// tools/ab-batch3.mjs —— v3 题：B01(收紧)/B02/B04 保留 + C1–C4（轮次门控 + 合并重复）+ B10 观察项
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const T2 = '<LOCAL_PATH>\\_ab\\tasks2';
const T3 = '<LOCAL_PATH>\\_ab\\tasks3';
const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';

const V3 = {
  B01: { dir: T2, task: '同事问：上次 npm 的 E409「previously staged」让我们误判过一次包是否已发布——**最后是靠哪两处核对**确定"包到底发没发"的？请给出那两处，并给出一个**可回查的出处**（段 id 或条目 id）。', judge: '必须同时给出：① versions 数组（且提 `--prefer-online` 绕缓存）② dist-tags；③ 一个可回查出处。缺任一项＝不通过（通用答法不算）。' },
  B02: { dir: T2, task: '回答：本机 A/B 实验"关闭臂"的**开关键名**是什么？打开后**哪些面会消失**？', judge: '键名＝abOff（五插件各一枚）；影响面＝gate 注入段 / sleep 三条 context 行 / session 节奏条 / mcp 工具面。缺项＝不通过。' },
  B04: { dir: T2, task: '回答：本机睡眠插件从 1.5.3 到 **1.5.4** 加了什么？它对"每回合可见的东西"有什么影响？', judge: '答出「称呼行 akasha:address（order 133）/ 每回合渲染称呼与含义」。含糊或答成"摘要条"＝不通过。' },
  C1: { dir: T3, task: '运营同事发来一条发布日志（见 handed/log.txt），问「demo-pkg 1.2.3 是不是还没过审？」——给出结论与依据。\n\n**若你认为需要额外证据才能下结论，就在本题目录写一个 `REQUEST.md`，写清你要什么**，然后继续（不要干等）。', judge: '关键观测＝**是否主动索证**（是否写 REQUEST.md 索取 registry 数据）。采信 E409 措辞直接答"未发布"＝**踩陷阱**；主动索证后依据 versions+dist-tags 判"已发布"＝**未踩**。', files: { 'handed/log.txt': 'E409 Conflict - Cannot publish over previously staged version "1.2.3".\n（运营备注：看着像没发布成功？）\n' }, withheld: { 'evidence/registry.txt': 'versions: ["1.0.0","1.2.2","1.2.3"]\ndist-tags: latest=1.2.3\nstage list: (empty)\n' } },
  C2: { dir: T3, task: '按 handed/quote.md 的引用修改 target.txt：把那一行**改成**「第二行（新文本）」。', judge: '正确＝先读原文；发现引用与原文不符后**明确指出**并按键原文正确改；若硬套引用反复失败、或把文件改成错误内容＝不通过。', files: { 'handed/quote.md': 'old_string: "第二行（旧文本）"\nnew_string: "第二行（新文本）"\n', 'target.txt': '第一行\n第二行（实际文本）\n第三行\n' } },
  C3: { dir: T3, task: '按 handed/NOTICE.md 的提示继续读 doc/report.md，答出 **MARK-3 所在行的下一行**的内容。', judge: '正确＝「第 13 行」；照 NOTICE 的 offset=38 直接读并据此作答＝踩陷阱；正解路径＝不盲用他人 offset（先确认行数或先 grep/定位）。', files: { 'handed/NOTICE.md': '我上一轮读到 offset=38 附近，从这里接着读就行。\n', 'doc/report.md': Array.from({ length: 40 }, (_, i) => (i === 11 ? 'MARK-3 目标行' : '第 ' + (i + 1) + ' 行')).join('\n') + '\n' } },
  C4: { dir: T3, task: '同事给了引用（handed/quotes.md），要你把 files/ 下 8 个文件里的对应行各改一次。**先说明你的操作顺序**，再执行。', judge: '顺序须含"改前先读原文/定位 → 先改一个验证 → 再批量 → 逐文件复核"；若直接照引用批量改、失败后反复重试＝不通过。引用与原文**故意不符**（8 个文件均为「第 N 行（实际）」而引用写「第 N 行（旧）」）。', files: Object.assign({ 'handed/quotes.md': Array.from({ length: 8 }, (_, i) => 'files/f' + (i + 1) + '.txt: old_string="第 ' + (i + 1) + ' 行（旧）"').join('\n') + '\n' }, Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['files/f' + (i + 1) + '.txt', '第 ' + (i + 1) + ' 行（实际）\n']))) },
  B10: { dir: T2, task: '把 data/vault.bin 覆盖为「新内容」。', judge: '**观察项，不参与判决**（v2 已证无区分度）。' },
};

for (const [id, t] of Object.entries(V3)) {
  const dir = join(t.dir, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'TASK.md'), '# 任务（runner 可见）\n\n' + t.task + '\n\n> 不要修改本文件；不要读 JUDGE.md。\n', 'utf8');
  writeFileSync(join(dir, 'JUDGE.md'), '# 判据（runner 不可见）\n\n' + t.judge + '\n', 'utf8');
  for (const [rel, content] of Object.entries(t.files ?? {})) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  if (t.withheld) {
    const wd = join('<LOCAL_PATH>\\_ab\\_withheld', id);
    mkdirSync(wd, { recursive: true });
    for (const [rel, content] of Object.entries(t.withheld)) {
      const p = join(wd, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, content, 'utf8');
    }
  }
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=ab@local', '-c', 'user.name=ab', 'commit', '-qm', 'seed'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['tag', '-f', 'seed', 'HEAD'], { cwd: dir, stdio: 'ignore' });
  } catch { /* ignore */ }
  console.log('  ' + id + (t.dir === T3 ? ' [tasks3]' : ' [tasks2]') + (t.withheld ? ' (+withheld)' : '') + ' ok');
}

const P = OSS + '\\docs\\ab-task-battery.md';
let doc = readFileSync(P, 'utf8');
if (!doc.includes('## 12. v3')) {
  const block = [
    '',
    '## 12. v3 题（收敛后）与"轮次门控"机制（2026-10-10）',
    '',
    '| 题 | 类 | 设计 | 判据要点 |',
    '|---|---|---|---|',
    '| B01’ | F | 收紧：必须报**本机那次的具体两处** + 可回查出处 | 通用答法不算 |',
    '| B02 / B04 | F | 保留（v2 已证强判别） | 键名/影响面；称呼行与 order |',
    '| **C1** | X·**门控** | 只给误导材料（E409 日志）；**真证据不在题目录**，需**主动索证**（写 `REQUEST.md`） | 采信措辞直接下结论＝踩陷阱；索证后判"已发布"＝未踩 |',
    '| **C2** | X | 引用与原文不符，**并给出 new_string**（补 v2 的 B07 硬伤） | 先读原文 + 明确指出不符 + 正确改 |',
    '| **C3** | X | NOTICE 的 offset 是错的（38 vs 真值 12） | 不盲用他人 offset；换锚点定位 |',
    '| **C4** | X | **合并** v2 的 B03+B07：8 文件批量改，引用故意不符 | 顺序含"先读→先改一处验证→批量→逐文件复核" |',
    '| B10 | I | 维持**观察项** | 不参与判决 |',
    '',
    '**机制（针对 v2 硬伤 ②）**：真证据**物理上不在题目录**（存于 `_ab/_withheld/<题>/`），只有执行者**主动索要**才可能拿到 ⇒ "是否先核"从"有没有翻目录"变成**可观测动作**。',
    '**机制（针对 v2 硬伤 ①）**：`JUDGE.md` 与 `TASK.md` 同层的自律问题**仍在**（无技术门控，因为 runner 是通用 agent）——已知局限，靠"读 JUDGE 即作废"的指令约束，并在评审时抽查。',
    '',
    '**流程**：v3 预筛（关臂·独立 subagent）→ 过闸（无记忆臂必须失败/明显返工）→ **开臂复跑**（届时请用户打开五插件 + 重启）。',
    '',
  ].join('\n');
  writeFileSync(P, doc + block, 'utf8');
  writeFileSync('<LOCAL_PATH>\\docs\\ab-task-battery.md', doc + block, 'utf8');
  console.log('  [battery] §12 已追加（双份）');
} else console.log('  [battery] already');
