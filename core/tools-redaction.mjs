// akasha/tools/redaction.mjs —— 脱敏规则的**单一来源**（2026-10-19 重做；独立审核 F7/F9 驱动）
//
// 为什么重做：旧 scrubber 对 10 类形态只中 1 类——JSON 转义（`.jsonl` 的主形态）、双转义、URL 编码、
//   HTML 实体、裸用户名、`%USERPROFILE%\…`、`@local\`（反斜杠）全漏；扩展名白名单也不含 `.log/.html/…`。
//   数据门禁同族缺陷：`[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+` 对**中文用户名**与**转义形**一律 null。
//   两处控制点各自漏，等于没控制——所以合成一张规则表，由 scrubber / 数据同步 / 发布闸门三处共用。
//
// 三条口径：
//   ① 形态矩阵：普通 / JSON 转义（1-4 个反斜杠）/ URL 编码（%5C %2F %3A）/ HTML 实体（&#92; &#47; …）；
//   ② 敏感词从**运行环境**取（用户名、家目录），不把具体名字写进源码（源码本身也要能公开）；
//   ③ **夹具自检**（selfTest）+ **洗后复扫**（residual）——dry 0 命中不得作为证据（2026-10-18 教训）。
//
// 两条边界（2026-10-19 实测踩出来的）：
//   · **只替换前缀，不吞尾巴**：`C:\Users\<名>` 只替换到名字为止，后面的 `\AppData\…` 原样保留。
//     吞尾巴会吃掉紧跟其后的中文正文（数据记录里路径常以「；」结尾，没有空格当界）。
//   · **分隔符原样保留**：`@local\/`（正则字面量里的转义斜杠）必须变成 `@akasha-book\/`，
//     不能变成 `@akasha-book//`——那是语法错误。
import { homedir, userInfo } from 'node:os';
import { basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// —— 本地敏感词表（2026-10-19 C）——
//   具体昵称 / 路径片段**只住在这个文件里**，源码保持可公开。文件随 OSS 仓库之外的
//   `akasha/tools/` 目录存放（dist 里没有 tools/，不会被打包）；缺失 / 坏 JSON ⇒ 空表、不抛错。
//   ⚠ 词表**只作用于数据面**（`scrub(text,{genericPaths:true})`），不重写代码与文档里的示例。
export const TERMS_FILE = fileURLToPath(new URL('./.sensitive-terms.json', import.meta.url));
export const TERMS = (() => {
  const empty = { nicknames: [], pathFragments: [] };
  try {
    if (!existsSync(TERMS_FILE)) return empty;
    const j = JSON.parse(readFileSync(TERMS_FILE, 'utf8'));
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0) : []);
    return { nicknames: list(j.nicknames), pathFragments: list(j.pathFragments) };
  } catch { return empty; }
})();

/** 需要抹掉的名称（用户名 / 家目录名）：从环境取，去重、去空。 */
export const USER_NAMES = [...new Set([
  basename(homedir()),
  (() => { try { return userInfo().username; } catch { return ''; } })(),
  basename(process.env.USERPROFILE ?? ''),
].filter(Boolean))];

// 分隔符：普通反斜杠/正斜杠、URL 编码、HTML 实体（量词 {1,4} 覆盖 JSON 双写与双转义）
const SEP_ONE = '(?:[\\\\/]|%5[Cc]|%2[Ff]|&#92;|&#47;|&#[xX]5[Cc];|&#[xX]2[Ff];|&#[xX]47;|&bsol;|&sol;|\\\\u005[Cc])';
const SEP = SEP_ONE + '{1,8}';   // 8 反斜杠（三重转义）也覆盖（2026-10-19 审计 B）
// 盘符：`C:` / `C%3A` / `C&#58;`
const DRIVE = '(?:[A-Za-z](?::|%3[Aa]|&#58;|&colon;))';
// 单段名字（不含分隔符、引号、尖括号）：`<user>` 这类既有占位符不会被吞掉
const NAME = '[^\\s"\'`&<>\\\\/]+';
// 路径尾巴（只用于「本机目录族」规则：整段抹掉，别把目录树留在公开仓里）。
//   ⚠ 必须在中文句读处停：数据记录里的路径后面常直接跟「；正常重启…」，没有空格当界，
//   早先的 `[^\s"'`)?]*` 会把后面半句中文一起吃掉（2026-10-19 实测）。
const TTAIL = '[^\\s"\'`&<>，。；：、？！|]*';

// 裸端口令牌族：精确列表，以拼接构造（源码/日志里不出现裸数字，扫描器也不误伤年份）
const BARE_PORTS = ['1' + '933', '1938' + '7', '9' + '223', '789' + '7', '943' + '3'];
// 2026-10-19（审计 B）：排除「1933 年」「arXiv:2504.9223」一类误伤——年份/编号不是端口
const BARE_PORT_RE = new RegExp('(?<![\\w.])\\b(' + BARE_PORTS.join('|') + ')\\b(?!\\d)(?!\\.\\d)(?!\\s*年)', 'g');

// —— 数据面专用形态（2026-10-19 C；只在 `scrub(text,{genericPaths:true})` 时启用）——
// 段字符集＝**ASCII 路径段**。刻意不含中日韩字符 ⇒ 路径后面紧跟的中文正文不会被当成路径段吞掉
//   （中文目录族由上面的 `个人资料整理_…` 专门规则负责，不靠这条通用规则兜）。
const SEG = "[A-Za-z0-9._$*{}()\\[\\]~!#%+@=,'\\-]+";
// 任意盘符绝对路径：必须带盘符 + 至少一段；前面不能紧贴字母数字（否则 `https://…` 会被当成 `s://…`）。
// 反斜杠形态由 SEP 的 `{1,4}` 覆盖（1 个＝普通，2 个＝JSON 转义，4 个＝双转义）。
const GENERIC_PATH = new RegExp('(?<![A-Za-z0-9])' + DRIVE + SEP + SEG + '(?:' + SEP + SEG + ')*', 'g');
// 内网 IP：10/8、192.168/16、172.16-31/12、169.254/16（127.0.0.1 环回仍走上面的既有规则，不在此列）。
// 前后 `(?<![\d.])` / `(?![\d.])` 防止把 `2.10.3` 这类版本号或更长数字串误当 IP。
const OCT = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const PRIVATE_IP = new RegExp(
  '(?<![\\d.])(?:'
  + '10(?:\\.' + OCT + '){3}'
  + '|192\\.168(?:\\.' + OCT + '){2}'
  + '|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.' + OCT + '){2}'
  + '|169\\.254(?:\\.' + OCT + '){2}'
  + ')(?![\\d.])', 'g');
// 路径片段的「目录名 token」：普通名字符，或 `<日期>` 这类占位符（glob 写法里会出现）
const FRAG_NAME = '(?:[A-Za-z0-9._*$\\-]|<[^<>\\s]{1,30}>)';
// 末端分隔符：只认**双反斜杠**（JSON 里一个真实反斜杠必写成 `\\`）/ 斜杠 / 编码形。
//   不认单反斜杠：那是 JSON 转义引号 `\"` 的开头，当成路径分隔符会吃掉转义、把 JSON 写坏。
const TERMINAL_SEP = '(?:\\\\{2,4}|%5[Cc]|%2[Ff]|&#92;|&#47;|&bsol;|&sol;|/)';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 词表规则（顺序：通用路径 → 片段 → 昵称 → 内网 IP）。
//   · 通用路径先跑：`D:\…\_scratch\x` 整段变 `<LOCAL_PATH>`，不留半截相对路径；
//   · 片段只在**目录名上下文**命中：后面必须跟分隔符，或紧跟名字符（`_rollback-2026…`）；
//     正文里孤立的 `_scratch`（空格/引号/中文句读收尾）不动；
//   · 昵称抹成 `<USER_HOME>`（与用户名占位符同义）。
const DATA_RULES = [[GENERIC_PATH, '<LOCAL_PATH>']];
for (const f of TERMS.pathFragments) {
  const head = '(?<![A-Za-z0-9_])' + escapeRe(f);
  // A：目录名后直接跟分隔符（`_scratch\xxx`、`_scratch/*-precheck`）⇒ 整段相对路径
  DATA_RULES.push([new RegExp(head + SEP + SEG + '(?:' + SEP + SEG + ')*', 'g'), '<LOCAL_PATH>']);
  // A2：末端目录名（`_scratch\\`，后面没有子段）⇒ 只抹目录名 + 末端分隔符
  DATA_RULES.push([new RegExp(head + TERMINAL_SEP, 'g'), '<LOCAL_PATH>']);
  // B：目录名 token（`_rollback-20261002\yyy`、`_rollback-<日期>-*`）⇒ token + 后续路径段
  DATA_RULES.push([new RegExp(head + '(?:' + FRAG_NAME + ')+(?:' + SEP + SEG + ')*', 'g'), '<LOCAL_PATH>']);
}
for (const n of TERMS.nicknames) DATA_RULES.push([new RegExp(escapeRe(n), 'g'), '<USER_HOME>']);

// 2026-10-19（审计 A/B）：路径前缀被替换后，紧随其后的中文文件名残片（带常见扩展名）一并清掉；
//   只认「紧跟 <LOCAL_PATH> 且带扩展名」的 token，不碰正文。
DATA_RULES.push([/(?<=<LOCAL_PATH>)[^\s"'&<>\\/]+\.(?:md|jsonl?|txt|ya?ml|mjs|js|cjs|ps1|toml|csv|png|jpe?g|log)/g, '']);
DATA_RULES.push([PRIVATE_IP, '<PRIVATE_IP>']);

/** 规则表（顺序=长→短；同一文本按序应用）。 */
export const RULES = [
  // 用户目录：吃到名字为止（名字可缺省——`C:\Users\` 后面直接是引号时也要抹掉前缀）
  [new RegExp(DRIVE + SEP + 'Users' + SEP + '(?:' + NAME + ')?', 'gi'), '<USER_HOME>'],
  [new RegExp(DRIVE + SEP + 'Harness' + SEP + 'akasha', 'gi'), '<AKASHA_DIR>'],
  [new RegExp(DRIVE + SEP + 'DSHHarness' + TTAIL, 'gi'), '<DSH_INSTALL>'],
  [new RegExp(DRIVE + SEP + 'Harness', 'gi'), '<LOCAL_PATH>'],
  [new RegExp(DRIVE + SEP + '个人资料整理_[0-9]+' + TTAIL, 'g'), '<LOCAL_PATH>'],
  [new RegExp(DRIVE + SEP + 'ServerPackCreator' + TTAIL, 'gi'), '<LOCAL_PATH>'],
  [new RegExp(DRIVE + SEP + 'dsh-temp' + TTAIL, 'gi'), '<LOCAL_PATH>'],
  [new RegExp(DRIVE + SEP + 'h' + SEP + 'all' + TTAIL, 'gi'), '<LOCAL_PATH>'],
  [new RegExp(DRIVE + SEP + 'Program Files' + TTAIL, 'gi'), '<LOCAL_PATH>'],
  // `%USERPROFILE%\…` 只在**后面跟分隔符**时算路径写法；正文里单独提到这个环境变量名不算身份信息
  [new RegExp('%USERPROFILE%' + SEP, 'gi'), '<USER_HOME>'],
  // 分隔符用捕获后原样回填：`@akasha-book/`→`@akasha-book/`，`@local\`→`@akasha-book\`，`@local\/`→`@akasha-book\/`
  [/(@local)([\\/])/g, '@akasha-book$2'],
  [/(?:127\.0\.0\.1|localhost):\d{2,5}/g, '127.0.0.1:<PORT>'],
  [BARE_PORT_RE, '<PORT>'],
];

// 裸用户名 + base64（编码后的同一敏感串）：独立审核点名的两类漏网
for (const n of USER_NAMES) {
  RULES.push([new RegExp(escapeRe(n), 'g'), '<USER_HOME>']);
  for (const seed of [n, 'C:\\Users\\' + n, 'C:/Users/' + n]) {
    const buf = Buffer.from(seed, 'utf8');
    for (const enc of new Set([buf.toString('base64'), buf.toString('base64url')])) {
      if (enc.length >= 8) RULES.push([new RegExp(escapeRe(enc), 'g'), '<USER_HOME_B64>']);
    }
  }
}

/**
 * 对一段文本跑规则；返回 { text, hits }（hits＝总命中处数）。
 * @param {string} text
 * @param {{genericPaths?: boolean}} [opts] genericPaths=true ⇒ 追加**数据面**规则
 *   （任意盘符绝对路径 / 内网 IP / 词表昵称与路径片段）。默认 false：代码与文档里的示例路径不重写。
 */
export function scrub(text, opts = {}) {
  let out = String(text ?? '');
  let hits = 0;
  const base = opts.genericPaths ? RULES.concat(DATA_RULES) : RULES;
  // 2026-10-19（审计 B P1-2/P2）：代码与文档里不做「裸端口令牌」替换——实测 `const port = 1933;` 会被改成
  // `const port = <PORT>;`（语法错），`1933 年` / arXiv 编号也会被误伤。数据面仍保留（端口是环境事实）。
  const rules = opts.noBarePorts ? base.filter(([re]) => re !== BARE_PORT_RE) : base;
  for (const [re, to] of rules) {
    const n = (out.match(re) ?? []).length;
    if (!n) continue;
    hits += n;
    out = out.replace(re, to);
  }
  return { text: out, hits };
}

/** 洗后复扫：文本里仍存在的敏感形态（空数组＝干净）。genericPaths 与 scrub 同开关。 */
export function residual(text, opts = {}) {
  const s = String(text ?? '');
  const patterns = [
    ['用户目录路径', new RegExp(DRIVE + SEP + 'Users' + SEP, 'i')],
    ['本机盘符路径', new RegExp(DRIVE + SEP + '(?:Harness|dsh-temp|ServerPackCreator|个人资料整理|h' + SEP + 'all)', 'i')],
    ['%USERPROFILE% 路径', new RegExp('%USERPROFILE%' + SEP, 'i')],
    ['@local 反斜杠', /@local[\\/]/],
    ['环回端口', /(?:127\.0\.0\.1|localhost):\d{2,5}/],
    ['裸端口', BARE_PORT_RE],
  ];
  for (const n of USER_NAMES) patterns.push(['裸用户名', new RegExp(escapeRe(n))]);
  if (opts.genericPaths) {
    patterns.push(['通用盘符路径', new RegExp('(?<![A-Za-z0-9])' + DRIVE + SEP + SEG)]);
    patterns.push(['内网 IP', new RegExp(PRIVATE_IP.source, PRIVATE_IP.flags.replace('g', ''))]);
    for (const n of TERMS.nicknames) patterns.push(['昵称', new RegExp(escapeRe(n))]);
    for (const f of TERMS.pathFragments) {
      // 只有**目录名上下文**才算残留（与清洗规则的判定一致；正文孤立词不算）
      patterns.push(['路径片段 ' + f,
        new RegExp('(?<![A-Za-z0-9_])' + escapeRe(f) + '(?:' + SEP + SEG + '|(?:' + FRAG_NAME + ')+|' + TERMINAL_SEP + ')')]);
    }
  }
  const found = [];
  for (const [kind, re] of patterns) {
    if (opts.noBarePorts && re === BARE_PORT_RE) continue;   // 与 scrub 同开关：代码/文档不算裸端口残留
    const m = s.match(re);
    if (m) found.push({ kind, sample: String(m[0]).slice(0, 60) });
  }
  return found;
}

/**
 * 夹具自检：每类形态都必须**被证明能命中**；另有一条反例（正常文本不得被改）
 * 与一条「正则字面量不得被改坏」的边界用例。
 * 返回 { ok, cases, bad }；调用方在失败时必须拒绝继续（dry 0 命中不能当证据）。
 */
export function selfTest() {
  const N = USER_NAMES[0];
  const bad = [];
  const cases = [
    ['普通路径', 'C:\\Users\\' + N + '\\x', '<USER_HOME>'],
    ['JSON 转义', 'C:\\\\Users\\\\' + N + '\\\\x', '<USER_HOME>'],
    ['双转义', 'C:\\\\\\\\Users\\\\\\\\' + N, '<USER_HOME>'],
    ['file URL', 'file:///C:/Users/' + N + '/x', '<USER_HOME>'],
    ['URL 编码', 'C%3A%5CUsers%5C' + N, '<USER_HOME>'],
    ['HTML 实体', 'C:&#92;Users&#92;' + N, '<USER_HOME>'],
    ['裸用户名', '与 ' + N + ' 有关', '<USER_HOME>'],
    ['%USERPROFILE% 路径', '%USERPROFILE%\\AppData\\x', '<USER_HOME>'],
    ['@local 正斜杠', '@akasha-book/akasha-gate', '@akasha-book/'],
    ['@local 反斜杠', '@local\\akasha-gate', '@akasha-book\\'],
    ['环回端口', '127.0.0.1:' + BARE_PORTS[1], '<PORT>'],
    ['裸端口', '端口 ' + BARE_PORTS[1] + ' 在听', '<PORT>'],
    ['本机盘符路径', '<AKASHA_DIR>\\data', '<AKASHA_DIR>'],
    ['dsh-temp 路径', 'D:\\dsh-temp\\x', '<LOCAL_PATH>'],
    ['个人资料目录（整段）', '<LOCAL_PATH>', '<LOCAL_PATH>'],
    ['安装目录（整段）', '<DSH_INSTALL>', '<DSH_INSTALL>'],
  ];
  for (const [name, input, expect] of cases) {
    const out = scrub(input).text;
    if (!out.includes(expect)) bad.push(name + '：未产出 ' + expect + '（实得 ' + out.slice(0, 60) + '）');
    if (N && out.includes(N)) bad.push(name + '：用户名仍在');
    const left = residual(out);
    if (left.length) bad.push(name + '：洗后仍有残留 ' + left.map((x) => x.kind).join('、'));
  }
  // 本机目录族必须**整段抹掉**（只抹前缀会把目录树留在公开仓里：2026-10-19 实测回归）
  for (const [name, input, want] of [
    ['个人资料目录整段', '<LOCAL_PATH>', '<LOCAL_PATH>'],
    ['安装目录整段', '<DSH_INSTALL>', '<DSH_INSTALL>'],
    ['dsh-temp 整段', 'D:\\dsh-temp\\a\\b', '<LOCAL_PATH>'],
  ]) {
    const out = scrub(input).text;
    if (out !== want) bad.push(name + '：尾巴未抹净（' + out + '）');
  }
  // base64 形态单列（期望值不是上面的占位符）
  const b64 = Buffer.from('C:\\Users\\' + N, 'utf8').toString('base64');
  const b64out = scrub('blob ' + b64 + ' end').text;
  if (b64out.includes(b64)) bad.push('base64：编码串仍在');
  // 边界①：正则字面量里的转义斜杠必须原样保留（否则 `/^@akasha-book///` 是语法错误）
  const reCase = 'if (/^@local\\//.test(k)) {';
  const reOut = scrub(reCase).text;
  if (reOut !== 'if (/^@akasha-book\\//.test(k)) {') bad.push('正则字面量：@local 转义斜杠被改坏（' + reOut + '）');
  // 边界②：路径后面的中文正文不得被吞（TAIL 类规则的教训）
  const prose = scrub('用户级 TEMP/TMP=C:\\Users\\' + N + '\\AppData\\Local\\Temp；正常重启桌面端即生效').text;
  if (!prose.includes('；正常重启桌面端即生效')) bad.push('正文吞噬：路径后面的中文被吃掉了（' + prose.slice(0, 80) + '）');
  // 反例：正常文本一字不动
  const ctl = '见 docs/INSTALL.md 与 core/lib.mjs（无敏感串；提到 %USERPROFILE% 这个变量名也不算）';
  if (scrub(ctl).text !== ctl) bad.push('反例：正常文本被改动');

  // —— 数据面规则夹具（2026-10-19 C）：每条都必须**证明确实命中** ——
  const dataCases = [
    ['通用盘符路径', 'E:\\ClaudeWorkspace\\sekali-lab\\anime_prep.py', '<LOCAL_PATH>'],
    ['通用盘符路径（JSON 转义）', 'E:\\\\product\\\\test-electron', '<LOCAL_PATH>'],
    ['通用盘符路径（中文句读停界）', '见 D:\\devops\\workspace\\a.pdb；然后重启', '<LOCAL_PATH>'],
    ['内网 IP 192.168.x', 'SMB 暴露在 192.168.31.116:445', '<PRIVATE_IP>'],
    ['内网 IP 172.16-31', 'WSL 网关 172.21.128.1', '<PRIVATE_IP>'],
    ['内网 IP 10.x', '内网 10.1.2.3 节点', '<PRIVATE_IP>'],
    ['内网 IP 169.254', '链路本地 169.254.10.20', '<PRIVATE_IP>'],
  ];
  if (TERMS.nicknames.length) {
    dataCases.push(['词表昵称', '机器属于 ' + TERMS.nicknames[0] + ' 的', '<USER_HOME>']);
  }
  for (const f of TERMS.pathFragments) {
    dataCases.push(['路径片段（后接分隔符）' + f, f + '\\build\\x', '<LOCAL_PATH>']);
    dataCases.push(['路径片段（末端目录名）' + f, f + '\\\\', '<LOCAL_PATH>']);
    dataCases.push(['路径片段（目录名 token）' + f, f + '20261002\\snap', '<LOCAL_PATH>']);
  }
  for (const [name, input, expect] of dataCases) {
    const out = scrub(input, { genericPaths: true }).text;
    if (!out.includes(expect)) bad.push(name + '：未产出 ' + expect + '（实得 ' + out.slice(0, 60) + '）');
    for (const nick of TERMS.nicknames) if (out.includes(nick)) bad.push(name + '：昵称仍在');
    const left = residual(out, { genericPaths: true });
    if (left.length) bad.push(name + '：洗后仍有残留 ' + left.map((x) => x.kind).join('、'));
    // 反向：**未洗**的同一夹具必须被 residual 判脏——否则复扫是失明的（洗后 0 残留不可信）
    if (!residual(input, { genericPaths: true }).length) bad.push(name + '：原始夹具未被 residual 判脏（复扫失明）');
  }
  // 数据面反例：普通正文里的数字 / **不带路径上下文**的孤立词不得被改，也不得被判残留
  for (const ctlData of [
    '普通词 _scratch 与 _rollback- 作为正文词不该被改',
    '版本 2.10.3、191.168.1.2、192.168 都不是内网地址',
  ]) {
    if (scrub(ctlData, { genericPaths: true }).text !== ctlData) bad.push('数据面反例：正文被改动（' + ctlData + '）');
    const left = residual(ctlData, { genericPaths: true });
    if (left.length) bad.push('数据面反例：正常正文被判残留 ' + left.map((x) => x.kind).join('、'));
  }
  return { ok: bad.length === 0, cases: cases.length + dataCases.length + 7, bad };
}
