// hint-backfill.mjs —— 给「陷阱条目」回填 `hint`（≤80 字的反射文本），使 C1 的提示**随条目走**。
// 背景（2026-10-11 用户裁定）：反射要能随工程知识纠错与优化 ⇒ 反射文本必须由条目携带（改条目＝改反射），
//   代码里的兜底表降级为"库不可读时"的过渡兼容。
// 用法：node tools/hint-backfill.mjs [--dry]
import { currentRecords, loadStore, revise, todayLocal } from './lib.mjs';

const dry = process.argv.includes('--dry');

// 反射文本：与条目 claim 的"触发/动作"一致，收在 ≤80 字（超了就在装载时截断，见 preflight）
const HINTS = {
  'canon-trap-edit-context-mismatch': '先 read 原文再改、改完复核',
  'canon-trap-read-offset-range': '先用 grep 拿真实行号再读',
  'canon-trap-grep-exit2-path': '换浅范围/排除 node_modules 再 grep',
  'canon-trap-unknown-tool-name': '只从本会话可见工具面选名字',
  'canon-trap-provider-method-list': '先列方法清单再调用',
  'canon-trap-pwsh-inline-js': '多行脚本落文件再跑（别塞内联）',
};

const cur = currentRecords(loadStore('canon').records);
const today = todayLocal();
let done = 0, skipped = 0, missing = [];
for (const [id, hint] of Object.entries(HINTS)) {
  if (hint.length > 80) { console.log('  ⚠ 反射文本超 80 字：' + id); }
  const rec = cur.filter((r) => String(r.id) === id || String(r.id).startsWith(id + '-r')).pop();
  if (!rec) { missing.push(id); continue; }
  if (typeof rec.hint === 'string' && rec.hint === hint) { skipped++; console.log('  = 已是最新：' + id); continue; }
  console.log('  ' + (dry ? '[dry] ' : '') + '写 hint → ' + id + '：' + hint);
  if (!dry) revise('canon', rec.id, { hint, last_reviewed: today });
  done++;
}
console.log('回填完成：写入 ' + done + '，已是最新 ' + skipped + '，条目缺失 ' + missing.length + (missing.length ? '（' + missing.join(', ') + '）' : ''));
