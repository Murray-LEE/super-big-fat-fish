#!/usr/bin/env node
/**
 * tools/setup-plugins.mjs —— 部署引导：把「派活」所需的东西装齐（或告诉你怎么装）
 *
 * 为什么需要它：
 *   票板工具（本仓库）只是"纸和尺子" ✓ 真正把任务**派给另一个会话**靠的是 DSH 插件
 *   `dsh-cross-session-approval`（提供 cross_session_spawn / send / reply / list 等工具）
 *   而它不在仓库里、也不走 npm 全局安装，而是**按 profile 挂在 DSH 的某个 profile 下** ✗
 *   ⇒ 新机器上光 clone 仓库，是派不出去的 ✗ 这个脚本负责"查清楚 + 给一条可复制的路"
 *
 * 用法：
 *   node tools/setup-plugins.mjs                 # 体检 + 打印该做什么（默认不改机器）
 *   node tools/setup-plugins.mjs --json          # 机器可读
 *   node tools/setup-plugins.mjs --run           # 真的去装（调用 DSH 的 plugin 命令）
 *   node tools/setup-plugins.mjs --run --profile workteam --version 0.3.10
 *   node tools/setup-plugins.mjs --check         # 只判断"装没装"，装了就 exit 0
 *
 * 退出码：
 *   0 = 齐了（或已装）
 *   2 = 缺东西（照打印的步骤做）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { W } from './lib/theme.mjs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);

const PKG = arg('--pkg', 'dsh-cross-session-approval');
const VER = arg('--version', '0.3.10');
const PROFILE = arg('--profile', 'cs-team');
const RUN = flag('--run');
const JSONOUT = flag('--json');
const CHECK = flag('--check');

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CANDIDATES = [
  process.env.DSH_EXE,
  path.join(os.homedir(), 'AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'),
  'D:/DeepSeek Harness/DeepSeek Harness.exe',
  '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  '/opt/DeepSeek Harness/deepseek-harness',
].filter(Boolean);

const exe = CANDIDATES.find(p => existsSync(p)) || '';
const asar = exe ? path.join(path.dirname(exe), 'resources', 'app.asar') : '';

/* ── profile 里有没有装过 ── */
function findInstalled() {
  const dir = path.join(HOME, 'profiles');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const p of readdirSync(dir)) {
    const nm = path.join(dir, p, 'node_modules', PKG, 'package.json');
    if (existsSync(nm)) {
      try {
        const j = JSON.parse(readFileSync(nm, 'utf8'));
        out.push({ profile: p, version: j.version || '?', path: nm });
      } catch { out.push({ profile: p, version: '?', path: nm }); }
    }
  }
  return out;
}

const installed = findInstalled();
const nodeOk = Number(process.versions.node.split('.')[0]) >= 18;

const report = {
  schemaVersion: 1,
  env: {
    node: process.versions.node,
    nodeOk,
    platform: process.platform,
    dshHome: HOME,
    dshHomeOk: existsSync(HOME),
    dshExe: exe || null,
    dshAsarOk: asar ? existsSync(asar) : false,
  },
  plugin: { name: PKG, want: VER, profile: PROFILE, installed },
  ready: false,
  steps: [],
};

const need = [];
if (!nodeOk) need.push('升级 Node 到 ≥ 18（本仓库与自检都要求）');
if (!existsSync(HOME)) need.push(`没找到 DSH 数据目录 ${HOME}（这台机器没装 DSH 桌面版？）`);
if (!exe && existsSync(HOME)) need.push('找到了 DSH 数据目录，但没定位到 DSH 可执行文件（可用 DSH_EXE 环境变量指定）');
if (!installed.some(x => x.profile === PROFILE && x.version === VER)) {
  need.push(`profile «${PROFILE}» 里没有 ${PKG}@${VER}`
    + (installed.length ? `（其它 profile 有：${installed.map(i => i.profile + '@' + i.version).join('、')}；可加 --profile 指过去）` : ''));
}

report.ready = need.length === 0;

/* ── 该怎么做（按检测结果给具体命令） ── */
const steps = [];
steps.push('① 确认 Node ≥ 18：`node -v`（当前 ' + process.versions.node + (nodeOk ? ' ✓' : ' ✗') + '）');
steps.push('② 确认装了 DSH 桌面版并启动过一次（会生成 ' + HOME + '）' + (existsSync(HOME) ? ' ✓' : ' ✗'));
if (installed.length) {
  steps.push('③ 已装 profile：' + installed.map(x => `${x.profile}@${x.version}`).join('、') + ' ✓');
} else {
  steps.push('③ 还没有任何 profile 装过它 ⇒ 跑下面这条（把 <profile> 换成你要用的，如 desktop 或 cs-team）：');
  steps.push('   dsh plugin --profile ' + PROFILE + ' add ' + PKG + (VER ? '@' + VER : ''));
  if (exe) {
    steps.push('   这台机器上等价于：');
    steps.push('   "' + exe + '" "' + path.join(path.dirname(exe), 'resources', 'app.asar') + '" plugin --profile ' + PROFILE + ' add ' + PKG + '@' + VER);
  }
}
steps.push('④ 装完验一下：`node tools/setup-plugins.mjs --check`（齐了 exit 0）');
steps.push('⑤ 然后跑 `node tools/ticket-dispatch.mjs` 看板；派活用 DSH 会话里的 cross_session_send ✓');
report.steps = steps;

if (JSONOUT) {
  console.log(JSON.stringify(report, null, 1));
  process.exit(report.ready ? 0 : 2);
}

if (CHECK) {
  if (report.ready) { console.log(`✓ 齐了：${PKG}@${VER} 已在 profile «${PROFILE}» ✓`); process.exit(0); }
  console.log('✗ 还没齐：'); need.forEach(n => console.log('  · ' + n));
  process.exit(2);
}

console.log('═══ 派活环境体检（' + W.agent + ' 的水质检测） ═══');
console.log(`Node            ${process.versions.node} ${nodeOk ? '✓' : '✗（要求 ≥18）'}`);
console.log(`DSH 数据目录     ${HOME} ${existsSync(HOME) ? '✓' : '✗'}`);
console.log(`DSH 程序         ${exe || '（没定位到，可设 DSH_EXE）'} ${exe ? '✓' : '✗'}`);
console.log(`已装 profile     ${installed.length ? installed.map(x => x.profile + '@' + x.version).join('、') : '（无）'}`);
console.log(`目标             ${PKG}@${VER} → profile «${PROFILE}»`);

console.log('\n═══ 该做什么（照做就能下水） ═══');
steps.forEach(s => console.log(' ' + s));

if (!RUN) {
  console.log('\n（默认只看不装 ✓ 确认无误后加 --run 让它执行第 ③ 步）');
  process.exit(report.ready ? 0 : 2);
}

/* ── --run：真的装 ── */
if (report.ready) { console.log('\n已经齐了，不需要装 ✓'); process.exit(0); }
if (!nodeOk) { console.error('\n✗ Node 版本不够，先升级再 --run'); process.exit(2); }
if (!exe || !existsSync(asar)) {
  console.error('\n✗ 没定位到 DSH 程序，没法自动装。请按上面第 ③ 步手动执行 ✓');
  process.exit(2);
}

const cli = path.join(path.dirname(exe), 'resources', 'app.asar');
console.log(`\n执行：dsh plugin --profile ${PROFILE} add ${PKG}@${VER}`);
try {
  const out = execFileSync(exe, [cli, 'plugin', '--profile', PROFILE, 'add', `${PKG}@${VER}`], {
    encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 180000,
  });
  console.log((out || '').trim().split('\n').slice(-6).join('\n') || '（无输出）');
} catch (e) {
  console.error('✗ 装失败：' + (e.status === undefined ? String(e.message) : 'exit ' + e.status));
  if (e.stdout) console.error(String(e.stdout).trim().split('\n').slice(-6).join('\n'));
  if (e.stderr) console.error(String(e.stderr).trim().split('\n').slice(-6).join('\n'));
  console.error('\n可手动执行：`dsh plugin --profile ' + PROFILE + ' add ' + PKG + '@' + VER + '`');
  process.exit(2);
}

const after = findInstalled();
const ok = after.some(x => x.version === VER);
console.log(ok
  ? `\n✓ 装好了：${after.map(x => x.profile + '@' + x.version).join('、')}\n  接着：node tools/setup-plugins.mjs --check ✓`
  : '\n⚠ 命令跑完了但没在 profile 里找到它，请用 `dsh plugin --profile ' + PROFILE + ' list` 确认 ✓');
process.exit(ok ? 0 : 2);
