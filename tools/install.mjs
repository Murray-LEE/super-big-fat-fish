#!/usr/bin/env node
/**
 * tools/install.mjs —— **一条命令**把开票工作流装进一个项目（傻瓜版）
 *
 * 为什么需要（2026-11-02）：
 *   README 的「装到一台新电脑 / 新项目」是四行手工命令（cp tools、cp 配置、mk-proj、跑自检）✗
 *   手工步骤的问题不是麻烦，是**漏一步不报错** ✗（没拷配置 ⇒ 用默认线名跑 ⇒ 票号全是别人的项目 ✗）
 *   ⇒ 一条命令做完，并且每一步都**打印它做了什么** ✓ 跳过什么也说清 ✗ 不做静默修补 ✗
 *
 * 用法：
 *   node tools/install.mjs                     # 装进当前目录
 *   node tools/install.mjs --to ../某项目       # 装进别处
 *   node tools/install.mjs --force             # 覆盖已有同名文件（默认**一个都不覆盖** ✗）
 *   node tools/install.mjs --no-ci             # 不装 .github/workflows/ticket-check.yml
 *   node tools/install.mjs --dry-run           # 只打印要做什么（不写盘 ✓）
 *
 * 装完你会得到：
 *   <目标>/tools/**                      工具本体（含两套自检 ＋ 写入保护自检）
 *   <目标>/docs/.ticketrc.json           线名/阈值配置（已有就**不覆盖** ✗ 先改线名 ✓）
 *   <目标>/docs/待办.md                   空票板（已有就不动 ✓）
 *   <目标>/.github/workflows/ticket-check.yml  CI 门禁（已有就不动 ✓）
 *
 * 口径：默认**不覆盖任何已有文件** ✓（= 单文件包的 --force 口径 ✓ 事故里最常见的就是"装一遍把票板覆盖了"✗）
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));       // <...>/tools
const SRC_ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const arg = (f, d = '') => { const i = argv.indexOf(f); return i < 0 ? d : String(argv[i + 1] || d); };
const FORCE = argv.includes('--force');
const DRY = argv.includes('--dry-run');
const NO_CI = argv.includes('--no-ci');
const TO = path.resolve(arg('--to') || process.cwd());

const say = (s) => console.log(s);
const plan = [];
const skipped = [];
const warn = [];

const ensureDir = (d) => { if (!DRY) mkdirSync(d, { recursive: true }); };

/** 拷一个文件：目标已存在且不是 --force ⇒ 跳过并记账（不覆盖 ✗） */
const put = (src, dst, label) => {
  if (!existsSync(src)) { skipped.push(label + '（源文件不存在）'); return; }
  const rel = path.relative(TO, dst).split(path.sep).join('/');
  if (existsSync(dst) && !FORCE) { skipped.push(rel + '（已存在，未覆盖）'); return; }
  plan.push(rel);
  if (DRY) return;
  mkdirSafe(path.dirname(dst));
  copyFileSync(src, dst);
};
const mkdirSafe = (d) => {
  try { mkdirSync(d, { recursive: true }); }
  catch (e) { warn.push('建目录失败 ' + d + '：' + ((e && e.code) || e)); throw e; }
};
/** 写一个新文件（同样默认不覆盖 ✓） */
const putText = (dst, text, label) => {
  const rel = path.relative(TO, dst).split(path.sep).join('/');
  if (existsSync(dst) && !FORCE) { skipped.push(rel + '（已存在，未覆盖）'); return; }
  plan.push(rel);
  if (DRY) return;
  mkdirSafe(path.dirname(dst));
  writeFileSync(dst, text, 'utf8');
};

// ── 0. 前置：别把自己装到自己头上 ───────────────────────────────────────
const sameTree = path.resolve(TO) === path.resolve(SRC_ROOT);
say('════ 开票工作流 · 一键安装 ════');
say('源：' + SRC_ROOT);
say('目标：' + TO + (sameTree ? '（就是当前仓库 ⇒ 只补缺的配置/CI，不重拷 tools ✓）' : ''));
say('模式：' + (DRY ? '**预演**（不写盘 ✓）' : '实际写入') + (FORCE ? ' ＋ --force 覆盖同名文件 ⚠' : '（默认不覆盖任何已有文件 ✓）'));
say('');

// ── 1. tools（含 lib 与全部自检）────────────────────────────────────────
if (!sameTree) {
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      put(p, path.join(TO, 'tools', path.relative(HERE, p)), 'tools');
    }
  };
  walk(HERE);
}

// ── 2. 配置（线名/阈值）：有样例就照着生成，但**不覆盖**已有配置 ────────
const cfgDst = path.join(TO, 'docs', '.ticketrc.json');
const cfgSrc = [path.join(TO, 'docs', '.ticketrc.json.example'), path.join(SRC_ROOT, 'docs', '.ticketrc.json.example')]
  .find((p) => existsSync(p));
if (existsSync(cfgDst)) {
  skipped.push('docs/.ticketrc.json（已存在，保留你现在的线名 ✓）');
} else if (cfgSrc) {
  put(cfgSrc, cfgDst, 'config');
} else {
  warn.push('没找到 docs/.ticketrc.json.example ⇒ 配置未生成（会用默认线名 ⇒ 记得手建 ✓）');
}

// ── 3. 空票板：只建**空白**的一张，绝不带别人的票 ──────────────────────
const boardDst = path.join(TO, 'docs', '待办.md');
putText(boardDst, [
  '# 待办（票板）',
  '',
  '> 唯一台账 ✓ 一张票 = 一件要有人做、要有人验收的事 ✓',
  '> 票头一行就是状态：`[ ]` 待办 ／ `[~]` 处理中 ／ `[v]` 待验收 ／ `[x]` 完成 ／ `[-]` 作废',
  '> 开第一张：`node tools/ticket-relay.mjs --from <线A> --to <线B> --title "…" --why "…" --accept "…" --write`',
  ''
].join('\n'), 'board');

// ── 4. CI 门禁：有就跳过，不覆盖别人的 workflow ────────────────────────
if (!NO_CI) {
  const wf = path.join(TO, '.github', 'workflows', 'ticket-check.yml');
  const srcWf = path.join(SRC_ROOT, '.github', 'workflows', 'ticket-check.yml');
  if (existsSync(wf)) skipped.push('.github/workflows/ticket-check.yml（已存在，未覆盖）');
  else if (existsSync(srcWf)) put(srcWf, wf, 'ci');
  else warn.push('源仓库没有 .github/workflows/ticket-check.yml ⇒ CI 未装（加 --no-ci 可静默跳过 ✓）');
}

// ── 5. 自检：装完立刻证明"工具没坏"，别等人第一次用才发现 ──────────────
const SUITES = ['ticket-check-selftest.mjs', 'ticket-reply-selftest.mjs', 'write-guard-selftest.mjs'];
const results = [];
if (!DRY) {
  for (const s of SUITES) {
    const p = path.join(TO, 'tools', s);
    if (!existsSync(p)) { results.push({ s, ok: null, why: '缺文件' }); continue; }
    try {
      const out = execFileSync(process.execPath, [p], { encoding: 'utf8', stdio: 'pipe' });
      results.push({ s, ok: true, tail: String(out).trim().split('\n').pop() });
    } catch (e) {
      // ★ 只回最后一行会**指错病例** ✗（实测：失败的是 53，最后一行却是 89 的 ✔）
      const lines = String(e.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const bad = lines.filter((l) => /^[✖✗]/.test(l) || l.includes('失败'));
      results.push({ s, ok: false, tail: (bad.length ? bad.slice(0, 3) : lines.slice(-3)).join(' ｜ ') || String(e.message) });
    }
  }
}

// ── 5.5 派活插件（**显式选择**才装 ✗）──────────────────────────────────
//   为什么默认不装：这 10 个工具是**按 profile** 挂的 ✗ 装进 desktop ⇒ 该 profile 的**每个会话**都有 ✗
//   docs/开票工作流-优化版 §2.6 的结论：想过干净日子就用独立 profile（如 workteam）或专用 preset ✓
//   这里只做"帮你把命令跑对"——装不装、装到哪，必须由人显式说 ✓
const WANT_DISPATCH = argv.includes('--with-dispatch');
const dispatchResult = { asked: WANT_DISPATCH, ok: null, detail: '' };
if (WANT_DISPATCH) {
  const prof = arg('--dispatch-profile', 'desktop');
  dispatchResult.profile = prof;
  const pkg = '@deepseek-ai/dsh-cross-session-approval';
  const ver = arg('--dispatch-version', '0.3.10');
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  const exe = process.env.DSH_EXE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
  const cli = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  // ★ 2026-11-02 修：cli.js **在 app.asar 里面** ⇒ existsSync 永远是 false ✗
  //   实际踩到：程序明明装了，却报"没找到桌面版程序"⇒ 改成检查 exe 与 app.asar 这两个**真实文件** ✓
  const asar = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar');
  if (!existsSync(home)) {
    dispatchResult.detail = '没找到 DSH_HOME（' + home + '）⇒ 这台机器没装 DSH 桌面版？派活插件跳过 ✓（纸和尺子照样能用 ✓）';
  } else if (!existsSync(exe) || !existsSync(asar)) {
    dispatchResult.detail = '找到了 DSH_HOME 但没找到桌面版程序（' + exe + '）⇒ 跳过 ✓\n'
      + '    可手动装：`dsh plugin --profile ' + prof + ' add ' + pkg + '@' + ver + '`（或设 DSH_EXE 环境变量再跑本命令 ✓）';
  } else if (DRY) {
    dispatchResult.detail = '（预演）会执行：' + pkg + '@' + ver + ' → profile `' + prof + '` ✓';
    dispatchResult.ok = true;
  } else {
    try {
      const out = execFileSync(exe, [cli, 'plugin', '--profile', prof, 'add', pkg + '@' + ver], {
        encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
      dispatchResult.ok = true;
      dispatchResult.detail = '已装进 profile `' + prof + '` ✓（输出尾部：' + String(out).trim().split('\n').slice(-2).join(' ｜ ') + '）';
    } catch (e) {
      dispatchResult.ok = false;
      dispatchResult.detail = '装失败（' + (e.status === undefined ? '异常' : 'exit ' + e.status) + '）：' + String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-3).join(' ｜ ');
    }
  }
}

// ── 6. 回执 ───────────────────────────────────────────────────────────
say('写入 ' + plan.length + ' 个文件' + (DRY ? '（预演，实际未写 ✗）' : '') + '：');
for (const p of plan) say('  ＋ ' + p);
if (skipped.length) {
  say('');
  say('跳过 ' + skipped.length + ' 项（默认不覆盖 ✓）：');
  for (const s of skipped) say('  · ' + s);
}
if (warn.length) {
  say('');
  say('⚠ 注意：');
  for (const w of warn) say('  · ' + w);
}
if (!DRY) {
  say('');
  say('自检：');
  for (const r of results) say('  ' + (r.ok === true ? '✓' : r.ok === false ? '✗' : '·') + ' ' + r.s + (r.tail ? ' — ' + r.tail : ''));
  if (results.some((r) => r.ok === false)) {
    say('');
    say('❌ **自检没过 ⇒ 这套工具在这个环境上跑不通** ✗ 先按上面的输出修，别急着用 ✗');
    process.exit(1);
  }
}
if (dispatchResult.asked) {
  say('');
  say('派活插件（--with-dispatch）：' + (dispatchResult.ok === true ? '✓ 已装' : dispatchResult.ok === false ? '✗ 失败' : '· 跳过'));
  say('  ' + dispatchResult.detail);
  if (dispatchResult.ok) {
    say('  ⚠ 这 10 个工具是**按 profile** 挂的：`' + (dispatchResult.profile || 'desktop') + '` 的**每个会话**都会有它们 ✗');
    say('  ⇒ 想隔离就用独立 profile 或专用 preset（docs/开票工作流-优化版 §2.6）✓ 装完必须**重启 DSH** ✗');
    say('  ⇒ 状态回执全靠票板：`**派活**：@线 时间` 写进票块 ✓ `--queue` 会列出"已派活未回票"✓');
  }
}
say('');
say('下一步（三件，别省 ✗）：');
say('  1. 改线名：' + path.join('docs', '.ticketrc.json') + '（默认线名是原作者项目的 ✓ 改完再开票 ✓）');
say('  2. 开第一张票：node tools/ticket-relay.mjs --from <线A> --to <线B> --title "…" --why "…" --accept "…" --write');
say('  3. 看板子：node tools/ticket-check.mjs --queue（谁该动）／ --loop（六问闭环）');
say('');
say('装上 DSH 侧的派活插件后，回票会自动归位；没装也能用，只是要人敲 ticket-reply ✓（见 docs/开票工作流-优化版 §2.6）');
