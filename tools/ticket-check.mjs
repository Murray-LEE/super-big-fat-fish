/**
 * tools/ticket-check.mjs —— 票板**只读**自检 CLI（逻辑全在 tools/lib/ticket-lint.mjs ✓ 可单测 ✓）
 *
 * 用法：
 *   node tools\ticket-check.mjs                      汇总
 *   node tools\ticket-check.mjs --list               逐条列出
 *   node tools\ticket-check.mjs --file docs\待办.md
 *   node tools\ticket-check.mjs --trial              试行统计（§16，v1.3 口径）
 *   node tools\ticket-check.mjs --trial --since 2026-10-25
 *   node tools\ticket-check.mjs --with-handoff       交叉核对**交接里的票号指针**（悬空 ⇒ 报 ✗）
 *   node tools\ticket-check.mjs --with-handoff --handoff docs\交接.md
 *
 * v1.4（2026-10-25 夜 · 流程线）：
 *   ⑥ 新增可选 `--with-handoff`：交接只写指针 ⇒ **指针必须能落到票** ✓
 *      落到票板 → 正常 ✓｜落到归档 → 也正常 ✓（归档不是丢票 ✗）｜两处都没有 → **悬空指针** ✗
 *      口径：代码块里的票号不算 ✗；能定位**不等于**内容对 ✗；只报告 ✗ 不改文件 ✓
 *
 * v1.3（吸收 GPT《反馈复核》6 个反例）：
 *   ① 票号只在本票块内读声明（不跨票窗口 ✗）
 *   ② 回票点名只认**回票记录**（`> ✅ …` 行）✓ 票头声明不算 ✗
 *   ③ 代码块/模板说明不参与判定 ✗（示例里的 ✅、"证据标签可选…"都不算）
 *   ④ 试行分母 = **有回票记录的票**；"0 次使用"只**触发复核** ✓ 不写"可以砍"
 *   ⑤ 日期以**票号里的日期**为准 ✓ 与票头冲突会提示
 *
 * v1.8（2026-10-26 · 五线第三份反馈）：
 *   ⑥ **真问题 / 历史债 分开数** ✓（历史债 = 无票号 ＋ 票头早于 debtSince；任一不成立算真问题 ✓）
 *      `--list` 默认只列真问题 ✓ `--list --all` 连历史债一起列 ✓ —— "有没有新增问题"重新可读 ✓
 *   ⑦ `--json`：给下游的**稳定契约**（schemaVersion 1 ✓ 字段只加不改名 ✓）不再逼别人 import 内部函数 ✗
 *   ⑧ `--trial` 每条指标**标清自己的分母** ✓（认领=全部带号票 ／ 引用与标签=有回票的票 ✗ 同一屏两个分母必被读错 ✗）
 *   ⑨ 新增问题类「票号只在标题」✓（标题里有号、块内没声明 ✗ 否则交接核对会误指"票不存在"✗）
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintTickets, lintHandoffPointers, buildReport, snapshotOf, queueOf, closedLoop, impersonatedOf, readTextSafe, loadConfig, tsOk, setLineNames, STATE } from './lib/ticket-lint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const LIST = argv.includes('--list');
const TRIAL = argv.includes('--trial');
const WITH_HANDOFF = argv.includes('--with-handoff');
const fi = argv.indexOf('--file');
const si = argv.indexOf('--since');
const hi = argv.indexOf('--handoff');
const di = argv.indexOf('--debt-since');

/**
 * v1.9（五线反馈 §1）：**项目级配置** —— "制度生效时刻"只该有一处 ✓
 * v1.10.19（GPT R01）：加载器搬到库里 ✓ 且**读不了 ⇒ 由调用方 exit 2** ✗ 不再静默回退默认值 ✗
 */
const CFG = loadConfig(ROOT);
const cget = (k) => (CFG.cfg && CFG.cfg[k] != null ? String(CFG.cfg[k]) : '');
// ★ v1.10.26（Q线 §三.1）：名字表可由配置覆盖 ✓ 别把线名写死 ✗
if (CFG.cfg && CFG.cfg.lines) setLineNames(CFG.cfg.lines);
if (CFG.error) {
  console.error('✗ 配置文件读不了：' + CFG.source + '：' + CFG.error);
  console.error('  ⇒ 期望：合法 JSON（`docs/.ticketrc.json` 或 `package.json` 的 `ticket` 段）✓ 例见 `.ticketrc.json.example`');
  console.error('  ⇒ **什么都没做** ✗ 不改文件 ✓ 修好再来 ✓（**不会**悄悄按默认值继续跑 ✗ 否则口径早变了你还以为没变 ✗）');
  process.exit(2);
}

/**
 * ★ v1.10.19（GPT R03）：**"没写这个选项"≠"写了但没值"** ✗
 *   以前 `--since` 后面没东西 ⇒ 静默取默认值 ⇒ 明确写出的意图被吞掉 ✗
 */
const needValue = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return '';
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) {
    console.error('✗ ' + flag + ' 缺少取值' + (v === undefined ? '（后面没有东西）' : '（后面是另一个选项 ' + v + '）'));
    console.error('  ⇒ 期望：' + flag + ' <值> ✓ 例：' + flag + ' 2026-10-25T21:40（或直接不写这个选项 ✓）');
    console.error('  ⇒ **什么都没做** ✗ 不改文件 ✓');
    process.exit(2);
  }
  return String(v);
};
needValue('--file');
needValue('--handoff');
needValue('--since');
needValue('--debt-since');

// ★ v1.10.7：`--file` 支持**绝对路径** ✗（原来 path.join(ROOT, 绝对路径) 会拼成怪路径 ⇒ ENOENT ✗）
const asPath = (p) => (path.isAbsolute(String(p || '')) ? String(p) : path.join(ROOT, String(p || '')));
const FILE = fi >= 0 ? asPath(argv[fi + 1] || '') : asPath(cget('board') || 'docs/待办.md');
const SINCE = si >= 0 ? String(argv[si + 1] || '2026-10-25') : (cget('since') || '2026-10-25');
const DEBT_SINCE = di >= 0 ? String(argv[di + 1] || '2026-10-25') : (cget('debtSince') || '2026-10-25');
const HANDOFF = hi >= 0 ? asPath(argv[hi + 1] || '') : asPath(cget('handoff') || 'docs/交接.md');

// ★ v1.10.11（五线反馈"缺陷 1"）：**非法时刻必须报错退出** ✗
//   之前 `--debt-since 不是日期` 照单全收 ⇒ fail-closed 把老票判成真问题 ✗ 配置行还打了个 ✓ ✗
//   ⇒ 报错方向反了：三条线各跑一遍都得到"真问题 2"，然后有人去修本不该修的旧账 ✗
// v1.10.19（GPT R04）：校验器搬到库里（含**日历**校验 ✓ `2026-02-30` 不再放过 ✗）
for (const [name, val, fromCfg] of [
  ['--since', SINCE, si < 0 && !!cget('since')],
  ['--debt-since', DEBT_SINCE, di < 0 && !!cget('debtSince')]
]) {
  if (tsOk(val)) continue;
  console.error('✗ ' + name + ' 无法解析成时刻：' + JSON.stringify(val) + '（' + (fromCfg ? '来自配置文件' : '来自命令行') + '）');
  console.error('  ⇒ 期望 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:MM` ✓ 例：2026-10-25T21:40');
  console.error('  ⇒ **什么都没做** ✗ 不改文件 ✓ 修好再来 ✓（别让一个坏常量把老票判成"真问题"✗）');
  process.exit(2);
}

const FILE_REL = path.relative(ROOT, FILE).split(path.sep).join('/');
const IS_ARCHIVE = /(^|\/)待办-归档-[^/]*\.md$/.test(FILE_REL);

// ★ v1.10.13（五线"文案瑕疵"）：**报错给的例子必须指对方向** ✗
//   之前交接文件报错却举例 `docs/待办.md` ⇒ 人照着建了个票板文件，继续报错 ✗
const die = (what, who, why, example) => {
  console.error('✗ ' + what + '：' + why + '（' + who + '）');
  console.error('  ⇒ 期望：该路径**存在且是文件** ✓ 例：' + example);
  console.error('  ⇒ **什么都没做** ✗ 不改文件 ✓ 修好路径再来 ✓');
  process.exit(2);
};
if (!existsSync(FILE)) {
  die('找不到票板文件', (fi >= 0 ? '来自命令行 --file' : (cget('board') ? '来自配置文件 board' : '默认路径')), FILE_REL, 'docs/待办.md');
}
try { if (!statSync(FILE).isFile()) die('票板路径不是文件', '来自命令行或配置', FILE_REL, 'docs/待办.md'); } catch { /* statSync 抛错下面 read 会兜 */ }
// ★ v1.10.19（GPT R02）：交接文件也要"存在、是文件、读得动" ✗ 以前只验存在 ⇒ 目录会裸栈 EISDIR ✗
if (existsSync(HANDOFF)) {
  const hrel = path.relative(ROOT, HANDOFF).split(path.sep).join('/');
  try { if (!statSync(HANDOFF).isFile()) die('交接路径不是文件', '来自命令行 --handoff 或配置', hrel, 'docs/交接.md'); }
  catch { /* 下面读不到会兜 */ }
  const hr = readTextSafe(HANDOFF);
  if (!hr.ok) {
    const why = hr.code === 'EACCES' || hr.code === 'EPERM' ? '没有读权限（权限问题 ✗）' : '读不动（' + hr.code + '）';
    die('读不动交接文件', '来自命令行 --handoff 或配置', hrel + '：' + why, 'docs/交接.md');
  }
} else if (hi >= 0) {
  die('找不到交接文件', '来自命令行 --handoff', path.relative(ROOT, HANDOFF).split(path.sep).join('/'), 'docs/交接.md');
}

// ★ v1.10.18（五线·宿主线）：**读不动也要说人话** ✗ 权限问题不许伪装成"有真问题"✗
const READ = readTextSafe(FILE);
if (!READ.ok) {
  const why = READ.code === 'EACCES' || READ.code === 'EPERM'
    ? '文件存在但**没有读权限**（权限问题 ✗ 不是票板问题 ✗）'
    : '文件存在但**读不动**（' + READ.code + '）';
  die('读不动票板文件', (fi >= 0 ? '来自命令行 --file' : (cget('board') ? '来自配置文件 board' : '默认路径')), FILE_REL + '：' + why, 'docs/待办.md');
}
const text = READ.text;
const LINT = lintTickets(text, { since: SINCE, debtSince: DEBT_SINCE });
const { tickets, problems, realProblems, debtProblems, unknownProblems, knownRealProblems, cnt, trial, debtSince } = LINT;
const QUEUE = argv.includes('--queue');
// ★ v1.10.28／29（主人）：**闭环六问** 一屏看完 ✓ 只读 ✓ 恒 exit 0 ✓（要门禁用 --strict ✗）
//   v1.10.30：把标题里的"五问"改成"六问" ✗ —— 加了第 ⑥ 问却没改字 ✓ 这种不一致自己看很刺眼 ✓
const LOOP = argv.includes('--loop');
// ★ v1.10.12（五线"新发现 2"）：退出码语义 ✗ 以前只有 0／2，真问题再多也是 0 ✗ 自动化没法 gate ✗
//   `--strict`：有真问题 ⇒ exit 1 ✓（0＝没问题 ／ 1＝strict 检出真问题 ／ 2＝参数或配置非法）
const STRICT = argv.includes('--strict');
// ★ v1.10.14（五线·宿主线现场）：**--strict 被提前 exit(0) 吞掉** ✗
//   原来 --queue／--json 分支无条件 exit(0) ⇒ 永远走不到文件末尾的 STRICT 判断 ✗
//   形状最坏：**跑得通、输出对、退出码错** ✗ 用 --strict --json 做门禁 = 门一直开着 ✗
// ★ v1.10.23（T-20261027-D13 调试工程师提的）：**"还剩几件真问题"必须能说成确定的数** ✗
//   `unknown`（无票号又判不了年代）既算 real（fail-closed）又没法说"是不是新增" ⇒ 单报一个 31 就是错的 ✗
//   `--assume-debt`：把 unknown **按历史债口径看** ✓ 只影响"分组显示 + --strict 门禁" ✓
//   **不改原始判定** ✗ JSON 里 `unknown` 照旧、另加 `assumedDebt: true` ✓ 首屏必须喊出来 ✗
const ASSUME_DEBT = argv.includes('--assume-debt');
const gateProblems = () => (ASSUME_DEBT ? realProblems.filter((p) => !p.unknown) : realProblems);
const STRICT_FAILS = () => STRICT && gateProblems().length > 0;
/** 唯一出口 ✓ 所有退出都过这里，STRICT 才能盖住每个分支 ✓ */
const finish = (code) => {
  if (STRICT_FAILS()) {
    console.error('✗ --strict：**真问题 ' + gateProblems().length + ' 条**'
      + (ASSUME_DEBT ? '（`--assume-debt`：unknown 不计入 ✓）' : '')
      + ' ⇒ exit 1 ✓（只读 ✓ 未改任何文件 ✓）');
    process.exit(1);
  }
  process.exit(code);
};
const JSONOUT = argv.includes('--json');
const ALL = argv.includes('--all');
const byKind = (list) => { const m = {}; for (const p of list) m[p.kind] = (m[p.kind] || 0) + 1; return m; };
/** 取数时刻（本地时区 ✓ 别用 toISOString ✗ 那会差 8 小时 ✗）*/
const stampNow = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  // ★ v1.10.11（五线 §八.2）：带**毫秒** ✗ 同分钟不同秒的读数靠它才对得上 ✓（毫秒不等于并发安全 ✓）
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0') + ' UTC+8';
};
const SNAP = snapshotOf(text, stampNow());

if (LOOP) {
  const loopCfg = (CFG.cfg && CFG.cfg.loop) || {};
  const R = closedLoop(tickets, { replyHours: loopCfg.replyHours, acceptHours: loopCfg.acceptHours });
  const sec = (title, rows, hint) => {
    console.log('');
    console.log('【' + title + '】' + rows.length + ' 件未闭环');
    if (!rows.length) { if (argv.includes('--verbose')) console.log('  （空 ✓）'); return; }   // ★ v1.10.37：健康不占屏（借 dsh-superagent 那条『A healthy state takes no space』）
    const NL = String.fromCharCode(10);
    for (const r of rows) console.log('  L' + String(r.line).padEnd(5) + '[' + r.state + '] ' + r.id + '  ' + r.title + NL + '         → ' + r.why);
    if (hint) console.log('  ⇒ ' + hint);
  };
  console.log('════ 闭环六问（只读 ✓ 不改票板 ✗ 恒 exit 0 ✓）════');
  console.log('文件：' + FILE_REL + '｜活跃票 ' + tickets.filter(t => [' ', '~', 'v'].includes(t.state)).length + ' 张'
    + '｜阈值：回票 ' + R.hours.replyHours + 'h ／ 验收 ' + R.hours.acceptHours + 'h（配置 docs/.ticketrc.json 的 loop 段可改 ✓）');
  const J = tickets.map((t) => ({ t, v: impersonatedOf(t) })).filter((x) => x.v.impersonated);
  const impRows = J.map((x) => ({ line: x.t.line, state: x.t.state, id: x.t.id || '(无票号)', title: (x.t.title || '').slice(0, 40), why: '代回：' + x.v.signer + ' 签的，本票负责人/验收方是 ' + x.v.allowed.filter((n) => n !== '项目负责人').join('／') + ' ⇒ 需本人确认 ✓ 代回不算闭环 ✗' }));
  const total0 = R.reply.length + R.landed.length + R.accounted.length + R.answered.length + R.closed.length + R.distributed.length + impRows.length + (R.authz ? R.authz.length : 0);
  const VERBOSE = argv.includes('--verbose');
  if (total0 === 0 && !VERBOSE) { console.log('✅ 六问全闭环 ＋ 无代回 ✓（健康不占屏 ✓ 加 --loop --verbose 才逐段展开 ✗）'); finish(0); }
  sec('① 事事有回应', R.reply, '有人问了、有人该做，但**没人回票** ✗');
  sec('② 件件有着落', R.landed, '负责人／验收方必须写职务 ✓ 写代号或代指等于没着落 ✗');
  sec('③ 凡事有交代', [...R.accounted, ...impRows], '[x] 完成却没有点名本票的回票 ⇒ 谁做的、怎么验的都不见了 ✗');
  sec('④ 句句有回答', R.answered, '票面里有疑问却没回票 ⇒ 提问悬空 ✗');
  sec('⑤ 沟通有闭环', R.closed, '[v] 堆着不关 ⇒ 对方永远在等 ✗');
  sec('⑥ 升级必分发', R.distributed, '每次升级都要**开一张分发票**（标题含版本号）＋ 各线回票 ✗ 未回记"未签收"✓ 这条是主人 2026-10-27 定的 ✓');
  if (R.authz && R.authz.length) sec('⑦ 授权待补', R.authz, '[ ] ＋ inferred 放超 24h 还没确认 ⇒ 补 **授权** 或作废 ✗（T-20261101-F05）');

  console.log('');
  console.log(total0 ? '⚠ **共 ' + total0 + ' 件未闭环** ⇒ 上面每件都写了"谁、卡在哪"✓ 关门方式：回票／补职务／补证据／关票 ✗'
    : '✅ 六问全闭环 ✓（这不证明内容对 ✗ 只证明**没有悬着的**✓）');
  finish(0);
}

if (QUEUE) {
  const q = queueOf(tickets);
  console.log('════ 两个队列 · 谁该去执行（只读 ✓）════');
  console.log('文件：' + path.relative(ROOT, FILE));
  console.log('');
  console.log('【待处理 ' + q.open.length + ' 张】**该动的是「负责人」**');
  if (!q.open.length) console.log('  （空 ✓ 没有等你处理的票 ✓）');
  for (const r of q.open) {
    console.log('  L' + String(r.line).padEnd(5) + '[' + r.route + '] ' + r.title.slice(0, 46));
    console.log('         → **' + (r.owner || '（没写负责人 ✗ 老票不回填 ✗ 新票请补）') + '** 该动' + (r.acceptor ? '｜验收方 ' + r.acceptor : '') + (r.id ? '｜' + r.id : '') + (r.ownerIsCode ? '  ⚠ **写的是代号** ✗ 请写具体责任人 ✓' : '')
      + (r.multi ? (String.fromCharCode(10) + '         多负责人：**已回** ' + (r.repliedOwners.join('／') || '（还没有）')
          + '｜**待回** ' + (r.pendingOwners.join('／') || '（全回了 ✓）')) : ''));
  }
  console.log('');
  console.log('【待验收 ' + q.accept.length + ' 张】**该动的是「验收方」**');
  if (!q.accept.length) console.log('  （空 ✓ 没有等你验收的票 ✓）');
  for (const r of q.accept) {
    console.log('  L' + String(r.line).padEnd(5) + '[' + r.route + '] ' + r.title.slice(0, 46));
    console.log('         → **' + (r.acceptor || '（没写验收方 ✗ 老票不回填 ✗ 新票请补）') + '** 该验收' + (r.owner ? '｜负责人 ' + r.owner : '') + (r.id ? '｜' + r.id : '') + (r.acceptorIsCode ? '  ⚠ **写的是代号** ✗ 请写具体责任人 ✓' : '')
      + (r.multi ? (String.fromCharCode(10) + '         多负责人：**已回** ' + (r.repliedOwners.join('／') || '（还没有）')
          + '｜**待回** ' + (r.pendingOwners.join('／') || '（全回了 ✓）')) : ''));
  }
  if (q.missing.length) console.log('');
  if (q.missing.length) console.log('⚠ 待处理里 **' + q.missing.length + ' 张没写负责人** ✗ 没人知道该谁动 ✓ 新票请补 `负责人：X｜验收方：Y` ✓ 老票不回填 ✗');
  if (q.missingAcceptor.length) console.log('⚠ 待验收里 **' + q.missingAcceptor.length + ' 张没写验收方** ✗ 回票了但没人知道该谁验 ✓');
  console.log('');
  console.log('注：这只是"谁该动"的清单 ✓ 不代表做没做对 ✗');
  finish(0);
}

if (JSONOUT) {
  // JSON 模式给下游 → 不打印人话 ✓ 但 handoff 仍按开关收集 ✓
  let h = null;
  if (WITH_HANDOFF && existsSync(HANDOFF)) {
    const sources = [{ name: '票板', text }];
    try { for (const f of readdirSync(path.join(ROOT, 'docs')).filter(f => /^待办-归档-.*\.md$/.test(f)).sort()) sources.push({ name: '归档 ' + f, text: readFileSync(path.join(ROOT, 'docs', f), 'utf8') }); } catch { /* 没有归档目录也能跑 */ }
    const r = lintHandoffPointers((readTextSafe(HANDOFF).text || ''), sources);
    h = { file: path.relative(ROOT, HANDOFF).split(path.sep).join('/'), refs: r.refs, unique: r.ids.length, examples: r.examples, dangling: r.dangling.map(d => d.id) };
  }
  console.log(JSON.stringify(buildReport(
    LINT,   // ★ v1.10.7（GPT N01/N11）：**必须把完整结果交进去** ✗ 重拼对象会漏字段 ✗
    { file: path.relative(ROOT, FILE).split(path.sep).join('/'), handoff: h, snapshot: SNAP,
      scope: { problemFiles: [FILE_REL], handoffFiles: h ? [h.file] : [], archiveLinted: false, archiveFileAsBoard: IS_ARCHIVE },
      config: { source: CFG.source || '(默认值)', debtSince: DEBT_SINCE, since: SINCE },
      assumeDebt: ASSUME_DEBT }
  ), null, 2));
  finish(0);
}

console.log('════ 票板自检（只读）════');
console.log('文件：' + path.relative(ROOT, FILE) + '｜共 ' + tickets.length + ' 张票');
// v1.9.1：取数快照 —— 三条线对同一张票报了 11 和 10，谁都没错，是票板在动 ✗ 没有时刻就永远对不上账 ✗
console.log('取数：' + SNAP.at + '｜' + SNAP.lines + ' 行／' + SNAP.chars + ' 字｜sha256 ' + SNAP.contentSha256.slice(0,12) + '…（**对账用这个** ✓ 完整值见 --json ✓ 旧短 hash 有碰撞 ✗ 别用）');
// ★ v1.10.11（五线 §九.1）：把归档当票板跑 ⇒ 一堆"真问题"，数字吓人且没意义 ✗ 光靠 scope 挡不住人 ✗
if (IS_ARCHIVE) {
  console.log('');
  console.log('⚠ **这是归档文件**（文件名命中 待办-归档-*.md）⇒ 下面的"问题数"**没有任何可比性** ✗');
  console.log('  ⇒ 归档块天然长这样：历史回票没点名、无号票、跨块引用 ✓ 不是新增问题 ✓');
  console.log('  ⇒ 要看真实问题请指向**活票板**（默认 docs/待办.md）✓ 归档只该被 `--with-handoff` 当落点源 ✓');
  console.log('');
}
if (CFG.source) {
  console.log(CFG.broken
    ? '⚠ 配置读不了：' + CFG.source + '（' + CFG.broken.split('\n')[0] + '）⇒ 全部走默认值 ✓ 修好它 ✓'
    : '配置：' + CFG.source + '（debtSince=' + DEBT_SINCE + (cget('since') ? ' · since=' + SINCE : '') + '）✓ 命令行参数可临时覆盖 ✓');
}
console.log('状态：待处理 ' + cnt[' '] + '｜处理中 ' + cnt['~'] + '｜待验收 ' + cnt.v + '｜已完成 ' + cnt.x + '｜已取消 ' + cnt['-'] + (cnt['?'] ? '｜**老格式 ' + cnt['?'] + '** ✗' : ''));

if (!problems.length) {
  console.log('✅ 没有发现问题');
} else {
  // v1.8：真问题 / 历史债 分开数 ✓ 让"有没有新增问题"能一眼读出 ✓
  const head = '⚠ **真问题 ' + realProblems.length + ' 条**' + (debtProblems.length ? '（另有历史债 ' + debtProblems.length + ' 条 · 无票号且票头早于 ' + debtSince + ' ⇒ 不回填 ✗）' : '');
  console.log(head + (realProblems.length ? '：' + Object.entries(byKind(realProblems)).map(([k, v]) => k + ' ' + v).join('｜') : ' ✓'));
  if (unknownProblems.length) console.log('　其中 **' + unknownProblems.length + ' 条「年代未知」**（无票号，且票头时间与划代时刻的先后判不了 ⇒ 按 fail-closed 计真问题 ✓ 但它**不是**"已确认的新增问题"✗）');
  // ★ v1.10.23（T-20261027-D13）：**"还剩几件真问题"必须能说成确定的数** ✗
  //   单报 23 是错的 ✓ 正确答法：已确认 2 ＋ 判不了 21 ✓（三栏一起报 ✓）
  if (ASSUME_DEBT) {
    console.log('　⚠ **已按 `--assume-debt` 计**：把「年代未知」的 ' + unknownProblems.length + ' 条**当历史债看** ✓');
    console.log('　⇒ 但这是**口径选择，不是判定** ✗ 原始判定未改 ✓（JSON 里 `unknown` 照旧 ✓）');
    console.log('　⇒ 能确定回答的数：**已确认的新增问题 ' + knownRealProblems.length + ' 条** ✓');
  }
  if (knownRealProblems.length) console.log('　另有 **' + knownRealProblems.length + ' 条年代可判定**（`knownReal`）✓ 关系：real ' + realProblems.length + ' = knownReal ' + knownRealProblems.length + ' + unknown ' + unknownProblems.length + ' + unclassified ' + (LINT.unclassifiedProblems || []).length + ' ✓');
  if ((LINT.unclassifiedProblems || []).length) console.log('　⚠ **内部异常 ' + LINT.unclassifiedProblems.length + ' 条**：诊断的所属票查不到 ✗ 请报上来 ✓（已从 knownReal 排除 ✓ 正常应为 0 ✓）');
  if (debtProblems.length) console.log('　历史债构成：' + Object.entries(byKind(debtProblems)).map(([k, v]) => k + ' ' + v).join('｜'));
  const shown = ALL ? problems : realProblems;
  if (LIST) {
    console.log('');
    if (!shown.length) console.log('  （真问题 0 条 ✓ 加 `--all` 才看历史债 ✓）');
    for (const p of shown) {
      const own = p.ticketLine && p.ticketLine !== p.line ? '（属 L' + p.ticketLine + '）' : '';
      console.log('  L' + String(p.line).padEnd(5) + '[' + p.kind + (p.code ? ' · ' + p.code : '') + '] ' + p.title + own + (p.detail ? ' — ' + p.detail : '') + (p.debt ? '  ⟵ 历史债' : ''));
    }
  } else {
    console.log('（加 --list 逐条列**真问题** ✓ `--list --all` 连历史债一起列 ✓）');
  }
}

if (TRIAL) {
  const MIN = 10;
  const enough = trial.n >= MIN;
  const verdict = (used, denom) => {
    const d = denom || 0;
    if (!enough) return '（样本 ' + trial.n + '/' + MIN + ' 张，**不下结论** ✓ 继续攒）';
    if (!d) return '（**没有适用的票** ⇒ 无法判断 ✓ 不是"0 次使用"✗）';
    if (used === 0) return '（**触发复核** ✓ 先查：功能没必要？字段不会填？工具漏数？没发生适用场景？✓ 不要直接砍 ✗）';
    return '（在用 ✓ 保留）';
  };
  console.log('');
  console.log('════ §16 试行统计（v1.3 口径：只算有票号且**票号日期** ≥ ' + SINCE + ' 的票）════');
  console.log('样本：' + trial.n + ' 张｜其中有回票记录的：' + trial.replies + ' 张' + (trial.dateClash ? '｜⚠ 票号日期与票头日期不一致 ' + trial.dateClash + ' 张（已按票号算 ✓ 请核对）' : ''));
  console.log('⚠ **两项指标两个分母** ✗ —— 下面**按分母分组**列 ✓ 别把 16/20 与 20/20 当同一批比 ✗');
  console.log('');
  console.log('【分母 ' + trial.n + ' ＝ 全部带号票】');
  console.log('  · `[~]` 认领行：' + trial.claim + '/' + trial.n + ' ' + verdict(trial.claim, trial.n));
  console.log('【分母 ' + trial.replies + ' ＝ 有回票记录的票】');
  console.log('  · 回票引用票号：' + trial.cited + '/' + trial.replies + ' ' + verdict(trial.cited, trial.replies));
  console.log('  · 回票标注证据标签：' + trial.labeled + '/' + trial.replies + ' ' + verdict(trial.labeled, trial.replies));
  console.log('注：使用率 ≠ 价值 ✗；高使用率也只证明"填了"✓ 不证明"减少了错误"✗');
}

if (WITH_HANDOFF) {
  console.log('');
  console.log('════ 交接交叉核对（--with-handoff · 只读 · 只查"指针能不能落到票" ✗ 不查内容对不对）════');
  if (!existsSync(HANDOFF)) {
    console.log('⚠ 找不到交接文件：' + path.relative(ROOT, HANDOFF) + '（跳过 ✓ 不算失败 ✗）');
  } else {
    // 对照源 = 活票板 ＋ 所有归档文件（归档过的票**不算**悬空 ✓ 别误报 ✗）
    const sources = [{ name: '票板', text }];
    let archived = [];
    try { archived = readdirSync(path.join(ROOT, 'docs')).filter(f => /^待办-归档-.*\.md$/.test(f)).sort(); } catch { /* docs 读不到就算了 */ }
    for (const f of archived) {
      try { sources.push({ name: '归档 ' + f, text: readFileSync(path.join(ROOT, 'docs', f), 'utf8') }); } catch { /* 单个归档读不到就跳过 */ }
    }
    const h = lintHandoffPointers((readTextSafe(HANDOFF).text || ''), sources);
    console.log('交接：' + path.relative(ROOT, HANDOFF) + '｜' + h.lines + ' 行｜票号指针 ' + h.refs + ' 处 ／ 去重 ' + h.ids.length + ' 个'
      + (h.examples ? '｜行内代码里的示例/模板 ' + h.examples + ' 个（**不判定** ✗ 别把示例当指针 ✗）' : ''));
    console.log('对照源（按**票号声明**算，不按"文本里出现过"）：' + h.declared.map(d => d.name + ' ' + d.total + ' 张票／声明票号 ' + d.n + ' 张').join(' ＋ '));
    const noDecl = h.declared.every(d => !d.n);
    if (noDecl && h.refs) console.log('⚠ 对照源里**一张声明了票号的票都没有** ⇒ 下面这些指针**没有落点** ✓（不是"写错了"✗ 是"票没开票号"✗）');
    // v1.9（五线反馈 §3）：解释"去重数 < 声明票号数" —— 否则第一眼像丢了指针 ✗
    const declaredIds = [...new Set(tickets.map(t => t.id).filter(Boolean))];
    if (declaredIds.length) {
      const referenced = new Set(h.ids);
      const uncovered = declaredIds.filter(id => !referenced.has(id));
      console.log('· 未被交接引用的票 **' + uncovered.length + ' 张**（声明票号 ' + declaredIds.length + ' ＝ 已引用 ' + (declaredIds.length - uncovered.length) + ' ＋ 未引用 ' + uncovered.length + '）'
        + '—— **正常** ✗ 不是丢指针 ✗ 不是每张票都会被交接提到 ✓');
    }
    const bySrc = {};
    for (const [id, src] of Object.entries(h.resolved)) (bySrc[src] = bySrc[src] || []).push(id);
    for (const src of Object.keys(bySrc)) console.log('· 能定位（' + src + '）：' + bySrc[src].length + ' 个 — ' + bySrc[src].join(' '));
    if (!h.refs) {
      console.log('· 交接里**没有**票号指针（0 处）⇒ **无从核对** ✓ 不报"通过" ✗（§16 同理：没有样本 ≠ 没用 ✗）');
    } else if (h.dangling.length) {
      console.log('⚠ **悬空指针 ' + h.dangling.length + ' 个**（交接写了票号，票板与归档里都没有 ✗）：');
      for (const d of h.dangling) console.log('  ' + d.id + '  ← L' + d.lines.join(', L'));
      console.log('  ⇒ 票号写错 ✗ ／ 票根本没开 ✗ ／ 归档文件不在 docs\\ 下 ✓ —— 查清再改指针 ✗ 别直接删行 ✗');
    } else {
      console.log('✅ 交接里的 ' + h.ids.length + ' 个票号指针**全部能落到票** ✓（能定位 ≠ 内容对 ✗ 也不证明对方签收过 ✗）');
    }
    if (trial.n) console.log('注：以上**不计入** §16 试行率 ✓ 口径不变（试行只数票板内的回票记录 ✓ 不把交接的指针算成引用 ✗）');
  }
}

console.log('注：这只是结构自检 ✓ 不能证明代码正确或用户满意 ✗');
finish(0);
