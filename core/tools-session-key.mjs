// 段/结构行的**归一内容键**（纯函数；2026-10-15 GPT 复核 N4 收尾：shape 与 migrate 必须共用同一函数，
// 否则两边对「什么是重复」给出相反结论；首版两工具各写各的即踩此坑）。
// 口径：
//   - node：不参与去重（同 id 多代是设计）——调用方自行跳过；
//   - topic（无 id、无整数 seq，代次靠 treegen/fingerprint）：按【代次 + 指纹】折叠，**绝不**把两代话题当重复；
//   - promotion（有 id、无 session/seq）：按自身 id 折叠（不同目标绝不合）；
//   - 机械段（整数 seq）：按归一会话键 + 内容折叠（与 session.mjs 索引跳过口径一致）；
//   - 其余（无整数 seq 的手工行）：优先按 id；连 id 都没有就按整行内容（相同行才合并，绝不误并）。
export const normSid = (s) => String(s ?? '').replace(/^session-/, '');

export function contentKeyOf(r) {
  const kind = String(r?.kind ?? '');
  if (kind === 'topic') return JSON.stringify(['#topic', Number(r.treegen) || 0, String(r.fingerprint ?? '')]);
  if (kind === 'promotion') return JSON.stringify(['#id', String(r.id ?? '')]);
  if (Number.isInteger(r?.seq)) {
    return JSON.stringify([normSid(r.session), r.seq, r.kind, r.gist, r.why ?? '', Array.isArray(r.tools) ? r.tools : String(r.tools ?? '')]);
  }
  return JSON.stringify(['#id', String(r.id ?? JSON.stringify(r))]);
}
