#!/usr/bin/env node
/**
 * tools/pack-release.mjs —— 单文件发行包的**复现**与**漂移检查**
 *
 * 为什么需要（2026-11-02）：
 *   之前 `dist/` 里的单文件包只能在仓库外手工拼，仓库里只有 `verify-release.mjs`（**验**一个已经存在的包 ✓）
 *   ⇒ 改完 tools/ 忘了重打包 ⇒ dist 还是旧的 ✗ 而 verify-release **验不出来**（它验的是包自身一致 ✓）
 *   ⇒ 版本串还停在旧值（包首注释里那句 `.split(旧版本).join(新版本)` 的事故就是这么来的 ✗）
 *
 * 两种用法：
 *   node tools/pack-release.mjs --check                  # 门禁：工作树与 dist 最新包不一致 ⇒ exit 1 ✓ 不写盘 ✓
 *   node tools/pack-release.mjs --pack --version v1.10.42 # 真的重打包（默认读 dist 最新包当模板 ✓ 写完自检 ✓）
 *
 * `--check` 判什么（三件事，缺一件都挡不住事故 ✓）：
 *   ① 包内每个文件：工作树里还在吗？内容 sha256 还对得上吗？（改了源码没重打包 ✗）
 *   ② 工作树里多出来的文件：tools 下、docs 下、README 有没有包内清单没有的？（新加文件没进包 ✗）
 *   ③ 包内清单里的文件在工作树里找不到 ⇒ 包比源码旧（删了文件没重打包 ✗）
 *
 * bundleId 算法（与已发行的包逐位一致 ✓ 反推验证过）：
 *   bundleId = sha256(按路径排序后**各文件 sha256 十六进制串直接拼接**) 的前 16 位 ✓
 *   所以"文件集合或任一文件内容变了 ⇒ bundleId 必变" ✓ 拿它当门禁是最省事的判据 ✓
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const PACK = argv.includes('--pack');
const arg = (f, d = '') => { const i = argv.indexOf(f); return i < 0 ? d : String(argv[i + 1] || d); };

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/* ★ T-20261103-F08：**行尾归一**（仓库 .gitattributes 是 eol=lf ✗ Windows 工作树是 CRLF ✗）
   现场：CI 从 #27 起连红三次，差值正好是每个 CRLF 多一个字节 ✗ 本地绿、CI 红 ✗
   ⇒ 打包与比较**两侧都先 \r\n → \n** ✓ bundleId 按归一后的内容算 ✓ 不许把 dist 当二进制糊过去 ✗ */
const lfBuf = (buf) => Buffer.from(String(buf.toString('utf8')).replace(/\r\n/g, '\n'), 'utf8');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const die = (msg, hint) => {
  console.error('✗ ' + msg);
  if (hint) console.error('  ⇒ ' + hint);
  process.exit(2);
};

/** 最新的 dist 单文件包（按名字里的版本号排 ✓ 不靠 mtime ✗ mtime 在 clone/解压后会变）*/
const newestPackage = () => {
  if (!existsSync(DIST)) die('没有 dist/ 目录', '先有至少一个已发行的包，才能把它当模板 ✓');
  const list = readdirSync(DIST).filter((f) => /\.mjs$/.test(f));
  if (!list.length) die('dist/ 里没有 .mjs 包', '先放一个已发行的单文件包当模板 ✓');
  const ver = (n) => { const m = /v(\d+)\.(\d+)\.(\d+)/.exec(n); return m ? m[1] * 1e6 + m[2] * 1e3 + m[3] : -1; };
  list.sort((a, b) => ver(b) - ver(a));
  return path.join(DIST, list[0]);
};

/** 从包源码里读出 BUNDLE_ID / FILES / TOTAL / OUT 默认值 */
const parsePackage = (src) => {
  const idm = /const BUNDLE_ID = '([0-9a-f]{16})';/.exec(src);
  const fm = /const FILES = (\[.*?\]);\nconst argv/s.exec(src) || /const FILES = (\[[\s\S]*?\]);/.exec(src);
  const tm = /const TOTAL = (\d+);/.exec(src);
  const om = /: '([^']+)';\nconst FORCE/.exec(src);
  if (!idm || !fm || !tm) die('包格式看不懂（缺 BUNDLE_ID / FILES / TOTAL）', '确认这是本仓库自己产的包 ✓');
  return { bundleId: idm[1], files: JSON.parse(fm[1]), total: Number(tm[1]), defaultOut: om ? om[1] : '' };
};

/** 工作树里"应该进包"的候选：**只有 tools 下所有 .mjs** ✓
 *  docs/ 与 README 不在比较范围 ✗ 原因（2026-11-02 实测）：发行包里的 README 是 74 KB 的合订本，
 *  还带着 `docs/交接.md`、`docs/角色分工.md`、`docs/阶段决定-*.md` 这些**仓库里根本没有**的语料 ✗
 *  ⇒ 包 = tools（工具本体，必须与仓库同步 ✓）＋ 语料（打包时从模板包原样带过去 ✓）
 *  ⇒ 把语料也拉进比较范围 ⇒ 门禁永远红 ✗ 那不是门禁，是噪音 ✗ */
const workingTreeCandidates = () => {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      // .mjs 是工具本体；.json 是契约文件（tools/schema/*.json）—— 两者都要进包 ✓
      if (e.name.endsWith('.mjs') || e.name.endsWith('.json')) out.push(rel(p));
    }
  };
  walk(path.join(ROOT, 'tools'));
  return [...new Set(out)].sort();
};

const pkgPath = newestPackage();
const pkgSrc = readFileSync(pkgPath, 'utf8');
const PKG = parsePackage(pkgSrc);
console.log('模板包：' + rel(pkgPath));
console.log('  参考：' + PKG.files.length + ' 个文件｜bundleId ' + PKG.bundleId + '｜解包后 ' + PKG.total + ' 字节');

// ── --check：三件事逐条比对 ───────────────────────────────────────────────
if (CHECK) {
  const drift = [];
  const inScope = (p) => p.startsWith('tools/');           // 只比工具本体 ✓ 语料不比 ✗
  const carried = PKG.files.filter((f) => !inScope(f.p));
  for (const f of PKG.files) {
    if (!inScope(f.p)) continue;
    const abs = path.join(ROOT, f.p.split('/').join(path.sep));
    if (!existsSync(abs)) { drift.push('包里有、工作树没有：' + f.p); continue; }
    const buf = lfBuf(readFileSync(abs));
    const h = sha256(buf);
    if (h !== f.h) drift.push('内容不一致：' + f.p + '（包 ' + f.h.slice(0, 12) + ' ／ 现 ' + h.slice(0, 12) + '，' + buf.length + ' vs ' + f.n + ' 字节）');
  }
  const inPkg = new Set(PKG.files.map((f) => f.p));
  for (const p of workingTreeCandidates()) {
    if (!inPkg.has(p)) drift.push('工作树有、包里没有：' + p);
  }

  /* ── 第 4 件：**文档里的版本号**不许过期（2026-11-02 补） ──
     现场：README 里写着 `v1.10.41` 的示例命令、目录树写着 `v1.10.50`，而 dist 已经到 v1.10.52 ✗
     外面的人照着抄会拿到一个不存在的文件名 ✗ ⇒ 文档里要么写占位符 `<版本>`，要么写**当前最新** ✓ */
  const distDir = path.join(ROOT, 'dist');
  const versions = existsSync(distDir)
    ? readdirSync(distDir).map((f) => (f.match(/v(\d+\.\d+\.\d+)/) || [])[1]).filter(Boolean)
    : [];
  const latestVer = versions.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).pop() || '';
  const docDrift = [];
  // 只看 README：docs/ 里的规范与修复清单**本来就记着历史版本号**（v1.10.36…v1.10.40），改了反而是抹掉历史 ✗
  const DOCS = ['README.md'];
  for (const rel of DOCS) {
    const abs = path.join(ROOT, rel.split('/').join(path.sep));
    if (!existsSync(abs)) continue;
    const t = readFileSync(abs, 'utf8');
    for (const m of t.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)) {
      if (latestVer && m[1] !== latestVer) docDrift.push(rel + ' 写了 v' + m[1] + '（最新是 v' + latestVer + '）');
    }
  }

  // ── 第 5 件：README 里**不许出现具体项目的行业词**（2026-11-02 主人指出）
  //   现场：README 拿「卡」「世界书」「线上平台」举例说明"这是原始项目的背景" ✗
  //   ⇒ 等于把项目是什么告诉所有人 ✗ 例子一律用中性词 ✓
  const BANNED = ['世界书', '线上平台', '角色卡', '卡片', '发卡', '卡面', '风月', '酒馆'];
  const readmePath = path.join(ROOT, 'README.md');
  if (existsSync(readmePath)) {
    const rt = readFileSync(readmePath, 'utf8');
    for (const w of BANNED) {
      const n = rt.split(w).length - 1;
      if (n) docDrift.push('README.md 出现行业词「' + w + '」×' + n + '（示例请用中性词：需求／文档／部署）');
    }
  }
  console.log('比较范围：tools/ 下 ' + PKG.files.filter((f) => inScope(f.p)).length + ' 个文件 ✓（另有 ' + carried.length + ' 个语料文件：README／docs，打包时原样带过去 ✓ 不参与比较 ✗）');
  console.log('');
  if (!drift.length && !docDrift.length) {
    console.log('✅ dist 与工作树一致（' + PKG.files.length + ' 个文件，bundleId ' + PKG.bundleId + '）⇒ 不需要重打包 ✓');
    console.log('✅ 文档里的版本号与最新包一致（v' + latestVer + '）✓');
    process.exit(0);
  }
  if (docDrift.length) {
    console.log('⚠ **文档里的版本号过期 ' + docDrift.length + ' 处** ⇒ 外面的人照抄会拿到不存在的文件 ✗');
    for (const d of docDrift.slice(0, 10)) console.log('  · ' + d);
    console.log('  ⇒ 改成占位符 `<版本>`，或改成最新 v' + latestVer + ' ✓（别写死旧版本 ✗）');
    console.log('');
  }
  if (!drift.length) process.exit(1);
  console.log('⚠ **dist 与工作树不一致 ' + drift.length + ' 处** ⇒ 发行包已落后于源码 ✗');
  for (const d of drift.slice(0, 20)) console.log('  · ' + d);
  if (drift.length > 20) console.log('  · …还有 ' + (drift.length - 20) + ' 处');
  console.log('');
  console.log('  ⇒ 重打包：node tools/pack-release.mjs --pack --version <新版本> ✓');
  console.log('  ⇒ 验内容：node tools/verify-release.mjs --pkg <新包> --must-contain "<关键串>" ✓');
  console.log('  ⇒ **别只改 dist 里的一行糊过去** ✗ bundleId 靠全部文件的 sha256 串起来 ✓');
  process.exit(1);
}

// ── --pack：按"模板包清单 ∪ 工作树新增文件"重打 ──────────────────────────
if (!PACK) die('没说做什么', '--check 只检查 ✓ --pack 才重打包 ✗');
const VERSION = arg('--version');
if (!VERSION) die('缺 --version', '例：--version v1.10.42 ✓（版本串要由打包方给一次，别在模板里硬改 ✗）');

const oldVer = (/单文件工具包 (v[\d.]+)/.exec(pkgSrc) || [, ''])[1];
// 语料（README／docs）**原样带过去** ✓ 仓库里没有它们 ✗ 重新从工作树打会把包打残 ✗
const carried = PKG.files.filter((f) => !f.p.startsWith('tools/'));
const wantedTools = [...new Set([
  ...PKG.files.filter((f) => f.p.startsWith('tools/')).map((f) => f.p),
  ...workingTreeCandidates()
])].sort();

const files = [...carried].map((f) => { const buf = lfBuf(Buffer.from(f.b, 'base64')); return { p: f.p, n: buf.length, h: sha256(buf), b: buf.toString('base64') }; });
const missing = [];
for (const p of wantedTools) {
  const abs = path.join(ROOT, p.split('/').join(path.sep));
  if (!existsSync(abs) || !statSync(abs).isFile()) { missing.push(p); continue; }
  const buf = lfBuf(readFileSync(abs));
  files.push({ p, n: buf.length, h: sha256(buf), b: buf.toString('base64') });
}
if (missing.length) die('这些文件在工作树里不存在，不能打进包：' + missing.join('、'), '先补文件，或从清单里删掉 ✓');

const total = files.reduce((s, f) => s + f.n, 0);
const bundleId = sha256(files.map((f) => f.h).join('')).slice(0, 16);

let out = pkgSrc
  .replace(/const BUNDLE_ID = '[0-9a-f]{16}';/, "const BUNDLE_ID = '" + bundleId + "';")
  // ★ 2026-11-02 修：原来要求 `];` 紧跟 `const argv` ✗ 模板里中间有个空行 ⇒ 替换**静默不生效** ✗
  //   结果：bundleId/TOTAL 是新算的、FILES 还是旧的 22 条 ⇒ 包自相矛盾，而 --verify 照样通过 ✗
  //   ⇒ 现在用前瞻容忍空行 ✓ 并在写盘前**重新解析生成结果**做断言 ✓
  .replace(/const FILES = \[[\s\S]*?\];(?=\s*\nconst argv)/, 'const FILES = ' + JSON.stringify(files) + ';')
  .replace(/const TOTAL = \d+;/, 'const TOTAL = ' + total + ';');

// 生成物自检：条目数 / bundleId / 字节数 三者必须与本次计算一致 ✓ 不一致就**不写盘** ✗
{
  const gen = parsePackage(out);
  if (gen.files.length !== files.length) {
    die('生成的包 FILES 条目数不对：' + gen.files.length + ' ≠ ' + files.length, '模板里 FILES 的结构变了 ✗ 检查替换正则 ✓（本次**没有写任何文件** ✗）');
  }
  if (gen.bundleId !== bundleId) die('生成的包 bundleId 不对：' + gen.bundleId + ' ≠ ' + bundleId, '替换没生效 ✗（本次没有写任何文件 ✗）');
  if (gen.total !== total) die('生成的包 TOTAL 不对：' + gen.total + ' ≠ ' + total, '替换没生效 ✗（本次没有写任何文件 ✗）');
}

// 版本串：三处（标题注释、内容行、默认输出目录）一起换 ✓ 换完必须复核没有旧版本残留 ✗
if (oldVer && oldVer !== VERSION) {
  out = out.split(oldVer).join(VERSION);
  const leftover = out.split('\n').filter((l) => l.includes(oldVer)).length;
  if (leftover) die('版本替换后仍有 ' + leftover + ' 行留着旧版本 ' + oldVer, '模板里有写死的旧版本 ✗ 先清掉再打包 ✓');
}

// ★ 2026-11-02 改名：包名跟仓库名一致（ASCII）\
//   为什么：GitHub Release 网页上传非 ASCII 文件名会被弄坏（现场：开票工作流-工具包-v1.10.55.单文件.mjs ⇒ '-.-v1.10.55.mjs'）✗\
const outName = 'super-big-fat-fish-' + VERSION + '.mjs';
const outPath = arg('--out') || path.join(DIST, outName);
writeFileSync(outPath, out, 'utf8');

console.log('');
console.log('✅ 已产出：' + rel(outPath));
console.log('  bundleId ' + bundleId + '｜' + files.length + ' 个文件｜解包后 ' + total + ' 字节｜版本 ' + VERSION);
console.log('  下一步：node tools/verify-release.mjs --pkg "' + rel(outPath) + '" --must-contain "<关键串>" ✓');
console.log('  再跑：node "' + rel(outPath) + '" --verify  （解到临时目录 → 跑两套自测 → 删掉 ✓）');
