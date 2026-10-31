#!/usr/bin/env node
/**
 * ticket-titles.mjs —— 把票面里的**线名/代号**改写成**职务** ✓（v1.10.22）
 *
 * 只管三个地方（都是**当前状态字段** ✓ 不动任何证据正文 ✗）：
 *   · 票头路由  `## [ ] [调试→卡片] 标题`  ⇒ `[调试工程师→卡片工程师]`
 *   · `负责人` 行                          ⇒ 职务
 *   · `验收方` 行                          ⇒ 职务
 *
 * 只改**活跃票**（待处理／处理中／待验收）✓ 已结/已取消老票不回填 ✗
 *
 * 用法：
 *   node tools/ticket-titles.mjs                # 预演（不写盘 ✓）
 *   node tools/ticket-titles.mjs --write        # 落盘（先备份 ✓ 写前重读 ✓）
 *   node tools/ticket-titles.mjs --file X --backup-dir tmp/bak --write   # 给测试用
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, copyFileSync, constants as FS } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTickets, checkNames, canonicalName, readTextSafe, loadConfig, setLineNames } from './lib/ticket-lint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
{
  const c = loadConfig(ROOT);
  if (!c.error && c.cfg && c.cfg.lines) setLineNames(c.cfg.lines);  // v1.10.26：名字表可由配置覆盖 ✓
}
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return '';
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) {
    console.error('✗ ' + flag + ' 缺少取值');
    console.error('  ⇒ 什么都没做 ✗ 文件未改 ✓');
    process.exit(2);
  }
  return String(v);
};
const FILE_ARG = argOf('--file');
const BAK_ARG = argOf('--backup-dir');
const FILE = FILE_ARG ? (path.isAbsolute(FILE_ARG) ? FILE_ARG : path.join(ROOT, FILE_ARG)) : path.join(ROOT, 'docs', '待办.md');

const die = (m, h) => { console.error('✗ ' + m); if (h) console.error('  ⇒ ' + h); console.error('  ⇒ 什么都没做 ✗ 文件未改 ✓'); process.exit(2); };
if (!existsSync(FILE)) die('找不到票板：' + FILE, '路径必须存在且是文件');
if (!statSync(FILE).isFile()) die('票板路径不是文件：' + FILE, '要文件，不是目录');
const R = readTextSafe(FILE);
if (!R.ok) die('读不动票板（' + R.code + '）', '权限问题 ✗');
const text = R.text;
const lines = text.split('\n');
const eolCrlf = (text.match(/\r\n/g) || []).length > 0;
const stripCR = (l) => l.replace(/\r$/, '');

const ts = parseTickets(text).tickets;
const active = ts.filter((t) => t.state === ' ' || t.state === '~' || t.state === 'v');
const changes = [];

const fixField = (line, label) => {
  // 允许字段出现在 `｜` 之后（一行里同时写 负责人 和 验收方 ✓）
  const re = new RegExp('(^|[｜|])(\\s*(?:\\*\\*)?' + label + '(?:\\*\\*)?\\s*[：:]\\s*)([^｜|]+)');
  const m = re.exec(line);
  if (!m) return null;
  const raw = m[3].trim();
  const r = checkNames(raw);
  if (!r.ok) return { bad: true, raw };
  const canon = r.canonical.join('／');
  if (canon === raw) return null;
  return {
    line: line.slice(0, m.index) + m[1] + m[2] + canon + line.slice(m.index + m[0].length),
    from: raw, to: canon
  };
};

for (const t of active) {
  const start = t.line - 1;
  let end = lines.length;
  for (const other of ts) if (other.line > t.line) { end = Math.min(end, other.line - 1); break; }
  // 只扫**票头元信息区**（票号/负责人/验收方那几行 ✓）绝不碰正文 ✗
  let sawField = false;
  const scanEnd = Math.min(end, start + 8);
  for (let i = start; i < scanEnd; i++) {
    const raw = stripCR(lines[i]);
    if (i > start && raw.trim() === '' && sawField) break;
    // ① 票头路由（两侧都要按「／」拆开逐个归一 ✓）
    if (i === start && /^##\s*\[[^\]]*\]\s*\[[^\]]+\]/.test(raw)) {
      const m = /^(##\s*\[[^\]]*\]\s*\[)([^\]]+)(\].*)$/.exec(raw);
      if (m) {
        const to = m[2]
          .split('→')
          .map((side) => side.split(/[／/、,，]+/).map((x) => canonicalName(x) || x.trim()).join('／'))
          .join('→');
        if (to !== m[2]) changes.push({ line: i + 1, kind: '路由', from: m[2], to, next: m[1] + to + m[3] });
      }
    }
    let cur = raw;
    for (const label of ['负责人', '验收方']) {
      const f = fixField(cur, label);
      if (!f) continue;
      if (f.bad) { changes.push({ line: i + 1, kind: label + '（认不出）', from: f.raw, to: '← 需要人改 ✗', next: null }); continue; }
      changes.push({ line: i + 1, kind: label, from: f.from, to: f.to, next: f.line });
      cur = f.line;
      sawField = true;
    }
  }
}

if (!changes.length) {
  console.log('✓ 活跃票里**没有**需要改的线名/代号 ✓（' + active.length + ' 张活跃票都已是职务）');
  process.exit(0);
}

console.log('════ 线名 → 职务（' + (WRITE ? '**落盘** ⚠' : '预演 ✗ 不写盘 ✓') + '）════');
console.log('票板：' + path.relative(ROOT, FILE) + '｜活跃票 ' + active.length + ' 张｜改动 ' + changes.length + ' 处');
for (const c of changes) {
  if (!c.next) console.log('  L' + c.line + ' [' + c.kind + '] ' + JSON.stringify(c.from) + ' ⇒ ' + c.to);
  else console.log('  L' + String(c.line).padEnd(5) + c.kind + '：' + JSON.stringify(c.from) + ' ⇒ ' + JSON.stringify(c.to));
}
const blocked = changes.filter((c) => !c.next);
if (blocked.length) {
  console.log('');
  console.log('⚠ 有 ' + blocked.length + ' 处**认不出的写法** ✗ 那几行需要人改 ✓ 其余可以自动改 ✓');
}

if (!WRITE) {
  console.log('');
  console.log('（预演结束 ✓ 什么都没改 ✓ 觉得对再加 `--write` —— 它会先备份 ✓）');
  process.exit(0);
}

// 落盘
const outLines = lines.slice();
for (const c of changes) if (c.next) outLines[c.line - 1] = c.next + (stripCR(lines[c.line - 1]).length !== lines[c.line - 1].length ? '\r' : '');
const nextText = outLines.join('\n');
mkdirSync(BAK_ARG ? (path.isAbsolute(BAK_ARG) ? BAK_ARG : path.join(ROOT, BAK_ARG)) : path.join(ROOT, '.backups'), { recursive: true });
const bakDir = BAK_ARG ? (path.isAbsolute(BAK_ARG) ? BAK_ARG : path.join(ROOT, BAK_ARG)) : path.join(ROOT, '.backups');
const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
const bak = path.join(bakDir, 'titles-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.md');
copyFileSync(FILE, bak, FS.COPYFILE_EXCL);
if (readFileSync(FILE, 'utf8') !== text) {
  console.error('✗ 写前重读发现票板已被别人改过 ⇒ 不写 ✗');
  process.exit(1);
}
writeFileSync(FILE, nextText);
console.log('');
console.log('  ✓ 已写入 ' + changes.filter((c) => c.next).length + ' 处｜备份：' + path.relative(ROOT, bak));
console.log('  ✓ 回滚：把这份备份整份复制回去 ✓');
