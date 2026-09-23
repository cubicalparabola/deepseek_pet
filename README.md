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
npm run acceptance      # 端到端验收（113 项检查）
npm run pack            # electron-builder 打包成未安装目录（快速验证）
npm run dist            # electron-builder 生成 Windows NSIS 安装包
```

启动后：

- 桌宠出现在主屏右下角，**透明、无边框、始终置顶**，默认大小 60%（288×384）；
- **可调整大小**：托盘或右键菜单 →「调整大小…」**直接打开设置窗口**，用滚动条连续调节（20%–250%，步进 5%），
  拖动即时生效并自动写入 `assets/config/settings.json`，重启后保持；
- 左键点击不同部位触发不同动画（头部/耳朵/肚子/尾巴），双击玩耍；
- 按住左键拖动可移动桌宠（超过 5px 位移才判定为拖动）；
- 右键弹出原生上下文菜单；托盘图标提供 显示/隐藏、大小、置顶、**播放动画（测试）**、暂停/恢复行为、重载插件、设置、退出；
- **「播放动画（测试）」菜单列出全部 18 个动画**（按优先级排序，含标签与 id），点任意一条即刻试放 —— 这是第一版最直接的动画测试入口；
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
  ├── PluginManager        插件发现 / TS 编译 / 生命周期编排
  └── Application          生命周期、异常兜底、bootstrap 握手
          │
          │ preload（contextBridge）+ IPC
          ↓
Renderer Process（桌宠窗口）
  ├── EventBus          全局事件总线
  ├── StateMachine      状态机（只决定状态，不播放动画）
  ├── AnimationManager  动画播放唯一入口（优先级 / 打断 / 冷却 / 排队）
  ├── ActionManager     统一 Action Pipeline（守门 + 分发）
  ├── BehaviorManager   行为调度（当前自动动画全部关闭，见 §10）
  ├── InteractionManager 鼠标互动（命中区域、点击、拖拽）
  ├── PluginHost        插件沙箱宿主 + PluginContext 注入
  └── PetLayers         渲染图层（video 双缓冲 / image 静态图）
```

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
│   ├── animations/      18 个**带 alpha 的** VP9 WebM 动画素材
│   │   └── source-premultiplied/   原始预乘黑底素材备份（转换脚本自动生成）
│   ├── brand/           ds.png（美术原图）+ ds.ico（原图自带的多尺寸 ICO）
│   └── config/
│       ├── animations.json   动画 Manifest（新增动画只改这里）
│       ├── plugins.json      插件开关与路径
│       ├── media-meta.json   素材分辨率（用于推导窗口宽高比）
│       └── settings.json     用户设置（尺寸 / 置顶），由程序写入
├── plugins/
│   ├── examples/        hello-plugin / random-action-plugin
│   └── types/           desktop-pet.d.ts（插件类型垫片，给 IDE 用）
├── build/               图标等打包资源（由 npm run assets 生成）
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

动画信息全部来自 `assets/config/animations.json`：

```json
{
  "cute": {
    "type": "video",
    "source": "animations/cute.webm",
    "loop": false,
    "priority": 50,
    "interruptible": true,
    "cooldown": 8000,
    "label": "卖萌",
    "tags": ["reaction", "affection", "click"],
    "render": { "className": "anim-cute" }
  }
}
```

新增动画 = 放入 WebM + 加一条记录，**核心代码零修改**。
Manifest 在加载时会做校验：重复 ID、未知 `type`、非法 `source`、扩展名与类型不匹配都会被抓出来并记录日志，单条失败不会让整体失败。

### 4.3 优先级与打断规则（由核心统一裁决）

优先级越大越优先（约定值，可自由使用 0–1000）：

| 动画 | priority | interruptible |
| --- | --- | --- |
| idle（循环兜底） | 0 | true |
| lie | 10 | true |
| sleep | 20 | **false** |
| work / read / sing | 30 | true |
| talk / remind | 40 | true |
| cute / fawning / stroke | 50 | true |
| bomb（演出） | 100 | **false** |

裁决规则（全部在 `AnimationManager` 内，业务代码不判断）：

1. 未注册 → 拒绝 `not-registered`；
2. 同一动画正在播放 → 忽略 `same-animation`（避免重置到第一帧）；
3. 冷却期内 → 拒绝 `cooldown`（**`force` 也不能绕过** —— 冷却防刷屏，`interrupt` 管能否抢占，两者正交）；唯一例外是用户**手动**挑的动画：托盘 / 右键菜单「播放动画（测试）」带 `bypassCooldown: true`；
4. 当前动画 `interruptible: false` → 拒绝 `not-interruptible`（`force` 也无法抢占）；
5. 新动画优先级 **低于** 当前 → 拒绝 `lower-priority`；
6. 优先级 **相同** → 拒绝 `equal-priority`（先到先得，避免抖动）；
7. 优先级更高 → 抢占，旧动画发出 `animation:end`（`completed: false`）；
8. `interrupt: 'queue'` → 排队到当前动画结束后播放。

> `interrupt: 'force'` 的语义是「允许抢占更高优先级 / 相同优先级」，不是「无视一切规则」。
> 不可打断动画与冷却期对它依然生效，否则插件或 AI 可以轻易刷爆桌宠。
>
> `bypassCooldown` 只给**用户手动播放**用，表达的是"用户明确点了这一条动画"，
> 而不是"允许刷屏"：冷却本来是防自动化来源高频触发的，不该吞掉用户的主动点击
> （例如 bomb 的 `cooldown` 是 300000ms，被冷却挡住时点第二次毫无反应，
> 看起来就是"这个动画只能播一次"）。自动化来源（行为 / 插件 / AI）一律不带它。

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
| 托盘/右键 → **调整大小…** | **直接打开设置窗口**（没有中间层子菜单）：滚动条连续调节（20%–250%，步进 5%），拖动即生效并立刻写盘；菜单项标签上顺带显示当前尺寸 |
| 插件 / 未来的设置界面 | `window.petAPI.settings.setScale(0.8)`（走同一条写盘路径） |

> 需求明确"**只保留拖动改变大小**"，因此体型档位（迷你/小/中/大/超大）已**移除**：
> 滚动条能拖出任意 5% 步进的值，档位 radio 在 85% 这种非档位值上只能全部不勾选，
> 两套入口并存只会带来歧义。
>
> 同时按需求把「桌宠大小」从**子菜单**改成**一个直接点击的菜单项** ——
> 之前要"展开子菜单 → 点调整大小"两步，现在一步到设置窗口。

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
（`setScale` / `setAlwaysOnTop` / `openConfigFolder` / `close` / `onChanged`），
**拿不到 `window.petAPI`**（验收里有断言）。

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
  system: PluginSystemAPI;     // getVersion / getPlatform / showNotification / log
  storage: PluginStorageAPI;   // get / set / remove / keys（按插件命名空间隔离）
  logger: Logger;
  plugin: { id, name, version, ... };
  pluginDir: string;
}
```

插件**不能**访问：`BrowserWindow`、`ipcMain`、`require`（除虚拟模块 `desktop-pet`）、`process`、`fs`、`path`、Electron internals。

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
| 开发 / 源码运行 | 运行时用 esbuild 编译 `.ts` 插件（改完代码点「重载插件」即可生效） |
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
```

**插件异常隔离**：`activate()` 用 try/catch + 5s 超时保护；失败时回滚该插件的全部事件订阅、标记为 `failed` 并记录日志，不影响桌宠核心与其他插件。

### 8.3 启用 / 停用

`assets/config/plugins.json`：

```json
{
  "plugins": [
    { "id": "hello-plugin", "path": "examples/hello-plugin", "enabled": true },
    { "id": "random-action-plugin", "path": "examples/random-action-plugin", "enabled": false }
  ]
}
```

改 `enabled` 即可启停，**核心程序无需修改**（托盘菜单「重载插件」可热重载）。

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
  "main": "index.ts"
}
```

在 IDE 里想要类型提示，把 `plugins/types/desktop-pet.d.ts` 加入你的工程即可
（插件不需要把主工程作为依赖安装；运行时 `desktop-pet` 由沙箱提供）。

内置示例：

| 插件 | 作用 |
| --- | --- |
| `hello-plugin` | 监听 `pet:click` / `animation:end` / `state:change`，统计点击数（持久化），每 5 次点击请求播放 `talk` |
| `random-action-plugin` | 定时在空闲时随机请求一个动画（走 `actions.execute`），验证 Action Pipeline 与优先级裁决 |

---

## 9. 鼠标互动

- **命中区域**：`InteractionManager` 把归一化坐标映射为 `head / face / ear / body / belly / skirt / legs / tail / outside`，可通过 `regions` 参数调整分区；
- **点击** → `pet:click` 事件 + Action（按区域选择动画：头部 `cute`、耳朵/尾巴 `fawning`、身体/腿 `stroke`）；
- **双击** → `pet:double-click` → `play`；
- **右键** → 原生上下文菜单（显示当前区域、当前动画、插件列表、显示/隐藏、暂停行为、重载插件、打开配置目录、设置、退出）；
- **拖动** → 超过 5px 阈值才判定为拖动，通过 IPC 移动窗口；长按（>900ms）不视为点击；窗口位置会被约束至少保留 60px 可见。

---

## 10. 行为系统

`BehaviorManager` **只产生 Action Request**，绝不直接播放视频：

```ts
{ type: 'animation', animationId: 'lie', priority: 10, reason: 'random-idle-action:idle-lie' }
```

### 当前阶段的范围（重要）

按需求，**当前只做「idle 循环 + 点击反应动画」**。
因此所有会「自动播放动画」的行为都设置为 `enabled: false`：

| 行为 | 间隔 | 当前状态 | 说明 |
| --- | --- | --- | --- |
| `idle-fidget` | 22–48s | ⏸ 关闭 | 随机小动作（`cute`） |
| `idle-lie` | 60–150s | ⏸ 关闭 | 趴下休息（`lie`） |
| `idle-work` | 90–200s | ⏸ 关闭 | 工作（`work`） |
| `idle-timeout-sleep` | 5 分钟无互动 | ⏸ 关闭 | 睡觉（`sleep`） |

结果：桌宠平时只会**循环播放 idle**，只有用户点击时才播放反应动画。
调度、冷却、优先级抢占的实现都完整保留着 —— 想启用某个自动行为，把
`DEFAULT_BEHAVIORS` 里对应条目的 `enabled` 改成 `true` 即可，不需要改其它代码。

另有全局冷却，避免多个行为同时触发互相抢占；托盘「暂停行为」会同步暂停行为系统与插件随机动作。

### 关于「眨眼」（功能已整体移除）

第一版素材没有真实眨眼帧，早期用「CSS 遮罩 + `transform: scaleY(0.99)`」硬凑过一个闭眼效果，
后来又被改成"只切状态、不做任何视觉表现"。这两个版本都已**整体删除**：

- `src/renderer/core/blink-controller.ts` 已删除；
- 状态机的 `BLINKING` 状态及其迁移已删除（现为 `IDLE` / `PLAYING` / `SLEEPING` / `BUSY`）；
- `DEFAULT_BEHAVIORS` 里的 `blink` 行为、`pet:blink` 事件、`pet-overlay` 叠加层
  以及 `.blinking` 样式全部移除；
- 占位素材 `assets/idle/open.png` / `closed.png` 与 Manifest 里的
  `blink-open` / `blink-closed` 条目一并删除。

`#pet-image` 图层保留：它现在服务的是 Manifest 中 `type: "image"` 的静态动画条目，
与眨眼无关。

---

## 11. 未来 AI Agent 接口

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

---

## 12. 日志

统一 Logger，格式一致（Main 与 Renderer 输出到同一处）：

```text
[12:31:20] [AnimationManager] play coffee
[12:31:24] [AnimationManager] ended coffee
[12:31:24] [StateMachine] PLAYING -> IDLE
[12:31:30] [PluginManager] activated hello-plugin
```

- 级别：`debug` / `info` / `warn` / `error`，`--dev` 或 `--debug` 开启 debug；
- Main 进程同时写入文件：`%APPDATA%\DesktopPet\logs\desktop-pet.log`（超过 1MB 自动轮转，保留 2 份）；
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

---

## 15. 验收

自动化端到端验收（真实启动桌宠，注入检查脚本）：

```bash
npm run build
npm run acceptance          # 等价于 electron tools/acceptance.cjs
```

结果写入 `build/acceptance.json`，当前覆盖 **113 项检查，全部通过**：

| 分组 | 覆盖内容 |
| --- | --- |
| 窗口 | 创建、不可缩放、始终置顶、可见 |
| 进程隔离 | 无 require / process / module / Buffer、未暴露 ipcRenderer 与通用 invoke、petAPI 与 bootstrap 已注入 |
| 运行时状态 | petApp 挂载、idle 兜底在播、状态机 PLAYING、18 个动画注册、2 个插件加载 |
| 媒体与透明素材 | WebM 解码、正在播放、loop、自定义协议加载、视频层为可见主渲染层、**未使用混合模式抠图**、四角 alpha=0、**角色区域 44% 完全不透明**、存在半透明软边 |
| 切换不闪烁 | 视频层使用双缓冲、切换动画期间 **0 个无纹理帧 / 0 个空画面帧 / 视频层不消失** |
| idle 循环 | loop 属性、时间轴持续前进、**跨越片尾回到开头**、循环期间不触发 `animation:end` |
| 点击后恢复循环 | 点击播放反应动画 → 结束后状态回 IDLE → **自动接回 idle 并继续循环** |
| 不变形 | 长按 1.5s 画面尺寸恒定、无 `transform` 形变、`object-fit: contain`、**眨眼叠加层已移除（台面只剩 2 video + 1 img）**、静态图片图层保留 |
| 尺寸可调 | 读取设置、60% / 130% 生效、越界夹取（2.5 / 0.2）、恢复 100%、窗口实际尺寸随设置变化、置顶可读写 |
| 设置窗口 | 可打开、滚动条为 `range` 且范围覆盖 20%–250%、已注入 `settingsAPI`、**拿不到桌宠 `petAPI`**、回显当前比例、拖动后比例写入 `settings.json` 且真实改变桌宠尺寸、置顶开关生效、关闭后桌宠存活、**验收结束自动还原用户设置** |
| 优先级 | 低优先级播放、高优先级抢占、同优先级拒绝、`interruptible:false` 拒绝抢占、冷却生效、**冷却期内手动播放仍可播放（bomb 可重复试放）而自动化来源被冷却拦住** |
| Action Pipeline | animation / state / event 三类走通、重复状态与非法状态被拒绝、未注册动画与非法 Action 被拒绝 |
| 状态机 | 动画开始联动 PLAYING、动画结束自动回 IDLE、5 个状态、白名单迁移、拒绝未知状态、迁移历史 |
| EventBus | on / off / once、同步与异步监听器异常隔离 |
| 插件 | 两个示例插件激活、插件监听事件（点击计数持久化）、插件请求动画、activate 抛错隔离、handler 抛错隔离、异常后主程序存活 |
| 系统集成 | 托盘创建、右键菜单调用 |

手动验证清单（无法自动断言的部分）：

- [ ] 桌宠画面背景确实是透明的（不是黑块 / 白块），且**角色本身是实心的**（不发虚、不透）；
- [ ] 桌宠在没有任何操作时**一直在循环播放 idle**（不会播完停住）；
- [ ] 长按 / 按住拖动时画面**不变形**（不压扁、不拉伸）；
- [ ] 从托盘/右键菜单调整「桌宠大小」，桌宠原地缩放且右下角不跳；
- [ ] 重启程序后尺寸设置被记住；
- [ ] 拖动桌宠跟手，且拖到屏幕边缘不会完全消失；
- [ ] 托盘图标显示正常，菜单项点击有反应；
- [ ] 右键菜单显示正确的「点击区域 / 当前动画」；
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
