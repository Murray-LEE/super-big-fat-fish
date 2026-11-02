/**
 * tools/ticket-reply.mjs —— **回票归位**（默认只预演 ✓ `--write` 才落盘 ＋ 先自动快照）
 *
 * 用法：
 *   node tools\ticket-reply.mjs                         预演：告诉你会把哪几行搬到哪张票（不写盘 ✗）
 *   node tools\ticket-reply.mjs --write                 落盘（先快照到 .backups\ ✓ 再逐条搬 ✓ 搬完自检 ✓）
 *   node tools\ticket-reply.mjs --write --close T-…-H02 搬完把该票 [v] → [x]（块里必须有回票 ✗ 否则拒绝）
 *   node tools\ticket-reply.mjs --file <路径>            换票板（测试用 ✓ 默认 docs\待办.md）
 *
 * 为什么默认 dry-run：**它会改共享文件** ✗ 共享文件的每一次改写都该先被人看一眼 ✓
 * 三条落地纪律（v1.6 §11.2 / §4.5）：
 *   · 快照放**仓库内** `.backups\`（✗ 别放 /tmp）＋ **本地时间**命名（✗ 别用 toISOString）
 *   · 只搬**整组引用行** ✓ 一个字不改 ✓ 定位**声明优先** ✓ 猜不准就不动 ✗
 *   · 搬完验**内容守恒**（非空行多重集不变 ✓）＋ 复跑 lint（两个方向的问题都该消失 ✓）
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, constants as FS } from 'node:fs';
const COPYFILE_EXCL = FS.COPYFILE_EXCL;
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintTickets } from './lib/ticket-lint.mjs';
import { planMoves, findReplyRecords, applyAllMoves, checkConserved, closeTicket, writeBackup } from './lib/ticket-move.mjs';
// ★ P0（2026-11-02）：写入的互斥与原子性 —— 上面那次「内容比对」挡不住两人同时通过比对 ✗
import { writeBoardGuarded } from './lib/ticket-write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const fi = argv.indexOf('--file');
const ci = argv.indexOf('--close');
// ★ v1.10.7：`--file` 支持绝对路径 ✗（与 ticket-check 一致 ✓）
const asPath = (p) => (path.isAbsolute(String(p || '')) ? String(p) : path.join(ROOT, String(p || '')));
const FILE = fi >= 0 ? asPath(argv[fi + 1] || '') : path.join(ROOT, 'docs', '待办.md');
const CLOSE = ci >= 0 ? String(argv[ci + 1] || '') : '';
// ★ v1.10.5（调试线实测）：一次 `--write` 搬了 25 条 ⇒ 问题 41 → 45 ✗ 他滚回了 ✓
//   ⇒ 默认**上限 10 条** ✗ 超过就拒绝 ✓ 要更多必须显式 `--max N` ✓（批量操作要人点头 ✓）
const mi = argv.indexOf('--max');
// ★ v1.10.7（GPT N05–N10）：**非法参数必须报错退出** ✗ 不能悄悄放行 ✗
//   之前 Number('abc') ⇒ NaN ⇒ NaN > MAX 恒假 ⇒ 上限形同不存在 ✗（实测：--max abc 搬了 11 条 ✗）
const MAX_RAW = mi >= 0 ? String(argv[mi + 1] === undefined ? '' : argv[mi + 1]) : '';
let MAX_MOVES = 10;
let MAX_GIVEN = false;
if (mi >= 0) {
  if (!/^[0-9]+$/.test(MAX_RAW)) {
    console.error('✗ --max 只接受**十进制非负整数**（收到 ' + JSON.stringify(MAX_RAW) + '）⇒ 什么都没做 ✓ 文件未改 ✓');
    console.error('  ⇒ 例：--max 0（不许搬）／--max 11（允许 11 条）✓ 空值、负数、小数、Infinity、--max --write 都算非法 ✗');
    process.exit(2);
  }
  const n = Number(MAX_RAW);
  if (!Number.isSafeInteger(n)) {
    console.error('✗ --max 超出安全整数范围（收到 ' + MAX_RAW + '）⇒ 什么都没做 ✓ 文件未改 ✓');
    process.exit(2);
  }
  MAX_MOVES = n;
  MAX_GIVEN = true;
}
const REL = path.relative(ROOT, FILE);

// ★ v1.10.19（GPT R03）：**"没写这个选项"≠"写了但没值"** ✗
//   以前 `--close` 后面没东西 ⇒ CLOSE 取空串 ⇒ 走"也不带 --close"分支 ⇒ 明确写出的结票意图被静默丢弃 ✗
const needValue = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return '';
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) {
    console.error('✗ ' + flag + ' 缺少取值' + (v === undefined ? '（后面没有东西）' : '（后面是另一个选项 ' + v + '）'));
    console.error('  ⇒ 期望：' + flag + ' <值> ✓ 例：' + flag + ' T-20261026-F01（或直接不写这个选项 ✓）');
    console.error('  ⇒ **什么都没做** ✗ 不改文件 ✓');
    process.exit(2);
  }
  return String(v);
};
needValue('--file');
needValue('--close');

/** 本地时间命名（✗ 不用 toISOString：那是 UTC，会和交接里的 UTC+8 差 8 小时 ✗） */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  // ★ v1.10：精确到**秒** ✗ 分钟级同分钟连跑会撞名 ✗（GPT §5）
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ★ v1.10.18（五线·宿主线）：路径存在 ≠ 读得动 ✗ 权限问题不许糊栈、也不许伪装成"有真问题"✗
if (!existsSync(FILE)) {
  console.error('✗ 找不到票板文件：' + REL + '（来自命令行 --file）');
  console.error('  ⇒ 期望：该路径**存在且是文件** ✓ 例：docs/待办.md');
  console.error('  ⇒ **什么都没做** ✗ 不改文件 ✓');
  process.exit(2);
}
let before;
{
  let r = null;
  try { r = readFileSync(FILE, 'utf8'); } catch (e) {
    const code = (e && e.code) || 'EUNKNOWN';
    const why = code === 'EACCES' || code === 'EPERM'
      ? '文件存在但**没有读权限**（权限问题 ✗ 不是票板问题 ✗）' : '文件存在但**读不动**（' + code + '）';
    console.error('✗ 读不动票板文件：' + REL + '：' + why);
    console.error('  ⇒ 期望：该路径**存在、是文件、且读得动** ✓ 例：docs/待办.md');
    console.error('  ⇒ **什么都没做** ✗ 不改文件 ✓');
    process.exit(2);
  }
  before = r;
}
const RAW_BEFORE = before;   // ★ T-20261101-F03：归一前的**原始字节**（并发校验与备份都用它 ✓ 回滚才能逐字节还原）
/* ★ T-20261101-F03（2026-11-01）：**混用行尾自动归一** ✗ 别再让人兜 ✗
   现场：两张票的 `--close` 都报「文件混用 CRLF/LF ✗ 先统一行尾再结票」—— 原因是票板被别人用
     PowerShell 的 `Add-Content`／`Set-Content` 追加过（默认写 CRLF ✗）⇒ 混用 ⇒ 工具拒绝 ⇒ 每次人来归一 ✗
   现在：**写盘前**先归一成 LF ✓ 只做 `\r\n → \n`（除行尾外一个字节都不许动 ✗）✓ 并打一行（不然没人知道文件被改过 ✗）
   `--strict-eol` 保留旧行为（想先看一眼再改时用 ✓）—— 纯 LF 文件行为完全不变，也不打这一行 ✓ */
const STRICT_EOL = argv.includes('--strict-eol');
let EOL_NORM = 0;
{
  const _crlfN = (String(before).match(/\r\n/g) || []).length;
  if (_crlfN) {
    if (STRICT_EOL) {
      console.error('✗ 票板混用 CRLF/LF（CRLF ' + _crlfN + ' 处）⇒ `--strict-eol` 要求先人工统一行尾 ✓（不统一就写会把行拆错 ✗）');
      console.error('  ⇒ **什么都没做** ✗ 不改文件 ✓（想看自动归一，去掉 `--strict-eol` 再跑 ✓）');
      process.exit(1);
    }
    before = String(before).replace(/\r\n/g, '\n');
    EOL_NORM = _crlfN;
  }
}
const plan = planMoves(before);
const { recs } = findReplyRecords(before);
const lintBefore = lintTickets(before, { since: '2026-10-25' }).problems;
const kindN = (list, kind) => list.filter(p => p.kind === kind).length;

console.log('════ 回票归位' + (WRITE ? '（**落盘** ⚠）' : '（dry-run · **不写盘** ✗）') + '════');
console.log('文件：' + REL + '｜票 ' + plan.tickets.length + ' 张｜回票记录 ' + recs.length + ' 条');
if (EOL_NORM) console.log('行尾归一：CRLF ' + EOL_NORM + ' 处 → LF' + (WRITE ? '（写盘前归一 ✓ 除行尾外未动一个字节 ✓）' : '（预演 ✓ 只在内存里归一，没写盘 ✗）'));
console.log('· 需要搬：' + plan.moves.length + ' 条｜定位不了（不动 ✗）：' + plan.unresolved.length + ' 条');
// ★ v1.10.6（调试线建议）：**预演就把上限说出来** ✗ 别等人加了 --write 才被拒 ✗
if (plan.moves.length > MAX_MOVES) {
  console.log('  ⚠ 超过**当前上限 ' + MAX_MOVES + ' 条**（' + (MAX_GIVEN ? '本次显式指定' : '默认值') + '）⇒ 直接 `--write` 会**被拒绝** ✗ 要一次搬完必须显式 `--max ' + plan.moves.length + '` ✓');
  console.log('    （--max 是**本次总量**的上限 ✗ 不是"每批搬多少"✗ 想分批请先人工缩小待归位集合 ✓）');
}

for (const m of plan.moves) {
  console.log('  L' + (m.start + 1) + (m.end > m.start ? '-L' + (m.end + 1) : '') +
    ' 现在错在 ' + (m.ownerId ? m.ownerId : '（票块外的段落 L' + m.ownerLine + '）') + ' 的块里' +
    ' → 应搬进 **' + m.targetId + '**（L' + m.targetLine + '）');
}
// ★ v1.10.3（第一轮实测 · 线上线）：34 条"定位不了"逐条打是噪声 ✗
//   按**原因归类**打 ✓ 只给每类 2 个例子 ✓ —— 人要知道的是"哪种写法让我认不出"，不是 34 个行号 ✗
// ★ v1.10.11（五线 §八.1）：**五类分开** ✗ 别把"没写归属"和"写了但对不上"混成一个"定位不了"✗
//   报"该号在 L2 与 L4 两处声明"人能立刻分辨 ✓ 报"定位不了"还得自己翻 ✗
const catOf = (why) =>
  /同时声明/.test(why) ? '票号**重复**（同一号多处声明 ⇒ 按号定位会指错票）'
    : /没有票号声明/.test(why) ? '目标票**没有票号声明**（先给那张票写 `**票号**：T-…`）'
      : /没有这张票|没有任何声明/.test(why) ? '引用了**不存在的号**（票板里没有这个号的任何声明）'
        : /对不上任何票的标题/.test(why) ? '**标题对不上**（可能标题被改过 ✗ 或那张票已归档 ✗）'
          : /多个票号/.test(why) ? '一条回票里有**多个票号**（无法确定归哪张）'
            : /无法定位|既没有票号/.test(why) ? '**既没票号也没「回『标题』」**（工具无从定位）'
              : '其他';
const groups = new Map();
for (const u of plan.unresolved) {
  const k = catOf(u.why);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(u);
}
for (const [k, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log('  ⚠ **' + list.length + ' 条**：' + k);
  for (const u of list.slice(0, 2)) {
    console.log('      L' + (u.start + 1) + (u.end > u.start ? '-L' + (u.end + 1) : '') + ' ' + u.why.slice(0, 70));
  }
  if (list.length > 2) console.log('      …还有 ' + (list.length - 2) + ' 条同类（同类不重复打 ✗ 要看全部用 `--all-unresolved`）');
}
if (plan.unresolved.length && !argv.includes('--all-unresolved')) {
  console.log('  ⇒ 定位不了 **不是失败** ✓ 是"这段回票没写清属于哪张票" ✗ 写法见规范 §4.6 ✓ 逐条看加 `--all-unresolved` ✓');
}
if (argv.includes('--all-unresolved')) {
  console.log('');
  for (const u of plan.unresolved) console.log('  L' + (u.start + 1) + ' ' + u.why);
}
if (!recs.length) {
  console.log('· 票板里**一条回票记录都没有** ⇒ 无从归位 ✓ 这不是"全部归位了" ✗（没有回票 ≠ 没有错 ✗）');
}
if (!plan.moves.length && !plan.unresolved.length && recs.length) {
  console.log('✅ 所有回票记录都在**自己的票块里** ✓（位置对 ≠ 内容对 ✗ 也不证明验收过 ✗）');
}

if (!WRITE) {
  console.log('');
  console.log('（预演结束 ✓ 什么都没改 ✓ 觉得对再加 `--write` —— 它会先快照再搬 ✓）');
  process.exit(0);
}

if (!plan.moves.length && !CLOSE) {
  console.log('');
  console.log('没有要搬的 ✓ 也不带 --close ⇒ 不写盘 ✓（省一次无意义的备份 ✓）');
  process.exit(0);
}

// ── 先算完再决定写不写（✗ 别"先备份再说"：没改动就不该产生快照 ✗）──────
// v1.10：算的过程可能**故意抛错**（混用行尾 ✗ / 目标不唯一 ✗ / 死循环 ✗）⇒ 这里要给人话 ✗ 不要堆栈 ✗
let moved;
try { moved = applyAllMoves(before, plan); }
catch (e) {
  console.error('✗ 没搬：' + e.message);
  console.error('  ⇒ **没写盘** ✓ 原文未动 ✓（先看预演 / 修掉上面的问题再跑 ✓）');
  process.exit(1);
}
// 守恒只校验**搬动**（结票会改票头 1 行 ✓ 那是设计内的 ✓ 单独核 ✓）
const cons = checkConserved(before, moved.text);
let after = moved.text;
let closeErr = '';
if (CLOSE) {
  try { after = closeTicket(after, CLOSE); }
  catch (e) { closeErr = e.message; }
}
const changed = after !== before;
if (!changed) {
  console.log('');
  console.log('结果与原文**逐字相同** ⇒ **不写盘** ✓ 也不产生快照 ✓');
  if (closeErr) { console.error('✗ 结票被拒：' + closeErr); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
}

// 批量上限：先拦，再算别的（不产生任何副作用 ✓）
if (moved.done > MAX_MOVES) {
  console.error('✗ 这次要搬 **' + moved.done + ' 条**，超过**当前上限 ' + MAX_MOVES + ' 条** ⇒ **没写盘** ✗（也没有产生备份 ✓）');
  console.error('  ⇒ 一次搬太多，出事很难判断是哪条引起的 ✓（调试线实测：一次 25 条 → 问题 41 变 45 ✗ 只能滚回 ✗）');
  console.error('  ⇒ 核对计划后显式提高上限（`--max ' + moved.done + '`）✓ 或先人工缩小本次待归位集合 ✓');
  console.error('  ⇒ 注意：`--max` 是**本次总量**的上限 ✗ 不是"每批搬多少"✗ 连跑两次默认命令不会自动分批 ✓');
  process.exit(1);
}

if (!cons.ok) {
  console.log('· 内容守恒：✗ 丢了 ' + cons.missing.length + ' 行／多了 ' + (cons.extra || []).length + ' 行');
  if (cons.missing.length) console.log('  缺的行示例：' + cons.missing.join(' ｜ '));
  if ((cons.extra || []).length) console.log('  多的行示例：' + cons.extra.join(' ｜ '));
  console.error('✗ 内容守恒校验失败（要求**多重集相等** ✓ 丢了或多出来都算失败 ✗）⇒ **没写盘** ✗（原文未动 ✓）');
  process.exit(1);
}
// 结票只允许改**票头那一行** ✓ 多改一行都不行 ✗
if (after !== moved.text) {
  const a = moved.text.split(/\r?\n/), b = after.split(/\r?\n/);
  const diff = [];
  if (a.length !== b.length) diff.push('行数变了（' + a.length + '→' + b.length + '）');
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) diff.push('L' + (i + 1));
  if (diff.length !== 1 || !/^## \[x\]/.test((b[Number(diff[0].slice(1)) - 1] || ''))) {
    console.error('✗ 结票改了不止票头一行（' + diff.join(',') + '）⇒ **没写盘** ✗');
    process.exit(1);
  }
}

// ── 落盘：① 复核输入没被别人改过 ② 快照不覆盖 ③ 才写 ────────────────
// ★ v1.10（GPT §5）：原来只比"行数"✗ 别人改了同样行数的内容就漏 ✗
const nowText = readFileSync(FILE, 'utf8');
if (nowText !== RAW_BEFORE) {
  console.error('✗ 文件在我读完之后被改过（hash 不同）⇒ **没写盘** ✗ 请重新预演 ✓（并发窗口无法彻底消除，但这一步能挡住"已经变了还在写"✗）');
  process.exit(1);
}

// ★ v1.10.34（T-20261028-F01 现场）：**沙箱里"新建文件"可能被拒** ✗ 而改写同目录已有文件可以 ✓
//   ⇒ 备份改走 `writeBackup()`：先试仓内 `.backups` ✓ 不行退 `<系统临时>/fj-backups` ✓ 并打出来 ✓
const bres = writeBackup(ROOT, path.basename(FILE, '.md') + '-' + stamp() + '.md', RAW_BEFORE);
const bak = bres.path;
if (bres.fallback) {
  console.error('⚠ 仓内 `.backups` 写不进去（沙箱拒新建文件 ✗）⇒ 快照退到：' + bak + ' ✓');
}
const bakText = readFileSync(bak, 'utf8');
if (bakText !== RAW_BEFORE) {
  console.error('✗ 快照内容与读到的原文不一致 ⇒ 中止，文件未改 ✗');
  process.exit(1);
}
console.log('');
console.log('· 快照：' + path.relative(ROOT, bak) + '（' + before.length + ' 字 ✓ **逐字**读回一致 ✓ 排他创建（不覆盖旧快照 ✓））');

console.log('· 搬：' + moved.done + ' 条（补空行分隔 ' + moved.gaps + ' 处）｜行数 ' + before.split(/\r?\n/).length + ' → ' + after.split(/\r?\n/).length);
console.log('· 内容守恒：✅ 非空行逐行一致（' + cons.afterNonEmpty + ' 行）✓');
if (CLOSE && !closeErr) console.log('· 结票：' + CLOSE + ' `[v]` → `[x]` ✓（块内确有回票记录 ✓）');
if (closeErr) { console.error('✗ 结票被拒：' + closeErr + ' ⇒ 只搬不结 ✓'); process.exitCode = 1; }

// ★ P0（2026-11-02）：锁 ＋ 原子替换 ＋ 锁内二次比对
//   上面 247 行那次比对只挡住"我读完别人已经写完"，挡不住**两人同时通过比对**再各写一份 ⇒
//   A 读→B 读→A 通过→B 通过→A 写→B 写 ⇒ A 的票静默消失 ✗（快照里有，但没人去翻 ✗）
const W = writeBoardGuarded({ file: FILE, before: RAW_BEFORE, after, who: 'ticket-reply' });
if (!W.ok) {
  if (W.code === 'CHANGED') {
    console.error('✗ 锁内复核发现票板已被改过（' + W.beforeSha + ' → ' + W.nowSha + '）⇒ **没写盘** ✗ 请重新预演 ✓');
  } else if (W.code === 'LOCKED') {
    const h = (W.lock && W.lock.held) || null;
    console.error('✗ 票板正被另一个进程写：' + (h
      ? (h.who || '未知') + ' · pid ' + h.pid + ' · ' + new Date(h.at).toLocaleString('zh-CN') + (h.host ? ' · ' + h.host : '')
      : '锁文件存在但读不出内容') + ' ⇒ **没写盘** ✗');
    console.error('  ⇒ 锁：' + path.relative(ROOT, (W.lock && W.lock.path) || '') + ' ✓ 确认对方已停再删 ✓ 过期锁会在下次写入时自动回收 ✓');
  } else {
    console.error('✗ 写盘失败（' + W.code + '）' + (W.detail ? '：' + W.detail : '') + ' ⇒ **没写盘** ✗');
  }
  process.exit(1);
}
if (W.reclaimed) {
  console.error('⚠ 回收了一条**陈旧锁**（' + (W.reclaimed.who || '未知') + ' · pid ' + W.reclaimed.pid + '）'
    + '⇒ 上次写入可能被强杀 ✓ 建议跑一次 ticket-check 看票板有没有半截 ✗');
}

// ── 搬完自检 ─────────────────────────────────────────────────
const lintAfter = lintTickets(readFileSync(FILE, 'utf8'), { since: '2026-10-25' }).problems;
const A = '回票指向别的票', B = '回票不在票块内';
console.log('· 复跑 lint：' + A + ' ' + kindN(lintBefore, A) + ' → ' + kindN(lintAfter, A) +
  '｜' + B + ' ' + kindN(lintBefore, B) + ' → ' + kindN(lintAfter, B) +
  '｜总问题 ' + lintBefore.length + ' → ' + lintAfter.length);
console.log('滚回：把 ' + path.relative(ROOT, bak) + ' 整份复制回 ' + REL + ' ✓ 别手工缝 ✗');
console.log('（这只是**结构**搬对 ✓ 不代表回票内容可信 ✗ 验收仍要找票面约定的验收方 ✓）');
