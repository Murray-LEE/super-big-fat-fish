/**
 * tools/lib/ticket-write.mjs —— 票板**写入**的互斥与原子性（有 IO ✓ 只碰锁和临时文件 ✓）
 *
 * 为什么需要（2026-11-02 · 自动派活上线后）：
 *   ticket-reply / ticket-relay 原来都是「读 → 比对 → 备份 → writeFileSync」。
 *   那次比对能挡住"我读完、别人已经写完了"，但**挡不住两人同时通过比对**再各写一份：
 *
 *     进程A 读 ── 进程B 读 ── A 比对通过 ── B 比对通过 ── A 写 ── B 写
 *                                            ⇒ A 那次的票**静默消失** ✗（快照里还在，但没人会去翻）
 *
 *   派活插件（docs/开票工作流-优化版 §2.6）上线前，"同时回票"几乎不会发生；
 *   上线后多条线会话并行回票是**每天都会**的事 ✓ ⇒ 靠"票板写入权在 cs-team"这种约定不够 ✗
 *
 * 三层保护（缺一层都不成立）：
 *   ① **锁**：`<票板>.lock` 用 `open('wx')` 排他创建 ⇒ 同一时刻只有一个写者 ✓
 *   ② **锁内二次比对**：拿到锁之后**重读**并比 sha256 ⇒ 挡住"读与写之间被人插了一笔" ✓
 *   ③ **原子替换**：写 `<票板>.tmp-<pid>` 再 rename ⇒ 进程被杀也不会留下半截票板 ✓
 *
 * 口径（与全仓一致 ✓ fail-closed）：
 *   · 拿不到锁 ⇒ **不写**，并说清谁持有、什么时候、哪台机器 ✗ 不"等一下试试"✗
 *   · 陈旧锁（超过 ttlMs 且持有进程已死／异机）⇒ 回收，并在回执里说明 ✓ 静默回收 ✗
 *   · 锁文件**不是账**（同理 registry.json）⇒ 只是互斥量，随时可删 ✓
 *   · 本模块**不判票面** ✗ 只保证"这一次写是独占且原子的" ✓
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

/** 锁的默认有效期：超过且持有进程已死 ⇒ 视为陈旧（分钟级够用 ✓ 长任务请显式传 ttlMs） */
export const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;

export const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

export const lockPathOf = (file) => String(file) + '.lock';

/** 读锁内容；读不出来（空文件／写了一半）⇒ null ✓ 调用方按"不可判定"处理 ✗ 不猜 */
export function readLock(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    if (!raw.trim()) return null;
    const o = JSON.parse(raw);
    return { pid: Number(o.pid) || 0, at: Number(o.at) || 0, who: String(o.who || ''), host: String(o.host || '') };
  } catch {
    return null;
  }
}

/** 进程还活着吗（EPERM ⇒ 活着但没权限 ✓ Windows 上 pid 复用概率低，够用） */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/** 锁是否陈旧：过期 **且**（异机 或 本机进程已死）⇒ 可回收 ✓ 过期但进程还活 ⇒ 不回收 ✗ */
export function isStaleLock(info, { ttlMs = DEFAULT_LOCK_TTL_MS, now = Date.now() } = {}) {
  if (!info) return true;                        // 读不出来 ⇒ 按陈旧处理（否则永远卡住）
  const ageMs = now - info.at;
  if (!(ageMs > ttlMs)) return false;
  const sameHost = !info.host || info.host === os.hostname();
  return sameHost ? !isAlive(info.pid) : true;   // 异机查不了 pid ⇒ 过期即陈旧
}

/**
 * 拿锁。返回 { ok:true, path, reclaimed? } 或 { ok:false, code:'LOCKED'|'EACCES'|…, held, path }
 * 陈旧锁会被回收并重试**一次**（不循环重试 ✗ 免得两个进程互相踩着转圈）
 */
export function acquireLock(file, { who = '', ttlMs = DEFAULT_LOCK_TTL_MS, now = Date.now() } = {}) {
  const lockPath = lockPathOf(file);
  const payload = JSON.stringify({ pid: process.pid, at: now, who, host: os.hostname() });

  const create = () => {
    try {
      const fd = openSync(lockPath, 'wx');        // wx = 排他创建 ✓ 已存在就抛 EEXIST
      try { writeSync(fd, payload); } finally { closeSync(fd); }
      return { ok: true, path: lockPath };
    } catch (e) {
      const code = (e && e.code) || 'ERR';
      return { ok: false, code, detail: String((e && e.message) || e) };
    }
  };

  const first = create();
  if (first.ok) return { ok: true, path: lockPath };
  if (first.code !== 'EEXIST') return { ok: false, code: first.code, detail: first.detail, path: lockPath };

  const held = readLock(lockPath);
  if (!isStaleLock(held, { ttlMs, now })) {
    return { ok: false, code: 'LOCKED', held, path: lockPath };
  }
  try { unlinkSync(lockPath); } catch { /* 别人先删了也算回收成功 */ }
  const second = create();
  if (second.ok) return { ok: true, path: lockPath, reclaimed: held };
  return {
    ok: false,
    code: second.code === 'EEXIST' ? 'LOCKED' : second.code,
    detail: second.detail,
    held: readLock(lockPath),
    path: lockPath
  };
}

/** 放锁：只删**自己那把**（pid 不符 ⇒ 已被别人回收并重建，别删 ✓） */
export function releaseLock(lockPath, pid = process.pid) {
  try {
    const cur = readLock(lockPath);
    if (cur && cur.pid !== pid) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/** 原子替换：写同目录临时文件 → rename ✓ 同卷 rename 是原子的 ✓ */
export function writeAtomic(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid);
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, text); } finally { closeSync(fd); }
  try {
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 尽力清理，失败也不掩盖原始错误 */ }
    throw e;
  }
  return { tmp, file };
}

/**
 * 受保护地写票板：拿锁 → 锁内重读比对 → 原子写 → 放锁。
 * 返回 { ok:true, lockPath, reclaimed? } 或 { ok:false, code, ... }（**任何一种失败都没有写盘** ✓）
 */
export function writeBoardGuarded({ file, before, after, who = '', ttlMs = DEFAULT_LOCK_TTL_MS, now } = {}) {
  const lock = acquireLock(file, { who, ttlMs, now });
  if (!lock.ok) return { ok: false, code: lock.code, lock, detail: lock.detail };
  try {
    let current;
    try {
      current = readFileSync(file, 'utf8');
    } catch (e) {
      return { ok: false, code: (e && e.code) || 'READ', detail: String((e && e.message) || e), lock };
    }
    const beforeSha = sha256(before);
    const nowSha = sha256(current);
    if (beforeSha !== nowSha) {
      return { ok: false, code: 'CHANGED', beforeSha: beforeSha.slice(0, 12), nowSha: nowSha.slice(0, 12), lock };
    }
    writeAtomic(file, after);
    return { ok: true, lockPath: lock.path, reclaimed: lock.reclaimed || null };
  } finally {
    releaseLock(lock.path);
  }
}

/** 只读检查（给 ticket-check 用）：不创建、不删除、不改时间 ✓ */
export function inspectLock(file, { ttlMs = DEFAULT_LOCK_TTL_MS, now = Date.now() } = {}) {
  const lockPath = lockPathOf(file);
  if (!existsSync(lockPath)) return { exists: false, path: lockPath };
  const info = readLock(lockPath);
  const ageMs = info ? now - info.at : null;
  return { exists: true, path: lockPath, info, ageMs, stale: isStaleLock(info, { ttlMs, now }) };
}
