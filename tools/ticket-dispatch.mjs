#!/usr/bin/env node
/**
 * tools/ticket-dispatch.mjs —— 「超级大肥鱼」派活调度器
 *
 * 它做什么：
 *   读票板 → 算出「谁该动」→ 生成派活计划 → 可选把 `**派活**` 行写进票块
 *   真正的"发消息"由 DSH 会话执行（cross_session_send），本脚本只负责**算准 + 记账**
 *
 * 为什么不在脚本里直接发消息：
 *   派发走的是 DSH 的会话通道（插件 @deepseek-ai/dsh-cross-session-approval），
 *   它不是命令行工具；脚本硬写插件内部状态等于把脆弱假设焊进流程 ✗
 *   所以分工是：脚本算账（可测、可复跑）＋ 会话发消息（有权限、有上下文）✓
 *
 * 用法：
 *   node tools/ticket-dispatch.mjs                     # 看板：谁该动、几张、多久没动
 *   node tools/ticket-dispatch.mjs --json              # 机器可读
 *   node tools/ticket-dispatch.mjs --emit docs/.dispatch-queue.json   # 给调度会话吃
 *   node tools/ticket-dispatch.mjs --write              # 把 `**派活**：@X 时间` 记进票块
 *   node tools/ticket-dispatch.mjs --agent 超级大肥鱼 --board docs/待办.md
 *
 * 退出码：0 = 有活可派；3 = 票板干净（无活）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTickets, queueOf, fieldOf, threadOf } from './lib/ticket-lint.mjs';
import { writeBoardGuarded, writeAtomic } from './lib/ticket-write.mjs';
import { W, glossaryText } from './lib/theme.mjs';
import { loadExperiences, matchExperiences } from './lib/experience.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);

const BOARD = path.resolve(arg('--board', path.join(ROOT, 'docs/待办.md')));
const AGENT = arg('--agent', '超级大肥鱼');
const EMIT = arg('--emit', '');
const WRITE = flag('--write');
const JSONOUT = flag('--json');
const HOURS = Number(arg('--hours', '24'));          // 派出去多久没回票算"该催"
const DRY = flag('--dry-run');
const EXP_DIR = path.resolve(arg('--experiences', path.join(ROOT, 'docs/经验')));   // ★ T-20261103-F04

if (!existsSync(BOARD)) {
  console.error('✗ 找不到票板：' + BOARD + '\n  用 --board <路径> 指定');
  process.exit(2);
}

const text = readFileSync(BOARD, 'utf8');
const parsed = parseTickets(text);
const tickets = parsed.tickets;
const q = queueOf(tickets);

/* ── 派活记录：`**派活**：@某人 2026-11-02 10:13` ── */
const dispOf = (t) => {
  const raw = Array.isArray(t.dispatch) ? t.dispatch : (t.dispatch ? [t.dispatch] : []);
  return raw;
};
const hoursSince = (t) => {
  const recs = dispOf(t);
  if (!recs.length) return null;
  const last = recs[recs.length - 1];
  if (last && typeof last === 'object' && Number.isFinite(last.atMs)) return (Date.now() - last.atMs) / 36e5;
  const s = (last && typeof last === 'object') ? String(last.at || last.raw || '') : String(last);
  const m = s.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (!m) return null;
  const at = new Date(`${m[1]}T${m[2]}:00+08:00`).getTime();
  return Number.isNaN(at) ? null : (Date.now() - at) / 36e5;
};

const rows = [];
const push = (kind, t, who, why) => {
  const row = {
    kind, id: t.id, state: t.state, who, why,
    title: String(t.title || '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 60),
    dispatched: dispOf(t).length,
    hours: hoursSince(t),
    thread: String(t.thread || '').trim(),
  };
  rows.push(row);
  return row;                    // ★ F06：门要往这一行上写判定 ✓ 返回行本身 ✗ 不是数组长度 ✗
};

/* ── ★ T-20261103-F06：**机械门**（先于任何判断 ✗ 顺序写死 ✗）
   ① 缺负责人 → 缺验收方 → ② 同线程多票 → ③ WIP 上限 → ④ 通过
   为什么先判 ① 再判 ③：缺负责人／同线程的票**本来就不该占 WIP 名额** ✗ */
const WIP_LIMIT = (() => {
  try {
    const p = path.join(ROOT, 'docs', '.ticketrc.json');
    if (existsSync(p)) { const j = JSON.parse(readFileSync(p, 'utf8')); const n = Number(j && j.wipLimit); if (Number.isFinite(n) && n > 0) return n; }
  } catch (e) { }
  return 8;
})();
const activeAll = tickets.filter((x) => x.state === ' ' || x.state === '~' || x.state === 'v');
function gateOf(t) {
  const out = [];
  const owner = fieldOf(t, '负责人'), acceptor = fieldOf(t, '验收方');
  out.push({ gate: '① 缺负责人', ok: !!owner, code: 'missing-owner', why: owner ? '' : '票面没写负责人 ⇒ 不许真派' });
  out.push({ gate: '① 缺验收方', ok: !!acceptor, code: 'missing-acceptor', why: acceptor ? '' : '票面没写验收方 ⇒ 不许真派' });
  const th = threadOf(t);
  const sib = th ? activeAll.filter((x) => x.id !== t.id && threadOf(x) === th) : [];
  out.push({ gate: '② 同线程多票', ok: !sib.length, code: 'duplicate-thread', why: sib.length ? '同线程还有 ' + sib.length + ' 张：' + sib.map((x) => x.id).join('／') + '（允许人工派）' : '' });
  out.push({ gate: '③ WIP 上限（' + WIP_LIMIT + '）', ok: activeAll.length <= WIP_LIMIT, code: 'held-wip', why: activeAll.length > WIP_LIMIT ? '活跃票 ' + activeAll.length + ' 张 > 上限 ' + WIP_LIMIT + '（只拦新派，催与验收照常）' : '' });
  const blocked = out.filter((x) => !x.ok);
  return { gates: out, blocked, pass: blocked.length === 0 };
}

for (const t of q.open || []) {
  const h = hoursSince(t);
  if (dispOf(t).length && h !== null && h < HOURS) { push('已派待回', t, t.owner || '?', `已派 ${h.toFixed(1)}h（<${HOURS}h，先不催）`); continue; }
  const kind = dispOf(t).length ? '该催' : '待派';
  const row = push(kind, t, t.owner || '?', dispOf(t).length ? `已派 ${h === null ? '未知' : h.toFixed(1) + 'h'} 未回票` : '从未派过');
  if (kind === '待派') {
    const g = gateOf(tickets.find((x) => x.id === t.id) || t);   // ★ queueOf 给的是**行** ✗ 门要的是**票对象**（有 bodyLines）✗
    row.gates = g.gates;
    if (!g.pass) { row.held = g.blocked[0].code; row.heldWhy = g.blocked.map((x) => x.gate + '：' + x.why).join('；'); }
  }
}
for (const t of q.accept || []) push('待验收', t, t.acceptor || '?', '负责人已回票，等验收');
for (const t of q.missingAcceptor || []) push('缺验收方', t, '?', '票面没写验收方');
for (const t of q.missing || []) push('缺负责人', t, '?', '票面没写负责人');

const actionable = rows.filter(r => ['待派', '该催', '待验收', '该问进展'].includes(r.kind) && !r.held);
/* ── ★ T-20261103-F07：**Watchdog 轻量版**（认领后久无动静 ⇒ 问进展，不是催 ✗）
   · 条件：state=~ 且「最后一次派活/认领」> watchdogHours（默认 12，可配）且此后**没有**新回票
   · 与「该催」严格分开：该催＝24h 没人理；该问进展＝有人认领了但卡住
   · 去重：同一票 watchdogHours 内只提示一次（查决策日志里最近一条 reminded-watchdog）
   · 别误判「刚认领」：起点取**派活/认领时间** ✗ 不是建票时间 ✗ */
const WATCH_HOURS = (() => {
  try {
    const p = path.join(ROOT, 'docs', '.ticketrc.json');
    if (existsSync(p)) { const j = JSON.parse(readFileSync(p, 'utf8')); const n = Number(j && j.watchdogHours); if (Number.isFinite(n) && n > 0) return n; }
  } catch (e) { }
  return 12;
})();
const LOG_PATH = path.join(ROOT, 'docs', '决策日志.md');
const recentWatchdog = (id) => {
  try {
    if (!existsSync(LOG_PATH)) return false;
    const lines = readFileSync(LOG_PATH, 'utf8').split('\n').filter((l) => l.includes('reminded-watchdog') && l.includes('| ' + id + ' |'));
    if (!lines.length) return false;
    const last = lines[lines.length - 1];
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(last);
    if (!m) return false;
    const at = new Date(m[1] + 'T' + m[2] + ':00+08:00').getTime();
    return Number.isFinite(at) && (Date.now() - at) < WATCH_HOURS * 3600000;
  } catch (e) { console.warn('看门狗去重检查失败：' + ((e && e.message) || e)); return false; }
};
const dispatchAt = (t) => {
  const recs = dispOf(t);
  const last = recs[recs.length - 1];
  if (last && typeof last === 'object' && Number.isFinite(last.atMs)) return last.atMs;
  return null;
};
const repliesAfter = (t, atMs) => {
  const out = [];
  for (const r of (t.replies || [])) {
    const head = String(r.text || '');
    const m = /【(\d{1,2}):(\d{2})/.exec(head.split('\n')[0]);
    if (!m) continue;
    const d = new Date(atMs);
    let ts = new Date(d.getFullYear(), d.getMonth(), d.getDate(), +m[1], +m[2]).getTime();
    if (ts + 12 * 3600000 < atMs) ts += 24 * 3600000;      // 回票在派活之后（跨零点）
    if (ts >= atMs) out.push(r);
  }
  return out;
};
const WD = new Map();      // id → {atMs, ageH, replies, why}
for (const t of tickets) {
  if (t.state !== '~') continue;
  const at = dispatchAt(t);
  if (at === null) continue;
  const ageH = (Date.now() - at) / 3600000;
  if (ageH < WATCH_HOURS) continue;
  const reps = repliesAfter(t, at);
  if (reps.length) continue;
  WD.set(t.id, { atMs: at, ageH, replies: 0, why: `认领 ${ageH.toFixed(1)}h 无新回票（阈值 ${WATCH_HOURS}h）⇒ 问一句卡在哪、要不要降范围` });
}
for (const r of rows) {
  const w = WD.get(r.id);
  if (!w || r.held) continue;
  if (recentWatchdog(r.id)) { r.watchSkip = true; continue; }
  r.kind = '该问进展';
  r.watch = w;
  r.why = w.why;
}

/* ── ★ T-20261103-F06：`--explain <票号>` 把四道门逐条打出来（只读 ✓）── */
const EXPLAIN = arg('--explain', '');
if (EXPLAIN) {
  const t = tickets.find((x) => x.id === EXPLAIN);
  if (!t) { console.error('✗ 找不到票号：' + EXPLAIN); process.exit(2); }
  console.log('═══ 机械门判定：' + t.id + '（' + (t.title || '').slice(0, 40) + '）═══');
  const g = gateOf(t);
  for (const x of g.gates) console.log('  ' + (x.ok ? '✓ 通过' : '✗ 拦住') + '｜' + x.gate + (x.why ? '｜' + x.why : ''));
  /* ★ F07：看门狗依据（四个数字：派活时间／已过时长／阈值／期间回票）*/
  const _at = dispatchAt(t);
  if (_at === null) console.log('  ④ 看门狗｜没有派活记录 ⇒ 不判（该催那条管没派过的票）');
  else {
    const _age = (Date.now() - _at) / 3600000;
    const _reps = repliesAfter(t, _at).length;
    const _when = new Date(_at).toLocaleString('sv-SE', { timeZone: 'Asia/Hong_Kong' }).slice(0, 16);
    console.log('  ④ 看门狗｜派活 ' + _when + '｜已过 ' + _age.toFixed(1) + 'h｜阈值 ' + WATCH_HOURS + 'h｜期间回票 ' + _reps + ' 条'
      + (t.state !== '~' ? '｜（state=' + t.state + ' ⇒ 只对 [~] 生效）' : ''));
  }
  console.log('  ⇒ 判定：' + (g.pass ? 'dispatched（可以派）' : g.blocked[0].code + '（不派）'));
  process.exit(0);
}
/* ── ★ T-20261103-F04：**经验库 · 命中才注入** ──
   进消息的只有 id ＋ action 一行 ✗ 正文永远不进 ✗（这是这套设计唯一的价值 ✓）
   坏条目 ⇒ 跳过并 warn ✗ 不许让派活崩 ✗ */
const EXP = loadExperiences(EXP_DIR);
for (const b of EXP.bad) console.error('⚠ 经验条目跳过：' + b.file + '（' + b.why + '）');
if (EXP.list.length) {
  for (const r of rows) {
    const text = String(r.title || '') + ' ' + String(r.kind || '') + ' ' + String(r.why || '');
    r.experiences = matchExperiences(text, EXP.list, 3).map((e) => ({ id: e.id, action: e.action }));
  }
}

if (JSONOUT) {
  console.log(JSON.stringify({
    schemaVersion: 1, agent: AGENT, board: path.relative(ROOT, BOARD) || BOARD,
    generatedAt: new Date().toISOString(), thresholdHours: HOURS,
    counts: rows.reduce((a, r) => (a[r.kind] = (a[r.kind] || 0) + 1, a), {}),
    actionable: actionable.length,
    experiences: EXP.list.length,
    rows: rows.map((r) => Object.assign({}, r, { experiences: r.experiences || [] })),
  }, null, 1));
} else if (flag('--glossary')) {
  console.log(`═══ ${AGENT} · 术语表（小彩蛋） ═══\n`);
  console.log(glossaryText());
} else {
  console.log(`═══ ${AGENT} · 派活看板（${W.pond}巡检） ═══`);
  console.log(`票板：${path.relative(process.cwd(), BOARD) || BOARD}｜票 ${tickets.length} 张｜阈值 ${HOURS}h\n`);
  if (!rows.length) console.log(`（${W.pond}干净 ✓ 没有要喂的活）`);
  else {
    const order = { '待派': 0, '该催': 1, '待验收': 2, '已派待回': 3, '缺验收方': 4, '缺负责人': 5 };
    rows.sort((a, b) => (order[a.kind] - order[b.kind]) || String(a.id).localeCompare(String(b.id)));
    for (const r of rows) {
      console.log(`${r.kind.padEnd(5)}｜${String(r.id || '—').padEnd(16)}｜→ ${String(r.who).padEnd(10)}｜${r.title}`);
      if (r.why) console.log(`        └ ${r.why}`);
    }
    console.log(`\n可派/可催/可验：${actionable.length} 张（${W.chum} ${actionable.length} 条）`);
    const held = rows.filter((r) => r.held);
    if (held.length) {
      const by = {};
      for (const r of held) by[r.held] = (by[r.held] || 0) + 1;
      const detail = Object.entries(by).map(([k, v]) => k + ' ' + v).join('／');
      const first = held[0];
      console.log(`⛔ 机械门拦住 ${held.length} 张（${detail}）⇒ ${first.heldWhy ? first.heldWhy.split('；')[0] : '见 --explain'}（--explain <票号> 看单张）`);
    }
    if (actionable.length) {
      console.log('\n调度会话要做的事（一次一张，别群发）：');
      for (const r of actionable.slice(0, 8)) {
        const _ask = r.kind === '该问进展' ? '｜问一句：卡在哪、要不要降范围' : '';
        console.log(`  · cross_session_send → ${r.who}：「${r.id}｜${r.title}（${r.kind}）${r.thread ? '〔线程 ' + r.thread + '〕' : ''}${_ask}」`);
        for (const e of (r.experiences || []).slice(0, 3)) console.log(`      └ 经验：${e.id} —— ${e.action}`);
      }
    }
  }
}

/* ── 写派活记录 ── */
if (WRITE && actionable.length && !DRY) {
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Hong_Kong' }).slice(0, 16);
  let next = text;
  let wrote = 0;
  for (const r of actionable) {
    const t = tickets.find(x => x.id === r.id);
    if (!t || !t.end) continue;
    if (t.body && t.body.includes('**派活**')) continue;      // 已有记录不重复写
    const at = next.indexOf(t.raw);
    if (at < 0) continue;
    const block = t.raw;
    const lineBreak = block.includes('\r\n') ? '\r\n' : '\n';
    const insert = `${lineBreak}**派活**：@${r.who} ${stamp}（${AGENT}）`;
    // 插在票块最后一个非空行之后
    const trimmed = block.replace(/\s+$/, '');
    next = next.replace(block, trimmed + insert + lineBreak);
    wrote++;
  }
  if (wrote) {
    const res = writeBoardGuarded({ file: BOARD, before: text, after: next, who: 'ticket-dispatch' });
    if (res && res.ok === false) console.error('✗ 写票板失败：' + (res.error || '未知'));
    else console.log(`\n✓ 已记 ${wrote} 条派活记录（${AGENT}）`);
  } else console.log('\n（没有需要新记的派活）');
} else if (WRITE && DRY) {
  console.log(`\n（--dry-run：会记 ${actionable.length} 条，未写）`);
}

/* ── ★ T-20261103-F02：**决策日志**（append-only · 一行一决策） ──
   为什么：我们只记"派了"，不记"为什么没派" ⇒ 被问"这票怎么没人动"时答不上来 ✗
   列：时间 | 票号或线程 | 决定 | 理由代码 | 依据
   写入：走 ticket-write 的锁＋原子写 ✗ 不许裸 writeFileSync ✗（不存在则先原子建文件 ✓）*/
if (WRITE && !DRY && rows.length) {
  const stamp2 = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Hong_Kong' }).slice(0, 16);
  const REASON = { '待派': 'dispatched', '该催': 'reminded', '待验收': 'accepted', '已派待回': 'skipped-recent', '缺负责人': 'missing-owner', '缺验收方': 'missing-acceptor', '该问进展': 'reminded-watchdog' };
  const LOGF = path.resolve(ROOT, 'docs/决策日志.md');
  const HEAD = '# 决策日志（append-only · 一行一决策）\n\n> 列：时间 | 票号或线程 | 决定 | 理由代码 | 依据\n\n';
  const entries = rows.map((r) => {
    const code = r.held || REASON[r.kind] || 'skipped-recent';
    const why = String((r.held ? r.heldWhy : r.why) || '').replace(/\|/g, '／');
    return stamp2 + ' | ' + (r.thread || r.id || '—') + ' | ' + (r.held ? '拦住不派' : r.kind) + ' | ' + code + ' | ' + why;
  });
  const existed = existsSync(LOGF);
  const before = existed ? readFileSync(LOGF, 'utf8') : HEAD;
  const after = String(before).replace(/\s*$/, '') + '\n' + entries.join('\n') + '\n';
  if (!existed) {
    writeAtomic(LOGF, after);
    console.log(`\n✓ 已新建决策日志：${path.relative(ROOT, LOGF)}（${entries.length} 行）`);
  } else {
    const res2 = writeBoardGuarded({ file: LOGF, before, after, who: 'ticket-dispatch' });
    if (res2 && res2.ok === false) console.error('✗ 决策日志追加失败：' + (res2.code || res2.error || '未知'));
    else console.log(`\n✓ 决策日志 +${entries.length} 行（${path.relative(ROOT, LOGF)}）`);
  }
}

/* ── 给调度会话的输出文件 ── */
if (EMIT) {
  const out = {
    schemaVersion: 1, agent: AGENT, board: path.relative(ROOT, BOARD),
    generatedAt: new Date().toISOString(), thresholdHours: HOURS,
    tasks: actionable.map(r => ({ id: r.id, kind: r.kind, to: r.who, title: r.title, why: r.why, thread: r.thread || '' })),
  };
  const p = path.resolve(EMIT);
  writeFileSync(p, JSON.stringify(out, null, 1), 'utf8');
  console.log(`\n✓ 已写调度队列：${path.relative(process.cwd(), p) || p}（${out.tasks.length} 条）`);
}

process.exit(actionable.length ? 0 : 3);
