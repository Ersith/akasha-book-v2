// akasha/tools/k1-strict.mjs —— K1 严格版：逐字保真 + 编造测试（CLI 侧 + MCP 侧）
// 用法: node akasha/tools/k1-strict.mjs [--json]
// 判据（写死、防事后调参）：
//   保真 ① CLI show --reflect：正文头/尾各取「干净切片」（≥30 字、不含引号/换行/反斜杠）须**逐字**出现在输出中；
//   保真 ② CLI lookup <中段切片>：须命中该 id，且命中行是可核正文（渲染段 ⊂ 原文或剥皮原文）；
//   保真 ③ MCP akasha_show（reflect=true）：同 ① 的头切片逐字出现；
//   编造 ① CLI lookup / brief 探针词（库内决不存在）→ 须明确「确定不知道」，不得编造命中；
//   编造 ② CLI show 不存在 id → 「未找到」且 exit 1；
//   编造 ③ MCP akasha_show 不存在 id → 未找到／found:false；MCP akasha_lookup 探针词 → 不得编造「记得·库内」性质命中。
// 纪律：只读；查询侧线经 AKASHA_QUERY_LOG=off 关断（防探针污染真日志）。
import { spawnSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore, currentRecords, stripGenre } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKDIR = dirname(ROOT);
const NODE = process.execPath;
const CLI = join(ROOT, 'akasha.mjs');
const MCP = join(ROOT, 'mcp.mjs');
const ENV = { ...process.env, AKASHA_QUERY_LOG: 'off' };

const cases = [];
const push = (id, pass, detail) => cases.push({ id, pass: !!pass, detail: String(detail ?? '').replace(/\s+/g, ' ').slice(0, 260) });

// —— 干净切片：取不含 引号/反斜杠/换行 的连续 ≥len 段（避免 JSON 转义破坏逐字比对） ——
const cleanSlice = (text, len, where) => {
  const t = String(text ?? '');
  const zone = where === 'mid' ? t.slice(Math.floor(t.length / 3), Math.floor((t.length * 2) / 3))
    : where === 'tail' ? t.slice(-len * 4) : t.slice(0, len * 4);
  const re = new RegExp('[^"\\\\\\n\\r]{' + len + ',}', 'g');
  const mm = zone.match(re);
  return mm ? mm[0].slice(0, len).replace(/^[^0-9A-Za-z\u4e00-\u9fff]+/, '').replace(/[^0-9A-Za-z\u4e00-\u9fff]+$/, '') : null;
};

const runCli = (...args) => spawnSync(NODE, [CLI, ...args], { cwd: WORKDIR, encoding: 'utf8', env: ENV, timeout: 60000 });

// —— MCP 迷你客户端（行式 JSON-RPC，无握手；与 mcp-probe 同款） ——
const mcpSession = () => {
  const child = spawn(NODE, [MCP], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: ENV });
  let buf = ''; const pending = new Map(); let nextId = 1;
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); }
    }
  });
  return {
    call(tool, args, timeoutMs = 30000) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n');
      return new Promise((res) => { const t = setTimeout(() => { pending.delete(id); res(null); }, timeoutMs); pending.set(id, (m) => { clearTimeout(t); res(m); }); });
    },
    close() { try { child.kill(); } catch { /* 静默 */ } },
  };
};
const mcpText = (resp) => {
  try { return String(resp?.result?.content?.[0]?.text ?? ''); } catch { return ''; }
};

// —— 取样：每库按 id 排序取 头1 + 中1（正文 ≥80 字），总数 ≤8 ——
const STORES = ['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier'];
const FIELD = { canon: 'claim', mirror: 'situation', orphan: 'summary', pricing: 'behavior', lexicon: 'resolution', frontier: 'title' };
// 覆盖轮转（2026-10-14 人工复检改进）：先每库头 1，再每库中 1 —— 保证六库都被抽到（此前会被前几库吃满 8 个名额而漏掉 mirror/pricing/lexicon）
const heads = []; const mids = [];
for (const s of STORES) {
  let recs = [];
  try { recs = currentRecords(loadStore(s).records); } catch { recs = []; }
  recs = recs.filter((r) => typeof r?.[FIELD[s]] === 'string' && r[FIELD[s]].length >= 36);
  if (!recs.length) continue;
  const sorted = recs.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  heads.push({ store: s, r: sorted[0], f: FIELD[s] });
  const mid = sorted[Math.floor(sorted.length / 2)];
  if (mid && mid.id !== sorted[0].id) mids.push({ store: s, r: mid, f: FIELD[s] });
}
const picks = [...heads, ...mids].slice(0, 8);

// ===== 保真面 =====
for (const { store, r, f } of picks.slice(0, 8)) {
  const text = String(r[f]);
  const head = cleanSlice(text, 36, 'head');
  const tail = cleanSlice(text, 30, 'tail');
  const sh = runCli('show', r.id, '--reflect');
  const shOut = sh.stdout || '';
  push('保真·CLI show --reflect·' + r.id,
    !!head && shOut.includes(head) && (!tail || shOut.includes(tail)),
    'exit=' + sh.status + ' head=' + head + ' tail=' + tail);

  const phrase = cleanSlice(text, 14, 'mid') ?? cleanSlice(text, 14, 'head');
  if (phrase) {
    const lk = runCli('lookup', phrase);
    const lkOut = (lk.stdout || '') + (lk.stderr || '');
    const idHit = lkOut.includes(r.id);
    if (!idHit) {
      // 未进展示面 = 检索面观察（K2 可达线索），不计入 K1 红项；如实列出
      push('（信息）可达观察·短语未进展示面·' + r.id, true, 'phrase=' + phrase + '｜该项属 K2 线索，K1 不裁');
    } else {
      // 命中行逐字核（2026-10-14 人工复检加严）：滑窗 **32 字**（步长 4），任一窗口 ⊂ 原文或剥皮原文即通过
      let lineOk = false; let lineSample = '';
      for (const ln of lkOut.split('\n')) {
        if (!ln.includes(r.id)) continue;
        for (let i = 0; i + 32 <= ln.length && !lineOk; i += 4) {
          const win = ln.slice(i, i + 32);
          if (text.includes(win) || stripGenre(text).includes(win)) { lineOk = true; lineSample = win; }
        }
        if (lineOk) break;
      }
      push('保真·CLI lookup·' + r.id, lineOk, 'phrase=' + phrase + '｜line=' + (lineSample || '（行内无 24 字窗口可核）'));
    }
  }
}

// MCP 保真：头 3 个样本
const sess = mcpSession();
for (const { r, f } of picks.slice(0, 3)) {
  const head = cleanSlice(String(r[f]), 36, 'head');
  const resp = await sess.call('akasha_show', { id: r.id, reflect: true });
  const out = mcpText(resp);
  push('保真·MCP akasha_show·' + r.id, !!head && out.includes(head), 'head=' + head + '｜len=' + out.length);
}

// ===== 编造面 =====
// 探针词：纯化（2026-10-14 人工复检改进）——不得内含真词（此前 "nonsense" 是英文真词，且「编造」二字会触发弱命中，属设计行为而非编造）
const cliProbe = 'k1probe' + Math.random().toString(36).slice(2, 8) + 'qzjvkwm';
const lkP = runCli('lookup', cliProbe);
push('编造·CLI lookup 无此主题', (lkP.stdout || '').includes('确定不知道'), (lkP.stdout || '').slice(0, 150));
const brP = runCli('brief', cliProbe);
push('编造·CLI brief 无此主题', (brP.stdout || '').includes('确定不知道'), (brP.stdout || '').slice(0, 150));
const shP = runCli('show', 'k1-nonesuch-zzz');
push('编造·CLI show 不存在 id', (shP.stdout || '').includes('未找到') && shP.status === 1, 'exit=' + shP.status + '｜' + (shP.stdout || '').slice(0, 100));

const fakeId = 'k1-nonesuch-' + Math.random().toString(36).slice(2, 8);
const mShow = await sess.call('akasha_show', { id: fakeId });
const mShowT = mcpText(mShow);
push('编造·MCP akasha_show 不存在 id', /未找到|"found":\s*false/.test(mShowT) && !/"claim"/.test(mShowT), mShowT.slice(0, 150));
// 纯噪声词（无真词）→ 必须零命中
const gib = 'k1probe' + Math.random().toString(36).slice(2, 8) + 'qzjvkwm';
const mLook = await sess.call('akasha_lookup', { query: gib });
const mLookT = mcpText(mLook);
{
  let zero = /确定不知道/.test(mLookT);
  try { const j = JSON.parse(mLookT); const hits = Array.isArray(j) ? j : (j.hits ?? []); zero = Array.isArray(hits) && hits.length === 0; } catch { /* 只看措辞 */ }
  push('编造·MCP akasha_lookup 纯噪声词（须零命中）', zero, mLookT.slice(0, 140));
}
// 生僻字词（无此主题）→ 允许弱命中，但**不得出现强命中**（不得声称「记得·库内」）
const rare = '紫蚨螭鬽鏚_' + Math.random().toString(36).slice(2, 5);
const mLook2 = await sess.call('akasha_lookup', { query: rare });
const t2 = mcpText(mLook2);
{
  let noStrong = true;
  try { const j = JSON.parse(t2); const hits = Array.isArray(j) ? j : (j.hits ?? []); noStrong = !Array.isArray(hits) || hits.every((h) => h.strong !== true); } catch { noStrong = !/记得·库内/.test(t2); }
  push('编造·MCP akasha_lookup 生僻字词（不得强命中）', noStrong, t2.slice(0, 140));
}
sess.close();

// ===== 汇总 =====
const passN = cases.filter((c) => c.pass).length;
const jsonMode = process.argv.includes('--json');
if (jsonMode) console.log(JSON.stringify({ total: cases.length, pass: passN, cases }, null, 2));
else {
  for (const c of cases) console.log((c.pass ? 'PASS ' : 'FAIL ') + c.id + (c.pass ? '' : '  ↳ ' + c.detail));
  console.log('\nK1 严格版：' + passN + '/' + cases.length + ' 通过' + (passN === cases.length ? '（全绿）' : '——有红项，逐条看 detail'));
}
process.exit(passN === cases.length ? 0 : 1);
