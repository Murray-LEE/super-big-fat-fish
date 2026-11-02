/**
 * write-guard-selftest.mjs —— 写入保护（P0：锁 / 原子写 / 锁内二次比对）的自检
 *
 * 为什么单独一个文件：`ticket-check-selftest` 与 `ticket-reply-selftest` 检的是**票面判定** ✓
 * 这里检的是**写入的物理性质**（谁先写、写一半会不会留半截、陈旧锁会不会卡死）✗ 两者失败原因不同 ✗
 *
 * 口径：每条用例都必须能说出"如果实现坏了，会以什么形状坏" ✓ 只断言"没抛错"不算用例 ✗
 *
 *   node tools/write-guard-selftest.mjs
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_LOCK_TTL_MS, acquireLock, inspectLock, isStaleLock, lockPathOf,
  readLock, releaseLock, sha256, writeAtomic, writeBoardGuarded
} from './lib/ticket-write.mjs';

let ok = 0;
const fails = [];
const t = (name, fn) => {
  try { fn(); ok++; console.log('✔ ' + name); }
  catch (e) { fails.push({ name, msg: (e && e.message) || String(e) }); console.log('✗ ' + name + ' — ' + ((e && e.message) || e)); }
};
const eq = (a, b, why) => { if (a !== b) throw new Error((why || '') + ' 期望 ' + JSON.stringify(b) + '，实得 ' + JSON.stringify(a)); };
const truthy = (v, why) => { if (!v) throw new Error(why || '期望为真'); };

const dir = mkdtempSync(path.join(os.tmpdir(), 'write-guard-'));
const board = path.join(dir, '待办.md');
const lock = lockPathOf(board);
const reset = (text = '# 票板\n') => {
  writeFileSync(board, text, 'utf8');
  try { rmSync(lock); } catch { /* 没有就算 */ }
};
const tmps = () => readdirSync(dir).filter((f) => f.includes('.tmp-'));

// ① sha256：同样的内容必须同 hash，差一个字符必须不同（否则"比对"形同虚设）
t('1（sha256）：同内容同 hash，差一字符不同 hash', () => {
  eq(sha256('abc'), sha256('abc'), '同内容');
  truthy(sha256('abc') !== sha256('abd'), '差一字符必须不同 hash ✗');
  eq(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '空串');
});

// ② 正常写入：内容变了、锁没留下、临时文件没留下（留下就是"写完没清理"✗）
t('2（正常写）：内容生效，且锁与临时文件都清干净', () => {
  reset('A');
  const r = writeBoardGuarded({ file: board, before: 'A', after: 'B', who: 'selftest' });
  truthy(r.ok, '写入应成功，实得 ' + JSON.stringify(r));
  eq(readFileSync(board, 'utf8'), 'B', '文件内容');
  truthy(!existsSync(lock), '写完后锁必须已释放 ✗');
  eq(tmps().length, 0, '不得残留 .tmp 文件 ✗');
});

// ③ 锁被占：另一个活进程持锁 ⇒ **不写**，且票板一个字节都不动（这是"不覆盖别人"的底线）
t('3（锁被占）：不写盘，票板未变', () => {
  reset('A');
  const held = acquireLock(board, { who: '另一个会话' });
  truthy(held.ok, '准备阶段拿锁应成功');
  const r = writeBoardGuarded({ file: board, before: 'A', after: 'B', who: 'selftest' });
  eq(r.ok, false, '应失败');
  eq(r.code, 'LOCKED', '失败码');
  eq(r.lock.held.who, '另一个会话', '应报出持有者');
  eq(readFileSync(board, 'utf8'), 'A', '票板必须未被修改 ✗');
  releaseLock(lock);
});

// ④ 陈旧锁回收：过期 + 本机 pid 已死 ⇒ 允许写，并回报 reclaimed（不许静默 ✗）
t('4（陈旧锁）：回收后写入成功，并回报 reclaimed', () => {
  reset('A');
  writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now() - DEFAULT_LOCK_TTL_MS - 60000, who: '被强杀的会话', host: os.hostname() }), 'utf8');
  const r = writeBoardGuarded({ file: board, before: 'A', after: 'B', who: 'selftest' });
  truthy(r.ok, '陈旧锁应被回收后写入，实得 ' + JSON.stringify(r));
  truthy(r.reclaimed && r.reclaimed.pid === 999999, '必须回报被回收的锁 ✗');
  eq(readFileSync(board, 'utf8'), 'B', '文件内容');
  truthy(!existsSync(lock), '写完后锁必须已释放 ✗');
});

// ⑤ 过期但持有进程还活着 ⇒ **不许回收**（长任务正在写，抢锁会丢它的票 ✗）
t('5（过期但活着）：不回收，判定 LOCKED', () => {
  reset('A');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() - DEFAULT_LOCK_TTL_MS - 60000, who: '长任务', host: os.hostname() }), 'utf8');
  truthy(isStaleLock(readLock(lock)) === false, '活着就不算陈旧 ✗');
  const r = writeBoardGuarded({ file: board, before: 'A', after: 'B', who: 'selftest' });
  eq(r.code, 'LOCKED', '失败码');
  eq(readFileSync(board, 'utf8'), 'A', '票板必须未被修改 ✗');
  releaseLock(lock);
});

// ⑥ 锁内二次比对：读完之后别人写过了 ⇒ 拒绝（这是"两人同时通过比对"的补丁 ✓）
t('6（锁内比对）：票板已变 ⇒ CHANGED，且不写盘', () => {
  reset('别人改成这样了');
  const r = writeBoardGuarded({ file: board, before: '我读到的是这样', after: '我要写的', who: 'selftest' });
  eq(r.ok, false, '应失败');
  eq(r.code, 'CHANGED', '失败码');
  truthy(r.beforeSha && r.nowSha && r.beforeSha !== r.nowSha, '必须回报前后 sha ✗');
  eq(readFileSync(board, 'utf8'), '别人改成这样了', '票板必须保持别人的版本 ✗');
  truthy(!existsSync(lock), '失败也要放锁 ✗');
});

// ⑦ 原子写：中文/多行/大内容逐字一致，且不残留临时文件
t('7（原子写）：多行中文逐字一致，无 .tmp 残留', () => {
  reset('');
  const big = Array.from({ length: 500 }, (_, i) => '## [ ] [流程→开发] 第 ' + i + ' 张票（含中文与符号 ✅ ✗ ✓）').join('\n') + '\n';
  writeAtomic(board, big);
  eq(readFileSync(board, 'utf8'), big, '内容必须逐字一致');
  eq(tmps().length, 0, '不得残留 .tmp 文件 ✗');
});

// ⑧ 放锁只删自己那把：别人重建过锁 ⇒ 不删（否则会把别人的互斥量踹掉 ✗）
t('8（放锁）：只删自己的锁', () => {
  reset('A');
  writeFileSync(lock, JSON.stringify({ pid: 424242, at: Date.now(), who: '别人', host: os.hostname() }), 'utf8');
  eq(releaseLock(lock), false, '不是自己那把 ⇒ 不许删');
  truthy(existsSync(lock), '别人的锁必须还在 ✗');
  rmSync(lock);
});

// ⑨ inspectLock：只读 —— 无锁 / 陈旧锁两种口径都要对，且**不得**删锁
t('9（inspectLock）：只读判定，不删锁', () => {
  reset('A');
  eq(inspectLock(board).exists, false, '无锁时 exists');
  writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now() - DEFAULT_LOCK_TTL_MS - 1, who: 'x', host: os.hostname() }), 'utf8');
  const r = inspectLock(board);
  eq(r.exists, true, '有锁时 exists');
  eq(r.stale, true, '陈旧判定');
  truthy(existsSync(lock), 'inspectLock 不许删锁 ✗');
  rmSync(lock);
});

// ⑩ 失败不留痕：连续 20 次"被锁挡下"的写入，票板必须一次都没被动过
t('10（反复被挡）：20 次全部不写盘', () => {
  reset('原始内容');
  acquireLock(board, { who: 'holder' });
  for (let i = 0; i < 20; i++) {
    const r = writeBoardGuarded({ file: board, before: '原始内容', after: '第' + i + '次', who: 'selftest' });
    if (r.ok) throw new Error('第 ' + i + ' 次竟然写成功了 ✗');
  }
  eq(readFileSync(board, 'utf8'), '原始内容', '票板必须一次都没变 ✗');
  releaseLock(lock);
});

rmSync(dir, { recursive: true, force: true });

console.log('');
if (fails.length) {
  console.log('❌ 写入保护自检：通过 ' + ok + ' ／ 失败 ' + fails.length);
  for (const f of fails) console.log('  · ' + f.name + ' — ' + f.msg);
  process.exit(1);
}
console.log('✅ 写入保护自检：通过 ' + ok + ' / 失败 0');
