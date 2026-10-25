#!/usr/bin/env node
// 审核面滞后检查（2026-10-16 建；2026-10-17 扩面：N1/N2/N3/N4；2026-10-17 批次12：D1 覆盖提示 / D2 files[] 越界 / D3 坏戳措辞 / D5 包内 scripts+test 入面；
//   2026-10-17 批次13：F1-A 装载件（cordis.patch.yml + package.json）入面 / F1-B "戳有面无"出声（只观测、不改判定）/ F2 覆盖提示两支都打 / F3-2 头注收口；
//   2026-10-17 批次14：F2 发版流程口径三条入头注（npm pack 不触发 / bump 应当红 / 同批审核 / 不豁免））
//
// 动机：门档原先只有**显式钩子**（等用户话里出现"审计/检查"关键词）。但改核心件、改测试、改判据这些
// 真正该开审核的时刻，用户不会说那些词 ⇒ 触发必须来自**自己的行为面**（事件/实体钩子）。
// 本工具是它的机械版：**改了核心件、而独立审核面没跟上 ⇒ 非零退出**。
//
// 判据（单一来源，只此一处）：
//   · 面（见 collect()）＝三块（**④⑤ 两个补充面归 `dsh-*/` 包块**，故 `--face` 仍打印三行计数），
//      **目录扫描为主、显式清单只作兜底**：
//       ① akasha/ 顶层 *.mjs（含 *.test.mjs）
//       ② akasha/tools/ 下全部代码件（递归；即 2026-10-17 前的头注所称"tools 全是核心件"——
//          当时实现只收 5 件（351 里 346 件在面外，头注与实现不符＝N3）⇒ 对齐到实现侧：全收）
//       ③ 各 **dsh-\*** 包（前缀 2026-10-17 从 `dsh-akasha-` 扩到 `dsh-`，N1①）：
//          包根代码件 + `lib/**` 递归 + `package.json` 的 `files[]` 展开（**随包发布面**——
//          `lib/prompt-safety.js`、`shared/*.mjs`、`servers/*.mjs` 这类此前整块在面外；
//          D2：`files[]` 项越出包目录（如 `../x.mjs`）**不入面**——否则既入面、`relOf` 又把它切成错路径）
//          ④ 包内 `scripts/**`、`test/**`（含 `.github/scripts/**`）的代码件（D5，批次12 裁定：**收**）
//             ——跨包一致性：`dsh-akasha-sleep/route.test.mjs` 在面内，而 `dsh-theme-endfield/test/*.test.js` 不在
//          ⑤ 各 `dsh-*` 包的**装载件**（F1-A，批次13）：`cordis.patch.yml`（profile 靠它挂插件）
//             + `package.json`（files[] / 依赖 / 版本＝改了会改行为）——**非代码件**，此前整块在面外；
//             而批次12 把戳重生成成"面"之后，面=代码件 × 戳=面 ⇒ 这类件**改盲 + 删盲**（verify-A2 §5 F1）。
//   · 发版流程口径（F2，批次14；装载件入面后，例行发版也会让工具红——先把判读口径钉在这里，免得下次复核把"红"当故障再查一遍）：
//       ① `npm pack` **不触发**（不写源字节）；而 **bump / 重写 `package.json`（及再生成含 `H:\` 绝对路径的 `cordis.patch.yml`）会红——且应当红**（版本决定装哪份 / `files[]` 决定发布面 / yml 决定挂不挂）；
//       ② 发版与代码**同批**走审核 + 收尾重生成戳（**不积压**）；
//       ③ **不加白名单豁免**（防 fail-open）。
//   · 审核面时间 = akasha/gate-out/REVIEW-STAMP.json 的 at（独立审核收尾时写入）
//                  文件不在 ⇒ SKIP；**at 不可解析 ⇒ 当作没有戳**（SKIP，N4：此前 Date.parse→NaN 会让
//                  整条 mtime 路径静默（m > NaN 恒 false）⇒ 工具报"无滞后"而戳其实已经坏了）
//                  两者皆无 ⇒ SKIP（可移植：OSS 仓/精简布局不误红）
//   · 滞后＝三种任一（N2 起为三种）：
//       ① **戳内**件 sha 与戳不符（精确：抓"审后又被改"）
//       ② **戳外**件 mtime > 覆盖下界（rt.atMs ⇒ 存量老件不误报，而**新件与下界后的改动**必报）
//       ③ 戳内件**已删除**且父目录仍在（N2："删除即隐形"此前 exit 0、且比 mtime 回拨更便宜；
//          父目录整块不存在 ⇒ 跳过，保可移植性）
// 退出码：0 = 无滞后（或 SKIP）；1 = 有滞后；2 = 内部错误
// 用法：node review-lag.mjs          判滞后（默认；消费者 gate.mjs / akasha-sleep 即此路径）
//       node review-lag.mjs --face   只打印本工具**自己认定的面清单**（自述，不判、不读戳）
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyStampChain } from './lib.mjs';   // 2026-10-17：戳链校验下沉到 lib（可被 test.mjs 直测）

const AK = resolve(dirname(fileURLToPath(import.meta.url)), '..');   // akasha/
const ROOT = resolve(AK, '..');                                      // 仓库根
const OUT = join(AK, 'gate-out');

const CODE = /\.(mjs|cjs|js)$/i;                                     // 代码件（*.test.mjs 亦在其内）
const PRUNE = new Set(['node_modules', '.git']);                     // 只剪依赖与元数据目录
const relOf = (f) => f.slice(ROOT.length + 1).replace(/\\/g, '/');

// 递归收代码件（存在性由调用方保证；目录不可读 ⇒ 静默跳过，可移植）
function walkCode(dir, out, depth = 0) {
  if (depth > 8) return;
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!PRUNE.has(e.name)) walkCode(p, out, depth + 1); }
    else if (CODE.test(e.name)) out.push(p);
  }
}

function collect() {
  const parts = { core: [], tools: [], pkgs: [] };

  // ① akasha/ 顶层 *.mjs
  for (const x of readdirSync(AK)) if (x.endsWith('.mjs')) parts.core.push(join(AK, x));

  // ② akasha/tools/**（目录扫描：新增件不再隐形）
  walkCode(join(AK, 'tools'), parts.tools);

  // ③ 各 dsh-* 包：包根代码件 + lib/** + files[]（随包发布）展开
  let nPkg = 0;
  if (existsSync(ROOT)) {
    for (const e of readdirSync(ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('dsh-')) continue;
      nPkg++;
      const base = join(ROOT, e.name);
      let rootEnts = []; try { rootEnts = readdirSync(base); } catch { rootEnts = []; }
      for (const x of rootEnts) if (CODE.test(x)) parts.pkgs.push(join(base, x));   // index.js / server.mjs / prompt-safety.js / *.test.mjs …
      const libDir = join(base, 'lib');
      if (existsSync(libDir)) walkCode(libDir, parts.pkgs);                        // lib/**（含 lib/prompt-safety.js）
      const pj = join(base, 'package.json');
      if (existsSync(pj)) {
        let fl = null; try { fl = JSON.parse(readFileSync(pj, 'utf8')).files; } catch { fl = null; }
        for (const raw of Array.isArray(fl) ? fl : []) {                           // 随包发布面（shared/ servers/ client/ …）
          const t = join(base, raw);
          if (!t.startsWith(base + sep)) continue;   // D2：`files[]` 越界（../）不入面（否则 relOf 会切出错误路径）
          if (CODE.test(raw)) { if (existsSync(t)) parts.pkgs.push(t); }
          else if (existsSync(t)) { try { if (statSync(t).isDirectory()) walkCode(t, parts.pkgs); } catch { /* ignore */ } }
        }
      }
      // ④ 包内脚本 / 测试（D5，批次12 裁定：收）——此前只有"随包发布面"⇒ 同类件跨包两等待遇
      //   （`dsh-akasha-sleep/route.test.mjs` 在面内，而 `dsh-theme-endfield/test/*.test.js` 不在）
      for (const sub of ['scripts', 'test', '.github/scripts']) walkCode(join(base, sub), parts.pkgs);
      // ⑤ 装载件（F1-A，批次13）：`cordis.patch.yml`（挂插件的装载配置）+ `package.json`（files[]/依赖/版本）
      //   ——非代码件，但"改了会改行为"；批次12 把戳重生成成面之后，这两类件的改与删**都判不出**（verify-A2 §5 F1）。
      //   显式枚举 + 存在性检查（不递归、不猜后缀）；与 ③ 块同归 `dsh-*/` 包块，`--face` 计数行数不变。
      for (const x of ['cordis.patch.yml', 'package.json']) { const t = join(base, x); if (existsSync(t)) parts.pkgs.push(t); }
    }
  }

  const seen = new Set(); const marks = [];
  for (const [k, arr] of [['akasha/ 顶层 *.mjs', parts.core], ['akasha/tools/**', parts.tools], [`dsh-*/ 包（${nPkg} 个）`, parts.pkgs]]) {
    let n = 0; for (const f of arr) if (!seen.has(f)) { seen.add(f); n++; }
    marks.push(`${k}：${n} 件`);
  }
  return { files: [...seen].sort(), marks };
}

function reviewTime() {
  // 2026-10-16 第二版（用户裁定「钩子应对应**当时的动作**，不是仓库现在的状态」）：
  // sha 口径天生分不清"我刚改的"与"历史存量"（首跑报 369 项、收窄后仍把从未审的老件算进来 ✗）。
  // 改为**动作面**：只问"审核戳之后，这些件**被动过**吗"——文件面用 mtime，动作面用 hooks 线佐证。
  const stamp = join(OUT, 'REVIEW-STAMP.json');
  if (!existsSync(stamp)) return null;
  let j;
  try {
    j = JSON.parse(readFileSync(stamp, 'utf8'));
    if (j && j.at) {
      const atMs = Date.parse(j.at);
      // N4（2026-10-17）：at 不可解析 ⇒ **当作没有戳**（SKIP，并在 SKIP 行明示原因）。
      // 原实现让 rt.atMs=NaN 通过，`m > NaN` 恒 false ⇒ 戳外件整条路径静默、工具报"无滞后"。
      if (!Number.isFinite(atMs)) return { bad: `审核戳 at 不可解析（at=${JSON.stringify(j.at)}）` };
      return { atMs, at: j.at, reviewed: j.reviewed ?? null, src: `REVIEW-STAMP.json（at=${j.at}${j.writtenAt ? `，写戳于 ${j.writtenAt}` : ''}）` };
    }
  } catch (e) {
    // D3（批次12）：戳**存在但不可解析**必须与"没有戳"分开说话——旧实现一并回 null ⇒ SKIP 行谎称"未找到审核戳"
    return { bad: `审核戳 JSON 不可解析（${String(e && e.message).slice(0, 100)}）` };
  }
  return { bad: '审核戳缺 at 字段' };   // 能解析但不是审核戳 ⇒ 同样 SKIP，但话说清楚
}

// 戳链（tripwire，2026-10-17）：**只比 sha 的旧口径发现不了"戳被回滚/替换"**——
//   把 REVIEW-STAMP.json 换回一版旧戳，文件 sha 全都对得上 ⇒ 旧实现照样报"无滞后"。
//   这里加一条**独立于工作区**的追加式链：每次写戳时把"新戳的 sha + 上一戳的 sha"追加进
//   `gate-out/stamp-chain.jsonl`；读端做三件事：
//     ① 当前戳的 sha 必须等于链尾 sha（否则＝戳被换过/回滚过）
//     ② 链内每条 prev 必须等于上一条 sha（否则＝链被改过）
//     ③ 戳在而链不在 ⇒ 链被删（更便宜的伪造路径）
//   它不依赖 mtime、不依赖面清单 ⇒ **假红风险接近 0**。
// 戳链校验已下沉到 `lib.mjs` 的 `verifyStampChain`（可被 test.mjs 直接测）；这里只做路径绑定。
const chainCheck = (stampPath) => verifyStampChain(stampPath, join(OUT, 'stamp-chain.jsonl'));


// 动作面佐证：hooks 线里"审核戳之后"的工具动作（tool 事件带工具名与时间，但**不带文件路径**）。
// 2026-10-16 审修（P5）：**整读 → 尾部窗口读**（与 intentsSince 同法，只读尾部 2 MiB）——hooks.jsonl
//   **无界增长**（审时 6.2 MB / 5.2 万行；按现增速到 100 MB 时单次整读 ~1–2 s），而本工具是被宿主
//   `review-lag` 钩子按 5 s 超时调起的 ⇒ 整读会让余量随日志增长而收紧；只读尾部足够覆盖"戳之后"的动作。
function hookActions(atMs) {
  const f = join(AK, 'logs', 'hooks.jsonl');
  if (!existsSync(f)) return null;
  const st = statSync(f);
  const start = Math.max(0, st.size - 2 * 1024 * 1024);
  const fd = openSync(f, 'r');
  let text = '';
  try {
    const buf = Buffer.allocUnsafe(st.size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    text = buf.subarray(0, n).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } finally { closeSync(fd); }
  const lines = text.split('\n').filter(Boolean).slice(-5000);
  const by = {};
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.kind !== 'tool' || !o.ts || Date.parse(o.ts) <= atMs) continue;
    const t = String(o.tool ?? '?');
    by[t] = (by[t] ?? 0) + 1;
  }
  return by;
}

// 修复批次的"意图面"（2026-10-16 用户裁定）：**钩子的单位是"这一段在修哪个问题"**，不是"哪些文件被动过"。
// 数据源＝会话层 intent 段（gist 为人可读意图，带 keywords）；只读尾部 2MB（session.jsonl 59MB，别全读）。
function intentsSince(atMs, limit = 12) {
  const f = join(AK, 'data', 'session.jsonl');
  if (!existsSync(f)) return [];
  const st = statSync(f);
  const start = Math.max(0, st.size - 2 * 1024 * 1024);
  const fd = openSync(f, 'r');
  let text = '';
  try {
    const buf = Buffer.allocUnsafe(st.size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    text = buf.subarray(0, n).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } finally { closeSync(fd); }
  const out = [];
  for (const l of text.split('\n')) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.kind !== 'intent' || !o.time || Date.parse(o.time) <= atMs) continue;
    const gist = String(o.gist ?? '').replace(/\s+/g, ' ').trim();
    if (!gist) continue;
    // 过滤噪声：subagent 收尾/转发通知不代表"这一段在修什么"
    if (/^(Agent |Background subagent )/.test(gist)) continue;
    out.push({ time: o.time.slice(11, 19), gist: gist.slice(0, 110), keywords: Array.isArray(o.keywords) ? o.keywords : null });
  }
  return out.slice(-limit);
}

try {
  const { files, marks } = collect();
  // --face：只自述面清单（供审计"从工具嘴里问"，不读源码猜白名单）；不读戳、不判滞后。
  if (process.argv.includes('--face')) {
    console.log(`面内件：${files.length} 件（＝代码件 + dsh-*/ 装载件；本工具自述，判据见文件头注释）`);
    for (const m of marks) console.log(`   · ${m}`);
    for (const f of files) console.log(relOf(f));
    process.exit(0);
  }
  const rt = reviewTime();
  // tripwire：戳链独立校验（不依赖工作区；见 chainCheck 注释）
  const chainBad = chainCheck(join(OUT, 'REVIEW-STAMP.json'));
  // P2（2026-10-18 VERIFY-D）：**删/坏戳不能变成 SKIP**——链在而戳没了/坏了 ⇒ fail-closed。
  //   旧实现单靠 `if (!rt) SKIP exit 0`：删掉 REVIEW-STAMP.json 一处，整条戳链闸就失效（攻击最狠的一条）。
  const chainPath = join(OUT, 'stamp-chain.jsonl');
  let chainPresent = false;
  try { chainPresent = existsSync(chainPath) && readFileSync(chainPath, 'utf8').trim().length > 0; } catch { chainPresent = false; }
  if ((!rt || rt.bad) && chainPresent) {
    console.log(`✗ 审核戳缺失/不可用（${(!rt) ? '未找到 REVIEW-STAMP.json' : rt.bad}），但戳链存在 ⇒ fail-closed（删/坏戳不是"无戳布局"）。`);
    process.exit(1);
  }
  if (!rt) { console.log('SKIP：未找到审核戳（REVIEW-STAMP.json）且无戳链——可移植布局不判。'); process.exit(0); }
  if (rt.bad) { console.log(`SKIP：${rt.bad} 且无戳链——按"无审核戳"处理，不判。`); process.exit(0); }
  const sha16 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);
  // 混合口径（2026-10-16 第三版）：**戳内**的件比 sha（精确，能抓"审后又被改"）；
  // **戳外**的件只有 mtime 晚于**覆盖下界**（rt.atMs——审核者取样时刻，不是写戳时刻）才算滞后
  // ⇒ 存量老件不误报（解决 369 噪声），而"下界之后新发生的未审改动"必报（解决假绿）。
  const late = [];
  const inFace = new Set(files.map(relOf));
  for (const f of files) {
    const rel = relOf(f);
    if (rt.reviewed && Object.prototype.hasOwnProperty.call(rt.reviewed, rel)) {
      if (sha16(f) !== rt.reviewed[rel]) late.push({ f, why: '戳内，但 sha 与戳不符（审后又被改）' });
    } else {
      // 2026-10-18（GPT 第三轮）：**戳必须覆盖整个面**。close-stamp 每次枚举全量面 ⇒
      //   "面内有、戳内无"只能是：戳被改（删 reviewed 键）或面内被塞了文件。
      //   旧实现退回 mtime 通道 ⇒ 删键 + 保留旧 mtime 即可绿（GPT 实测已验证）。
      late.push({ f, why: '不在戳内（戳必须覆盖整个面；缺登记＝戳被改/面被塞）' });
    }
  }
  // N2（2026-10-17）：**删除即隐形**——戳内登记过的件被删掉后，既不进 files（存在性过滤）、也不进 mtime 路径
  // ⇒ 旧实现 exit 0（比"mtime 压旧"更便宜，连时间都不用伪造）。对"父目录还在、文件没了"报红；
  // 父目录整块不在（整包移除 / 换布局）⇒ 跳过，保可移植。
  if (rt.reviewed) {
    for (const rel of Object.keys(rt.reviewed)) {
      if (inFace.has(rel)) continue;
      const abs = join(ROOT, rel);
      if (!existsSync(abs) && existsSync(dirname(abs))) late.push({ f: abs, why: '戳内登记，但文件已不存在（删除 = 隐形）' });
    }
  }
  const acts = hookActions(rt.atMs);
  // D1（批次12，verify-A1 §5）＋F2（批次13，verify-A2 §6 F2）：面与戳的不对齐此前**只在绿分支可见**——
  //   红态恰是"正在加件/改件"的时刻，却看不到覆盖缺口 ⇒ 计算提到分支外、**两支都打**（数都是 0 时仍安静）。
  // F1-B（批次13）：`extra` ＝**戳里有、面里没有**的键（正是装载件未入面时的形态）——出声时**列前 3 个键名**
  //   （此前只给计数，读的人得自己去猜是哪些）；**只观测：判定与退出码一律不变**。
  const unreg = files.map(relOf).filter((r) => !rt.reviewed || !Object.prototype.hasOwnProperty.call(rt.reviewed, r));
  const extra = rt.reviewed ? Object.keys(rt.reviewed).filter((k) => !inFace.has(k)) : [];
  const gapLine = (unreg.length || extra.length)
    ? `   覆盖提示：${unreg.length} 件面内件无 sha 锚（仅 mtime 通道）· ${extra.length} 个戳键不在面内`
      + `（无锚，仅"删除"可判${extra.length ? `：${extra.slice(0, 3).join('、')}${extra.length > 3 ? ' …' : ''}` : ''}）`
      + ' —— 收尾写戳请用 `node akasha/tools/review-lag.mjs --face` 重生成 reviewed'
    : null;
  if (!late.length && !chainBad) {
    console.log(`无滞后：${files.length} 个面内件均未被改动（${rt.src}）。`);
    if (gapLine) console.log(gapLine);
    process.exit(0);
  }
  if (!late.length && chainBad) {
    // 文件面全绿、但戳链异常 ⇒ 这是"戳被回滚/替换"的典型形态，必须红。
    console.log(`⚠ 审核戳链异常：${chainBad}`);
    console.log('   ⇒ 文件面看起来全绿，但**戳本身不可信**（旧实现只看文件 sha，看不到这一层）。');
    if (gapLine) console.log(gapLine);
    process.exit(1);
  }
  console.log(`⚠ 审核面滞后：${late.length} 个面内件在审核戳之后被改过（${rt.src}）：`);
  for (const x of late.slice(0, 10)) console.log(`   · ${relOf(x.f)} —— ${x.why}`);
  if (late.length > 10) console.log(`   …共 ${late.length} 个`);
  if (gapLine) console.log(gapLine);   // F2：红态也打覆盖提示（此前只在绿分支 ⇒ 红态看不到缺口）
  if (acts && Object.keys(acts).length) {
    console.log('   动作面佐证（hooks 线，戳之后的工具动作）：' + Object.entries(acts).map(([k, n]) => `${k} ${n}`).join(' / '));
  }
  const intents = intentsSince(rt.atMs);
  if (intents.length) {
    console.log('\n—— 这一段在做什么（会话层 intent，覆盖下界之后）——');
    for (const x of intents) console.log(`   · ${x.time} ${x.gist}${x.keywords && x.keywords.length ? `  [${x.keywords.slice(0, 4).join('/')}]` : ''}`);
  }
  console.log('⇒ 处置：对这批改动开独立审核（全新上下文、只读），收尾后**更新审核戳**（at 前移）。');
  console.log('   派单要求（按用户裁定 2026-10-16）：① 先确认"这一段修的是哪个问题"，逐条判定改动是否对准它；'
    + '② 覆盖面＝**为它做过的全部步骤**（含中途推翻/回滚的那次）；③ 不只给判定——**给出可执行补丁（diff 或代码段）**。');
  process.exit(1);
} catch (e) { console.error('内部错误：' + e.message); process.exit(2); }
