#!/usr/bin/env node
/**
 * mk-proj.mjs —— 造一个**唯一**的临时项目（给"造脏板/跑入口测试"用）✓
 *
 * 为什么要有它（T-20261027-P01 · 发布工程师实机报的）：
 *   我 2026-10-26 那张票让三条线都用 `tmp/proj-F10` ✗ ⇒ 八条线共用同一个路径 ⇒
 *   一个会话 `rm -rf tmp/` 就把别人的临时项目清掉 ✗ ⇒ 剩下 "Cannot find module" ✗ 谁都看不出为什么 ✗
 *   ⇒ 不是谁不小心，是**我给的指令用了共用路径** ✗
 *
 * 用法：
 *   P=$(node tools/mk-proj.mjs --line P)          # 唯一路径（stdout 只打路径 ✓）
 *   node "$P/tools/ticket-check.mjs" --strict     # 在里面跑 ✓ 不会和别人撞
 *   node tools/mk-proj.mjs --clean "$P"           # 用完清掉
 *
 * 选项：
 *   --line <码>        路径里带线码，便于认领（D／C／P／F，任意短串）
 *   --debt-since <值>  写进临时项目 docs/.ticketrc.json（默认 2026-10-25T21:40）
 *   --board <文件>     用这份票板做种子（默认造一张合规票）
 *   --clean <路径>     删掉某个临时项目（只删本工具造的那种 ✓ 不删别的 ✗）
 *
 * 退出码：0 成功 ／ 2 参数或路径问题
 */
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (f) => {
  const i = argv.indexOf(f);
  if (i < 0) return '';
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) {
    console.error('✗ ' + f + ' 缺少取值');
    process.exit(2);
  }
  return String(v);
};

const CLEAN = argOf('--clean');
if (CLEAN) {
  const p = path.resolve(CLEAN);
  const base = path.basename(p);
  if (!base.startsWith('fj-proj-')) {
    console.error('✗ 只删本工具造的临时项目（目录名必须以 fj-proj- 开头）✗ 收到：' + base);
    console.error('  ⇒ 这是**防手滑** ✓ 别的目录请自己删 ✓');
    process.exit(2);
  }
  if (!existsSync(p)) { console.error('（已经不在了：' + p + ' ✓）'); process.exit(0); }
  rmSync(p, { recursive: true, force: true });
  console.error('✓ 已删除 ' + p);
  process.exit(0);
}

const line = (argOf('--line') || 'X').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'X';
const debtSince = argOf('--debt-since') || '2026-10-25T21:40';
const seed = argOf('--board');

const dir = mkdtempSync(path.join(os.tmpdir(), 'fj-proj-' + line + '-'));
mkdirSync(path.join(dir, 'docs'), { recursive: true });
cpSync(path.join(ROOT, 'tools'), path.join(dir, 'tools'), { recursive: true });

writeFileSync(path.join(dir, 'docs', '.ticketrc.json'), JSON.stringify({
  board: 'docs/待办.md', handoff: 'docs/交接.md', since: '2026-10-25', debtSince
}, null, 2) + '\n');

const okTicket = '## [x] [调试工程师→卡片工程师] 临时项目里的合规票（2026-10-27 03:00 UTC+8）\n\n'
  + '**票号**：T-20261027-D01\n**负责人**：卡片工程师｜**验收方**：调试工程师\n**阻塞**：无\n'
  + '**验收方式**：`node tools/ticket-check-selftest.mjs`\n\n'
  + '> ✅ **【03:10 · 调试工程师】** 回「临时项目里的合规票」（T-20261027-D01）\n';
writeFileSync(path.join(dir, 'docs', '待办.md'), seed ? readFileSync(path.resolve(seed), 'utf8') : okTicket);

/* ★ T-20261103-F05：**把本仓 docs/经验 一起带过去** ✗ 只有这条测试路径以前漏了 ✗
   现场：样例项目没有 docs/经验 ⇒ 在里面跑 ticket-dispatch 永远「命中 0 条」⇒ 看起来像经验库没生效 ✗
   规矩：**有则拷、无则静默跳过**（源目录不存在 ⇒ 不建目录、不报错、exit 0）✓ */
let expN = 0;
try {
  const expSrc = path.join(ROOT, 'docs', '经验');
  if (existsSync(expSrc)) {
    const mds = readdirSync(expSrc).filter((f) => /\.md$/i.test(f));
    if (mds.length) {
      mkdirSync(path.join(dir, 'docs', '经验'), { recursive: true });
      for (const f of mds) copyFileSync(path.join(expSrc, f), path.join(dir, 'docs', '经验', f));
      expN = mds.length;
    }
  }
} catch (e) { console.error('⚠ 经验库没拷过去（不影响样例）：' + ((e && e.message) || e)); }

if (expN) {
  writeFileSync(path.join(dir, 'README.md'),
    '# 临时样例项目（mk-proj 生成）\n\n'
    + '- 票板：`docs/待办.md`｜配置：`docs/.ticketrc.json`\n'
    + '- **自带 ' + expN + ' 条种子经验**（`docs/经验/*.md`）⇒ 可直接测命中，不用手拷 ✓\n'
    + '- 派活：`node tools/ticket-dispatch.mjs --board docs/待办.md`\n', 'utf8');
}

console.error('✓ 临时项目已建：line=' + line + ' debtSince=' + debtSince + (seed ? ' board=种子' : ' board=合规样例') + (expN ? '｜经验 ' + expN + ' 条' : '｜无经验库'));
console.log(dir);
