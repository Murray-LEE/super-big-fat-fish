/**
 * tools/lib/experience.mjs —— 经验库（借 dsh-superagent-reactive 的「命中才注入」）
 *
 * 为什么只抄这一条：
 *   经验能越攒越多，而**没命中的一个字都不进 prompt** ⇒ 提示词不膨胀 ✓
 *   （授权分级 L1/L2/L3 先不做：现在只有 5 条，建分级是过度设计 ✗）
 *
 * 条目格式（docs/经验/<id>.md）：
 *   ---
 *   id: reply-no-checkmark
 *   trigger: 回票, 对勾, ✅
 *   action: 回票正文只用 ✓，只有首行用 ✅
 *   ---
 *   为什么这么定：……（正文只给人看，**永远不进 prompt** ✗）
 *
 * 规矩：
 *   · 进消息的只有 **id ＋ action 一行** ✗ 正文永不进 ✗
 *   · 打分＝命中关键词个数 ✓ 同分按 id 字典序 ✓（两次跑必须一样 ✓）
 *   · 坏条目（缺 id／触发空／动作空／正文空）⇒ **跳过并 warn** ✗ 不许让派活崩 ✗
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

/** 解析一条经验的文本。返回 { ok:true, exp } 或 { ok:false, why } */
export function parseExperience(text, file = '') {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const m = /^\s*---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(src);
  if (!m) return { ok: false, why: '没有 frontmatter（--- … ---）' };
  const head = m[1];
  const body = String(m[2] || '').trim();
  const get = (k) => {
    // ★ 只吃行内空白 ✗ 用 \s* 会把换行也吃掉 ⇒ 空 trigger 会把下一行 action 当成触发值 ✗
    const re = new RegExp('^[ \\t]*' + k + '[ \\t]*:[ \\t]*(.*)$', 'mi');
    const r = re.exec(head);
    return r ? String(r[1]).trim() : '';
  };
  const id = get('id');
  if (!id) return { ok: false, why: '缺 id' };
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) return { ok: false, why: 'id 只许字母数字与连字符：' + id };
  // trigger 支持三种写法：行内数组 / 逗号分隔 / 下面挂 - 列表
  let trigRaw = get('trigger');
  if (!trigRaw) {
    // YAML 列表：trigger: 之后连续的 "- 关键词" 行（遇到非 - 行就停）
    const lines = head.split('\n');
    const at = lines.findIndex((l) => /^[ \t]*trigger[ \t]*:[ \t]*$/i.test(l));
    if (at >= 0) {
      const got = [];
      for (let i = at + 1; i < lines.length; i++) {
        const m = /^[ \t]*-[ \t]*(.+)$/.exec(lines[i]);
        if (!m) break;
        got.push(m[1].trim());
      }
      trigRaw = got.join(',');
    }
  }
  const triggers = String(trigRaw || '')
    .replace(/^\[|\]$/g, '')
    .split(/[,，、]/)
    .map((s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter(Boolean);
  if (!triggers.length) return { ok: false, why: '触发为空（trigger 至少要有一个关键词）' };
  const action = get('action');
  if (!action) return { ok: false, why: '缺 action（一句话说清该做什么）' };
  if (!body) return { ok: false, why: '正文为空（写清"为什么"）' };
  return { ok: true, exp: { id, triggers, action, body, file } };
}

/** 读一整个目录。坏条目收进 bad（调用方决定要不要 warn） */
export function loadExperiences(dir) {
  const out = { list: [], bad: [] };
  if (!dir || !existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((f) => /\.md$/i.test(f)).sort()) {
    const file = path.join(dir, name);
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch (e) { out.bad.push({ file: name, why: '读不动：' + (e && e.code) }); continue; }
    const r = parseExperience(text, name);
    if (r.ok) out.list.push(r.exp); else out.bad.push({ file: name, why: r.why });
  }
  return out;
}

/**
 * 命中才注入：按**命中关键词个数**打分 ✓ 同分按 id 字典序 ✓（可复现）
 * @returns [{ id, action, score }]（不含正文 ✗）
 */
export function matchExperiences(text, list, limit = 3) {
  const hay = String(text || '').toLowerCase();
  if (!hay.trim()) return [];
  const scored = [];
  for (const exp of list || []) {
    let score = 0;
    for (const t of exp.triggers || []) {
      if (t && hay.includes(t)) score++;
    }
    if (score > 0) scored.push({ id: exp.id, action: exp.action, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.slice(0, Math.max(1, Number(limit) || 3));
}
