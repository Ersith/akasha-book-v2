// akasha/tools/store-submit-20261010.mjs —— 向 DSH-Store 提交 5 条上架申请（monorepo 子路径）
// 方式：走 GitHub API，凭据由 git credential fill 取得（仅内存使用，绝不打印）。
// 每个插件一个 Issue（表单字段：repository / plugin-path / notes）。
import { execFileSync } from 'node:child_process';

const REPO_URL = 'https://github.com/Ersith/akasha-book-v2';
const TARGET = 'AI-Scarlett/DSH-Store';

const PLUGINS = [
  ['akasha-gate', '@akasha-book/gate', '写入门控 + 纪律注入（渲染时读库）：拦截对记忆库数据目录的直写，并向系统提示注入来源态约定与自我层。'],
  ['akasha-hooks', '@akasha-book/hooks', '事件记录 + 输出审计：回合/工具/流式帧 → append-only 观测线（usage / output-audit），供排序与审计使用。'],
  ['akasha-session', '@akasha-book/session', '会话层调度：会话档案增量索引（worker 线程 + 单飞节流）+ 压缩事件行 + 每回合节奏条 + 循环观测（dry 干跑）。'],
  ['akasha-sleep', '@akasha-book/sleep', '离线巩固调度：空闲/定时蒸馏 → 睡眠报告 + 候选待办；每回合条子与新会话唤醒条；失败不推进水位线。'],
  ['mcp-akasha', '@akasha-book/mcp', 'MCP 注册桥：把外置记忆层（本仓 core/mcp.mjs）的工具以 mcp__akasha__* 暴露给模型（stdio，经官方 @deepseek-ai/dsh-mcp-client 装载）。'],
];

const cred = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
const token = (cred.match(/^password=(.+)$/m) || [])[1];
if (!token) { console.log('未取到 GitHub 凭据'); process.exit(1); }
console.log('  凭据已取得（不打印）');

async function createIssue(plugin, pkg, blurb) {
  const body = [
    '### GitHub repository', '', REPO_URL, '',
    '### Plugin path (optional)', '', `plugins/${plugin}`, '',
    '### Notes (optional)', '',
    `${pkg} —— 阿卡夏之书（Akasha）外置记忆层五件之一：${blurb}`,
    '',
    `- 兼容声明：\`dsh.compatibility.dshReleases\` = {0.2.0-rc.2: compatible, 0.2.1-alpha.1: compatible, 0.2.1-alpha.2: compatible}（三版 × 一次性 Profile 实跑：install → 冷启动 HTTP 就绪 → 卸载 → \`--dump-config\` 逐字回到基线）。`,
    `- 证据：\`plugins/${plugin}/EVIDENCE.json\`；权限与非目标见同目录 README 的「兼容与状态」节。`,
    '- 零依赖、无 install/prepare/build/test 生命周期脚本；不 disable/replace 任何 `@deepseek-ai/*` 官方组件（入口 ID 为插件自有）。',
  ].join('\n');

  const r = await fetch(`https://api.github.com/repos/${TARGET}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'akasha-book-submission' },
    body: JSON.stringify({ title: `[Plugin] ${plugin} (${pkg})`, body }),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* ignore */ }
  if (r.status === 201 && j) return { ok: true, number: j.number, url: j.html_url };
  return { ok: false, status: r.status, error: (j && j.message ? j.message : t.slice(0, 200)) };
}

const results = [];
for (const [plugin, pkg, blurb] of PLUGINS) {
  const res = await createIssue(plugin, pkg, blurb);
  results.push([plugin, res]);
  console.log('  ' + plugin.padEnd(16) + (res.ok ? '✓ #' + res.number + '  ' + res.url : '✗ ' + res.status + ' ' + res.error));
  await new Promise((d) => setTimeout(d, 1500)); // 温和限速
}
console.log('  成功 ' + results.filter(([, r]) => r.ok).length + '/' + results.length);
