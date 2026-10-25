// 漂移检查 v2：分级输出（代码漂移 = 必须动作；仅版本号漂移 = 提示，无需动作）
// 起因：v1 首跑报 4 个插件 ✗ —— 查清后**代码全部一致、只有 package.json 的 version 超前** ✗
//   ⇒ 若不分级，每天报 4 个假警，人会开始忽视它（狼来了）⇒ 分级 ✓
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PLUGINS = [
  { name: '@akasha-book/akasha-gate', src: '<LOCAL_PATH>/dsh-akasha-gate', code: ['index.js', 'prompt-safety.js'] },
  { name: '@akasha-book/akasha-sleep', src: '<LOCAL_PATH>/dsh-akasha-sleep', code: ['lib/index.js', 'lib/prompt-safety.js'] },
  { name: '@akasha-book/akasha-session', src: '<LOCAL_PATH>/dsh-akasha-session', code: ['lib/index.js'] },
  { name: '@akasha-book/akasha-hooks', src: '<LOCAL_PATH>/dsh-akasha-hooks', code: ['index.js'] },
  { name: '@akasha-book/mcp-akasha', src: '<LOCAL_PATH>/dsh-mcp-akasha', code: ['index.js', 'mcp.mjs'] },
];
const PROFILE = '<LOCAL_PATH>/official-home/profiles/desktop/node_modules';
const quiet = process.argv.includes('--quiet');
const say = (...a) => { if (!quiet) console.log(...a); };

let codeDrift = 0, verDrift = 0;
say('══ 插件源码 / 安装包漂移检查（分级）══');
for (const p of PLUGINS) {
  const dst = join(PROFILE, p.name);
  if (!existsSync(dst)) { say('  ⚠ ' + p.name + '：profile 里不在'); continue; }
  const codeDiffs = [];
  for (const f of p.code) {
    const a = join(p.src, f), b = join(dst, f);
    if (!existsSync(a) || !existsSync(b)) continue;
    if (!readFileSync(a).equals(readFileSync(b))) codeDiffs.push(f);
  }
  // 版本号
  let vSrc = '?', vDst = '?';
  try { vSrc = JSON.parse(readFileSync(join(p.src, 'package.json'), 'utf8')).version; } catch {}
  try { vDst = JSON.parse(readFileSync(join(dst, 'package.json'), 'utf8')).version; } catch {}

  if (codeDiffs.length) {
    codeDrift++;
    say('  ✗ ' + p.name + ' —— **代码**漂移（必须动作）：' + codeDiffs.join(', '));
    say('     ⇒ 重打包 → install_bundle → 重启');
  } else if (vSrc !== vDst) {
    verDrift++;
    say('  · ' + p.name + ' —— 仅版本号超前（' + vSrc + ' vs ' + vDst + '）· 代码一致 ⇒ 无需动作 ✓');
  } else {
    say('  ✓ ' + p.name + '（代码与版本都一致）');
  }
}
say('');
say(codeDrift ? '  结论：' + codeDrift + ' 个插件**代码漂移** ⇒ 改动尚未生效 ✗（另 ' + verDrift + ' 个仅版本号超前）'
              : '  结论：✓ 无代码漂移' + (verDrift ? '（' + verDrift + ' 个仅版本号超前，无需动作）' : ''));
process.exit(codeDrift ? 1 : 0);
