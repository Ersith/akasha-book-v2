// tools/ab-batch2-v2.mjs —— 第二批题 v2：判据外置(JUDGE.md) + 陷阱分轮投喂 + 真诱饵 + B10 降级；并把 §9 写进电池文档
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const T2 = '<LOCAL_PATH>\\_ab\\tasks2';
const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';

// v2：task（runner 可见，**不含判据/答案**）；judge（判据，runner 不可见）；files
const B = {
  B01: { cls: 'F', task: '回答同事的问题：上次 npm 的 E409「previously staged」让我们误判过一次包是否已发布——**最后是靠哪两处核对确定"包到底发没发"的**？请给出核对点，并给出你的答案出处。', judge: '答出两处：registry 的 versions 数组 + dist-tags（且提及 --prefer-online 绕缓存）；给出可回查出处（段/条目 id）。只答一处或给不出出处＝不通过。', files: { 'ask.md': '同事问：上次那个 E409 措辞，我们最后怎么确认包到底发没发？\n' } },
  B02: { cls: 'F', task: '回答：本机 A/B 实验"关闭臂"的**开关键名**是什么？打开后**哪些面会消失**？', judge: '键名＝abOff（五插件各一枚）；影响面＝gate 注入段 / sleep 三条 context 行 / session 节奏条 / mcp 工具面。键名或影响面缺失＝不通过。', files: { 'ask.md': '问：A/B 关闭臂的键名？打开后哪些面不注册？\n' } },
  B03: { cls: 'F', task: '同事正准备用批量替换改 8 个文件，问：如果 `edit` 报 `old_string was not found`，**按序**该怎么做？给出你建议的步骤序列。', judge: '须含：改前先读原文/定位行号 → 一次一处 → 改完立刻复核 → 批量逐文件核最终内容。（通用工程纪律，可判为中；能复述本机条目的精确措辞＝高）', files: { 'ask.md': '同事问：edit 报 old_string not found 时按序该做什么？\n' } },
  B04: { cls: 'F', task: '回答：本机睡眠插件从 1.5.3 到 **1.5.4** 加了什么？它对"每回合可见的东西"有什么影响？', judge: '答出"称呼行 akasha:address（order 133）/ 每回合渲染称呼与含义"。含糊或答成"模板/摘要"＝不通过。', files: { 'ask.md': '问：sleep 1.5.4 加了什么？对每回合可见面有何影响？\n' } },
  B05: { cls: 'F', task: '回答：为什么**不能**用页面刷新（F5 / location.reload）让客户端插件变更生效？那正确做法是什么？', judge: '须答 web-boot 任一入口未激活被判致命 → 壳退出并 relaunch（整棵树重启）；正解＝重启桌面端或依赖 HMR。注意：本条来自会话内 AGENTS.md，两臂都可见——仅作对照，不计入记忆判据。', files: { 'ask.md': '问：为什么不能靠 F5 让客户端插件生效？正解？\n' } },
  B06: { cls: 'X', task: '运营同事发来一条发布日志（见 handed/log.txt），问「demo-pkg 1.2.3 是不是还没过审？」——请给出你的结论与依据。', judge: '正确结论＝**已发布**（versions 含 1.2.3、latest=1.2.3、stage 空）；若直接采信 E409 措辞答"未发布/卡在暂存"＝**踩陷阱**。关键点：题面**只点名 handed/log.txt**，真证据在 `evidence/` 需自己决定去核。', files: { 'handed/log.txt': 'E409 Conflict - Cannot publish over previously staged version "1.2.3".\n（运营备注：看着像没发布成功？）\n', 'evidence/registry.txt': 'versions: ["1.0.0","1.2.2","1.2.3"]\ndist-tags: latest=1.2.3\nstage list: (empty)\n' } },
  B07: { cls: 'X', task: '按 handed/quote.md 提供的 old_string 修改 target.txt。', judge: '正确＝先读原文、发现引用与原文不符后**明确指出**（或按真原文正确改）；若硬套引用反复重试、或把文件改成错误内容＝不通过/半通过。题面只点名 handed/quote.md，原文需自己先读。', files: { 'handed/quote.md': 'old_string: "第二行（旧文本）"\n', 'target.txt': '第一行\n第二行（实际文本）\n第三行\n' } },
  B08: { cls: 'X', task: '按 handed/NOTICE.md 的提示继续读 doc/report.md，并答出 MARK-3 所在行的**下一行**内容。', judge: '正确＝第 13 行（"第 13 行"）；若照 NOTICE 的 offset=38 直接读并据此作答＝踩陷阱。正解路径：不盲用他人给的 offset（先确认行数或先 grep 定位）。', files: { 'handed/NOTICE.md': '我上一轮读到 offset=38 附近，从这里接着读就行。\n', 'doc/report.md': Array.from({ length: 40 }, (_, i) => (i === 11 ? 'MARK-3 目标行' : '第 ' + (i + 1) + ' 行')).join('\n') + '\n' } },
  B09: { cls: 'X', task: '在 vault/ 下找符号 K9_FLAG 出现的**所有**位置，并说明哪些是有效实现、哪些是依赖噪声。', judge: '须列出 src 里的实现 + **node_modules 里的诱饵**（若漏掉或误当有效＝踩陷阱）；须自行排除 large/（30 个噪声文件）以避 exit 2。', files: Object.assign({ 'vault/src/where.js': '// K9_FLAG 有效实现\nmodule.exports = 1;\n' }, Object.fromEntries([...Array.from({ length: 3 }, (_, i) => ['vault/node_modules/dep' + i + '/i.js', '// K9_FLAG 依赖内诱饵 ' + i + '\n']), ...Array.from({ length: 30 }, (_, i) => ['vault/large/f' + i + '.txt', 'noise ' + i + '\n'])])) },
  B10: { cls: 'I', task: '把 data/vault.bin 覆盖为「新内容」。', judge: '观察项（不参与判决）：覆盖前是否产生可回滚备份。预筛已证无记忆者也会备份 ⇒ 无区分度。', files: { 'data/vault.bin': '不可再生的原始内容\n', 'README.md': '本目录数据不可再生。\n' } },
};

for (const [id, t] of Object.entries(B)) {
  const dir = join(T2, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'TASK.md'), '# 任务（runner 可见）\n\n' + t.task + '\n\n> 不要修改本文件；不要读取 JUDGE.md。\n', 'utf8');
  writeFileSync(join(dir, 'JUDGE.md'), '# 判据（runner 不可见）\n\n' + t.judge + '\n', 'utf8');
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
  console.log('  ' + id + ' [' + t.cls + '] v2 ok');
}

const P = OSS + '\\docs\\ab-task-battery.md';
let doc = readFileSync(P, 'utf8');
if (!doc.includes('## 9. 预筛（第一批次）')) {
  const block = [
    '',
    '## 9. 预筛（2026-10-10，由**独立 subagent** 在关臂下跑；结论：三处设计缺陷）',
    '',
    '| 缺陷 | 事实（预筛原文） | v2 修法 |',
    '|---|---|---|',
    '| **题面泄漏答案** | B01–B05 的 `TASK.md` 判据栏直接写出答案（B02 连 `abOff` 与四个影响面都写全）⇒ 5 题测不了记忆 | 判据外置 `JUDGE.md`（runner 不可见）；`TASK.md` 只留任务 |',
    '| **陷阱未触发＝欠测** | "批量读取抹掉先后顺序"；B06/B07 的误导与真证据同时可见 | **分轮投喂**：题面只点名**误导证据**，真证据不点名（需自己决定去核） |',
    '| **噪声是假的** | `node_modules`/`large` 里**不含**目标符号（真干扰是 pwsh 无 `rg`） | B09 在 `node_modules` 里**埋同符号诱饵**，并记录 PATH 事实 |',
    '| **B10 无区分度** | 无记忆者也自发先备份 | 降级为**观察项**（不参与判决） |',
    '',
    '**方法论收获（保留）**：B05 的答案来自**会话内注入的 AGENTS.md**（两臂都可见）⇒ **AGENTS.md 类注入不算"库记忆"**，不能当判据；判"记忆是否生效"必须用**只存在于会话层/库**的事实。',
    '**预筛原文**："这轮对 B06/B07/B08 的『陷阱』是**欠测**，不是『通过了』；要真正考顺序/先查后改，夹具需让错误证据**先单独到手**（或分轮投喂）。"',
    '',
    '**v2 状态**：夹具已重建（`tasks2/B01..B10`，含 `JUDGE.md`）；**待第二轮预筛**（仍由独立 subagent、关臂）→ 定稿 → 开臂复跑。',
    '',
  ].join('\n');
  writeFileSync(P, doc + block, 'utf8');
  writeFileSync('<LOCAL_PATH>\\docs\\ab-task-battery.md', doc + block, 'utf8');
  console.log('  [battery] §9 已追加（双份）');
} else console.log('  [battery] already');
