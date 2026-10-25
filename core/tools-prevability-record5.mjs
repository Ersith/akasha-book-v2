// prevability-record5.mjs —— §14：4 条补料结果 + 反事实口径的诚实结论 + 事故记录
import { readFileSync, writeFileSync } from 'node:fs';
import { loadStore, currentRecords, revise } from './lib.mjs';

const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const P = OSS + '\\docs\\recall-preventability-test-plan.md';
const t = readFileSync(P, 'utf8');
if (!t.includes('## 14.')) {
  const block = [
    '',
    '## 14. 补料（4 条）与"反事实回测"的诚实结论（2026-10-10）',
    '',
    '**已补并验证**（均为**可执行条目**：触发 / 正确动作 / 反例 / 自检问句）：',
    '- `canon-trap-read-offset-range`（read 越界：先 grep 拿真实行号）',
    '- `canon-trap-grep-exit2-path`（rg exit 2：换浅范围/排除重目录/权限类换副本）',
    '- `canon-trap-unknown-tool-name`（未知工具名：只从本会话可见工具面选，先单工具试）',
    '- `canon-trap-provider-method-list`（宿主方法臆测：先 list 再调）',
    '四条模板问句**全部命中**（验证通过）；`RECALL_TRAP_MAP` 现覆盖 **11** 个工具；核心套件 **140/140**。',
    '',
    '**反事实回测（不采信其机器数）**：忽略时间过滤跑同一批 49 条，机器判"有覆盖性强命中"= **48/49（98%）**——**这个数不可信**：',
    '查询词含"坑"这类通用 token，会命中**主题相关但无因果覆盖**的条目（步 4 校准批已证：机器初筛真阳性 0/15）。',
    '⇒ **结论**：反事实同样**必须人工按"覆盖"准则判定**，机器数只能当"待判清单"，不能当结果。**当前可信的结论仍是步 4 那条**：修正口径下**可预防集合 ≈ 0（历史）**，补料的价值在**未来**（A/B 与 C1 有了可测目标）。',
    '',
    '**事故记录（自查，2026-10-10）**：补料脚本用兜底 `replace("});")` 命中 lib.mjs 中**第一处** `});`（非映射表尾），写坏核心库 ⇒ 套件 3/82 ✗；**靠套件当场发现**，从 git 恢复后改用精确锚点重打，全绿。',
    '**教训**：① **禁止盲替换通用符号**（`});`、`}`），必须用唯一上下文锚点；② **每次写入核心库后立刻跑套件**——这次正是套件把事故拦住。',
    '',
  ].join('\n');
  writeFileSync(P, t + block, 'utf8');
  writeFileSync('<LOCAL_PATH>\\docs\\recall-preventability-test-plan.md', t + block, 'utf8');
  console.log('  [plan] §14 已追加（双份）');
} else console.log('  [plan] already');

const recs = currentRecords(loadStore('canon').records);
const hit = recs.filter((r) => String(r.id).startsWith('canon-observation-ledger-20261010')).pop();
const marker = '**补料 4 条 + 反事实口径（2026-10-10）**';
if (String(hit.claim).includes(marker)) { console.log('  [canon] already'); process.exit(0); }
const add = ' ' + marker + '：① 补 4 条可执行条目（`canon-trap-read-offset-range` / `grep-exit2-path` / `unknown-tool-name` / `provider-method-list`），四条模板问句**全部命中**，映射表覆盖 **11** 工具，套件 **140/140**；② **反事实机器回测 48/49（98%）不可采信**——通用 token 造成"主题相关但无覆盖"的假阳性（与步 4 校准批真阳性 0/15 同源）⇒ 反事实**必须人工判定**；可信结论仍是"历史可预防集合 ≈ 0、补料价值在未来"；③ **事故自查**：补料脚本兜底 `replace("});")` 命中文件第一处 `});`，写坏核心库（套件 3/82），靠套件当场发现、从 git 恢复后精确重打全绿 ⇒ **教训：禁止盲替换通用符号、核心库写入后必跑套件**。';
const next = revise('canon', hit.id, { claim: hit.claim + add, last_reviewed: '2026-10-10' });
console.log('  [canon] ' + hit.id + ' → ' + next.id);
