/**
 * tools/ticket-reply-selftest.mjs —— **回票归位**的回归测试（7 个用例）
 *
 * 为什么单独测：它是本仓**唯一会改共享票板的工具** ✗ 改错了比 README 写错严重得多 ✗
 * 每个用例都只走**纯函数**（不碰磁盘 ✓）—— 磁盘那份由 `--write` 自己再做一次快照＋守恒校验 ✓
 *
 * 跑法：node tools\ticket-reply-selftest.mjs     全绿 exit 0 ✓ 有红 exit 1
 */
import assert from 'node:assert/strict';
import { planMoves, applyAllMoves, applyOneMove, checkConserved, closeTicket, findReplyRecords, eolOf } from './lib/ticket-move.mjs';
import { lintTickets } from './lib/ticket-lint.mjs';

let pass = 0, fail = 0;
function expect(name, fn) {
  try { fn(); pass++; console.log('✔ ' + name); }
  catch (e) { fail++; console.log('✖ ' + name + '\n   ' + String(e.message).split('\n')[0]); }
}
const kinds = (text) => lintTickets(text, { since: '2026-10-25' }).problems.map(p => p.kind);

// ── 0. 正常对照：回票就在自己块里 ⇒ 一条都不用搬 ──────────────────────
const OK = [
  '## [v] [C→D] 在正确位置（2026-10-26 09:00 UTC+8）',
  '',
  '**票号**：T-20261026-C01',
  '',
  '**验收方式**：读字段',
  '',
  '> ✅ **【2026-10-26 09:30 · D】** 回「在正确位置」（T-20261026-C01）',
  ''
].join('\n');

expect('0 正常对照：位置对 ⇒ 0 条待搬', () => {
  const p = planMoves(OK);
  assert.equal(p.moves.length, 0, '实际 ' + p.moves.length);
  assert.equal(p.unresolved.length, 0, '实际 ' + p.unresolved.length);
});

// ── 1. A 向：回票落在**别人的**票块里 ⇒ 要搬进它点的那张票 ─────────────
const MISPLACED = [
  '## [v] [C→D] 甲票（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-C01',
  '',
  '**验收方式**：读字段',
  '',
  '## [ ] [D→C] 乙票（2026-10-26 10:10 UTC+8）',
  '',
  '**票号**：T-20261026-D05',
  '',
  '**验收方式**：读字段',
  '',
  '> ✅ **【2026-10-26 10:30 · D】** 回「甲票」（T-20261026-C01）',
  ''
].join('\n');

expect('1 A向：回票落别人块 ⇒ 搬进它点的票（搬完 A/B 两个方向都清零）', () => {
  const p = planMoves(MISPLACED);
  assert.equal(p.moves.length, 1, '应只有 1 条，实际 ' + p.moves.length);
  assert.equal(p.moves[0].targetId, 'T-20261026-C01', '目标应是甲票，实际 ' + p.moves[0].targetId);
  assert.equal(p.moves[0].ownerId, 'T-20261026-D05', '源应是乙票块，实际 ' + p.moves[0].ownerId);
  assert.ok(kinds(MISPLACED).includes('回票指向别的票'), '搬前应能报出来（否则这个用例没意义）');

  const r = applyAllMoves(MISPLACED);
  assert.equal(r.done, 1);
  const k = kinds(r.text);
  assert.ok(!k.includes('回票指向别的票'), '搬完 A 向应清零，实际 ' + JSON.stringify(k));
  assert.ok(!k.includes('回票不在票块内'), '搬完 B 向应清零，实际 ' + JSON.stringify(k));
  assert.equal(planMoves(r.text).moves.length, 0, '再算一次应为空（幂等 ✓）');
  assert.ok(checkConserved(MISPLACED, r.text).ok, '内容必须守恒');
});

// ── 2. 定位不了：既没票号也没回「标题」⇒ 只报告，不动 ✗ ────────────────
const NO_HINT = [
  '## [v] [C→D] 没有线索（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-C02',
  '',
  '**验收方式**：读字段',
  '',
  '> ✅ **【2026-10-26 10:30 · D】** 已改，请复验',
  ''
].join('\n');

expect('2 定位不了就不动（unresolved 1 ✓ 宁可不动也不猜 ✗）', () => {
  const p = planMoves(NO_HINT);
  assert.equal(p.moves.length, 0, '不该猜，实际搬 ' + p.moves.length);
  assert.equal(p.unresolved.length, 1, '应报 1 条定位不了，实际 ' + p.unresolved.length);
});

// ── 3. 一段回票里两个票号 ⇒ 不猜 ✗ ──────────────────────────────────
const TWO_IDS = [
  '## [ ] [D→C] 二号（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-D08',
  '',
  '**验收方式**：读字段',
  '',
  '> ✅ **【2026-10-26 10:30 · D】** 回「甲」（T-20261026-C02）与「乙」（T-20261026-D09）',
  ''
].join('\n');

expect('3 一段回票两个号 ⇒ unresolved（不猜 ✗）', () => {
  const p = planMoves(TWO_IDS);
  assert.equal(p.moves.length, 0, '不该搬，实际 ' + p.moves.length);
  assert.equal(p.unresolved.length, 1, '实际 unresolved=' + p.unresolved.length);
});

// ── 4. 定位按**声明**走：正文提到别人的号，不能把回票吸到那块 ─────────────
const DECL_FIRST = [
  '## [v] [D→C] 提到的块（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-D10',
  '',
  '**验收方式**：读字段',
  '',
  '我上一条回的是 T-20261026-C11 那张票',
  '',
  '## [v] [C→D] 真正的目标（2026-10-26 10:10 UTC+8）',
  '',
  '**票号**：T-20261026-C11',
  '',
  '**验收方式**：读字段',
  '',
  '> ✅ **【2026-10-26 10:30 · C】** 回「真正的目标」（T-20261026-C11）',
  ''
].join('\n');

expect('4 声明优先：回票已在声明块里 ⇒ 不因正文提号而乱搬', () => {
  const p = planMoves(DECL_FIRST);
  assert.equal(p.moves.length, 0, '实际搬 ' + p.moves.length + ' 条（说明按"出现过"匹配了 ✗）');
});

// ── 5. 行内代码里的回票原文不算回票记录 ──────────────────────────────
const QUOTED = [
  '## [v] [H→K] 只有引用（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-H12',
  '',
  '**验收方式**：读字段',
  '',
  '> 我把 K 那段 `> ✅【22:50 · K】回「登记第五条线」（T-20261026-H01）` 搬回去了',
  ''
].join('\n');

expect('5 行内代码里的引用不算回票记录（0 条 ✓ 否则会被搬走 ✗）', () => {
  assert.equal(findReplyRecords(QUOTED).recs.length, 0, '实际 ' + findReplyRecords(QUOTED).recs.length);
});

// ── 6. 结票：只许 [v] → [x] ＋ 块里必须有回票 ────────────────────────
const TO_CLOSE = [
  '## [v] [C→D] 等验收（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-C13',
  '',
  '**验收方式**：读字段',
  '',
  '> ✅ **【2026-10-26 10:30 · C】** 回「等验收」（T-20261026-C13）',
  ''
].join('\n');
const NO_REPLY = [
  '## [v] [C→D] 空票（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-C14',
  '',
  '**验收方式**：读字段',
  ''
].join('\n');
const ALREADY_X = TO_CLOSE.replace('## [v]', '## [x]');

expect('6 结票：`[v]`→`[x]` 可以 ✓｜无回票 ✗ 拒绝｜非 [v] ✗ 拒绝', () => {
  assert.ok(closeTicket(TO_CLOSE, 'T-20261026-C13').includes('## [x] [C→D] 等验收'), '应推成 [x]');
  assert.throws(() => closeTicket(NO_REPLY, 'T-20261026-C14'), /没有回票记录/, '无回票必须拒绝');
  assert.throws(() => closeTicket(ALREADY_X, 'T-20261026-C13'), /只有 `\[v\]`/, '已是 [x] 必须拒绝');
});

// ── 7–10. v1.10：GPT 第二轮复核（C09–C11）＋ 重复票号 ────────────────
expect('7（C09）：守恒必须是**多重集相等** —— 多出来的行也要判失败', () => {
  const a = '甲\n乙\n', b = '甲\n乙\n多出来的一行\n';
  const r = checkConserved(a, b);
  assert.equal(r.ok, false, '多了非空行必须失败（原来只查"没丢"✗）');
  assert.ok(r.extra.length > 0, '应报出多出来的行');
  assert.equal(checkConserved('甲\n乙\n', '乙\n甲\n').ok, true, '顺序变化不算失败（搬动会改顺序 ✓）');
});

expect('8（C10）：块里只有"点别人票"的回票 ⇒ 不许结票', () => {
  const text = [
    '## [v] [卡片→调试] 甲（2026-10-26 01:00 UTC+8）',
    '**票号**：T-20261026-D01',
    '> ✅ 调试：回「乙」 T-20261026-D02'
  ].join('\n');
  assert.throws(() => closeTicket(text, 'T-20261026-D01'), /没有一条点名本票/, '必须拒绝');
});

expect('9（C11）：混用 CRLF/LF ⇒ 拒绝写入（别"能读就当能写回"✗）', () => {
  const mixed = '## [v] [x] 甲（2026-10-26 01:00 UTC+8）\r\n**票号**：T-20261026-D01\n> ✅ 调试：回「甲」 T-20261026-D01\n';
  const plan = planMoves(mixed);
  assert.equal(eolOf(mixed).mixed, true, '应识别为混用行尾');
  assert.throws(() => applyOneMove(mixed, { start: 3, end: 4, targetId: 'T-20261026-D01' }), /混用 CRLF\/LF/, '搬动必须拒绝');
  assert.throws(() => closeTicket(mixed, 'T-20261026-D01'), /混用 CRLF\/LF/, '结票必须拒绝');
});

expect('10（C01/C02）：重复票号 ⇒ 归位不敢动（unresolved，0 条待搬）', () => {
  const dup = [
    '## [v] [x] 甲（2026-10-26 01:00 UTC+8）', '**票号**：T-20261026-D01', '',
    '## [v] [x] 乙（2026-10-26 01:00 UTC+8）', '**票号**：T-20261026-D01', '',
    '## [v] [x] 丙（2026-10-26 01:00 UTC+8）', '**票号**：T-20261026-D02', '',
    '> ✅ 调试：回「甲」 T-20261026-D01'
  ].join('\n');
  const p = planMoves(dup);
  assert.equal(p.moves.length, 0, '重复票号时不许生成可执行搬动');
  assert.equal(p.unresolved.length, 1, '应报 1 条定位不了');
  assert.ok(/同时声明/.test(p.unresolved[0].why), '原因应说明重复声明：' + p.unresolved[0].why);
});

expect('11（F02）：相邻两条回票不许并成一条 —— 只搬错位那条，另一条原地不动', () => {
  const two = [
    '## [v] [x] 甲（2026-10-26 01:00 UTC+8）', '**票号**：T-20261026-D01', '',
    '## [v] [x] 乙（2026-10-26 01:00 UTC+8）', '**票号**：T-20261026-D02', '',
    '> ✅ 回「乙」 T-20261026-D02', '> 证据：1/1。',
    '> ✅ 回「甲」 T-20261026-D01', '> 证据：1/1。', ''
  ].join('\n');
  const recs = findReplyRecords(two).recs;
  assert.equal(recs.length, 2, '两条相邻回票必须识别为 2 条（原来并成 1 条 ✗），实际 ' + recs.length);
  const p = planMoves(two);
  assert.equal(p.moves.length, 1, '只该搬错位的那条');
  assert.equal(p.moves[0].targetId, 'T-20261026-D01');
  assert.equal(p.unresolved.length, 0, '不该有 unresolved');
  const r = applyAllMoves(two);
  assert.ok(checkConserved(two, r.text).ok, '内容必须守恒');
  assert.equal(planMoves(r.text).moves.length, 0, '搬完不该还有待搬');
});

// ── 12–14. v1.10.7/8：**入口级** --max 校验（真跑 CLI ✓ 但**在临时项目根里** ✓）──
// ★ v1.10.8（GPT R01）：原来用**真项目的 CLI** 跑临时票板 ⇒ 备份落到**真项目** `.backups` ✗
//   现在：把 CLI ＋ lib 复制到一个临时项目根，从那里跑 ⇒ 票板和备份都落在临时根里 ✓ 跑完整目录删掉 ✓
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_BACKUPS = path.resolve(HERE, '..', '.backups');
const listBackups = () => (existsSync(REAL_BACKUPS) ? readdirSync(REAL_BACKUPS).sort().join('|') : '');

/** 造一个**独立项目根**：tools/ticket-reply.mjs ＋ tools/lib/* ✓ 备份只会落在它自己的 .backups ✓ */
const mkTempProject = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fj-proj-'));
  mkdirSync(path.join(dir, 'tools', 'lib'), { recursive: true });
  copyFileSync(path.join(HERE, 'ticket-reply.mjs'), path.join(dir, 'tools', 'ticket-reply.mjs'));
  for (const f of ['ticket-lint.mjs', 'ticket-move.mjs']) {
    copyFileSync(path.join(HERE, 'lib', f), path.join(dir, 'tools', 'lib', f));
  }
  return { dir, cli: path.join(dir, 'tools', 'ticket-reply.mjs'), board: path.join(dir, 'board.md') };
};
const mkBoard = (n) => {
  let s = '';
  for (let i = 1; i <= 2; i++) s += '## [v] [C→D] 票' + i + '\n\n**票号**：T-20261026-C0' + i + '\n\n**验收方式**：读字段\n\n';
  for (let i = 0; i < n; i++) s += '> ✅ 回「票1」 T-20261026-C01\n> 证据：' + (i + 1) + '/' + n + '。\n';
  return s + '\n';
};
const runCli = (proj, args) => {
  try {
    const out = execFileSync(process.execPath, [proj.cli, '--file', proj.board, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

expect('12（N05–N10）：非法 --max 必须拒绝且**一个字节都不写**（真跑 CLI · 临时项目根）', () => {
  const proj = mkTempProject();
  try {
    for (const bad of ['abc', 'Infinity', '--write', '-1', '1.5', '']) {
      writeFileSync(proj.board, mkBoard(11));
      const before = readFileSync(proj.board, 'utf8');
      const r = runCli(proj, ['--write', '--max', bad]);
      assert.equal(r.code, 2, '--max ' + JSON.stringify(bad) + ' 应 exit 2，实际 ' + r.code + '：' + r.out.slice(0, 80));
      assert.equal(readFileSync(proj.board, 'utf8'), before, '--max ' + JSON.stringify(bad) + ' 之后票板必须逐字不变');
      assert.ok(!existsSync(path.join(proj.dir, '.backups')), '被拒时不许产生备份');
    }
  } finally { rmSync(proj.dir, { recursive: true, force: true }); }
});

expect('13（N05）：默认 11 条拒绝 ✓ 显式 --max 11 允许 ✓（真跑 CLI · 临时项目根）', () => {
  const proj = mkTempProject();
  try {
    writeFileSync(proj.board, mkBoard(11));
    const before = readFileSync(proj.board, 'utf8');
    const r1 = runCli(proj, ['--write']);
    assert.equal(r1.code, 1, '默认应拒绝（exit 1），实际 ' + r1.code);
    assert.equal(readFileSync(proj.board, 'utf8'), before, '被拒时不许写盘');
    const r2 = runCli(proj, ['--write', '--max', '11']);
    assert.equal(r2.code, 0, '显式 --max 11 应放行，实际 ' + r2.code + '：' + r2.out.slice(0, 120));
    assert.notEqual(readFileSync(proj.board, 'utf8'), before, '放行后应真的搬了');
    // 备份必须落在**临时根**里 ✓ 不是真项目 ✓
    assert.ok(existsSync(path.join(proj.dir, '.backups')), '备份应落在临时项目根的 .backups');
  } finally { rmSync(proj.dir, { recursive: true, force: true }); }
});

expect('14（GPT R01）：自测**不许**在真项目的 .backups 里留东西', () => {
  const before = listBackups();
  const proj = mkTempProject();
  try {
    writeFileSync(proj.board, mkBoard(11));
    runCli(proj, ['--write', '--max', '11']);
  } finally { rmSync(proj.dir, { recursive: true, force: true }); }
  assert.equal(listBackups(), before, '真项目 .backups 目录内容变了 ✗ 自测污染了生产备份 ✗');
});

// ── 15. v1.10.10：标题匹配到**没有票号**的票 ⇒ unresolved，不许生成空 targetId ──
expect('15：按标题匹配的票没有票号声明 ⇒ 定位不了（不许生成空 targetId 的搬动）', () => {
  const text = [
    '## [v] [C→D] 老票标题（2026-10-26 01:00 UTC+8）', '（没有票号声明）', '',
    '## [ ] [D→C] 另一张（2026-10-26 01:00 UTC+8）', '**票号**：T-20261026-D02', '',
    '> ✅ 回「老票标题」'
  ].join('\n');
  const p = planMoves(text);
  assert.equal(p.moves.length, 0, '不许生成可执行搬动（targetId 会是空 ✗）');
  assert.equal(p.unresolved.length, 1, '应报 1 条定位不了');
  assert.ok(/没有票号声明/.test(p.unresolved[0].why), '原因应说明对方没写票号：' + p.unresolved[0].why);
});

// ── 16–18. T-20261101-F03：混用行尾**自动归一**成 LF（不让人再兜）──────────────
const toMixed = (s) => {
  const lines = s.split('\n');
  const cut = Math.max(1, Math.floor(lines.length / 2));
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    out += lines[i] + (i === lines.length - 1 ? '' : (i < cut ? '\r\n' : '\n'));
  }
  return out;
};

expect('16（F03）：混用 CRLF/LF ⇒ 写盘前自动归一，打一行，文件里再没有 \\r', () => {
  const proj = mkTempProject();
  try {
    const mixed = toMixed(mkBoard(1));
    assert.ok(mixed.includes('\r\n') && /(?<!\r)\n/.test(mixed), '夹具本身要是混用的');
    writeFileSync(proj.board, mixed);
    const r = runCli(proj, ['--write', '--close', 'T-20261026-C01']);
    assert.equal(r.code, 0, '混用文件应成功，实际 ' + r.code + '：' + r.out.slice(0, 200));
    assert.ok(/行尾归一：CRLF \d+ 处 → LF/.test(r.out), '必须打出归一数：' + r.out.slice(0, 300));
    const after = readFileSync(proj.board, 'utf8');
    assert.ok(!after.includes('\r'), '写完不许留 \\r');
    assert.ok(after.includes('## [x]'), '结票应生效');
  } finally { rmSync(proj.dir, { recursive: true, force: true }); }
});

expect('17（F03）：同一个混用文件加 --strict-eol ⇒ 仍然拒绝，且一个字节都不写', () => {
  const proj = mkTempProject();
  try {
    const mixed = toMixed(mkBoard(1));
    writeFileSync(proj.board, mixed);
    const r = runCli(proj, ['--write', '--close', 'T-20261026-C01', '--strict-eol']);
    assert.equal(r.code, 1, '--strict-eol 应拒绝，实际 ' + r.code);
    assert.ok(/混用 CRLF\/LF/.test(r.out), '要说清为什么拒：' + r.out.slice(0, 200));
    assert.equal(readFileSync(proj.board, 'utf8'), mixed, '被拒时票板必须逐字不变');
  } finally { rmSync(proj.dir, { recursive: true, force: true }); }
});

expect('18（F03）：纯 LF 文件 ⇒ 行为不变，也**不打**归一那行', () => {
  const proj = mkTempProject();
  try {
    const pure = mkBoard(1);
    writeFileSync(proj.board, pure);
    const r = runCli(proj, ['--write', '--close', 'T-20261026-C01']);
    assert.equal(r.code, 0, '纯 LF 应正常，实际 ' + r.code + '：' + r.out.slice(0, 200));
    assert.ok(!/行尾归一/.test(r.out), '纯 LF 不许打归一那行：' + r.out.slice(0, 300));
    assert.ok(readFileSync(proj.board, 'utf8').includes('## [x]'), '结票应生效');
  } finally { rmSync(proj.dir, { recursive: true, force: true }); }
});

console.log('');
console.log((fail ? '⚠ ' : '✅ ') + '回票归位自检：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
