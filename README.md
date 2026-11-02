# 🐋 超级大肥鱼 · 开票工作流（super-big-fat-fish）

**一只负责统管全局的鲸鱼娘，替你把「口头协作」变成三份可检索的文件。**

它的工作方式很朴素：你把活说出来，它**开锅**（新票进板）、**投喂**（派给该干的线）、等对方**冒个泡**（回票）、**尝味**（验收）、最后**收碗**（结票）。活儿游走一圈，票板上留下了痕迹——「做完了没有」不再靠记性，而是**能被机器检查**。

给那些**多个 agent 会话／多个人同时干一个项目**的场景用：谁该动、动了什么、什么事等着谁、有没有闭环，全在文件里。

- 零第三方依赖，Node ≥ 18
- 单文件发行版，拷过去就能用
- 线名（默认 **添饭／开工／尝味**）、阈值、票号格式都可配
- 想换掉这些叫法：`node tools/lines.mjs`，或直接编辑 `docs/.ticketrc.json`

> 名字来源：鲸鱼娘形象来自社区项目 [Neko3000/deepseek-whalechan](https://github.com/Neko3000/deepseek-whalechan)（DeepSeek 非官方同人）。
> 这套工具本身与任何官方无关，命名只是彩蛋 ✓

---

## 30 秒上手

```bash
# 0. 先定线名（默认就是彩蛋名：添饭／开工／尝味；不改也能跑）
cp docs/.ticketrc.json.example docs/.ticketrc.json
#   想改成你自己的叫法：node tools/lines.mjs --set 前端,后端,QA
#   ⚠ 「项目负责人」这个名字别改 —— 代回判定要认它

# 1. 造一个合规样例项目（看看它长什么样）
node tools/mk-proj.mjs

# 2. 开一张票（默认只预演，加 --write 才落盘）
node tools/ticket-relay.mjs --from 添饭 --to 开工 \
     --title "把首页加载时间压到 1s 内" \
     --why "主人 2026-11-01 提的" \
     --accept "Lighthouse 跑分 ≥ 90 且回归全绿" \
     --origin 主人原话 --write

# 3. 做完回票（回票可以顺手结票）
node tools/ticket-reply.mjs --write --close T-20261101-F01

# 4. 查板子
node tools/ticket-check.mjs            # 结构自检
node tools/ticket-check.mjs --queue    # 谁该动
node tools/ticket-check.mjs --loop     # 六问闭环
```

---

## 装到一台新电脑 / 新项目

### 方式 A：只要这套工具（推荐）

```bash
git clone <这个仓库> kaipiao
cd 你的项目
cp -r ../kaipiao/tools ./tools
cp    ../kaipiao/docs/.ticketrc.json ./docs/.ticketrc.json   # 按需改线名
node tools/mk-proj.mjs                                       # 生成 docs/待办.md 等骨架
```

### 方式 B：用单文件发行版（目标机没有网络或不想带目录）

```bash
node dist/super-big-fat-fish-v<最新>.mjs --out .
# <最新> 看 dist/ 里编号最大的那个（命令：node tools/pack-release.mjs --check 会打印）
# 解出来是 docs/ tools/ README.md —— 把 tools/ 拿过去即可
```

> 单文件包**只解包，不自动安装**：`--out` 指定目录，默认不会覆盖任何已有文件（要覆盖加 `--force`）。

### 方式 C：只作为个人写作／研究助手

不需要票板时，`tools/` 里任一脚本都可单独用；最小的两个是 `ticket-relay.mjs`（开票）与 `ticket-check.mjs`（自检）。

---

## 目录

### 仓库里**现在就有**的

```
.
├─ README.md
├─ LICENSE
├─ .gitignore
├─ .gitattributes
├─ docs/
│  ├─ 待办.md                        ← 空票板模板（装上后这就是你的票板）
│  ├─ .ticketrc.json.example          ← 配置模板（复制成 .ticketrc.json 再改）
│  ├─ 开票工作流-优化版-2026-10-25.md  ← 规范全文
│  ├─ 开票系统-工作流教程.md          ← 手把手教程
│  ├─ 实装与使用说明.md               ← 装法与验收
│  └─ 开票工作流-修复清单-2026-10-26.md ← 修过什么、为什么
├─ tools/
│  ├─ ticket-relay.mjs               ← 开锅：传话 → 开票
│  ├─ ticket-reply.mjs               ← 冒个泡 / 收碗（含行尾自动归一）
│  ├─ ticket-check.mjs               ← 结构自检 / 队列 / 六问闭环
│  ├─ ticket-dispatch.mjs            ← 超级大肥鱼：算谁该动、记账
│  ├─ ticket-archive.mjs             ← 洄游：旧票进归档池
│  ├─ lines.mjs                      ← 线名：看 / 验 / 改名
│  ├─ install.mjs                    ← 一键部署到新机器
│  ├─ setup-plugins.mjs              ← 派活插件体检与安装引导
│  ├─ pack-release.mjs               ← 发行包可复现（--check / --pack）
│  ├─ verify-release.mjs             ← 发行包复验（解包逐条 grep）
│  ├─ json-contract-check.mjs        ← JSON 契约（schemaVersion 1）
│  ├─ ticket-titles.mjs              ← 标题规范化
│  ├─ mk-proj.mjs                    ← 生成合规样例项目
│  ├─ identity-check.mjs             ← 账目恒等式
│  ├─ ticket-check-selftest.mjs      ← 自检用例（93 条）
│  ├─ ticket-reply-selftest.mjs      ← 回票用例（19 条）
│  ├─ write-guard-selftest.mjs       ← 写入保护用例（10 条）
│  ├─ lib/                           ← ticket-lint / ticket-write / theme …
│  └─ schema/                        ← ticket-check.schema.json
└─ dist/
   └─ super-big-fat-fish-v<版本>.mjs  ← 每次发布会多一个（ASCII 名）
```

### 装上之后**才会生成**的（不在仓库里）

```
docs/待办.md           ← 你的真票板（仓库里那份是空模板，`install.mjs` 会按需生成）
docs/交接.md           ← 每次收工追加一行（你自己建，教程里有格式）
docs/角色分工.md        ← 谁能动哪些文件（可选，团队协作时才有意义）
docs/.ticketrc.json    ← 你的线名/阈值（.**gitignore 里，不会进仓库**）
.backups/              ← 每次写票板前的快照（.gitignore）
```

> ⚠ 这三个 `docs/` 下的运行文件**故意不进仓库**：它们记的是**你这个项目**的票和线名，不是工具的一部分。

---

## 五个概念，够用了

**① 票（Ticket）**：一张票 = 一件要有人做、要有人验收的事。票头一行就是状态：`[ ]` 待办／`[~]` 处理中／`[v]` 待验收／`[x]` 完成／`[-]` 作废。

**② 三个字段是硬约束**：`负责人`／`验收方`／`阻塞`，只能写**线名**（默认 `添饭`／`开工`／`尝味`，别名 `流程`／`开发`／`验收` 也认），写「你们」「下次」「各领自己那条」直接不合格。

**③ 回票要点名**：回票首行必须带 `回「原票标题」（T-…）`，否则会被判「回票未点名」——因为票板长了以后，靠位置猜归属一定会错。

**④ 六问闭环**（`--loop`）：事事有回应／件件有着落／凡事有交代／句句有回答／沟通有闭环／升级必分发。全绿时只打一行。

**⑤ 授权强度**：`explicit`（负责人明确要求）／`inferred`（你自己推断的活儿）／`none`。
`inferred` 的票**动工前要有一次确认**，否则 `--strict` 报 `authorization-weak`；建票超 24h 还没确认的，`--loop` 会列进「⑦ 授权待补」。

---

## 配置

`docs/.ticketrc.json`：

```json
{
  "lines": {
    "流程": ["F", "流程线"],
    "开发": ["D", "开发线"],
    "验收": ["Q", "验收线"]
  },
  "loop": { "replyHours": 24, "acceptHours": 12 }
}
```

线名在这里配，代码里没有硬编码。`--from 流程 --to 开发` 用的是配置里的名字。

---

## 常用命令

| 命令 | 作用 | 会写盘吗 |
|---|---|---|
| `ticket-relay.mjs --from A --to B --title … --why … --accept …` | 传话 → 开票 | 否，加 `--write` 才写 |
| `ticket-reply.mjs --write` | 归位回票 | 是（先快照） |
| `ticket-reply.mjs --write --close T-…` | 回票并结票 | 是 |
| `ticket-check.mjs` | 结构自检 | 否 |
| `ticket-check.mjs --queue` | 谁该动 | 否 |
| `ticket-check.mjs --loop` | 六问闭环（`--verbose` 逐段） | 否 |
| `verify-release.mjs --pkg <包> --must-contain "<串>"` | 发行包复验 | 否 |

---

## 放进 CI

```yaml
- run: node tools/ticket-check.mjs --strict
```

`--strict` 在有真问题时会 exit 1，可以直接当门禁。存量债务用 `debtSince` 划界，不会被当成新问题。

---

## 自动化的边界（重要，先读这一节再决定要不要用）

**这个仓库里没有“自动开票／自动验票”。** 它提供的是三样东西里的前两样：

| 层 | 是什么 | 在仓库里 | 说明 |
|---|---|---|---|
| **纸** | `docs/待办.md` 票板、交接、角色分工 | ✓ | 人和 agent 都读同一份文件 |
| **尺子** | `ticket-check` 的判据：六问闭环、代回判定、授权强度、悬空复验 | ✓ | 能机械地判「有没有闭环」 |
| **跑腿** | 谁去开票、谁去回票、把票递给哪条线 | ✗ | **不在本仓库，需要另外的东西** |

`--queue` 和 `--loop` 是**真的自动**——每次跑都会算出「谁该动、哪张票超时、谁代回了谁」。但它们只**报**，不**派人**。

### 我们（原项目）用什么实现“跑腿”

原项目跑在 **DeepSeek Harness（DSH）** 上，用的是它自带的**跨会话工具**（不是 npm 包，也不是本仓库的一部分）：

| 工具 | 作用 |
|---|---|
| `cross_session_spawn` | 新开一个常驻会话（一条“线”），给它一份长期的职责 |
| `cross_session_send` | 把一张票／一句话派给某条线 |
| `cross_session_reply` | 那条线把结果回给派活方 |
| `cross_session_list` / `_status` | 看有哪些线、各自在忙什么 |

**关键分清**：

- DSH 的插件负责 **运输**（会话之间能说话）
- 本仓库的工具负责 **格式与判据**（这些话得像票、能检查）
- **真正的“自动”来自 agent 按规矩行动**（主动开票、到点回票）——这是**纪律**，不是机制

也就是说：装好 DSH 也**不会**让票自己动起来；它只是让“派活”这件事有一个可调用的入口。

### 想清楚你要哪一档，再决定装什么

| 档位 | 你要装什么 | 实际体验 |
|---|---|---|
| **① 手动** | 只要本仓库 | 你自己敲 `ticket-relay`／`ticket-reply`；`--loop` 帮你查漏 |
| **② 半自动（推荐起步）** | 本仓库 ＋ 一个定时任务（cron／CI／任务计划） | 定时跑 `ticket-check --queue`，把结果发到 IM／邮件；**人决定要不要派活** |
| **③ 全自动派活** | 本仓库 ＋ 一个能派活的运行时（如 DSH，或你自建的 agent 编排） ＋ 一张「线名 → 会话」映射表 | agent 自己开票、派活、回票；**出错时也自己刷噪音** |

### 如果要做第 ③ 档，缺的那一块长这样

```js
// 伪代码：watcher（本仓库没有提供，需要自己写）
setInterval(async () => {
  const q = exec('node tools/ticket-check.mjs --queue --json');
  for (const t of q.needAction) {
    if (dispatched.has(t.ticket)) continue;      // 去重：同一张票别派两次
    const session = MAPPING[t.owner];            // 线名 → 会话 id
    await send(session, render(t));
    dispatched.add(t.ticket);
  }
}, 10 * 60 * 1000);
```

三个坑提前说：**去重**（同一张票不能被派两次）、**映射表要维护**（线名改了、会话换了都得跟）、**失败要能停**（派活的脚本自己挂了，别把票刷成噪音）。

### 一句话总结

**这套系统的价值在“把协作变成可检查的文件”，不在“自动”。** 自动是可以加上去的，但那是一层独立的东西，装不装由你决定——本仓库不绑死任何运行时。

---

## 已知边界


- **它是文件型系统，不是数据库**：并发写同一份票板没有锁，靠「先快照再写」兜底。
- **票板会长**：几百张票以后 `--queue` 和 `--loop` 会变慢，建议定期归档到 `docs/待办-归档-YYYYMM.md`。
- **不做权限**：谁能改哪些文件是**约定**，不是强制。真要隔离得靠仓库分权。
- **`[ ]` 阶段拦不住 inferred 票**（24h 内不报），这是刻意的权衡——否则 relay 一开票就被拦。

---


---


---

## 和 dsh-superagent 不是同类

（指 DeepSeek 开源的 `dsh-superagent-prototype`）

**它解决「把活干了」，本项目解决「活有没有人认、有没有人验」。** 它是主动型编码 agent——自己开工作项、动手、提 PR；本项目不碰代码，只记谁该动、做完没有、证据在哪。两者可以叠着用：票板当上游，agent 领活。

本项目不打算长成 agent ✓ 也不建议把两者当替代关系比较 ✗
## 一个不做、但留着的方向：把它当「记忆」用

有人问过：这套东西能不能当 agent 的长期记忆？**能靠上去，但本仓库不做。**

这里只把方向写下来，方便想自己动手的人少走弯路——**它不是路线图，是边界说明**。

### 为什么「能靠上去」

| 已有机制 | 当记忆用时是什么 |
|---|---|
| 票 ＋ 状态机 | 事件记录：做过什么、卡在哪、怎么验的 |
| `**复验**` 行 | 记忆保鲜：这条结论现在还成立吗 |
| 授权强度（explicit／inferred） | 可信度分级：主人说的 vs 自己推的 |
| 归档 | 遗忘：旧记录游出上下文 |
| `--json` 契约 | 记忆可以被程序读 |
| git 历史 | 记忆可回滚、可追溯 |

**它天生是「带证据的记忆」**——每条都能追到来源，这是普通 memory 做不到的。

### 为什么本仓库不做

1. **票板是过程，记忆是结论**——混在一起会把上下文撑爆（一个跑久了的票板轻易到几百 KB）
2. **记错了比不记更糟**——没有失效机制的记忆会让人越走越偏
3. **范围**：这个仓库只负责「谁该动、做完了没有」✗ 记忆是另一件事

### 真要做的话，最少需要这四样

```
① 分层      常驻（≤2k token）／索引（一条一行）／正文（按需读）
② 检索      memory.mjs --recall "关键词"   标签＋关键词＋时间衰减，返回 top N
③ 写入纪律  只记「会改变下一次行为」的东西：硬规矩、踩过的坑、决定与理由
④ 失效      被推翻的不删，标 superseded（删了会重犯，标了才知道为什么变）
```

**外加一条硬要求**：每条记忆必须带来源（票号／日期／谁说的）。**没有来源的记忆等于谣言**——这和票板「不看结论看证据」是同一条规矩。

### 一句话

**如果你要记忆，别直接把票板当记忆库**：从里面抽出「结论」，配上来源与失效标记，单独存一层。票继续记过程，记忆只存判断。

---

## 线程、决策日志、活跃票上限

三样都是「让票面更像数据、少一点靠人记」：

**① 线程：给票一个稳定的锚**

```bash
node tools/ticket-relay.mjs ... --thread "issue:1234"
```

票块里会多一行 `**线程**：issue:1234`。

- 同一线程上的票，`ticket-check --queue` 会打一行 `🔗 同线程多票`
- `ticket-dispatch` 的派活消息会带 `〔线程 issue:1234〕`
- **只是提示，不是错误**——想拆就拆

> 为什么需要：回票靠「回『票标题』」点名，标题一改就挂错票。线程不会变。

**② 决策日志：记下「为什么没派」**

`ticket-dispatch --write` 会往 `docs/决策日志.md` 追加一行：

```
时间 | 票号或线程 | 决定 | 理由代码 | 依据
2026-11-03 04:31 | issue:1234 | 待派 | dispatched | 从未派过
2026-11-03 04:31 | T-…        | 已派待回 | skipped-recent | 已派 0.0h（<24h，先不催）
```

理由代码：`dispatched`／`reminded`／`accepted`／`skipped-recent`／`missing-owner`／`missing-acceptor`。

> 为什么需要：票板只记「派了」。有人问「这票怎么没人动」，没有日志就只能猜。

**③ 活跃票上限提示**

`ticket-check --queue` 在活跃票（`[ ]`＋`[~]`）超过 **8 张**时加一行提示：

```
⚠ 活跃票 9 张（[ ]+[~]），建议同时不超过 8 张（只提示 ✓ 不报错 ✗ docs/.ticketrc.json 的 wipLimit 可改）
```

> 为什么是 8：一个人能同时跟的会话通常是 3–5 个（DeepSeek 那篇 Super-agent 文章里的观察）。票开太多，瓶颈在人不在模型。

**三样都不改变旧行为**：没有 `**线程**` 的票、没有日志文件的板，输出与之前一致。
## 来源

这套东西是从一个真实的多会话项目里长出来的：三条线（流程／实现／发布）＋ 一个负责人，几个月里踩出来的规矩。**它解决的问题是通用的**——多个会话／多人同时改一个仓库时，「谁该动、做完了没有」怎么记账。

文档里的例子一律用中性词（需求／文档／部署），不带具体项目的行业背景 ✓

MIT License.

---

## 部署到一台新机器（照这个顺序，一条一条跑）

> 目标：新机器上 **票板能用 ＋ 能把任务派给别的会话**。
> 前两节是"纸和尺子"，第三节才是"派活能力"——**它不在这个仓库里**，得单独装。

### ① 装好 Node 与仓库

```bash
node -v                 # 要 ≥ 18
git clone <仓库地址> && cd super-big-fat-fish
node tools/ticket-check.mjs            # 能跑就说明"纸和尺子"到位了
```

### ② 让票板指向你自己的项目

```bash
cp docs/.ticketrc.json.example docs/.ticketrc.json   # 改里面的线名
node tools/ticket-check.mjs --queue                  # 谁该动
```

### ③ 装「派活」插件（这一步不能省，否则派不出去）

先体检：

```bash
node tools/setup-plugins.mjs
```

它会查四件事并打印**这台机器上该跑的确切命令**：

| 检查项 | 不满足会怎样 |
|---|---|
| Node ≥ 18 | 工具与自检跑不起来 |
| DSH 数据目录（`~/.dsh`） | 这台机器没装 DSH 桌面版 ⇒ 只能手动开票回票 |
| DSH 程序位置 | 找不到就没法自动装，得手动 `dsh plugin add` |
| profile 里有没有 `dsh-cross-session-approval` | 没有 ⇒ 会话里没有 `cross_session_*` 那套工具 |

体检通过后**自动装**：

```bash
node tools/setup-plugins.mjs --run --profile cs-team     # profile 换成你要用的
node tools/setup-plugins.mjs --check                     # 齐了 exit 0
```

> 插件是**按 profile 挂的**：装进 `desktop` ⇒ 那个 profile 的每个会话都多出 10 个工具；
> 想干净就用专用 profile（如 `cs-team`），只在那个 profile 里派活。

### ④ 让人（或会话）知道该派什么

```bash
node tools/ticket-dispatch.mjs                  # 看板：谁该动、几张、多久没回
node tools/ticket-dispatch.mjs --write          # 把「**派活**：@某人 时间」记进票块
node tools/ticket-dispatch.mjs --emit docs/.dispatch-queue.json   # 给调度会话吃
```

退出码：`0` 有活可派｜`3` 票板干净。

### ⑤ 调度者：**超级大肥鱼**

`ticket-dispatch.mjs` 只负责**算账**（可测、可复跑、不碰网络）；
真正"发消息"由调度会话说 `cross_session_send` 完成——它需要在装了插件的那个 profile 里。

```
每 30–60 分钟：
  node tools/ticket-dispatch.mjs --write          # 算 + 记账
  然后调度会话按看板逐条 cross_session_send（一次一张，别群发）
```

> 为什么不写成"脚本直接发消息"：会话通道是 DSH 插件的能力，不是命令行；
> 脚本硬去写插件内部状态，等于把脆弱假设焊进流程。 **算账归脚本，发消息归会话 ✓**


---

## 🐟 小彩蛋：这套系统的另一个名字

调度者叫 **超级大肥鱼**，所以内部有一份鱼类术语表（**只影响终端里的措辞，不影响任何机器读的字段**）：

| 正式叫法 | 彩蛋叫法 | 说明 |
|---|---|---|
| 票板 | **鱼塘** | 所有票待着的地方 |
| 开票 | **开锅** | 一锅饭开始算（新票进板） |
| 派活 | **投喂** | 把票喂给负责的那条线 |
| 回票 | **冒个泡** | 负责人回来报一声 |
| 阻塞 | **搁浅** | 卡住了，等人拉一把 |
| 归档 | **洄游** | 旧票游去归档池 |
| 结票 | **收碗** | 饭吃完，碗收走 |

看术语表：

```bash
node tools/ticket-dispatch.mjs --glossary
```

**边界**：`--json` 输出、票面 Markdown 关键字、文件路径、退出码**一律不动**——
彩蛋只在人看的地方，机器读的地方一个字没改 ✓
想换词只改一个文件：`tools/lib/theme.mjs`。

> 🐋 **出处**：鲸鱼娘形象与设定来自社区项目 [Neko3000/deepseek-whalechan](https://github.com/Neko3000/deepseek-whalechan)（DeepSeek 非官方同人，MIT / CC-BY-NC-SA 4.0）。这里只借用「白米饭 ＋ 鲸」的意象做彩蛋，不涉及任何官方品牌授权 ✓


---

## 线名：默认是彩蛋，改成你自己的

线名**不是代码写死的**，是配置项：`docs/.ticketrc.json` 的 `lines`。

### 默认长这样（鲸鱼娘彩蛋预设）

| 正式名 | 票号字母 | 还认这些别名 |
|---|---|---|
| **添饭** | F | 流程、流程线 |
| **开工** | D | 开发、开发线 |
| **尝味** | Q | 验收、验收线 |
| **项目负责人** | — | 负责人、主人、用户 |

**别名是真认的**：`--from 流程线` 会落到「鲸尾」，老习惯不用改 ✓
**「项目负责人」这个名字不能改**——代回判定要认它 ✗

### 看现在配了什么

```bash
node tools/lines.mjs          # 每条线的正式名/票号字母/别名
node tools/lines.mjs --check  # 验配置：能加载吗、负责人这条在不在
```

### 改成你自己的（两种方式）

**① 直接编辑** `docs/.ticketrc.json`：

```json
{
  "lines": {
    "前端": ["H", "流程", "添饭"],
    "后端": ["B", "开发", "开工"],
    "QA":   ["Q", "验收", "尝味"],
    "项目负责人": ["负责人", "主人", "用户"]
  }
}
```

- **键**＝正式名（写进票面）
- **值**＝`[票号字母, 别名…]`
- 字母是 1~2 位，票号会长成 `T-20261102-H01`

**② 一条命令改**：

```bash
node tools/lines.mjs --set 前端,后端,QA --codes H,B,Q --dry-run   # 先看
node tools/lines.mjs --set 前端,后端,QA --codes H,B,Q             # 真改（自动备份）
```

**旧名会自动降级成别名** ⇒ 改名不会让老脚本炸 ✓

### 改完必须做两件事

```bash
node tools/lines.mjs --check              # 配置有效
node tools/ticket-check.mjs --queue       # 票面里的线名能对上
```

> 票面里写的线名和配置对不上时，`ticket-check` 会报「线名不认识」——
> 这就是提醒你：要么改配置，要么改票面，**别两边都猜** ✓