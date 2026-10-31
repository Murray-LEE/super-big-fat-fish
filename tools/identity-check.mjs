#!/usr/bin/env node
/**
 * identity-check.mjs —— **只验账，不验对错** ✓
 *
 * v1.10.16（五线 §9.0 的直接产物）：每条线自己写 JSON 断言 ⇒ 各写一套 ✗
 * 而且最容易写成 `sum(byKindReal) == knownReal` ✗（干净板上恒真 ✓ 一跑脏板就炸 ✗）
 *
 * 正确式子（本脚本只认这四条）：
 *   1) total = real + debt
 *   2) real  = knownReal + unknown + unclassified
 *   3) sum(byKindReal) = real        ← 含 unknown ✓ 不含历史债 ✓（**不是** knownReal ✗）
 *   4) sum(byKindDebt) = debt
 *
 * 用法：
 *   node tools/identity-check.mjs                     # 默认 docs/待办.md
 *   node tools/identity-check.mjs --file tmp/dirty.md # 任意票板
 *   node tools/identity-check.mjs --strict            # 任一条不成立 ⇒ exit 1
 *
 * 退出码：0 全成立 ✓ ／ 1 有不成立（仅 --strict）✗ ／ 2 参数或文件问题
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintTickets, buildReport, readTextSafe, loadConfig, tsOk, setLineNames } from './lib/ticket-lint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const fi = argv.indexOf('--file');
const STRICT = argv.includes('--strict');

// ★ v1.10.19（GPT R05）：**两个入口必须算同一个口径** ✗
//   以前这里 `lintTickets(text, {})` 走库默认 2026-10-25 ⇒ 和主检查器读的项目配置不一致 ✗
//   实测：同一块板、同一配置 ⇒ check 报 real 0／debt 2，identity 报 real 2／debt 0 ✗（四条恒等式还照样全成立 ✗）
const CFG = loadConfig(ROOT);
if (CFG.error) {
  console.error('✗ 配置文件读不了：' + CFG.source + '：' + CFG.error);
  console.error('  ⇒ 期望：合法 JSON（`docs/.ticketrc.json` 或 `package.json` 的 `ticket` 段）✓');
  console.error('  ⇒ **什么都没做** ✗ 不改文件 ✓');
  process.exit(2);
}
const cget = (k) => (CFG.cfg && CFG.cfg[k] != null ? String(CFG.cfg[k]) : '');
if (CFG.cfg && CFG.cfg.lines) setLineNames(CFG.cfg.lines);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return '';
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) {
    console.error('✗ ' + flag + ' 缺少取值（后面' + (v === undefined ? '没有东西' : '是另一个选项 ' + v) + '）');
    console.error('  ⇒ 期望：' + flag + ' <值> ✓ 或直接不写这个选项 ✓');
    console.error('  ⇒ **什么都没做** ✗ 不改文件 ✓');
    process.exit(2);
  }
  return String(v);
};
const rel = argOf('--file') || cget('board') || 'docs/待办.md';
const FILE = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
const DEBT_SINCE = argOf('--debt-since') || cget('debtSince') || '2026-10-25';
const SINCE = argOf('--since') || cget('since') || '2026-10-25';
for (const [name, v] of [['--since', SINCE], ['--debt-since', DEBT_SINCE]]) {
  if (!tsOk(v)) {
    console.error('✗ ' + name + ' 无法解析成时刻：' + JSON.stringify(v));
    console.error('  ⇒ 期望 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:MM`（且日历上存在 ✓ 例：2026-10-25T21:40）');
    console.error('  ⇒ **什么都没做** ✗ 不改文件 ✓');
    process.exit(2);
  }
}

if (!existsSync(FILE) || !statSync(FILE).isFile()) {
  console.error('✗ 找不到票板文件：' + rel);
  console.error('  ⇒ 期望：该路径**存在且是文件** ✓ 例：docs/待办.md');
  console.error('  ⇒ **什么都没做** ✗ 不改文件 ✓');
  process.exit(2);
}

const READ = readTextSafe(FILE);
if (!READ.ok) {
  const why = READ.code === 'EACCES' || READ.code === 'EPERM'
    ? '文件存在但**没有读权限**（权限问题 ✗ 不是账的问题 ✗）'
    : '文件存在但**读不动**（' + READ.code + '）';
  console.error('✗ 读不动票板文件：' + rel + '：' + why);
  console.error('  ⇒ 期望：该路径**存在、是文件、且读得动** ✓ 例：docs/待办.md');
  console.error('  ⇒ **什么都没做** ✗ 不改文件 ✓');
  process.exit(2);
}
const text = READ.text;
const LINT = lintTickets(text, { since: SINCE, debtSince: DEBT_SINCE });  // ★ v1.10.19（R05）：与主检查器同口径 ✓
const j = buildReport(LINT, { since: SINCE, debtSince: DEBT_SINCE });
const s = j.summary;

const sumOf = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
const rows = [
  ['total = real + debt', s.total, s.real + s.debt],
  ['real  = knownReal + unknown + unclassified', s.real, s.knownReal + s.unknown + s.unclassified],
  ['sum(byKindReal) = real   ← 不是 knownReal ✗', sumOf(s.byKindReal), s.real],
  ['sum(byKindDebt) = debt', sumOf(s.byKindDebt), s.debt]
];

console.log('════ 恒等式自查（只验账 ✓ 不验对错 ✗）════');
console.log('文件：' + rel + '｜口径：debtSince=' + DEBT_SINCE + (CFG.source ? '（配置 ' + CFG.source + '）' : '（默认值）') + '｜票 ' + j.tickets.total + ' 张｜real ' + s.real + ' ／ debt ' + s.debt
  + ' ／ knownReal ' + s.knownReal + ' ／ unknown ' + s.unknown + ' ／ unclassified ' + s.unclassified);
console.log('');
let bad = 0;
for (const [name, left, right] of rows) {
  const ok = left === right;
  if (!ok) bad++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + '｜' + left + (ok ? ' = ' : ' ≠ ') + right);
}
console.log('');
if (!bad) {
  console.log('✅ 四条全成立 ✓');
  console.log('  ⇒ 这**只说明账算对了** ✗ 不说明票对 ✓ 也不说明没问题 ✓');
  console.log('  ⇒ 而且要说清：四条是**同一份输出**算出来的 ⇒ **结构上恒成立** ✗ 它**做不出"炸"** ✗');
  console.log('　　能抓：① 你脚本里写错的式子（如 sum(byKindReal)==knownReal ✗）② **字段接线错误**（如 unclassified 没进 real ✗）');
  console.log('　　抓不到：**票判错了** ✗ 账照样对 ✓ 那要靠 --list 的人看 ✓（这是"验账"，不是"验票"✗）');
  process.exit(0);
}
console.log('✗ **' + bad + ' 条不成立** ⇒ 要么票板有异常，要么工具算错了 ✗ 请把这份输出贴回来 ✓');
process.exit(STRICT ? 1 : 0);
