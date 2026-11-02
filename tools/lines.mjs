#!/usr/bin/env node
/**
 * tools/lines.mjs —— 看 / 验 / 改 线名（「谁是谁」的唯一入口）
 *
 * 线名是**配置项**，不是代码：改 `docs/.ticketrc.json` 的 `lines` 就行 ✓
 * 这个脚本负责三件事：看清楚、验一遍、别改坏。
 *
 * 用法：
 *   node tools/lines.mjs                     # 我现在有哪几条线、各认哪些名字
 *   node tools/lines.mjs --json              # 机器可读
 *   node tools/lines.mjs --check             # 验配置：能不能加载、有没有「项目负责人」
 *   node tools/lines.mjs --set 前端,后端,QA  # 按顺序重命名三条线（保留原字母与别名，先备份）
 *   node tools/lines.mjs --set 前端,后端,QA --codes H,B,Q --dry-run
 *
 * 退出码：0 正常｜2 配置有问题
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);

const CFG = path.resolve(arg('--config', path.join(ROOT, 'docs/.ticketrc.json')));
const JSONOUT = flag('--json');
const CHECK = flag('--check');
const DRY = flag('--dry-run');
const SET = arg('--set', '');
const CODES = arg('--codes', '');

if (!existsSync(CFG)) {
  console.error('✗ 没有配置文件：' + CFG);
  console.error('  ⇒ 先复制模板：cp docs/.ticketrc.json.example docs/.ticketrc.json');
  process.exit(2);
}

let cfg;
try { cfg = JSON.parse(readFileSync(CFG, 'utf8')); }
catch (e) { console.error('✗ 配置不是合法 JSON：' + e.message); process.exit(2); }

const lines = cfg.lines || {};
const problems = [];
if (!Object.keys(lines).length) problems.push('lines 是空的 ⇒ 至少要有一条线');
const hasOwner = Object.keys(lines).some(k => k === '项目负责人' || (Array.isArray(lines[k]) ? lines[k].includes('项目负责人') : String(lines[k]).includes('项目负责人')));
if (!hasOwner) problems.push('没有「项目负责人」这条线 ⇒ 代回判定会失效（这条名字不能改）');

const norm = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[／/、,，]+/)).map(x => String(x).trim()).filter(Boolean);
const rows = Object.entries(lines).map(([name, v]) => {
  const list = norm(v);
  const code = list.find(x => /^[A-Za-z]{1,2}$/.test(x)) || '';
  return { name, code: code.toUpperCase(), aliases: list.filter(x => x !== code) };
});

/* ── --set：批量改名 ── */
if (SET) {
  const want = SET.split(/[,，、/]/).map(s => s.trim()).filter(Boolean);
  const codes = CODES ? CODES.split(/[,，、/]/).map(s => s.trim().toUpperCase()).filter(Boolean) : [];
  const targets = rows.filter(r => r.name !== '项目负责人');
  if (want.length !== targets.length) {
    console.error(`✗ 要改 ${targets.length} 条线（${targets.map(t => t.name).join('、')}），你给了 ${want.length} 个新名`);
    process.exit(2);
  }
  const next = {};
  targets.forEach((t, i) => {
    const newName = want[i];
    const code = codes[i] || t.code;
    next[newName] = [code, ...t.aliases, t.name].filter(Boolean);   // 旧名保留成别名 ⇒ 老脚本不炸 ✓
  });
  next['项目负责人'] = lines['项目负责人'];
  const out = { ...cfg, lines: next, _comment: cfg._comment };
  if (DRY) {
    console.log('（--dry-run）会写成：');
    console.log(JSON.stringify(out.lines, null, 1));
    process.exit(0);
  }
  mkdirSync(path.join(ROOT, '.backups'), { recursive: true });
  const bak = path.join(ROOT, '.backups', `ticketrc-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  copyFileSync(CFG, bak);
  writeFileSync(CFG, JSON.stringify(out, null, 1) + '\n', 'utf8');
  console.log(`✓ 已改名并写回 ${path.relative(process.cwd(), CFG) || CFG}（旧配置备份：${path.relative(ROOT, bak)}）`);
  console.log('  旧名保留成别名 ⇒ 老命令照常能用 ✓');
  process.exit(0);
}

if (JSONOUT) {
  console.log(JSON.stringify({ schemaVersion: 1, config: path.relative(ROOT, CFG) || CFG, lines: rows, problems }, null, 1));
  process.exit(problems.length ? 2 : 0);
}

console.log('═══ 线名配置（' + (path.relative(process.cwd(), CFG) || CFG) + '） ═══\n');
if (!rows.length) console.log('（还没有任何线）');
for (const r of rows) {
  const note = r.name === '项目负责人' ? '  ← 名字不能改（代回判定要认它）' : '';
  console.log(`  ${r.name.padEnd(8)} 票号字母 ${(r.code || '—').padEnd(3)} 别名：${r.aliases.length ? r.aliases.join('、') : '（无）'}${note}`);
}
if (problems.length) { console.log('\n✗ 有问题：'); problems.forEach(p => console.log('  · ' + p)); }
else console.log('\n✓ 配置能加载，且「项目负责人」在位');

if (CHECK) process.exit(problems.length ? 2 : 0);
console.log('\n想改名：编辑这份 JSON 的 lines，或 `node tools/lines.mjs --set 前端,后端,QA`');
console.log('改完验一遍：node tools/lines.mjs --check');
