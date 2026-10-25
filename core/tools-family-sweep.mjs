// akasha/tools/family-sweep.mjs —— 阿卡夏全族「一次跑完」的检查器（2026-10-13，举一反三批）
//
// 起因：现有各检查是散的（plugin-src-drift 只管 5 个 @local 包的代码漂移），有三个盲区：
//   ① 只对比**代码文件**，不扫**发布件里的机器路径**（本次 S6 清掉的 <LOCAL_PATH> 写死就属于这类）；
//   ② 不检查**环境变量契约**（插件读 AKASHA_DIR / 核心读 AKASHA_ROOT+AKASHA_LOGS，两套并存）；
//   ③ 不检查**README 里的版本漂移**（P3 的那类，靠人眼看不出来）。
//
// 2026-10-15 修（独立审核 gate-out/gate-selffix/audit-family-sweep.md 的四处 fail-open；反例与实测日志见
// gate-out/gate-selffix/runs/fs-fix/，四条各有「修前红 / 修后绿」）：
//   ① 整包不在 profile 从 ⚠ 警告改**计入必须动作** —— 原实现下六个漏同时存在仍打印「全绿 ✓」EXIT=0（审核跑 B）。
//   ② 漂移面＝手写 code 清单 ∪ package.json 的 files + main + exports 声明入口（原**完全不读 package.json**，
//      于是「源里缺件 / 副本侧多件 / 发货件未声明」三类全无声）；包内代码文件的漏扫自检改**递归**（含 .cjs 与深目录）。
//   ③ 豁免从「8 个精确文件名的全局白名单」改**通配**（probe* / *.test.* / _verify-*，逐条留理由）；**声明优先于豁免**：
//      被 files/main/exports 声明者一律进漂移面必须比对（原实现里 mcp-rea 随包发布的 selftest.mjs 被同名豁免蒙混）。
//   ④ `(缺)` 语义拆三类：`(副本缺件：src 有、副本无)` / `(源里无：src 无、副本有 ⇒ 遗留件)` /
//      `(两侧皆无：声明悬空)`——原实现 `if (!existsSync(a)) continue;` 把第二类静默跳过。
//
// 2026-10-17 B-④（发布扫描三类反例）：把「声明面」从 main/exports/files 扩到**装载字段**，
//   并给扫描根加 env 覆盖 —— 反例必须在隔离克隆里跑（不动真包），原实现根硬编码 ⇒ 该类代码不可测。
//   反例与日志：runs/audit-1016-batch21/work/（三类必测 + 三个探针，各有红/绿证据）。
//
// 用法：
//   node akasha/tools/family-sweep.mjs            # 全量（含自测）
//   node akasha/tools/family-sweep.mjs --quiet    # 只报 ✗ 与结论行（静音过程）
//   node akasha/tools/family-sweep.mjs --no-tests # 跳过子套件（快）
//   FAMILY_SWEEP_ROOT=<dir> [FAMILY_SWEEP_PROFILE=<dir>] node ...   # 根覆盖（隔离克隆 / 回归；默认真机路径）
// 退出码：0 = 全绿；1 = 有必须动作项。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const H = (process.env.FAMILY_SWEEP_ROOT || process.env.HARNESS_ROOT || '<LOCAL_PATH>').replace(/\\/g, '/').replace(/\/+$/, '');
const PROFILE = process.env.FAMILY_SWEEP_PROFILE || join(H, 'official-home/profiles/desktop/node_modules');
const quiet = process.argv.includes('--quiet');
const noTests = process.argv.includes('--no-tests');
const say = (...a) => { if (!quiet) console.log(...a); };
// 2026-10-13 修：--quiet 曾把 ✗ 一并吞掉 ⇒ 静默退出码 1，无从看因（与文档「只报结论行」不符）。
// 口径：静音「过程」，**失败行与结论行永远出声**。
const loud = (...a) => console.log(...a);
let actions = 0;

// ── 1. 包清单（含 bundle 目录：cordis.patch.yml 与 mcp.mjs 这类也纳入代码对比）──
const PKGS = [
  { name: '@akasha-book/akasha-gate', src: join(H, 'dsh-akasha-gate'), code: ['index.js', 'prompt-safety.js', 'cordis.patch.yml'] },
  { name: '@akasha-book/akasha-sleep', src: join(H, 'dsh-akasha-sleep'), code: ['lib/index.js', 'lib/prompt-safety.js'] },
  { name: '@akasha-book/akasha-session', src: join(H, 'dsh-akasha-session'), code: ['lib/index.js', 'lib/index-worker.mjs'] },   // 2026-10-15：+index-worker（声明了却漏扫）；根 index.js 系 v0.2 遗留件——0.3.5-h6 已连同 files 一起删（22:30），本清单同批移除（新「两侧皆无」类 22:34 抓出的正是这条陈旧声明）
  { name: '@akasha-book/akasha-hooks', src: join(H, 'dsh-akasha-hooks'), code: ['index.js'] },
  { name: '@akasha-book/mcp-akasha', src: join(H, 'dsh-mcp-akasha'), code: ['index.js', 'cordis.patch.yml'] },
  { name: '@akasha-book/mcp-rea', src: join(H, 'dsh-mcp-rea'), code: ['server.mjs', 'cordis.patch.yml'] },
];

// 根自检（2026-10-17 B-④）：根可被 FAMILY_SWEEP_ROOT 覆盖（反例必须在隔离克隆里跑，不动真包）。
// 覆盖指错时旧实现仍会红（第 1 节报 6 条「profile 里不在」），红得对但**指错方向**——把「根指错了」
// 说成「包没装」。此自检把原因说清并早退（空根探针 c8），避免照诊断去重打包。
if (!PKGS.some((p) => existsSync(p.src))) {
  console.log('  ✗ 扫描根自检：' + H + ' 下 ' + PKGS.length + ' 个源包一个都没有 —— FAMILY_SWEEP_ROOT 指错了？（默认 <LOCAL_PATH>）');
  process.exit(1);
}

// ── 1a. 声明面工具（package.json → 漂移面；2026-10-15 审核②）────────────────────
// 漂移面不再只有手写清单：**files + main + exports 声明的一切入口都进比对**（声明的才是发货件）。
const CODE_RE = /\.(mjs|js|cjs)$/;
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isGlob = (p) => /[*?[\]{}]/.test(p);
function readPj(dir) { try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { return {}; } }
// 递归收集包内代码文件（排除 node_modules 与点目录；src / 副本两侧同一把尺子）
function walkCode(root, base = '', out = []) {
  let entries = [];
  try { entries = readdirSync(join(root, base), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    // 2026-10-18（GPT③ ⑧ / 点文件）：只跳过**点目录**（.git/.cache），点文件（.eslintrc 等）照收——
    //   旧实现 `name.startsWith('.')` 把点文件一起跳过（声明目录里的点配置文件漂移会静默绿）。
    if (e.name === 'node_modules' || (e.isDirectory() && e.name.startsWith('.'))) continue;
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walkCode(root, rel, out);
    else if (e.isFile() && CODE_RE.test(e.name)) out.push(rel);
  }
  return out;
}
// 声明的入口：files（目录声明则展开为该目录内全部代码文件）+ main + exports（递归取本地路径串）
function declaredEntries(srcDir, dstDir) {
  let pj = readPj(srcDir);
  if (!Object.keys(pj).length) pj = readPj(dstDir);        // src 无包定义时退回副本侧
  const out = new Set();
  const addFile = (rel) => {
    if (!rel || rel === 'package.json' || rel.startsWith('..') || isGlob(rel)) return;   // package.json 另有版本判定；glob 不做展开（防误报）
    out.add(rel);
  };
  const addExports = (v) => {
    if (typeof v === 'string') { addFile(norm(v)); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) addExports(x);
  };
  if (typeof pj.main === 'string') addFile(norm(pj.main));
  // 2026-10-17 B-④：`dsh.bundle.patch` 是宿主挂插件的**装载入口**，也是入口 ⇒ 进漂移面（两侧存在性 + 字节）
  const patchEntry = pj.dsh && pj.dsh.bundle && pj.dsh.bundle.patch;
  if (typeof patchEntry === 'string') addFile(norm(patchEntry));
  addExports(pj.exports);
  for (const raw of (Array.isArray(pj.files) ? pj.files : [])) {
    const rel = norm(raw);
    if (!rel || rel.startsWith('..') || isGlob(rel)) continue;
    if (isDir(join(srcDir, rel)) || isDir(join(dstDir, rel))) {          // 目录声明 ⇒ 展开其内代码文件（双侧）
      for (const f of walkCode(srcDir, rel)) out.add(f);
      for (const f of walkCode(dstDir, rel)) out.add(f);
    } else addFile(rel);
  }
  return [...out];
}
const surfaceOf = (p, dst) => {
  const s = [...p.code];
  for (const f of declaredEntries(p.src, dst)) if (!s.includes(f)) s.push(f);
  return s;
};

// ── 1b. 覆盖自检（R4；2026-10-15 审核后重修）───────────────────────────────────
// 判据（audit-family-sweep.md §1/§3）：包内存在的代码文件（递归），要么在漂移面（code 清单 / files / main / exports），
// 要么匹配豁免通配；否则报「漏扫」。副本侧多出、源里没有的代码文件同样报出。**声明优先于豁免**（声明为入口者必须比）。
// 旧实现的两个反例：① mcp-rea 的 selftest.mjs 在 files 里、随包发布，却因同名豁免不在漂移面（蒙混）；
// ② 新测试件 newsuite.test.mjs 不在豁免表 ⇒ 被误报「主入口漏扫」（假动作）。豁免列表逐条写理由（审核建议）。
const COVERAGE_WAIVE = [
  { re: /^probe[-.\w]*\.(mjs|js|cjs)$/, why: '探针件（probe*）——人工诊断用，不是入口' },
  { re: /\.test\.(mjs|js|cjs)$/, why: '测试套件（*.test.*）——第 5 节会实跑，不是入口' },
  { re: /^_verify-[\w.-]*\.(mjs|js|cjs)$/, why: '自校验工具（_verify-*）——开发期校验脚本，不是入口' },
];
const waived = (rel) => COVERAGE_WAIVE.some((w) => w.re.test(norm(rel).split('/').pop()));
for (const p of PKGS) {
  if (!existsSync(p.src)) continue;
  const dst = join(PROFILE, p.name);
  const surface = new Set(surfaceOf(p, dst));
  const missed = walkCode(p.src).filter((f) => !surface.has(f) && !waived(f));
  const extra = existsSync(dst) ? walkCode(dst).filter((f) => !surface.has(f) && !isFile(join(p.src, f))) : [];
  if (missed.length) {
    console.log(`  ✗ 覆盖自检（必须动作）：${p.name} 有 ${missed.length} 个包内代码文件不在漂移面 —— ${missed.join(', ')}（声明进 files/main/exports，或给豁免表加一条带理由的通配）`);
    actions += missed.length;
  }
  if (extra.length) {
    console.log(`  ✗ 覆盖自检（必须动作）：${p.name} 副本侧多出 ${extra.length} 个源里没有的代码文件 —— ${extra.join(', ')}（遗留件？先删再核）`);
    actions += extra.length;
  }
}
// 核心库（不在 profile 里：以「发行件是否含机器路径」与「自测」间接把关）

say('══ 1. 代码 / 版本漂移（src ↔ profile 安装副本）══');
let codeDrift = 0, verDrift = 0, absentPkgs = 0;
for (const p of PKGS) {
  const dst = join(PROFILE, p.name);
  if (!existsSync(dst)) {
    // 2026-10-15 审核①：整包不在 profile 是**必须动作**（原实现只 ⚠、不计动作 ⇒ 六种漏同时存在仍报「全绿 ✓」）。
    absentPkgs += 1;
    loud('  ✗ ' + p.name + '：profile 里不在（必须动作）—— 无安装副本 ⇒ 该包整个漂移面无从比对；先在 profile 里装上');
    continue;
  }
  const diffs = [];
  for (const f of surfaceOf(p, dst)) {
    const a = join(p.src, f), b = join(dst, f);
    const hasA = isFile(a), hasB = isFile(b);
    if (hasA && hasB) { if (!readFileSync(a).equals(readFileSync(b))) diffs.push(f); continue; }
    // 2026-10-15 审核④：`(缺)` 拆三类，不再静默跳过「源里没有」的那半（原 `if (!existsSync(a)) continue;`）
    if (hasA) diffs.push(f + '(副本缺件：src 有、副本无 ⇒ 打包/安装问题)');
    else if (hasB) diffs.push(f + '(源里无：src 无、副本有 ⇒ 遗留件，或该件不该再发布)');
    else diffs.push(f + '(两侧皆无：声明悬空 ⇒ 清单/声明里有、两边都找不到)');
  }
  let vSrc = '?', vDst = '?';
  try { vSrc = JSON.parse(readFileSync(join(p.src, 'package.json'), 'utf8')).version; } catch { /* 无包 */ }
  try { vDst = JSON.parse(readFileSync(join(dst, 'package.json'), 'utf8')).version; } catch { /* 无包 */ }
  if (diffs.length) { codeDrift += 1; loud('  ✗ ' + p.name + ' —— **代码**漂移（必须动作）：' + diffs.join(', ') + ' ⇒ 重打包 → install_bundle → 重启'); }
  else if (vSrc !== vDst) { verDrift += 1; say('  · ' + p.name + ' —— 仅版本号超前（' + vSrc + ' vs ' + vDst + '）· 代码一致 ⇒ 无需动作 ✓'); }
  else say('  ✓ ' + p.name + '（代码与版本都一致）');
}
if (codeDrift) actions += codeDrift;
if (absentPkgs) actions += absentPkgs;
say('  → ' + (codeDrift ? codeDrift + ' 个代码漂移 ✗' : '无代码漂移 ✓')
  + (absentPkgs ? '；' + absentPkgs + ' 个整包不在 profile ✗（必须动作）' : '')
  + (verDrift ? '（' + verDrift + ' 个仅版本号超前）' : ''));

// ── 1c. 发布扫描盲区补丁（GPT 第二份·优先④；与单元 C 的声明面扫描**衔接不重复**）────────────
// 单元 C 已做：漂移面＝手写清单 ∪ files/main/exports（含目录展开）、递归代码文件、双向比对。
// 本块补**三个仍能假绿的盲区**：① 安装件 `package.json` 缺失（无法核对入口声明，原静默 ✗）；
// ② **两侧入口声明漂移**（src 的 main/exports/files 与安装件不一致，原不查 ✗）；
// ③ **声明目录下的非代码件漂移**（C 的递归只收 .js/.mjs/.cjs ⇒ 声明目录里的 .yml/.json 漂移无声 ✗）。
//   ⚠ 2026-10-17 B-④ 实测更正：六个包的 files 目前**全是文件声明、没有一个目录声明** ⇒ 本分支是**无人走的路**；
//   而 `cordis.patch.yml` 作为**文件**声明，早在第 1 节就按字节比过（反例 c3b 红，证词原先把类归错了）。
//   本分支由反例 c3（两侧同步改成 files:["lib"]/["conf"] 后只漂安装侧一份）实测红，才第一次被走到。
// 2026-10-17 B-④：原先只比 main/exports/files ⇒ 三处**装载字段**漂移实测假绿（反例 c4/c5/c6）：
//   `dsh.bundle.patch`（宿主靠它挂插件）/ `type`（module↔commonjs 翻转解析语义）/ `peerDependencies`（宿主席位门控，
//   不满足就整块不加载）/ `name`（装到错目录）。四者都发生在「代码逐字节全同」时 ⇒ 只看代码的扫描必绿。
const normD = (v) => (Array.isArray(v) ? v.map(normD)
  // 2026-10-18（GPT③ ⑧ / exports 条件顺序）：**保留键序**——Node 的 exports 条件按声明顺序取首个匹配，
  //   旧实现 `Object.keys(v).sort()` 会把顺序差异抹平（实测"排平后假绿"）。
  : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).map((k) => [k, normD(v[k])]))
  : (typeof v === 'string' ? norm(v) : (v ?? null)));
const declSurf = (j) => JSON.stringify({
  name: j.name ?? null,
  type: j.type ?? 'commonjs',   // 2026-10-17 复核（VERIFY-B4 §⑥）：Node 默认语义＝缺 type 即 commonjs；
  //   原来写 `?? null` 会把「没写」和「写了 commonjs」判成漂移 ⇒ 窄误红（当前六包全 type:module，不触发）。
  main: j.main ? norm(j.main) : null,
  exports: normD(j.exports ?? null),
  files: [...(j.files ?? [])].map(norm).sort(),
  patch: j.dsh?.bundle?.patch ? norm(j.dsh.bundle.patch) : null,
  peers: j.peerDependencies ? Object.fromEntries(Object.keys(j.peerDependencies).sort().map((k) => [k, j.peerDependencies[k]])) : null,
});
const declFields = (a, b) => Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
let declGaps = 0;
for (const p of PKGS) {
  const dst = join(PROFILE, p.name);
  if (!existsSync(dst)) continue;                       // 整包不在 profile 由上面计动作 ✓，此处不重复
  const dp = join(dst, 'package.json');
  if (!existsSync(dp)) { loud(`   ✗ ${p.name} 安装件缺 package.json（入口声明无从核对）`); actions += 1; declGaps += 1; continue; }
  let sj, dj;
  try { sj = JSON.parse(readFileSync(join(p.src, 'package.json'), 'utf8')); dj = JSON.parse(readFileSync(dp, 'utf8')); }
  catch { loud(`   ✗ ${p.name} package.json 不可解析（两侧之一）`); actions += 1; declGaps += 1; continue; }
  const sSurf = declSurf(sj), dSurf = declSurf(dj);
  // 2026-10-17 复核（VERIFY-B4 §⑥）：`files` 里含通配（`*`）时，下面 ③ 的逐文件比对**覆盖不到**
  //   （它只认"目录型声明项"），非代码件的漂移会静默绿。这里**显式打出**这个已知盲区，不让它无声。
  const globEntries = [...new Set([...(sj.files ?? []), ...(dj.files ?? [])])].filter((x) => String(x).includes('*'));
  if (globEntries.length) {
    loud(`   · ${p.name} files 含通配（${globEntries.join(',')}）⇒ 非代码件漂移**不覆盖**（已知盲区，非绿）`);
  }
  if (sSurf !== dSurf) {
    const fields = declFields(JSON.parse(sSurf), JSON.parse(dSurf));
    loud(`   ✗ ${p.name} **入口/装载声明漂移**（src vs 安装件，字段：${fields.join(',')}）`);
    actions += 1; declGaps += 1;
  }
  // ③ 声明目录下：非代码件逐文件比对（只对**目录型**声明项）
  for (const entry of (sj.files ?? [])) {
    const srcDir = join(p.src, entry);
    let isDir = false;
    try { isDir = statSync(srcDir).isDirectory(); } catch { isDir = false; }
    if (!isDir) continue;
    const walkAll = (root) => {
      const out = [];
      const rec = (d) => { let es = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of es) { if (e.name === 'node_modules' || (e.isDirectory() && e.name.startsWith('.'))) continue;
          const f = join(d, e.name); if (e.isDirectory()) rec(f); else out.push(f); } };
      rec(root); return out;
    };
    const rel = (root, f) => f.slice(root.length + 1).replace(/\\/g, '/');
    const sSet = new Map(walkAll(srcDir).map((f) => [rel(srcDir, f), f]));
    const dSet = new Map(walkAll(join(dst, entry)).map((f) => [rel(join(dst, entry), f), f]));
    for (const [k, f] of sSet) {
      const g = dSet.get(k);
      if (!g) { loud(`   ✗ ${p.name} 声明目录 ${entry} 下缺件：${k}`); actions += 1; declGaps += 1; continue; }
      const same = (() => { try { return readFileSync(f).equals(readFileSync(g)); } catch { return false; } })();
      if (!same) { loud(`   ✗ ${p.name} 声明目录 ${entry} 下**配置漂移**：${k}`); actions += 1; declGaps += 1; }
    }
    for (const k of dSet.keys()) if (!sSet.has(k)) { loud(`   ✗ ${p.name} 声明目录 ${entry} 下多件（安装侧独有）：${k}`); actions += 1; declGaps += 1; }
  }
}
if (declGaps) say(`  → 声明面/配置面：${declGaps} 项必须动作 ✗`);

// ── 2. 发布件机器路径（注释行豁免；本机路径只许出现在注释/README/宿主 patch 配置里）──
say('');
say('══ 2. 发布件机器路径（JS 代码行不许写死 <LOCAL_PATH> / D:\\ 等）══');
const MACHINE_RE = /(H:[\\/]Harness|D:[\\/](ServerPackCreator|DSHHarness))/i;
// 只扫 **JS 代码**：`cordis.patch.yml` 是「每台机器自己的 profile 配置」（按设计就是本机路径），
// 扫它等于对着宿主的合法配置报警——**不是缺陷**（2026-10-13 首跑即踩：17 处全在 patch 里）。
const SCAN_FILES = PKGS.flatMap((p) => ['index.js', 'server.mjs', 'mcp.mjs', 'lib/index.js', 'lib/prompt-safety.js', 'prompt-safety.js', 'lib/index-worker.mjs'].map((f) => join(p.src, f)));
let pathHits = 0;
for (const f of SCAN_FILES) {
  if (!existsSync(f)) continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (!MACHINE_RE.test(l)) return;
    const t = l.trim();
    const commentish = t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');
    if (commentish) return;                                  // 注释里的示例路径豁免
    pathHits += 1;
    loud('  ✗ ' + f.replace(H + '/', '') + ':' + (i + 1) + ' —— ' + t.slice(0, 90));
  });
}
if (pathHits) actions += pathHits;
say('  → ' + (pathHits ? pathHits + ' 处代码行机器路径 ✗（改为 env 优先 + 相对候选）' : 'JS 代码行无机器路径 ✓') + '（`cordis.patch.yml` 按设计含本机路径，故意不扫）');

// ── 3. 环境变量契约（两套并存：插件 AKASHA_DIR ↔ 核心 AKASHA_ROOT / AKASHA_LOGS）──
say('');
say('══ 3. 环境变量契约 ══');
const ENV_CONTRACT = [
  { file: join(H, 'akasha/lib.mjs'), must: ['AKASHA_ROOT', 'AKASHA_LOGS'], what: '核心：数据根 / 日志根' },
  { file: join(H, 'dsh-akasha-gate/index.js'), must: ['AKASHA_DIR', 'AKASHA_POLICY'], what: '门控：库根 / 策略文件' },
  { file: join(H, 'dsh-akasha-hooks/index.js'), must: ['AKASHA_DIR'], what: '钩子：库根' },
  { file: join(H, 'dsh-akasha-session/lib/index.js'), must: ['AKASHA_DIR'], what: '会话层：库根' },
  { file: join(H, 'dsh-akasha-sleep/lib/index.js'), must: ['AKASHA_DIR'], what: '睡眠：库根' },
];
let envMiss = 0;
for (const c of ENV_CONTRACT) {
  if (!existsSync(c.file)) continue;
  const text = readFileSync(c.file, 'utf8');
  const missing = c.must.filter((v) => !text.includes(v));
  if (missing.length) { envMiss += 1; loud('  ✗ ' + c.file.replace(H + '/', '') + ' 缺 ' + missing.join(' / ') + '（' + c.what + '）'); }
}
if (envMiss) actions += envMiss;
say('  → ' + (envMiss ? envMiss + ' 处契约缺口 ✗' : '五族环境变量契约齐 ✓') + '（口径：插件侧 AKASHA_DIR；核心侧 AKASHA_ROOT + AKASHA_LOGS；默认布局下互不相撞）');

// ── 4. README 版本漂移（豁免：已写「以 package.json 为准」的 README）──
say('');
say('══ 4. 组件 README 的版本陈述 ══');
let readmeDrift = 0;
for (const p of PKGS) {
  const f = join(p.src, 'README.md');
  if (!existsSync(f)) continue;
  const head = readFileSync(f, 'utf8').split('\n').slice(0, 6).join(' ');
  if (head.includes('以本包 `package.json`')) { say('  ✓ ' + p.name + '：指真值（不再复述版本）'); continue; }
  const declared = (head.match(/v?(\d+\.\d+(?:\.\d+)?(?:-h\d+)?)/) || [])[1];
  let real = '?';
  try { real = JSON.parse(readFileSync(join(p.src, 'package.json'), 'utf8')).version; } catch { /* 无包 */ }
  if (!declared) { say('  · ' + p.name + '：README 头未声明版本（可接受）· 实际 ' + real); continue; }
  const norm2 = (s) => String(s).replace(/^v/, '').replace(/-h\d+$/, '');
  if (norm2(declared) === norm2(real)) { say('  ✓ ' + p.name + '：' + declared + ' ≈ ' + real + '（仅 h 后缀差异）'); continue; }
  readmeDrift += 1; loud('  ✗ ' + p.name + '：README 头写 ' + declared + '，实际 ' + real + ' ⇒ 改「指真值」或同步');
}
if (readmeDrift) actions += readmeDrift;

  // ── 5. 子套件（可选；**自动发现**）──
  // 2026-10-15 修（真盲区）：原先每个包**只列一个** selftest.test.mjs ⇒ sleep 的 stateful / preflight / gate
  // 三套**从未进扫描面**，于是 7 条存量红藏了很久而扫描器天天报"全绿"（今天先由插件侧发现）。
  // 现改为：按包目录**自动发现** `*.test.mjs` 与 `selftest.mjs`，新增套件无需再改本文件。
if (!noTests) {
  say('');
  say('══ 5. 子套件实跑（自动发现）══');
  const SUITES = [['akasha/test.mjs', join(H, 'akasha/test.mjs')]];
  for (const p of PKGS) {
    if (!existsSync(p.src)) continue;
    const files = readdirSync(p.src).filter((f) => f.endsWith('.test.mjs') || f === 'selftest.mjs').sort();
    for (const f of files) SUITES.push([p.name.replace('@akasha-book/', '') + '/' + f, join(p.src, f)]);
  }
  for (const [label, file] of SUITES) {
    // 2026-10-17 批次13 采纳（batch12 VERIFY-H4 §5-N2）：缺件原先只 ⚠、不计动作 ⇒ 与「有问题却判绿」同族 fail-open；
    //   缺件＝扫描面缺口，现改 ✗ 并 actions += 1（不静默）。
    if (!existsSync(file)) { loud('  ✗ ' + label + '：找不到 ' + file); actions += 1; continue; }
    // 2026-10-17 批次13 采纳（batch12 VERIFY-H4 §5-N1）：预算 300s 贴边 akasha/test.mjs（完跑 ~395s）⇒ 实测间歇被杀；
    //   且被杀时（status=null）旧展示行仍是一条 PASS（r.error/r.signal 从不进判据或展示）⇒ 抬到 900s + 未完成显式化。
    const r = spawnSync(process.execPath, [file], { cwd: join(file, '..'), encoding: 'utf8', timeout: 900000, env: { ...process.env, AKASHA_QUERY_LOG: 'off' } });   // 子套件＝机器检查，关查询侧线（防污染真日志）
    const stderrText = (r.stderr || '').trim();
    const out = r.error ? '[子套件未完成：' + (r.error.code || r.error.message) + ']'
      : r.signal ? '[子套件被信号终止：' + r.signal + ']'
      : (((r.stdout || '') + stderrText).trim().split('\n').filter(Boolean).pop() || '');
    // 2026-10-17 批次12 采纳（batch11 VERIFY-H3 §1.3 判定）：判绿不再只看状态码 ——
    //   子套件把「告警」写 stderr 而 exit 0 时（例：selftest 的 AKASHA_CORE 回退告警），旧口径
    //   `r.status === 0` 会让 CI 照绿（可见性停在 stderr，无消费者）。现补：stderr 非空 ⇒ 判 ✗。
    //   设计边界：**不**把 selftest 改成默认 fail-closed（继承 process.env 的历史变量会误伤整片）；
    //   CI 想要硬失败口径用入口 `AKASHA_CORE_STRICT=1`（selftest 实测 exit 1 / 140ms）。
    const ok = r.status === 0 && !stderrText;
    if (!ok) actions += 1;
    (ok ? say : loud)((ok ? '  ✓ ' : '  ✗ ') + label + '：' + out.slice(0, 90) + (ok ? '' : stderrText ? '  [stderr≠空]' : ''));
  }
}

say('');
loud(actions ? '★★ 结论：' + actions + ' 项必须动作（见上方 ✗）' : '★★ 结论：全绿 ✓');
process.exit(actions ? 1 : 0);
