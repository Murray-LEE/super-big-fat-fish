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
import { parseTickets, queueOf } from './lib/ticket-lint.mjs';
import { writeBoardGuarded, writeAtomic } from './lib/ticket-write.mjs';
import { W, glossaryText } from './lib/theme.mjs';

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
const push = (kind, t, who, why) => rows.push({
  kind, id: t.id, state: t.state, who, why,
  title: String(t.title || '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 60),
  dispatched: dispOf(t).length,
  hours: hoursSince(t),
  thread: String(t.thread || '').trim(),
});

for (const t of q.open || []) {
  const h = hoursSince(t);
  if (dispOf(t).length && h !== null && h < HOURS) { push('已派待回', t, t.owner || '?', `已派 ${h.toFixed(1)}h（<${HOURS}h，先不催）`); continue; }
  push(dispOf(t).length ? '该催' : '待派', t, t.owner || '?', dispOf(t).length ? `已派 ${h === null ? '未知' : h.toFixed(1) + 'h'} 未回票` : '从未派过');
}
for (const t of q.accept || []) push('待验收', t, t.acceptor || '?', '负责人已回票，等验收');
for (const t of q.missingAcceptor || []) push('缺验收方', t, '?', '票面没写验收方');
for (const t of q.missing || []) push('缺负责人', t, '?', '票面没写负责人');

const actionable = rows.filter(r => ['待派', '该催', '待验收'].includes(r.kind));

if (JSONOUT) {
  console.log(JSON.stringify({
    schemaVersion: 1, agent: AGENT, board: path.relative(ROOT, BOARD) || BOARD,
    generatedAt: new Date().toISOString(), thresholdHours: HOURS,
    counts: rows.reduce((a, r) => (a[r.kind] = (a[r.kind] || 0) + 1, a), {}),
    actionable: actionable.length, rows,
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
    if (actionable.length) {
      console.log('\n调度会话要做的事（一次一张，别群发）：');
      for (const r of actionable.slice(0, 8)) {
        console.log(`  · cross_session_send → ${r.who}：「${r.id}｜${r.title}（${r.kind}）${r.thread ? '〔线程 ' + r.thread + '〕' : ''}」`);
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
  const REASON = { '待派': 'dispatched', '该催': 'reminded', '待验收': 'accepted', '已派待回': 'skipped-recent', '缺负责人': 'missing-owner', '缺验收方': 'missing-acceptor' };
  const LOGF = path.resolve(ROOT, 'docs/决策日志.md');
  const HEAD = '# 决策日志（append-only · 一行一决策）\n\n> 列：时间 | 票号或线程 | 决定 | 理由代码 | 依据\n\n';
  const entries = rows.map((r) => stamp2 + ' | ' + (r.thread || r.id || '—') + ' | ' + r.kind + ' | ' + (REASON[r.kind] || 'skipped-recent') + ' | ' + String(r.why || '').replace(/\|/g, '／'));
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
