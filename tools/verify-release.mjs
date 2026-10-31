#!/usr/bin/env node
/**
 * verify-release.mjs —— **发行包可机械复验**（票 T-20261101-F05）
 *
 * 为什么要有它（2026-11-01 现场）：
 *   v1.10.40 第一遍打出来的包，**包里 README 没有 11.21 段** —— 因为打包脚本的 README 取自**上一版包体**，
 *   而脚本只断言了**标题行**版本号 ✗ 标题对、正文可以是旧的 ⇒ 就这么漏过去了 ✗
 *   ⇒ 光"验标题"不够 ✓ 得能对**任意一段正文**说"它在不在包里" ✓
 *
 * 用法：
 *   node tools/verify-release.mjs --pkg dist/开票工作流-工具包-v1.10.40.单文件.mjs --must-contain "### 11.21"
 *   node tools/verify-release.mjs --pkg … --must-contain "甲" --must-contain "乙"     # 可重复
 *
 * 做三件事：
 *   ① 解包到临时目录（用包自己的 `--out` ✓ 与用户装的是同一条路径 ✓）
 *   ② 逐条 grep `--must-contain` 的串：缺哪条、**在哪个文件里也没找到** ⇒ 说清 ✓
 *   ③ 打印 sha256／文件数／bundleId（回票要贴的证据 ✓）
 *
 * 退出码：0 全在 ✓ ／ 1 有缺 ✓（附带说明）／ 2 参数或包不可用 ✗
 */
import { readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (flag) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--')) out.push(String(argv[i + 1]));
  return out;
};
const die = (m, h) => { console.error('✗ ' + m); if (h) console.error('  ⇒ ' + h); console.error('  ⇒ 什么都没做 ✓'); process.exit(2); };

const PKG_ARGS = argOf('--pkg');
if (!PKG_ARGS.length) die('缺 --pkg（要验哪个包）', '例：--pkg dist/开票工作流-工具包-v1.10.40.单文件.mjs');
const NEEDLES = argOf('--must-contain');
if (!NEEDLES.length) die('缺 --must-contain（要在包里找到什么串）', '例：--must-contain "### 11.21"（可重复多次）');

const PKG = path.isAbsolute(PKG_ARGS[0]) ? PKG_ARGS[0] : path.join(ROOT, PKG_ARGS[0]);
if (!existsSync(PKG) || !statSync(PKG).isFile()) die('找不到包：' + PKG, '路径必须是**存在的文件** ✓');

const buf = readFileSync(PKG);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
const src = buf.toString('utf8');
const m = /BUNDLE_ID\s*=\s*'([0-9a-f]{16})'/.exec(src);
const bundleId = m ? m[1] : '(读不到 bundleId)';

const tmp = path.join(os.tmpdir(), 'fj-verify-rel-' + Date.now());
let files = [];
try {
  try { execFileSync(process.execPath, [PKG, '--out', tmp], { stdio: 'pipe' }); }
  catch (e) { die('解包失败（包自身 --out 报错）', String((e && e.stdout) || (e && e.message) || e).slice(0, 300)); }
  const walk = (dir, base = '') => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = base ? base + '/' + name : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files.push(rel);
    }
  };
  walk(tmp);

  console.log('════ 发行包复验 ════');
  console.log('包：' + path.relative(ROOT, PKG) + '｜' + buf.length + ' 字节｜' + files.length + ' 个文件');
  console.log('sha256：' + sha);
  console.log('bundleId：' + bundleId);

  const missing = [];
  for (const needle of NEEDLES) {
    const hits = [];
    for (const rel of files) {
      const text = readFileSync(path.join(tmp, rel), 'utf8');
      if (text.includes(needle)) hits.push(rel);
    }
    if (hits.length) console.log('  ✓ 找到 ' + JSON.stringify(needle) + ' ⇒ ' + hits.join('／'));
    else { console.log('  ✗ **没找到** ' + JSON.stringify(needle) + '（' + files.length + ' 个文件里都没有 ✗）'); missing.push(needle); }
  }
  if (missing.length) {
    console.log('');
    console.log('✗ **缺 ' + missing.length + ' 条**：' + missing.map((s) => JSON.stringify(s)).join('／'));
    console.log('  ⇒ 说明包里确实没有这段 ⇒ 打包时漏了（别当成"验过了"✗）');
    process.exit(1);
  }
  console.log('');
  console.log('✅ 全部 ' + NEEDLES.length + ' 条都在包里 ✓');
  process.exit(0);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
}
