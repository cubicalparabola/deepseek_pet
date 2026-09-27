# 记忆机制现状（分层、数据流、保留期、问题清单）

这份文档回答两个问题：**她现在的"记忆"到底由哪些东西组成**、**它们之间怎么流动**。
以及最后：我发现的**缺口与可整理的方案**（按优先级排）。

- 行号基准：`304 项验收通过` 的那一版（记忆迁到项目 `data/`、宫殿接成工具调用、
  小纸条支持删除与文件查看之后）。
  定位请以**符号名**为准，行号只作辅助。
- 与 `README.md` 的关系：README 讲的是动画/行为/插件那套"第一版架构"，**没有** AI 认知层；
  所以记忆这一层的事实来源是代码 + `build/acceptance.json` + 用户真实数据目录。
- 文中"实测"的数据来自迁移前的真实安装目录 `%APPDATA%\DesktopPet`（2 天使用量）；
  迁移后同样的内容出现在 `<项目目录>\data\`，两处条目一一对应，只有位置变了。

---

## 1. 一张总表：谁存什么、存在哪、谁读

| # | 层 | 文件 | 写入者 | 读它的人 |
|---|---|---|---|---|
| 1 | **长期事实** | `memory/profile.json` | 规则抽取（每轮对话）+ 模型抽取（每 6 轮整理） | 聊天/日记/小纸条的提示词 |
| 2 | **流水** | `memory/events-*.jsonl`、`memory/chat-*.jsonl` | 每次互动/对话/开关 | 三路召回（今日事件 + 跨天检索）、日记、反思 |
| 3 | **可读日志** | `memory/memory-log.md` | 上面两者的渲染 | 只有人看（「打开记忆目录」） |
| 4 | **前情摘要** | `memory/profile.json` 的 `summary` | 每 6 轮整理时滚动压缩 | 聊天/日记提示词 |
| 5 | **记忆宫殿** | `memory/nodes.json` + `palace.md` | 反思时 `suggestNodes` + 用户手记 + 自动首见 | 面板、托盘摘要、闲聊的"最近的事"、**聊天时由模型调用 `recall_memory` 按需取** |
| 6 | **反馈流水** | `reflection/feedback-*.jsonl` | 每次主动开口（含是否被回应） | 反思 |
| 7 | **反思与策略** | `reflection/*.json|.md`、`policy.json` | 每天一次（`reflectionHour` 后） | **感知的频率闸门**（唯一反向影响行为的记忆） |
| 8 | **日记** | `diary/YYYY-MM-DD.md` + `index.json` | 每天一次（`diaryHour` 后）+ 启动补写 | 人（面板/托盘/聊天窗口） |
| 9 | **小纸条** | `notes/notes.json` + `notes/files/` | 她自己（「让她记一件」+ 收进来的文件） | 人（聊天窗口「小纸条」「文件」页签） |
| 10 | **感知明细** | `perception/observations-*.jsonl`、`timeline-*.json`、`habits.json` | 每轮采样 | 时间线文本进提示词、习惯预测、反思的场景统计 |
| 11 | **心情曲线** | `mood/mood-YYYY-MM-DD.jsonl` | 每 5 分钟采样一次 | 日记/反思的心情曲线 |
| 12 | **情绪状态** | `emotion.json`（根目录） | 互动/衰减/心跳 | 提示词里的"你现在的状态"、托盘/面板 |

> **位置**：1–5、11 在 `<项目目录>\data\` 下（见 §2），不再写到 C 盘的 `%APPDATA%`。

> 注意 5 和 10 的目录归属容易看错：**记忆宫殿在 `memory/` 里**（由 growth 模块读写），
> 感知明细在 `perception/` 里。`memory/` 因此同时装着"对话记忆"和"经历记忆"。
>
> **记忆宫殿的读法是"按需取"而不是"每轮注入"**：它被做成了模型可调用的工具 `recall_memory`
> （需求："若用户提及相关内容，模型会调用相关工具，再把记忆宫殿的内容传回去"）。
> 见 §3.4 与 §7.3。

## 2. 真实磁盘布局（实测）

```
<项目目录>\data\                     ← 默认在这里（需求：记忆不放 C 盘）
  ai-settings.json            1KB     AI 开关/密钥(AES)/预算/日记时刻/保留期
  emotion.json                0.1KB   当前心情与饱腹
  perception-settings.json    0.8KB   感知开关/采样频率/隐私
  memory\
    profile.json              0.1KB   事实 + 前情摘要 + userName（**不随保留期清理**）
    events-YYYY-MM-DD.jsonl   30–43KB/天   ← 增长最快，> keepMemoryDays 就删
    chat-YYYY-MM-DD.jsonl     0.6–0.9KB/天  ← 同上
    memory-log.md             43KB/2天      ← 按"日期小节"裁剪，同上
    nodes.json / palace.md    0.8/0.6KB    记忆宫殿（另有压缩归档机制）
    archive\palace-<年>.json               压缩留档
  diary\  YYYY-MM-DD.md + index.json       ~1KB/天
  notes\  notes.json (+ files\)            条目上限 500；files 是她收着的文件（可查看/删除）
                                          ← 日记**不再**复制进这里（需求）
  reflection\ YYYY-MM-DD.json|.md, feedback-*.jsonl, policy.json, policy-log.md
  perception\ observations-*.jsonl(92KB/天), timeline-*.json(29KB/天), daily-*.md, habits.json, perception-log.md
  mood\   mood-YYYY-MM-DD.jsonl            ~1.7KB/天
```

目录解析规则（`src/main/data-dir.ts`，优先级从高到低）：

1. 环境变量 `DESKTOP_PET_AI_DATA_DIR`（验收/调试把数据隔离到临时目录）；
2. **项目目录 `<appRoot>/data`**（默认）—— 数据跟着代码走，方便查看与备份；
3. `userData`（兜底）：项目目录不可写时（Program Files、只读盘）自动退回并记 warning。

两条配套措施：
- **一次性迁移**：首次以"项目目录"启动时，把老 `%APPDATA%\DesktopPet` 里的
  记忆条目**复制**过来（源文件保留作安全网），并在 userData 写 `.migrated-to-project`
  标记 —— 之后永不再迁（否则用户删掉 `data/` 又会被"复活"）。
- **`.gitignore` 里必须忽略 `data/`**：里面有 `ai-settings.json`（含 API Key）。

> `logs/desktop-pet.log` 仍在 userData 下（它是诊断而非记忆），并且有轮转；
> Chromium 的 `Cache\` / `GPUCache\` / `Local Storage\` 也留在 userData。

## 3. 逐层细节

### 3.1 长期事实（`MemoryStore`）
- schema：8 类 key（`name / interest / routine / activity / project / preference / relation / note`），
  每条带 `confidence / source / firstSeenAt / lastSeenAt / hits`。
- 两条写入路径，互为兜底：
  1. **规则**（`extractFactsHeuristic`，每轮对话后立刻跑）：覆盖"我叫X / 我喜欢X / 我一般12点睡 /
     我在写论文"这类高价值句式，置信度 0.55–0.8；
  2. **模型**（`extractFactsFromModelOutput`，每 `consolidateEvery`（默认 6）轮整理一次）：能理解
     "我最近在鼓捣一个桌宠"这种没有固定句式的表达，置信度 0.9。
- 合并规则（`mergeFacts`）：同 key+同值 → `hits++`；`name` 是唯一键，可被更高置信度覆盖；
  超过 **200 条**时按 `confidence × hits` 淘汰最弱的。
- **明确不猜**：规则置信度不足就丢掉 —— "记错了比没记住更伤陪伴感"。

### 3.2 流水与检索
- `recordEvent` / `recordTurn` 都先问 `enabled`（记忆开关关掉时不落盘，验收钉过）。
- **三路召回**（`buildContext(query)`，聊天用）：
  1. 事实：与这句话 bigram 重合度打分，`×2` 加权，再按 `confidence×hits` 补位，取 **6 条**；
  2. 过去片段：在最近 `lookbackDays`（默认 **7**）天的 chat/events 里按关键词找，取 **4 条**，带 `MM-DD`；
  3. 今天的事件：取最后 **6** 条。
- 中文没有空格，分词用 **bigram**（"论文进度"→论文/文进/进度），零依赖。

### 3.3 前情摘要（`shared/memory-summary.ts`）
- 触发：`consolidate()` 的末尾（每 6 轮）。
- 输入：`recentTurnsAcrossDays(60)` 里**除去最近 6 轮**的部分，且只并入 `summaryTurns` 之后的新轮
  （避免同一批对话被反复摘要、越滚越糊）。
- 有模型走模型；**没模型走抽取式** `fallbackRollingSummary`（只留主人那半句），
  所以"没配密钥"时这条机制也不会静默失效。
- 上限：`SUMMARY_MAX_CHARS = 600`。

### 3.4 记忆宫殿（growth）—— 现在**由模型按需调用**
- 节点来源：`first-meet` 自动生成；反思时 `suggestNodes`（对话轮数、心情曲线、场景分布）→ `mergeNodes`；
  用户在成长面板手记一笔。
- 压缩：超过 `palaceCompressMonths`（默认 6 个月）的同类反复经历折叠成一条，原始节点进
  `memory/archive/palace-<年>.json`。
- `palace.md` 是**可读镜像**（用户直接看/直接改）。
- **怎么被用**（需求 7.3 的改法）：
  1. system prompt 里加一段【可用的工具】，告诉它有 `recall_memory(query)` 以及**什么时候用**
     （提到"上次/之前/我们说好的/某个项目名"才查；寒暄不查）；
  2. 模型真要查时，返回 `tool_calls`（OpenAI）或 `tool_use` 块（Anthropic）；
  3. **本地执行检索**（`shared/memory-recall.ts`：bigram 分词 → 打分 → 取前 3 段，
     查不到就明确说"没有相关经历"，不要编），把结果作为工具结果回传；
  4. 模型据此作答。最多 **2 轮**工具调用（防"反复查同一个东西"烧 token）。
  每次调用都会记一条记忆事件（"她查了记忆宫殿（论文）：1 条相关"），事后可审计。

### 3.5 反馈 → 反思 → 策略（唯一会"改行为"的记忆）
1. 她每次主动开口 → `recordIntervention` 写 `feedback-*.jsonl`；
2. 3 分钟内主人有任何互动/对话 → 标记 `responded`；
3. 每天 `reflectionHour`（默认 23）之后写一次反思（启动时补昨天）：
   输入 = 反馈统计 + 当天对话轮数 + 心情曲线 + 场景分布；输出 = 正文 + 洞见；
4. 洞见 → `PolicyOverlay`（`policy.json`）→ 通过 `effectivePerception` **收紧**感知的频率闸门
   （最小间隔 / 每小时上限 / 按场景的系数），并且只能收紧、不能放宽。
   这是整条记忆链里**唯一反向影响当下行为**的一环，也是"她因为我没回应而变安静"的落点。

### 3.6 派生物：日记、小纸条、心情曲线
- **日记**：每天 `diaryHour`（默认 22）后 + 启动补写"昨天没写的"；素材全是真的
  （当天 turns/events、心情曲线、facts 前 10 条、前情摘要、感知时间线）。有活动才写。
  **日记只留在 `diary/`**：早期它会被顺手复制一份到小纸条，现在不会了（需求）。
- **小纸条**：她自己记的收纳夹（点「让她记一件」；将来她把整理好的文件收进来）。
  **用户不能留言**（按需求删掉了写入路径），但可以**删掉某一条**、把文件**收进来 / 查看 / 删除**。
  纸条与文件是两层：删纸条不动文件，删文件不动纸条。
- **心情曲线**：`mood/*.jsonl` 每 5 分钟一条，只被日记与反思读。

## 4. 数据流

```
感知采样 ──> observations/timeline/habits ──┬─> 时间线文本 ──> 聊天/日记/小纸条 提示词
                                            └─> 场景统计 ─────> 反思 ──> 策略 ──> 感知频率闸门（闭环）
对话 ──┬─> turns/chat-*.jsonl ──┬─> 检索片段(跨天) ──┐
       │                        └─> 滚动摘要 ────────┼─> 聊天/日记 提示词
       ├─> 规则抽取 ─┐                                 │
       └─> events ───┴─> 模型整理(每6轮) ──> profile.facts
互动/开口 ──> feedback-*.jsonl ──> 反思 ──> policy.json ──> 感知
记忆宫殿节点 ──> 闲聊"最近的事" + （用户提到相关内容时）`recall_memory` 工具回传 ──> 聊天提示词
日记 / 小纸条 ──> 只写不读（除 UI 展示；小纸条仅用于"避免重复记"）
`notes/files/` ──> 只被人看（查看/打开/删除），不进任何提示词
```

## 5. 隐私边界：什么会离开这台机器

**会发给模型**（都是**文本**，且都是"她自己的记录"，不是原始素材）：
- 聊天：人格 + 情绪状态 + facts(6) + 前情摘要 + 片段(4) + 时间线文本 + 最近 6 轮；
- 日记：当天对话（最多 40 轮）+ 事件 + 心情 + facts(10) + 前情摘要 + 时间线；
- 反思：反馈流水 + 对话节选(8) + 心情 + 场景分布；
- 小纸条：facts(6) + 时间线 + 已记过的标题(5)；
- 视觉（3.1/3.2/3.5）：**当次截图的 base64**（不落盘）、地址栏横条、窗口上下文**文本**。

**只留本地**：`observations-*.jsonl` 明细、`mood` 曲线、`feedback` 流水、`notes`/`diary` 全文
（除非被上面那几条引用）、窗口列表原始数据（只把"描述文本"给视觉模型）。

**不进模型**：闲聊的候选话头（全部本地拼字符串）。

**按需进模型**：记忆宫殿节点默认**不发**；只有模型主动调用 `recall_memory(query)` 时，
才把本地检索命中的**最多 3 段**（标题 + 日期 + 摘要）作为工具结果回传。
也就是说"她什么时候想起往事"由模型决定，而不是每轮把整座宫殿塞进提示词。

## 6. 保留期对照（谁会被清理、谁不会）

| 数据 | 上限 / 保留 | 机制 | 状态 |
|---|---|---|---|
| `profile.facts` | 200 条 | `mergeFacts` 淘汰最弱 | ✅ |
| 小纸条条目 | 500 条 | `trimNotes` | ✅ |
| `notes/files/` | 不清理（**手动可删**） | 不自动删任何文件；聊天窗口「文件」页签可逐个删除 | ✅ 设计如此 |
| 反思 + 反馈流水 | `keepReflectionDays`（默认 180 天） | 启动时 `pruneReflections` | ✅ |
| 感知明细（observations/timeline/daily/perception-log） | `retentionDays`（默认 90 天） | 每天首次采样 `pruneOldData`（超期归档） | ✅ |
| `memory/events-*.jsonl` | `keepMemoryDays`（默认 180 天，`0` = 永久） | 启动 + 每天首次对话 `pruneMemory` | ✅ |
| `memory/chat-*.jsonl` | 同上 | 同上 | ✅ |
| `memory/memory-log.md` | 同上 | 按 `## YYYY-MM-DD` 小节裁剪 | ✅ |
| `memory/profile.json`（facts / summary / userName） | **不清理** | — | ✅ 设计如此（汇总层不随流水删） |
| `memory/nodes.json` + `palace.md` | 不按天清理 | 超过 `palaceCompressMonths` 折叠归档 | ✅ |
| `logs/desktop-pet.log`（在 userData） | `LOG_FILE_MAX_BYTES` | 轮转成 `.1` | ✅ |
| `mood/*.jsonl` | `keepMemoryDays` 不覆盖 | — | 🟢 ~1.7KB/天，暂不处理 |
| `diary/*.md` | 不清理 | — | 🟢 ~1KB/天，可接受 |

> 两条"启动即清理"的路径互相独立：`pruneReflections`（反思）+ `pruneOldData`（感知）
> 原本就在，`pruneMemory` 是这一轮补上的第三条；三者都只在**跨天后的第一次**执行，
> 不会每轮扫盘。删掉的只是**流水**（events / chat / 渲染日志），
> `profile.json` 里沉淀下来的事实、摘要、观点一条都不动 ——
> 也就是"忘掉逐字记录，记住结论"。

## 7. 缺口与可整理项（按优先级）

> ✅ = 这一轮已修（并进了验收）；🟡/🟢 = 仍未动。

### ✅ 7.1 `notes.json` 没有 schema 迁移 —— 会**静默丢数据**（曾实锤）
上一轮把"邮箱"改成"她的收纳夹"时，新版 `isNote()` 要求 `title` 字段，
而旧格式（`author`/无 `title`）会被 `read()` 直接过滤掉。
真实数据里已经有一条（`nmuigiz2e1i5jy`，2026-09-26 的日记纸条）会在加载时消失，
而且不会有任何日志或提示。

**已修**：`shared/notes.ts` 新增 `migrateNote()` —— 读盘时兼容旧记录：
- 缺 `title` → 取正文首句（截断到 `NOTE_MAX_TITLE`），并去掉首句重复；
- 旧 `author: 'pet'` → 归入 `kind: 'memory'`，`author` 字段被丢弃；
- 无法修复的垃圾条目（无正文、日期不可解析）才丢，且**丢几条会写日志**（`note-service.read()`）。

验收里加了纯函数用例（旧记录 → 迁移后标题正确），并且**真实那条数据现在能正常读出来**。

### ✅ 7.2 记忆流水没有保留期，且与感知/反思不对称
`memory/` 里的三份（events / chat / memory-log.md）原来**永远不会被清理**，
而 perception（90 天）和 reflection（180 天）都有保留期设置。按实测速率，
`events` + `memory-log.md` 合计约 **50–90KB/天 → 每年 20–30MB**。

**已修**：新增设置项 `keepMemoryDays`（默认 **180 天**，`0` = 永久保留），
面板里是「记忆保留天数」输入框（`#ai-keep-memory-days`），走 IPC `AIMemoryPrune` / `pet:ai-memory-prune`。
- `MemoryStore.pruneOldData(keepDays, now)`：删掉超期的 `events-*.jsonl` / `chat-*.jsonl`，
  并按 `## YYYY-MM-DD` 小节裁剪 `memory-log.md`；
- 触发点：启动 `load()` 一次 + 每天首次 `chat()`（`lastMemoryPruneDay` 去重），
  另外面板按钮可强制跑一次（`pruneMemory(true)`）；
- **只删流水**：`profile.json` 的 facts / summary 不受影响（见 §6 的表注）。

> 踩过的坑：`availableDays()` 返回的是**降序**，最初的 `for + break` 会在第一天就跳出，
> 导致 `days: 0`（旧日期一条都没删）。改成 `filter(day => day < cutoff)` 后正确。

### ✅ 7.3 记忆宫殿**不进聊天提示词**
她"记得的重要经历"（里程碑、一起做的项目、熬夜赶工）原来只被用来在闲聊里生成一句问候；
聊天时她完全想不起宫殿里的内容 —— 而 facts 只有 8 类短事实（"在做的项目=桌宠"），
两者信息量差一个量级。

**已修（按需求改成工具调用而不是无条件注入）**：
- `src/main/ai/tools.ts`：定义 `recall_memory(query)` 工具 + 一段中文 `TOOL_HINT`
  （写清"什么时候该查、什么时候别查"），随 system prompt 一起发；
- `LLMClient` 支持 OpenAI `tools` / `tool_calls` / `role:'tool'` 与 Anthropic `tools` /
  `tool_use` / `tool_result` 两种协议，最多 **2 轮**工具调用（`MAX_TOOL_ROUNDS`）；
- 检索在本地做（`src/shared/memory-recall.ts`：bigram 分词 → 打分 → 取前 **3** 段），
  查不到就回"记忆里没有与这件事相关的经历，不要编"，避免她瞎编往事；
- 每次调用写一条记忆事件（"查了记忆宫殿（论文）：1 条相关"），可事后审计；
- 兼容性兜底：模型/网关不认 `tools` 时（HTTP 400/404）自动**去掉工具重试一次**，
  聊天不会因此整条失败。

验收里加了一条**端到端**用例：本地起 `node:http` 假网关 → 断言第 1 个请求带 `tools`、
第 2 个请求带 `role:'tool'` 且内容含被检索到的往事 → 最终回复正确、`mode === 'llm'`。

### 🟡 7.4 小纸条是"只写不读"的孤岛
除了"避免重复记"，`notes.json` 不回流任何提示词 —— 她不会想起自己记过什么。
（它现在更像"给她自己看的收纳夹"，这符合需求；但若要她"翻自己的小纸条"，需要显式注入。）

> 这一轮补的是**人**那一侧的能力：删单条、收文件、查看文件内容。她那一侧仍然不读小纸条。

### 🟢 7.5 三份近义数据
同一次对话会写进 `chat-*.jsonl`（结构化）+ `events-*.jsonl`（一条 `chat` 事件）+ `memory-log.md`
（两者的渲染）。三份都在增长，检索时又各查一遍。
→ 可合并为"一份流水 + 一份渲染"，或让 `memory-log.md` 按月归档。

### 🟢 7.6 零散不一致
- `MemoryProfile.petName` **从来没被写过**（实测 `""`）：人格名只在 `ai-settings.json`。
  留着容易误用，建议删掉或同步。
- 摘要上限不一致：`SUMMARY_MAX_CHARS = 600`，但 `setSummary` 截的是 2000。
- `emotion.json` 在根目录、`mood/` 是它的采样目录，两者命名不同源，容易找错。

## 8. 已经做到哪一档

| 档 | 内容 | 状态 |
|---|---|---|
| **A. 数据安全** | 7.1 迁移旧纸条 + 7.2 给记忆加保留期 | ✅ **已完成**（299 项验收通过） |
| **A+. 数据搬家** | 记忆默认写到 `<项目目录>\data\`（不再放 C 盘）+ 一次性迁移 | ✅ **已完成** |
| **B. A + 记忆可用性** | 把宫殿（7.3）接进聊天 —— 按需求做成 `recall_memory` 工具调用 | ✅ **已完成** |
| **B+. 收纳夹可用性** | 日记不再进小纸条；纸条可**删单条**；新增「文件」页签（收纳 / 查看 / 删除） | ✅ **已完成** |
| **C. B + 去冗余** | 合并三份近义流水（7.5）+ 清理 7.6 的零散项 | ⬜ 未做（要写迁移与回滚） |

还没做的是 7.4（小纸条回流，属于"要不要"而不是"坏了"）、7.5、7.6。
A→B+ 全部经过 `npm run acceptance`（304/304，约 215s）+ 两个真机探针
（`probe-note-views.cjs` / `probe-note-files.cjs`）。
