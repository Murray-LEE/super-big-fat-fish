#!/usr/bin/env node
/**
 * ticket-relay.mjs —— **把"传话"变成"一张票"** ✓
 *
 * 为什么要它（2026-10-27 · 主人反馈）：
 *   "会话间有时我传话后，就不互相开票了，系统效率反而降低"
 * 　⇒ 传话是**最省力**的通道 ✓ 开票要写八行 ✗ 人当然选省力的 ✓
 * 　⇒ 这个工具让"传话"和"开票"变成**同一个动作** ✓ 一句话就能开出一张合规票 ✓
 *
 * 用法：
 *   node tools/ticket-relay.mjs --from 调试 --to 卡片 --title "把 X 改成 Y"
 *   node tools/ticket-relay.mjs --from 调试 --to 卡片 --title "…" --why "主人 04:1x 传话" --accept "`node test/x.mjs` 全绿"
 *   node tools/ticket-relay.mjs … --write        # 真的写进票板（默认只预演 ✓）
 *   node tools/ticket-relay.mjs … --origin 主人原话   # ★ T-20261101-F02：授权强度 ⇒ explicit
 *   node tools/ticket-relay.mjs … --origin 自查       # ⇒ inferred（**缺省就是 inferred** ✗ 绝不默认 explicit ✗）
 *
 * 授权强度（§9.2h · 借 dsh-superagent 002-authorization）：
 *   explicit ＝ 项目负责人本人明确要求（能引原话）✓
 *   inferred ＝ 职务自己推断出来的活儿 ⇒ **动工前必须有主人确认** ✗ 票面补 `**授权**：主人已确认（YYYY-MM-DD HH:MM）` ✓
 *   none     ＝ 没人要的活儿 ⇒ 不许进活跃队列 ✗
 *
 * 规矩（照 §2.5）：
 *   · 有动作／有结论／要人验收 ⇒ **必须开票** ✓ 光回话 = 没办 ✗
 *   · 纯信息（不要求任何人做事）⇒ **不开票** ✓ 但回一句"只通知 ✓"
 *   · 已有票的补充 ⇒ 追加到那张票 ✓ 别另开 ✗
 *
 * 退出码：0 预演或写入完成 ✓ ／ 1 被拒（参数/票板状态）✗ ／ 2 参数或路径问题 ✗
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, copyFileSync, constants as FS } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintTickets, readTextSafe, checkNames, canonicalName, fieldOf, codeFor, loadConfig, setLineNames } from './lib/ticket-lint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
{
  const c = loadConfig(ROOT);
  if (!c.error && c.cfg && c.cfg.lines) setLineNames(c.cfg.lines);  // v1.10.26：名字表可由配置覆盖 ✓
}
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');

const die = (msg, hint) => {
  console.error('✗ ' + msg);
  if (hint) console.error('  ⇒ ' + hint);
  console.error('  ⇒ **什么都没做** ✗ 票板未改 ✓');
  process.exit(2);
};
const arg = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return '';
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) die(flag + ' 缺少取值（后面' + (v === undefined ? '没有东西' : '是另一个选项 ' + v) + '）', flag + ' <值> ✓ 或直接不写这个选项 ✓');
  return String(v);
};

const FROM = arg('--from');
const TO = arg('--to');
const TITLE = arg('--title');
// ★ v1.10.35（2026-10-29 现场：`MALFORMED_RESPONSE · tool input is invalid JSON`）
//   长中文 ＋ 引号 ＋ 反引号塞进工具参数 ⇒ 模型偶尔生成**非法 JSON** ✗ 整轮作废 ✗
//   修法：长文本**先写文件**再让工具读 ✓ 参数里只剩一个路径 ✓
const readOr = (fileArg, inline) => {
  if (!fileArg) return inline;
  const p = path.isAbsolute(fileArg) ? fileArg : path.join(ROOT, fileArg);
  const r = readTextSafe(p);
  if (!r || !r.ok) {
    console.error('✗ 读不到 ' + p + '（' + ((r && r.code) || 'ERR') + '）'
      + ' —— 参数里给了文件就按文件读 ✗ 不会退回内联 ✓');
    process.exit(2);
  }
  return String(r.text).trim();
};
const WHY = readOr(arg('--why-file'), arg('--why'));
const ACCEPT = readOr(arg('--accept-file'), arg('--accept'));
const FILE_ARG = arg('--file');
const argOfCode = () => arg('--code');   // v1.10.27：显式票号字母 ✓
// 备份目录可指定（给测试用 ✓ 生产默认 ROOT/.backups ✓ —— 别把测试备份留进生产目录 ✗）
const BAK_ARG = arg('--backup-dir');

if (!FROM) die('缺少 --from（谁开这张票）', '例：--from 调试 ✓');
if (!TO) die('缺少 --to（谁该去做）', '例：--to 卡片 ✓');
if (!TITLE) die('缺少 --title（这张票要干什么）', '例：--title "把 X 改成 Y" ✓');
if (FROM === TO) die('--from 与 --to 是同一条线', '一张票要"我做不了/不该我做"才开 ✓ 自己给自己开票没有验收方 ✗');

const FILE = FILE_ARG
  ? (path.isAbsolute(FILE_ARG) ? FILE_ARG : path.join(ROOT, FILE_ARG))
  : path.join(ROOT, 'docs', '待办.md');
if (!existsSync(FILE)) die('找不到票板文件：' + FILE, '该路径必须存在且是文件 ✓ 例：docs/待办.md');
if (!statSync(FILE).isFile()) die('票板路径不是文件：' + FILE, '要传文件路径，不是目录 ✗');
const READ = readTextSafe(FILE);
if (!READ.ok) die('读不动票板文件（' + READ.code + '）', '权限/编码问题 ✗ 不是票板内容问题 ✓');
const text = READ.text;

// ★ v1.10.21：线名先归一（别名→标准名 ✓ 代号/代指直接拒 ✗）
const fFrom = checkNames(FROM);
const fTo = checkNames(TO);
if (!fFrom.ok) die('--from 认不出：' + FROM + '（认不出的部分：' + fFrom.bad.join('、') + '）',
  '认得出：调试／卡片／线上发布／流程线／主人 及其别名与代号（D/C/P/F 会自动归一 ✓）／代指（我们、你们、对方、各领自己那条）不收 ✗');
if (!fTo.ok) die('--to 认不出：' + TO + '（认不出的部分：' + fTo.bad.join('、') + '）',
  '认得出：调试／卡片／线上发布／流程线／主人 及其别名与代号 ✓ 多条线用「／」分隔 ✓ 例：--to 调试／卡片 ✓ 代指（我们、你们、对方）不收 ✗');
const FROM_N = fFrom.canonical.join('／');
const TO_N = fTo.canonical.join('／');

// ── 票号：T-YYYYMMDD-<码><NN> ✓
// ★ v1.10.27（Q线）：码**也可以配** ✗ 以前只从硬编码五职务表取 ⇒ 配了自定义线名就 exit 2 ✗
//   取码：`--code` 显式指定 ✓ → 配置别名里的 1~2 位字母 ✓ → 内置五职务 ✓
const CODE_ARG = (argOfCode() || '').toUpperCase();
const code = CODE_ARG || codeFor(fFrom.canonical[0]);
if (!code || !/^[A-Z]{1,2}$/.test(code)) {
  die('认不出 --from 该用哪个票号字母：' + FROM,
    '三种办法任选 ✓ ① 显式给 `--code`（1~2 位字母 ✓ 例：--code Q）'
    + ' ② 在 `.ticketrc.json` 的 `lines` 里放一个短代号（例：{ "开票系统线": ["Q", "开票"] } ✓ 会自动取 Q）'
    + ' ③ 用内置职务（调试工程师／卡片工程师／发布工程师／流程管理员／项目负责人 ✓）');
}

const now = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const day = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());
const dayId = now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate());
const stamp = day + ' ' + p2(now.getHours()) + ':' + p2(now.getMinutes()) + ' UTC+8';

const LINT = lintTickets(text, {});
const sameDay = LINT.tickets.map((t) => t.id || '').filter((id) => id.startsWith('T-' + dayId + '-' + code));
let maxN = 0;
const idRe = new RegExp(code + '([0-9]+)$');
for (const id of sameDay) {
  const m = idRe.exec(id);
  if (m) maxN = Math.max(maxN, Number(m[1]));
}
const ID = 'T-' + dayId + '-' + code + p2(maxN + 1);

// ── 拼票块（照票板现有格式 ✓ 负责人/验收方 用加粗标签 ✓ 写具体人名 ✗ 不写代号）
/* ★ T-20261101-F02（借 dsh-superagent 的授权模型）：**建票时就写授权强度** ✗ 事后补 ✗
   `--origin 主人原话` ⇒ explicit ✓（负责人本人明确要求，能引原话）
   `--origin 自查／推断／inferred` ⇒ inferred ✓（职务自己推断出来的活儿 ⇒ 动工前要主人确认 ✗）
   **缺省 ⇒ inferred** ✗ 绝不默认 explicit ✗（默认"有授权"是最坏的默认 ✗） */
const ORIGIN = String(arg('--origin') || '').trim();
const AUTHZ = (() => {
  const o = ORIGIN.toLowerCase();
  if (!o) return 'inferred';
  if (/主人|原话|explicit|明确要求|用户/.test(o)) return 'explicit';
  if (/自查|推断|inferred|顺手|笔记|发现/.test(o)) return 'inferred';
  if (/无|none|没人要/.test(o)) return 'none';
  return 'inferred';
})();
const block = [
  '## [ ] [' + FROM_N + '→' + TO_N + '] ' + TITLE + '（' + stamp + '）',
  '',
  '**票号**：' + ID,
  '**负责人**：' + TO_N + '｜**验收方**：' + FROM_N,
  '**授权强度**：' + AUTHZ + (ORIGIN ? '（来源：' + ORIGIN + '）' : '（缺省 inferred ✗ 来源没写 ⇒ 先当"自己推断的"✓）'),
  '**阻塞**：无',
  '',
  '**来由**：' + (WHY || '主人传话 ⇒ 按 §2.5「传话即开票」转成票 ✓（光回话＝没办 ✗）'),
  '',
  '**验收方式**：' + (ACCEPT || '（待补：写清怎么验 —— 命令／阈值／证据在哪 ✓ 别写"已修好"✗）'),
  ''
].join('\n');

// ── 混行尾拒写（同 ticket-reply 的保护 ✓）
const crlf = (text.match(/\r\n/g) || []).length;
const lf = (text.match(/(?<!\r)\n/g) || []).length;
const eol = crlf > 0 && lf > 0 ? 'mixed' : (crlf > 0 ? 'crlf' : 'lf');
if (WRITE && eol === 'mixed') die('票板混用 CRLF/LF', '先统一行尾再写 ✓（不统一会把行写坏 ✗）');

// 块与块之间留**一个空行** ✓ 否则下一个 `##` 会紧贴上一张票的正文 ✗
const head = text.endsWith('\n\n') ? text : (text.endsWith('\n') ? text + '\n' : text + '\n\n');
const body = block.replace(/\n/g, eol === 'crlf' ? '\r\n' : '\n');
const next = head + body + (eol === 'crlf' ? '\r\n' : '\n');

// ── 写完必须能被 lint 接受（不然就是造了一张坏票 ✗）
const probe = lintTickets(next, {});
const before = new Set(LINT.problems.map((p) => p.kind + '@' + p.ticketLine));
const added = probe.problems.filter((p) => !before.has(p.kind + '@' + p.ticketLine));
const mine = added.filter((p) => p.ticketLine === head.split('\n').length - 1 + 1);
if (mine.length) {
  console.error('✗ 这张票写进去会**自带问题** ⇒ 不写 ✗');
  for (const p of mine) console.error('  · [' + p.kind + '] ' + p.detail);
  console.error('  ⇒ 改完参数再来 ✓（票板未改 ✓）');
  process.exit(1);
}

if (!WRITE) {
  console.log('════ 传话 → 开票（**预演** ✗ 不写盘 ✓）════');
  console.log('票板：' + path.relative(ROOT, FILE) + '｜开票线：' + FROM_N + '（' + code + '）');
  console.log('');
  console.log(block);
  console.log('—— 确认无误后，加 `--write` 真的写进去（会先备份 ✓）——');
  console.log('写完后请让对方**回票**（`> ✅ **【时分 · 线】** 回「' + TITLE.slice(0, 12) + '…」（' + ID + '）`）✗ 光回话＝没办 ✗');
  process.exit(0);
}

// ── 落盘：先备份（排他创建）→ 写前重读 → 写入
const bakDir = BAK_ARG ? (path.isAbsolute(BAK_ARG) ? BAK_ARG : path.join(ROOT, BAK_ARG)) : path.join(ROOT, '.backups');
mkdirSync(bakDir, { recursive: true });
const bak = path.join(bakDir, 'relay-' + now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()) + '-' + p2(now.getHours()) + p2(now.getMinutes()) + p2(now.getSeconds()) + '.md');
copyFileSync(FILE, bak, FS.COPYFILE_EXCL);
const recheck = readFileSync(FILE, 'utf8');
if (recheck !== text) {
  console.error('✗ 写前重读发现票板已被别人改过 ⇒ 不写 ✗（并发保护 ✓）');
  console.error('  ⇒ 重新跑一次这条命令 ✓ 备份在 ' + path.relative(ROOT, bak) + ' 未用 ✓');
  process.exit(1);
}
writeFileSync(FILE, next);
console.log('════ 传话 → 开票（**已写入** ⚠）════');
console.log('  ✓ ' + ID + '  ' + FROM_N + ' → ' + TO_N + '｜' + TITLE);
console.log('  ✓ 备份：' + path.relative(ROOT, bak));
console.log('  ✓ 写完自检：这张票没有引入新问题 ✓');
console.log('');
console.log('下一步（别省 ✗）：');
console.log('  1. 让对方回票：`> ✅ **【时分 · 线】** 回「' + TITLE.slice(0, 14) + '…」（' + ID + '）`');
console.log('  2. 自己看一眼：node tools/ticket-check.mjs --queue   ← 该谁动写得清清楚楚 ✓');
console.log('  3. 回滚（万一）：把 ' + path.relative(ROOT, bak) + ' 整份复制回 ' + path.relative(ROOT, FILE) + ' ✓');
