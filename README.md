# 鲸鱼娘桌宠（Desktop Pet）— Electron + TypeScript 第一版

Windows 透明桌面宠物。所有复杂动画都已在外部制作完成（WebM），运行时只负责**播放与编排**，不做实时 AI 视频生成。

第一版的核心目标不是 UI，而是**把架构一次设计正确**：动画系统、状态机、事件系统、插件系统、Action Pipeline、行为系统全部独立成模块，为未来的 AI Agent / 任务系统留出稳定接口。

---

## 1. 快速开始

```bash
npm install          # 若 Electron 二进制未下载，见下方“常见问题”
npm run build        # 类型检查 + 打包 main/preload/renderer + 编译插件 + 拷贝静态文件
npm start            # 构建并启动桌宠
npm run dev          # 开发模式（debug 日志 + DevTools 可用）
```

其他命令：

```bash
npm run typecheck       # 仅类型检查
npm run icons           # 【图标】从 assets/brand/ds.png 生成应用图标(.ico/.png)与托盘图标
npm run assets          # 生成兜底占位图标（已有真实图标时会跳过，不会覆盖）
npm run probe           # 解析 assets/animations/*.webm 的分辨率与时长
npm run convert:alpha   # 【素材预处理】用 ffmpeg 把预乘黑底素材烘焙成带 alpha 的透明 WebM
npm run verify:alpha    # 逐条核验素材是否真的带 alpha（在 Chromium 里验证）
npm run verify:visual   # 验证运行时画面边缘是否真正透明
npm run verify:console  # 核验日志字节层（UTF-8 合法且可逐字还原）
npm run logs           # 实时查看日志（推荐；中文必定正常，见 §17）
npm run acceptance      # 端到端验收（391 项检查）
npm run pack            # electron-builder 打包成未安装目录（快速验证）
npm run dist            # electron-builder 生成 Windows NSIS 安装包
```

启动后：

- 桌宠出现在主屏右下角，**透明、无边框、始终置顶**，默认大小 60%（288×384）；
- **可调整大小**：托盘或右键菜单 →「设置…」→ 顶部滚动条连续调节（20%–250%，步进 5%），
  拖动即时生效并自动写入 `assets/config/settings.json`，重启后保持；
- 左键点击随机播放一个互动反应（`cute` / `fawning` / `stroke`，不再区分身体部位），双击不再播放动画；
- 按住左键拖动可移动桌宠（超过 5px 位移才判定为拖动）；
- **交互（邮件式收件箱）**：她**保存重要事情**的地方，也是**插件交货**的地方。
  一条消息 = 发件人（她 / 某个插件）+ 主题 + 正文 + **0..N 个附件** + 时间 + 已读/未读；
  入口在托盘/右键菜单的「交互…」（带未看条数）或聊天窗口的「交互」页签。
  **只能看、不能留言**：可以标记看过、清空、**逐条删除**（连同附件一起删）、**单独删某个附件**、
  查看/用系统程序打开附件；她记东西的来源是她自己（点「让她记一件」），
  文件来源是「收纳文件…」或插件投递（`context.mail.send`，见 §8）。
  没被任何消息引用的文件归成一封**「未归档的文件」**，不会被藏起来；
- **日记页签**：每天到点她自己写一篇（也可以点「写今天的日记」立刻写），
  列表按日期倒序、点「看正文」展开全文，另有「打开日记目录」。
  日记**不进收件箱**（只写 `data/diary/`）；它原来是托盘 AI 子菜单里的两项，
  2026-09 需求把那一块子菜单删掉、搬进了这个窗口；
- **单击托盘图标 = 弹出菜单**，菜单最上面几行就是她的属性（**心情与饱腹各占一行**）：
  `心情 83/100（很开心）`、`饱腹 100/100（很饱）`、`token 本次 43 · 累计 43/200000`、
  `感知：写代码 · 在电脑前`、`记得的经历 N 段 · 一起 N 天`（有未读纸条时也会提示）。
  显示/隐藏桌宠仍然是菜单里的两项（左键不再是"切换显示"，改为把菜单弹出来）；
- 托盘菜单与桌宠右键菜单是**同一份模板**（条目与顺序完全一致，由 `buildMainTemplate()` 保证）；
  菜单只放**日常动作**：显示/隐藏、收起（贴边）、**交互…**（带未看条数）、
  **播放动画（测试）**、插件、设置…、退出。
  所有**配置项**都在设置窗口里：调整大小、总是置顶、拖到边缘自动收起、插件管理（安装/卸载/启停）、
  打开配置目录、感知的全部开关与日志、情绪重置、AI 与成长设置（含**记忆宫殿**与日记，
  菜单里不再重复这些条目）；
- **「播放动画（测试）」菜单列出全部 28 个动画**（按优先级排序，含标签与 id），点任意一条即刻试放 —— 这是第一版最直接的动画测试入口；
- 关闭窗口不会退出程序，桌宠继续驻留托盘。

---

## 2. 进程架构

严格遵循 Electron 官方推荐的进程模型：

```text
Main Process
  ├── WindowManager        透明桌宠窗口（frame:false / transparent / alwaysOnTop）
  ├── TrayManager          系统托盘 + 原生菜单（托盘菜单 / 右键菜单 / 设置入口）
  ├── SettingsWindowManager 设置窗口（滚动条调大小，即时生效 + 自动保存）
  ├── IpcManager           IPC 白名单中枢（唯一跨进程通道清单）
  ├── PluginManager        插件发现 / TS 编译 / 生命周期编排 / 权限解析 / 启停写盘
  ├── PluginRuntime        插件运行期能力（HTTP 代发 / 子进程与 Python / 定时器 / 通知 / 面板与菜单注册表）
  └── Application          生命周期、异常兜底、bootstrap 握手
          │
          │ preload（contextBridge）+ IPC
          ↓
Renderer Process（桌宠窗口）
  ├── EventBus          全局事件总线
  ├── StateMachine      状态机（只决定状态，不播放动画）
  ├── AnimationManager  动画播放唯一入口（优先级 / 打断 / 冷却 / 排队）
  ├── ActionManager     统一 Action Pipeline（守门 + 分发）
  ├── BehaviorManager   行为调度（随机动画池：按显示状态取池，见 §10）
  ├── InteractionManager 鼠标互动（命中区域、点击、拖拽）
  ├── PluginHost        插件沙箱宿主 + PluginContext 注入（启停即回收）
  └── PetLayers         渲染图层（video 双缓冲 / image 静态图）
```

**插件界面（第三类窗口内容）**：插件的面板渲染在**聊天窗口**的插件页签里（`src/chat/`
+ `src/shared/plugin-panel-html.ts` 的净化器），插件自己跑在桌宠窗口的渲染进程，
两边只通过 Main 中转"HTML 快照 + 点击动作" —— 插件拿不到第二个窗口的 DOM。

**职责边界（整个项目最重要的约束）**

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| StateMachine | 当前状态、允许的迁移、进入/退出钩子 | ❌ 不播放任何视频 |
| AnimationManager | 怎么播、优先级裁决、ended 监听、背景扣除 | ❌ 不决定业务状态 |
| ActionManager | 校验、守卫、分发到状态机/动画管理器 | ❌ 不直接操作 DOM |
| BehaviorManager | 产生 Action Request | ❌ 不播放视频 |
| Animation 播放细节 | AnimationManager 内部封装 | ❌ 业务代码不得写 `video.src=` / `video.play()` |

---

## 3. 目录结构

```text
desktop-pet/
├── package.json
├── tsconfig.json
├── electron-builder.yml
├── src/
│   ├── main/            主进程：窗口 / 托盘 / 设置窗口 / IPC / 插件发现 / 素材协议 / 日志
│   ├── preload/         contextBridge 白名单桥（桌宠与设置窗口共用，按命令行参数分角色）
│   ├── renderer/
│   │   ├── index.html   CSP 严格、DOM 图层
│   │   ├── renderer.ts  组合根（唯一把各模块拼起来的地方）
│   │   ├── styles.css
│   │   ├── core/        各管理器（见上表）
│   │   └── types/       window.petAPI / petBootstrap 类型声明
│   ├── settings/        设置窗口页面（滚动条调尺寸，普通窗口）
│   │   ├── index.html
│   │   ├── settings.css
│   │   └── settings.ts
│   └── shared/          跨进程契约：事件、动画/状态/Action/插件类型、IPC、协议
├── assets/
│   ├── animations/      28 个**带 alpha 的** VP9 WebM 动画素材
│   │   └── source-premultiplied/   原始预乘黑底素材备份（转换脚本自动生成）
│   ├── brand/           ds.png（美术原图）+ ds.ico（原图自带的多尺寸 ICO）
│   └── config/
│       ├── animations.json   动画 Manifest（新增动画只改这里）
│       ├── plugins.json      插件开关与路径
│       ├── media-meta.json   素材分辨率（用于推导窗口宽高比）
│       └── settings.json     用户设置（尺寸 / 置顶），由程序写入
├── plugins/             插件目录（运行时读写）
│   ├── todo-plugin/     **随包的第一个真插件**：待办清单（输入时间与事件，到点她提醒）
│   └── types/           desktop-pet.d.ts（插件类型垫片，给 IDE 用）
│                        装更多插件走设置窗口「插件 → 安装插件…」
├── build/               图标等打包资源（由 npm run assets 生成）
├── data/                AI 认知层数据（记忆 / 日记 / 小纸条 / 心情 / 感知 / 反思 / AI 设置）
│                        默认写在这里而不是 C 盘；**不进版本库**（含 API Key），见 §11.1
├── tools/               构建、素材预处理与验收脚本
└── dist/                构建产物
```

`dist/` 结构：`dist/main/main.js`、`dist/preload/preload.js`、`dist/renderer/{index.html,styles.css,renderer.js}`、`dist/settings/{index.html,settings.css,settings.js}`、`dist/plugins/<插件路径>/index.js`（预编译插件产物）。

---

## 4. 动画系统

### 4.1 唯一入口

```ts
// ✅ 正确
await animationManager.play('cute', { priority: 50, reason: 'user-click:head' });

// ❌ 禁止：播放细节不允许散落在业务代码里
video.src = 'cute.webm';
video.play();
```

`AnimationManager` 公开 API：

```ts
play(animationId, options?): Promise<PlayResult>
requestAnimation(animationId, { priority, interrupt, reason, source, bypassCooldown }): Promise<PlayResult>
stop(): void
pause(): void
resume(): void
isPlaying(): boolean
getCurrentAnimation(): string | null
registerAnimation(animation: AnimationDefinition): boolean
registerAll(animations): number
getDefinition(animationId): AnimationDefinition | null
```

### 4.2 Manifest 驱动，不写死

动画信息全部来自 `assets/config/animations.json`（28 条），**行为策略**来自
`assets/config/behavior.json`（显示状态 -> 默认动画 + 随机池 + 间隔）：

```json
{
  "cute": {
    "type": "video",
    "source": "animations/cute.webm",
    "loop": false,
    "priority": 50,
    "interruptible": false,
    "cooldown": 3000,
    "category": "click",
    "label": "卖萌",
    "tags": ["click", "touch"],
    "render": { "className": "anim-cute" }
  },
  "sad": {
    "type": "video",
    "source": "animations/sad-start.webm",
    "kind": "persistent",
    "segments": {
      "start": "animations/sad-start.webm",
      "loop": "animations/sad-loop.webm",
      "end": "animations/sad-end.webm",
      "loopCountRange": [2, 5]
    },
    "category": "trigger",
    "label": "难过"
  }
}
```

新增动画 = 放入 WebM + 加一条记录（要参与随机就再往池里加个 id），**核心代码零修改**。
Manifest 在加载时会做校验：重复 ID、未知 `type`、非法 `source`、扩展名与类型不匹配、
`loopCountRange` 写反、未知 `category` 都会被抓出来并记录日志，单条失败不会让整体失败。

#### 4.2.1 四类动画（`category`）

| 分类 | 数量 | 成员 | 谁来决定播它 |
| --- | --- | --- | --- |
| `state` 状态动画 | 3 | idle / sleep / watch | 显示状态的**默认动画**（idle=正常、sleep=下方收起、watch=右侧收起） |
| `random` 随机动画 | 10 | roll / hot / lie / peek / bomb / play / shake / sing / spin / swim | 正常状态由 BehaviorManager 按池随机（25–60 秒）；`lie` / `peek` 由收起时的**随机小动作**触发（见 §10.2） |
| `trigger` 触发动画 | 11 | catch_down / catch_right / hungry / remind / talk / sad / shy / offline / overheat / work / read | 事件触发（见 §4.5） |
| `click` 点击动画 | 3 | cute / fawning / stroke | 用户点击；**不可打断** |

#### 4.2.2 显示状态（收起 / 隐藏）

拖到屏幕**右边缘或下边缘** -> 收起：贴平边缘、默认动画换成 `watch`（右侧）/ `sleep`（下方），
收起期间**没有随机池**——她安静维持默认姿势，只按"随机小动作"在默认姿势里插一小段
（`sleep` 中随机时刻趴一会儿 `lie`、`watch` 阶段偷看 `peek`）。
**拖动离开边缘**或**点一下她**即展开
（展开是**就地站立**：播完收尾段直接留在边缘，位置一动不动）。
托盘/右键的「收起（贴边）」与「隐藏桌宠」是两个不同的状态：
前者仍在屏幕上、仍可交互，后者窗口直接藏起来（情绪衰减也按"看不到主人"算）。

收起/隐藏还是**安静模式**：她不自发开口（不冒泡、感知干预整条不发生），
用户主动要她说话时先就地展开再开口。

判定与几何全是纯函数（`src/shared/dock.ts`）：`petRectIn` / `evaluateDock` /
`dockTargetPosition` / `shouldUndock` —— 阈值 8px 触发（必须推到最边上）、
拖离 56px 展开（刻意做成两个不同的数，否则会在边缘反复抖动）。

### 4.3 优先级与打断规则（由核心统一裁决）

优先级越大越优先（约定值，可自由使用 0–1000）：

| 动画 | priority | interruptible |
| --- | --- | --- |
| idle（循环兜底） | 0 | true |
| lie / sleep | 10 | true |
| watch | 15 | true |
| read / work | 20 | true |
| hot / peek / catch_down / catch_right / hungry / offline / sing | 30–40 | true |
| sad / play / roll / shake / spin / swim | 40–45 | true |
| cute / fawning / stroke（点击） | 50 | **false** |
| shy | 55 | true |
| remind | 60 | true |
| bomb | 100 | true |

裁决规则（全部在 `AnimationManager` 内，业务代码不判断）：

1. 未注册 → 拒绝 `not-registered`；
2. 同一动画正在播放 → 忽略 `same-animation`（避免重置到第一帧）；
3. 冷却期内 → 拒绝 `cooldown`（**`force` 也不能绕过** —— 冷却防刷屏，`interrupt` 管能否抢占，两者正交）；唯一例外是用户**手动**挑的动画：托盘 / 右键菜单「播放动画（测试）」带 `bypassCooldown: true`；
4. `interrupt: 'queue'` → 排队到当前动画结束后播放（排队不算打断，所以在第 5 条之前）；
5. 当前动画 `interruptible: false` → 拒绝 `not-interruptible`（**`force` 也无法抢占**：这是点击动画"必须播完才能再点"的硬约束）；
6. 新动画优先级 **低于** 当前 → 拒绝 `lower-priority`；
7. 优先级 **相同** → 拒绝 `equal-priority`（先到先得，避免抖动）；
8. 优先级更高 → 抢占（旧动画发出 `animation:end`，`completed: false`）。

> `interrupt: 'force'` 的语义是「允许抢占更高优先级 / 相同优先级」，不是「无视一切规则」。
> 不可打断动画与冷却期对它依然生效，否则插件或 AI 可以轻易刷爆桌宠。
>
> `bypassCooldown` 只给**用户手动播放**用，表达的是"用户明确点了这一条动画"，
> 而不是"允许刷屏"：冷却本来是防自动化来源高频触发的，不该吞掉用户的主动点击
> （例如 bomb 的 `cooldown` 是 300000ms，被冷却挡住时点第二次毫无反应，
> 看起来就是"这个动画只能播一次"）。自动化来源（行为 / 插件 / AI）一律不带它。

### 4.3.1 三段式持续动画的打断语义

`start -> loop ×（随机 2~5 轮）-> end`。打断**分两种**，这是需求明确要求的：

```text
正在 loop（或 start）时被点击 / 触发 → 立刻进 end 段，end 播完再播打断它的动画
正在 end 段时再被打断              → 立刻结束，直接播新动画（不再排一次收尾）
```

实现要点：被打断的请求挂在 `AnimationManager.pendingAfterEnd`（只留最后一条意图），
由收尾段结束时的 `finishActive()` **先接上挂起请求、再发 `animation:end`** ——
顺序反了会被"动画结束 -> 接回默认动画"那条链路顶掉（实测踩过）。
`watch` 故意不配轮数（无限循环），因为它是右侧收起状态的默认动画，
只在离开收起状态时才播收尾。

### 4.4 动画结束自动回到 IDLE

`<video>` 的 `ended` **只由 AnimationManager 监听**，业务代码不得写 `video.onended`：

```text
IDLE ──play──> PLAYING ──ended──> animation:end ──> StateMachine ──> IDLE
```

`AnimationManager` 发布 `animation:end`，StateMachine 根据事件决定下一状态。

### 4.4.1 换动画不闪烁：视频双缓冲

**问题**：给可见的 `<video>` 换 `src` 时，Chromium 会立刻丢掉当前帧
（触发 `emptied`，`readyState` 掉到 0）。如果这时元素还是可见的，
桌宠就会整只变透明 —— 表现为**播放前/播放后各闪一下**。

实测（逐帧采样视频纹理）：换源后有 **5 帧 `readyState < 2`**，
期间画布上没有任何不透明像素。

**方案**：页面上放**两个** `<video>`（A/B），换源永远发生在隐藏的那个上，
等它真的解出一帧之后再交换可见性：

```text
pet-video (可见)  ← 正在播 idle
pet-video-b(隐藏) ← 加载 cute.webm → 等 loadeddata → 再等一帧绘制
        ↓ 交换
pet-video-b(可见) ← 播 cute      pet-video (隐藏，释放素材)
```

实测结果（`tools/diag-switch-flicker.cjs`，361 帧采样）：

```json
{ "visibleBlankFrames": 0, "noTextureVisibleFrames": 0, "noneActiveFrames": 0 }
```

另外两条相关修复：

- **同一素材复用**：如果目标素材就是当前缓冲正在播的（典型场景：点击后回 idle），
  连换源都不做，只把时间轴拨回 0，因此那条路径完全没有空档。
- **await 之后的存活检查**：换源、等解码、等帧绘制这几步都是异步的，
  期间 `ended` 事件可能到达并把当前播放置空。若无检查，旧请求醒来后会继续
  交换缓冲并发出 `animation:start`，把新动画顶掉 ——
  表现为"动画状态和画面不一致、兜底循环再也接不回来"。
  现在每个 `await` 之后都确认 `token` 仍然是当前播放，不是就直接放弃。

### 4.4.2 播放层故障自愈

`<video>` 偶发会停在 `readyState = 0`（有 `src`、没解码数据、
且不一定触发 `error`）的僵死状态。这属于播放层故障而非业务问题，因此加了两道保险：

| 保险 | 作用 |
| --- | --- |
| 结束看门狗 | 非循环动画按素材时长 + 0.8s 设一个定时器；`ended` 事件丢了也会走完结束流程 |
| 画面看门狗 | 每 2.5s 检查一次：IDLE 状态下若可见缓冲不可播，则强制重载并重播兜底动画 |

配合 pet-asset:// 协议处理器上的 8s 超时：宁可返回错误让渲染层走自愈，
也不要静默挂死。

### 4.5 素材预处理：把黑底哑光烘焙成真正的透明 WebM

**问题**：原始素材是 VP8 编码、**没有 alpha 通道**、背景是纯黑哑光（premultiplied alpha 渲染到黑底）。
直接播放会出现黑方块，而 Chromium 也无法从 WebM VP8/VP9 的原始像素里还原 alpha。

**方案**：用 ffmpeg 在**构建期一次性烘焙**成带 alpha 的 VP9 WebM，运行时零处理。
`<video>` 直接解码出透明像素，`mix-blend-mode` 保持 `normal`，没有 canvas、没有逐帧循环。

```bash
npm run convert:alpha          # 全部素材
node tools/convert-alpha.mjs idle sleep   # 只处理指定素材
node tools/convert-alpha.mjs --force      # 重新烘焙
npm run verify:alpha           # 逐条核验（在 Chromium 里测真实 alpha）
```

**原理**（逐像素验证过）：素材满足 `rgb = 真实颜色 × alpha`，因此

```text
alpha = 分段蒙版(亮度)          —— 见下方阈值说明
C     = rgb × 255 / max(r,g,b)  —— 反预乘还原直通颜色
```

#### alpha 蒙版为什么必须分段（关键修正）

最直观的做法是 `alpha = 亮度`（因为预乘后亮度确实等于 alpha），但**那样是错的**：
角色本身的深色部分（深蓝头发、深色描边）在预乘后亮度同样很低，会被判成半透明，
于是整只角色看起来发虚、像蒙了一层雾。

实测对比（`build/matte/idle-compare.png`，棋盘底并排）：

| 蒙版 | 全透明 | 半透明 | **完全不透明** | 观感 |
| --- | --- | --- | --- | --- |
| `alpha = 亮度` | 47.5% | 52.5% | **0%** | 整只角色半透明、发虚 |
| **分段 `lo=8 hi=48`** | 50% | 16.4% | **33.6%** | 实体不透明，仅软边/阴影半透明 |

分段语义：

```text
luma >= 48   -> 255   角色实体，完全不透明
8 .. 48      -> 线性过渡（抗锯齿边缘、脚下软阴影保持真实半透明）
luma <= 8    -> 0     纯黑背景，完全透明
```

可调：`PET_ALPHA_LO=8 PET_ALPHA_HI=40 npm run convert:alpha -- --force`

ffmpeg 滤镜链（`tools/convert-alpha.mjs`）：

```text
[0:v] split[srcA][srcB];
[srcA] format=gbrp, geq=r/g/b='x*255/max(1,max(max(r,g),b))', format=rgb24 [rgb];
[srcB] format=gray, lut=y='if(lt(val,8),0,if(gt(val,48),255,255*(val-8)/40))' [matte];
[rgb][matte] alphamerge, format=yuva420p [out]
```

> ⚠️ 三个踩过的坑（代码里都留了注释）：
> 1. **蒙版必须取自源**。若先 `format=gbrap` 再 `alphaextract`，alpha 平面会被填成 255，
>    结果是整帧不透明。
> 2. **不能只用亮度当 alpha**（见上表），否则角色整体变半透明。
> 3. VP9 的 alpha 存在 WebM 的 **alpha side channel** 里，`ffprobe` 依然报告 `pix_fmt=yuv420p`，
>    所以**不能用 ffprobe 判断素材是否透明** —— 必须真正解码看像素（`npm run verify:alpha`）。
>    另外用 ffmpeg 抽帧核对时，需要显式写 `-c:v libvpx-vp9`，否则解出来的是不带 alpha 的版本。

编码参数：`libvpx-vp9 -pix_fmt yuva420p -crf 32 -b:v 0 -auto-alt-ref 0 -row-mt 1 -cpu-used 5`。
`-auto-alt-ref 0` 是因为 VP9 的 alt-ref 帧与 alpha side channel 兼容性不佳。

**为什么选 VP9-alpha 而不是动画 WebP / APNG**（实测对比同一段 idle）：

| 格式 | 体积 | Chromium alpha 解码 |
| --- | --- | --- |
| **VP9 alpha WebM** | **6.5 MB** | ✅ 已验证（四角 alpha=0、角色 alpha≈238） |
| 动画 WebP (lossy q80) | 42 MB | ✅ 但体积大 6.5 倍 |
| 动画 WebP (lossless) | 51 MB | ✅ 不可接受 |
| APNG | 体积尚可 | ⚠️ ffmpeg 输出需额外处理 |

**目录约定**：原始预乘素材会被自动备份到 `assets/animations/source-premultiplied/`。
要重新烘焙或换编码参数时，从备份重跑即可（`--force`）。

**运行时的实际结果**（`npm run verify:visual`）：

```json
{
  "source": { "w": 834, "h": 1112 },
  "videoMixBlendMode": "normal",
  "pctTransparent": 50.9,
  "pctSemi": 15.9,
  "pctOpaque": 33.2,
  "edges": { "topLeft": 0, "topRight": 0, "bottomLeft": 0, "bottomRight": 0,
             "topMid": 0, "leftMid": 0, "rightMid": 0, "bottomMid": 0 },
  "centerAlpha": 255
}
```

四角与四条边中点 alpha 全为 0；**角色区域 33.2% 完全不透明**（alpha=255），
只有边缘与脚下阴影是半透明 —— 真正"实心"地贴在桌面上，且没有任何运行时开销。

新素材的流程：`放进 assets/animations/` → `npm run convert:alpha` → `npm run verify:alpha` → 在 `animations.json` 加一条记录。

---

## 5. 状态机

第一版状态：`IDLE` / `PLAYING` / `SLEEPING` / `BUSY`。

```text
                               ┌───── idle timeout ─────> SLEEPING
                               │                             │
      IDLE ────播放动画────> PLAYING ──animation:end──> IDLE  │（唤醒）
        ↑                      │                              │
        └──────────────────────┴──────────────────────────────┘
                               │
                            BUSY（未来任务系统）
```

迁移采用**白名单**：不在允许列表内的迁移被拒绝并发布 `state:rejected`，同时保留最近 100 条迁移历史。

---

## 5.1 桌宠尺寸（滚动条可调 + 自动保存）

尺寸只用一个**缩放系数**表示，素材宽高比是唯一来源：

```text
窗口高度 = 基准高度 480px × scale      （并受当前显示器工作区高度限制，超出自动收敛）
窗口宽度 = 窗口高度 × 素材宽高比（834/1112 = 0.75）
```

默认 `scale = 0.6`（288×384）——100% 对应的 360×480 在 1080p 工作区上要占掉近 60% 高度，
默认值刻意取小，需要多大由用户自己拖。

| 入口 | 操作 |
| --- | --- |
| 托盘/右键 → **设置…** → 顶部滚动条 | 滚动条连续调节（20%–250%，步进 5%），拖动即生效并立刻写盘 |
| 设置窗口 → **恢复默认大小** | 一键回到 100%（一个按钮，不再占用菜单） |
| 插件 / 未来的设置界面 | `window.petAPI.settings.setScale(0.8)`（走同一条写盘路径） |

> 需求明确"**只保留拖动改变大小**"，因此体型档位（迷你/小/中/大/超大）已**移除**：
> 滚动条能拖出任意 5% 步进的值，档位 radio 在 85% 这种非档位值上只能全部不勾选，
> 两套入口并存只会带来歧义。
>
> 「调整大小…」这一项**已经从菜单里删掉**（2026-09 需求）：它属于配置，
> 点「设置…」进去就是同一根滚动条，菜单里那一项只是把用户多绕一层。
> 同一批搬进设置窗口的还有：总是置顶、拖到边缘自动收起、重载插件、打开配置目录。

### 设置窗口（`src/settings/` + `main/settings-window-manager.ts`）

为什么是一个**独立普通窗口**，而不是原生对话框：

- `dialog.showMessageBox` 只能给按钮，做不出滚动条；
- 桌宠窗口是 `transparent + frame:false + alwaysOnTop` 的"活体图层"，
  在里面放控件既会被透明背景吃掉，又会跟着桌宠一起缩放。

交互约定（重要）：**拖动 = 立即生效 + 立即写盘**，没有"预览/保存"两套状态，
所以不存在"忘了点保存"这种丢配置的方式。页面上的百分比是**用户请求值**，
括号里的像素是**实际生效值**，显示器装不下时下方会出现黄条说明收敛结果。

安全上，设置窗口与桌宠窗口**共用同一份 preload 产物**，靠命令行参数
`--pet-window=settings` 区分角色：设置窗口只拿到 `window.settingsAPI`
（`setScale` / `setAlwaysOnTop` / `setDockOnEdge` / `reloadPlugins` /
`openConfigFolder` / `close` / `onChanged`），
**拿不到 `window.petAPI`**（验收里有断言）。

设置窗口顶部的「外观与行为」一组控件（2026-09 需求：配置从菜单搬进来）：

| 控件 | 作用 | 走哪条 IPC |
| --- | --- | --- |
| 滚动条 + 恢复默认大小 | 20%–250% 连续调大小 | `SettingsWindowSetScale` |
| 总是置顶 | 盖在其它窗口之上 | `SettingsWindowSetAlwaysOnTop` |
| **拖到边缘自动收起** | 关掉后她可以停在屏幕中间、不贴边 | `SettingsWindowSetDockOnEdge` |
| **插件面板**（列表 / 开关 / 权限 / **安装…** / **卸载** / 重新发现） | 装插件、卸插件、随时启停 | `PluginInstall` / `PluginUninstall` / `SettingsWindowSetPluginEnabled` / `SettingsWindowReloadPlugins` |
| 打开配置目录 | 在文件管理器里打开 `assets/config/` | `SettingsWindowOpenConfig` |

> 这四条以前都在托盘/右键菜单里。搬家的理由：它们都是**调一次就不动的配置**，
> 留在菜单里既占位置，又把"和她说句话"这类日常动作挤到下半屏；
> 现在菜单只放日常动作，点「设置…」能找到全部配置。
> 感知那一整块（隐私模式、看我在做什么、立刻采样、感知日志、摄像头授权、
> 习惯模型）也都在设置窗口的「环境与用户感知」面板里，菜单不再重复。

细节：

- 范围夹取在 **20%–250%**（`clampPetScale`），步进吸附 5%（`snapPetScale`），
  避免把 `0.7000000000000001` 写进配置；20% 对应窗口 96×72，
  再小会撞上窗口最小尺寸（64px）而无法等比缩小；
- `PetSizeInfo.scale` 是**用户请求值**（已按上下限夹取），`windowScale` 是**实际生效值**
  —— 因为显示器高度不够时只会压缩窗口像素，不改写用户的选择；
  例如请求 250% 在 816px 高的工作区上会得到 `scale: 2.5, windowScale: 1.7`；
- 调整尺寸时保持**默认尺寸中心**锚点（早期是右下角锚点，连续拖动时会朝右下"爬"）；
- 设置写入 `assets/config/settings.json`（打包后可写，因为 assets 在 asar 之外），
  写入是"先写 tmp 再改名"的原子替换；
- Renderer 侧图层是 100% 自适应窗口的，所以改尺寸**不需要重新加载动画**，只通知一次。

### 5.2 窗口移动的两个 Windows 坑（都踩过）

在 `resizable: false` 的透明无边框窗口上移动，Windows 有两个反直觉行为。
两个问题都通过 `tools/diag-jitter.cjs` 等脚本实测定位，结论如下。

**坑 1：拖动时桌宠越来越大**

| 移动方式 | 连续移动 12 次后的尺寸 | 结论 |
| --- | --- | --- |
| `setPosition()` | 一路涨到 **376×496** | ❌ 每次 +1 且累积 |
| `setBounds(用当前尺寸)` | 一路涨到 **376×496** | ❌ 同样累积 |
| `setPosition()` + `setSize()` | 一路涨到 **384×504** | ❌ 更糟 |
| **`setBounds(显式 w/h)`** | 恒为 **361×481** | ✅ 采用 |

原因：这些 API 在移动时会把窗口的 `minimumSize` 一起顶大（最小尺寸棘轮），
而回读 `getBounds()` 又会把这个误差带进下一次移动，于是滚雪球。

修复：`WindowManager.moveWindow()` 统一用 `setBounds` 并**显式带上目标尺寸**；
同时用 `logicalSize` 作为尺寸的单一事实来源，不再每次回读 `getBounds()`。

**坑 2：拖动时画面闪一下 / 瞬移一次**

有两个独立原因，都会表现为"拖动时闪一下"。

（a）**位置没落在物理像素网格上。** 在 125% 缩放（`scaleFactor = 1.25`）下，
若窗口位置不在物理像素网格上，Windows 每次移动都会重新对齐窗口矩形，
窗口高度就在 480 / 481 之间抖动 —— 表现为闪烁。

| 每次移动的步进 | resize 次数 | 尺寸 |
| --- | --- | --- |
| 9, 7 | 1 | 361×481 |
| 10, 10 | **8** | 361×481 ↔ 360×480（抖动 = 闪烁） |
| **4, 4** | **0** | 360×480 |
| **8, 8** | **0** | 360×480 |

修复：`WindowManager.setPosition()` 把位置**对齐到物理像素网格**，
步长取 `1 / 缩放的小数部分`（1.25 → 4）。对齐后拖动全程 **0 次 resize**。

（b）**拖拽原点的异步竞态。** `beginDrag` 需要异步向主进程要窗口位置，
而 `moveDrag` 是同步调用的。指针抖动只要超过 5px 就会立即触发 `moveDrag`，
此时 `dragOriginWindow` 还是**上一次拖拽的残留值**，算出来的目标位置是错的 ——
窗口先"瞬移"到一个错误位置，再跟上鼠标。

修复：给每次拖拽加 token，`moveDrag` 发现原点尚未就绪时**直接丢弃这一帧**
（丢 1~2 帧肉眼无感），而不是拿旧原点去算。实测瞬移消失（位置序列无跳变）。

> 另一个坑：对 `resizable: false` 的窗口调用 `setSize()` 同样会顶大最小尺寸，
> 导致桌宠只能变大不能变小。现已统一走 `setBounds` 路径。

---

## 6. 事件总线

```ts
eventBus.emit('pet:click', { region: 'head', ... });
eventBus.emit('animation:start', { animationId: 'cute', priority: 50 });
eventBus.emit('animation:end', { animationId: 'cute', completed: true });

const sub = eventBus.on('pet:click', handler);
eventBus.once('pet:click', handler);
eventBus.off('pet:click', handler);
sub.unsubscribe();
```

- 支持拦截器（`addInterceptor`），未来 AI/审计插件可在事件流上观察或改写；
- **监听器抛错被隔离**：同步异常被捕获，异步 rejection 被上报，不影响其它监听器与桌宠主体；
- 自定义事件名也被允许（`PetEventName = KnownEventName | (string & {})`），插件与未来 AI 事件无需修改核心。

主要事件：`app:ready`、`pet:click`、`pet:dblclick`、`pet:drag`、`pet:region`、`animation:request|start|end|rejected`、`state:change`、`action:received|rejected`、`plugin:discovered|loaded|activated|deactivated|unloaded|error`、`behavior:triggered|paused`。

---

## 7. Action Pipeline（统一行为入口）

**所有**行为来源都汇入同一条管线：

```text
用户点击 ┐
插件     ├─> Action Pipeline ─> 守卫 ─> StateMachine ─> AnimationManager ─> WebM
定时器   │
Behavior │
AI Agent ┘
```

```ts
actionManager.execute({
  type: 'animation',
  animationId: 'coffee',
  priority: 30,
  source: 'ai-agent',
  reason: 'user_has_been_working_for_a_long_time',
});
```

三种 Action 类型：`animation`（播动画）、`state`（请求状态迁移）、`event`（派发事件）。
`addGuard()` 可插入裁决逻辑（返回 `false` 即拒绝），为未来策略引擎/AI 留出插槽。

---

## 8. 插件系统

### 8.1 插件能做什么，不能做什么

插件运行在 Renderer 的沙箱宿主（`PluginHost`）中，通过 `activate(context)` 拿到受控的 `PluginContext`：

```ts
interface PluginContext {
  events: PluginEventAPI;      // on / once / off / emit
  animations: PluginAnimationAPI; // play / stop / isPlaying / getCurrent / getDefinition / list / register
  state: PluginStateAPI;       // get / is / onChange / list（只读）
  actions: PluginActionAPI;    // execute(PetAction) —— 与 AI Agent 同一条管线
  behavior: PluginBehaviorAPI; // pause / resume / isPaused
  system: PluginSystemAPI;     // getVersion / getPlatform / showNotification / log / openExternal
  storage: PluginStorageAPI;   // get / set / remove / keys（按插件命名空间隔离）
  lifecycle: PluginLifecycleAPI; // permissions / has() / onDispose()（停用即回收）
  timers: PluginTimerAPI;      // after / every / cancel —— **主进程计时**
  net: PluginNetAPI;           // request / json                —— 权限 net
  process: PluginProcessAPI;   // run / which                   —— 权限 process
  python: PluginPythonAPI;     // available / run               —— 权限 python
  notify: PluginNotifyAPI;     // send / onClick                —— 权限 notify
  mail: PluginMailAPI;         // send(主题+正文+附件)           —— 权限 mail
  ui: PluginUIAPI;             // 菜单项 / 聊天窗口面板 / say    —— 权限 ui
  logger: Logger;
  plugin: { id, name, version, ... };
  pluginDir: string;
}
```

`timers` / `net` / `process` / `python` / `notify` / `mail` / `ui` 是**按权限开放的系统能力**：
权限写在插件自己的 `package.json`（`"permissions": ["net", "notify"]`），
用户还能在 `assets/config/plugins.json` 里收窄（只减不增），执法点在主进程
（`src/main/plugin-runtime.ts`）—— 渲染层根本没有"联网/起进程/发通知"的能力
（CSP 是 `connect-src 'none'`，模板也读不到磁盘）。

插件**不能**访问：`BrowserWindow`、`ipcMain`、`require`（除虚拟模块 `desktop-pet`）、`process`、`fs`、`path`、
以及 `window` / `document` / `fetch` / `XMLHttpRequest` / `localStorage` / `window.petAPI`、Electron internals。
后面这几个浏览器全局是在沙箱模块体里显式声明成 `undefined` 的：否则插件可以绕过 `PluginContext`
直接调用桌宠的 IPC 面，权限声明就成了摆设。桌宠窗口另外拦了 `will-navigate` 与 `window.open`。

**详细的接口清单、"八个想做的插件够不够"的逐条核实、以及还没实现的能力（`context.fs` /
`context.secrets`）见 [`docs/plugins.md`](docs/plugins.md)。**


**沙箱实现（一个值得说明的设计点）**：页面 CSP 是 `script-src 'self' blob:`，**没有** `unsafe-eval`，
所以 `new Function` / `eval` 会被 CSP 直接拒绝。插件代码因此以 **blob ES module** 形式执行：
Main 进程把插件编译成自包含 CommonJS → Renderer 把代码内联进模块体（`module`/`exports`/`require`/`console`
绑定到受控垫片）→ `import(blobUrl)` 取回插件对象。插件代码是模块体的一部分，由浏览器正常编译，不需要 eval。

插件作用域内还显式屏蔽了 `process` / `global` / `Buffer` / `__dirname` / `__filename`。
想彻底禁用插件代码执行，把 `index.html` 的 `script-src` 改回 `'self'` 即可 —— 核心桌宠功能不受影响。

**插件编译策略**：esbuild 是 devDependency（打包后不存在），且它的 JS API 不能被 bundle。
因此采用双路径：

| 场景 | 编译方式 |
| --- | --- |
| 开发 / 源码运行 | 运行时用 esbuild 编译 `.ts` 插件（改完代码点设置窗口的「重载插件」即可生效） |
| 打包运行 | 读取构建阶段由 `tools/build-plugins.mjs` 生成的 `dist/plugins/<path>/index.js` |

两条路径产出格式完全一致，`PluginHost` 只有一条执行路径。

### 8.2 生命周期与接口

```text
discover → load → activate → running → deactivate → unload
```

`PluginManager`（Main 进程）公开：

```ts
discoverPlugins(): readonly DiscoveredPlugin[]
loadPlugin(id): Promise<PluginCodePayload | null>
activatePlugin(id): boolean
deactivatePlugin(id): boolean
reloadPlugin(id): Promise<PluginCodePayload | null>
unloadPlugin(id): boolean
getLoadedPlugins(): readonly PluginRecord[]
/* 运行期启停与权限（"插件可随时关闭"的那一半） */
setPluginEnabled(id, enabled): PluginToggleResult   // 写回 plugins.json + 重新发现
getPluginRecords(): readonly PluginRecord[]         // 含被关掉的插件
getEffectivePermissions(id): readonly PluginPermission[]
getDiscoveredPlugins(): readonly DiscoveredPlugin[]
```

`PluginHost`（Renderer 进程）公开：

```ts
bootstrap(plugins): Promise<void>
enablePlugin(entry): Promise<boolean>        // 单个启用（现场取代码 + activate）
disablePlugin(id): Promise<boolean>          // 单个停用（回收一切 + 下线菜单与面板）
deactivate(id): Promise<boolean>
reloadAll(entries): Promise<void>            // 整体重载
applyEnabledCommand(id, enabled, entry)      // Main 下发的启停指令
handleUIEvent(event)                         // 菜单点击 / 通知点击 / 面板动作
handleTimerTick(pluginId, timerId, kind)     // 主进程定时器到点
getLoadedPlugins(): readonly PluginRecord[]
deactivateAll(): void
```

**插件异常隔离**：`activate()` 用 try/catch + 5s 超时保护；失败时回滚该插件的全部事件订阅、
回收它已登记的资源、标记为 `failed` 并记录日志，不影响桌宠核心与其他插件。

### 8.3 启用 / 停用（可随时关闭，不用重启）

`assets/config/plugins.json`（**随包只登记一个插件**：`todo-plugin` 待办清单，见 §8.5；
原先两个示例插件 `hello-plugin` / `random-action-plugin` 已按需求卸载并删掉源码）：

```json
{
  "plugins": [
    { "id": "pomodoro-plugin", "path": "pomodoro-plugin", "enabled": true },
    { "id": "search-plugin", "path": "search-plugin", "enabled": false, "permissions": ["net"] },
    { "id": "builtin-thing", "path": "vendor/builtin-thing", "enabled": true }
  ]
}
```

- `enabled`：开关。改文件可以，但**不必手改** —— 设置窗口的「插件」面板与托盘菜单的
  「插件」子菜单都能点，点了立刻生效并写回这个文件；
- `path`：相对 `plugins/` 的目录。**没有 `/` 的（就在 `plugins/` 根下一层）算"用户安装的"，
  可以一键卸载**；带层级的（如 `vendor/builtin-thing`）视为随包内置，卸载会被拒绝；
- `permissions`（可选）：**用户额度**，只减不增 —— 写了就与插件 `package.json` 里声明的取交集，
  可以用来"插件留着，但先不给它联网"；
- 被关掉的插件仍然会出现在设置窗口与菜单里（状态 `disabled`），否则用户就"关得掉、开不回来"。

关掉一个插件时按顺序发生（`PluginHost.disablePlugin` + `PluginRuntime.revoke`）：

```text
Main:     写盘 -> 收回权限 -> 清主进程定时器 -> 杀掉它的子进程 -> 下线菜单项与面板
Renderer: 退订事件 -> 取消定时器 -> 跑 onDispose 回调 -> 调它自己的 deactivate()
```

两个刻意的顺序：**先回收 Main 侧资源再通知渲染层**（渲染层卡住也不影响回收）、
**先退订事件最后才调 `deactivate()`**（插件收尾时不该还能收到事件）。
再打开 = 现场取代码 + `activate()`，只动这一个插件，不打断其它插件。

「重载插件」按钮仍然存在（整体重载）：它会**先向主进程要最新清单**再全部重来，
所以新放进 `plugins/` 的插件与刚被关掉的插件都能立刻反映出来。

### 8.3.1 安装 / 卸载插件

设置窗口「插件」面板上有两个按钮：**「安装插件…」**（弹原生目录选择框）与每张卡片右下角的 **「卸载」**。

```text
安装：选一个插件文件夹 -> Main 校验（package.json + 能解析出入口 + 规模上限）
      -> 复制进 plugins/<id>/ -> 登记到 plugins.json（enabled: true）-> 立刻启用
卸载：停用（连带回收定时器/子进程/菜单/面板）-> 删除 plugins/<id>/ -> 从清单移除 -> 清掉它的存储
```

几条刻意定下的规则：

| 规则 | 为什么 |
| --- | --- |
| 安装的是**文件夹**，不是 `.zip` | 插件就是"一个入口 + 若干资源"，没有依赖树；复制最可解释，用户能自己打开看、改、删 |
| 必须有 `package.json` 且入口能解析 | 否则用户挑到 `C:\` 这种目录也会被当成插件；入口候选表与发现器**共用同一份** |
| 文件数 > 2000 或体积 > 64MB 直接拒绝 | 一眼能看出"选错目录了"，不必复制到一半才发现 |
| 不复制 `node_modules` / `.git` / `.vscode` / `__pycache__`，也不复制**符号链接** | 前者是垃圾，后者可能指向插件目录之外（留一个后门） |
| 覆盖安装 = **升级**（只对用户安装的插件） | `plugins/examples/*` 是随程序发布的内置示例，绝不被覆盖 |
| 卸载只允许删 `plugins/` **根下一层**的目录 | 内置示例删了会破坏随包内容；要删它们请直接改仓库 |
| 卸载会清掉插件的 localStorage 与 `data/plugins/<id>/` | "卸载"应当等于"干净地消失" |
| 覆盖安装时会**先失效代码缓存、再停后开** | 否则渲染层以"已经加载过"跳过，跑的还是旧代码（现象是"装了没变化"） |

> 自动化入口：`install(directory)` 可以显式给路径（验收脚本用），不传才会弹框；
> 卸载失败时会把插件**放回停用前的状态**，不会出现"点了一下卸载、插件反而被停了"。

### 8.3.2 界面：菜单项与面板

插件想被用户"叫起来"、想展示内容，有两条受控通道（权限 `ui`）：

| 通道 | 用法 | 出现在哪 |
| --- | --- | --- |
| 菜单项 | `context.ui.registerMenuItem({ id, label, checked }, handler)` | 托盘 / 右键菜单的「插件」子菜单，按插件分组；点击回流给插件 |
| 面板 | `context.ui.registerPanel({ id, title, html, onAction })` | 聊天窗口的插件页签（普通窗口、能滚动、能打字） |

面板是**声明式**的：一段被净化的 HTML + `data-plugin-action="id"` 按钮 + `data-plugin-field="name"`
输入控件。点一下就把**整个面板的字段快照**交给插件，插件返回新 HTML 即刷新；
面板里的 `<a href>` 由宿主代开系统浏览器（保留动作 `@open-external`，页面自身不导航）。
净化器（`src/shared/plugin-panel-html.ts`）只放行展示型标签，`script` / `on*` / 非 `data:` 图片 /
非 http(s) 链接一律剔除 —— 因为面板内容常常是插件刚从网上取回的**远程数据**。

**为什么面板在聊天窗口而不是桌宠窗口**：桌宠窗口是透明、点击穿透、跟着宠物缩放的"活体图层"，
放不下 TODO 列表与课程表；而聊天窗口已经有"列表 + 滚动 + 打字"（「交互」页签就是同一个模式的先例）。
插件跑在桌宠窗口的渲染进程里，面板渲染在聊天窗口里 —— 两边通过 Main 中转 HTML 快照与点击事件，
插件**拿不到**第二个窗口的 DOM。


### 8.4 写一个插件

`plugins/examples/hello-plugin/index.ts`：

```ts
import { definePlugin, type PluginContext } from 'desktop-pet';

export default definePlugin({
  id: 'hello-plugin',
  name: 'Hello 插件',
  version: '0.1.0',

  async activate(context: PluginContext) {
    context.logger.info('插件已激活');
    context.events.on('pet:click', (payload) => {
      context.logger.info(`被点击：${payload.region}`);
    });
    context.events.on('animation:end', (payload) => {
      context.logger.info(`动画结束：${payload.animationId}`);
    });
    await context.animations.play('talk', { priority: 40, reason: 'hello' });
  },

  async deactivate() {
    // PluginHost 会自动清理该插件的全部订阅，这里只做自定义资源释放
  },
});
```

插件目录需要一个 `package.json`（`main` 指向入口，可为 `.ts`，由 esbuild 编译）：

```json
{
  "name": "hello-plugin",
  "displayName": "Hello 插件",
  "version": "0.1.0",
  "main": "index.ts",
  "permissions": ["net", "notify"]
}
```

`permissions` 是**系统能力声明**（`net` / `process` / `python` / `notify` / `mail` / `ui`），
不写就什么系统能力都拿不到；用户还能在 `plugins.json` 里进一步收窄。
写一个"到点提醒我"的插件最短路径：

```ts
async activate(ctx: PluginContext) {
  ctx.ui.registerMenuItem({ id: 'start', label: '开始 25 分钟', checked: false }, () => {
    ctx.timers.after(25 * 60 * 1000, () => {
      void ctx.notify.send({ title: '番茄钟', body: '时间到，休息一下' });
    });
  });
  // 停用时宿主会自动取消定时器；这里只登记"非事件类"的收尾
  ctx.lifecycle.onDispose(() => ctx.logger.info('番茄钟已停止'));
  ctx.logger.info('权限：', { data: { permissions: ctx.lifecycle.permissions } });
}
```

在 IDE 里想要类型提示，把 `plugins/types/desktop-pet.d.ts` 加入你的工程即可
（插件不需要把主工程作为依赖安装；运行时 `desktop-pet` 由沙箱提供）。

### 8.5 随包的插件：待办清单（`plugins/todo-plugin`）

第一个真插件，也是**唯一的随包插件**（`plugins.json` 里就它一条，`enabled: true`）。
它是"插件系统够不够用"的活证据 —— **主程序一行没改**，全靠 `PluginContext`：

| 需求 | 用了哪个接口 |
| --- | --- |
| 输入**时间 + 事件** | `ui.registerPanel`：`data-plugin-field="text"` + `<input type="datetime-local">`，外加「15 分钟后 / 1 小时后 / 3 小时后 / 不设提醒」快捷按钮 |
| 到点**提醒** | `timers.after`（**主进程计时**，窗口隐藏也不降频）→ `ui.say` 冒泡说话 + `notify.send` 系统通知 + `animations.play('remind')`（动画被仲裁拒绝也不影响前两者） |
| 随时**打勾 / 删除** | 每行三个按钮：`完成 / 恢复`、`+10 分钟`、`删除` |
| 记住清单 | `storage`（按插件命名空间隔离；停用/卸载后数据仍在，重新启用就回来） |
| 入口 | `ui.registerMenuItem`（托盘「插件」子菜单，标签实时显示"N 条未完成"）+ 点系统通知 `notify.onClick` 打开面板 |
| 导出 | `mail.send`：清单以 `todo.md` 附件投进「交互」收件箱 |

已知边界（都是宿主/平台的取舍，不是缺接口）：

- 面板是**声明式 HTML、没有脚本**：每次重画都按插件给的 HTML 重建，所以"没提交的输入框草稿"会在重画时丢；
- 桌宠**没在运行**时到点不会响 —— 只能在运行期间提醒，并在下次启动时把"早就过点、还没提醒过"的补提醒一次；
- 时间输入的粒度是**分钟**（`datetime-local` 本身如此）。

> 计划中的另外几个（课程表 / GitHub / 论文 / 网页搜索 / 新闻 / Python / 番茄钟）
> 还没写：接口核实结论、权限清单、面板协议，以及"已经留出但还没实现"的能力
> （`context.fs` / `context.secrets`）见 [`docs/plugins.md`](docs/plugins.md)。

---

## 9. 鼠标互动

- **命中区域**：`InteractionManager` 把归一化坐标映射为 `head / face / ear / body / belly / skirt / legs / tail / outside`，可通过 `regions` 参数调整分区（**仅用于命中判定与右键菜单展示**）；
- **点击** → `pet:click` 事件 + Action（**不再按区域区分动画**：从 `cute` / `fawning` / `stroke` 里随机挑一条，且会避开正在冷却的那条）；
- **双击** → `pet:double-click`（**不再触发动画**：它仍算一次互动，但没有可等的互动动画）；
- **右键** → 原生上下文菜单（与托盘菜单**完全相同**：属性读数（心情与饱腹各占一行）、显示/隐藏、收起（贴边）、交互、播放动画（测试）、插件、设置、退出）；
- **拖动** → 超过 5px 阈值才判定为拖动，通过 IPC 移动窗口；长按（>900ms）不视为点击；窗口位置会被约束至少保留 60px 可见。

---

## 10. 行为系统（随机池 + 随机小动作）

`BehaviorManager` **只产生 Action Request**，绝不直接播放视频：

```ts
{ type: 'animation', animationId: 'roll', reason: 'random-pool:normal-random', source: 'behavior' }
```

它管两种**不同**的自动行为（都由 `assets/config/behavior.json` 驱动）：

| | 随机池 `pools` | 随机小动作 `fidget` |
| --- | --- | --- |
| 何时发生 | 她**空闲**（没有动画在播）时 | **默认姿势正在循环**的过程中 |
| 做什么 | 挑一条自己播，播完回默认 | 打断默认姿势（先播它的 `end`），播 N 轮小动作，**回到同一个默认姿势** |
| 现状 | 正常状态 25–60 秒 | 下方收起：`sleep` 中插 `lie`；右侧收起：`watch` 中插 `peek`（3–8 分钟随机） |

### 10.1 池 + 显示状态（数据驱动）

随机动画不再是"一串写死的行为条目"，而是**池**（`assets/config/behavior.json`）：
到点了就从池里随机挑一个播，挑哪个由 `pickPoolAnimation()` 决定（等概率，可配 `weights`）。

| 显示状态 | 默认动画 | 随机池 | 间隔 |
| --- | --- | --- | --- |
| 正常 `normal` | idle | roll / hot / bomb / play / play_tail / shake / sing / spin / swim（9 个） | 25–60 秒 |
| 下方收起 `docked-bottom` | sleep | **无池** —— 见 §10.2 的 `fidget` | — |
| 右侧收起 `docked-right` | watch | **无池** —— 见 §10.2 的 `fidget` | — |
| 隐藏 `hidden` | 不播 | 无 | — |

> 心情 `<= 25` 时，正常状态的池子内容会被整体换成 `sad`（见 §10.3）——间隔与收起状态都不变。

### 10.4 用户习惯：从统计到"她眼里的你"

感知层会顺手学你的作息（3.6），产出**两层**东西：

| 层 | 内容 | 落盘 | 触发 |
| --- | --- | --- | --- |
| **统计** | `平日/周末 × 小时 × 场景 -> 看到它的日期` + 主要应用 | `data/perception/habits.json` | 每次认出来的观察（默认 30s） |
| **模型** | 把统计归纳成一段话 + 一句能说出口的话 | `data/perception/habit-model.json` | 每天 `habitModelHour`（默认 22 点）后一次，或点「立刻建模」 |

统计口径的四条规矩（都是"她学到的必须是你**现在**的习惯"）：

- **按天计数**：同一天同一小时同一场景只记一次日期（所以"这个点通常…"至少要跨 3 天才说）；
- **遗忘 = 21 个使用日的滑动窗口**：按"运行过的日子"算 —— **没启动的日子不占名额**，出差回来习惯不会丢；
- **作息可回落**：「通常几点在线」取最近 21 个使用日的**中位数**，不是历史极值；
- **分平日/周末 + 记应用**：`工作日 10 点 → 写代码（Code）`，旧数据落在"平时"这一档。

**习惯模型会调用大模型**（没配密钥 / 关掉对话开关时退回本地模板，并在面板写明原因）。
分工是刻意划死的：**条目（几点、在做什么、几天）由本地纯函数算出，模型只负责措辞** ——
这样它编不出数字。详细设计与已知限制见 [`docs/habit-learning.md`](docs/habit-learning.md)。

收起状态没有随机池：她的"换姿势"由随机小动作负责（间隔刻意做成正常状态的 5~10 倍，
需求："收起宠物的随机动画分别只有一个，随机时间触发，注意触发时间要比正常状态下的时间长"）。

### 10.2 随机小动作（收起时的 `lie` / `peek`）

需求：`lie` 要在 **sleep 过程中随机时刻**触发 —— 先播完 `sleep` 的 `end`，再播**随机数量**的
`lie`，然后继续 `sleep`；`peek` 同理，但**只有 `watch` 阶段才能触发**。

配置长在状态上（`behavior.json`）：

```jsonc
"docked-bottom": {
  "defaultAnimation": "sleep",
  "pools": [],
  "fidget": { "animations": ["lie"], "intervalMs": [180000, 480000], "loopCountRange": [1, 3] }
}
```

触发门槛写在 `BehaviorManager.tickFidget()` 里：**当前播的就是该状态的默认动画、且已经在 `loop` 段**。
于是"`sleep` 过程中"与"`watch` 阶段"这两条语义是同一行代码，不需要靠状态机的巧合去表达。
不在门槛内就把排期清零（下次真正进入默认姿势时**重新随机**一个时刻，不会"攒着"立刻插一段）。

顺序完全靠既有的三段式仲裁实现，没有新增播放机制：

```text
sleep(loop) --fidget 到点--> sleep(end) --> lie ×N --> 回 IDLE --> resumeFallbackLoop --> sleep(loop)
```

`lie` / `peek` 是**三段式**动画，`loopCountRange` 决定"随机数量"（`resolvePlayLoopCount`）。
播完能回到 `sleep` / `watch`，靠的是"动画结束 -> 回 IDLE -> 接回当前显示状态的默认动画"这条链路。

三条实现约定：

- **换状态就换池并重新排期**：收起时不该继承"正常状态已经等了一半"的计时
  （否则刚收起就蹦一下，很怪）；
- **只在 `IDLE` 状态触发**（池的 `onlyWhenIdle`）：她正在演反应/说话时不打断；
  **随机小动作相反** —— 它本来就只在"默认姿势正在循环"时发生；
- **全局冷却**（池的 `cooldownMs`）避免多个池在同一秒一起触发。

想加随机动画：把 id 加进池的 `animations` 即可（清单里不存在的 id 会被过滤并告警）。
想改收起时的"换姿势"：改对应状态的 `fidget`（同理会过滤不存在的 id）。
托盘「行为暂停」（隐藏桌宠时自动进入）会同步暂停整个随机池、随机小动作与插件的随机动作。

### 10.3 心情过低：随机池整体变成 `sad`

需求："在心情低于阈值的时候，所有随机池的动画都变成 `sad`，高于阈值再变回来，
收起状态的动画不受影响"。

配置在 `behavior.json` 顶层：

```jsonc
"sadPool": { "enabled": true, "moodBelow": 25, "animation": "sad" }
```

| | 说明 |
| --- | --- |
| 判定 | `心情 <= moodBelow` 生效，`> moodBelow` **立刻**恢复（单一阈值，不做迟滞） |
| 换什么 | 只换**池里挑出来的那条动画**；`intervalMs` / `cooldownMs` / `onlyWhenIdle` 全部照旧 |
| 不换什么 | **默认姿势**（`idle`/`sleep`/`watch`）与**随机小动作**（`lie`/`peek`）—— 收起状态完全不受影响 |
| 阈值为什么是 25 | 与 `pet-triggers.ts` 的 `SAD_MOOD_THRESHOLD` 同值（`moodLabel()` 的"很难过"那一档），否则会出现"UI 说她很难过、随机动作却还在打滚" |

数据流：心情的真相在主进程（要持久化、按在场状态衰减），渲染层只缓存一个读数 ——
`refreshAISurfaces()` 会把 AI 状态推给桌宠窗口，`Renderer.wireMoodMirror()` 收到后写入
`this.mood`，`BehaviorManager` 每次 `rebuild()` / `tick()` 据此决定池子里放什么。
跨过阈值时会**立刻重建**（而不是等下一个 25–60 秒的触发点）。

`sad` 这条动画如果没在清单里（被删了），规则自动失效并记一条 warning ——
不会留下一个"永远挑不出动画"的空池。

端到端验证见 `tools/probe-sad-pool.cjs`（真写一份 `mood: 18` 的 `emotion.json` 再启动）。

### 关于「眨眼」（功能已整体移除）

第一版素材没有真实眨眼帧，早期用「CSS 遮罩 + `transform: scaleY(0.99)`」硬凑过一个闭眼效果，
后来又被改成"只切状态、不做任何视觉表现"。这两个版本都已**整体删除**：

- `src/renderer/core/blink-controller.ts` 已删除；
- 状态机的 `BLINKING` 状态及其迁移已删除（现为 `IDLE` / `PLAYING` / `SLEEPING` / `BUSY`）；
- 早期行为表里的 `blink` 行为、`pet:blink` 事件、`pet-overlay` 叠加层
  以及 `.blinking` 样式全部移除；
- 占位素材 `assets/idle/open.png` / `closed.png` 与 Manifest 里的
  `blink-open` / `blink-closed` 条目一并删除。

`#pet-image` 图层保留：它现在服务的是 Manifest 中 `type: "image"` 的静态动画条目，
与眨眼无关。

---

## 11. 未来 AI Agent 接口

> AI 认知层本身**已经落地**（聊天 / 日记 / 反思 / 小纸条 / 感知），细节见 §11.1、
> [`docs/memory.md`](docs/memory.md)（记忆分层与保留期）、
> [`docs/habit-learning.md`](docs/habit-learning.md)（用户习惯学习：学什么、怎么学、用在哪）与
> [`docs/timeline-continuity.md`](docs/timeline-continuity.md)（「今天在做什么」为什么断断续续：
> 真机数据对账、推理模型吃光 max_tokens 的根因、以及每日预算 vs 采样频率的取舍）。
> 本节讲的是"AI 怎么驱动桌宠"的那条 Action 通道。

架构已经就位，接入 AI 时**不需要改动桌宠核心**：

```text
AI 输出 JSON  { "action": "coffee", "reason": "user_working_long_time" }
        ↓  （由未来的 ai-plugin 或主进程 AI 模块解析）
actionManager.execute({ type: 'animation', animationId: 'coffee', source: 'ai-agent', reason })
        ↓
Action Pipeline → StateMachine → AnimationManager → WebM
```

AI **不允许**直接操作 `video` / DOM / BrowserWindow / Electron，只能调用 Action API。所有 Action 都带 `source`（`user` / `behavior` / `plugin:<id>` / `ai-agent` / `system`），日志里可以完整审计“谁在控制桌宠”。

插件侧已经可以直接用同一条管线：

```ts
await context.actions.execute({ type: 'animation', animationId: 'coffee', priority: 30, reason: 'ai-suggestion' });
// 注意：source 会被 PluginHost 强制改写成 plugin:<id>，防止伪造来源
```

### 11.1 AI 认知层：数据放哪、记得什么、什么时候问模型

**数据目录（重要）**：记忆、日记、小纸条、心情、感知、反思、AI 设置默认写在
**项目目录下的 `data/`**，不再放 C 盘。解析顺序（`src/main/data-dir.ts`）：

1. 环境变量 `DESKTOP_PET_AI_DATA_DIR`（验收/调试隔离用）；
2. **`<appRoot>/data`**（默认）；
3. `userData`（`%APPDATA%\DesktopPet`）—— 仅当项目目录不可写（Program Files、只读盘）时兜底，并记 warning。

首次以"项目目录"启动时会把老的 `%APPDATA%\DesktopPet` 里的数据**一次性复制**过来
（源文件保留作安全网，之后不再重复迁移）。`data/` 已在 `.gitignore` 里
（里面含 `ai-settings.json`，有 API Key）。

> `logs/` 与 Chromium 缓存仍留在 `userData`：它们是**诊断**而不是记忆。

**什么时候调用大模型**（网络只发生在主进程，渲染进程 CSP `connect-src 'none'`）：

| 时机 | 频率 | 用途 |
| --- | --- | --- |
| 用户发一条聊天 | 每条 | 回复；每 6 轮额外做一次"整理"（抽取事实 + 滚动摘要） |
| **模型主动调用 `recall_memory`** | 由模型决定（每条聊天最多 2 轮） | 用户提到"上次/之前/那个项目"时，把记忆宫殿里命中的经历回传 |
| 写日记 | 每天一次（`diaryHour` 后，启动补写） | 生成当天日记（有活动才写）——**只写 `diary/`，不再复制进小纸条** |
| 反思 | 每天一次（`reflectionHour` 后） | 反馈统计 + 心情曲线 → 洞见 → 收紧感知频率 |
| 感知的视觉判断 | 换了应用立刻一次；同一应用最多每 5 分钟一次（`modelRefreshMs`，可在设置里调）；中间的采样沿用上一次判断、**不花 token** | 截图的 base64（不落盘）交视觉模型判断"主人在干嘛" |
| 小纸条「让她记一件」 | 手动触发 | 生成一条她自己记的纸条 |
| 闲聊（她主动开口） | 受频率闸门 + 安静模式限制 | 问候 / 最近的事 / 你的习惯；**候选话头本地生成**，不是每次都问模型 |

**记忆宫殿不再每轮注入提示词**：它作为工具 `recall_memory(query)` 暴露给模型
（`src/main/ai/tools.ts`），本地用 bigram 打分检索（`src/shared/memory-recall.ts`），
取命中的前 3 段回传；查不到就明确说"没有相关经历"，避免编造。
模型/网关不认 `tools` 时（HTTP 400/404）会自动**去掉工具重试一次**，聊天不会整条失败。

**推理模型的两个坑（都已处理，实测踩过）**：

1. **`max_tokens` 会被思考吃光**。本机 `deepseek-flash` 每次回答前先写 600~1000 字
   reasoning，而视觉那条只给了 360 token → 正文被截断或整段为空，
   那一次采样**什么都没记下来**（时间线出现空洞，实测约 1/3 的采样）。
   现在所有"短输出"调用都带 `reasoning_effort: 'none'`（视觉 53~57 token / 0.75s），
   并且空内容时自动把预算放大 3 倍**重试一次**；服务商不认这个字段时也会去掉重试。
2. **省钱靠"窗口没变就别重复问"**：一次视觉调用 1450~1700 token，
   30 秒一次 ≈ 18 万 token/小时（200,000/天的预算一小时就见底）。
   现在换了应用立刻问、同一应用最多每 5 分钟问一次，中间的采样
   **沿用上一次的判断**（`mode: 'local'`、`tokens: 0`）但照样记观察 ——
   时间线不断、预算够用一整天。设置 →「采样与频率」→「模型复核间隔」可调。

> 时间线为什么断断续续、推理模型怎么把预算吃光、以及"没认出来"的桥接口径，
> 有一份带真机数据的完整复盘：[`docs/timeline-continuity.md`](docs/timeline-continuity.md)。

**保留期**：流水会按天清理，结论不会。`keepMemoryDays`（默认 180 天，`0` = 永久）
控制 `memory/events-*.jsonl`、`memory/chat-*.jsonl`、`memory/memory-log.md`；
`profile.json` 里沉淀下来的事实与摘要**不随流水删除**。
感知明细走 `retentionDays`（默认 90 天），反思走 `keepReflectionDays`（默认 180 天）。

---

## 12. 日志

统一 Logger，格式一致（Main 与 Renderer 输出到同一处）：

```text
[12:31:20] [AnimationManager] play coffee
[12:31:24] [AnimationManager] ended coffee
[12:31:24] [StateMachine] PLAYING -> IDLE
[12:31:30] [PluginManager] activated pomodoro-plugin
```

- 级别：`debug` / `info` / `warn` / `error`，`--dev` 或 `--debug` 开启 debug；
- Main 进程同时写入文件：`%APPDATA%\DesktopPet\logs\desktop-pet.log`（超过 1MB 自动轮转，保留 2 份）；
  日志留在 `userData` 而**不跟着记忆搬去 `data/`**（它是诊断，不是记忆，见 §11.1）；
- Renderer 日志通过 IPC 汇总到 Main，因此在同一个终端/文件里能看到完整时序；
- **日志系统本身绝不抛异常**，写失败静默。

---

## 13. 错误处理

| 场景 | 处理 |
| --- | --- |
| WebM / PNG 文件不存在 | `ANIMATION_LOAD_FAILED`，发布 `animation:error`，自动回落到兜底动画 |
| 视频加载/播放失败 | 监听 `<video>` 的 `error`，记录 `MediaError.code`，降级到 idle |
| Manifest 格式错误 | 顶层结构错误抛 `ConfigError`；单条记录错误只跳过并记录 |
| 重复 animation ID | 校验阶段检测，跳过后者并告警 |
| 重复 plugin ID | `plugins.json` 解析时去重并告警 |
| 插件加载失败（无 esbuild 且无预编译产物） | 标记 `failed`，记录日志，不阻塞其他插件 |
| 插件入口未导出合法对象 | 标记 `failed`，发布 `plugin:error` |
| 插件 activate 超时（>5s）或抛错 | 回滚该插件全部订阅并隔离，标记 `failed` |
| 插件事件 handler 抛错 | EventBus 隔离（同步 catch + 异步 rejection 上报） |
| 插件代码被 CSP 拒绝 | 记录 `EvalError` 并隔离；正常情况下使用 blob 模块不会触发 |
| IPC handler 异常 | 捕获后返回结构化错误，主进程不崩 |
| 主进程未捕获异常 | `uncaughtException` / `unhandledRejection` 全局兜底并记录 |
| 渲染进程崩溃 | 记录 `render-process-gone`，主进程继续运行（可从托盘恢复） |
| `assets/config` 缺失 | 记录错误、空载运行，renderer 显示启动失败提示而不是白屏 |

---

## 14. 安全架构

主进程窗口配置（`WindowManager`）：

```ts
frame: false, transparent: true, resizable: false, alwaysOnTop: true

webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  preload: '<absolute path>/preload.js',
  webSecurity: true,
  backgroundThrottling: false,
}
```

- **Renderer 完全没有 Node 能力**：不暴露 `require` / `process` / `ipcRenderer`；
- preload 只暴露语义化白名单方法（`window.petAPI`），**不暴露通用 `invoke(channel, ...)`**；
- 素材通过自定义协议 `pet-asset://assets/<相对路径>` 加载，做协议 host 校验、扩展名白名单、路径穿越防护（越界返回 403），比 `file://` 收敛得多；
- 页面 CSP：`default-src 'none'`、`connect-src 'none'`（禁止一切网络），
  `script-src 'self' blob:`（`blob:` 仅为插件沙箱所需，**未开启 `unsafe-eval`**），
  `img-src` / `media-src` 只允许 `pet-asset:`、`data:`、`blob:`；
- IPC handler 对入参做类型校验，不把 Renderer 数据直接透传给 Electron API；
- 插件作用域进一步收窄（见第 8 节）。

### 14.1 目录与路径解析

`assets/` 与 `plugins/` 的位置在运行时解析（`shared/config.ts`）：

| 模式 | assets / plugins | dist |
| --- | --- | --- |
| 开发 | 仓库根目录 | `<root>/dist` |
| 打包 | `resources/`（electron-builder `extraResources`） | `app.asar/dist` |

`appRoot` 由多路探测确定（`resolveAppRoot`），不依赖 `app.getAppPath()` ——
后者取决于 Electron 的启动方式（`electron tools/xxx.cjs` 会得到 `tools/`），作为路径基准并不可靠。

**AI 数据目录**另行解析（`src/main/data-dir.ts`）：`DESKTOP_PET_AI_DATA_DIR` >
`<appRoot>/data` > `userData`（兜底）。项目目录不可写时自动退回并记 warning，
所以放在 Program Files 或只读盘上也不会写失败。详见 §11.1。

---

## 15. 验收

自动化端到端验收（真实启动桌宠，注入检查脚本）：

```bash
npm run build
npm run acceptance          # 等价于 electron tools/acceptance.cjs
```

结果写入 `build/acceptance.json`，当前覆盖 **391 项检查，全部通过**：

| 分组 | 覆盖内容 |
| --- | --- |
| 窗口 | 创建、不可缩放、始终置顶、可见 |
| 进程隔离 | 无 require / process / module / Buffer、未暴露 ipcRenderer 与通用 invoke、petAPI 与 bootstrap 已注入 |
| 运行时状态 | petApp 挂载、idle 兜底在播、状态机 PLAYING、28 个动画注册、**随包 1 个插件（待办清单）激活** |
| 媒体与透明素材 | WebM 解码、正在播放、loop、自定义协议加载、视频层为可见主渲染层、**未使用混合模式抠图**、四角 alpha=0、**角色区域 44% 完全不透明**、存在半透明软边 |
| 切换不闪烁 | 视频层使用双缓冲、切换动画期间 **0 个无纹理帧 / 0 个空画面帧 / 视频层不消失** |
| idle 循环 | loop 属性、时间轴持续前进、**跨越片尾回到开头**、循环期间不触发 `animation:end` |
| 点击后恢复循环 | 点击播放反应动画 → 结束后状态回 IDLE → **自动接回 idle 并继续循环** |
| 不变形 | 长按 1.5s 画面尺寸恒定、无 `transform` 形变、`object-fit: contain`、**眨眼叠加层已移除（台面只剩 2 video + 1 img）**、静态图片图层保留 |
| 尺寸可调 | 读取设置、60% / 130% 生效、越界夹取（2.5 / 0.2）、恢复 100%、窗口实际尺寸随设置变化、置顶可读写 |
| 设置窗口 | 可打开、滚动条为 `range` 且范围覆盖 20%–250%、已注入 `settingsAPI`、**拿不到桌宠 `petAPI`**、回显当前比例、拖动后比例写入 `settings.json` 且真实改变桌宠尺寸、置顶开关生效、关闭后桌宠存活、**验收结束自动还原用户设置** |
| 时间线连续性 | 空内容自动加大 max_tokens 重试一次、请求里关掉推理、同一程序永远同一个显示名（`msedge` → `Microsoft Edge`）、窗口没变就不重复调模型（0 次调用但仍记观察）、同进程内"没认出来"桥接不切段 |
| 交互（邮件式收件箱）/ 日记 | 旧格式能迁移不丢（单数 `file` → `files` 数组、`author` → `sender`）、用户不能留言、**写日记不进收件箱**、能删消息（连同附件）与单删附件、把消息字段与附件数组的 JSON 对比（**不写死时间戳**）、**拒绝对目录外的名字**、三个页签互斥可来回切、未归档文件单独归类、日记页能展开正文、插件投递（`mail`）落盘并可读、预览浮层平时不显示 |
| 心情 / 随机池 | 池内容随心情切换（`<=25` 只剩 `sad`、`26` 立刻恢复、关掉开关或动画名写空都不生效）、只换池不动 fidget 与默认姿势、**心情推送真的更新了渲染层镜像** |
| 习惯学习 | 按天去重、21 个**使用日**的窗口遗忘（没启动不计入）、作息可回落、平日/周末分档 + 记应用、v1→v2 迁移（含坏数据）、习惯建模（模型只写措辞 / 模板兜底 / token 记账） |
| 用量记账 | 所有大模型调用（含视觉理解与反思）都进账；本次运行按用途分档（真截图 + 假网关跑一次视觉调用） |
| 时间线口径 | 合并只看场景、合段间隔 150 秒、换段补时（采样间隔不丢）、账目自洽（跨度 = 活动 + 空闲 + 没认出来/没采样）、应用**身份**用进程名（模型给的名字只作显示） |
| 托盘 | 菜单顶部属性信息（心情 / 饱腹 / token 本次与累计 / 感知 / 经历 / 未读纸条），且左右键菜单完全一致 |
| 优先级 | 低优先级播放、高优先级抢占、同优先级拒绝、`interruptible:false` 拒绝抢占、冷却生效、**冷却期内手动播放仍可播放（bomb 可重复试放）而自动化来源被冷却拦住** |
| Action Pipeline | animation / state / event 三类走通、重复状态与非法状态被拒绝、未注册动画与非法 Action 被拒绝 |
| 状态机 | 动画开始联动 PLAYING、动画结束自动回 IDLE、**4 个内置状态**、白名单迁移、拒绝未知状态、迁移历史 |
| EventBus | on / off / once、同步与异步监听器异常隔离 |
| 插件 | 随包的待办插件激活、事件监听（点击计数持久化）、插件请求动画、activate 抛错隔离、handler 抛错隔离、异常后主程序存活、安装器装进来的探针插件立刻激活、**卸载等于干净消失**（清存储与 `data/plugins/<id>/`） |
| 系统集成 | 托盘创建、右键菜单调用 |

手动验证清单（无法自动断言的部分）：

- [ ] 桌宠画面背景确实是透明的（不是黑块 / 白块），且**角色本身是实心的**（不发虚、不透）；
- [ ] 桌宠在没有任何操作时**一直在循环播放 idle**（不会播完停住）；
- [ ] 长按 / 按住拖动时画面**不变形**（不压扁、不拉伸）；
- [ ] 从托盘/右键菜单调整「桌宠大小」，桌宠原地缩放且右下角不跳；
- [ ] 重启程序后尺寸设置被记住；
- [ ] 拖动桌宠跟手，且拖到屏幕边缘不会完全消失；
- [ ] 托盘图标显示正常，菜单项点击有反应；
- [ ] 右键菜单能弹出且各项可用（属性读数（心情/饱腹各一行） / 交互 / 播放动画 / 插件 / 显示隐藏 / 设置 / 退出；**没有** AI 子菜单与「查看记忆宫殿」）；
- [ ] 设置窗口里能改大小、置顶、**拖到边缘自动收起**，能**安装/卸载/启停插件**、打开配置目录，能看记忆宫殿与日记；
- [ ] 打开聊天窗口 →「日记」页签 →「写今天的日记」能写出当天一篇，点「看正文」能看到全文；
- [ ] 托盘 →「插件」→「看待办清单…」能打开面板：写一件事 + 选时间 → 到点她**冒泡提醒**（还带系统通知与 remind 动作），打勾 / 恢复 / +10 分钟 / 删除都生效；
- [ ] 打开聊天窗口 →「交互」→「收纳文件…」能弹出系统选择框，选完那条消息带着附件出现在收件箱里；
- [ ] 点文件的「查看」：文本/图片能直接在窗口里显示；点「打开」能用系统程序打开；删掉后列表里消失；
- [ ] 点某张纸条的「删除」：确认框写明"文件不会被删除"，删完纸条少了、文件还在；
- [ ] 关闭窗口后程序仍在托盘驻留，可从托盘退出。

其他脚本（`tools/`，非产品代码）：

| 脚本 | 用途 |
| --- | --- |
| `convert-alpha.mjs` | **素材预处理**：ffmpeg 把预乘黑底素材烘焙成带 alpha 的 VP9 WebM |
| `verify-alpha-assets.cjs` | 在 Chromium 里逐条核验素材真实 alpha 与实体不透明比例 |
| `verify-visual.cjs` | 验证运行时画面边缘真正透明 |
| `compare-matte.cjs` | 生成旧/新蒙版的并排对比图（棋盘底，人工判断用） |
| `probe-matte.cjs` | 试算不同分段阈值下的 alpha 分布 |
| `probe-webm.mjs` | 解析 WebM 头：编码、分辨率、时长、alpha |
| `decode-png.mjs` | 纯 Node 解 PNG（验证滤镜链时用，不依赖图像库） |
| `diag-jitter.cjs` | 复现「拖动闪烁」：对比不同位置步进下的 resize 次数（见 5.2 节） |
| `dump-clip-frames.cjs` | 导出素材关键帧网格图，人工确认动作内容 |
| `build-plugins.mjs` | 构建期预编译插件到 `dist/plugins/` |
| `make-icons.mjs` | **图标**：从 `assets/brand/ds.png` 生成多尺寸 ICO / 应用 PNG / 托盘 PNG |
| `verify-console-encoding.mjs` | 核验日志字节层：把 `src/main/console-encoding.ts` 打成 bundle 后跑真代码，断言输出可逐字还原 |
| `logs.mjs` | **实时查看日志（推荐）**：在纯 Node 进程里读 UTF-8 日志文件并输出，中文必定正常 |
| `generate-assets.mjs` | 生成**兜底占位**图标（真实图标存在时自动跳过） |
| `smoke.cjs` | Electron 最小启动冒烟测试 |
| `acceptance.cjs` | 端到端验收 |

**行为 / 触发的真机探针**（都真启动桌宠，把结论写进 `build/*.json`，可重跑）：

| 脚本 | 验证什么 |
| --- | --- |
| `probe-dock-range.cjs` | 收起的触发范围：必须推到最边上（8px 内）才收；离边 20px 松手不再收起 |
| `probe-dock-transition.cjs` | 收起稳态与离开收起的过渡（不反复播 end、点击/拖离都先播 end 再回 idle） |
| `probe-end-loop.cjs` | 「end 一直循环回不到 idle」的回归：自愈路径不会把 end 播成循环 |
| `probe-end-and-offset.cjs` | 展开就地站立（从点击到回 idle 位置一次都不变）+ watch 渲染偏移（并出对照图 `build/watch-offset-*.png`） |
| `probe-catch-cooldown.cjs` | 鼠标靠近的冷却：真光标（`SetCursorPos`）四次靠近只接住一次，60 秒后才有第二次 |
| `probe-quiet-when-docked.cjs` | 收起/隐藏 = 安静模式：屏幕边上不冒泡、回复只进聊天窗口、用户点「让她说句话」先展开再开口、自动开口整条不发生 |
| `probe-offline-overheat.cjs` | 断网与 GPU 过热：真 `nvidia-smi` 温度 + 真连不上的地址 -> `offline:network` |
| `probe-sad-hungry.cjs` | 心情低与饿：真情绪状态（mood 18 / 预算用光）-> 真的演 sad 与 hungry |
| `probe-triggers.cjs` | 没配密钥时启动就该演一次 offline，且正常心情/饿不会误触发 |
| `probe-fidget.cjs` | 收起时的小动作：在 watch 状态下真的演出 `sleep → end → lie×N → sleep`（不是随机池） |
| `probe-note-views.cjs` | 聊天窗口三个页签（聊天 / 交互 / 日记）互相切换时**只有一个可见**（计算样式级断言，防"叠在一起"回归） |
| `probe-note-files.cjs` | 收件箱的附件真能看真能收：附件行画出三颗按钮、文本进 `<pre>`、图片真的解码（`naturalWidth > 0`）、点「删除」那一行消失、「收纳文件…」把选中的文件**复制**进来并记一条消息（源文件不动） |
| `rebuild-timeline.mjs` | 用**产品里的同一份纯函数**重放 `observations-<日期>.jsonl` 重写 `timeline-<日期>.json`（修历史数据的碎片/漏时；观察记录不动） |
| `probe-sad-pool.cjs` | 心情过低（真写一份 `mood: 18` 的 `emotion.json` 再启动）：正常状态的池子只剩 `sad`、间隔照旧；**收起后没有池、fidget 仍是 `sleep → lie`**，并且最终真的回到 `sleep` |
| `probe-habit-model.cjs` | 习惯建模全链路（真机）：真写一份**旧格式** `habits.json` 再启动，断言迁移后条目落在"平时"档、一次真实模型调用被解析并落盘、token 记进预算（迁移本身的确定性断言在验收里） |
| `probe-terminal-no-model.cjs` | 终端窗口里不调用大模型（隐私边界回归） |
| `probe-timeline.cjs` | 「每天在做什么」端到端：周期观察 → 时间线区间 → `timeline-*.json` / `daily-*.md` 落盘（用本地假模型） |
| `probe-palace-compress.cjs` | 记忆宫殿超期折叠归档 |
| `probe-scene-unrecognized.cjs` | 无法识别场景时不自作主张 |
| `diag-anim-system.cjs` | 动画系统 10 步诊断（分类、随机轮数、池、贴边、点击锁） |
| `diag-perception-ui.cjs` | 感知面板 11 步诊断（开关、授权、日志、过热阈值、保留期落盘） |

`verify-visual.cjs` 会在**真实运行中的桌宠**里检查 alpha 分布并把结果写到 `build/visual.json`
（示例输出见第 4.5 节），是「桌宠真的透明、没有黑方块」的硬证据。

---

## 16. 图标（应用图标 + 托盘图标）

美术原图放在 `assets/brand/ds.png`（1436×1436，带完整 alpha），由 `npm run icons` 生成：

| 产物 | 尺寸 | 用途 |
| --- | --- | --- |
| `build/icon.ico` | 16/24/32/48/64/128/256 七种尺寸内嵌 | electron-builder 打包用（Windows 会按 DPI 自动挑合适的一档） |
| `build/icon.png` | 256×256 | 开发模式下的应用图标 |
| `build/tray.png` | 32×32 | 系统托盘图标（1x） |
| `build/tray@2x.png` | 64×64 | 托盘图标（125%/150% 缩放时优先，避免放大发糊） |
| `build/tray-16.png` | 16×16 | 核对托盘实际显示尺寸用 |

实现要点（`tools/make-icons.mjs`，零第三方依赖）：

- **自己解码 PNG**：工程只依赖 4 个 devDependency，不引入图像库；
  PNG = zlib + 逐行滤波，用 `node:zlib` 的 `inflateSync` + 五种滤波还原即可；
- **自己拼 ICO**：ICO 就是"6 字节目录头 + 每张图 16 字节目录项 + 内嵌 PNG"，
  Vista 之后所有 Windows 都支持内嵌 PNG；
- **自动裁掉留白**：扫描 alpha>8 的最小外接矩形，再做正方形中心裁剪，
  避免原图自带留白导致图标缩得很小；
- **按预乘 alpha 平均缩放**：透明像素的 RGB 通常是无意义的黑/白，
  直接平均会让角色边缘发黑；先乘 alpha 加权、再还原，才能保住软边；
- **不带内边距**：托盘槽位只有 16 逻辑像素、Windows 还会再留一圈空白，
  因此图标素材**铺满画布**（曾经留 3% 内边距，用户反馈"托盘图标太小"后去掉）；
- **提供 @2x**：本机显示缩放 125%，只给 32px 会被放大显示而发糊、显得更小，
  `TrayManager` 因此优先加载 `tray@2x.png`，并逐级回退到 32px / 应用图标；
- **小尺寸要"看得懂"而不是"看得清"**：托盘图用**整颗头**而不是脸部特写
  （实测特写在 16px 下只剩一团蓝色）。

`npm run assets`（兜底占位图标生成）会先检查 `build/icon.ico` 是不是**多尺寸** ICO，
是就跳过 —— 不会把真实图标覆盖成灰色圆点。

---

## 17. 日志与终端显示（Windows）

**日志消息一律用英文，界面文本一律用中文。** 这是一条刻意的约定。

### 为什么日志用英文

Electron 主进程在 Windows + npm 这条链路上，往终端写中文**无法保证正确显示**：

```text
[console] codepage=936 stdout=tty  <- tools/*.mjs（Node 子进程）：中文正常
[build-plugins] 完成，共 2/2 个插件

[console] codepage=936 stdout=pipe <- Electron 主进程：中文乱码
[22:31:17] [Main] 涓昏繘绋嬪惎鍔?
```

两者的**字节完全相同**（实测 hex 一致），差别只在 stdout 是 `tty` 还是 `pipe`。
也就是说问题不取决于我们写什么编码，而在这条通道的下游 —— 因此**换编码解决不了**。

改成英文（ASCII）后，任何终端编码下都能正确显示，问题从根上消失。

### 为什么界面仍用中文

托盘菜单、右键菜单、设置窗口、启动失败提示都是 **HTML/原生控件渲染**，
不经过终端编码，因此中文没有任何问题 —— 而且这是给用户看的，必须保持中文。

### 约定（改代码时请遵守）

| 位置 | 语言 | 原因 |
| --- | --- | --- |
| `logger.*` 消息（main / renderer） | **英文** | 会出现在终端里，见上 |
| `tools/*.mjs` 的 console 提示 | 中文可用 | Node 脚本的输出路径正常（已实测） |
| 托盘 / 右键 / 设置窗口 / 对话框文本 | **中文** | 界面渲染，不受终端影响 |
| 代码注释 | 中文 | 不输出，只给人看 |

### 排查日志

- **文件日志（可靠）**：`%APPDATA%\DesktopPet\logs\desktop-pet.log`，UTF-8 写入，
  每次启动清空，单文件超 1MB 轮转；
- `npm run logs` 可实时跟随该文件（在纯 Node 进程里读取输出）。
- 注意 `app.setName()` **不会**改变已解析的 userData 路径，
  因此 `main.ts` 顶部显式 `app.setPath('userData', ...)`，
  保证开发模式与打包模式、手工启动与自动化验收看到的是同一份日志。

---

## 18. 第一版不做的事情（但已留接口）

Live2D、AI 视频生成、联网 AI、数据库、账号系统、云同步、复杂设置界面、React、复杂 UI 框架、自动更新、多角色、语音识别/合成 —— 全部未实现。

但架构已为它们留好位置：

- **设置界面**：已有可用的设置窗口（滚动条调尺寸 + 置顶开关，即时生效并写盘）；再加配置项只需往 `src/settings/` 加控件 + 一条 IPC 通道；
- **数据库**：`StorageAPI` 已是抽象接口，把 `localStorage` 换成 SQLite/IPC 即可；
- **AI Agent**：`Action Pipeline` 就是接口（第 11 节）；
- **任务系统**：`BUSY` 状态与 `ActionGuard` 已就位；
- **新动画形式**：`AnimationDefinition.type` 是可扩展判别字段，新增 `gif` / `sprite` / `spine` 只需在 `AnimationManager` 加一个分支；
- **多角色**：`WindowManager` / `AnimationManager` 的注册表结构可以直接实例化多份。

---

## 19. 常见问题

**Electron 二进制没下载成功？**
部分 npm 版本会拦截 postinstall 脚本。手动执行：

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
node node_modules/electron/install.js
```

若 `extract-zip` 在较新的 Node 上解压不完整（`dist/` 里只有 LICENSES 文件），可直接解压缓存中的 zip：

```powershell
$zip = "$env:LOCALAPPDATA\electron\Cache\<hash>\electron-v33.4.11-win32-x64.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, "node_modules\electron\dist")
Set-Content node_modules\electron\path.txt -Value 'electron.exe' -NoNewline
```

**`npm run pack` / `npm run dist` 卡在下载 Electron？**
electron-builder 默认从 GitHub 下载对应版本的 Electron，国内网络通常会超时。指定镜像即可：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm run pack
```

**打包报 `winCodeSign-2.6.0.7z` 下载失败？**
electron-builder 在打包 Windows 目标时默认会去 GitHub 下载签名工具链（即使你没有证书）。
本项目在 `electron-builder.yml` 里已经设置 `win.signAndEditExecutable: false` 与
`forceCodeSigning: false`，因此 `npm run pack` 可以完全离线完成。
将来要做签名发布时，删掉这两行并配置 `CSC_LINK` / `CSC_KEY_PASSWORD` 即可。

**打包后的目录结构**

```text
release/win-unpacked/
├── DesktopPet.exe
└── resources/
    ├── app.asar          代码产物（dist/main、dist/preload、dist/renderer、dist/plugins）
    ├── assets/           动画、idle 图、config/*.json（可现场编辑）
    ├── plugins/          插件源码（可现场新增插件目录）
    └── build/            托盘与应用图标（必须在 asar 之外，nativeImage 读不到 asar 内的图片）
```

**她的记忆 / 日记 / 小纸条存在哪？想清空重来怎么办？**

默认在**项目目录的 `data/`**（首次启动会从 `%APPDATA%\DesktopPet` 一次性复制过来）。
想完全重来：删掉 `data/` 即可 —— 迁移只会在 `userData` 里**没有** `.migrated-to-project`
标记时发生，所以不会"删了又被复活"。
只想清流水、不想丢事实：把「记忆保留天数」调小（或点面板里的强制清理），
`memory/profile.json` 里的长期事实与摘要不会被删。

**桌宠显示成黑色方块？**
说明素材还是「预乘黑底」的原始版本，没有经过 alpha 烘焙。执行：

```bash
npm run convert:alpha     # 烘焙成透明 WebM（需要 ffmpeg 在 PATH 上）
npm run verify:alpha      # 确认真的是透明素材
```

**想换素材？**
把新 WebM 放进 `assets/animations/`，然后：

```bash
npm run convert:alpha     # 烘焙出透明版本（原始文件自动备份到 source-premultiplied/）
npm run verify:alpha      # 核验 alpha
```

最后在 `animations.json` 加一条记录即可（`media-meta.json` 会被脚本自动刷新）。
如果新素材**本来就带 alpha**（例如导出的 VP9+alpha），用 `npm run convert:alpha -- --force` 会重复处理，此时改为只跑 `verify:alpha` 确认，并手动把它登记进 manifest。

**调整了尺寸但桌宠没变？**
尺寸是写入 `assets/config/settings.json` 的。确认该文件可写（打包后 assets 位于 asar 之外，正常可写）；
日志里会打印 `桌宠尺寸已更新`，可据此确认链路。

**日志在哪？**
终端（开发期）+ `%APPDATA%\DesktopPet\logs\desktop-pet.log`。

---

## 20. 技术栈

Electron 33 · TypeScript 5.7（strict）· 原生 DOM / HTML / CSS · HTML5 `<video>` · 自研 StateMachine / EventBus / Plugin System / Action Pipeline · esbuild（构建）· electron-builder（打包）· ffmpeg（**仅构建期**烘焙透明素材）· JSON 配置。

运行时依赖为零：没有 React、没有 Zustand、没有数据库、没有不必要的第三方 UI 框架，
也没有任何逐帧图像处理（透明已离线烘焙进素材）。
