/** experience-selftest.mjs —— 经验库回归（票 T-20261103-F04）
 *
 *  跑法：node tools/experience-selftest.mjs       全绿 exit 0 ／ 红 exit 1
 *  覆盖：解析 ✓／坏 frontmatter ✗／空触发 ✗／打分 ✓／同分按 id 排序 ✓／limit=3 截断 ✓／坏条目跳过不崩 ✓
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseExperience, loadExperiences, matchExperiences } from './lib/experience.mjs';

let pass = 0, fail = 0;
function expect(name, fn) {
  try { fn(); pass++; console.log('✔ ' + name); }
  catch (e) { fail++; console.log('✖ ' + name + '\n   ' + String(e.message).split('\n')[0]); }
}
const mk = (head, body = '为什么：因为这样。') => '---\n' + head + '\n---\n' + body;

expect('1 正常条目：id／触发／动作／正文都解析出来', () => {
  const r = parseExperience(mk('id: repack\ntrigger: 打包, 重打\naction: 改完要重打包'));
  assert.equal(r.ok, true, r.why);
  assert.equal(r.exp.id, 'repack');
  assert.deepEqual(r.exp.triggers, ['打包', '重打']);
  assert.equal(r.exp.action, '改完要重打包');
  assert.ok(r.exp.body.includes('因为'));
});

expect('2 触发支持行内数组 / 顿号 / YAML 列表 三种写法', () => {
  assert.deepEqual(parseExperience(mk('id: a\ntrigger: [x, y]\naction: t')).exp.triggers, ['x', 'y']);
  assert.deepEqual(parseExperience(mk('id: b\ntrigger: x、y\naction: t')).exp.triggers, ['x', 'y']);
  const listy = '---\nid: c\ntrigger:\n  - x\n  - y\naction: t\n---\n正文';
  assert.deepEqual(parseExperience(listy).exp.triggers, ['x', 'y']);
});

expect('3 坏条目：没有 frontmatter / 缺 id / 触发空 / 缺 action / 正文空', () => {
  assert.equal(parseExperience('就是一段正文，没有 frontmatter').ok, false);
  assert.equal(parseExperience(mk('trigger: x\naction: t')).ok, false);
  assert.equal(parseExperience(mk('id: x\ntrigger:\naction: t')).ok, false);
  assert.equal(parseExperience(mk('id: x\ntrigger: y')).ok, false);
  assert.equal(parseExperience(mk('id: x\ntrigger: y\naction: t', '')).ok, false);
});

expect('4 打分：命中越多越靠前', () => {
  const list = [
    { id: 'a', triggers: ['打包'], action: 'A' },
    { id: 'b', triggers: ['打包', 'tools'], action: 'B' },
  ];
  const hit = matchExperiences('改完 tools 要打包', list);
  assert.equal(hit.length, 2);
  assert.equal(hit[0].id, 'b', '命中 2 个的应排前面 ✗');
  assert.equal(hit[0].score, 2);
});

expect('5 同分按 id 字典序（必须可复现）', () => {
  const list = [
    { id: 'zeta', triggers: ['x'], action: 'Z' },
    { id: 'alpha', triggers: ['x'], action: 'A' },
    { id: 'mike', triggers: ['x'], action: 'M' },
  ];
  const ids = matchExperiences('说 x', list).map((e) => e.id);
  assert.deepEqual(ids, ['alpha', 'mike', 'zeta']);
  assert.deepEqual(matchExperiences('说 x', list).map((e) => e.id), ids, '两次结果必须一样 ✗');
});

expect('6 limit：命中 4 条只回 3 条', () => {
  const list = ['a', 'b', 'c', 'd'].map((id) => ({ id, triggers: ['x'], action: id.toUpperCase() }));
  assert.equal(matchExperiences('x', list).length, 3, '默认必须截到 3 ✗');
  assert.equal(matchExperiences('x', list, 2).length, 2);
});

expect('7 没命中 ⇒ 空数组；空白文本 ⇒ 空数组', () => {
  assert.deepEqual(matchExperiences('完全无关的话', [{ id: 'a', triggers: ['打包'], action: 'A' }]), []);
  assert.deepEqual(matchExperiences('', [{ id: 'a', triggers: ['打包'], action: 'A' }]), []);
});

expect('8 坏条目不影响好的：loadExperiences 把坏条目收进 bad，不抛', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'exp-'));
  try {
    writeFileSync(path.join(dir, 'good.md'), mk('id: good\ntrigger: x\naction: 好的'));
    writeFileSync(path.join(dir, 'bad.md'), '没有 frontmatter');
    writeFileSync(path.join(dir, 'noaction.md'), mk('id: noaction\ntrigger: y'));
    const r = loadExperiences(dir);
    assert.equal(r.list.length, 1, '好的应载入 1 条 ✗ 实际 ' + r.list.length);
    assert.equal(r.bad.length, 2, '坏的应记 2 条 ✗');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

expect('9 返回项只有 id/action/score —— 正文永不外泄', () => {
  const [hit] = matchExperiences('打包', [{ id: 'a', triggers: ['打包'], action: 'A', body: '正文不许出去' }]);
  assert.deepEqual(Object.keys(hit).sort(), ['action', 'id', 'score']);
  assert.equal(JSON.stringify(hit).includes('正文不许出去'), false, '正文泄漏了 ✗');
});

console.log('');
console.log((fail ? '⚠ ' : '✅ ') + '经验库自检：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
