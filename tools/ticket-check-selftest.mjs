/**
 * tools/ticket-check-selftest.mjs —— 检查器的**回归测试**（9 个样例：1 正常对照 + 8 反例）
 *
 * 前 7 个反例来自 GPT 2026-10-25 的《反馈复核》（原包是 7 个独立样例文件 ＋ 复现脚本 ✓）
 * 第 8 个是本仓 v1.4 新增的 `--with-handoff`（交接指针能不能落到票 ✓）
 * 这里把它们**内联成断言** ✓ 以后谁改检查器，跑这一个文件就知道有没有改回去 ✓
 *
 * 跑法：node tools\ticket-check-selftest.mjs       全绿 exit 0 ✓ 有红 exit 1
 */
import { lintTickets, lintHandoffPointers, buildReport, snapshotOf, queueOf, closedLoop, releaseTier, KIND_CODES } from './lib/ticket-lint.mjs';
import { writeBackup } from './lib/ticket-move.mjs';
import { impersonatedOf } from './lib/ticket-lint.mjs';
import { planMoves } from './lib/ticket-move.mjs';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const kinds = (text) => lintTickets(text, { since: '2026-10-25' }).problems.map(p => p.kind);
const trial = (text) => lintTickets(text, { since: '2026-10-25' }).trial;

function expect(name, fn) {
  try { fn(); pass++; console.log('✔ ' + name); }
  catch (e) { fail++; console.log('✖ ' + name + '\n   ' + String(e.message).split('\n')[0]); }
}

// ── 0. 正常对照：一张合规的票，不该有任何问题 ─────────────────────────
const GOOD = [
  '## [x] [C→D] 正常对照（2026-10-26 09:10 UTC+8）',
  '',
  '**票号**：T-20261026-C01',
  '',
  '**现象**：示例',
  '**验收方式**：`node x.mjs` → 0',
  '',
  '认领：D（2026-10-26 09:20 UTC+8）',
  '',
  '> ✅ **【2026-10-26 09:30 UTC+8 · D：改了】** 回「正常对照」（T-20261026-C01）',
  '> 证据标签：自动测试实测'
].join('\n');

expect('正常对照无任何问题', () => assert.deepEqual(kinds(GOOD), []));

// ── 1. 反例：票号窗口跨进下一张票（甲票没票号，乙票紧接在后）─────────
const CROSS = [
  '## [ ] [C→D] 甲票没票号（2026-10-26 10:00 UTC+8）',
  '',
  '**现象**：甲',
  '**验收方式**：读字段',
  '',
  '## [x] [D→C] 乙票有票号（2026-10-26 10:10 UTC+8）',
  '',
  '**票号**：T-20261026-D02',
  '',
  '> ✅ **【2026-10-26 11:00 · D】** 回「乙票」（T-20261026-D02）'
].join('\n');

expect('反例1：票号不跨票（甲报缺票号 ✓ 乙不报重复 ✓）', () => {
  const k = kinds(CROSS);
  assert.ok(k.includes('缺票号'), '甲票应报缺票号，实际：' + JSON.stringify(k));
  assert.ok(!k.includes('票号重复'), '不该误报票号重复，实际：' + JSON.stringify(k));
});

// ── 2. 反例：票头声明票号冒充回票点名 ────────────────────────────────
const FAKE_CITE = [
  '## [x] [C→D] 声明冒充点名（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-C02',
  '',
  '> ✅ 已修改，请复验'
].join('\n');

expect('反例2：票头声明不算回票点名（应报 回票未点名）', () => {
  assert.ok(kinds(FAKE_CITE).includes('回票未点名'), '实际：' + JSON.stringify(kinds(FAKE_CITE)));
});

// ── 3. 反例：代码块里的 "✅ 回票格式示例" 冒充完成证据 ─────────────────
const FENCED_OK = [
  '## [x] [C→D] 代码块示例冒充证据（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-C03',
  '',
  '格式示例：',
  '```markdown',
  '> ✅ **【时间 · 线：结论】** 回「原票」',
  '```'
].join('\n');

expect('反例3：代码块里的 ✅ 不算回票（应报 符号冒充回票）', () => {
  assert.ok(kinds(FENCED_OK).includes('符号冒充回票'), '实际：' + JSON.stringify(kinds(FENCED_OK)));
});

// ── 4. 反例：模板里写"证据标签可选：静态检查／…" 冒充实际标签 ──────────
const TPL_LABEL = [
  '## [ ] [C→D] 模板选项冒充标签（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-C04',
  '',
  '**验收方式**：`node x.mjs`',
  '',
  '证据标签可选：静态检查／自动测试实测／目标环境实测',
].join('\n');

expect('反例4：没回票就不算标注标签（试行为 0/0 而非 0/1）', () => {
  const t = trial(TPL_LABEL);
  assert.equal(t.replies, 0, '没有回票记录 ⇒ 分母应为 0，实际 ' + t.replies);
  assert.equal(t.labeled, 0, '不该把模板文字算成标注，实际 ' + t.labeled);
});

// ── 5. 反例：普通 `票号：T-…`（不加粗）被计作"引用" ────────────────────
const PLAIN_DECL = [
  '## [v] [C→D] 普通声明冒充引用（2026-10-26 10:00 UTC+8）',
  '',
  '票号：T-20261026-C05',
  '',
  '> ✅ 已改，请复验'
].join('\n');

expect('反例5：回票没写票号 ⇒ 不算引用（cited 0/1 ✓ 且报 回票未点名）', () => {
  const r = lintTickets(PLAIN_DECL, { since: '2026-10-25' });
  assert.equal(r.trial.cited, 0, '实际 cited=' + r.trial.cited);
  assert.equal(r.trial.replies, 1, '有回票记录 ⇒ 分母 1，实际 ' + r.trial.replies);
  assert.ok(r.problems.map(p => p.kind).includes('回票未点名'), '应报回票未点名');
});

// ── 6. 反例：票号日期新、票头日期旧（应提示冲突，且按票号算进样本）──────
const DATE_CLASH = [
  '## [ ] [C→D] 日期冲突（2026-10-01 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-C06',
  '',
  '**验收方式**：`node x.mjs`'
].join('\n');

expect('反例6：日期冲突要提示（dateClash=1 ✓ 且按票号日期进样本）', () => {
  const t = trial(DATE_CLASH);
  assert.equal(t.dateClash, 1, '实际 dateClash=' + t.dateClash);
  assert.equal(t.n, 1, '应按票号日期 2026-10-26 计入样本，实际样本 ' + t.n);
});

// ── 7. 反例：回票落在票块之外（追加到**下一张票之后**）──────────────────
const MISPLACED = [
  '## [v] [C→D] 回票落块外（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-C07',
  '',
  '**验收方式**：`node x.mjs`',
  '',
  '## [ ] [D→C] 另一张票（2026-10-26 10:30 UTC+8）',
  '',
  '**票号**：T-20261026-D08',
  '',
  '**验收方式**：`node y.mjs`',
  '',
  '---',
  '',
  '> ✅ **【2026-10-26 12:00 · D】** 回「回票落块外」（T-20261026-C07）'
].join('\n');

expect('反例7：回票落块外要单列一类', () => {
  assert.ok(kinds(MISPLACED).includes('回票不在票块内'), '实际：' + JSON.stringify(kinds(MISPLACED)));
});

// ── 8. --with-handoff：交接只写指针 ⇒ 指针必须能落到票 ────────────────
//   三个断言：① 悬空要报 ② 落到归档不算悬空 ③ 行内代码里的示例/模板不算指针
const HANDOFF = [
  '| 日期 | 会话 | 做了什么 |',
  '|---|---|---|',
  '| 2026-10-26 | D | 做完了，见 T-20261026-D09 |',
  '| 2026-10-26 | D | 老票在归档里，见 T-20261020-C07 |',
  '| 2026-10-26 | D | 规则说明：交接只写指针（`见 T-20261026-D09` ✓ 别复述人话 ✗）|',
  '| 2026-10-26 | D | 票根本没开过：见 T-20261026-D99 |'
].join('\n');
const BOARD_TXT = [
  '## [ ] [C→D] 新票（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-D09',
  '',
  '**验收方式**：`node x.mjs` → 0'
].join('\n');
const ARCHIVE_TXT = [
  '## [x] [C→D] 早就归档的票（2026-10-20 10:00 UTC+8）',
  '',
  '**票号**：T-20261020-C07'
].join('\n');

expect('反例8：交接指针能落到票（悬空要报 ✓ 归档不算悬空 ✓ 行内代码示例不算指针 ✓）', () => {
  const h = lintHandoffPointers(HANDOFF, [
    { name: '票板', text: BOARD_TXT },
    { name: '归档', text: ARCHIVE_TXT }
  ]);
  const d = h.dangling.map(x => x.id);
  assert.deepEqual(d, ['T-20261026-D99'], '只该报那张根本没开的票，实际：' + JSON.stringify(d));
  assert.equal(h.resolved['T-20261020-C07'], '归档', '归档里的票应能定位到归档，实际：' + JSON.stringify(h.resolved));
  assert.equal(h.resolved['T-20261026-D09'], '票板', '活票板里的票应能定位到票板，实际：' + JSON.stringify(h.resolved));
  assert.equal(h.examples, 1, '行内代码里的示例应只计数、不判定，实际 examples=' + h.examples);
});

// ── 9. 行内代码里的"凭据样例"不算凭据（五线现场反馈：`password=…` 被误报）──────
const SECRET_SAMPLE = [
  '## [ ] [C→D] 文档里的样例（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-C09',
  '',
  '**验收方式**：读字段',
  '',
  '文档里写 `password=abcdef123` 这种样例是正常的'
].join('\n');

expect('反例9：行内代码里的凭据样例不算凭据（不报 疑似凭据）', () => {
  const k = kinds(SECRET_SAMPLE);
  assert.ok(!k.includes('疑似凭据'), '不该误报，实际：' + JSON.stringify(k));
});

// ── 10. 行内代码里引用的"别人的回票"不算本块的回票记录 ──────────────────
const QUOTED_REPLY = [
  '## [v] [H→K] 只有一段引用（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-H10',
  '',
  '**验收方式**：读字段',
  '',
  '> 我把 K 那段 `> ✅【22:50 · K】回「登记第五条线」（T-20261026-H01）` 搬回去了'
].join('\n');

expect('反例10：行内代码里别人的回票不算回票（回票记录 0 条 ✓ 不判"指向别的票"✓）', () => {
  const r = lintTickets(QUOTED_REPLY, { since: '2026-10-25' });
  const k = r.problems.map(p => p.kind);
  assert.equal(r.tickets[0].replyLines.length, 0, '引用不算回票记录，实际 ' + r.tickets[0].replyLines.length);
  assert.ok(!k.includes('回票指向别的票'), '引用被判成行为，实际：' + JSON.stringify(k));
  assert.equal(r.trial.cited, 0, '引用里的号不算引用，实际 cited=' + r.trial.cited);
});

// ── 11. 正文交叉引用别人的票号 ≠ 票号歧义（口径：只看声明行）──────────────
const CROSS_REF = [
  '## [v] [C→D] 正文提别人的号（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-C11',
  '',
  '**验收方式**：读字段',
  '',
  '我开的第一张就是 T-20261026-D05，这个号是别人的',
  '',
  '> ✅ **【2026-10-26 11:00 · C】** 回「正文提别人的号」（T-20261026-C11）'
].join('\n');

expect('反例11：正文交叉引用别的票号不算歧义（声明行只有一个 ⇒ 不报 ✓）', () => {
  const r = lintTickets(CROSS_REF, { since: '2026-10-25' });
  const k = r.problems.map(p => p.kind);
  assert.ok(!k.includes('票号歧义'), '不该误报歧义，实际：' + JSON.stringify(k));
  assert.equal(r.tickets[0].id, 'T-20261026-C11', '票号应取声明行那个，实际 ' + r.tickets[0].id);
});

// ── 12. 对照：真的两个声明行 ⇒ 必须仍报歧义（别把口径放宽成"永远不报"）──────
const TWO_DECLS = [
  '## [ ] [C→D] 两个声明（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-C12',
  '**票号**：T-20261026-D12',
  '',
  '**验收方式**：读字段'
].join('\n');

expect('反例12：两个声明行要报歧义（防止口径被放宽成永不报 ✗）', () => {
  assert.ok(kinds(TWO_DECLS).includes('票号歧义'), '实际：' + JSON.stringify(kinds(TWO_DECLS)));
});

// ── 13. 回票落在别人块里，但带「回『标题』」—— 也必须报（v1.6 修的真漏报）──────
const WRONG_BLOCK = [
  '## [ ] [D→C] 乙票（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-D13',
  '',
  '**验收方式**：读字段',
  '',
  '> ✅ **【2026-10-26 10:30 · D】** 回「甲票」（T-20261026-C13）'
].join('\n');

expect('反例13：带「回『标题』」也照样报"指向别的票"（别让最常见形态失明 ✗）', () => {
  const k = kinds(WRONG_BLOCK);
  assert.ok(k.includes('回票指向别的票'), '实际：' + JSON.stringify(k));
});

// ── 14. 回票写了"状态：[v]"，票头却没改 ⇒ 必须报（现场真踩过）───────────────
const STATE_NOT_MOVED = [
  '## [ ] [流程→调试] 票头没推（2026-10-26 10:00 UTC+8）',
  '',
  '**票号**：T-20261026-F14',
  '',
  '**验收方式**：读字段',
  '',
  '> ✅ **【2026-10-26 10:30 · D】** 回「票头没推」（T-20261026-F14）',
  '> 状态：**[v] 待验收**'
].join('\n');

expect('反例14：回票了但票头还是 [ ] ⇒ 报「回票了但状态没推」', () => {
  const k = kinds(STATE_NOT_MOVED);
  assert.ok(k.includes('回票了但状态没推'), '实际：' + JSON.stringify(k));
});

// ── 15. v1.8：历史债分类（双特征：无票号 ＋ 票头早于制度生效日）────────────
const OLD_DEBT = [
  '## [ ] [卡片→调试] 老票没有号（2026-10-13 10:00 UTC+8）',
  '',
  '**现象**：老票',
  '**验收方式**：读字段'
].join('\n');
const NEW_NO_ID = [
  '## [ ] [卡片→调试] 新票忘了写号（2026-10-26 10:00 UTC+8）',
  '',
  '**验收方式**：读字段'
].join('\n');
const NO_DATE_NO_ID = [
  '## [ ] [卡片→调试] 连日期都没有',
  '',
  '**验收方式**：读字段'
].join('\n');

expect('反例15：老票（无号＋旧日期）⇒ 全算历史债（真问题 0 ✓）', () => {
  const r = lintTickets(OLD_DEBT, { since: '2026-10-25' });
  assert.ok(r.problems.length > 0, '这份样例本身就该有问题');
  assert.equal(r.realProblems.length, 0, '实际还有真问题 ' + r.realProblems.length);
  assert.equal(r.debtProblems.length, r.problems.length, '应全部标成历史债');
});

expect('反例16：无票号但**新日期** ⇒ 算真问题（不许当成历史债 ✗）', () => {
  const r = lintTickets(NEW_NO_ID, { since: '2026-10-25' });
  assert.ok(r.debtProblems.length === 0, '不该有历史债，实际 ' + r.debtProblems.length);
  assert.ok(r.realProblems.some(p => p.kind === '缺票号'), '应报缺票号且算真问题');
});

expect('反例17：无号且**无日期** ⇒ fail-closed 算真问题 ＋ 标 unknown', () => {
  const r = lintTickets(NO_DATE_NO_ID, { since: '2026-10-25' });
  assert.ok(r.debtProblems.length === 0, '不许猜成历史债');
  assert.ok(r.unknownProblems.length > 0, '应标 unknown（判不了）');
});

// ── 18. v1.8：票号只写在标题里 ⇒ 单独报一类 ────────────────────────
const ID_IN_TITLE = [
  '## [ ] [卡片→调试] T-20261026-C18 票号写在标题里（2026-10-26 10:00 UTC+8）',
  '',
  '**验收方式**：读字段'
].join('\n');

expect('反例18：票号只在标题 ⇒ 报「票号只在标题」（别让它变成"交接写错"✗）', () => {
  const k = kinds(ID_IN_TITLE);
  assert.ok(k.includes('票号只在标题'), '实际：' + JSON.stringify(k));
});

// ── 19. v1.8：--json 的稳定契约 ─────────────────────────────────
expect('反例19：buildReport 契约（schemaVersion=1 ＋ 字段齐 ＋ problems 覆盖 total）', () => {
  const r = lintTickets(OLD_DEBT + '\n\n' + NEW_NO_ID, { since: '2026-10-25' });
  const j = buildReport(r, { file: 'x.md' });
  assert.equal(j.schemaVersion, 1);
  assert.equal(j.summary.total, r.problems.length, 'total 应等于 problems 长度');
  assert.equal(j.problems.length, r.problems.length);
  for (const p of j.problems) {
    for (const k of ['kind', 'line', 'title', 'detail', 'debt', 'unknown', 'ticket']) {
      assert.ok(k in p, '缺字段 ' + k + '：' + JSON.stringify(p));
    }
  }
  assert.equal(j.summary.real + j.summary.debt, j.summary.total, '真问题＋历史债 应等于总数');
  assert.equal(j.file, 'x.md');
});

// ── 20. v1.9：划代时刻带时分（制度 21:40 生效 ⇒ 当天早上的票仍算老票 ✓）──────
const SAME_DAY_MORNING = '## [ ] [卡片→调试] 制度生效当天上午的票（2026-10-25 10:00 UTC+8）\n\n**验收方式**：读字段';
const SAME_DAY_NIGHT = '## [ ] [卡片→调试] 制度生效之后的票（2026-10-25 22:30 UTC+8）\n\n**验收方式**：读字段';
const SAME_DAY_NO_TIME = '## [ ] [卡片→调试] 同一天但没写时分（2026-10-25）\n\n**验收方式**：读字段';

expect('反例20：划代带时分 ⇒ 当天上午算历史债 ✓ 当天晚上算真问题 ✓ 只写日期则 fail-closed ✓', () => {
  const opt = { since: '2026-10-25', debtSince: '2026-10-25T21:40' };
  const a = lintTickets(SAME_DAY_MORNING, opt);
  assert.equal(a.debtProblems.length, a.problems.length, '10:00 早于 21:40 ⇒ 应全算历史债，实际真问题 ' + a.realProblems.length);
  const b = lintTickets(SAME_DAY_NIGHT, opt);
  assert.equal(b.debtProblems.length, 0, '22:30 晚于 21:40 ⇒ 不该算历史债');
  const c = lintTickets(SAME_DAY_NO_TIME, opt);
  assert.equal(c.debtProblems.length, 0, '同日但缺时分 ⇒ fail-closed 算真问题');
});

// ── 21. v1.9.1：取数快照（同一张票两个数 ⇒ 得能证明"不是同一份票板"）──────────
expect('反例21：取数快照 —— 同文本 hash 相同 ✓ 改一个字 hash 不同 ✓ 行数/字数对', () => {
  const a = snapshotOf('line1\nline2\n', '2026-10-26 01:00 UTC+8');
  const b = snapshotOf('line1\nline2\n', '2026-10-26 02:00 UTC+8');
  const c = snapshotOf('line1\nline2\nx\n', '2026-10-26 01:00 UTC+8');
  assert.equal(a.hash, b.hash, '同内容 hash 必须相同（时间不算内容 ✓）');
  assert.notEqual(a.hash, c.hash, '改一个字 hash 必须不同');
  assert.equal(a.lines, 3, '行数应按 \\n 切（末行空串也算 ✓），实际 ' + a.lines);
  assert.equal(a.at, '2026-10-26 01:00 UTC+8');
  const j = buildReport(lintTickets(OLD_DEBT, { since: '2026-10-25' }), { snapshot: a });
  assert.equal(j.snapshot.hash, a.hash, 'JSON 应带 snapshot ✓');
});

// ── 22–27. v1.10：GPT 第二轮复核（C01–C08）—— 从"坏行为复现"改成"正向回归"──────
const T = (id, title, body, state = 'x', date = '2026-10-26 01:00 UTC+8') =>
  `## [${state}] [卡片→调试] ${title}（${date}）\n${id ? '**票号**：' + id + '\n' : ''}${body}\n`;
const R = (id, title = '甲') => `> ✅ 调试：回「${title}」 ${id}\n> 证据：自动测试实测；3/3 通过。`;

expect('反例22（C01）：两张票声明同一票号 ⇒ 两边都报「票号重复」', () => {
  const dup = T('T-20261026-D01', '甲', R('T-20261026-D01')) + '\n' + T('T-20261026-D01', '乙', R('T-20261026-D01', '乙'));
  const r = lintTickets(dup, { since: '2026-10-25' });
  const hits = r.problems.filter(p => p.kind === '票号重复');
  assert.equal(hits.length, 2, '两张票都该被报，实际 ' + hits.length);
  assert.ok(/2 张票/.test(hits[0].detail), 'detail 应说明有几张票：' + hits[0].detail);
});

expect('反例23（C03/C04）：一条正确回票不能掩盖另一条错票 / 未点名', () => {
  const mixed = T('T-20261026-D01', '甲', R('T-20261026-D01') + '\n' + '> ✅ 调试：回「别的」 T-20261026-D09');
  assert.ok(kinds(mixed).includes('回票指向别的票'), '正确+错票 ⇒ 仍要报指向别的票');
  const mixed2 = T('T-20261026-D01', '甲', R('T-20261026-D01') + '\n' + '> ✅ 调试：已改完，请复验');
  assert.ok(kinds(mixed2).includes('回票未点名'), '正确+未点名 ⇒ 仍要报未点名');
});

expect('反例24（C05）：正文只是"提到"别人的票号 ⇒ 不算落错块（应报完成缺证据）', () => {
  const a = T('T-20261026-D01', '甲', '', 'x');
  const b = T('T-20261026-D02', '乙', '关联票：T-20261026-D01（只是提一下 ✗ 不是回票）', ' ', '2026-10-26 01:00 UTC+8') + '\n**验收方式**：读字段';
  const k = kinds(a + '\n' + b);
  assert.ok(!k.includes('回票不在票块内'), '普通提及不该判成落错块，实际：' + JSON.stringify(k));
  assert.ok(k.includes('完成缺证据'), '应改报完成缺证据，实际：' + JSON.stringify(k));
});

expect('反例25（C06）：划代当天但缺时分 ⇒ unknown（不算历史债也不算已确认真问题）', () => {
  const r = lintTickets(T(null, '无号', '正文', ' ', '2026-10-25'), { debtSince: '2026-10-25T21:40', since: '2026-10-25' });
  assert.equal(r.debtProblems.length, 0, '不许猜成历史债');
  assert.ok(r.unknownProblems.length > 0, '应进 unknown ⇒ ' + JSON.stringify(r.problems.map(p => p.kind)));
});

expect('反例26（C07）：9:00 与 09:00 必须同分类', () => {
  const mk = (t) => lintTickets(T(null, '无号', '正文', ' ', '2026-10-25 ' + t), { debtSince: '2026-10-25T21:40', since: '2026-10-25' });
  const a = mk('9:00').problems[0], b = mk('09:00').problems[0];
  assert.equal(a.debt, b.debt, '9:00 与 09:00 分类必须一致（实际 ' + a.debt + ' vs ' + b.debt + '）');
  assert.equal(a.unknown, b.unknown, 'unknown 也必须一致');
  assert.equal(a.debt, true, '10-25 09:00 早于 21:40 ⇒ 应是历史债');
});

expect('反例27（C08）：短 hash 会碰撞，但 contentSha256 能分开（对账用它）', () => {
  const a = snapshotOf('备注：Aa\n'), b = snapshotOf('备注：BB\n');
  assert.equal(a.hash, b.hash, '短 hash 本来就该碰撞（所以它不能对账）');
  assert.notEqual(a.contentSha256, b.contentSha256, 'sha256 必须不同');
  assert.ok(/h\*31/.test(a.hashKind), 'hashKind 要说清是 h*31 滚动（它不是 djb2）✗ 实际：' + a.hashKind);
});

// ── 28–30. v1.10.1：GPT 第二轮复核的 F01/F03 + code 契约 ────────────────
expect('反例28（F01）：回票类诊断必须按**所属票**分类（旧票的回票问题算历史债 ✓）', () => {
  const old = '## [x] [卡片→调试] 旧票（2026-10-24 10:00 UTC+8）\n说明：等待核对。\n> ✅ 调试：已处理。\n> 结果：1/1 通过。\n';
  const r = lintTickets(old, { since: '2026-10-25', debtSince: '2026-10-25T21:40' });
  const reply = r.problems.find(p => p.kind === '回票未点名');
  assert.ok(reply, '应报回票未点名');
  assert.equal(reply.debt, true, '旧票的回票问题**必须**算历史债（原来掉进 knownReal ✗）');
  assert.equal(reply.ticketLine, 1, 'ticketLine 应指向票头');
  assert.equal(r.knownRealProblems.length, 0, '这张票不该有任何 knownReal');
});

expect('反例29（F03）：对外行号 1 基（回票在 L3 就报 L3 ✗ 不是 L2）', () => {
  const t = '## [x] [卡片→调试] 甲（2026-10-26 01:00 UTC+8）\n**票号**：T-20261026-D01\n> ✅ 已改完\n';
  const r = lintTickets(t, { since: '2026-10-25' });
  const p = r.problems.find(x => x.kind === '回票未点名');
  assert.equal(p.line, 3, '回票在第 3 行，实际报 L' + p.line);
  // 归位器的 start 必须仍是 0 基（两者不能混）
  const plan = planMoves(t);
  assert.equal(plan.recs[0].start, 2, '归位器 start 仍是 0 基索引');
});

expect('反例30（GPT §6）：code 契约 —— 唯一 ✓ 每个 kind 都有映射 ✓ 输出不漏映射', () => {
  const codes = Object.values(KIND_CODES);
  assert.equal(new Set(codes).size, codes.length, 'code 必须唯一');
  for (const c of codes) assert.ok(/^[a-z]+(-[a-z]+)*$/.test(c), 'code 命名不合规：' + c);
  const sample = [
    '## [ ] [x] 甲（2026-10-26 01:00 UTC+8）',
    '**票号**：T-20261026-D01',
    '**票号**：T-20261026-D02',
    '> ✅ 回「乙」 T-20261026-D09',
    ''
  ].join('\n');
  for (const p of lintTickets(sample, { since: '2026-10-25' }).problems) {
    assert.ok(p.code, 'kind「' + p.kind + '」没有映射 code ✗');
    assert.equal(p.code, KIND_CODES[p.kind], 'code 与映射表不一致：' + p.kind);
  }
});

// ── 31. v1.10.2（GPT §2）：归属查不到 ⇒ 单列 unclassified，绝不混进 knownReal ─────
expect('反例31：归属失配必须单列 unclassified（不许静默算 knownReal）', () => {
  const bad = { kind: '缺票号', code: 'missing-ticket-id', line: 1, ticketLine: 1, title: 'x', detail: '', debt: false, unknown: false, unclassified: true, ticket: '' };
  const res = {
    tickets: [], problems: [bad], realProblems: [bad], debtProblems: [], unknownProblems: [],
    unclassifiedProblems: [bad], knownRealProblems: [],
    cnt: { ' ': 0, '~': 0, v: 0, x: 0, '-': 0, '?': 0 },
    trial: { since: '2026-10-25', n: 0, replies: 0, claim: 0, cited: 0, labeled: 0, dateClash: 0 },
    debtSince: '2026-10-25'
  };
  const j = buildReport(res, {});
  assert.equal(j.summary.knownReal, 0, '归属失配不许算 knownReal');
  assert.equal(j.summary.unclassified, 1, '应单独计数');
  assert.equal(j.problems[0].unclassified, true, 'JSON 每条要带 unclassified');
});

// ── 32. v1.10.4：两个队列要能说出"谁该去执行" ─────────────────────────
expect('反例32：queueOf 要分出"负责人该动"与"验收方该动"，缺字段要单列', () => {
  const text = [
    '## [ ] [卡片→调试] 甲（2026-10-26 01:00 UTC+8）',
    '**票号**：T-20261026-D01',
    '负责人：D｜验收方：C｜阻塞：无',
    '**验收方式**：读字段',
    '',
    '## [v] [卡片→调试] 乙（2026-10-26 01:00 UTC+8）',
    '**票号**：T-20261026-D02',
    '负责人：D｜验收方：C｜阻塞：无',
    '',
    '## [ ] [卡片→调试] 丙（老票没字段）',
    '**验收方式**：读字段'
  ].join('\n');
  const q = queueOf(lintTickets(text, { since: '2026-10-25' }).tickets);
  assert.equal(q.open.length, 2, '待处理应 2 张');
  assert.equal(q.accept.length, 1, '待验收应 1 张');
  assert.equal(q.open[0].owner, 'D', '待处理该动的是负责人 D');
  assert.equal(q.accept[0].acceptor, 'C', '待验收该动的是验收方 C');
  assert.equal(q.missing.length, 1, '没写负责人的票要单列');
  assert.equal(q.missing[0].title.includes('丙'), true);
});

// ── 33. v1.10.5：执行人写具体责任人（代号只提示，不阻止）──────────────────
expect('反例33：负责人/验收方写代号 ⇒ 标出来；写具体责任人不标', () => {
  const mk = (owner, accept) => [
    '## [ ] [卡片→调试] 甲（2026-10-26 01:00 UTC+8）',
    '**票号**：T-20261026-D01',
    '负责人：' + owner + '｜验收方：' + accept + '｜阻塞：无',
    '**验收方式**：读字段'
  ].join('\n');
  const a = queueOf(lintTickets(mk('D', 'C'), { since: '2026-10-25' }).tickets);
  assert.equal(a.open[0].ownerIsCode, true, '单个字母应判为代号');
  assert.equal(a.open[0].acceptorIsCode, true);
  const b = queueOf(lintTickets(mk('D／C／P（各领自己那条）', '流程线'), { since: '2026-10-25' }).tickets);
  assert.equal(b.open[0].ownerIsCode, true, '「D／C／P（…）」去掉括号后仍是代号');
  const c = queueOf(lintTickets(mk('调试', '卡片'), { since: '2026-10-25' }).tickets);
  assert.equal(c.open[0].ownerIsCode, false, '具体责任人不是代号');
  assert.equal(c.open[0].acceptorIsCode, false);
});

// ── 34. v1.10.7（GPT N02/N03）：队列只认正式责任行 ─────────────────────
expect('反例34：示例/引用里的「负责人」不算 —— 应判为缺失', () => {
  const t = [
    '## [ ] [卡片→调试] 甲（2026-10-26 01:00 UTC+8）',
    '**票号**：T-20261026-D01',
    '**验收方式**：读字段',
    '说明：示例 `负责人：调试｜验收方：卡片`',
    '> 历史回票中曾写 负责人：线上发布｜验收方：调试'
  ].join('\n');
  const q = queueOf(lintTickets(t, { since: '2026-10-25' }).tickets);
  assert.equal(q.open[0].owner, '', '不许从示例/引用里捡负责人，实际：' + q.open[0].owner);
  assert.equal(q.missing.length, 1, '应列为缺失');
  // 正式行仍要读得到（含加粗容错）
  const ok = '## [ ] [C→D] 乙（2026-10-26 01:00 UTC+8）\n**票号**：T-20261026-D02\n**负责人**：调试｜**验收方**：卡片\n**验收方式**：读字段';
  const q2 = queueOf(lintTickets(ok, { since: '2026-10-25' }).tickets);
  assert.equal(q2.open[0].owner, '调试', '加粗的正式行也要读得到');
  assert.equal(q2.open[0].acceptor, '卡片');
});

// ── 35. v1.10.7（GPT N01）：buildReport 的回退也必须排除 unclassified ──────
expect('反例35：漏传异常数组时（回退路径）unclassified 不许算进 knownReal', () => {
  const bad = { kind: '缺票号', code: 'missing-ticket-id', line: 1, ticketLine: 1, title: 'x', detail: '', debt: false, unknown: false, unclassified: true, ticket: '' };
  const res = {   // ← 故意**不**传 unclassifiedProblems / knownRealProblems
    tickets: [], problems: [bad], realProblems: [bad], debtProblems: [], unknownProblems: [],
    cnt: { ' ': 0, '~': 0, v: 0, x: 0, '-': 0, '?': 0 },
    trial: { since: '2026-10-25', n: 0, replies: 0, claim: 0, cited: 0, labeled: 0, dateClash: 0 },
    debtSince: '2026-10-25'
  };
  const j = buildReport(res, {});
  assert.equal(j.summary.knownReal, 0, '回退路径也必须排除 unclassified');
  assert.equal(j.summary.unclassified, 1, '回退路径也要能数出异常');
  assert.equal(j.summary.real, 1);
});

// ── 36–37. v1.10.11（五线"缺陷 1"／§九.1）：入口校验与归档警告（真跑 CLI）───
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'ticket-check.mjs');
const runCheck = (args) => {
  try {
    const out = execFileSync(process.execPath, [CHECK_CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};
const OLD = [
  '## [x] [系统线→宿主线] 老票（2026-10-25 15:00 UTC+8）',
  '',
  '负责人：调试｜验收方：宿主｜阻塞：无',
  '**现象 / 目标**：老格式。',
  '**验收方式**：`echo ok`。'
].join('\n');

expect('36（五线缺陷1）：非法 --debt-since 必须 exit 2（不许静默把老票判成真问题）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chk-'));
  try {
    const f = path.join(dir, 'b.md');
    writeFileSync(f, OLD);
    for (const bad of ['不是日期', '2026-13-01', '2026-10-25T25:00', '2026/10/25']) {
      const r = runCheck(['--file', f, '--debt-since', bad]);
      assert.equal(r.code, 2, '--debt-since ' + JSON.stringify(bad) + ' 应 exit 2，实际 ' + r.code + '：' + r.out.slice(0, 100));
      assert.ok(/无法解析成时刻/.test(r.out), '应给出"无法解析成时刻"：' + r.out.slice(0, 120));
    }
    // 合法值仍要能跑，且老票算历史债（不是真问题）
    const ok = runCheck(['--file', f, '--debt-since', '2026-10-25T21:40']);
    assert.equal(ok.code, 0, '合法值应能跑');
    assert.ok(/真问题 0 条/.test(ok.out), '老票应算历史债：' + ok.out.slice(0, 200));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

expect('37（五线§九.1）：把归档文件当票板跑 ⇒ 必须打"这是归档文件"警告', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arc-'));
  try {
    const f = path.join(dir, '待办-归档-20261026.md');
    writeFileSync(f, OLD);
    const r = runCheck(['--file', f]);
    assert.ok(/这是归档文件/.test(r.out), '应打归档警告：' + r.out.slice(0, 200));
    assert.ok(/没有任何可比性/.test(r.out), '应说明数字不可比');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 38–39. v1.10.12（五线"新发现 1／2"）：路径校验 ＋ --strict 退出码 ──────
expect('38（新发现1）：票板路径不存在 ⇒ 三行人话 ＋ exit 2（不许糊 Node 栈）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'path-'));
  try {
    const missing = path.join(dir, '没有这个文件.md');
    const r = runCheck(['--file', missing]);
    assert.equal(r.code, 2, '应 exit 2，实际 ' + r.code);
    assert.ok(/找不到票板文件/.test(r.out), '应说明找不到票板：' + r.out.slice(0, 120));
    assert.ok(/什么都没做/.test(r.out), '应说明什么都没做');
    assert.ok(!/at Object\.|at Module\.|node:internal/.test(r.out), '不许把 Node 栈糊出来：' + r.out.slice(0, 200));
    // ★ v1.10.13（五线"文案瑕疵"）：**例子要指对方向** ✗ 交接文件不许举票板的例子 ✗
    const h = runCheck(['--handoff', missing]);
    assert.equal(h.code, 2, '--handoff 不存在应 exit 2，实际 ' + h.code);
    assert.ok(/例：docs\/交接\.md/.test(h.out), '交接报错应举 docs/交接.md：' + h.out.slice(0, 200));
    assert.ok(!/例：docs\/待办\.md/.test(h.out), '交接报错**不许**举票板的例子');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

expect('39（新发现2）：--strict 有真问题 ⇒ exit 1；没有 ⇒ exit 0', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'strict-'));
  try {
    const badBoard = path.join(dir, 'bad.md');
    writeFileSync(badBoard, '## [ ] [C→D] 没号也没验收（2026-10-26 03:00 UTC+8）\n\n正文。\n');
    const r1 = runCheck(['--file', badBoard, '--strict', '--debt-since', '2026-10-25']);
    assert.equal(r1.code, 1, '有真问题应 exit 1，实际 ' + r1.code + '：' + r1.out.slice(0, 120));
    assert.ok(/--strict/.test(r1.out), '应说明是 strict 导致的 1');
    const goodBoard = path.join(dir, 'good.md');
    writeFileSync(goodBoard, [
      '## [x] [C→D] 合规票（2026-10-26 03:00 UTC+8）', '', '**票号**：T-20261026-D01', '',
      '负责人：调试｜验收方：卡片｜阻塞：无', '**验收方式**：`node x`', '',
      '> ✅ **【03:10 · 调试】** 回「合规票」（T-20261026-D01）'
    ].join('\n'));
    const r2 = runCheck(['--file', goodBoard, '--strict', '--debt-since', '2026-10-25']);
    assert.equal(r2.code, 0, '没有真问题应 exit 0，实际 ' + r2.code + '：' + r2.out.slice(0, 200));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 40. v1.10.14（五线·宿主线现场）：--strict 不许被提前 exit(0) 的分支吞掉 ────
expect('40（宿主线现场）：--strict 与 --json／--queue／--trial 同用也必须 exit 1', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'strict2-'));
  try {
    const bad = path.join(dir, 'bad.md');
    writeFileSync(bad, '## [ ] [C→D] 没号也没验收（2026-10-26 03:00 UTC+8）\n\n正文。\n');
    for (const combo of [['--strict'], ['--strict', '--json'], ['--strict', '--queue'], ['--strict', '--trial'], ['--strict', '--with-handoff']]) {
      const r = runCheck(['--file', bad, '--debt-since', '2026-10-25', ...combo]);
      assert.equal(r.code, 1, combo.join(' ') + ' 应 exit 1，实际 ' + r.code + '：' + r.out.slice(0, 120));
    }
    // --strict --json 的 JSON 仍要能解析（门禁脚本要读 summary）
    const j = runCheck(['--file', bad, '--debt-since', '2026-10-25', '--strict', '--json']);
    const parsed = JSON.parse(j.out.slice(j.out.indexOf('{'), j.out.lastIndexOf('}') + 1));
    assert.equal(parsed.schemaVersion, 1, '--strict --json 的 JSON 仍要可解析');
    const good = path.join(dir, 'good.md');
    writeFileSync(good, [
      '## [x] [C→D] 合规票（2026-10-26 03:00 UTC+8）', '', '**票号**：T-20261026-D01', '',
      '负责人：调试｜验收方：卡片｜阻塞：无', '**验收方式**：`node x`', '',
      '> ✅ **【03:10 · 调试】** 回「合规票」（T-20261026-D01）'
    ].join('\n'));
    const r2 = runCheck(['--file', good, '--debt-since', '2026-10-25', '--strict', '--json']);
    assert.equal(r2.code, 0, '干净板 --strict --json 应 exit 0，实际 ' + r2.code);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 41. v1.10.16（五线 §9.0）：脏板上四条恒等式也必须成立 ────────────────
expect('41（五线§9.0）：identity-check 在**脏板**上也要全成立（脏板模板 A：缺票号）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'idc-'));
  try {
    const f = path.join(dir, 'dirty.md');
    writeFileSync(f, [
      '## [x] [C→D] 合规票（2026-10-26 05:00 UTC+8）', '', '**票号**：T-20261026-D01', '',
      '负责人：调试｜验收方：卡片｜阻塞：无', '**验收方式**：`node x`', '',
      '## [ ] [C→D] 脏板样本A-缺票号（2026-10-26 05:00 UTC+8）', '',
      '负责人：调试｜验收方：卡片｜阻塞：无', '**验收方式**：`node x`', '',
      '## [ ] [C→D] 脏板样本B-无日期', '', '**票号**：T-20261026-D99',
      '负责人：调试｜验收方：卡片｜阻塞：无', '**验收方式**：`node x`'
    ].join('\n'));
    const r = runCheck(['--file', f, '--debt-since', '2026-10-25', '--strict']);
    assert.equal(r.code, 1, '这块脏板有真问题 ⇒ --strict 应 exit 1，实际 ' + r.code);
    const IDC = path.resolve(path.dirname(CHECK_CLI), 'identity-check.mjs');
    const out = execFileSync(process.execPath, [IDC, '--file', f], { encoding: 'utf8', stdio: 'pipe' });
    const s = String(out);
    assert.ok(/四条全成立/.test(s), '脏板上的恒等式也必须成立，实际输出：' + s.slice(0, 300));
    const lines = s.split('\n').filter(l => /^\s+[✓✗]/.test(l));
    assert.equal(lines.length, 4, '应打四条恒等式，实际 ' + lines.length);
    assert.ok(lines.every(l => l.includes('✓')), '四条都得对：' + lines.join(' | '));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 42. v1.10.18（五线 ③）：unknown 的准确边界 —— 三种"只写日期"要分开 ──────
expect('42（五线③）：同日只写日期 ⇒ unknown；跨日只写日期 ⇒ knownReal；没日期 ⇒ unknown', () => {
  const mk = (head) => '## [x] [C→D] ' + head + '\n\n负责人：调试｜验收方：卡片｜阻塞：无\n**验收方式**：`x`\n';
  const opt = { debtSince: '2026-10-25T21:40', since: '2026-10-25' };
  const sameDay = lintTickets(mk('甲（2026-10-25）'), opt);
  const crossDay = lintTickets(mk('乙（2026-10-26）'), opt);
  const noDate = lintTickets(mk('丙'), opt);
  const p = (r) => r.problems.find(x => x.kind === '缺票号') || {};
  assert.equal(p(sameDay).unknown, true, '划代当日只写日期 ⇒ unknown（先后判不了）');
  assert.equal(p(crossDay).unknown, false, '跨日只写日期 ⇒ **可判定**，不是 unknown');
  assert.equal(p(noDate).unknown, true, '完全没写日期 ⇒ unknown');
  assert.equal(sameDay.summary ? 0 : 0, 0);
  assert.equal(crossDay.knownRealProblems.length > 0, true, '跨日那张要进 knownReal');
});

// ── 43–47. v1.10.19（GPT R01–R05）：五个入口契约 ────────────────────────
const mkProj = (cfg) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'proj-'));
  cpSync(path.dirname(CHECK_CLI), path.join(dir, 'tools'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'docs', '.ticketrc.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  return dir;
};
const runIn = (proj, script, args) => {
  try {
    const out = execFileSync(process.execPath, [path.join(proj, 'tools', script), ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

expect('43（R01）：坏配置在**五个入口**都必须 exit 2（不许静默回退默认值）', () => {
  const proj = mkProj('{broken');
  try {
    const board = path.join(proj, 'docs', '待办.md');
    writeFileSync(board, '## [x] [C→D] 甲（2026-10-26）\n\n**票号**：T-20261026-D01\n');
    for (const args of [[], ['--json'], ['--queue'], ['--trial'], ['--strict']]) {
      const r = runIn(proj, 'ticket-check.mjs', args);
      assert.equal(r.code, 2, '坏配置 + ' + (args.join(' ') || '（普通）') + ' 应 exit 2，实际 ' + r.code);
      assert.ok(/配置文件读不了/.test(r.out), '应说明配置读不了：' + r.out.slice(0, 120));
      assert.ok(!/at Object\.|node:internal/.test(r.out), '不许糊 Node 栈');
    }
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

expect('44（R02）：交接是目录 ⇒ exit 2 ＋ 人话（不许先报"没有发现问题"再崩）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ho-'));
  try {
    const board = path.join(dir, 'b.md');
    writeFileSync(board, '## [x] [C→D] 甲（2026-10-26）\n\n**票号**：T-20261026-D01\n');
    for (const extra of [[], ['--json']]) {
      const r = runCheck(['--file', board, '--with-handoff', '--handoff', dir, ...extra]);
      assert.equal(r.code, 2, '交接是目录应 exit 2，实际 ' + r.code + '：' + r.out.slice(0, 120));
      assert.ok(/交接路径不是文件|读不动交接/.test(r.out), '应说清是交接路径问题：' + r.out.slice(0, 160));
      assert.ok(!/at Object\.|node:internal|EISDIR/.test(r.out), '不许糊栈／EISDIR');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

expect('45（R03）：选项缺值 ⇒ exit 2（不许当成"没写"）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nv-'));
  try {
    const board = path.join(dir, 'b.md');
    writeFileSync(board, '## [x] [C→D] 甲（2026-10-26）\n\n**票号**：T-20261026-D01\n');
    for (const args of [['--file', board, '--since'], ['--file', board, '--debt-since'],
      ['--file', board, '--since', '--json'], ['--file'], ['--handoff']]) {
      const r = runCheck(args);
      assert.equal(r.code, 2, args.join(' ') + ' 应 exit 2，实际 ' + r.code + '：' + r.out.slice(0, 100));
      assert.ok(/缺少取值/.test(r.out), '应说"缺少取值"：' + r.out.slice(0, 120));
    }
    const REPLY = path.resolve(path.dirname(CHECK_CLI), 'ticket-reply.mjs');
    const rr = (() => { try { execFileSync(process.execPath, [REPLY, '--file', board, '--write', '--close'], { encoding: 'utf8', stdio: 'pipe' }); return 0; } catch (e) { return e.status; } })();
    assert.equal(rr, 2, 'reply --close 无值应 exit 2，实际 ' + rr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

expect('46（R04）：日历上不存在的日期也要拒绝（2026-02-30 / 2026-04-31 / 2025-02-29）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cal-'));
  try {
    const board = path.join(dir, 'b.md');
    writeFileSync(board, '## [x] [C→D] 甲（2026-10-26）\n\n**票号**：T-20261026-D01\n');
    for (const bad of ['2026-02-30', '2026-04-31', '2025-02-29', '2026-13-01', '2026-00-10']) {
      const r = runCheck(['--file', board, '--debt-since', bad]);
      assert.equal(r.code, 2, bad + ' 应 exit 2，实际 ' + r.code);
    }
    for (const good of ['2026-02-28', '2024-02-29', '2026-04-30', '2026-12-31', '2026-10-25T23:59']) {
      const r = runCheck(['--file', board, '--debt-since', good]);
      assert.equal(r.code, 0, good + ' 应通过，实际 ' + r.code + '：' + r.out.slice(0, 100));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

expect('47（R05）：identity-check 与 ticket-check 必须**同口径**（读同一份配置）', () => {
  const proj = mkProj({ debtSince: '2026-10-25T21:40', since: '2026-10-25', board: 'docs/待办.md' });
  try {
    const board = path.join(proj, 'docs', '待办.md');
    writeFileSync(board, '## [x] [C→D] 旧票（2026-10-25 15:00 UTC+8）\n\n负责人：调试｜验收方：卡片｜阻塞：无\n');
    const c = runIn(proj, 'ticket-check.mjs', ['--json']);
    const cj = JSON.parse(c.out.slice(c.out.indexOf('{'), c.out.lastIndexOf('}') + 1));
    const i = runIn(proj, 'identity-check.mjs', []);
    const m = /real (\d+) ／ debt (\d+)/.exec(i.out);
    assert.ok(m, 'identity 输出应含 real/debt：' + i.out.slice(0, 200));
    assert.equal(Number(m[1]), cj.summary.real, 'real 必须同口径：check ' + cj.summary.real + ' vs identity ' + m[1]);
    assert.equal(Number(m[2]), cj.summary.debt, 'debt 必须同口径：check ' + cj.summary.debt + ' vs identity ' + m[2]);
    assert.ok(/口径：debtSince=2026-10-25T21:40/.test(i.out), 'identity 输出要显示实际口径');
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

// ── 48–50. v1.10.20：传话 → 开票（ticket-relay）────────────────────────
const RELAY = path.resolve(path.dirname(CHECK_CLI), 'ticket-relay.mjs');
const runRelay = (args) => {
  try {
    const out = execFileSync(process.execPath, [RELAY, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};
// 用**临时项目里**的 relay 跑（配置在它自己的 docs/.ticketrc.json ✓）
const runProjRelay = (proj, args) => {
  try {
    const out = execFileSync(process.execPath, [path.join(proj, 'tools', 'ticket-relay.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};
// ★ v1.10.34：票号里的日期是**今天**（本地时区 ✓）⇒ 用例不许写死日期 ✗（跨午夜会假红 ✓ 2026-10-28 02:3x 实测撞到）
const todayStamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()); };
const todayId = (code, nn) => 'T-' + todayStamp() + '-' + code + nn;
// ★ v1.10.34：票号按**当天**编号 ✗ ⇒ 夹具里的"已有票"必须是**今天**的，否则今天第一张就是 D01 而不是 D02 ✓
const RELAY_BOARD = [
  '## [x] [C→D] 已有票（' + todayStamp().slice(0,4) + '-' + todayStamp().slice(4,6) + '-' + todayStamp().slice(6,8) + ' 03:00 UTC+8）',
  '**票号**：' + todayId('D', '01'),
  '**负责人**：调试｜**验收方**：卡片',
  '**阻塞**：无'
].join('\n') + '\n';

expect('48（传话即开票）：预演能生成合规票块，票号接着当天该线最大号 +1', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay48-'));
  try {
    const f = path.join(dir, 'b.md');
    writeFileSync(f, RELAY_BOARD);
    const r = runRelay(['--from', '调试', '--to', '卡片', '--title', '把阈值改成 5', '--file', f]);
    assert.equal(r.code, 0, '预演应 exit 0，实际 ' + r.code + '：' + r.out.slice(0, 120));
    assert.ok(r.out.includes(todayId('D', '02')), '票号应是今天 D02（已有 D01）：期望 ' + todayId('D','02') + '，实际 ' + r.out.slice(0, 300));
    assert.ok(r.out.includes('[调试工程师→卡片工程师]'), '路由也要写职务：' + r.out.slice(0, 300));
    assert.ok(r.out.includes('**负责人**：卡片工程师｜**验收方**：调试工程师'), '负责人/验收方要写成**职务**：' + r.out.slice(0, 300));
    assert.equal(readFileSync(f, 'utf8'), RELAY_BOARD, '预演不许改文件');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

expect('49（传话即开票）：--write 落盘后这张票不带问题，备份落在指定目录', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay49-'));
  try {
    const bak = path.join(dir, 'bak');
    mkdirSync(bak, { recursive: true });
    const f = path.join(dir, 'b.md');
    writeFileSync(f, RELAY_BOARD);
    const r = runRelay(['--from', '调试', '--to', '卡片', '--title', '把阈值改成 5',
      '--accept', '`node tools/ticket-check.mjs` 全绿', '--file', f, '--backup-dir', bak, '--write']);
    assert.equal(r.code, 0, '写入应 exit 0，实际 ' + r.code + '：' + r.out.slice(0, 160));
    const after = readFileSync(f, 'utf8');
    assert.ok(after.includes(todayId('D', '02')), '票没写进去（期望 ' + todayId('D','02') + '）');
    const L = lintTickets(after, { since: '2026-10-26', debtSince: '2026-10-26T00:00' });
    const mine = L.problems.filter((p) => p.ticketLine > 5);
    assert.equal(mine.length, 0, '新票不许自带问题：' + JSON.stringify(mine.map((p) => p.kind)));
    assert.ok(readdirSync(bak).some((n) => n.startsWith('relay-')), '应留下备份');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

expect('50（传话即开票）：参数不合法 ⇒ exit 2（同线／缺标题／认不出线名）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay50-'));
  try {
    const f = path.join(dir, 'b.md');
    writeFileSync(f, RELAY_BOARD);
    for (const args of [
      ['--from', '调试', '--to', '调试', '--title', 'x', '--file', f],
      ['--from', '调试', '--to', '卡片', '--file', f],
      ['--from', '某人', '--to', '卡片', '--title', 'x', '--file', f]
    ]) {
      const r = runRelay(args);
      assert.equal(r.code, 2, args.join(' ') + ' 应 exit 2，实际 ' + r.code);
      assert.equal(readFileSync(f, 'utf8'), RELAY_BOARD, '被拒时不许改文件');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 51–53. v1.10.21（主人：代号/代指没交代清楚负责人）────────────────────
expect('51（责任点名）：负责人/验收方写代指或代号 ⇒ 判"负责人不是具体责任人"', () => {
  const mk = (owner, accept) => [
    '## [ ] [卡片→调试] 甲（2026-10-27 03:00 UTC+8）',
    '**票号**：T-20261027-D01',
    '**负责人**：' + owner + '｜**验收方**：' + accept,
    '**阻塞**：无',
    '**验收方式**：`node x`'
  ].join('\n');
  const opt = { since: '2026-10-26', debtSince: '2026-10-26T00:00' };
  for (const [o, a] of [['你们', '调试'], ['我们', '调试'], ['对方', '调试'], ['下次', '调试'], ['各领自己那条', '调试']]) {
    const r = lintTickets(mk(o, a), opt);
    assert.ok(r.problems.some((p) => p.kind === '负责人不是具体责任人'), '负责人=' + o + ' 应被判不合格');
  }
  for (const [o, a] of [['调试', '卡片'], ['D', '卡片'], ['调试／卡片', '流程线'], ['线上', '调试'], ['调试／卡片（各领自己那条）', '流程线']]) {
    const r = lintTickets(mk(o, a), opt);
    assert.ok(!r.problems.some((p) => p.kind === '负责人不是具体责任人'), '负责人=' + o + ' 不该被判不合格');
  }
});

expect('52（责任点名）：阻塞写"等你们确认" ⇒ 判"阻塞没写清谁"；写线名则不判', () => {
  const mk = (blocker) => [
    '## [~] [调试→卡片] 乙（2026-10-27 03:00 UTC+8）',
    '**票号**：T-20261027-D02',
    '**负责人**：卡片｜**验收方**：调试',
    '**阻塞**：' + blocker,
    '**验收方式**：`node x`'
  ].join('\n');
  const opt = { since: '2026-10-26', debtSince: '2026-10-26T00:00' };
  assert.ok(lintTickets(mk('等你们确认字段清单'), opt).problems.some((p) => p.kind === '阻塞没写清谁'), '代指应被判');
  assert.ok(lintTickets(mk('对方先给清单'), opt).problems.some((p) => p.kind === '阻塞没写清谁'), '对方也应被判');
  assert.ok(!lintTickets(mk('等卡片确认「字段清单 v1」'), opt).problems.some((p) => p.kind === '阻塞没写清谁'), '写了线名不该被判');
  assert.ok(!lintTickets(mk('无'), opt).problems.some((p) => p.kind === '阻塞没写清谁'), '「无」不该被判');
});

expect('53（责任点名）：ticket-relay 把别名/代号归一成标准名再写票', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay53-'));
  try {
    // ★ 2026-11-02：**必须在没有 docs/.ticketrc.json 的隔离根里跑** ✗
    //   本用例断言的是"**内置默认线名**"（流程管理员／发布工程师…）✓
    //   而线名一旦被配置覆盖（样例配置就是 流程／开发／验收），这些断言就不成立 ✗
    //   症状离原因很远：新项目装完（install.mjs 会拷样例配置）自检立刻报红，可工具本身没坏 ✗
    //   ⇒ 拷一份 tools 到临时根（ROOT 变成临时根 ⇒ 读不到配置 ⇒ 走默认名 ✓）
    cpSync(path.dirname(CHECK_CLI), path.join(dir, 'tools'), { recursive: true });
    const ISO_RELAY = path.join(dir, 'tools', 'ticket-relay.mjs');
    const runIso = (args) => {
      try {
        const out = execFileSync(process.execPath, [ISO_RELAY, ...args], { encoding: 'utf8', stdio: 'pipe' });
        return { code: 0, out: String(out) };
      } catch (e) {
        return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
      }
    };
    const f = path.join(dir, 'b.md');
    writeFileSync(f, '## [x] [C→D] 已有（2026-10-27 03:00 UTC+8）\n**票号**：T-20261027-D01\n**负责人**：调试｜**验收方**：卡片\n');
    const r = runIso(['--from', '流程', '--to', '线上', '--title', '归一测试', '--file', f]);
    assert.equal(r.code, 0, '应 exit 0，实际 ' + r.code + '：' + r.out.slice(0, 120));
    assert.ok(r.out.includes('[流程管理员→发布工程师]'), '路由要归一成职务：' + r.out.slice(0, 200));
    assert.ok(r.out.includes('**负责人**：发布工程师｜**验收方**：流程管理员'), '字段要归一成职务');
    const bad = runIso(['--from', '流程线', '--to', '你们', '--title', 'x', '--file', f]);
    assert.equal(bad.code, 2, '--to 写代指应 exit 2，实际 ' + bad.code);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 54–55. v1.10.23（T-20261027-D13）：`--assume-debt` 只改口径，不改判定 ────
expect('54（D13）：--assume-debt 只改"门禁口径"，JSON 里 unknown 照旧、另加 assumedDebt', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ad54-'));
  try {
    const f = path.join(dir, 'b.md');
    // 无票号 + 无日期 ⇒ 判不了年代 ⇒ unknown ✓
    writeFileSync(f, '## [ ] [调试工程师→卡片工程师] 没号也没日期\n\n**负责人**：卡片工程师｜**验收方**：调试工程师\n**阻塞**：无\n**验收方式**：`node x`\n');
    const plain = runCheck(['--file', f, '--json']);
    const j1 = JSON.parse(plain.out.slice(plain.out.indexOf('{'), plain.out.lastIndexOf('}') + 1));
    assert.equal(j1.summary.assumedDebt, false, '不带开关时 assumedDebt 必须是 false');
    assert.ok(j1.summary.unknown > 0, '这块板应有 unknown');
    const assumed = runCheck(['--file', f, '--json', '--assume-debt']);
    const j2 = JSON.parse(assumed.out.slice(assumed.out.indexOf('{'), assumed.out.lastIndexOf('}') + 1));
    assert.equal(j2.summary.assumedDebt, true, '带开关时 assumedDebt 必须是 true');
    assert.equal(j2.summary.unknown, j1.summary.unknown, '**判定不许被改**：unknown 数必须一样');
    assert.equal(j2.summary.real, j1.summary.real, 'real 也不许被改');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

expect('55（D13）：--strict 的门禁随口径变 —— 只有 unknown 时，加开关后应 exit 0', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ad55-'));
  try {
    const f = path.join(dir, 'b.md');
    writeFileSync(f, '## [ ] [调试工程师→卡片工程师] 没号也没日期\n\n**负责人**：卡片工程师｜**验收方**：调试工程师\n**阻塞**：无\n**验收方式**：`node x`\n');
    const r1 = runCheck(['--file', f, '--strict']);
    assert.equal(r1.code, 1, '只有 unknown 时，普通 --strict 应 exit 1（fail-closed）实际 ' + r1.code);
    const r2 = runCheck(['--file', f, '--strict', '--assume-debt']);
    assert.equal(r2.code, 0, '--assume-debt 下（knownReal 0）应 exit 0，实际 ' + r2.code + '：' + r2.out.slice(0, 200));
    // 有 knownReal 时，开关不该把门放开 ✗
    const g = path.join(dir, 'g.md');
    writeFileSync(g, '## [ ] [调试工程师→卡片工程师] 有号但无验收方式（2026-10-27 04:00 UTC+8）\n\n**票号**：T-20261027-D01\n**负责人**：卡片工程师｜**验收方**：调试工程师\n**阻塞**：无\n');
    const r3 = runCheck(['--file', g, '--strict', '--assume-debt', '--debt-since', '2026-10-26']);
    assert.equal(r3.code, 1, '有已确认新增问题时，加 --assume-debt 也必须 exit 1，实际 ' + r3.code);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 56–57. v1.10.24（T-20261027-P01）：临时项目必须**按线隔离** ────────────
const MK = path.resolve(path.dirname(CHECK_CLI), 'mk-proj.mjs');
const runMk = (args) => {
  try {
    const out = execFileSync(process.execPath, [MK, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: String(out).trim() };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '').trim() + String(e.stderr || '') };
  }
};

expect('56（P01）：mk-proj 每次给**不同**路径，且造出来的项目能直接跑', () => {
  const a = runMk(['--line', 'D']);
  const b = runMk(['--line', 'P']);
  const pa = path.join(a.out, 'docs', '待办.md');
  try {
    assert.equal(a.code, 0, 'mk-proj 应 exit 0，实际 ' + a.code);
    assert.ok(existsSync(pa), '路径应是项目根（含 docs/待办.md）：' + a.out);
    assert.notEqual(a.out, b.out, '两条线必须拿到**不同**路径 ✗（共用路径正是 P01 的事故）');
    const r = execFileSync(process.execPath, [path.join(a.out, 'tools', 'ticket-check.mjs'), '--strict'], { encoding: 'utf8', stdio: 'pipe' });
    assert.ok(String(r).length > 0, '临时项目里的检查器应能跑');
  } finally {
    runMk(['--clean', a.out]);
    runMk(['--clean', b.out]);
  }
});

expect('57（P01）：--clean 只删本工具造的目录（别的目录拒删 ✗）', () => {
  const a = runMk(['--line', 'F']);
  try {
    assert.ok(existsSync(a.out), '应先存在');
    const bad = runMk(['--clean', path.resolve(path.dirname(CHECK_CLI), '..', 'docs')]);
    assert.equal(bad.code, 2, '删非 fj-proj-* 目录必须 exit 2，实际 ' + bad.code);
    assert.ok(existsSync(path.resolve(path.dirname(CHECK_CLI), '..', 'docs', '待办.md')), 'docs/ 必须毫发无伤');
    const ok = runMk(['--clean', a.out]);
    assert.equal(ok.code, 0, '删自己造的目录应 exit 0');
    assert.ok(!existsSync(a.out), '应已删除');
  } finally { rmSync(a.out, { recursive: true, force: true }); }
});

// ── 58. v1.10.25（T-20261027-D16 误报）：多负责人的票，一条线回票不算"状态没推" ──
expect('58（D16 误报）：多负责人票不回判"状态没推"；单负责人票仍判', () => {
  const mk = (owner, accept, id) => [
    '## [ ] [调试工程师→卡片工程师] 票（2026-10-27 05:00 UTC+8）',
    '',
    '**票号**：' + id,
    '**负责人**：' + owner + '｜**验收方**：' + accept,
    '**阻塞**：无',
    '**验收方式**：`node x`',
    '',
    '> ✅ **【05:10 · 卡片工程师】** 回「票」（' + id + '）'
  ].join('\n');
  const opt = { since: '2026-10-26', debtSince: '2026-10-26T00:00' };
  const one = lintTickets(mk('卡片工程师', '调试工程师', 'T-20261027-D01'), opt);
  assert.ok(one.problems.some((p) => p.kind === '回票了但状态没推'), '单负责人：还没开始就有回票，应被判');
  const multi = lintTickets(mk('卡片工程师／发布工程师', '调试工程师', 'T-20261027-D02'), opt);
  assert.ok(!multi.problems.some((p) => p.kind === '回票了但状态没推'), '多负责人：一条线回了不算全部回，不该判');
});

// ── 59–60. v1.10.26（Q线 §三）：名字表可配置 ＋ [~] 返工不再误报 ──────────
expect('59（Q线§三.1）：别的项目可以在 .ticketrc.json 里配自己的线名（不写死）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lines59-'));
  try {
    const proj = mkProj({ debtSince: '2026-10-26T00:00', since: '2026-10-26', board: 'docs/待办.md',
      lines: { '宿主线': ['H', '宿主'], 'Q线': 'Q' } });
    try {
      const f = path.join(proj, 'docs', '待办.md');
      writeFileSync(f, [
        '## [ ] [宿主线→Q线] 用别家的线名（2026-10-27 05:00 UTC+8）', '',
        '**票号**：T-20261027-H01',
        '**负责人**：Q线｜**验收方**：宿主线',
        '**阻塞**：无', '**验收方式**：`node x`'
      ].join('\n'));
      const r = runIn(proj, 'ticket-check.mjs', ['--json']);
      const j = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
      const bad = j.problems.filter(p => p.kind === '负责人不是具体责任人');
      assert.equal(bad.length, 0, '配了自己的线名后不该再判"不是具体责任人"：' + JSON.stringify(bad.map(p => p.detail)));
      // 括号两种顺序都要认 ✓
      writeFileSync(f, [
        '## [ ] [宿主线→Q线] 括号顺序（2026-10-27 05:00 UTC+8）', '',
        '**票号**：T-20261027-H02',
        '**负责人**：H（宿主）｜**验收方**：Q线（Q）',
        '**阻塞**：无', '**验收方式**：`node x`'
      ].join('\n'));
      const r2 = runIn(proj, 'ticket-check.mjs', ['--json']);
      const j2 = JSON.parse(r2.out.slice(r2.out.indexOf('{'), r2.out.lastIndexOf('}') + 1));
      assert.equal(j2.problems.filter(p => p.kind === '负责人不是具体责任人').length, 0, '代号（H）在括号里也认');
    } finally { rmSync(proj, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

expect('60（Q线§三.2）：返工把 [v] 退回 [~] 时，旧回票不再报"状态没推"（[ ] 仍报）', () => {
  const mk = (state) => [
    state + ' [调试工程师→卡片工程师] 票（2026-10-27 05:00 UTC+8）', '',
    '**票号**：T-20261027-D01',
    '**负责人**：卡片工程师｜**验收方**：调试工程师',
    '**阻塞**：无', '**验收方式**：`node x`', '',
    '> ✅ **【05:10 · 卡片工程师】** 回「票」（T-20261027-D01）'
  ].join('\n');
  const opt = { since: '2026-10-26', debtSince: '2026-10-26T00:00' };
  assert.ok(lintTickets(mk('## [ ]'), opt).problems.some((p) => p.kind === '回票了但状态没推'), '[ ] 有回票仍应判');
  assert.ok(!lintTickets(mk('## [~]'), opt).problems.some((p) => p.kind === '回票了但状态没推'), '[~] 返工不该判（旧回票会一直在）');
});

// ── 61–62. v1.10.27（Q线）：配了 lines 也要能生成票号（或给 --code）──────
expect('61（Q线）：配了 lines 的项目，ticket-relay 能用自定义线名开票（票号字母取短码）', () => {
  const proj = mkProj({ debtSince: '2026-10-26T00:00', since: '2026-10-26', board: 'docs/待办.md',
    lines: { '开票系统线': ['Q', '开票'], '宿主机线': ['H', '宿主'] } });
  try {
    const f = path.join(proj, 'docs', '待办.md');
    writeFileSync(f, [
      '## [x] [开票系统线→宿主机线] 已有（' + todayStamp().slice(0,4) + '-' + todayStamp().slice(4,6) + '-' + todayStamp().slice(6,8) + ' 05:00 UTC+8）', '',
      '**票号**：' + todayId('Q', '01'),
      '**负责人**：宿主机线｜**验收方**：开票系统线',
      '**阻塞**：无', '**验收方式**：`node x`'
    ].join('\n'));
    const r = runProjRelay(proj, ['--from', '开票系统线', '--to', '宿主机线', '--title', '配了 lines 也能开票', '--file', f]);
    assert.equal(r.code, 0, '应 exit 0，实际 ' + r.code + '：' + r.out.slice(0, 160));
    assert.ok(r.out.includes(todayId('Q', '02')), '票号字母应取配置里的短码 Q（已有 Q01 ⇒ Q02）：期望 ' + todayId('Q','02') + '：' + r.out.slice(0, 300));
    assert.ok(r.out.includes('**负责人**：宿主机线｜**验收方**：开票系统线'), '票面用配置里的名字');
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

expect('62（Q线）：配置里没有短码 ⇒ 明确报错并提示三条路；给 --code 就能开', () => {
  const proj = mkProj({ board: 'docs/待办.md', debtSince: '2026-10-26T00:00',
    lines: { '宿主线': ['宿主'] } });
  try {
    const f = path.join(proj, 'docs', '待办.md');
    writeFileSync(f, '## [x] [调试工程师→卡片工程师] 已有（2026-10-27 05:00 UTC+8）\n\n**票号**：T-20261027-D01\n**负责人**：卡片工程师｜**验收方**：调试工程师\n**阻塞**：无\n**验收方式**：`x`\n');
    const bad = runProjRelay(proj, ['--from', '宿主线', '--to', '调试', '--title', 'x', '--file', f]);
    assert.equal(bad.code, 2, '没短码应 exit 2，实际 ' + bad.code);
    assert.ok(/--code/.test(bad.out) && /lines/.test(bad.out), '报错要给出三条路（--code／lines 短码／内置职务）：' + bad.out.slice(0, 200));
    const ok = runProjRelay(proj, ['--from', '宿主线', '--to', '调试', '--title', 'x', '--code', 'Z', '--file', f]);
    assert.equal(ok.code, 0, '--code 应放行，实际 ' + ok.code + '：' + ok.out.slice(0, 160));
    assert.ok(ok.out.includes(todayId('Z', '01')), '应生成今天 Z01：期望 ' + todayId('Z','01') + '：' + ok.out.slice(0, 200));
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

// ── 63–65. v1.10.28（主人）：闭环五问 ────────────────────────────────
expect('63（闭环）：活跃票久无回票 ⇒ 算"事事有回应"未闭环', () => {
  const t = [
    '## [ ] [流程图→卡片工程师] 没人回的老票（2026-10-20 10:00 UTC+8）', '',
    '**票号**：T-20261020-C01',
    '**负责人**：卡片工程师｜**验收方**：流程管理员',
    '**阻塞**：无',
    '**验收方式**：`node x`',
    '', '**请确认**：这个阈值取 3 还是 5？'
  ].join('\n');
  const ts = lintTickets(t, { since: '2026-10-01' }).tickets;
  const r = closedLoop(ts, { replyHours: 24, acceptHours: 12, now: '2026-10-27T12:00:00+08:00' });
  assert.equal(r.reply.length, 1, '应报 1 条"没人回"');
  assert.equal(r.answered.length, 1, '票面有疑问且没回票 ⇒ 也算"句句有回答"未闭环');
});

expect('64（闭环）：[v] 久未关 ⇒ 算"沟通有闭环"未闭环；刚推的不算', () => {
  const mk = (stamp) => [
    '## [v] [流程图→卡片工程师] 等验收（' + stamp + '）', '',
    '**票号**：T-20261027-C01',
    '**负责人**：卡片工程师｜**验收方**：流程管理员',
    '**阻塞**：无', '**验收方式**：`node x`', '',
    '> ✅ **【10:00 · 卡片工程师】** 回「等验收」（T-20261027-C01）'
  ].join('\n');
  const now = '2026-10-27T12:00:00+08:00';
  const old = closedLoop(lintTickets(mk('2026-10-26 10:00 UTC+8'), { since: '2026-10-01' }).tickets, { acceptHours: 12, now });
  assert.equal(old.closed.length, 1, '超过 12h 未关应报');
  const fresh = closedLoop(lintTickets(mk('2026-10-27 11:00 UTC+8'), { since: '2026-10-01' }).tickets, { acceptHours: 12, now });
  assert.equal(fresh.closed.length, 0, '刚推的不该报');
});

expect('65（闭环）：干净闭环的票 —— 五问全 0', () => {
  const t = [
    '## [x] [流程图→卡片工程师] 已闭环（2026-10-27 09:00 UTC+8）', '',
    '**票号**：T-20261027-C02',
    '**负责人**：卡片工程师｜**验收方**：流程管理员',
    '**阻塞**：无', '**验收方式**：`node x`', '',
    '> ✅ **【10:00 · 卡片工程师】** 回「已闭环」（T-20261027-C02）'
  ].join('\n');
  const r = closedLoop(lintTickets(t, { since: '2026-10-01' }).tickets, { replyHours: 24, acceptHours: 12, now: '2026-10-27T12:00:00+08:00' });
  for (const k of ['reply', 'landed', 'accounted', 'answered', 'closed']) assert.equal(r[k].length, 0, k + ' 应为 0');
});

// ── 66–67. v1.10.29（主人）：每次升级必须开分发票并有回票 ────────────────
expect('66（升级必分发）：票板提到最新版本却没有分发票 ⇒ 算未闭环', () => {
  const t = [
    '## [x] [流程管理员→卡片工程师] 顺手提了一句 v1.10.30（2026-10-27 09:00 UTC+8）', '',
    '**票号**：T-20261027-F01',
    '**负责人**：卡片工程师｜**验收方**：流程管理员', '**阻塞**：无', '**验收方式**：`x`', '',
    '> ✅ **【10:00 · 卡片工程师】** 回「顺手提了一句 v1.10.30」（T-20261027-F01）'
  ].join('\n');
  const r = closedLoop(lintTickets(t, { since: '2026-10-01' }).tickets, { now: '2026-10-27T12:00:00+08:00' });
  assert.equal(r.distributed.length, 1, '应报 1 条"没有分发票"');
  assert.ok(r.distributed[0].why.includes('v1.10.30'), '要说清是哪个版本：' + r.distributed[0].why);
});

expect('67（升级必分发）：有分发票但没人回 ⇒ 报"还没有回票"；回了就过', () => {
  const head = (withReply) => [
    '## [x] [流程管理员→卡片工程师／发布工程师] 升级分发 v1.10.31（2026-10-27 09:00 UTC+8）', '',
    '**票号**：T-20261027-F02',
    '**负责人**：卡片工程师／发布工程师｜**验收方**：流程管理员', '**阻塞**：无', '**验收方式**：`x`', '',
    withReply ? '> ✅ **【10:00 · 卡片工程师】** 回「升级分发 v1.10.31」（T-20261027-F02）' : ''
  ].join('\n');
  const opt = { since: '2026-10-01', now: '2026-10-27T12:00:00+08:00' };
  const no = closedLoop(lintTickets(head(false), opt).tickets, opt);
  assert.equal(no.distributed.length, 1, '没人回应报');
  assert.ok(no.distributed[0].why.includes('还没有任何回票'), '原因要说清：' + no.distributed[0].why);
  const yes = closedLoop(lintTickets(head(true), opt).tickets, opt);
  assert.equal(yes.distributed.length, 0, '有回票就算闭环（未回的另记"未签收"✓）');
});

// ── 68–69. v1.10.30：闭环"六问"的字面一致性 ──────────────────────────
expect('68（六问）：--loop 的标题与结语都必须是"六问"（加了第 ⑥ 问却没改字 ✗）', () => {
  const r = runCheck(['--loop']);
  assert.equal(r.code, 0, '--loop 恒 exit 0，实际 ' + r.code);
  assert.ok(r.out.includes('闭环六问'), '标题必须写"闭环六问"：' + r.out.slice(0, 80));
  // 结语取决于**当前票板**（有未闭环项时不会打"全闭环"✗）⇒ 只断言"不再出现五问"✓
  assert.ok(!r.out.includes('五问'), '不许再出现"五问"字样 ✗：' + r.out.slice(0, 80));
  assert.ok(r.out.includes('六问'), '必须出现"六问" ✓');
});

// ── 69–70. v1.10.32（T-20261027-P02）：引用代码块里的 ✅ 不算回票 ──────────
expect('69（P02）：`> ``` ` 引用围栏里的 ✅ 不算回票记录（以前会假红）', () => {
  const A = [
    '## [x] [调试工程师→卡片工程师] 有引用围栏（2026-10-27 10:00 UTC+8）', '',
    '**票号**：T-20261027-D01',
    '**负责人**：卡片工程师｜**验收方**：调试工程师',
    '**阻塞**：无', '**验收方式**：`x`', '',
    '> ✅ **【10:10 · 卡片工程师】** 回「有引用围栏」（T-20261027-D01）',
    '>', '> ```', '> ✅ 自检：通过 69 / 失败 0', '> ✅ 回票归位自检：通过 16 / 失败 0', '> ```'
  ].join('\n');
  const opt = { since: '2026-10-26', debtSince: '2026-10-26T00:00' };
  const r = lintTickets(A, opt);
  assert.equal(r.tickets[0].replies.length, 1, '引用围栏里的 ✅ 不许被当成新记录（应只有 1 条）');
  assert.equal(r.problems.filter((p) => p.kind === '回票未点名').length, 0, '不许假红"回票未点名"');
});

expect('70（P02）：**不带围栏**的 `> ✅ …` 仍要算回票（没把功能一起关掉）', () => {
  const B = [
    '## [x] [调试工程师→卡片工程师] 没有围栏（2026-10-27 10:00 UTC+8）', '',
    '**票号**：T-20261027-D01',
    '**负责人**：卡片工程师｜**验收方**：调试工程师',
    '**阻塞**：无', '**验收方式**：`x`', '',
    '> ✅ **【10:10 · 卡片工程师】** 回「没有围栏」（T-20261027-D01）', '',
    '> ✅ 这一行没有点名，也没有票号（对照：应该被判）'
  ].join('\n');
  const opt = { since: '2026-10-26', debtSince: '2026-10-26T00:00' };
  const r = lintTickets(B, opt);
  assert.equal(r.tickets[0].replies.length, 2, '没围栏的两条都要算记录');
  assert.ok(r.problems.some((p) => p.kind === '回票未点名'), '没点名那条仍要判');
});

// ── 71–72. v1.10.33（主人）：版本节奏三档 —— 小修不打包、不要回票 ──────────
expect('71（版本节奏）：热修／中修／大修 判得对（小修不许逼人回票）', () => {
  const t = (x) => releaseTier(x).tier;
  assert.equal(t({ changed: [], addDel: 0 }), '无改动', '没改就别说要发版');
  assert.equal(t({ changed: [{ k: 'tools/ticket-relay.mjs', kind: '改' }], addDel: 8 }), '热修', '一处 ≤15 行 ⇒ 热修');
  assert.equal(releaseTier({ changed: [{ k: 'tools/ticket-relay.mjs', kind: '改' }], addDel: 8 }).need, false, '热修**不需要**打版／回票 ✗');
  assert.equal(t({ changed: [{ k: 'a', kind: '改' }, { k: 'b', kind: '改' }], addDel: 40 }), '中修', '两处 ⇒ 中修');
  assert.equal(t({ changed: [{ k: 'tools/mk-proj.mjs', kind: '新增' }], addDel: 120 }), '中修', '新增文件 ⇒ 至少中修');
  assert.equal(t({ changed: [{ k: 'x', kind: '改' }], addDel: 3, contract: ['ticket-lint.mjs'] }), '中修', '碰判据/契约 ⇒ 至少中修');
  assert.equal(t({ changed: [{ k: 'x', kind: '改' }], addDel: 3, major: true }), '大修', '显式 --major ⇒ 大修');
  assert.equal(releaseTier({ changed: [{ k: 'x', kind: '改' }], addDel: 3, major: true }).mustReply, true, '大修必须回票');
});

expect('72（版本节奏）：20 行以上的一处修改不算热修（别把中修当小修混过去）', () => {
  assert.equal(releaseTier({ changed: [{ k: 'tools/ticket-check.mjs', kind: '改' }], addDel: 24 }).tier, '中修', '24 行 ⇒ 中修');
  assert.equal(releaseTier({ changed: [{ k: 'tools/ticket-check.mjs', kind: '改' }], addDel: 24 }).need, true, '中修要打版');
});

// ── 73–74. v1.10.34（T-20261028-F01 现场）：备份写不进去就退到临时目录 ──────
expect('73（备份兜底）：仓内 .backups 不可写 ⇒ 退到系统临时目录并标记 fallback', () => {
  /* ★ T-20261030-F02（Q线）：**不许写死 `C:\Windows\…`** ✗
     现场：Linux 上那串是**合法可写相对路径** ⇒ 用例假红（79 变 78/1）＋ 在仓根建出垃圾目录 ✗
     跨平台做法：临时目录里放一个**名字叫 .backups 的文件** ⇒ `mkdirSync(dir,{recursive})` 必然 EEXIST/ENOTDIR ✓
     （不用 chmod 0500：Windows 上 chmod 拦不住往目录里写 ✗ 那又会变成"只在 Linux 绿"✗）
     收尾：临时根目录整棵删掉 ⇒ 不留目录 ✓ 不碰仓根 ✓ */
  const root = mkdtempSync(path.join(tmpdir(), 'bk73-'));
  try {
    writeFileSync(path.join(root, '.backups'), 'not-a-dir');
    const res = writeBackup(root, 'probe-73.txt', 'hello-73');
    assert.equal(res.fallback, true, '不可写时必须是 fallback ✓');
    assert.ok(res.path.startsWith(tmpdir()), '应退到系统临时目录：' + res.path);
    assert.ok(existsSync(res.path), '临时目录里应真有这份文件 ✓');
    rmSync(res.path, { force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

expect('74（备份兜底）：可写时仍用仓内 .backups（不许一律退临时 ✗）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bk74-'));
  try {
    const r = writeBackup(dir, 'p.txt', 'x');
    assert.equal(r.fallback, false, '可写时不该退 ✓');
    assert.ok(r.dir.endsWith('.backups'), '应落在 <root>/.backups：' + r.dir);
    assert.ok(existsSync(r.path), '文件应存在 ✓');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 75–76. v1.10.35（2026-10-29 现场 MALFORMED_RESPONSE）：长文本走文件 ──────
expect('75（长文本走文件）：--why-file 里的引号／反引号／换行原样进票面', () => {
  const proj = mkProj({ board: 'docs/待办.md', since: '2026-10-01', debtSince: '2025-10-01T00:00' });
  try {
    const f = path.join(proj, 'docs', '待办.md');
    writeFileSync(f, '## [x] [调试工程师→卡片工程师] 已有（2026-10-27 05:00 UTC+8）\n\n**票号**：T-20261027-D01\n**负责人**：卡片工程师｜**验收方**：调试工程师\n**阻塞**：无\n**验收方式**：`x`\n');
    const why = path.join(proj, 'why.txt');
    writeFileSync(why, '带 "双引号" 和 `反引号`\n还有第二行 ✓\n');
    const r = runProjRelay(proj, ['--from', '调试工程师', '--to', '卡片工程师', '--title', '长文本测试', '--why-file', why, '--accept', '`node x`', '--file', f]);
    assert.equal(r.code, 0, '应 exit 0，实际 ' + r.code + '：' + r.out.slice(0, 200));
    assert.ok(r.out.includes('带 "双引号" 和 `反引号`'), '引号与反引号必须原样保留：' + r.out.slice(0, 400));
    assert.ok(r.out.includes('还有第二行'), '换行内容也要保留');
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

expect('76（长文本走文件）：--why-file 指向不存在的文件 ⇒ exit 2，不退回内联', () => {
  const proj = mkProj({ board: 'docs/待办.md', since: '2026-10-01', debtSince: '2025-10-01T00:00' });
  try {
    const f = path.join(proj, 'docs', '待办.md');
    writeFileSync(f, '## [x] [调试工程师→卡片工程师] 已有（2026-10-27 05:00 UTC+8）\n\n**票号**：T-20261027-D01\n**负责人**：卡片工程师｜**验收方**：调试工程师\n**阻塞**：无\n**验收方式**：`x`\n');
    const before = readFileSync(f, 'utf8');
    const r = runProjRelay(proj, ['--from', '调试工程师', '--to', '卡片工程师', '--title', 'x', '--why-file', path.join(proj, 'nope.txt'), '--accept', 'x', '--file', f]);
    assert.equal(r.code, 2, '读不到文件应 exit 2，实际 ' + r.code);
    assert.ok(/读不到/.test(r.out), '要说清读不到：' + r.out.slice(0, 200));
    assert.equal(readFileSync(f, 'utf8'), before, '失败时不许改票板');
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

// ── 77–78. v1.10.36（Q线 2026-10-30 现场）：广播票要能看出"哪几线已回" ──────
expect('77（Q线§八）：多负责人票，queueOf 给出"已回／待回"逐个线名', () => {
  const t = [
    '## [ ] [流程管理员→调试工程师／卡片工程师／发布工程师] 广播票（2026-10-30 03:00 UTC+8）', '',
    '**票号**：T-20261030-F01',
    '**负责人**：调试工程师／卡片工程师／发布工程师｜**验收方**：流程管理员',
    '**阻塞**：无', '**验收方式**：`node x`', '',
    '> ✅ **【03:10 · 卡片工程师：签收】** 回「广播票」（T-20261030-F01）'
  ].join('\n');
  const q = queueOf(lintTickets(t, { since: '2026-10-29' }).tickets);
  const r = q.open[0];
  assert.equal(r.multi, true, '应识别为多负责人');
  assert.deepEqual(r.repliedOwners, ['卡片工程师'], '已回应只有卡片工程师：' + JSON.stringify(r.repliedOwners));
  assert.deepEqual(r.pendingOwners, ['调试工程师', '发布工程师'], '待回应剩两条：' + JSON.stringify(r.pendingOwners));

  /* ★ T-20261030-F02（Q线 2026-10-30 现场）：回票首行写「职务（代号）」也要认 ✗
     现场合成板：`✅ **【05:11 · 调试工程师（D）】**` ⇒ 以前恒显示「已回（还没有）」✗ 去掉（D）就正常 ✓ */
  const t2 = t + '\n> ✅ **【03:20 · 调试工程师（D）】** 回「广播票」（T-20261030-F01）';
  const r2 = queueOf(lintTickets(t2, { since: '2026-10-29' }).tickets).open[0];
  assert.deepEqual([...r2.repliedOwners].sort(), ['卡片工程师', '调试工程师'].sort(), '「职务（代号）」要认出：' + JSON.stringify(r2.repliedOwners));
  assert.deepEqual(r2.pendingOwners, ['发布工程师'], '待回应只剩发布工程师：' + JSON.stringify(r2.pendingOwners));

  /* 本仓 lines 里的别名（调试／调试线／D）同样归一 ✓ */
  const t3 = t + '\n> ✅ **【03:22 · 调试线】** 回「广播票」（T-20261030-F01）';
  const r3 = queueOf(lintTickets(t3, { since: '2026-10-29' }).tickets).open[0];
  assert.ok(r3.repliedOwners.includes('调试工程师'), '别名也要归一：' + JSON.stringify(r3.repliedOwners));

  /* 三家回齐 ⇒ 待回空（ticket-check 显示「（全回了 ✓）」）✓ */
  const t4 = t2 + '\n> ✅ **【03:25 · 发布工程师（P）】** 回「广播票」（T-20261030-F01）';
  const r4 = queueOf(lintTickets(t4, { since: '2026-10-29' }).tickets).open[0];
  assert.deepEqual(r4.pendingOwners, [], '三家回齐后待回应为空：' + JSON.stringify(r4.pendingOwners));
});

expect('78（Q线§八）：owner-not-a-name 文案要提到"你 .ticketrc.json 的 lines 里配的名字"', () => {
  const t = [
    '## [ ] [调试工程师→卡片工程师] 坏名（2026-10-30 04:00 UTC+8）', '',
    '**票号**：T-20261030-D01',
    '**负责人**：我们｜**验收方**：卡片工程师',
    '**阻塞**：无', '**验收方式**：`node x`'
  ].join('\n');
  const r = lintTickets(t, { since: '2026-10-29', debtSince: '2026-10-29T00:00' });
  const p = r.problems.find((x) => x.kind === '负责人不是具体责任人');
  assert.ok(p, '应收录这条问题');
  assert.ok(p.detail.includes('lines'), '文案必须提 lines 配置：' + p.detail.slice(0, 120));
  assert.ok(p.detail.includes('.ticketrc.json'), '要点名配置文件名');
});

// ── 79–81. v1.10.37（借 dsh-superagent）：代回判定 ＋ 健康不占屏 ────────────
expect('79（代回）：签名不是负责人/验收方 ⇒ impersonated；是项目负责人 ⇒ 放行', () => {
  const mk = (signer, owner, acceptor) => [
    '## [ ] [流程图→卡片工程师] 代回测试（2026-11-01 01:00 UTC+8）', '',
    '**票号**：T-20261101-C01',
    '**负责人**：' + owner + '｜**验收方**：' + acceptor,
    '**阻塞**：无', '**验收方式**：`node x`', '',
    '> ✅ **【01:10 · ' + signer + '】** 回「代回测试」（T-20261101-C01）'
  ].join('\n');
  const imp = (txt) => impersonatedOf(lintTickets(txt, { since: '2026-10-01' }).tickets[0]);

  const a = imp(mk('调试工程师', '卡片工程师', '流程管理员'));
  assert.equal(a.impersonated, true, '调试工程师替卡片工程师回 ⇒ 代回');
  assert.equal(a.signer, '调试工程师', '签名要归一成标准职务：' + a.signer);

  const b = imp(mk('卡片工程师', '卡片工程师', '流程管理员'));
  assert.equal(b.impersonated, false, '本人回不算代回');

  const c = imp(mk('主人', '卡片工程师', '流程管理员'));
  assert.equal(c.impersonated, false, '项目负责人（主人）回票放行');
});

expect('80（代回）：认不出签名（自由文本）时**不猜** ✗ 不判代回', () => {
  const t = [
    '## [ ] [流程图→卡片工程师] 自由签名（2026-11-01 01:00 UTC+8）', '',
    '**票号**：T-20261101-C02',
    '**负责人**：卡片工程师｜**验收方**：流程管理员',
    '**阻塞**：无', '**验收方式**：`node x`', '',
    '> ✅ **【01:10 · 主人确认 + 结清】** 回「自由签名」（T-20261101-C02）'
  ].join('\n');
  const r = impersonatedOf(lintTickets(t, { since: '2026-10-01' }).tickets[0]);
  assert.equal(r.impersonated, false, '认不出的签名不许当代回 ✗');
});

expect('81（健康不占屏）：干净板上 --loop 只打一行结论，不逐段展开', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop81-'));
  try {
    const f = path.join(dir, 'b.md');
    writeFileSync(f, '## [x] [调试工程师→卡片工程师] 干净（2026-11-01 01:00 UTC+8）\n\n**票号**：T-20261101-D01\n**负责人**：卡片工程师｜**验收方**：调试工程师\n**阻塞**：无\n**验收方式**：`x`\n\n> ✅ **【01:10 · 卡片工程师】** 回「干净」（T-20261101-D01）\n');
    const r = runCheck(['--file', f, '--loop']);
    assert.equal(r.code, 0, '--loop 恒 exit 0');
    assert.ok(r.out.includes('六问全闭环'), '应给一行结论：' + r.out.slice(-200));
    assert.ok(!r.out.includes('（空 ✓）'), '健康时不逐段展开 ✗');
    const v = runCheck(['--file', f, '--loop', '--verbose']);
    assert.ok(v.out.includes('（空 ✓）'), '--verbose 时才逐段展开 ✓');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 83–86. T-20261101-F02（借 dsh-superagent 授权模型）：授权强度（事前拦）＋ 悬空票复验 ──
const authzTicket = (stamp, line, extra = '') => [
  '## [ ] [流程管理员→调试工程师] 授权强度用例（' + stamp + '）', '',
  '**票号**：T-20261101-D77',
  '**负责人**：调试工程师｜**验收方**：流程管理员',
  line,
  '**阻塞**：无', '**验收方式**：`node x`', '',
  extra
].join('\n');
const authzProblems = (txt) => lintTickets(txt, { since: '2026-10-01' }).problems.filter((p) => p.kind === '授权强度不足');

expect('83（授权强度）：inferred 没主人确认 ⇒ 真问题；确认过 / explicit ⇒ 不报', () => {
  const started = (a) => a.replace('## [ ]', '## [~]');
  const bad = started(authzTicket('2026-11-01 01:00 UTC+8', '**授权强度**：inferred'));
  assert.equal(authzProblems(bad).length, 1, 'inferred 未确认必须报 ✗');
  assert.ok(authzProblems(bad)[0].code === 'authorization-weak', 'code 要对');
  const ok = started(authzTicket('2026-11-01 01:00 UTC+8', '**授权强度**：inferred', '**授权**：主人已确认（2026-11-01 00:30）'));
  assert.equal(authzProblems(ok).length, 0, '确认过就不该报 ✗');
  const exp = authzTicket('2026-11-01 01:00 UTC+8', '**授权强度**：explicit（来源：主人原话）');
  assert.equal(authzProblems(exp).length, 0, 'explicit 不该报 ✗');
});

expect('84（授权强度）：none 还挂活跃队列 ⇒ 真问题；存量票没有这一行 ⇒ 豁免（不追溯）', () => {
  const none = authzTicket('2026-11-01 01:00 UTC+8', '**授权强度**：none');
  assert.equal(authzProblems(none).length, 1, 'none 还活跃必须报 ✗');
  const legacy = authzTicket('2026-11-01 01:00 UTC+8', '');   // 没有这一行 ⇒ 老票
  assert.equal(authzProblems(legacy).length, 0, '存量票不许追溯 ✗');
});

expect('85（授权强度）：ticket-relay 缺省写 inferred；--origin 主人原话 写 explicit', () => {
  const proj = mkProj({ board: 'docs/待办.md', since: '2026-10-01', debtSince: '2025-10-01T00:00' });
  try {
    const f = path.join(proj, 'docs', '待办.md');
    writeFileSync(f, '## [x] [调试工程师→卡片工程师] 已有（2026-11-01 01:00 UTC+8）\n\n**票号**：T-20261101-D01\n**负责人**：卡片工程师｜**验收方**：调试工程师\n**阻塞**：无\n**验收方式**：`x`\n');
    const r1 = runProjRelay(proj, ['--from', '调试工程师', '--to', '卡片工程师', '--title', '缺省', '--file', f]);
    assert.equal(r1.code, 0, r1.out.slice(0, 200));
    assert.ok(/授权强度\*\*：inferred/.test(r1.out), '缺省必须 inferred ✗：' + r1.out.slice(0, 300));
    const r2 = runProjRelay(proj, ['--from', '调试工程师', '--to', '卡片工程师', '--title', '原话', '--origin', '主人原话', '--file', f]);
    assert.equal(r2.code, 0, r2.out.slice(0, 200));
    assert.ok(/授权强度\*\*：explicit/.test(r2.out), '主人原话必须 explicit ✗：' + r2.out.slice(0, 300));
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

expect('86（复验）：[~] 悬空 25h 没复验 ⇒ ⑤ 报「需复验」；补了 24h 内的复验 ⇒ 不报；[x] 不要求', () => {
  const mkT = (stamp, extra = '') => [
    '## [~] [流程管理员→调试工程师] 悬空票（' + stamp + '）', '',
    '**票号**：T-20261031-D66',
    '**负责人**：调试工程师｜**验收方**：流程管理员',
    '**授权强度**：explicit',
    '**阻塞**：无', '**验收方式**：`node x`', '',
    '> ✅ **【10:00 · 调试工程师】** 回「悬空票」（T-20261031-D66）',
    extra
  ].join('\n');
  const now = '2026-11-01T02:00:00+08:00';
  const stale = closedLoop(lintTickets(mkT('2026-10-31 00:00 UTC+8'), { since: '2026-10-01' }).tickets, { now });
  assert.equal(stale.closed.length, 1, '[~] 悬空 26h 必须报 ✗');
  assert.ok(/需复验/.test(stale.closed[0].why), '要写「需复验」：' + stale.closed[0].why);
  const okT = closedLoop(lintTickets(mkT('2026-10-31 00:00 UTC+8', '**复验**：2026-11-01 01:30 ✓ 请求人仍在／规则未变'), { since: '2026-10-01' }).tickets, { now });
  assert.equal(okT.closed.length, 0, '24h 内复验过 ⇒ 不报 ✗：' + JSON.stringify(okT.closed));
  const done = closedLoop(lintTickets(mkT('2026-10-31 00:00 UTC+8').replace('## [~]', '## [x]'), { since: '2026-10-01' }).tickets, { now });
  assert.equal(done.closed.length, 0, '[x] 不要求复验 ✗');
});

// ── 87–89. T-20261101-F05：`[ ]` ＋ inferred 放超 24h 还没补授权 ⇒ authorization-stale ──
const staleTicket = (stamp, extra = '') => [
  '## [ ] [流程管理员→调试工程师] 躺着没动的推断票（' + stamp + '）', '',
  '**票号**：T-20261101-D78',
  '**负责人**：调试工程师｜**验收方**：流程管理员',
  '**授权强度**：inferred',
  '**阻塞**：无', '**验收方式**：`node x`', '',
  extra
].join('\n');
const staleN = (txt, kind) => lintTickets(txt, { since: '2026-10-01' }).problems.filter((p) => p.kind === kind).length;
const nowStamp = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ' UTC+8';
};

expect('87（F05）：`[ ]` ＋ inferred 建票超 24h 没确认 ⇒ 报 authorization-stale（不是 weak）', () => {
  const t = staleTicket('2026-10-30 10:00 UTC+8');
  assert.equal(staleN(t, '授权待补'), 1, '超 24h 躺着的 inferred 必须报 ✗');
  assert.equal(staleN(t, '授权强度不足'), 0, '与 weak 不许重复报 ✗');
});

expect('88（F05）：同一张补了 `**授权**：主人已确认` ⇒ 不报', () => {
  const t = staleTicket('2026-10-30 10:00 UTC+8', '**授权**：主人已确认（2026-11-01 03:00）');
  assert.equal(staleN(t, '授权待补'), 0, '确认过就不该报 ✗');
});

expect('89（F05）：24h 内建的 inferred 票 ⇒ 不报（这条最容易被写成"一律报"✗）', () => {
  const t = staleTicket(nowStamp());
  assert.equal(staleN(t, '授权待补'), 0, '24h 内不许催 ✗');
});

// ── 90–93. P1（2026-11-02）：派活记录落票板 ─────────────────────────────
//   为什么要有：派活原来只在插件内存里 ✗ 重启丢去重集合 ⇒ 同一张票被派两次（README 三个坑之一）✗
//   落到票板后：重复派活能查（真问题）✓ 派了多久没回票能催（queue）✓ 票板仍是唯一台账 ✓
const dispatchedTicket = (extraLines = '') => [
  '## [ ] [流程管理员→调试工程师] 派活测试票（2026-11-01 10:00 UTC+8）', '',
  '**票号**：T-20261101-D90',
  '**负责人**：调试工程师｜**验收方**：流程管理员',
  '**阻塞**：无', '**验收方式**：`node x`',
  extraLines, ''
].join('\n');
const dupCount = (txt) => lintTickets(txt, { since: '2026-10-01' }).problems.filter((p) => p.kind === '重复派活').length;

expect('90（P1）：一张票两条派活记录 ⇒ 报「重复派活」', () => {
  assert.equal(dupCount(dispatchedTicket('**派活**：@调试工程师 2026-11-01 10:05\n**派活**：@调试工程师 2026-11-01 11:05')), 1, '重复派活必须报 ✗');
});

expect('91（P1）：只有一条派活记录 ⇒ 不报', () => {
  assert.equal(dupCount(dispatchedTicket('**派活**：@调试工程师 2026-11-01 10:05')), 0, '一条不许报 ✗');
});

expect('92（P1）：代码块/行内代码里的"派活"不算记录 ⇒ 不报重复', () => {
  const t = dispatchedTicket('**派活**：@调试工程师 2026-11-01 10:05\n\n```\n**派活**：@调试工程师 2026-11-01 11:05\n```\n\n行内样例 `**派活**：@调试工程师 2026-11-01 12:05`');
  assert.equal(dupCount(t), 0, '代码块/行内代码里的样例不算 ✗（否则抄个格式就报错 ✗）');
});

expect('93（P1）：已派活 + 无回票 ⇒ 进 --queue 催办；有回票 ⇒ 移出', () => {
  const noReply = dispatchedTicket('**派活**：@调试工程师 2026-11-01 10:05');
  const q1 = queueOf(lintTickets(noReply, { since: '2026-10-01' }).tickets);
  assert.equal(q1.dispatched.length, 1, '派活未回票应进催办 ✗');
  assert.equal(q1.dispatched[0].dispatch[0].target, '调试工程师', '要能读出派给谁 ✗');
  const withReply = noReply + '\n> ✅ **【11:00 · 调试工程师】** 回「派活测试票」（T-20261101-D90）\n';
  const q2 = queueOf(lintTickets(withReply, { since: '2026-10-01' }).tickets);
  assert.equal(q2.dispatched.length, 0, '回过票就不该再催 ✗');
});

console.log('');
console.log((fail ? '⚠ ' : '✅ ') + '自检：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
