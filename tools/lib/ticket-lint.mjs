/**
 * tools/lib/ticket-lint.mjs —— 票板**纯函数**解析与检查（无 IO ✓ 可单测 ✓）
 *
 * v1.3（2026-10-25 夜，吸收 GPT《反馈复核》6 个反例）：
 *   ① 票号只在**本票块内**读声明 ✗ 不再跨票窗口（原窗口会扫进下一张票 ✗ → 误报"票号重复"）
 *   ② **票头声明不等于回票点名** ✗ 回票点名只从**回票记录**里找（`> ✅ …` 那些行）
 *   ③ **代码块 / 模板说明不参与判定** ✗（示例里的 ✅、``` 里的"证据标签可选…"都不算实际记录）
 *   ④ 试行统计改口径：分母 = **有回票记录的票**（适用回票）✓；"0 次使用"只**触发复核** ✓ 不写"可以砍"
 *   ⑤ 日期以**票号里的日期**为准 ✓ 与票头不一致时提示（不默默取"任一够新"）
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const STATE = { ' ': '待处理', '~': '处理中', v: '待验收', x: '已完成', '-': '已取消' };
const HEAD_OK = /^## \[([ ~vx-])\] \[([^\]]{1,40})\](.*)$/;
const HEAD_OLD = /^## \[([^\]]{1,40})\](.*)$/;
const ID_RE = /T-(20\d\d\d\d\d\d)-([A-Z])\d{2}/;
const ID_DECL = /(?:^|[^\w*])(?:\*\*)?票号(?:\*\*)?\s*[：:]\s*(T-20\d\d\d\d\d\d-[A-Z]\d{2})/;
const CLAIM = /(^|\n)[ \t]*(?:[-*·][ \t]*)?(?:\*\*)?认领(?:\*\*)?\s*[：:]/;
const LABELS = /(静态检查|自动测试实测|目标环境实测|人工样本复核|未验证)/;
const SECRET = /(password|passwd|secret|token|api[_-]?key|密码|口令)\s*[=:：]\s*\S{6,}/i;

/** 把文本切成 {lines, fenced[]} —— fenced[i] = true 表示该行在 ``` 块里 */
export function scanFences(lines) {
  const fenced = new Array(lines.length).fill(false);
  let inF = false;
  for (let i = 0; i < lines.length; i++) {
    // ★ v1.10.32（T-20261027-P02 发布工程师现场）：**引用代码块 `> ``` ` 也算围栏** ✗
    //   以前只认行首三反引号 ⇒ `> ``` ` 里的内容照扫 ⇒ 块内 `> ✅ …` 被当成回票 ✗（真板 21→23 那次）
    //   ⇒ 先剥掉引用前缀（`>` 与空白）再判围栏 ✓
    if (/^\s*(?:>\s*)?```/.test(lines[i])) { inF = !inF; fenced[i] = true; continue; }   // 围栏行本身也算"非实际内容"
    fenced[i] = inF;
  }
  return fenced;
}

/**
 * 剥掉**行内代码**（`` `…` ``）—— 与代码块同一个理由（v1.6 · 五线现场反馈）：
 * 引用别人的回票原文、写格式样例、写字段样例，都会把符号和票号带进正文 ✗
 * 不剥 ⇒ 引用被判成行为 ✗ 样例被判成凭据 ✗（实测：`password=abcdef123` 被误报）
 */
export function stripInline(s) {
  return s.replace(/`[^`\n]*`/g, '');
}

/** 解析票块：状态/路由/标题/块范围/非代码块正文/票号声明/回票记录 */
export function parseTickets(text) {
  /* ★ 2026-10-26 修（调试会话实测发现的真 bug ✗）：
     原来是 `eol = text.includes('\r\n') ? '\r\n' : '\n'` 然后 `text.split(eol)` ✗
     一旦文件**混了行尾**（有人用 LF 追加、老内容还是 CRLF ✗），`split('\r\n')` 会把整个文件当成 **2 行** ✗
     ⇒ 一张票都解析不出来 ✗ 而且自检会**安静地报"0 张票"** ✗✗（比报错更危险 ✗）
     → 现在永远按 `/\r?\n/` 切 ✓ 混用也不会崩 ✓ 写回时仍用检测到的行尾 ✓ */
  const raw = String(text || '');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const SCAN = scanReplyRecords(raw);            // ★ 共享扫描器（v1.10.1）✓ 边界只有一处 ✓
  const lines = SCAN.lines;
  const fenced = SCAN.fenced;
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const ok = HEAD_OK.exec(lines[i]);
    if (ok) { heads.push({ i, state: ok[1], route: ok[2], title: ok[3].trim(), bad: false }); continue; }
    const old = HEAD_OLD.exec(lines[i]);
    if (old) heads.push({ i, state: '?', route: old[1], title: old[2].trim(), bad: true });
  }
  const tickets = heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;   // 块 = [头行, 下一票头) ✓
    const block = lines.slice(h.i + 1, end);
    const blockFenced = fenced.slice(h.i + 1, end);
    const rawLines = block.filter((_, j) => !blockFenced[j]);      // 代码块已剥
    const bodyRaw = rawLines.join('\n');                            // ↑ 行内代码还在（只有"验收"字样用这份）
    const bareLines = rawLines.map(stripInline);                    // 行内代码也剥（一切符号判定都用这份）
    const body = bareLines.join('\n');
    // 票号：只在本块内、非代码块、非行内代码里读**声明**（多个不同值 ⇒ 歧义）
    const decls = [];
    for (const l of bareLines) { const m = ID_DECL.exec(l); if (m) decls.push(m[1]); }
    const uniq = [...new Set(decls)];
    // 回票记录：★ v1.10.1（GPT F02）改用**共享扫描器** ✗ 不再自己再写一套边界 ✗
    //   （两套边界 ⇒ 检查器看得见、归位器看不见 ✗ 同一份合法文本两种身份 ✗）
    const replies = SCAN.recs
      .filter(r => r.start >= h.i + 1 && r.start < end)
      .map(r => ({ ...r, start: r.start, end: r.end }));
    const replyLines = replies.flatMap(r => r.lines);
    // ★ P1（2026-11-02）：**派活记录**落票板 —— `**派活**：@调试 2026-11-02 10:13`
    //   为什么要有：派活原本只存在于插件内存与会话里 ✗ 脚本一重启去重集合就丢
    //   ⇒ 同一张票会被派第二次（README 自己列的三个坑之一）✗
    //   落到票板上以后：① 重复派活能查 ② "派了多久还没回票"能催 ③ 票板仍是唯一台账 ✓
    //   边界与回票记录同一套：只认本块、非代码块、非行内代码 ✓（bareLines 已剥过）
    const dispatch = [];
    for (let li = 0; li < bareLines.length; li++) {
      const dm = /^\s*(?:\*\*)?派活(?:\*\*)?\s*[：:]\s*(.*)$/.exec(bareLines[li]);
      if (!dm) continue;
      const rest = dm[1].trim();
      const tm = /(20\d\d-\d\d-\d\d)[ T](\d{1,2}:\d{2})/.exec(rest);
      const target = (rest.replace(/(20\d\d-\d\d-\d\d)[ T]\d{1,2}:\d{2}/, '').match(/@?([^\s@，,]+)/) || [, ''])[1] || '';
      let atMs = null;
      if (tm) {
        const ms = new Date(+tm[1].slice(0, 4), +tm[1].slice(5, 7) - 1, +tm[1].slice(8, 10),
          +tm[2].split(':')[0], +tm[2].split(':')[1]).getTime();
        atMs = Number.isNaN(ms) ? null : ms;
      }
      dispatch.push({ target, at: tm ? tm[1] + ' ' + tm[2] : '', atMs, raw: rest, line: h.i + 2 + li });
    }
    return {
      line: h.i + 1, raw: lines[h.i], state: h.state, route: h.route, title: h.title, bad: h.bad,
      end, body, bodyRaw, bodyLines: bareLines, decls, id: uniq.length === 1 ? uniq[0] : '', idConflict: uniq.length > 1,
      replies, replyLines, reply: replyLines.join('\n'), dispatch
    };
  });
  // "回票落在票块外"：v1.10 起只在**真正的回票记录**里找候选 ✗ 不再扫原始文字 ✗（C05）
  const allReplies = tickets.flatMap(t => t.replies.map(r => ({ ...r, ownerId: t.id || '', ownerLine: t.line })));
  return { eol, lines, fenced, tickets, allReplies };
}

/**
 * 交接文件里的**票号指针**交叉核对（`--with-handoff` · 纯函数 · 无 IO）
 *
 * 要解决的真问题：交接只写指针（`见 T-…`）✓ 那么**指针必须能落到票** ✓
 *   · 落到**活票板** → 正常 ✓
 *   · 落到**归档文件** → 也正常 ✓（归档不是丢票 ✓ 别误报悬空 ✗）
 *   · 两处都没有 → **悬空指针** ✗ —— 半年后没人知道当初指的是哪张票 ✗
 *
 * 口径（写死，免得以后漂移）：
 *   ① 代码块（``` 围栏）里的票号**不算** ✓ 同 parseTickets 的围栏规则
 *   ② **行内代码（`` `T-…` ``）里的票号当成示例/模板，不算指针** ✗ —— 同 §0 铁律 4
 *      （实测踩到：交接第 1128 行是规则说明，里面 `见 T-…` 是个示例 ✗ 当成指针就会误报 ✗）
 *      ⇒ 真要写指针就别套反引号 ✓；被跳过的示例会**单独计数打出来** ✓ 不静默丢 ✗
 *   ③ 能不能"落到票"用**票号声明**（`**票号**：T-…`）判 ✗ 不用"文本里出现过"✗
 *      （后者会把票板头部模板里的示例号算成"有这张票" ✗ 又一个"示例冒充证据"✗）
 *   ④ 能定位**不等于**内容对 ✗ —— 这里只证明"这张票存在"✓
 *
 * @param {string} handoffText 交接文件全文
 * @param {{name:string,text:string}[]} sources 对照源（票板 / 归档 …）
 */
export function lintHandoffPointers(handoffText, sources = []) {
  const eol = handoffText.includes('\r\n') ? '\r\n' : '\n';
  const lines = handoffText.split(eol);
  const fenced = scanFences(lines);
  const RE = /T-20\d\d\d\d\d\d-[A-Z]\d{2}/g;
  const refs = [];
  let examples = 0;
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const raw = lines[i];
    // ② 行内代码里的票号 = 示例/模板 ⇒ 只计数，不判定
    for (const span of raw.match(/`[^`]*`/g) || []) examples += (span.match(RE) || []).length;
    const bare = stripInline(raw);
    const m = bare.match(RE);
    if (!m) continue;
    for (const id of m) refs.push({ line: i + 1, id });
  }
  const ids = [...new Set(refs.map(r => r.id))];
  // ③ 声明口径：只有真声明过的票号才算"这张票存在"
  const known = sources.map(s => {
    const list = parseTickets(s.text).tickets;
    return { name: s.name, total: list.length, set: new Set(list.map(t => t.id).filter(Boolean)) };
  });
  const resolved = {};
  for (const id of ids) {
    const hit = known.find(s => s.set.has(id));
    if (hit) resolved[id] = hit.name;
  }
  const dangling = ids
    .filter(id => !resolved[id])
    .map(id => ({ id, lines: refs.filter(r => r.id === id).map(r => r.line) }));
  return {
    lines: lines.length,
    refs: refs.length,
    examples,
    ids,
    resolved,
    dangling,
    sources: sources.map(s => s.name),
    declared: known.map(s => ({ name: s.name, n: s.set.size, total: s.total }))
  };
}

/**
 * v1.8：给下游的**稳定 JSON 契约**（`--json` 用的就是它 ✓ 纯函数 ✓ 可单测 ✓）
 * 规矩：**字段只加不改名** ✓ 要改就升 schemaVersion ✓ —— 下游靠这个契约写视图，不靠 import 内部实现 ✓
 */
export function buildReport(res, meta = {}) {
  const { tickets, problems, realProblems, debtProblems, unknownProblems, cnt, trial } = res;
  // ★ v1.10.23（T-20261027-D13）：`--assume-debt` 是**口径选择** ✗ 不是判定 ⇒ JSON 里必须看得见 ✓
  const assumedDebt = !!(meta && meta.assumeDebt);
  // ★ v1.10.7（GPT N01）：回退也要排除 unclassified ✗ 否则"漏传异常数组"会把异常算进 knownReal ✗
  const unclassifiedProblems = res.unclassifiedProblems || problems.filter(p => p.unclassified);
  const knownRealProblems = res.knownRealProblems || realProblems.filter(p => !p.unknown && !p.unclassified);
  const unclassified = unclassifiedProblems.length;
  const byKind = (list) => { const m = {}; for (const p of list) m[p.kind] = (m[p.kind] || 0) + 1; return m; };
  return {
    schemaVersion: 1,
    tool: 'ticket-check',
    file: meta.file || '',
    debtSince: res.debtSince,
    // v1.10（GPT §3.4）：**范围**要能追溯到 ✓ 问题只查活跃票板 ✗ 交接引用才可能查归档 ✓
    ...(meta.scope ? { scope: meta.scope } : {}),
    tickets: {
      total: tickets.length,
      states: { open: cnt[' '], claimed: cnt['~'], pendingAccept: cnt.v, done: cnt.x, cancelled: cnt['-'], legacyFormat: cnt['?'] }
    },
    summary: {
      real: realProblems.length, debt: debtProblems.length, unknown: unknownProblems.length, total: problems.length,
      // v1.10（GPT §3.1）：`unknown` 是 `real` 的**子集** ✓ 另外给出 `knownReal = real − unknown` ✓
      //   v1 的 `real` 含义**不变** ✗ 不悄悄改成"排除 unknown" ✗（下游会读到不同数 ✗）
      knownReal: knownRealProblems.length,
      unclassified,
      assumedDebt,
      byKindReal: byKind(realProblems), byKindDebt: byKind(debtProblems)
    },
    problems: problems.map(p => ({ kind: p.kind, code: p.code || '', line: p.line, ticketLine: p.ticketLine || p.line, title: p.title, detail: p.detail || '', debt: !!p.debt, unknown: !!p.unknown, unclassified: !!p.unclassified, ticket: p.ticket || '' })),
    trial: { since: trial.since, sample: trial.n, replies: trial.replies, claim: trial.claim, cited: trial.cited, labeled: trial.labeled, dateClash: trial.dateClash },
    ...(meta.snapshot ? { snapshot: meta.snapshot } : {}),
    // ★ P6（2026-11-02）：门禁结果进 JSON —— 以前下游只能从 stderr 文字猜"门禁过没过" ✗
    //   口径：字段**只加不改名** ✓ schemaVersion 仍是 1 ✓
    ...(meta.exitCode !== undefined ? { exitCode: meta.exitCode } : {}),
    ...(meta.gates ? { gates: meta.gates } : {}),
    ...(meta.config ? { config: meta.config } : {}),
    ...(meta.handoff ? { handoff: meta.handoff } : {})
  };
}

/**
 * v1.9.1：**取数快照**（现场：三条线同一张票报了 11 和 10 两个数 ✗ 谁都没错，票板在动 ✗）
 * ⇒ 每次输出都带"什么时候、文件多长、hash 前 8 位" ✓ 两份截图才对得上账 ✓
 * 纯函数 ✓ 传进来算好（CLI 负责读文件与取时间）
 */
export function snapshotOf(text, at = '') {
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) >>> 0; }
  return {
    at: at || '',
    lines: text.split(/\r?\n/).length,
    chars: text.length,
    // v1.10（C08）：下面这个**不是** djb2 ✗（djb2 是 h*33）✗ 而且实测两支文本互换尾部就能碰撞 ✗
    //   保留它只为兼容 ✓ 但**它不能证明同一文本** ✗ 对账请用 contentSha256 ✓
    hash: h.toString(16).padStart(8, '0'),
    hashKind: 'h*31 滚动 32 位（**不是 djb2** ✗ 有碰撞 ✗ 只给人眼估量用 ✓ 对账别用它 ✗）',
    contentSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    contentSha256Kind: 'UTF-8 文本的 SHA-256（**对账用这个** ✓ 完整值 ✓）'
  };
}

/**
 * 回票记录的**唯一**扫描器（v1.10.1 · GPT F02）
 * 检查器、归位器、结票**必须**用同一个边界 ✗ 否则同一条记录在三处身份不一致 ✗
 * 边界规则（写死）：
 *   · 一行 `>` 开头且含 ✅ ⇒ 开始一条记录 ✓
 *   · 后续行必须以 `>` 开头、不含 ✅（出现新 ✅ ⇒ **那是下一条记录** ✗ 不是续行 ✗）
 *   · 代码块/行内代码里的一切都不算 ✓
 * 返回 { lines, fenced, recs }，recs 的 start/end 是 **0 基下标** ✓（对外展示要 +1 ✓）
 */
export function scanReplyRecords(text) {
  const lines = String(text).split(/\r?\n/);
  const fenced = scanFences(lines);
  const recs = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const bare = stripInline(lines[i]);
    if (!/^\s*>/.test(bare) || !/✅/.test(bare)) continue;
    const rec = { start: i, end: i, lines: [bare] };
    for (let k = i + 1; k < lines.length && !fenced[k]; k++) {
      const nb = stripInline(lines[k]);
      if (!/^\s*>/.test(nb)) break;
      if (/✅/.test(nb)) break;              // 新记录开始 ✓
      rec.lines.push(nb); rec.end = k;
    }
    rec.text = rec.lines.join('\n');
    rec.cited = [...new Set(rec.text.match(/T-20\d\d\d\d\d\d-[A-Z]\d{2}/g) || [])];
    rec.titleHint = (/回「([^」]{1,40})」/.exec(rec.text) || [])[1] || '';
    recs.push(rec);
    i = rec.end;
  }
  return { lines, fenced, recs };
}

/**
 * v1.10.4（主人要求）：**两个队列 ＋ 谁该去执行** ✗ 只列票头没用 ✓
 *   · 待处理 `[ ]`/`[~]` → 该动的是**负责人**
 *   · 待验收 `[v]` → 该动的是**验收方**
 * 字段读 `负责人：X｜验收方：Y`（容错加粗 ✓ 规范仍写"别加粗"✗）
 * 老票没有这两个字段 ⇒ 不算错 ✓ 单独列 ✓（§16.1 不回填 ✗）
 */
export function queueOf(tickets) {
  // ★ v1.10.7（GPT N02/N03）：只认**正式责任行** ✗ 不从示例、历史引用、行内代码里捡 ✗
  //   规则：行首（可带 **）就是「负责人」✓ 引用行（> 开头）不算 ✓ 围栏已剥 ✓ 行内代码已剥（bodyLines）✓
  const formalLine = (t) => (t.bodyLines || []).find((l) => /^\s*(?:\*\*)?负责人(?:\*\*)?\s*[：:]/.test(l)) || '';
  const pick = (t, name) => {
    const line = formalLine(t);
    if (!line) return '';
    const re = new RegExp('(?:\\*\\*)?' + name + '(?:\\*\\*)?\\s*[：:]\\s*([^｜|]+)');
    const m = re.exec(line);
    return m ? m[1].trim() : '';
  };
  // ★ v1.10.5（主人要求）：**执行人写具体责任人** ✗ 不写 D／C／P 代号 ✓
  //   这里只做**提示** ✓ 不阻止任何动作 ✗（代号不是错误，只是要人再去查一次表 ✗）
  const isCode = (v) => {
    const bare = String(v || '').replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
    if (!bare) return false;
    const toks = bare.split(/[／/、,，\s]+/).filter(Boolean);
    return toks.length > 0 && toks.every(x => /^[A-Z]{1,2}$/.test(x));
  };
  // ★ v1.10.36（Q线 2026-10-30 现场）：**多负责人的广播票，--queue 要能看出"哪几线已回"** ✗
  //   现场：5 张广播票，负责人写六条线 ⇒ 每次都 grep '^> ✅' 数行 ✗ 容易漏 ✓
  //   做法：从每条回票的**首行**取「… · 职务」里的职务名 ✓ 与负责人逐个对 ✓
  const replyOwners = (t) => {
    const out = new Set();
    for (const r of (t.replies || [])) {
      const NL2 = String.fromCharCode(10);
      const head = String(r.text || '').split(NL2)[0];
      const dot = head.indexOf(String.fromCharCode(183));
      if (dot >= 0) {
        let name = head.slice(dot + 1);
        for (const sep of [String.fromCharCode(12305), "**", String.fromCharCode(65306), ":"]) name = name.split(sep)[0];
        /* ★ T-20261030-F02（Q线 2026-10-30 现场）：**回票首行写「职务（代号）」也要认** ✗
           现场：`✅ **【05:11 · 调试工程师（D）】**` ⇒ 以前恒显示「已回（还没有）」✗
           根因：上面只按 】／**／：／: 切，**没剥尾部（D）**，也没走 `canonicalName`（含 lines 别名）✗
           ⇒ 先 `stripNote` 剥（X）/(X)，再归一成职务 ✓ 认不出就保留原样（不吞名字 ✓）*/
        name = stripNote(name);                              // 调试工程师（D） ⇒ 调试工程师 ✓
        const canon = canonicalName(name);                   // 调试／调试线／D ⇒ 调试工程师 ✓
        if (canon) out.add(canon);
        else if (name) out.add(name);
      }
    }
    return out;
  };
  const splitOwners = (v) => String(v || '').split(/[／/、,，]+/).map(x => x.trim()).filter(Boolean);
  /* 负责人字段也可能写别名（配置里的 lines）⇒ 两边都归一之后比 ✓（T-20261030-F02）*/
  const canonOf = (v) => canonicalName(String(v || '').trim()) || String(v || '').trim();
  const rows = tickets.map(t => {
    const owner = pick(t, '负责人');
    const owners = splitOwners(owner);
    const replied = replyOwners(t);
    const isReplied = (o) => replied.has(canonOf(o));
    const repliedOwners = owners.filter(isReplied);
    return {
      line: t.line, id: t.id || '', route: t.route, title: t.title, state: t.state,
      owner, acceptor: pick(t, '验收方'),
      owners, repliedOwners,
      pendingOwners: owners.filter(o => !isReplied(o)),
      multi: owners.length > 1,
      // ★ P1（2026-11-02）：派活状态进队列 —— 派了多久没回票，是"催办"而不是"该动" ✓
      dispatch: t.dispatch || [], replyCount: (t.replies || []).length
    };
  }).map(r => ({ ...r, ownerIsCode: isCode(r.owner), acceptorIsCode: isCode(r.acceptor) }));
  return {
    open: rows.filter(r => r.state === ' ' || r.state === '~'),
    accept: rows.filter(r => r.state === 'v'),
    missing: rows.filter(r => (r.state === ' ' || r.state === '~') && !r.owner),
    missingAcceptor: rows.filter(r => r.state === 'v' && !r.acceptor),
    // ★ P1（2026-11-02）：已派活但**一条回票都没有** ⇒ 催办清单 ✓（不是"该动"，是"该催"✓）
    //   这张清单以前不存在 ⇒ 派出去之后只能靠人记着 ✗ 现在票板自己会算 ✓
    dispatched: rows.filter(r => (r.state === ' ' || r.state === '~') && r.dispatch.length > 0 && r.replyCount === 0)
  };
}

/**
 * v1.10.1（GPT §6）：**稳定的 code**（英文、小写、连字符 ✓ 一义一码 ✓）
 * 规矩：`kind` 中文**字面值冻结** ✗ 只加 `code` 不改名 ✓ 换含义就新开 code ✓
 */
export const KIND_CODES = {
  '格式': 'bad-header',
  '时间': 'missing-header-date',
  '缺票号': 'missing-ticket-id',
  '票号重复': 'duplicate-ticket-id',
  '票号只在标题': 'ticket-id-in-title-only',
  '票号歧义': 'ambiguous-ticket-id',
  '回票未点名': 'reply-target-missing',
  '回票指向别的票': 'reply-points-elsewhere',
  '回票不在票块内': 'reply-outside-own-block',
  '回票了但状态没推': 'reply-state-unconfirmed',
  '符号冒充回票': 'reply-marker-without-record',
  '完成缺证据': 'done-without-reply-record',
  '负责人不是具体责任人': 'owner-not-a-name',
  // ★ T-20261101-F02（借 dsh-superagent 的授权模型）：**事前**就不让"没授权的活儿"进来 ✗
  '授权强度不足': 'authorization-weak',
  // ★ T-20261101-F05：**躺在 `[ ]` 里超 24h 还没补授权**（与 weak 不重复：weak 管"已动工"，这条管"没动工但放太久"）
  '授权待补': 'authorization-stale',
  // ★ P1（2026-11-02）：同一张票被派了两次 ⇒ 收票方重复开工 ✗ 而且两边各回一次票，票板对不上 ✗
  '重复派活': 'dispatch-duplicate',
  '阻塞没写清谁': 'blocker-vague',
  '缺验收方式': 'missing-acceptance-method',
  '疑似凭据': 'suspected-secret'
};

/**
 * ★ v1.10.22（主人 2026-10-27："工作时称职务"）
 * **职务制**：票面只出现职务 ✓ 旧线名／代号／代指一律作别名归一或判不合格 ✗
 *
 *   流程管理员  F   ← 流程线 / 流程 / F
 *   调试工程师  D   ← 调试 / 调试线 / D
 *   卡片工程师  C   ← 卡片 / 卡片线 / 卡片会话 / C
 *   发布工程师  P   ← 线上发布 / 线上 / 线上发布会话 / P
 *   项目负责人  M   ← 主人 / 用户
 */
const DEFAULT_NAMES = new Map(Object.entries({
  '流程管理员': '流程管理员', '流程线': '流程管理员', '流程': '流程管理员', 'F': '流程管理员', 'f': '流程管理员',
  '调试工程师': '调试工程师', '调试': '调试工程师', '调试线': '调试工程师', 'D': '调试工程师', 'd': '调试工程师',
  '卡片工程师': '卡片工程师', '卡片': '卡片工程师', '卡片线': '卡片工程师', '卡片会话': '卡片工程师', 'C': '卡片工程师', 'c': '卡片工程师',
  '发布工程师': '发布工程师', '线上发布': '发布工程师', '线上': '发布工程师', '线上发布会话': '发布工程师', 'P': '发布工程师', 'p': '发布工程师',
  '项目负责人': '项目负责人', '主人': '项目负责人', '用户': '项目负责人', 'M': '项目负责人',
  // 代指一律不合格 ✗（映射到空串 ⇒ checkNames 判 bad）
  '你们': '', '我们': '', '对方': '', '大家': '', '自己': '', '各领自己那条': '',
  '相关': '', '某人': '', '下次': '', '待定': '', '各线': '', '全体': ''
}));

/**
 * ★ v1.10.26（Q线反馈 §三.1）：**线名不能写死** ✗
 * 他们的 `宿主线（H）`／`Q线`／`开票系统线` 全被判不合格 ✗ —— 因为这五个职务是我们仓的 ✗
 * ⇒ 允许在 `docs/.ticketrc.json` 里覆盖/追加：
 *   { "lines": { "宿主线": ["H", "宿主"], "Q线": ["Q"] } }
 *   值是数组 ✓ 也接受字符串（按 ／ 、 , 拆）✓
 * 默认（本仓五个职务）**始终保留** ✓ 混着写也能认 ✓
 */
let EXTRA = new Map();

let EXTRA_CODES = new Map();   // 职务 → 票号线码（配置里"像代号"的别名 ⇒ 自动当码 ✓）

export function setLineNames(cfg) {
  EXTRA = new Map();
  EXTRA_CODES = new Map();
  if (!cfg || typeof cfg !== 'object') return;
  for (const [name, aliases] of Object.entries(cfg)) {
    const canon = String(name).trim();
    if (!canon) continue;
    EXTRA.set(canon, canon);
    const list = Array.isArray(aliases) ? aliases : String(aliases == null ? '' : aliases).split(/[／/、,，]+/);
    for (const a of list) {
      const k = String(a).trim();
      if (!k) continue;
      EXTRA.set(k, canon);
      // ★ v1.10.27（Q线）：**只配了一半** —— 名字走配置、票号字母却还是硬编码 ✗
      //   现在：别名里"1~2 位字母"当票号字母 ✓（`["H","宿主"]` ⇒ H）
      if (/^[A-Za-z]{1,2}$/.test(k) && !EXTRA_CODES.has(canon)) EXTRA_CODES.set(canon, k.toUpperCase());
    }
  }
}

/**
 * ★ v1.10.27（Q线）：**票号字母也要能配** ✗
 * 取码顺序：配置别名里的短码 ✓ → 内置五职务表 ✓ → ''（调用方应给 `--code` 或提示去配）
 */
export function codeFor(name) {
  const canon = canonicalName(name) || String(name || '').trim();
  if (!canon) return '';
  if (EXTRA_CODES.has(canon)) return EXTRA_CODES.get(canon);
  return LINE_CODES.get(canon) || '';
}

/** 当前生效的票面名字表（默认五个职务 ＋ 配置追加 ✓） */
export function lineNamesMap() {
  const m = new Map(DEFAULT_NAMES);
  for (const [k, v] of EXTRA) m.set(k, v);
  return m;
}


/** 职务 → 票号线码 */
export const LINE_CODES = new Map(Object.entries({
  '流程管理员': 'F', '调试工程师': 'D', '卡片工程师': 'C', '发布工程师': 'P', '项目负责人': 'M'
}));

/** 职务是唯一可写形式 ✓ 这个列表给报错和文档用 */
export const ALL_TITLES = ['流程管理员', '调试工程师', '卡片工程师', '发布工程师', '项目负责人'];

/** 去括号与首尾空白：调试／卡片（各领自己那条）⇒ 调试／卡片 ✓ */
export const stripNote = (v) => String(v == null ? '' : v)
  .replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();

/** 拆名字（／、/、、、, 都算分隔 ✓） */
export const splitNames = (v) => stripNote(v).split(/[／/、,，]+/).map((x) => x.trim()).filter(Boolean);

/** 单个名字归一成职务（空串＝认不出 ✗） */
export const canonicalName = (n) => lineNamesMap().get(String(n).trim()) || '';

/** 校验一个负责人/验收方字段 ⇒ { ok, canonical, bad } */
export function checkNames(v) {
  const raw = stripNote(v);
  if (!raw) return { ok: false, canonical: [], bad: ['（空）'] };
  const canonical = [];
  const bad = [];
  for (const p of splitNames(raw)) {
    const c = canonicalName(p);
    if (c) canonical.push(c); else bad.push(p);
  }
  return { ok: bad.length === 0 && canonical.length > 0, canonical: [...new Set(canonical)], bad };
}

/** 从票块里取字段（只认正式行 ✓） */
export function fieldOf(t, name) {
  const re = new RegExp('(?:\\*\\*)?' + name + '(?:\\*\\*)?\\s*[：:]\\s*([^｜|]+)');
  for (const l of t.bodyLines || []) {
    const m = re.exec(l);
    if (m) return m[1].trim();
  }
  return '';
}


/**
 * ★ v1.10.19（GPT R01）：**配置读不了就必须失败** ✗ 不许静默回退默认值 ✗
 *   以前：坏 JSON ⇒ 警告一句（还只在普通输出分支）＋ exit 0 ⇒ JSON/queue 调用方以为"按项目配置判定"✗
 * 返回 { source, cfg, error } —— error 非空 ⇒ 调用方**统一 exit 2** ✓
 * 只有"文件不存在"才是"没配置 ⇒ 用默认值" ✓ 这是两件事 ✗
 */
export function loadConfig(root) {
  const cands = [path.join(root, 'docs', '.ticketrc.json'), path.join(root, 'package.json')];
  for (const p of cands) {
    if (!existsSync(p)) continue;
    const rel = path.relative(root, p).split(path.sep).join('/');
    let raw;
    try { raw = readFileSync(p, 'utf8'); }
    catch (e) { return { source: rel, cfg: null, error: '读不动：' + ((e && e.code) || 'EUNKNOWN') }; }
    let j;
    try { j = JSON.parse(raw.replace(/^﻿/, '')); }
    catch (e) { return { source: rel, cfg: null, error: '不是合法 JSON：' + String((e && e.message) || e) }; }
    const c = p.endsWith('package.json') ? (j.ticket || null) : (j.ticket || j);
    if (c && typeof c === 'object' && Object.keys(c).length) return { source: rel, cfg: c, error: '' };
    if (c != null && typeof c !== 'object') return { source: rel, cfg: null, error: '配置不是对象' };
  }
  return { source: '', cfg: null, error: '' };
}

/**
 * ★ v1.10.19（GPT R04）：日期不仅要"格式对"，还要**日历上存在** ✗
 *   以前：月份 1–12、日 1–31 各自合法就放行 ⇒ `2026-02-30`、`2026-04-31` 都被接受 ✗
 */
export function tsOk(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(String(v == null ? '' : v));
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d > days) return false;
  if (m[4] !== undefined && (+m[4] > 23 || +m[5] > 59)) return false;
  return true;
}

/**
 * v1.10.18（五线·宿主线 EACCES 现场）：**"存在"≠"能读"** ✗
 * existsSync ＋ isFile 过了，readFileSync 仍可能 EACCES／EPERM ⇒ 裸栈 ✗ exit 1 被读成"有真问题"✗
 * 这里只做**纯读取**，不退出 ✓ 由各 CLI 决定怎么说话 ✓
 */
export function readTextSafe(p) {
  try {
    return { ok: true, text: readFileSync(p, 'utf8') };
  } catch (e) {
    return { ok: false, code: (e && e.code) || 'EUNKNOWN' };
  }
}

/**
 * ★ v1.10.28（主人 2026-10-27）：**闭环五问** —— 事事有回应／件件有着落／凡事有交代／句句有回答／沟通有闭环
 *
 * 这不是新"判据"，是**体检报告** ✓ 一条命令把五件事各自的"未闭环项"列出来 ✓
 * 全部只读 ✓ 不改票板 ✗ 退出码恒为 0 ✓（要门禁请用 `--strict` ✗ 别拿这个当门禁）
 *
 * 五条口径（都写死在这里，避免各处再解释一遍 ✗）：
 *   ① 事事有回应：**活跃票**超过 `replyHours` 小时没有任何回票 ⇒ 列出来
 *   ② 件件有着落：活跃票缺 `负责人`／`验收方`，或写成代号/代指 ⇒ 列出来
 *   ③ 凡事有交代：`[x]` 完成票**没有点名自己的回票记录**（完成缺证据）⇒ 列出来
 *   ④ 句句有回答：票面里有**疑问**（`？`／「请确认」「请回答」「征求意见」／① ② ③ 编号提问）却**没有回票** ⇒ 列出来
 *   ⑤ 沟通有闭环：`[v]` 待验收超过 `acceptHours` 小时没被关 ⇒ 列出来
 */
const VAGUE_IN_BODY = /？|\?|请确认|请回答|请定|征求意见|请点名|要我选|帮我选/;

export function closedLoop(tickets, opt = {}) {
  const replyHours = Number(opt.replyHours) > 0 ? Number(opt.replyHours) : 24;
  const acceptHours = Number(opt.acceptHours) > 0 ? Number(opt.acceptHours) : 12;
  const now = opt.now ? new Date(opt.now).getTime() : Date.now();

  const parseTs = (s) => {
    const m = /(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(s || ''));
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] === undefined ? 12 : +m[4], m[5] === undefined ? 0 : +m[5]);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  };
  const hoursSince = (t) => {
    const ts = parseTs(t.raw || '');
    return ts === null ? null : (now - ts) / 3600000;
  };
  const row = (t, why) => ({ id: t.id || '(无票号)', line: t.line, state: t.state, title: (t.title || '').slice(0, 40), why });

  /* ★ T-20261101-F02：**悬空票复验**（续做前重新校验授权）
     · 悬空定义：[~] 且最后活动 > 24h；或 [v] 且 > 12h
     · 悬空票**再动之前**必须补 `**复验**：YYYY-MM-DD HH:MM ✓ 请求人仍在／规则未变`
     · 一次复验管 24h ✓ [x]／[-] 不要求 ✓ */
  const REVERIFY = /(?:^|\n)\s*>?\s*\*\*复验\*\*[：:]\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/g;
  const reverifiedAt = (t) => {
    const src = String(t.bodyRaw || '');
    let m, last = null;
    REVERIFY.lastIndex = 0;
    while ((m = REVERIFY.exec(src)) !== null) {
      const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      if (!Number.isNaN(d.getTime())) last = d.getTime();
    }
    return last;
  };
  const active = tickets.filter((t) => t.state === ' ' || t.state === '~' || t.state === 'v');
  const out = { reply: [], landed: [], accounted: [], answered: [], closed: [], distributed: [], reverify: [], authz: [], hours: { replyHours, acceptHours } };

  for (const t of active) {
    const hasReply = (t.replies || []).length > 0;
    const h = hoursSince(t);

    // ① 事事有回应
    if (!hasReply && h !== null && h >= replyHours) {
      out.reply.push(row(t, '超过 ' + replyHours + 'h 没有任何回票（约 ' + Math.floor(h) + 'h）'));
    }
    // ② 件件有着落（负责人/验收方）
    if (t.state !== 'v') {
      for (const label of ['负责人', '验收方']) {
        const v = fieldOf(t, label);
        const r = checkNames(v);
        if (!r.ok) out.landed.push(row(t, label + ' 写成了 `' + (v || '（空）') + '`'));
      }
    }
    // ③ 凡事有交代（完成票必须有回票记录）
    if (t.state === 'x' && !(t.replies || []).some((r) => (r.cited || []).includes(t.id))) {
      out.accounted.push(row(t, '[x] 完成但块内没有**点名本票**的回票记录'));
    }
    // ④ 句句有回答（票面有疑问，却没人回）
    if (!hasReply && VAGUE_IN_BODY.test(t.bodyRaw || '')) {
      out.answered.push(row(t, '票面里有疑问（？／请确认／①②③…）但**没有回票**'));
    }
    // ⑤ 沟通有闭环（[v] 久未关）＋ **悬空复验**（T-20261101-F02：续做前重新校验授权）
    const dangling = (t.state === '~' && h !== null && h >= replyHours) || (t.state === 'v' && h !== null && h >= acceptHours);
    const noReplyYet = (!hasReply && h !== null && h >= replyHours);
    if (dangling && !noReplyYet) {
      const rv = reverifiedAt(t);
      const fresh = rv !== null && (now - rv) <= 24 * 3600000;
      if (!fresh) {
        out.closed.push(row(t, (t.state === 'v'
          ? '[v] 待验收超过 ' + acceptHours + 'h 未关（约 ' + Math.floor(h) + 'h）'
          : '[~] 悬空超过 ' + replyHours + 'h（约 ' + Math.floor(h) + 'h）')
          + ' ⇒ **需复验**：续做前补一行 `**复验**：YYYY-MM-DD HH:MM ✓ 请求人仍在／规则未变` ✓（一次管 24h ✓，见规范 §9.2h）'));
        out.reverify.push(row(t, '需复验'));
      }
    }
    // ⑦ 授权待补（T-20261101-F05）：`[ ]` ＋ inferred ＋ 放超 24h 还没确认
    if (t.state === ' ') {
      const az = String(fieldOf(t, '授权强度') || '').split(/[（(：:｜|／/\s]/)[0].trim().toLowerCase();
      if (az === 'inferred' && !/主人已确认/.test(t.bodyRaw || '') && h !== null && h >= 24) {
        out.authz.push(row(t, '**待确认授权（开了约 ' + Math.floor(h) + ' 小时）** ⇒ 补 `**授权**：主人已确认（YYYY-MM-DD HH:MM）` 或作废 `[-]` ✓'));
      }
    }
  }
  // ⑥ 版本分发闭环（v1.10.29 · 主人："每次升级开票系统以后都要分发给各线开票回票，每一步都必须用票说话"）
  //   判法：票板里出现的最新版本号 `v1.x.y` ⇒ 必须有一张**标题含该版本**的票，且该票**有回票** ✓
  //   只查**最新**那个版本 ✓（历史版本不追溯 ✗ 否则老账永远红 ✗）
  // 只认**本工具**的版本号（v1.x ✓）—— 别的软件版本（如 v2.3.5）不算 ✗
  const verRe = /v1\.(\d+)\.(\d+)/g;
  const seen = new Map();
  for (const t of tickets) {
    const text = (t.title || '') + '\n' + (t.bodyRaw || '');
    let m;
    while ((m = verRe.exec(text)) !== null) {
      const key = 'v1.' + Number(m[1]) + '.' + Number(m[2]);
      if (!seen.has(key)) seen.set(key, [Number(m[1]), Number(m[2])]);
    }
  }
  let latest = null;
  for (const [k, v] of seen) {
    if (!latest || v[0] > latest.v[0] || (v[0] === latest.v[0] && v[1] > latest.v[1])) latest = { k, v };
  }
  if (latest) {
    // "分发票"的判法：标题里**同时**有版本号 和 分发/升级/发布 字样 ✓
    //   只在正文提一句版本号 ≠ 分发票 ✗（用例 66 就是这种）
    const dist = tickets.filter((t) => (t.title || '').includes(latest.k) && /分发|升级|发布/.test(t.title || ''));
    const replied = dist.filter((t) => (t.replies || []).length > 0);
    if (!dist.length) {
      out.distributed.push({ id: latest.k, line: 0, state: '-', title: '版本 ' + latest.k, why: '票板里出现了 ' + latest.k + ' 但**没有一张分发票**（标题含版本号）✗ 升级必须开票分发 ✓' });
    } else if (!replied.length) {
      for (const t of dist) out.distributed.push(row(t, '分发票 ' + latest.k + ' **还没有任何回票** ✗（各线必须回票 ✓）'));
    }
  }

  return out;
}

/**
 * ★ v1.10.33（主人 2026-10-27："版本升得太频繁，可以热修的小修复不需要回票，只有中大修复需要回票"）
 * 版本节奏三档（纯函数 ✓ 可单测 ✓）：
 *   文档修 ⇒ 不打包 ／ 不升版 ／ 不要回票
 *   热修   ⇒ 原地改    ／ 不升版 ／ 不要回票（记交接）
 *   中修   ⇒ 打包 ＋ 分发票 ＋ 回票（**可攒着**和下一个中/大修一起发）
 *   大修   ⇒ 同上，且**必须三线回票**
 */
export function releaseTier(changeSet = {}) {
  const changed = Array.isArray(changeSet.changed) ? changeSet.changed : [];
  const addDel = Number(changeSet.addDel) || 0;
  const contract = Array.isArray(changeSet.contract) ? changeSet.contract : [];
  const hasNew = changed.some((c) => c.kind === '新增');
  if (!changed.length) return { tier: '无改动', need: false, why: '工具文件与基线包逐字相同 ⇒ 没有要发的' };
  // 机器判不出"是否破坏契约" ✗ ⇒ 碰了判据/契约一律**至少中修**✓ 真要大修用 `--major` 显式声明 ✓
  if (changeSet.major) return { tier: '大修', need: true, mustReply: true, why: '显式声明大修（`--major`）⇒ 打包 ＋ 分发票 ＋ **必须三线回票**' };
  if (contract.length) return { tier: '中修', need: true, mustReply: true, why: '动了判据库或主 CLI（' + contract.join('／') + '）⇒ 打包 ＋ 分发票 ＋ 回票 ✓ 若能确认破了契约，按大修处理（加 --major）✗' };
  if (changed.length === 1 && addDel <= 15 && !hasNew) return { tier: '热修', need: false, why: '≤1 文件 ＋ ≤15 行 ＋ 非新增 ⇒ 原地修，不打包／不升版／不要回票（记交接）' };
  return { tier: '中修', need: true, mustReply: true, why: '超出小修或新增文件 ⇒ 打包 ＋ 分发票 ＋ 回票（可攒着一起发）' };
}


/**
 * ★ v1.10.37（2026-11-01 · 借 dsh-superagent 的"授权强度"）
 *   **回票署名** ＝ 回票首行 `【时:分 · 职务】` 里那个职务 ✓ 归一成唯一起诉（认不出就返回空 ✗ 不猜）
 *   用途：判"**代回**"——署名既不是本票的负责人/验收方，也不是项目负责人 ⇒ 代回 ✓ 需本人确认 ✗
 */
export function signatureOf(t) {
  const NL = String.fromCharCode(10);
  const DOT = String.fromCharCode(183);      // ·
  const RB = String.fromCharCode(12305);     // 】
  const COLON = String.fromCharCode(65306);  // ：
  const answers = (t.replies || []).filter((r) => r && r.cited && r.cited.length);
  for (const r of answers) {
    const head = String(r.text || '').split(NL)[0];
    const dot = head.indexOf(DOT);
    if (dot < 0) continue;
    let name = head.slice(dot + 1);
    for (const sep of [RB, '**', COLON, ':']) name = name.split(sep)[0];
    name = name.trim();
    if (!name) continue;
    const c = checkNames(name);
    if (c.ok && c.canonical.length === 1) return c.canonical[0];
  }
  return '';
}

/**
 * 「代回」判据（只在**活跃票**和 **2026-10-30 之后开的票**上判 ✓ 老票不回填 ✗）
 * 返回 { impersonated, signer, allowed } —— 认不出签名时 impersonated=false（不猜 ✗）
 */
export function impersonatedOf(t) {
  const active = t.state === ' ' || t.state === '~' || t.state === 'v';
  const m = /T-(\d{8})-/.exec(t.id || '');
  const afterCutover = !!(m && Number(m[1]) >= 20261030);
  if (!active && !afterCutover) return { impersonated: false, signer: '', allowed: [] };
  const split = (v) => String(v || '').split(/[／/、,，]+/).map((x) => x.trim()).filter(Boolean);
  const allowed = [...split(fieldOf(t, '负责人')), ...split(fieldOf(t, '验收方')), '项目负责人'];
  const signer = signatureOf(t);
  if (!signer) return { impersonated: false, signer: '', allowed };
  return { impersonated: !allowed.includes(signer), signer, allowed };
}

/** 主检查 */
export function lintTickets(text, opt = {}) {
  const { lines, tickets, allReplies } = parseTickets(text);
  const problems = [];
  const add = (kind, t, detail, atLine) => problems.push({
    kind, code: KIND_CODES[kind] || '',
    line: atLine || t.line, ticketLine: t.line,
    title: (t.route + ' ' + t.title).slice(0, 60), detail
  });

  // ★ v1.10（C01）：**跨票号的重复声明** ✗ —— 之前完全没查 ✗
  //   后果比"少一条提示"严重：归位工具按号定位会**指到另一张票** ✗（C02）
  const byId = new Map();
  for (const t of tickets) for (const id of [...new Set(t.decls)]) {
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(t);
  }
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    for (const t of list) {
      add('票号重复', t, '票号 ' + id + ' 被 **' + list.length + ' 张票**同时声明 ✗（L' + list.map(x => x.line).join('/L') + '）—— 按号定位/归位/交接核对都会**指错票** ✗ 必须改成唯一 ✓');
    }
  }

  for (const t of tickets) {
    if (t.bad) add('格式', t, '票头不是 `## [状态] [路由] 标题`（缺状态位 / 老格式 ✗）');
    if (!/20\d\d-\d\d-\d\d/.test(t.raw)) add('时间', t, '票头没写日期（推荐 `（2026-10-25 10:40 UTC+8）`）');
    if (t.idConflict) add('票号歧义', t, '本票块内声明了多个不同票号 ✗（' + t.decls.join(' / ') + '）');
    if (!t.id && t.state !== '-') add('缺票号', t, '本票块内没有 `**票号**：T-…` 声明 ✗（不跨票补猜 ✗）');

    const noReply = !t.replies.length;
    const hasReplyMark = /✅/.test(t.body);                    // 正文（非代码块）
    const hasReplyAnywhere = t.decls.length >= 0 && /✅/.test(lines.slice(t.line, t.end).join('\n'));   // 含代码块
    // ② 回票点名：★ v1.10（C03/C04）**逐条记录**判 ✗ 不再把整块回票拼起来判 ✗
    //   （拼起来后：一条正确的回票会把另一条"点错票"或"未点名"掩盖掉 ✗ 判据当场失效 ✗）
    for (const rec of t.replies) {
      if (!/回「/.test(rec.text) && !rec.cited.length) {
        add('回票未点名', t, '**这一条**回票记录里既没有 `回「<原票标题>」` 也没有 `T-…` 票号 ✗（同一块里别的回票点名了不算 ✗）'
        + '；写法：`> ✅ **【时分 · 线：结论】** 回「原票标题」（T-…）` ✓ —— **结票也算回票** ✗ 用"结票 [x]"替代点名会被判成这一条 ✗', rec.start + 1);
      } else if (t.id && rec.cited.length && !rec.cited.includes(t.id)) {
        // ★ v1.10.11（五线 §九.3）：点的号**根本不存在**时要说清 ✗ 否则人会以为自己"号打错了"✗
        const declaredIds = new Set(tickets.map(x => x.id).filter(Boolean));
        const ghost = rec.cited.filter(id => !declaredIds.has(id));
        add('回票指向别的票', t, '**这一条**回票点的是 ' + rec.cited.join(',') + ' ≠ 本票 ' + t.id + ' ✗（同一块里别的回票对了不算 ✗）'
          + (ghost.length ? '；且 ' + ghost.join(',') + ' 在票板里**没有任何声明** ✗（号笔误 ✗ 或那张票压根没开 ✗）' : ''), rec.start + 1);
      }
    }
    // ③ '✅' 只在正文/代码块/模板里出现 ≠ 回票
    //   ★ 现场反例：整块里唯一的 ✅ 是 ``` 里的"回票格式示例" ✗ → 必须报"符号冒充回票" ✓
    //   ⚠ 这个 else-if 必须**紧跟在 `if (!noReply)` 后面**（靠它做互斥）✗ 中间插别的 if 会把它改嫁 ✗
    if (noReply) {
      if (t.state === 'x' && hasReplyAnywhere) add('符号冒充回票', t, '有 ✅ 但没有**回票记录**（`> ✅ …` 的引用行）✗ —— 正文/代码块里的示例不算 ✗');
      else if (t.state === 'x' && hasReplyMark) add('符号冒充回票', t, '正文里有 ✅ 但没有**回票记录** ✗');
    }
    // ★ v1.7 补（2026-10-25 夜 · 现场）：回票写了"状态：[v]"，票头却没改 ✗ —— 声明 ≠ 字段 ✗
    // ★ v1.10.25（T-20261027-D16 误报）：**多个负责人**的票，一条线回了票头仍是 [~] 是**对的** ✓
    //   以前一律判"状态没推" ⇒ 每次别人回一条就红一次 ✗ 现在只在**单一负责人**的票上判 ✓
    const multiOwner = /[／/、,，]/.test(fieldOf(t, '负责人')) || /[／/、,，]/.test(fieldOf(t, '验收方'));
    // ★ v1.10.26（Q线 §三.2）：`[~]` 处理中时，块里的回票**可能是上一轮的** ✗
    //   [v]→[~] 返工时旧回票会一直在 ⇒ 提示持续 ✗ 噪声 ✓ 所以只在 `[ ]`（还没开始就有回票）上判 ✓
    if (!noReply && !multiOwner && t.state === ' ') {
      add('回票了但状态没推', t, '**状态与回票关系待确认**：块内已有回票记录，票头仍是 `[' + t.state + ']` ⇒ 工具**不判断**它属于哪一轮 ✗（重开/重试会保留旧回票 ✗）；kind 字面值保持不变 ✓ 新下游请读 `code: reply-state-unconfirmed` ✓ 这是**提示**，不是阻止写入的结构错误 ✓');
    }
    // 完成缺证据 / 回票落块外 ★ v1.10（C05）：只在**真正的回票记录**里找候选 ✗ 不再扫原始文字 ✗
    if (noReply && (t.state === 'x' || t.state === 'v')) {
      const later = allReplies.filter(r => r.start > t.end);
      const hit = t.id
        ? later.find(r => r.cited.includes(t.id))
        : later.find(r => r.titleHint && t.title.includes(r.titleHint));
      if (hit) add('回票不在票块内', t, '本块没有回票记录，但 L' + (hit.start + 1) + ' 有一条**指向本票**的回票 ✗ ⇒ 追加到别处了 ✓ 用 `ticket-reply` 归位', hit.start + 1);
      else if (t.state === 'x') add('完成缺证据', t, '[x] 但块里没有回票记录（历史票常见 ✓ 只报告）');
    }
    // ★ v1.10.23（D13 的用例 55 撞出来的）：原来只测「验收」两个字 ⇒ 每张票都有「验收**方**」✗
    //   ⇒ 这条判据**从来没生效过** ✗ 现在只认「验收方式」✓
    if ((t.state === ' ' || t.state === '~') && !/验收方式/.test(t.bodyRaw)) add('缺验收方式', t, '[ ]/[~] 但没有「验收方式」✗（写清怎么验：命令／阈值／证据在哪 ✓ 别写「已修好」✗）');

    // ★ v1.10.21（主人 2026-10-27）：**负责人/验收方必须是具体责任人** ✗
    //   只查**活跃票**（待处理/处理中/待验收）✓ 已结老票不回填 ✗
    if (t.state === ' ' || t.state === '~' || t.state === 'v') {
      // ★ v1.10.21：**阻塞**是结构性字段 ✗ 写"等你们确认"就等于没写清谁在等 ✗
      const blocker = fieldOf(t, '阻塞');
      if (blocker) {
        const VAGUE = ['你们', '我们', '对方', '两边', '他们', '大家', '各线'];
        const hit = VAGUE.filter((w) => blocker.includes(w));
        const named = checkNames(blocker).ok;
        if (hit.length && !named) {
          add('阻塞没写清谁', t, '`阻塞` 写成了 `' + blocker + '` ✗ 有代指（' + hit.join('、')
            + '）且没写具体线名 ⇒ 看不出谁在等谁 ✗'
            + ' 请写线名 ✓ 例：`阻塞：等卡片确认「字段清单 v1」`／`阻塞：无`');
        }
      }
      for (const label of ['负责人', '验收方']) {
        const raw = fieldOf(t, label);
        const r = checkNames(raw);
        if (!r.ok) {
          add('负责人不是具体责任人', t, label + ' 写成了 `' + (raw || '（空）') + '` ✗'
            + '（认不出的部分：' + r.bad.join('、') + '）'
            + ' ⇒ **只认**：以上职务 **或你 docs/.ticketrc.json 的 lines 里配的名字** ✓ 多条线用「／」分隔 ✓'
            + ' 旧线名与代号（流程线／调试／卡片／线上发布／D／C／P／F）会**自动归一成职务** ✓ 代指（我们／你们／对方／各领自己那条／下次）一律不合格 ✗'
            + ' 例：`**负责人**：调试工程师｜**验收方**：卡片工程师`');
        }
      }
    }
    if (t.state !== 'x' && SECRET.test(t.body)) add('疑似凭据', t, '未结票里出现疑似明文凭据 ✗（票是永久留存物 ✓ 请改指针）');
    /* ★ T-20261101-F02（2026-11-01 · 照 dsh-superagent 的 002-authorization）：**授权强度**（事前拦 ✗ 不是事后标 ✗）
       三档：explicit＝项目负责人本人明确要求（能引原话）／inferred＝职务自己推断出来的活儿／none＝不许进活跃队列
       规矩：
         · inferred 票**动工前**必须补 `**授权**：主人已确认（YYYY-MM-DD HH:MM）` ⇒ 没有就是真问题 ✗
         · none 还挂在活跃队列 ⇒ 真问题 ✗
         · **存量票不回填** ✗ 没有这一行的老票一律豁免（否则 73 张存量票会集体变红 ✗）
       只管 [ ]/[~]（还没干完/要续做）✓ [v] 已经干完了，再判"动工前"没意义 ✓ */
    {
      const authzRaw = String(fieldOf(t, '授权强度') || '').trim();
      /* 只取**档位那个词** ✓ 括号里的来源说明（`inferred（来源：自查）`）不算档位值 ✗ */
      const authz = (authzRaw.split(/[（(：:｜|／/\s]/)[0] || '').trim();
      /* "动工"的判法：已经进 `[~]` **或** 块里已有回票 ⇒ 活儿开干了 ✓
         只是 `[ ]` 且没人动 ⇒ 还在等确认 ✓ 不算违规（否则新开的 inferred 票一落地就红 ✗ relay 直接写不进去 ✗）*/
      const started = (t.state === '~') || ((t.replies || []).length > 0);
      const working = (t.state === ' ' || t.state === '~');
      if (authz) {
        const val = authz.toLowerCase();
        const confirmed = /主人已确认/.test(t.bodyRaw || '');
        if (!['explicit', 'inferred', 'none'].includes(val)) {
          add('授权强度不足', t, '`授权强度` 写成了 `' + authz + '` ✗ 只认三档：`explicit`（负责人本人明确要求）／`inferred`（自己推断的）／`none`（不许进活跃队列）');
        } else if (val === 'none' && working) {
          add('授权强度不足', t, '`授权强度：none`（没人要的活儿）但还挂在**活跃队列** ✗ ⇒ 要么作废 `[-]`、要么先补授权 ✓');
        } else if (val === 'inferred' && started && !confirmed) {
          add('授权强度不足', t, '`授权强度：inferred`（职务自己推断出来的活儿）**动工前必须有主人确认** ✗'
            + ' ⇒ 票面补一行 `**授权**：主人已确认（YYYY-MM-DD HH:MM）` 才许执行 ✓（事前拦，不是事后标 ✗）');
        } else if (val === 'inferred' && t.state === ' ' && !started && !confirmed) {
          /* ★ T-20261101-F05（2026-11-01）：**躺在 [ ] 里不被拦** 也是口子 ✗
             `ticket-relay` 缺省写 inferred ⇒ 一张 inferred 票可以一直躺在 `[ ]` 里没人管 ✗
             ⇒ `[ ]` ＋ inferred ＋ **建票超 24h** 还没补授权 ⇒ 记 `authorization-stale`
             边界：24h 内不报（太吵 ✗）｜只判 `[ ]`（[~]/[v] 走 weak 那条 ✓）｜**与 weak 不重复**（started 为假才进来 ✓）*/
          const ts = /(20\d\d)-(\d\d)-(\d\d)(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(t.raw || ''));
          if (ts) {
            const born = new Date(+ts[1], +ts[2] - 1, +ts[3], ts[4] === undefined ? 12 : +ts[4], ts[5] === undefined ? 0 : +ts[5]).getTime();
            const ageH = Number.isNaN(born) ? null : (Date.now() - born) / 3600000;
            if (ageH !== null && ageH >= 24) {
              add('授权待补', t, '`授权强度：inferred` 的票**在 `[ ]` 里躺了约 ' + Math.floor(ageH) + ' 小时**还没补授权 ✗'
                + ' ⇒ 要么补 `**授权**：主人已确认（YYYY-MM-DD HH:MM）`、要么作废 `[-]` ✓（24h 内不催 ✓）');
            }
          }
        }
      }
    }
    // ★ v1.8（2026-10-26 · 五线反馈）：票号只写在**标题**里、块内没有声明行 ✗
    //   不报的话，`--with-handoff` 会把它显示成"交接写错"✗ 人得猜是交接错还是票错 ✗
    // ⑧ 重复派活（P1 · 2026-11-02）：同一张票有两条以上派活记录 ✗
    //   为什么算**真问题**而不是提示：重复派活的代价是"两条线各做一遍 + 各回一张票"✗
    //   而票板只认一张票 ⇒ 另一条线的活儿在台账里**不存在** ✗ 这比漏派更贵 ✗
    if ((t.dispatch || []).length > 1) {
      add('重复派活', t, '本票有 **' + t.dispatch.length + ' 条派活记录**（' + t.dispatch.map((d) => (d.target ? '@' + d.target : '无目标') + ' ' + (d.at || '无时间')).join(' / ') + '）✗'
        + ' ⇒ 同一张票被派了多次，收票方会重复开工、各回一张票 ✗ 去重后再派 ✓（派活记录只该留最后一条 ✓）');
    }
    if (!t.id && ID_RE.test(t.raw)) {
      add('票号只在标题', t, '票头标题里出现了票号，但块内没有 `**票号**：T-…` 声明行 ✗ —— 检查器只认声明 ✓（否则交接核对会指向"票不存在"✗）');
    }
  }

  // ── v1.8：把问题拆成「真问题」与「历史债」（五线反馈 §1）───────────────
  //   历史债 = **两条同时成立**（任一不成立 ⇒ 真问题 ✓ fail-closed ✓）：
  //     A. 本票块内没有 `**票号**：` 声明 ✓
  //     B. 票头时间**确定早于** DEBT_SINCE（票号制度生效时刻）✓
  //   v1.9：DEBT_SINCE 允许带时分（`2026-10-25T21:40`）
  //   v1.10（C06/C07）：改成**三态分类** ✗ 不再用字符串比较 ✗
  //     · `9:00` 与 `09:00` 必须同结果 ✓（按**数字分钟**比，不按字符串 ✓）
  //     · 同日但有一边缺时分 ⇒ **unknown**（判不了先后 ✗ 不伪造）✓
  //     · 非法日期/时间（13 月、25 点）⇒ **unknown** ✓ 不补猜 ✗
  //     · unknown **是 real 的子集**（v1 语义不变 ✓）另外给 `knownReal` ✓
  const DEBT_SINCE = opt.debtSince || '2026-10-25';
  const parseTs = (s) => {
    const m = /(20\d\d)-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(s || ''));
    if (!m) return null;
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const hasTime = m[4] !== undefined;
    const hh = hasTime ? +m[4] : null, mm = hasTime ? +m[5] : null;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    if (hasTime && (hh > 23 || mm > 59)) return null;
    return { date: m[1] + '-' + m[2] + '-' + m[3], minutes: hasTime ? hh * 60 + mm : null, hasTime };
  };
  /** 'before' | 'after' | 'unknown' —— 判不了就是 unknown ✗ 不硬塞到任何一边 ✗ */
  const vsSince = (raw, since) => {
    const t = parseTs(raw), s = parseTs(since);
    if (!t || !s) return 'unknown';
    if (t.date < s.date) return 'before';
    if (t.date > s.date) return 'after';
    if (!t.hasTime || !s.hasTime) return 'unknown';   // 同一天但有一边没时分 ⇒ 判不了 ✓
    if (t.minutes === s.minutes) return 'unknown';    // 同一时刻 ⇒ 不判先后 ✓
    return t.minutes < s.minutes ? 'before' : 'after';
  };
  const byLine = new Map();
  for (const t of tickets) byLine.set(t.line, t);
  for (const p of problems) {
    // ★ v1.10.1（GPT F01）：必须按**所属票**（票头行）查 ✗ 不能按问题所在行查 ✗
    //   （回票类诊断的 line 是回票行 ✗ 拿它查票头表必然查不到 ⇒ 掉进 knownReal ✗）
    const t = byLine.get(p.ticketLine) || byLine.get(p.line);
    const ts = t ? parseTs(t.raw) : null;
    const kind = t ? vsSince(t.raw, DEBT_SINCE) : 'unknown';
    p.ticket = t ? (t.id || '') : '';
    // ★ v1.10.2（GPT：我上一轮这条承诺说满了 ✗）：归属查不到时**不许**静默混进 knownReal ✗
    //   现在单独标 `unclassified` ✓ 从 knownReal 里排除 ✓ 汇总单列（正常应为 0）✓
    p.unclassified = !t;
    p.debt = !!(t && !t.id && kind === 'before');
    p.unknown = !!(t && !t.id && kind === 'unknown');
    p.reason = p.unclassified
      ? '**内部异常**：这条诊断的所属票查不到（`ticketLine` 与 `line` 都对不上任何票头）✗ 是工具的锅 ✗ 请报上来 ✓（已从 knownReal 排除 ✓）'
      : (p.debt
        ? '历史债：无票号 ＋ 票头 ' + (ts ? ts.date + (ts.hasTime ? ' ' + String(Math.floor(ts.minutes / 60)).padStart(2, '0') + ':' + String(ts.minutes % 60).padStart(2, '0') : '') : '') + ' 早于 ' + DEBT_SINCE
        : (p.unknown ? '无法判定：无票号，且票头时间与划代时刻的先后判不了（无日期／同日缺时分／格式不合法）⇒ 按 fail-closed 计真问题' : ''));
  }
  const realProblems = problems.filter(p => !p.debt);
  const debtProblems = problems.filter(p => p.debt);
  const unknownProblems = problems.filter(p => p.unknown);
  const unclassifiedProblems = problems.filter(p => p.unclassified);   // 正常应为 0 ✓
  const knownRealProblems = realProblems.filter(p => !p.unknown && !p.unclassified);   // real − unknown − 异常 ✓

  const cnt = { ' ': 0, '~': 0, v: 0, x: 0, '-': 0, '?': 0 };
  for (const t of tickets) cnt[t.state] = (cnt[t.state] || 0) + 1;

  // ── 试行统计（v1.3 口径）──
  const SINCE = opt.since || '2026-10-25';
  const sample = tickets.filter(t => {
    if (!t.id) return false;
    const m = ID_RE.exec(t.id);
    const day = m[1].replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    return day >= SINCE;
  });
  const dateClash = sample.filter(t => {
    const m = ID_RE.exec(t.id);
    const idDay = m[1].replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    const hm = /20\d\d-\d\d-\d\d/.exec(t.raw);
    return hm && hm[0] !== idDay;
  });
  const withReply = sample.filter(t => t.replyLines.length);            // ★ 分母 = 适用回票
  const trial = {
    since: SINCE, n: sample.length, replies: withReply.length,
    claim: sample.filter(t => CLAIM.test(t.body)).length,
    cited: withReply.filter(t => t.id && t.reply.includes(t.id)).length,
    labeled: withReply.filter(t => LABELS.test(t.reply)).length,
    dateClash: dateClash.length
  };
  return { tickets, problems, realProblems, debtProblems, unknownProblems, unclassifiedProblems, knownRealProblems, cnt, trial, lines, debtSince: DEBT_SINCE };
}
