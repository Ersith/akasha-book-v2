// measure-recall.mjs —— 拿「推演出阿卡夏之书的那段」做装载上限实测（只读）。
// 量三件事：① 每次查询能拿多少（字符/token/段数）；② 读完整个结论层要几次查询；③ 覆盖与保真入口。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const NODE = '<DSH_INSTALL>';
const AK = '<AKASHA_DIR>/akasha.mjs';
const SID8 = 'f362b992';
const tok = (chars) => Math.round(chars * 1.18);   // 中文经验换算（≈1.18 tok/字）

// ① 语料基准
const rows = readFileSync('<AKASHA_DIR>/data/session.jsonl', 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .filter((r) => String(r.session || '').includes(SID8));
const concl = rows.filter((r) => String(r.kind) === 'conclusion');
const totalChars = rows.reduce((n, r) => n + String(r.gist || '').length, 0);
const conclChars = concl.reduce((n, r) => n + String(r.gist || '').length, 0);
console.log('【基准】' + SID8 + '：' + rows.length + ' 段 / ' + totalChars + ' 字符（≈' + Math.round(tok(totalChars) / 1000) + 'K tok）');
console.log('        结论层 ' + concl.length + ' 条 / ' + conclChars + ' 字符（≈' + Math.round(tok(conclChars) / 1000) + 'K tok）');
const fullSid = String(rows[0].session || '');
console.log('        完整会话名 = ' + fullSid);

// ② 会话层的上下文包（正确会话名 + 预算）
for (const b of [2048, 4096, 8192]) {
  let out = '';
  try {
    out = execFileSync(NODE, [AK, 'session', 'context', '--session', fullSid, '--budget', String(b)], { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (e) { out = '（失败：' + String(e).slice(0, 80) + '）'; }
  console.log('  [session context --budget ' + b + '] → ' + out.length + ' 字符（≈' + tok(out.length) + ' tok）');
  const first = out.split('\n')[0] || '';
  console.log('     ' + first.slice(0, 120));
}

// ③ 关键字查询的每次收获与累计覆盖
const Qs = ['库无界', '装载有界', '六库', '来源态', '排序', '定价', '睡眠', '孤案', '镜像', '门控', '机械钩子', '蒸馏', '双通路', '目录', '论文'];
const seen = new Set();
let calls = 0, chars = 0;
const perCall = [];
for (const q of Qs) {
  let out = '';
  try { out = execFileSync(NODE, [AK, 'session', 'lookup', q], { encoding: 'utf8', maxBuffer: 1 << 26 }); } catch { out = ''; }
  calls++; chars += out.length;
  const ids = [...out.matchAll(/seg-[0-9a-f]{8}-[0-9a-z-]+/g)].map((m) => m[0]);
  const before = seen.size;
  for (const id of ids) seen.add(id);
  perCall.push({ q, chars: out.length, ids: ids.length, fresh: seen.size - before });
  console.log('  「' + q + '」 ' + String(out.length).padStart(5) + ' 字符（≈' + String(tok(out.length)).padStart(5) + ' tok）'
    + ' · 命中 ' + String(ids.length).padStart(2) + ' 段 · 新增 ' + String(seen.size - before).padStart(2) + ' 段 · 累计去重 ' + seen.size);
}
console.log('【每次查询】平均 ' + Math.round(chars / calls) + ' 字符（≈' + tok(Math.round(chars / calls)) + ' tok）· 平均命中 '
  + (perCall.reduce((n, x) => n + x.ids, 0) / calls).toFixed(1) + ' 段 · 平均新增 ' + (seen.size / calls).toFixed(1) + ' 段');
console.log('【覆盖】' + calls + ' 次查询共见到 ' + seen.size + ' 个段 id（结论层共 ' + concl.length + ' 条）⇒ 覆盖率 '
  + (100 * seen.size / concl.length).toFixed(0) + '%（注：id 计数含非结论段，仅作量级参考）');
console.log('【推算】若按每次 ≈' + tok(Math.round(chars / calls)) + ' tok 计：结论层 ' + Math.round(tok(conclChars)) + ' tok ⇒ 理论最少 '
  + Math.ceil(tok(conclChars) / 4096) + ' 次（4096 tok/次上限）；实际按"每次新增 ' + (seen.size / calls).toFixed(1) + ' 段"计 ⇒ 约 '
  + Math.ceil(concl.length / Math.max(1, seen.size / calls)) + ' 次才能覆盖一轮全部结论段');
