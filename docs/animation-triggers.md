# 动画触发条件全量目录

这份文档回答一个问题：**manifest 里的每一条动画，分别是被什么触发的？**

- 机制与规则（仲裁顺序、三段式语义、双缓冲、自愈）在 `README.md` 的 §4 / §9 / §10，本文不重复；
  本文只做**「动画 id → 触发条件」的逐条索引**，并在最后记录已发现的缺口。
- 动画清单的唯一事实来源是 `assets/config/animations.json`（28 条）。
  新增动画请**同时**更新本文 —— 否则下一个人只能靠读代码反推。
- 行号基准：`ec3b81b` + 互动心情修复（`AIInteractionSettled`）之后的工作区。
  行号会漂移，**定位请以符号名（函数/常量）为准**，行号只作辅助。

---

## 1. 通用裁决机制

所有播放都经过唯一入口 `AnimationManager.requestAnimation`（`src/renderer/core/animation-manager.ts`），
按顺序过滤，任一环节失败即返回 `{ accepted: false, reason }`：

| 顺序 | 检查 | 拒绝原因 |
|---|---|---|
| 1 | 动画已在 manifest 注册 | `not-registered` |
| 2 | 单条动画冷却（`bypassCooldown` 例外） | `cooldown` |
| 3 | 同一条动画正在播则忽略（`force` 也无效，除非 `restart`） | `same-animation` |
| 4 | 收起状态的**安静白名单**（`source: 'user'` 例外） | `docked` |
| 5 | 显式排队（`interrupt: 'queue'`） | —（挂到 `queue`） |
| 6 | **不可打断硬锁**（`interruptible: false`，`force` 也切不动） | `not-interruptible` |
| 7 | 优先级（`<` 拒绝；`==` 拒绝） | `lower-priority` / `equal-priority` |
| 8 | 抢占：`start`/`loop` 段先播 `end` 再播新请求；已在 `end` 段直接让位 | — |

**收起安静白名单**（`renderer.ts` 的 `getQuietPolicy`，由 `behavior.json` 推导，不是写死的）：
`docked-bottom` → `{sleep} ∪ fidget(lie)`；`docked-right` → `{watch} ∪ fidget(peek)`；
`normal` / `hidden` → 不限制。**收起状态的 fidget 动画必须在白名单里**，
否则那两段会被这条规则以 `docked` 拒掉（表现为"收起后从来不换姿势"）。

**三段式（`kind: "persistent"`，共 7 条：watch/sleep/lie/sad/overheat/read/work）**：
`start` 播一次 → `loop` 播 N 轮 → `end` 播一次 → 回默认动画。
轮数由 `loopCountRange` 决定：`'forever'` → 无限循环；`[min,max]` → 区间内随机；都缺 → 无限。
轮数计数靠 rAF 轮询（不是 `ended`，因为循环段设了 `loop=true` 永不触发 `ended`），
另有 `max(2000, 时长+800)ms` 看门狗兜底丢失的 `ended`。

**"马上要接上"的窗口（`isHandoverPending`）**：抢占持续动画时，新请求是排到
`setTimeout(0)` 才真正开始的，而它的 `animation:end` 是**同步**发出的 ——
此刻 `getCurrentAnimation()` 已经是 null。渲染层因此把 `isHandoverPending()` 也算作
"还有动画"，否则会先接回默认姿势、再被挂起项顶掉，多出一段
`默认 -> 默认 end -> 目标`（收起时就是"刚趴下又要爬起来"）。

**状态默认动画**（`renderer.ts` 的 `defaultAnimationId` / `playDisplayDefault`）：
取 `behavior.json` 的 `states.*.defaultAnimation`，播放参数固定
`interrupt:'force'`、`loop:true`、`loopCountRange:'forever'`、`source:'system'`，非兜底时 `priority:5`；
配置了但清单里不存在的 id → 退回兜底 id（`fallback: true` 的 `idle`）。`hidden` 状态不播任何动画。

**随机池**（`src/renderer/core/behavior-manager.ts`）：1s tick → 到点 → 要求状态机为 `IDLE`
（`onlyWhenIdle`，否则 2s 后重试）→ 池冷却 → 等概率/加权抽取 → 以
`{ source:'behavior', reason:'random-pool:<pool>' }` 投递到 Action Pipeline。
**只有正常状态有池**（8 条）。

**心情过低换池**（`behavior.json` 的 `sadPool`，需求："心情低于阈值时所有随机池的动画都变成
`sad`，高于阈值再变回来，收起状态的动画不受影响"）：`心情 <= moodBelow`（默认 25）时，
上面那次抽取的结果被整体替换成 `animation`（默认 `sad`）——
换的只是"演什么"，`intervalMs` / `cooldownMs` / `onlyWhenIdle` 与**默认姿势、fidget 全部不动**，
所以收起状态的 `sleep`/`watch`/`lie`/`peek` 不受影响（收起状态本来也没有池）。
判定用**单一阈值**（`sadPoolAnimation()`，纯函数），心情跨过阈值时立刻重建池，不等下一个触发点。
阈值与 `pet-triggers.ts` 的 `SAD_MOOD_THRESHOLD` 同值，避免"UI 说她很难过、随机动作还在打滚"。

**随机小动作 fidget**（`behavior.json` 的 `states.*.fidget`）：与池是两件事 ——
池是"空闲时替换掉默认动画"，fidget 是"**默认姿势正在循环时插一小段，播完回到同一个默认姿势**"。
门槛（`BehaviorManager.tickFidget()`）：**当前播的就是该状态的默认动画、且已在 `loop` 段**。
不在门槛内就把排期清零（下次进入默认姿势时重新随机一个时刻）。
以 `interrupt: 'auto'` 投递 → 三段式仲裁自动实现"先播完默认姿势的 `end`"，
`loopCountRange` 决定"随机数量"，播完由"回 IDLE → `resumeFallbackLoop`"接回默认姿势：

```text
sleep(loop) --到点--> sleep(end) --> lie ×N --> 回 IDLE --> sleep(loop)     （下方收起）
watch(loop) --到点--> watch(end) --> peek ×N --> 回 IDLE --> watch(loop)    （右侧收起）
```

两处门禁是所有**自动**触发共用的一层（不在 AnimationManager 里）：
`main.ts` 的 `triggerAnimation` 会丢弃 `hidden`、`dock !== 'free'`、以及
「行为暂停」期间的请求 —— 所以自动动画在收起/隐藏/暂停时一律不发生。
（"行为暂停"的菜单项已按需求从托盘/右键菜单移除；暂停状态仍可由
`petAPI.notifyBehaviorPaused` 设置，隐藏桌宠时也会自动进入暂停。）

---

## 2. 逐动画目录

### 2.1 state 类（默认姿势）

#### `idle`（loop true，priority 0，`fallback: true`）
- **normal 状态默认动画**（`behavior.json` → `states.normal.defaultAnimation`）：启动、回到 IDLE 后、
  从收起展开回来、渲染自愈（缓冲僵死 / 卡帧）时播。
- **加载失败降级**：任何动画 `load-failed` 时 `failAnimation` 回退到兜底 id。
- **某状态配置的默认动画不在清单里**时退回兜底。
- 托盘/右键「播放动画（测试）→ 待机」（「恢复默认动画」已按需求删除：它做的事就是回到 idle，而等一下就自己回 idle 了）。
- 冷知识：`idle` 不在任何随机池里；`AnimationManager.playFallback()` 目前**无调用者**（见 §4）。

#### `watch`（priority 15，persistent：start/loop/end，**无 loopCount**）
- **`docked-right` 默认姿势**：被 `playDisplayDefault` 的 `'forever'` 覆盖 → **无限循环**，
  只在离开该状态时才播 `watch-end` 再回 idle。
- 右侧收起时点击/拖离 → 走 `undock` → 显示状态变化 → 旧 watch 进 `end`。
- 托盘手动（无 `'forever'` 覆盖、定义里也没有 loopCount → 同样无限循环，再点一次才收尾）。
- 注意：`docked-right` 的**随机池**是 `peek`，不是 watch。

#### `sleep`（priority 10，persistent，`loopCountRange: [2,5]`）
- **`docked-bottom` 默认姿势** → `'forever'` 覆盖 → 无限循环。
- **深夜提醒**：已按需求**删除**（详见 §4.1）。
- `animationForScene('idle')` 的第 2 候选；`preferredAnimation` 极低心情兜底。
- 托盘手动 → 按定义的 [2,5] 轮后播 `sleep-end`。
- 副作用：`ANIMATION_STATE_HINTS.sleep = 'SLEEPING'`，播 sleep 会把状态机置为 `SLEEPING`，
  下一次点击先 `wakeIfSleeping` 回 IDLE 再播反应动画。

### 2.2 random 类

| 动画 | 触发条件 |
|---|---|
| `roll` / `hot` / `shake` / `sing` / `spin` / `swim` / `play_tail` | **仅由 `normal-random` 池**选中（25–60s，首延迟 15s，池冷却 8s，仅 IDLE，各等概率）。代码里没有任何字面量引用。 |
| `bomb` | 仅 `normal-random` 池。`priority:100`、冷却 **300s** —— 只有托盘的 `bypassCooldown` 能再点一次。 |
| `play` | 仅 `normal-random` 池（双击不再触发动画）。 |
| `lie` | **下方收起时的随机小动作**：`sleep` 循环中随机时刻 → `sleep` 的 `end` → `lie` ×N → 回到 `sleep`（`behavior.json` 的 `docked-bottom.fidget`）。另有摄像头「主人不在」、`animationForScene('idle')` 首选、`preferredAnimation` 兜底。**不在任何随机池里。** |
| `peek` | **右侧收起时的随机小动作**：`watch` 阶段同理 → `peek` ×N → 回到 `watch`（`docked-right.fidget`）。另有**摄像头检测到陌生人**（紧急类，演完自动藏 20s）。**不在任何随机池里。** |

### 2.3 trigger 类（事件驱动）

#### `catch_down` / `catch_right`（priority 35）
- 唯一来源 `TriggerService.checkApproach`（250ms 轮询光标）+ 纯函数 `classifyApproach`：
  - 进入 **150px**（`APPROACH_RADIUS_PX`）且已武装；
  - 离开 **210px**（150×1.4）才重新武装；
  - 两次「接住」最小间隔 **60s**（冷却中保持武装，冷却过后若仍靠近会补演）；
  - 方向必须**主轴占优**：`dy>0 && |dy| >= |dx|` → `catch_down`；`dx>0 && |dx| >= |dy|` → `catch_right`。
    **从上/左靠近不演**（避免「低头看你」被演成「从右边接住」）。

#### `hungry`（priority 30）
- `evaluateHungry`：**饱腹 ≤ 40** 且已武装；回到 **≥ 60** 重新武装。30s 轮询 + 启动时立刻一次。
- 备选：`preferredAnimation` 在饱腹 ≤30 时的首选（实际总被它占位）。

#### `sad`（priority 45，persistent [2,5]）
- 两条来源：
  1. **触发动画**：`evaluateSad` —— **心情 ≤ 25** 且已武装；回到 **≥ 40** 重新武装。
     30s 轮询 + 启动立刻。`cooldown: 0`，靠 armed 保证「一次越界只演一次」。
  2. **随机池**：心情 ≤ `sadPool.moodBelow`（默认 25）时，`normal-random` 池里抽到的
     任何一条都换成 `sad`（`behavior.json` 的 `sadPool`，见 §1）。
     这是**状态**而不是一次性事件：只要心情还低着，她每次自己动都是 sad；
     回到阈值以上立刻恢复原池。**不影响收起状态的 fidget 与默认姿势。**

#### `offline`（priority 30）
- `evaluateOffline` + `classifyOffline`，判定顺序：AI 总开关关 → 空；
  无密钥 → `no-key`；系统无网 → `network`；余额不可用 → `no-balance`；
  401/403 或文案含「API Key 无效」 → `invalid-key`；错误含「网络请求失败」 → `network`。
  **超时不算掉线。** 30s 轮询 + 启动立刻。
- 持续状态：刚变坏立刻演一次，之后每随机 **3–8 分钟**再演一次，恢复后清零。

#### `overheat`（priority 40，persistent [2,5]）
- `evaluateOverheat`：`nvidia-smi` 温度 ≥ 阈值（默认 **80**，回差 5°C 重新武装）。
  **读不到温度一律不触发。** 60s 轮询 + 启动立刻；持续状态每 3–8 分钟重演。
- 阈值可由感知设置 `overheatThresholdC` 覆盖（合法 0 < t < 150）。

#### `remind`（priority 60）
- 久坐干预：`sessionMinutes >= longSessionMinutes(默认 120) && idleSeconds < 120`。

#### `shy`（priority 55，冷却 60s）
- 唯一来源：**私人内容**干预（`observation.sensitive`，模型标志或敏感词命中）。
  紧急类，跳过免打扰/每小时上限/最小间隔，但保留 60s 硬下限。
- ⚠️ `decide()` 只在**模型路径**下把 observation 传下去，所以**离线/本地降级不会触发 shy**。

#### `talk`（priority 40）—— 触发源最多
1. **场景变化打招呼**：`previousScene !== null && 变化 && scene ∉ {idle, other}`（gaming 用 `cute`）。
2. **习惯预测**：「按你平时的习惯，这个点一般在写代码，今天也是吗？」（需样本 ≥2、场景被识别）。
3. **AI 回复**：`pickAnimation('reply')`（需 `emotion` 开关）→ 受 `handleSpeak` 双重闸门（收起/忙碌时只进聊天窗不演动画）。
4. 托盘「让她说句话」。
5. **心情 < 25 主动搭话**（≥30 分钟一次）—— ⚠️ 见 §4.4。
6. 日记写完（`greeting` 路径）。
7. 记忆宫殿新增节点 / 「回忆这段」。
8. 感知干预的兜底备选（`decide()` 里没有更具体的选择时）。
9. 插件（走 `context.animations.play` / `actions.execute`；随包不带插件，用户装的插件才会出现）。
10. 托盘/右键手动。

> 「看我在做什么（场景）」不再是 `talk` 的来源：那个动作按需求搬进了设置窗口的
> 「按需看屏幕」面板，结果只显示在面板里（不冒泡、不演动画）——
> 主进程里那条 `viewScreen()` 包装（会 `handleSpeak`）已随之删除。

#### `read`（priority 20，persistent [2,5]）
- **场景触发**：`scene === 'reading'` 且
  连续稳定 **90s**（`SCENE_TRIGGER_STABLE_MS`）、**不是**频繁切换（< 8 次/小时）、
  距上次同类触发 **≥ 20 分钟**；需 `screen` 开关打开、非隐私模式。
  这一路**不开口、不占打扰额度**。
- **报错求助**：`observation.suggestion` 非空（模型给了建议才说）。
- `animationForScene('reading')` 首选；`preferredAnimation` 候选；插件；托盘。

#### `work`（priority 20，persistent [2,5]）
- **场景触发**：`coding` / `writing` / `terminal` 同上「90s 稳定 + 不频繁切换 + 20 分钟冷却」。
  终端的本地短路观察也会喂进来，所以**终端场景不需要模型**；而本地降级观察被当 `null` 传入，不会触发。
- `animationForScene('coding'|'terminal')` 首选；插件；托盘。

### 2.4 click 类（`interruptible: false` —— 硬锁，必须播完）

**点击不再按区域选动画**（需求）：从 `cute` / `fawning` / `stroke` 里**随机挑一条** ——
挑选是共享层纯函数 `pickClickReaction`（`shared/animation-types.ts`），会**优先避开正在冷却的那条**
（三条冷却 3s/3s/4s，纯粹均匀随机会让连点频繁"点了没反应"）。
区域（`PetRegion`）仍然算出来，但只用于命中判定与右键菜单展示。

| 动画 | 触发条件 | 参数 |
|---|---|---|
| `cute` | 点击（随机一条）· 场景变 gaming · 摄像头「你回来啦」· `preferredAnimation` | priority 50，冷却 3000 |
| `fawning` | 点击（随机一条）· `preferredAnimation` · 插件 | priority 50，冷却 3000 |
| `stroke` | 点击（随机一条） | priority 50，冷却 4000 |

点击的上游门禁（`src/renderer/core/interaction-manager.ts`）：
仅左键；`data-pet-ui` 标记的浮层内事件不算（避免点气泡按钮顺带触发）；
位移 **< 5px** 才算点击（否则是拖拽）；按下 **≤ 900ms**（长按不算）；
`region !== 'outside'`；与上一次点击间隔 **≥ 320ms**（去抖，双击交给 `dblclick`）。

**没有动画的互动**：**双击**（已按需求去掉触发动画；它仍算一次互动，但没有可等的动画，
所以心情在互动那一刻结算）、滚轮（全仓库无 `wheel` / `deltaY` 路径）、
悬停（`region-enter` 不演动画）、拖拽（只移动窗口，拖到/离开边缘会经显示状态变化切默认动画）、
**收起状态下点击**（只展开，由默认姿势的收尾段负责过渡）。

---

## 3. 按触发来源汇总

| 分组 | 触发器 | 选中动画 |
|---|---|---|
| **用户交互** | 单击（任意部位，随机一条） | `cute` / `fawning` / `stroke` |
| | 双击 | **不播动画**（去掉触发；仍算一次互动） |
| | 收起状态点击 | 不播反应，只展开 → 默认姿势收尾段 |
| | 滚轮 / 悬停 | **无任何代码路径** |
| **随机/空闲** | `normal-random` 池（25–60s） | `roll, hot, bomb, play, play_tail, shake, sing, spin, swim`；**心情 ≤25 时整池换成 `sad`** |
| | 收起时的随机小动作（180–480s） | 下方：`sleep`→`lie`→`sleep`；右侧：`watch`→`peek`→`watch` |
| | 示例插件 | `cute, fawning, talk, sing, work, read, play, hungry, lie` 等 |
| **状态** | normal / docked-bottom / docked-right / hidden 默认 | `idle` / `sleep` / `watch` / 无 |
| | 回 IDLE、缓冲僵死、卡帧自愈、加载失败 | 该状态默认动画 / `idle` |
| **系统信号** | 心情 ≤25 · 饱腹 ≤40 · 掉线原因非空 · GPU ≥阈值 · 光标入 150px | `sad` · `hungry` · `offline` · `overheat` · `catch_down`/`catch_right` |
| **感知/场景** | reading / coding·writing·terminal 稳定 90s | `read` / `work` |
| | 私人内容 · 久坐 · 场景变化 · 习惯命中 · 报错建议 | `shy` · `remind` · `cute`/`talk` · `talk` · `read` |
| | 摄像头：陌生人 / 人回来 / 人离开 | `peek` / `cute` / `lie` |
| **AI / 说话** | chat 回复（按情绪挑） | 饱腹≤30→`hungry`；心情≥75→`cute`/`fawning`/`talk`；≥45→`talk`/`cute`；≥25→`read`/`talk`；否则 `lie`/`sleep`/`read` |
| | 日记写完 / 宫殿新增 / 回忆节点 | 情绪挑片 / `talk` |
| **手动** | 托盘/右键「播放动画（测试）」 | 全部 28 条（`force + user + priority 70 + bypassCooldown`） |
| | 插件 API `animations.play(id)` | 插件自定（无清单校验，非法 id 由仲裁拒 `not-registered`） |
| | 调试句柄 `window.petDebug` / IPC `ActionExecute` | 任意 id |

---

## 4. 已处理 / 仍存在的缺口

### 4.1 `sleep` 的「深夜提醒」已删除（原本是死代码）
`lateNight = hour >= lateNightHour(默认 1) && hour < 5`（`shared/perception.ts` 的 `isLateNight`），
而免打扰默认 `quietHours = { start: 23, end: 8 }`（`shared/perception-types.ts` 的 `DEFAULT_PERCEPTION_SETTINGS`）。
交集 **1–4 点** 全部被 `gateIntervention` 的免打扰分支拒掉，而 `late-night` 不是紧急类 ——
也就是说那条路径**永远不会生效**。
**现状**：已按需求删除 —— `planIntervention` 里不再有这条分支，`InterventionKind` /
`InterventionRecord.kind` 里的 `'late-night'` 也一并移除，验收里加了"深夜不再产出干预"的断言。
`lateNight` / `lateNightHour` **保留**：它们仍决定"现在算不算深夜"，
用于习惯预测里的「今天已经比你平时睡觉的时间晚 N 个小时了」。

### 4.2 注释与配置不一致 —— 已修正
之前 `renderer.ts` / `main.ts` / `tray-manager.ts` / `animation-types.ts` / `animation-manager.ts`
多处的注释写着「下方收起默认是 `lie`」，而 `behavior.json` 的
`states.docked-bottom.defaultAnimation` 实际是 **`sleep`**。**这些注释已全部改为 `sleep`。**
（`lie` 现在的角色是"下方收起时的随机小动作"，见 §1 的 fidget。）

### 4.3 未使用 / 残留 API
- `AnimationManager.playFallback()`：无调用者（只剩注释里提到它）。实际接回默认走 `playDisplayDefault`。
- `PerceptionServiceOptions.getAvailableAnimations`：声明了、`main.ts` 也注入了，但**从未被调用**
  （别和 `AIServiceOptions.getAvailableAnimations` 混淆 —— 后者在 `pickAnimation` 里真被用）。
- `IDLE_THRESHOLDS.sessionBreak`：无引用，采样侧用的是硬编码 600。

### 4.4 未经清单校验的两个入口
`main.ts` 的 `triggerAnimation` 与 `ipc-manager.ts` 的 `setAnimation` 都不校验动画是否存在，
最终由 renderer 仲裁拒绝（`not-registered`）。主进程侧因此**不会报错**，
清单改名后表现为「点了没反应」——排查时请直接看 renderer 日志。

### 4.5 「心情低主动搭话」目前不可达
`AIService.speakUp('lonely')` / `maybeLonelySpeak()` / `AIService.heartbeat()` 已实现，
但 `src/` 里**没有任何调用者**（只有 `tools/acceptance.cjs` 的注释提到它）。
所以 §2.3 `talk` 的第 5 条触发源**当前不会发生**。
