// verify-npm-publish.mjs —— 直读 registry 公开接口核验发布结果（不依赖 npm CLI 的本地缓存）。
// 口径（来自 canon-npm-publish-20261010-r1 的教训）：只看两处 —— versions 数组里有没有该版本 + dist-tags.latest 指向。
// 用法：node tools/verify-npm-publish.mjs
const EXPECT = {
  '@akasha-book/gate': '1.4.3',
  '@akasha-book/hooks': '1.2.9',
  '@akasha-book/session': '0.3.6',
  '@akasha-book/sleep': '1.10.31',
  '@akasha-book/mcp': '1.1.5',
};
const PROXY = process.env.HTTPS_PROXY || 'http://127.0.0.1:7897';

async function getJSON(url) {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    // 2026-10-19（独立审核 F5）：这里原本用 undici 的 ProxyAgent 取代理——
    //   它是 core「零第三方依赖」的**唯一破例**，而 OSS 里没有 package.json/node_modules ⇒
    //   这个分支必然 ERR_MODULE_NOT_FOUND（本机代理环境很可能会走到）。
    //   改为不引入依赖：走代理请用 Node 内置能力（Node ≥24：设 HTTPS_PROXY + NODE_USE_ENV_PROXY=1 后重跑，
    //   内置 fetch 会读环境代理）；下面把失败原因与出口一起抛出来，别再静默。
    throw new Error('直连失败（' + String(e?.message ?? e).slice(0, 80) + '）'
      + '；如需代理：设 HTTPS_PROXY=' + PROXY + ' 且 NODE_USE_ENV_PROXY=1 后重跑（Node ≥24 内置 fetch 支持）');
  }
}

let ok = 0, bad = 0;
for (const [name, want] of Object.entries(EXPECT)) {
  const url = 'https://registry.npmjs.org/' + name.replace('/', '%2F');
  try {
    const data = await getJSON(url);
    const inVersions = Object.keys(data.versions || {}).includes(want);
    const latest = (data['dist-tags'] || {}).latest;
    const latestOk = latest === want;
    const modified = data.time && data.time[want] ? String(data.time[want]).slice(0, 19) : '(无)';
    const verdict = inVersions && latestOk ? '✅' : (inVersions ? '⚠ latest 未指向' : '❌ 版本不在册');
    console.log('  ' + verdict + ' ' + name.padEnd(24) + ' 期望 ' + want.padEnd(8) + ' 在册=' + inVersions + '  latest=' + String(latest).padEnd(8) + '  发布时间 ' + modified);
    if (inVersions && latestOk) ok++; else bad++;
  } catch (e) {
    console.log('  ✗ ' + name.padEnd(24) + ' 读取失败：' + e.message);
    bad++;
  }
}
console.log('  ────────');
console.log('  通过 ' + ok + ' / 待查 ' + bad + '（registry 直读，无本地缓存干扰）');

process.exit(bad ? 1 : 0);