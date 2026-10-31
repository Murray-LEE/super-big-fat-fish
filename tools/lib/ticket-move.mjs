import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
/**
 * tools/lib/ticket-move.mjs —— **回票归位**的纯函数（算计划 ＋ 应用计划 · 无 IO ✓ 可单测 ✓）
 *
 * v1.6（2026-10-25 深夜 · 五线项目反馈）
 *   要解决：回票落在**别人的票块里** ✗ —— 人写票的第一反应就是"追加到末尾" ✗
 *   只做 lint 只能告诉你"落错了"，救不了；这个文件负责把"搬"变成**可预演、可核对**的动作 ✓
 *
 * 三条口径（与 §4.5 一致）：
 *   ① 定位**声明优先**：票号（声明过的）> 回「标题」匹配 > 其余一律"定位不了"✗ 不猜 ✗
 *   ② 搬的是**整组引用行**（`> ✅` 那一整段）✓ 内容一个字不改 ✓ 不重新排版 ✗
 *   ③ 搬完**内容守恒**：非空行多重集必须与搬前逐行相等 ✓ 行数只允许因"补空行分隔"±1 ✓
 *
 * 一切判断前先剥**代码块 ＋ 行内代码**（§8 铁律 7 ✓）—— 引用别人的回票原文不算行为 ✗
 */
import { parseTickets, scanReplyRecords, stripInline, snapshotOf } from './ticket-lint.mjs';

const ID_RE = /T-20\d\d\d\d\d\d-[A-Z]\d{2}/g;

/**
 * 找出所有**回票记录**并标出它现在落在谁的块里
 * ★ v1.10.1（GPT F02）：边界改由 `scanReplyRecords()` **统一提供** ✗
 *   原来这里自己写了一套"连续 `>` 行"，和检查器不一致 ✗
 *   ⇒ 同一条合法文本：检查器看成 2 条、归位器看成 1 条 ✗（两套身份 ✗）
 * 保留原能力：**票头之前的回票**也要扫到 ✓（不能只从各票块的 replies 汇总 ✗）
 */
export function findReplyRecords(text) {
  const { tickets } = parseTickets(text);
  const { lines, fenced, recs: raw } = scanReplyRecords(text);
  const recs = raw.map(r => {
    const owner = tickets.find(t => t.line - 1 <= r.start && r.start < t.end) || null;
    return {
      start: r.start, end: r.end, n: r.end - r.start + 1, cited: r.cited,
      titleHint: r.titleHint,
      ownerLine: owner ? owner.line : null,
      ownerId: owner ? owner.id : '',
      ownerState: owner ? owner.state : '',
      quoted: r.text
    };
  });
  return { lines, fenced, tickets, recs };
}

/**
 * 算计划：哪些回票记录要搬到哪张票块里
 * 返回 { moves, unresolved, recs, tickets }
 *   moves       = [{ start, end, targetId, targetLine, ownerId, ownerLine }]（按文件顺序）
 *   unresolved  = [{ start, end, why }]（定位不了 ⇒ 只报告，不动 ✗）
 *
 * ★ v1.10（C01/C02）：票号**必须唯一**才允许定位 ✗
 *   之前：Map 建表时后者覆盖前者，applyOneMove 用 find 取到前者 ⇒ **预演说搬去 A，实际搬进 B** ✗
 *   现在：`id → 候选票列表`，候选数 ≠ 1 ⇒ unresolved ✓ 预演与执行**共用**同一个解析器 ✓
 */
const indexById = (tickets) => {
  const m = new Map();
  for (const t of tickets) for (const id of [...new Set(t.decls || [])]) {
    if (!m.has(id)) m.set(id, []);
    m.get(id).push(t);
  }
  return m;
};

/** 唯一目标解析器（预演与执行共用 ✓ 不唯一就返回 null + 原因 ✗）*/
export function resolveTarget(tickets, id) {
  const list = indexById(tickets).get(id) || [];
  if (list.length === 1) return { target: list[0], why: '' };
  if (list.length === 0) return { target: null, why: '点了 ' + id + '，但票板里没有这张票的**声明** ✗（不按"出现过"补猜 ✗）' };
  return { target: null, why: '票号 ' + id + ' 被 ' + list.length + ' 张票同时声明 ✗（L' + list.map(t => t.line).join('/L') + '）⇒ 按号定位会指错票 ✗ 先改成唯一 ✓' };
}

export function planMoves(text) {
  const { recs, tickets } = findReplyRecords(text);
  const moves = [], unresolved = [];

  for (const r of recs) {
    let target = null, why = '';
    if (r.cited.length === 1) {
      const res = resolveTarget(tickets, r.cited[0]);
      target = res.target; why = res.why;
    } else if (r.cited.length > 1) {
      why = '一段回票里出现多个票号（' + r.cited.join(',') + '）⇒ 不猜 ✗ 请人工拆开';
    } else {
      const m = /回「([^」]{1,40})」/.exec(r.quoted);
      if (!m) why = '既没有票号，也没有「回『原票标题』」⇒ 无法定位 ✗';
      else {
        const key = m[1].trim();
        const hit = tickets.filter(t => t.title && (t.title.includes(key) || key.includes(t.title)));
        // ★ v1.10.10：标题匹配到的票**没有票号声明** ⇒ 不许生成 targetId 为空的搬动 ✗
        //   （原来 target.id === '' ⇒ 后面 resolveTarget('') 直接抛错 ✗ 结票也一起被挡 ✗）
        if (hit.length === 1 && !hit[0].id) why = '回「' + key + '」匹配到 L' + hit[0].line + '，但**那张票没有票号声明** ✗ ⇒ 先给它写 `**票号**：T-…` ✓ 再归位 ✓';
        else if (hit.length === 1) target = hit[0];
        else if (hit.length > 1) why = '回「' + key + '」对上多张票（L' + hit.map(t => t.line).join('/L') + '）⇒ 不猜 ✗';
        else why = '回「' + key + '」对不上任何票的标题 ⇒ 无法定位 ✗';
      }
    }
    if (!target) { unresolved.push({ start: r.start, end: r.end, why }); continue; }
    if (r.ownerId && r.ownerId === target.id) continue;   // 已经在正确的块里 ✓
    moves.push({
      start: r.start, end: r.end,
      targetId: target.id, targetLine: target.line,
      ownerId: r.ownerId, ownerLine: r.ownerLine
    });
  }
  return { moves, unresolved, recs, tickets };
}

/** 行尾：v1.10（C11）—— 混用就**拒绝写** ✗ 别"能读就当能写回" ✗ */
export function eolOf(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  if (crlf && lf) return { eol: '\n', mixed: true };
  return { eol: crlf ? '\r\n' : '\n', mixed: false };
}

/** 应用**一条**搬动（一次只搬一条 ⇒ 行号不会互相污染 ✓ 便于逐步核对 ✓） */
export function applyOneMove(text, mv) {
  const { eol, mixed } = eolOf(text);
  if (mixed) throw new Error('文件混用 CRLF/LF ✗ 先统一行尾再搬 ✓（不统一就搬会把行拆错 ✗）');
  const lines = text.split(eol);
  const recLines = lines.slice(mv.start, mv.end + 1);
  const rest = lines.slice(0, mv.start).concat(lines.slice(mv.end + 1));
  const { tickets } = parseTickets(rest.join(eol));
  const { target: t, why } = resolveTarget(tickets, mv.targetId);
  if (!t) throw new Error('搬动后目标不唯一：' + why + '（已中止，文件未改 ✗）');

  // 插到目标块内**最后一个非空行之后**
  let ins = t.end;
  while (ins > t.line && rest[ins - 1] !== undefined && rest[ins - 1].trim() === '') ins--;
  const needGap = ins > 0 && rest[ins - 1] !== undefined && rest[ins - 1].trim() !== '';
  const out = rest.slice(0, ins)
    .concat(needGap ? [''] : [])
    .concat(recLines)
    .concat(rest.slice(ins));
  return { text: out.join(eol), addedGap: needGap };
}

/**
 * 一直搬到没得搬为止
 * ★ v1.10：① 有**无进展**检测 ✓ ② 到上限后**复查剩余计划必须为 0** ✗ 不能把"试了 50 次"当"做完了" ✗
 */
export function applyAllMoves(text, plan = planMoves(text)) {
  let cur = text, done = 0, gaps = 0, guard = 0;
  // ★ v1.10.1（GPT §7）：**已访问状态集合** ✗ 单步"没变化"挡不住 A→B→A ✗
  const seen = new Set([snapshotOf(text).contentSha256]);
  while (guard++ < 50) {
    const p = planMoves(cur);
    if (!p.moves.length) break;
    const r = applyOneMove(cur, p.moves[0]);
    if (r.text === cur) throw new Error('搬动没有产生任何变化 ⇒ 检测到死循环，已中止 ✗（文件未改 ✓）');
    const h = snapshotOf(r.text).contentSha256;
    if (seen.has(h)) throw new Error('搬动出现了**循环状态**（回到搬之前的样子）⇒ 已中止 ✗（文件未改 ✓）');
    seen.add(h);
    cur = r.text; done++; if (r.addedGap) gaps++;
  }
  const left = planMoves(cur).moves.length;
  if (left) throw new Error('还有 ' + left + ' 条没搬完（达到轮次上限）✗ 结果不可信 ✗ 请先看预演 ✓');
  return { text: cur, done, gaps };
}

/**
 * 内容守恒校验：非空行**多重集相等** ✓
 * ★ v1.10（C09）：原来只查"旧行没丢"✗ 是**包含关系**不是相等 ✗ ⇒ 多出来的行也能过 ✗
 *   现在：缺失、**新增**、同一行多复制一次，都算失败 ✓（容忍范围只有"行尾空白"与"空行"✓ 写死 ✓）
 */
export function checkConserved(before, after) {
  const norm = (s) => s.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim()).sort();
  const a = norm(before), b = norm(after);
  const missing = [], extra = [];
  const poolB = [...b];
  for (const line of a) {
    const k = poolB.indexOf(line);
    if (k < 0) missing.push(line); else poolB.splice(k, 1);
  }
  extra.push(...poolB);                  // 剩下的就是"多出来的"✓
  return {
    ok: missing.length === 0 && extra.length === 0,
    missing: missing.slice(0, 5),
    extra: extra.slice(0, 5),
    beforeNonEmpty: a.length,
    afterNonEmpty: b.length
  };
}

/**
 * 推 [x]：只允许 `[v]` → `[x]` ✓ 且**必须有一条归属于本票的回票记录** ✗
 * ★ v1.10（C10）：原来只查"块里有回票"✗ 不查那条回票**是不是本票的** ✗
 *   ⇒ 块里只有一条"点别人票"的回票，也能结票 ✗ 现已要求：记录点的号**包含**本票号（或点了本票标题）✓
 */
export function closeTicket(text, id) {
  const { eol, mixed } = eolOf(text);
  if (mixed) throw new Error('文件混用 CRLF/LF ✗ 先统一行尾再结票 ✓（不统一会把行改错 ✗）');
  const lines = text.split(eol);
  const { tickets, recs } = findReplyRecords(text);
  const { target: t, why } = resolveTarget(tickets, id);
  if (!t) throw new Error('结票目标不唯一：' + why);
  if (t.state !== 'v') throw new Error('只有 `[v]` 待验收能推 `[x]`，' + id + ' 现在是 `[' + t.state + ']` ✗');
  const inBlock = recs.filter(r => r.start >= t.line - 1 && r.start < t.end);
  if (!inBlock.length) throw new Error(id + ' 的票块里没有回票记录 ⇒ 不许推 `[x]` ✗（无回票更不是完成 ✗）');
  const mine = inBlock.some(r => r.cited.includes(id) || (!r.cited.length && r.titleHint && t.title.includes(r.titleHint)));
  if (!mine) throw new Error(id + ' 块里的回票**没有一条点名本票** ✗（点了别的票 ⇒ 那是别人的回票 ✓ 先归位 ✓）');
  lines[t.line - 1] = lines[t.line - 1].replace('## [v]', '## [x]');
  return lines.join(eol);
}

/**
 * ★ v1.10.34（T-20261028-F01 现场 · cs-team 沙箱）：**备份目录写不进去时自动退到系统临时目录** ✓
 *   现场：cs-team 里跑 --write --close ⇒ EPERM: copyFile '待办.md' -> 'f j-tavern\.backups\待办-….md'
 *   但同一份文件的改写成功 ✓ ⇒ 不是 ACL（两侧权限项一模一样 ✓ ACL 脚本判 NOT_THIS_CLASS ✓）
 *   ⇒ 差在**在那个目录里新建文件**被沙箱拒 ✗
 * 所以：先试仓内 .backups ✓ 不行就退 <系统临时>/fj-backups ✓ 并把实际路径打出来 ✗
 */
export function writeBackup(rootDir, fileName, text) {
  const errs = [];
  const dirs = [path.join(rootDir, '.backups'), path.join(os.tmpdir(), 'fj-backups')];
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
      const p = path.join(dir, fileName);
      writeFileSync(p, text);
      return { path: p, dir, fallback: dir === dirs[1] };
    } catch (e) {
      errs.push(((e && e.code) || 'ERR') + ' @ ' + dir);
    }
  }
  throw new Error('备份写不进去 ✗ ' + errs.join(' ／ ') + ' ⇒ 为安全本次不写盘 ✗');
}
