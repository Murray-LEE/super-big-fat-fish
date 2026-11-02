#!/usr/bin/env node
/**
 * tools/json-contract-check.mjs —— `ticket-check --json` 的**契约自检**（零依赖 ✓）
 *
 * 为什么需要（2026-11-02 · P6）：
 *   这份 JSON 是给下游（watcher／派活脚本／CI）用的**稳定契约** ✓ 仓库也一直说"字段只加不改名"✓
 *   但**没有任何东西在检查这句话** ✗ ⇒ 有人顺手把 `real` 改成"排除 unknown"，
 *   下游读到的数全变，而自检和 CI 都是绿的 ✗（这类事故最难查：两边都"对"，只是口径不同 ✗）
 *
 * 做法（不引 AJV ✗ 这个仓库是零依赖 ✓）：
 *   按 tools/schema/ticket-check.schema.json 的**要点**逐条断言 ＋ 三条**恒等式**：
 *     ① summary.real = 非历史债的问题数
 *     ② summary.real = knownReal + unknown + unclassified
 *     ③ summary.total = problems.length
 *   恒等式比字段类型更重要：字段在但数算错了，契约就是假的 ✗
 *
 * 用法：
 *   node tools/json-contract-check.mjs                     # 跑当前票板，校验输出
 *   node tools/json-contract-check.mjs --file <票板>        # 换票板
 *   node tools/json-contract-check.mjs --in <json文件>      # 校验一份**已有**的 JSON（离线复核 ✓）
 *   node tools/json-contract-check.mjs --strict            # 额外要求 exitCode/gates 存在（门禁场景 ✓）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'tools', 'ticket-check.mjs');
const argv = process.argv.slice(2);
const argOf = (f, d = '') => {
  const i = argv.indexOf(f);
  if (i < 0) return d;
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) {
    console.error('✗ ' + f + ' 缺少取值 ⇒ 什么都没做 ✗');
    process.exit(2);
  }
  return String(v);
};
const STRICT = argv.includes('--strict');
const IN = argOf('--in', '');
const BOARD = argOf('--file', 'docs/待办.md');

let raw;
if (IN) {
  if (!existsSync(IN)) { console.error('✗ 读不到 JSON：' + IN + ' ⇒ 什么都没做 ✗'); process.exit(2); }
  raw = readFileSync(IN, 'utf8');
} else {
  try {
    raw = execFileSync(process.execPath, [CLI, '--json', '--file', BOARD], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    console.error('✗ 跑 ticket-check --json 失败（' + (e.status === undefined ? '异常' : 'exit ' + e.status) + '）');
    console.error(String(e.stdout || '').slice(-800) + String(e.stderr || '').slice(-800));
    console.error('  ⇒ 先让票板自检能跑通，再来验契约 ✗（别拿"跑不出来"当"契约没问题"✗）');
    process.exit(2);
  }
}

let j;
try { j = JSON.parse(raw); }
catch (e) { console.error('✗ 输出不是合法 JSON：' + (e.message || e)); process.exit(1); }

let pass = 0; const fails = [];
const t = (name, fn) => { try { const why = fn(); if (why) throw new Error(why); pass++; console.log('✔ ' + name); } catch (e) { fails.push(name + ' — ' + ((e && e.message) || e)); console.log('✖ ' + name + ' — ' + ((e && e.message) || e)); } };
const int = (v) => typeof v === 'number' && Number.isInteger(v);
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── 必备字段与类型 ───────────────────────────────────────────────────────
t('1：schemaVersion = 1（改语义必须升到 2 ✗ 不许原地改）', () => (j.schemaVersion === 1 ? '' : '实得 ' + JSON.stringify(j.schemaVersion)));
t('2：tool = ticket-check', () => (j.tool === 'ticket-check' ? '' : '实得 ' + JSON.stringify(j.tool)));
t('3：file 是字符串', () => (typeof j.file === 'string' ? '' : '实得 ' + typeof j.file));
t('4：tickets.total / states 齐全且都是整数', () => {
  if (!obj(j.tickets) || !obj(j.tickets.states)) return 'tickets 或 states 不是对象';
  if (!int(j.tickets.total)) return 'tickets.total 不是整数';
  for (const k of ['open', 'claimed', 'pendingAccept', 'done', 'cancelled', 'legacyFormat']) {
    if (!int(j.tickets.states[k])) return 'states.' + k + ' 不是整数';
  }
  return '';
});
t('5：summary 九个字段齐全', () => {
  if (!obj(j.summary)) return 'summary 不是对象';
  for (const k of ['real', 'debt', 'unknown', 'total', 'knownReal', 'unclassified']) {
    if (!int(j.summary[k])) return 'summary.' + k + ' 不是整数';
  }
  for (const k of ['byKindReal', 'byKindDebt']) {
    if (!obj(j.summary[k])) return 'summary.' + k + ' 不是对象';
  }
  if (typeof j.summary.assumedDebt !== 'boolean') return 'summary.assumedDebt 不是布尔';
  return '';
});
t('6：problems 是数组，每条有 kind／line／title', () => {
  if (!Array.isArray(j.problems)) return 'problems 不是数组';
  for (const [i, p] of j.problems.entries()) {
    if (!obj(p)) return 'problems[' + i + '] 不是对象';
    if (typeof p.kind !== 'string' || !p.kind) return 'problems[' + i + '].kind 不是非空字符串';
    if (!int(p.line) || p.line < 1) return 'problems[' + i + '].line 不是正整数';
    if (typeof p.title !== 'string') return 'problems[' + i + '].title 不是字符串';
  }
  return '';
});

// ── 三条恒等式（比字段类型更要紧 ✗）──────────────────────────────────────
t('7：恒等式① summary.real = 非历史债的问题数', () => {
  const expect = Array.isArray(j.problems) ? j.problems.filter((p) => !p.debt).length : NaN;
  return j.summary.real === expect ? '' : 'summary.real=' + j.summary.real + '，按 problems 算=' + expect;
});
t('8：恒等式② real = knownReal + unknown + unclassified', () => {
  const s = j.summary;
  const sum = s.knownReal + s.unknown + s.unclassified;
  return s.real === sum ? '' : 'real=' + s.real + '，三项和=' + sum;
});
t('9：恒等式③ summary.total = problems.length', () => {
  const n = Array.isArray(j.problems) ? j.problems.length : NaN;
  return j.summary.total === n ? '' : 'summary.total=' + j.summary.total + '，problems=' + n;
});
t('10：恒等式④ tickets.total = states 各项之和', () => {
  const st = j.tickets.states;
  const sum = st.open + st.claimed + st.pendingAccept + st.done + st.cancelled + st.legacyFormat;
  return j.tickets.total === sum ? '' : 'total=' + j.tickets.total + '，分项和=' + sum;
});

// ── P6 新增字段 ──────────────────────────────────────────────────────────
t('11：lock / snapshot 形状（存在时）', () => {
  if (j.lock !== undefined) {
    if (!obj(j.lock)) return 'lock 不是对象';
    if (typeof j.lock.exists !== 'boolean') return 'lock.exists 不是布尔';
    if (typeof j.lock.stale !== 'boolean') return 'lock.stale 不是布尔';
  }
  if (j.snapshot !== undefined) {
    if (!obj(j.snapshot)) return 'snapshot 不是对象';
    if (typeof j.snapshot.contentSha256 !== 'string' || j.snapshot.contentSha256.length !== 64) return 'snapshot.contentSha256 不是 64 位 hex';
  }
  return '';
});
const gateCheck = () => {
  if (![0, 1].includes(j.exitCode)) return 'exitCode 必须是 0 或 1，实得 ' + JSON.stringify(j.exitCode);
  if (!obj(j.gates)) return 'gates 不是对象';
  if (typeof j.gates.strict !== 'boolean') return 'gates.strict 不是布尔';
  if (!int(j.gates.strictFails)) return 'gates.strictFails 不是整数';
  if (typeof j.gates.staleLock !== 'boolean') return 'gates.staleLock 不是布尔';
  if (j.exitCode === 1 && j.gates.strictFails === 0 && !j.gates.staleLock) return 'exitCode=1 却既无真问题也无陈旧锁（自相矛盾 ✗）';
  return '';
};
t('12：exitCode / gates 可读且自洽' + (STRICT ? '（--strict 要求必须存在）' : '（存在时校验）'), () => {
  if (j.exitCode === undefined && j.gates === undefined) return STRICT ? '缺 exitCode/gates ✗（下游没法判门禁）' : '';
  return gateCheck();
});

console.log('');
if (fails.length) {
  console.log('❌ JSON 契约：通过 ' + pass + ' ／ 失败 ' + fails.length);
  for (const f of fails) console.log('  · ' + f);
  console.log('  ⇒ 契约是**下游的依赖** ✗ 改字段名=破坏下游 ✓ 只许加字段 ✓');
  process.exit(1);
}
console.log('✅ JSON 契约：通过 ' + pass + ' / 失败 0（schemaVersion 1 · 三条恒等式成立 ✓）');
