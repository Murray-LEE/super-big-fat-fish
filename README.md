# 开票工作流（kaipiao-workflow）

把「口头协作」变成三份可检索的文件，让「做完了没有」变成**能被机器检查**的东西。

给那些**多个 agent 会话／多个人同时干一个项目**的场景用：谁该动、动了什么、什么事等着谁、有没有闭环，全在文件里，不靠记性。

- 零第三方依赖，Node ≥ 18
- 单文件发行版，拷过去就能用
- 线名、阈值、票号格式都可配

---

## 30 秒上手

```bash
# 0. 先定线名（不配也能跑，但默认线名是原作者项目里的，建议先改）
cp docs/.ticketrc.json.example docs/.ticketrc.json
#   然后把里面的「流程／开发／验收」改成你自己团队的叫法
#   ⚠ 「项目负责人」这个名字别改 —— 代回判定要认它

# 1. 造一个合规样例项目（看看它长什么样）
node tools/mk-proj.mjs

# 2. 开一张票（默认只预演，加 --write 才落盘）
node tools/ticket-relay.mjs --from 流程 --to 开发 \
     --title "把首页加载时间压到 1s 内" \
     --why "产品负责人 2026-11-01 提的" \
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
node 开票工作流-工具包-v1.10.41.单文件.mjs --out .
# 解出来是 docs/ tools/ README.md —— 把 tools/ 拿过去即可
```

> 单文件包**只解包，不自动安装**：`--out` 指定目录，默认不会覆盖任何已有文件（要覆盖加 `--force`）。

### 方式 C：只作为个人写作／研究助手

不需要票板时，`tools/` 里任一脚本都可单独用；最小的两个是 `ticket-relay.mjs`（开票）与 `ticket-check.mjs`（自检）。

---

## 目录

```
.
├─ README.md
├─ LICENSE
├─ .gitignore
├─ docs/
│  ├─ 待办.md                        ← 票板（唯一的真相）
│  ├─ 交接.md                        ← 每次收工追加一行
│  ├─ 角色分工.md                    ← 谁能动哪些文件
│  ├─ .ticketrc.json                 ← 配置（线名／阈值／票号）
│  ├─ 开票工作流-优化版-*.md          ← 规范全文
│  ├─ 开票系统-工作流教程.md          ← 手把手教程
│  ├─ 实装与使用说明.md               ← 装法与验收
│  └─ 开票工作流-v1.10-修复清单.md    ← 修过什么、为什么
├─ tools/
│  ├─ ticket-relay.mjs               ← 传话 → 开票
│  ├─ ticket-reply.mjs               ← 回票 / 结票（含行尾自动归一）
│  ├─ ticket-check.mjs               ← 结构自检 / 队列 / 六问闭环
│  ├─ ticket-titles.mjs              ← 标题规范化
│  ├─ mk-proj.mjs                    ← 生成合规样例项目
│  ├─ identity-check.mjs             ← 账目恒等式
│  ├─ verify-release.mjs             ← 发行包复验（解包逐条 grep）
│  ├─ ticket-check-selftest.mjs      ← 自检用例（89 条）
│  ├─ ticket-reply-selftest.mjs      ← 回票用例（19 条）
│  └─ lib/
└─ dist/
   └─ 开票工作流-工具包-v1.10.41.单文件.mjs
```

---

## 五个概念，够用了

**① 票（Ticket）**：一张票 = 一件要有人做、要有人验收的事。票头一行就是状态：`[ ]` 待办／`[~]` 处理中／`[v]` 待验收／`[x]` 完成／`[-]` 作废。

**② 三个字段是硬约束**：`负责人`／`验收方`／`阻塞`，只能写**线名**（`流程`／`开发`／`验收` 这种），写「你们」「下次」「各领自己那条」直接不合格。

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

## 来源

这套东西是从一个真实的多会话项目里长出来的：三条线（流程／实现／发布）＋ 一个负责人，几个月里踩出来的规矩。

文档里的例子会出现「卡」「世界书」「线上平台」这类词——那是原始项目的背景，**机制本身与它们无关**：换成「需求／文档／部署」一样成立。

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
| 开票 | **下崽** | 新票写进票板 |
| 派活 | **投喂** | 把票喂给负责的那条线 |
| 回票 | **冒个泡** | 负责人回来报一声 |
| 阻塞 | **搁浅** | 卡住了，等人拉一把 |
| 归档 | **洄游** | 旧票游去归档池 |
| 结票 | **上岸** | 不再下水 |

看术语表：

```bash
node tools/ticket-dispatch.mjs --glossary
```

**边界**：`--json` 输出、票面 Markdown 关键字、文件路径、退出码**一律不动**——
彩蛋只在人看的地方，机器读的地方一个字没改 ✓
想换词只改一个文件：`tools/lib/theme.mjs`。

