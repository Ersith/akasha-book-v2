// 阿卡夏协作信箱（intercom v2）—— 工程（project）分组的协作消息层，append-only。
//
// 为什么是「信箱 + 工程」而不是单一聊天室：
//   · 异步：各方不在同一时刻在线，消息要能落盘等对方
//   · 可确认：「我发了」和「她看到了」是两件事，必须能查 acked
//   · 可追溯：append-only 落在 logs 里，天然是记忆
//   · 分工程：一个工程 = 一个会话现场；成员显式 join/leave，不靠超时推断
//     （2026-10-20 Master 裁定：暂完工作不等于退出，必须由成员自己声明离场）
//
// 文件：<akasha>/logs/intercom.jsonl（运行时日志，不入 git）
// 五类行（同一个 append-only 文件，靠 kind 区分）：
//   proj   { kind:'proj',  id, ts, project, title, workspace? } 工程登记
//          可选映射：codexSectionId, codexProjectId, codexThreadId, repository, repoRemote, branch, prUrl
//          clearFields?: 显式清除映射字段的白名单数组；省略字段仍保留
//   join   { kind:'join',  id, ts, project, peer, agent, role }  成员加入
//          可选身份：identity, displayName, sessionTitle, model, modelProvider, modelSource, effort, sessionId, workspace
//   leave  { kind:'leave', id, ts, project, peer }               成员离场
//   msg    { kind:'msg',   id, ts, project, from, to, type, subject, body, refs, replyTo? }
//   ack    { kind:'ack',   id, ts, by, acks }                    acks 指向消息 id
//
// 读取时按 project 折叠当前成员，并把 ack 合并回消息（都不改原行）。
import { readFileSync, appendFileSync, existsSync, mkdirSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFileLock } from './lib.mjs';

const ROOT = process.env.AKASHA_ROOT
  ? String(process.env.AKASHA_ROOT)
  : join(dirname(fileURLToPath(import.meta.url)), 'data');
const LOGS = process.env.AKASHA_LOGS
  ? String(process.env.AKASHA_LOGS)
  : join(dirname(fileURLToPath(import.meta.url)), 'logs');

export const INTERCOM_FILE = join(LOGS, 'intercom.jsonl');

/** 未指定工程时的兜底（旧消息全部落在这里，保证向后兼容）。 */
export const DEFAULT_PROJECT = 'general';

// 允许的消息类型：刻意少，逼每类都有明确用途。
export const INTERCOM_TYPES = Object.freeze(['note', 'ask', 'result', 'blocker']);

const IDENTITY_FIELDS = ['identity', 'displayName', 'sessionTitle', 'model', 'modelProvider', 'modelSource', 'effort', 'sessionId', 'workspace'];
const PROJECT_FIELDS = ['workspace', 'codexSectionId', 'codexProjectId', 'codexThreadId', 'repository', 'repoRemote', 'branch', 'prUrl'];

function httpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

function optionalMetadata(input, fields = IDENTITY_FIELDS, ignoreInvalid = false) {
  const values = {};
  for (const key of fields) {
    const value = input[key];
    if (value === undefined || (typeof value === 'string' && !value.trim())) continue;
    const directory = key === 'workspace' || key === 'repository';
    const valid = typeof value === 'string'
      && (!directory || /^(?:\/|[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value.trim()))
      && (key !== 'prUrl' || httpUrl(value.trim()));
    if (!valid) {
      if (ignoreInvalid) continue;
      return { error: directory ? `${key} 必须是绝对目录路径` : key === 'prUrl' ? 'prUrl 必须是 HTTP/HTTPS URL' : `${key} 必须是字符串` };
    }
    values[key] = value.trim();
  }
  return { values };
}

function ensureDir(file) {
  const d = dirname(file);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function parseLines(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过：日志面坏行不遮主流程 */ }
  }
  return out;
}

function newId(prefix) {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${t}-${r}`;
}

function recoveryError(message) {
  const error = new Error(message);
  error.code = 'RECOVERY_REQUIRED';
  return error;
}

/** 只在 .append 锁内读边界：完整 JSON 缺 LF 可补；真正不完整的尾巴必须保留并拒绝写入。 */
function inspectBoundary(file) {
  if (!existsSync(file)) return { ok: true, needsLF: false };
  const text = readFileSync(file, 'utf8');
  if (!text) return { ok: true, needsLF: false };
  const endsLF = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsLF) lines.pop();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { JSON.parse(lines[i]); }
    catch {
      return { ok: false, partial: i === lines.length - 1 && !endsLF, line: i + 1 };
    }
  }
  return { ok: true, needsLF: !endsLF };
}

function repairLineBoundary(file) {
  if (!existsSync(file)) return;
  withFileLock(file + '.append', () => {
    const state = inspectBoundary(file);
    if (!state.ok) throw recoveryError(`协作日志第 ${state.line} 行不是完整 JSON，需先恢复；未写入新记录`);
    if (state.needsLF) appendFileSync(file, '\n', { encoding: 'utf8', flush: true });
  });
}

function appendRowUnlocked(row, file) {
  const state = inspectBoundary(file);
  if (!state.ok) throw recoveryError(`协作日志第 ${state.line} 行不是完整 JSON，需先恢复；未写入新记录`);
  if (state.needsLF) appendFileSync(file, '\n', { encoding: 'utf8', flush: true });
  appendFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8', flush: true });
  verifyRow(row, file);
  return row;
}

function appendRow(row, opts = {}) {
  const file = opts.file || INTERCOM_FILE;
  ensureDir(file);
  // All core appenders (ordinary sends and standalone ACKs included) serialize
  // boundary repair plus append. Keep incomplete bytes as their own bad line.
  withFileLock(file + '.append', () => appendRowUnlocked(row, file));
  return row;
}

function verifyRow(row, file) {
  const matches = readIntercom(file).filter(saved => saved.id === row.id);
  if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(row)) {
    throw new Error(`协作日志追加未核验：${row.id}`);
  }
}

/** 读全部行（消息、回执、成员变动原样）。 */
export function readIntercom(file = INTERCOM_FILE) {
  if (!existsSync(file)) return [];
  return parseLines(readFileSync(file, 'utf8'));
}

/** 工程名归一：空/非法 ⇒ DEFAULT_PROJECT。 */
export function normalizeProject(v) {
  const s = String(v || '').trim();
  if (!s) return DEFAULT_PROJECT;
  if (!/^[a-zA-Z0-9._/-]{1,64}$/.test(s)) return null;   // 非法返回 null，由调用方拒绝
  return s;
}

/**
 * 折叠成「消息 + 已读回执」的当前视图（不含成员）。按 ts 升序。
 * 保留 v1 行为：只取 kind==='msg'，acks 合并回消息。
 */
export function foldIntercom(rows) {
  const acksByMsg = new Map();
  for (const r of rows) {
    if (!r || r.kind !== 'ack' || typeof r.acks !== 'string') continue;
    if (!acksByMsg.has(r.acks)) acksByMsg.set(r.acks, []);
    acksByMsg.get(r.acks).push({ by: r.by ?? null, ts: r.ts ?? null });
  }
  const msgs = rows.filter((r) => r && r.kind === 'msg' && typeof r.id === 'string');
  return msgs
    .map((m) => {
      const acks = acksByMsg.get(m.id) ?? [];
      return { ...m, project: m.project || DEFAULT_PROJECT, acks, acked: acks.length > 0 };
    })
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

/**
 * 折叠工程视图：每个工程的标题、当前成员（join 后有 leave 即离场）、消息数、最后活动。
 * 成员变更按 (project, peer) 取最后一条 join/leave 决定在场。
 */
export function foldProjects(rows) {
  const projects = new Map();
  const touch = (name) => {
    if (!projects.has(name)) {
      projects.set(name, { project: name, title: '', members: new Map(), msgs: 0, lastTs: null, createdAt: null, closed: false });
    }
    return projects.get(name);
  };
  for (const r of rows) {
    if (!r || typeof r.kind !== 'string') continue;
    const name = r.project || DEFAULT_PROJECT;
    const p = touch(name);
    if (r.ts && (!p.lastTs || String(r.ts) > String(p.lastTs))) p.lastTs = r.ts;
    if (r.kind === 'proj') {
      p.title = r.title || p.title;
      p.createdAt = r.ts || p.createdAt;
      if (r.closed !== undefined) p.closed = !!r.closed;
      if (Array.isArray(r.clearFields)) {
        for (const key of r.clearFields) if (PROJECT_FIELDS.includes(key)) delete p[key];
      }
      Object.assign(p, optionalMetadata(r, PROJECT_FIELDS, true).values);
    } else if (r.kind === 'join' && r.peer) {
      const previous = p.members.get(r.peer);
      const member = {
        ...previous, peer: r.peer,
        agent: r.agent === undefined ? previous?.agent ?? null : r.agent || null,
        role: r.role === undefined ? previous?.role ?? '' : r.role || '',
        ...optionalMetadata(r, IDENTITY_FIELDS, true).values,
        joinedAt: r.ts || null, active: true,
      };
      delete member.leftAt;
      p.members.set(r.peer, member);
    } else if (r.kind === 'leave' && r.peer) {
      const m = p.members.get(r.peer);
      if (m) { m.active = false; m.leftAt = r.ts || null; }
      else p.members.set(r.peer, { peer: r.peer, agent: null, role: '', joinedAt: null, leftAt: r.ts || null, active: false });
    } else if (r.kind === 'msg') {
      p.msgs += 1;
    }
  }
  return [...projects.values()]
    .map((p) => ({ ...p, members: [...p.members.values()] }))
    .sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
}

// ── 工程与成员 ────────────────────────────────────────────────────────────

/** 登记或更新工程映射；省略字段保留，clearFields 显式清除，信息不变时不追加（串行幂等）。 */
export function createProject(name, details = {}, opts = {}) {
  const p = normalizeProject(name);
  if (!p) return { ok: false, error: '工程名非法：只允许字母数字 . _ / -，长度 ≤64' };
  if (details.clearFields !== undefined && (!Array.isArray(details.clearFields)
    || details.clearFields.some((key) => !PROJECT_FIELDS.includes(key)))) {
    return { ok: false, error: `clearFields 必须是工程映射字段数组：${PROJECT_FIELDS.join(', ')}` };
  }
  const clearFields = [...new Set(details.clearFields || [])];
  if (clearFields.some((key) => details[key] !== undefined)) {
    return { ok: false, error: '同一个工程映射字段不能同时设置与清除' };
  }
  const metadata = optionalMetadata(details, PROJECT_FIELDS);
  if (metadata.error) return { ok: false, error: metadata.error };
  const rows = readIntercom(opts.file);
  const cur = foldProjects(rows).find((x) => x.project === p);
  const next = {
    title: String(details.title || '').trim() || cur?.title || '',
    ...optionalMetadata(cur || {}, PROJECT_FIELDS, true).values,
    ...metadata.values,
  };
  for (const key of clearFields) delete next[key];
  if (cur && !clearFields.some((key) => Object.hasOwn(cur, key))
    && Object.entries(next).every(([key, value]) => cur[key] === value)) {
    return { ok: true, project: p, created: false, already: true };
  }
  const row = {
    kind: 'proj', id: newId('proj'), ts: new Date().toISOString(), project: p,
    ...(details.title !== undefined && String(details.title).trim() ? { title: String(details.title).trim() } : {}),
    ...metadata.values,
    ...(clearFields.length ? { clearFields } : {}),
  };
  appendRow(row, opts);
  return { ok: true, project: p, created: !cur, already: false, id: row.id };
}

/** 成员加入或更新身份（幂等：已在场且提供的信息不变则返回 already）。 */
export function joinProject(name, peer, details = {}, opts = {}) {
  const p = normalizeProject(name);
  if (!p) return { ok: false, error: '工程名非法' };
  const who = String(peer || '').trim();
  if (!who) return { ok: false, error: '必须给成员 id（--as）' };
  const metadata = optionalMetadata(details);
  if (metadata.error) return { ok: false, error: metadata.error };
  const rows = readIntercom(opts.file);
  const proj = foldProjects(rows).find((x) => x.project === p);
  const cur = proj && proj.members.find((m) => m.peer === who);
  const next = {
    agent: details.agent === undefined ? cur?.agent ?? null : details.agent ? String(details.agent) : null,
    role: details.role === undefined ? cur?.role ?? '' : String(details.role || ''),
    ...optionalMetadata(cur || {}, IDENTITY_FIELDS, true).values,
    ...metadata.values,
  };
  if (cur?.active && Object.entries(next).every(([key, value]) => cur[key] === value)) {
    return { ok: true, project: p, peer: who, already: true };
  }
  const row = { kind: 'join', id: newId('join'), ts: new Date().toISOString(), project: p, peer: who };
  if (details.agent !== undefined) row.agent = details.agent ? String(details.agent) : null;
  if (details.role !== undefined) row.role = String(details.role || '');
  Object.assign(row, metadata.values);
  appendRow(row, opts);
  return { ok: true, project: p, peer: who, already: false, id: row.id };
}

/** 成员离场（幂等：已不在场则返回 already）。 */
export function leaveProject(name, peer, opts = {}) {
  const p = normalizeProject(name);
  if (!p) return { ok: false, error: '工程名非法' };
  const who = String(peer || '').trim();
  if (!who) return { ok: false, error: '必须给成员 id（--as）' };
  const rows = readIntercom(opts.file);
  const proj = foldProjects(rows).find((x) => x.project === p);
  const cur = proj && proj.members.find((m) => m.peer === who);
  if (!cur || !cur.active) return { ok: true, project: p, peer: who, already: true };
  const row = { kind: 'leave', id: newId('leave'), ts: new Date().toISOString(), project: p, peer: who };
  appendRow(row, opts);
  return { ok: true, project: p, peer: who, already: false, id: row.id };
}

/** 工程列表（含成员与消息数）。 */
export function listProjects(opts = {}) {
  const rows = readIntercom(opts.file);
  return { ok: true, projects: foldProjects(rows) };
}

// ── 消息 ──────────────────────────────────────────────────────────────────

/**
 * 发一条消息。body 必填非空；project 缺省 general。
 * to 可空 —— 空表示群发（工程内所有成员）。
 */
export function sendIntercom({ from, to = '', project, type = 'note', subject = '', body, refs = [], replyTo } = {}, opts = {}) {
  if (!from) return { ok: false, error: '必须给 from（协作方 id）' };
  if (!INTERCOM_TYPES.includes(type)) return { ok: false, error: `type 非法：须为 ${INTERCOM_TYPES.join(' / ')}` };
  if (!body || !String(body).trim()) return { ok: false, error: 'body 不能为空' };
  const p = normalizeProject(project);
  if (!p) return { ok: false, error: '工程名非法：只允许字母数字 . _ / -，长度 ≤64' };
  // Only an explicit reply requests a receipt. Ordinary refs remain citations.
  if (replyTo !== undefined) {
    const exact = value => typeof value === 'string' && value.length > 0 && value === value.trim();
    if (!exact(replyTo) || !exact(from) || !exact(to)) {
      return { ok: false, sent: false, error: 'replyTo、from、to 必须是无首尾空白的非空字符串；回复必须定向原发送者' };
    }
    const file = opts.file || INTERCOM_FILE;
    let durableReply;
    let already = false;
    try {
      // Serialize explicit replies across short CLI processes. A crash after the
      // message append is repaired by reusing replyTo on the next invocation.
      return withFileLock(file + '.reply', () => {
        const rows = readIntercom(file);
        const source = rows.find(row => row.kind === 'msg' && row.id === replyTo);
        const currentProject = foldProjects(rows).find(item => item.project === p);
        if (!source || (source.project || DEFAULT_PROJECT) !== p || source.from === from || source.from !== to) {
          return { ok: false, sent: false, error: 'replyTo 须为同工程收到的准确消息，回复目标须为原发送者' };
        }
        if (currentProject?.closed) return { ok: false, sent: false, error: '工程已关闭，不能回复或补回执' };
        const addressable = source.to
          ? source.to === from
          : currentProject?.members.some(member => member.peer === from && member.active);
        if (!addressable) return { ok: false, sent: false, error: '原消息未发给当前回复者；群发须由本工程在场成员回复' };
        const replyRefs = [...new Set([...(Array.isArray(refs) ? refs.map(String) : []), `intercom:${replyTo}`])];
        const existing = rows.find(row => row.kind === 'msg' && (row.project || DEFAULT_PROJECT) === p
          && row.from === from && row.to === to && row.replyTo === replyTo && row.type === type);
        if (existing && (existing.body !== String(body) || existing.subject !== String(subject || '')
          || JSON.stringify(existing.refs) !== JSON.stringify(replyRefs))) {
          return { ok: false, sent: false, id: existing.id, error: '同一 replyTo/from/to/type 已有不同回复内容；请明确发送新消息而非重试' };
        }
        durableReply = existing || {
          kind: 'msg', id: newId('msg'), ts: new Date().toISOString(), project: p,
          from, to, type, subject: String(subject || ''), body: String(body), refs: replyRefs, replyTo,
        };
        already = !!existing;
        if (!existing) appendRow(durableReply, opts);
        verifyRow(durableReply, file);
        let receipt;
        try {
          receipt = ackIntercom(replyTo, from, opts);
          if (receipt.ok) {
            verifyRow(durableReply, file);
            if (!readIntercom(file).some(row => row.kind === 'ack' && row.acks === replyTo && row.by === from)) {
              receipt = { ok: false, error: '回执追加后不可读取' };
            }
          }
        }
        catch (error) { receipt = { ok: false, ...(error?.code ? { code: error.code } : {}), error: String(error?.message || error) }; }
        return {
          ok: receipt.ok, sent: true, already, id: durableReply.id, row: durableReply, receipt,
          ...(receipt.code === 'RECOVERY_REQUIRED'
            ? { code: receipt.code, error: '回复已落盘，但协作日志需先恢复；恢复前不要重复发送' }
            : (!receipt.ok ? { error: '回复已投递但回执未完成；使用相同 replyTo 与内容重试可补回执，不会重复发送' } : {})),
        };
      });
    } catch (error) {
      // Append errors can occur after a complete write. Report the durable ID
      // when it can be verified, but never ACK a failed/unconfirmed send.
      let saved = false;
      try { saved = !!durableReply && readIntercom(file).some(row => row.kind === 'msg' && row.id === durableReply.id); } catch { /* unconfirmed */ }
      return { ok: false, sent: saved, already, ...(saved ? { id: durableReply.id, row: durableReply } : {}),
        error: String(error?.message || error), ...(error?.code ? { code: error.code } : {}),
        ...(saved ? { receipt: { ok: false, error: '发送过程失败；尚未确认回执' } } : {}) };
    }
  }
  const row = appendRow({
    kind: 'msg',
    id: newId('msg'),
    ts: new Date().toISOString(),
    project: p,
    from: String(from),
    to: to ? String(to) : '',
    type,
    subject: String(subject || ''),
    body: String(body),
    refs: Array.isArray(refs) ? refs.map(String) : [],
  }, opts);
  return { ok: true, id: row.id, row };
}

/** 给某条消息盖已读回执。重复 ack 同一方同一消息 ⇒ 幂等返回 already。 */
export function ackIntercom(id, by, opts = {}) {
  if (!id || !by) return { ok: false, error: '必须给消息 id 与 ack 的 by' };
  const file = opts.file || INTERCOM_FILE;
  ensureDir(file);
  try {
    return withFileLock(file + '.append', () => {
      const state = inspectBoundary(file);
      if (!state.ok) throw recoveryError(`协作日志第 ${state.line} 行不是完整 JSON，需先恢复；未写入新记录`);
      if (state.needsLF) appendFileSync(file, '\n', { encoding: 'utf8', flush: true });
      const folded = foldIntercom(readIntercom(file));
      const msg = folded.find((m) => m.id === id);
      if (!msg) return { ok: false, error: `找不到消息：${id}` };
      if (msg.acks.some((a) => a.by === String(by))) return { ok: true, already: true, id };
      appendRowUnlocked({ kind: 'ack', id: newId('ack'), ts: new Date().toISOString(), by: String(by), acks: String(id) }, file);
      return { ok: true, already: false, id };
    });
  } catch (error) {
    return { ok: false, code: error.code || null, error: String(error?.message || error) };
  }
}

/**
 * 某人视角的消息箱。
 * project 给了就只看该工程。
 */
export function inboxIntercom({ for: who, project, unreadOnly = false, limit = 50 } = {}, opts = {}) {
  if (!who) return { ok: false, error: '必须给 --for（你的协作方 id）' };
  const all = foldIntercom(readIntercom(opts.file));
  const p = project ? normalizeProject(project) : null;
  if (project && p === null) return { ok: false, error: `工程名非法：${project}` };
  const scoped = p ? all.filter((m) => m.project === p) : all;
  // 群发也算收件；自己的发言不进收件箱，已读只认当前收件人的回执。
  const mine = scoped
    .filter((m) => m.from !== String(who) && (m.to === String(who) || m.to === ''))
    .map((m) => ({ ...m, acked: m.acks.some((a) => a.by === String(who)) }));
  const rows = unreadOnly ? mine.filter((m) => !m.acked) : mine;
  const tail = rows.slice(-Math.max(1, limit));
  return { ok: true, total: mine.length, unread: mine.filter((m) => !m.acked).length, rows: tail };
}

/** 某工程的消息流（聊天界面用）：按 ts 升序，附 ack 状态。 */
export function projectFeed(name, { limit = 100 } = {}, opts = {}) {
  const p = normalizeProject(name);
  if (!p) return { ok: false, error: '工程名非法' };
  const all = foldIntercom(readIntercom(opts.file)).filter((m) => m.project === p);
  const proj = foldProjects(readIntercom(opts.file)).find((x) => x.project === p) || { project: p, title: '', members: [] };
  return { ok: true, project: p, title: proj.title, ...optionalMetadata(proj, PROJECT_FIELDS, true).values, members: proj.members, total: all.length, rows: all.slice(-Math.max(1, limit)) };
}

/** 全局概览：按协作方聚合收发/未读（保留 v1 口径）。 */
export function intercomSummary(opts = {}) {
  const all = foldIntercom(readIntercom(opts.file));
  const byPeer = new Map();
  const touch = (p) => {
    if (!p) return null;
    if (!byPeer.has(p)) byPeer.set(p, { peer: p, sent: 0, recv: 0, unreadForThem: 0, lastTs: null });
    return byPeer.get(p);
  };
  for (const m of all) {
    const a = touch(m.from);
    if (a) { a.sent += 1; a.lastTs = m.ts; }
    const b = touch(m.to);
    if (b) { b.recv += 1; if (!m.acked) b.unreadForThem += 1; b.lastTs = m.ts; }
  }
  return { total: all.length, peers: [...byPeer.values()].sort((x, y) => String(y.lastTs).localeCompare(String(x.lastTs))) };
}
