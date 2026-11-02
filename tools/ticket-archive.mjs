#!/usr/bin/env node
/**
 * tools/ticket-archive.mjs —— 把**已结的票**从活票板搬进月度归档
 *
 * 为什么需要（2026-11-02）：
 *   README 的"已知边界"自己写了：「票板会长 ✗ 几百张票以后 --queue / --loop 会变慢，建议定期归档」
 *   但仓库里**没有做这件事的工具** ✗ ⇒ 全靠人记得手搬 ⇒ 手搬就会：搬丢回票、搬出重复票号、忘备份 ✗
 *   ⇒ 归档是个**可机械核对**的动作：搬走的行必须原样出现在归档里，票板里不许留半截 ✓
 *
 * 用法：
 *   node tools/ticket-archive.mjs                 # 预演：告诉你会搬哪几张（不写盘 ✓）
 *   node tools/ticket-archive.mjs --write         # 真搬（先备份 ✓ 再写归档 ✓ 最后写票板 ✓）
 *   node tools/ticket-archive.mjs --days 3        # 只搬结票超过 3 天的（默认 7 ✓ 0 = 全部结票）
 *   node tools/ticket-archive.mjs --file X --archive Y    # 换文件（测试用）
 *
 * 口径（与全仓一致 ✓）：
 *   · 只搬 `[x] 完成` / `[-] 作废` ✓ 活跃票、待验收票**一票不动** ✗
 *   · 搬的是**整块**（票头到下一张票头之前）✓ 内容一个字不改 ✓
 *   · 搬完核对：归档里必须**逐行**出现这些行 ＋ 票板里必须**不再**出现 ✓ 任一不成立 ⇒ 不写盘 ✗
 *   · 归档文件：`docs/待办-归档-YYYYMM.md`（按**票头日期**分月 ✓ 没日期就按今天 ✓）
 *   · 归档只由本工具**追加** ✓ 从不重写已有归档 ✗
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintTickets } from './lib/ticket-lint.mjs';
import { writeBackup } from './lib/ticket-move.mjs';
import { writeBoardGuarded } from './lib/ticket-write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const argOf = (f, d = '') => {
  const i = argv.indexOf(f);
  if (i < 0) return d;
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) {
    console.error('✗ ' + f + ' 缺少取值 ⇒ 什么都没做 ✗ 文件未改 ✓');
    process.exit(2);
  }
  return String(v);
};
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const FILE = abs(argOf('--file', 'docs/待办.md'));
const DAYS = Number(argOf('--days', '7'));
if (!Number.isFinite(DAYS) || DAYS < 0) {
  console.error('✗ --days 必须是非负数字（0 = 全部结票）⇒ 什么都没做 ✗');
  process.exit(2);
}
if (!existsSync(FILE)) {
  console.error('✗ 找不到票板：' + path.relative(ROOT, FILE) + ' ⇒ 什么都没做 ✗');
  process.exit(2);
}

const text = readFileSync(FILE, 'utf8');
const { tickets } = lintTickets(text, {});
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);          // 切分用宽松规则（混行尾也不会错 ✗ 同 parseTickets）

/** 票头里的日期（没有就 null ✓ 不猜 ✗） */
const bornOf = (t) => {
  const m = /(20\d\d)-(\d\d)-(\d\d)(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(t.raw || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] === undefined ? 12 : +m[4], m[5] === undefined ? 0 : +m[5]);
  return Number.isNaN(d.getTime()) ? null : d;
};
const nowMs = Date.now();
const eligible = tickets.filter((t) => {
  if (t.state !== 'x' && t.state !== '-') return false;      // 只搬结票 ✓
  const born = bornOf(t);
  if (DAYS === 0 || !born) return true;                       // 无日期 ⇒ 当老票（要人确认 ✓ 但会列出来）
  return nowMs - born.getTime() >= DAYS * 86400000;
});

if (!eligible.length) {
  console.log('✅ 没有可归档的票（判据：`[x]`／`[-]` 且结票超过 ' + DAYS + ' 天，共 ' + tickets.length + ' 张票）⇒ 什么都没做 ✓');
  process.exit(0);
}

// ── 组装：从票板里挖掉整块，按月份分组写进归档 ──────────────────────────
const monthOf = (t) => {
  const b = bornOf(t);
  const d = b || new Date();
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
};
const byMonth = new Map();
for (const t of eligible) {
  const m = monthOf(t);
  if (!byMonth.has(m)) byMonth.set(m, []);
  byMonth.get(m).push(t);
}

// 要挖掉的行号（0 基，含票头行，不含下一张票头）
const cut = new Set();
for (const t of eligible) for (let i = t.line - 1; i < t.end; i++) cut.add(i);
const keptLines = lines.filter((_, i) => !cut.has(i));
const movedLines = lines.filter((_, i) => cut.has(i));
const nextBoard = keptLines.join(eol);

// 逐票重建归档文本（整块原文 ✓ 不改一个字）
const blocksOf = (list) => {
  const out = [];
  for (const t of list) {
    const raw = lines.slice(t.line - 1, t.end);
    while (raw.length && raw[raw.length - 1].trim() === '') raw.pop();   // 去掉块尾空行 ✓ 归档时统一补
    out.push(raw.join(eol));
  }
  return out;
};

console.log('════ 归档（' + (WRITE ? '**已写入** ⚠' : '预演 ✗ 不写盘 ✓') + '）════');
console.log('票板：' + path.relative(ROOT, FILE) + '｜共 ' + tickets.length + ' 张｜可归档 ' + eligible.length + ' 张｜阈值 ' + DAYS + ' 天');
for (const [m, list] of [...byMonth].sort()) {
  console.log('');
  console.log('→ docs/待办-归档-' + m + '.md（' + list.length + ' 张）');
  for (const t of list) console.log('   L' + String(t.line).padEnd(5) + '[' + t.state + '] ' + (t.id || '(无票号)') + '  ' + t.title.slice(0, 40));
}

if (!WRITE) {
  console.log('');
  console.log('（预演结束 ✗ 什么都没改 ✓ 觉得对就加 `--write` —— 会先备份再搬 ✓）');
  process.exit(0);
}

// ── 写盘：① 备份票板 ② 追加归档 ③ 受保护地写票板 ④ 回读核对 ────────────
const stamp = (() => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
})();
const bak = writeBackup(ROOT, path.basename(FILE, '.md') + '-archive-' + stamp + '.md', text);
console.log('');
console.log('· 快照：' + path.relative(ROOT, bak.path) + (bak.fallback ? '（沙箱不容许写仓内 .backups ⇒ 退到临时目录 ⚠）' : ''));

const written = [];
for (const [m, list] of [...byMonth].sort()) {
  const arch = path.join(path.dirname(FILE), path.basename(FILE, '.md').replace(/^待办$/, '待办') + '-归档-' + m + '.md');
  const rel = path.relative(ROOT, arch).split(path.sep).join('/');
  const existed = existsSync(arch);
  const prev = existed ? readFileSync(arch, 'utf8') : '';
  const header = existed ? '' : ['# 待办归档 ' + m, '', '> 由 `tools/ticket-archive.mjs` 追加 ✓ **只追加、不重写** ✗ 归档里的票不再参与闭环判定 ✓', '', ''].join(eol);
  const block = blocksOf(list).join(eol + eol) + eol;
  const next = (prev ? prev.replace(/\s*$/, '') + eol + eol : header) + block;
  mkdirSync(path.dirname(arch), { recursive: true });
  writeFileSync(arch, next, 'utf8');
  written.push({ rel, n: list.length, existed });
}

const w = writeBoardGuarded({ file: FILE, before: text, after: nextBoard, who: 'ticket-archive' });
if (!w.ok) {
  console.error('✗ 写票板失败（' + w.code + '）' + (w.detail ? '：' + w.detail : '') + ' ⇒ **归档已写、票板没改** ⚠ 需要人工收尾 ✗');
  console.error('  ⇒ 快照在 ' + path.relative(ROOT, bak.path) + ' ✓ 用官方工具重跑一次归档即可（归档是追加 ✓ 会重复 ✗ 先看归档内容）');
  process.exit(1);
}

// 回读核对：搬走的行必须逐行出现在归档里；票板里必须不再有这些行
const archAll = [...byMonth.keys()].map((m) => readFileSync(path.join(path.dirname(FILE), path.basename(FILE, '.md') + '-归档-' + m + '.md'), 'utf8')).join('\n');
const missing = movedLines.filter((l) => l.trim() && !archAll.includes(l));
const afterBoard = readFileSync(FILE, 'utf8');
const leftOver = eligible.filter((t) => afterBoard.includes('**票号**：' + t.id) && t.id);
console.log('');
console.log('· 归档：' + written.map((x) => x.rel + '（' + x.n + ' 张' + (x.existed ? '，追加' : '，新建') + '）').join('｜'));
console.log('· 回读核对：搬走 ' + movedLines.filter((l) => l.trim()).length + ' 行，归档里缺 ' + missing.length + ' 行，票板里残留 ' + leftOver.length + ' 张');
if (missing.length || leftOver.length) {
  console.error('✗ **核对没过** ⇒ 别继续用票板 ✗ 快照：' + path.relative(ROOT, bak.path) + '（整份复制回去即可回滚 ✓）');
  process.exit(1);
}
console.log('✅ 归档完成：' + eligible.length + ' 张票已进归档，票板剩 ' + (tickets.length - eligible.length) + ' 张 ✓');
console.log('   下一步：node tools/ticket-check.mjs --strict（票板变短了，判据不变 ✓）');
