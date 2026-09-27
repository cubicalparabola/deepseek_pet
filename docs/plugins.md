# 插件系统（能力、权限、随时关闭）

> 这份文档回答三件事：**现在有哪些插件**、**想做的插件需要什么接口（够不够）**、
> **怎么把一个插件随时关掉**。系统架构与沙箱实现见 [`README.md` 第 8 节](../README.md#8-插件系统)。

---

## 1. 目前的插件

随包**只有一个**：`plugins.json` 里登记的 `todo-plugin`（待办清单，`enabled: true`）。

| 插件 | 目录 | 作用 |
| --- | --- | --- |
| `todo-plugin` | `plugins/todo-plugin` | 输入**时间 + 事件** → 到点由桌宠提醒（气泡 + 系统通知 + `remind` 动画）；随时打勾 / 恢复 / 推迟 10 分钟 / 删除；可把清单导出到「交互」收件箱。权限：`ui` `notify` `mail` |

它是**第一个真插件**，也是"接口够不够用"的活证据 —— 主程序一行没改。
用法：托盘/右键 →「插件」→「看待办清单…」（标签上带未完成条数），
或者聊天窗口里那个「待办清单」页签。

原先随包的两个示例（`hello-plugin` / `random-action-plugin`）已按需**卸载并删除** ——
它们的用途只是验证链路，而随机动画本来就是核心 `BehaviorManager` 在做（README §10）。

其余插件由用户装进来（见 §6）：

```text
设置窗口 →「插件」→「安装插件…」→ 选一个插件文件夹 → 立刻启用
```

验收脚本也这么干：它跑的时候临时装两个探针插件
（`build/acceptance-fixtures/` 下的 `click-probe` / `plain-probe`）与一个
`mail-probe`，跑完连同目录一起卸干净；另外它还会**真点**待办面板，
验证"输入时间与事件 → 到点冒泡提醒 → 打勾 → 删除"整条链路。

---

## 2. 权限模型：插件要碰系统，必须先声明

权限写在**插件自己的 `package.json`**（静态可读，不必先执行插件代码）：

```json
{
  "name": "pomodoro-plugin",
  "displayName": "番茄钟",
  "version": "0.1.0",
  "main": "index.ts",
  "permissions": ["notify", "ui"]
}
```

| 权限 | 打开的接口 | 谁用得上 |
| --- | --- | --- |
| `net` | `context.net.request / json`（主进程代发 HTTP(S)） | 搜索网页、新闻、论文、GitHub |
| `process` | `context.process.run / which`（`shell: false` 起本机命令） | 调用外部工具（git、ffmpeg…） |
| `python` | `context.python.available / run` | 调用 Python |
| `notify` | `context.notify.send / onClick` | 番茄钟、TODO 提醒、新闻推送 |
| `ui` | `context.ui.*`、`context.system.openExternal` | TODO / 课程表 / 番茄钟的界面与菜单入口 |
| `mail` | `context.mail.send`：把消息与文件投递到「交互」收件箱 | 会**生成文件**的插件（导出清单、抓下来的 PDF、Python 画出来的图） |

三条规则：

1. **执法点在主进程**（`src/main/plugin-runtime.ts`）。渲染层也会先给一次可读的拒绝原因，
   但"有没有权限"的真相只在 Main —— 改渲染层的代码越不了权。
2. **用户可以在 `plugins.json` 里收窄**（只减不增）：`{"id":"x","permissions":["notify"]}`
   表示"这个插件留着，但先不给它联网"。设置窗口会把"声明了但被你收窄掉"的权限画成虚线。
3. **停用 = 权限全部收回**：`PluginManager.getEffectivePermissions()` 对停用的插件直接返回空数组，
   残留的异步回调再去调系统能力同样会被拒绝。

---

## 3. 插件能拿到的全部接口

```ts
context.events      // on / once / off / emit（桌宠事件总线）
context.animations  // play / stop / isPlaying / getCurrent / getDefinition / list / register
context.state       // get / is / onChange / list（只读）
context.actions     // execute(PetAction) —— 与 AI 共用同一条 Action Pipeline
context.behavior    // pause / resume / isPaused
context.storage     // get / set / remove / keys（按插件命名空间隔离）
context.system      // getVersion / getPlatform / showNotification / log / openExternal
context.logger      // debug / info / warn / error（自动带 Plugin:<id> 前缀）
context.plugin      // { id, name, version, description?, author? }
context.pluginDir   // 相对 plugins/ 的目录标识（不是文件系统句柄）

/* 本轮新增：生命周期与系统能力 */
context.lifecycle   // permissions / has(permission) / onDispose(fn)
context.timers      // after / every / cancel      —— 主进程计时，停用即清表
context.net         // request / json              —— 权限 net
context.process     // run / which                 —— 权限 process
context.python      // available / run             —— 权限 python
context.notify      // send / onClick              —— 权限 notify
context.mail        // send(主题 + 正文 + 附件)      —— 权限 mail（投递到「交互」收件箱）
context.ui          // registerMenuItem / updateMenuItem / registerPanel / updatePanel / say / openPanel
```

插件**拿不到**：`window`、`document`、`fetch`、`XMLHttpRequest`、`WebSocket`、`localStorage`、
`process`、`require`（除虚拟模块 `desktop-pet`）、`ipcRenderer`、`window.petAPI`、Electron / Node 的一切。
这些名字在沙箱模块体里被显式声明为 `undefined`（CSP 的 `script-src 'self' blob:` 又堵死了
`eval` / `new Function` 这类绕路），所以**系统能力只有 `context` 一条路**，权限才真的可执法。
桌宠窗口还额外拦了 `will-navigate` / `window.open`（见 `src/main/window-manager.ts`）。

---

## 4. 八个插件想法的接口核实

结论先行：**八个都不缺接口**；其中三处"想做得更好"的能力已按下面的说明留出位置（§5）。

| 想做的插件 | 需要什么 | 用哪些接口 | 够不够 |
| --- | --- | --- | --- |
| **TODO** | 持久化列表、界面、到期提醒、定时检查 | `storage` + `ui.registerPanel`（列表/勾选/输入框）+ `notify.send` + `timers.every` | ✅ 够 |
| **课程表** | 表格界面、按星期/时间提醒、可选联网导入 | `ui.registerPanel`（table 已放行）+ `timers.after/every` + `notify` + `net`（抓 `.ics` 由插件自己解析） | ✅ 够（本地文件导入见 §5.1） |
| **管理 GitHub** | 带 Token 的 HTTPS、看 issue/PR、打开链接、可选 git 命令 | `net`（自定义 headers 放 Token）+ `ui.registerPanel` + `system.openExternal`（面板里的 `<a href>` 会被宿主代开）+ `process`（`git` CLI）+ `storage`（存 Token） | ✅ 够（Token 明文问题见 §5.2） |
| **查找论文** | arXiv / Crossref 查询、结果列表、打开 PDF 链接 | `net.json` + `ui.registerPanel` + `@open-external` | ✅ 够 |
| **搜索网页** | 任意搜索 API / 引擎 HTML | `net.request`（默认 15s 超时、2MB 上限、可调） | ✅ 够 |
| **新闻获取** | 定时轮询 + 新条目提醒 | `net` + `timers.every`（**主进程计时**，窗口隐藏也不会被降频）+ `notify` + `ui.say` | ✅ 够 |
| **调用 Python** | 探测解释器、执行脚本、传参/传 stdin、拿 stdout | `python.available`（按 `python3` → `python` → `py -3` 探测并缓存）+ `python.run`（`script` 代码或插件目录内的 `.py`；`args` / `stdin` / `timeoutMs` / `maxOutputBytes`） | ✅ 够 |
| **番茄钟** | 精确计时、到点提醒、开始/暂停入口、进度展示、演动画 | `timers` + `notify.send/onClick` + `ui.registerMenuItem`（含 `checked` 复选态）+ `ui.updatePanel`（进度条）+ `animations.play` + `lifecycle.onDispose` | ✅ 够 |
| **插件生成文件后交给用户** | 把生成的内容（文本 / 二进制）连同一条说明放进用户的收件箱 | `mail.send({ subject, body, attachments })`（权限 `mail`） | ✅ 够（见 §4.1） |

### 4.1 插件生成的文件怎么给用户（`mail`，2026-09 新增）

需求原文："宠物可能在插件中生成文件然后保存到这里" —— 插件拿不到文件系统，
所以**内容以字符串交上来**（文本用 `utf8`、二进制用 `base64`），主进程负责写盘：

```ts
const result = await context.mail.send({
  subject: '今日待办导出',
  body: '这是按你的清单导出的 Markdown。',
  attachments: [
    { name: 'todo.md', content: markdown },                       // 文本
    { name: 'chart.png', content: base64Png, encoding: 'base64' }, // 二进制
  ],
});
// result: { ok, messageId?, files: [{ name, size }], error? }
```

约束与行为：

| 规则 | 说明 |
| --- | --- |
| 权限 | 必须在 `package.json` 里声明 `mail`，否则拒绝（执法在 Main，和联网/起进程同一条路） |
| 数量与体积 | 最多 5 个附件、每个解码后 ≤ 4MB；主题 ≤ 60 字、正文 ≤ 2000 字 |
| 文件名 | 经 `safeFileName` 清洗（去掉路径分隔符与保留字符），同名会**覆盖**上一次的同名附件 |
| 收件箱里的样子 | 一条消息：**发件人 = 插件名**、主题、正文、附件（可查看 / 打开 / 删附件）；未读徽标会亮 |
| 删除 | 删掉那条消息会**连同附件一起删**（邮件语义）；附件被别的消息引用时保留 |
| 读 | **不给**：插件只能投递，读收件箱是用户的界面（最小权限） |

> 「交互」窗口现在是**邮件式收件箱**：纸条早已并入它，文件也以附件的身份挂在消息下面
> （原来那个独立的「文件」页签已经删掉）。没有归属的文件会出现在一封虚拟的
> 「未归档的文件」里，不会被藏起来。

几个"够用"的关键细节（都是这一轮特意补上的）：

- **精确计时**：`context.timers` 的定时器由 **Main** 持有。渲染层的 `setTimeout` 在窗口隐藏时会被
  Chromium 降频到分钟级，番茄钟与新闻轮询会因此失准；而且停用插件时 Main 能直接清表，
  不依赖"渲染层还活着"。
- **面板里的交互不需要写脚本**：`data-plugin-action="id"` 的按钮 + `data-plugin-field="name"`
  的输入控件；点一下就把**整个面板的字段快照**回传给插件，插件返回新 HTML 即刷新。
- **打开链接**：面板里的 `<a href="https://…">` 由宿主走保留动作 `@open-external` 交给系统浏览器
  （页面自身不导航 —— 聊天窗口的 CSP 与 `will-navigate` 都不允许）。
- **输出上限**：`net` 默认 2MB（上限 8MB）、`process` / `python` 单路输出默认 256KB（上限 4MB）、
  超时默认 15s / 20s，都会被截断并置 `truncated`，插件据此提示用户而不是把桌宠拖垮。
- **子进程回收**：插件起的每个子进程都登记在 `PluginRuntime` 里，停用插件时**全部杀掉**，
  退出程序时也会清一遍（不留孤儿 python）。

---

## 5. 已经留出接口、但这一轮没有实现的能力

这三件事目前的接口**能凑合**，但不是理想形态；写插件时按下面的方式绕开，等接口补齐再切换。

### 5.1 `context.fs`（插件自己的文件读写）—— 未实现

课程表想把 `.ics` 导进来、TODO 想导出 Markdown 时会需要它。现在只有 `context.storage`
（浏览器 localStorage，几百 KB 级别，适合结构化小数据）。

**留出的形态**（写插件时可以把这部分隔离在一个小模块里，将来替换）：
`context.fs.readText/writeText/list/remove`，路径限制在 `data/plugins/<id>/` 与插件自身目录，
权限名建议 `files`。**当前替代方案**：让用户把文件拖进「小纸条 → 文件」，插件读不到，
所以这一条确实是缺口 —— 请把大文件需求先记在这里，不要用 `process`/`python` 去读磁盘绕开它。

### 5.2 `context.secrets`（密钥安全存储）—— 未实现

GitHub Token、搜索 API Key 现在只能用 `context.storage` 存，也就是**明文放在应用 profile 的
localStorage 里**（和"密钥不进渲染进程"的 AI 那条链路不是一个安全等级）。

**留出的形态**：`context.secrets.get/set/remove`，由 Main 落盘到 `data/plugins/<id>/secrets.json`
（或接 Electron `safeStorage` 加密），权限名建议 `secrets`。在它实现之前：**不要把高价值 Token
交给插件**，用只读、可随时吊销的细粒度 Token。

### 5.3 面板里的脚本与草稿 —— 有意不做

- 面板只接受**被净化的 HTML**（`src/shared/plugin-panel-html.ts`），没有 `<script>`。这是安全取舍：
  面板里的内容常常是插件刚从网上取回的远程数据。要"活"的界面，用 `data-plugin-action` +
  `updatePanel` 重画。
- 面板每次切回页签都按插件给的 HTML 重画，**未提交的输入框内容会丢**。想保留草稿的插件，
  要把当前值写进 HTML（或在 `onAction` 里落盘后再重画）。

---

## 6. 安装与卸载

### 6.1 界面入口

设置窗口 →「插件」面板：

| 操作 | 位置 | 做了什么 |
| --- | --- | --- |
| **安装插件…** | 面板顶部按钮 | 弹原生**目录选择框** → 校验 → 复制进 `plugins/<id>/` → 登记 `plugins.json`（`enabled: true`）→ 立刻启用 |
| **卸载** | 每张卡片右下角（只对 `removable` 的插件显示） | 二次确认 → 停用（连带回收）→ 删除 `plugins/<id>/` → 从清单移除 → 清掉它的存储 |
| 重新发现插件 | 面板顶部按钮 | 重新读 `plugins.json` 与插件目录（手改过配置时用） |
| 启用 / 停用 | 卡片开关 / 托盘「插件」子菜单 | 见 §7（随时关闭） |

内置/随包插件（`path` 带层级的，例如 `vendor/xxx`）显示「内置示例（不可卸载）」而不是卸载按钮 ——
它们随程序一起发布，删掉会破坏随包内容。

### 6.2 手装与手删（不经过界面）

插件系统的"真相"就是目录 + 一份清单，所以手动装同样有效：

```text
1. 把插件文件夹放进 plugins/<插件 id>/
   （放在 plugins/ 根下一层最省事；带层级的路径也可以，由 plugins.json 的 path 指定）
2. 在 assets/config/plugins.json 的 plugins 数组里加一条：
   { "id": "<插件 id>", "path": "<id>", "enabled": true }
3. 设置窗口 →「插件」→ 重新发现插件（或重启）
```

卸载 = 反过来：先停用，再删目录，再从 `plugins.json` 里删掉那条。
**目录名（或 `path`）没有 `/` 的插件才算"可卸载"**（就是 `plugins/` 根下一层）；
`vendor/xxx` 这类带层级的会被卸载按钮拒绝（见 §6.4）。

### 6.3 安装时到底校验了什么

安装逻辑在 `src/main/plugin-installer.ts`（唯一会写插件目录的地方）：

| 检查 | 拒绝时的提示 |
| --- | --- |
| 源目录存在、是文件夹、且不在 `plugins/` 里面 | 「文件夹不存在」/「请选择一个文件夹」/「已经在插件目录里了」 |
| 有 `package.json` 且是合法 JSON 对象 | 「这个文件夹里没有 package.json，看起来不是一个插件」 |
| 插件 id 合法（`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，取自 `package.json.name`，缺失时用文件夹名） | 「插件 id 不合法…（它会成为目录名）」 |
| 入口能解析出来（`main` 或与发现器共用的候选表） | 「没有找到插件入口」 |
| ≤ 2000 个文件、≤ 64MB | 「文件太多/体积太大，这不像是一个插件」 |
| 目标目录不存在，或存在但属于**用户安装的**插件（= 升级） | 「已经存在同名插件，它不是可以覆盖的安装目录」 |

复制时跳过 `node_modules` / `.git` / `.vscode` / `__pycache__` / `.venv` 等，
并**不复制符号链接**（可能指向插件目录之外）。

### 6.4 卸载时的顺序（为什么不能反）

```text
停用（写盘 enabled:false -> 渲染层退订事件、取消定时器 -> Main revoke：杀子进程、清定时器、下线菜单与面板）
   ↓
删除 plugins/<id>/        ← 必须在杀子进程之后：Windows 上子进程的工作目录还在里面就删不掉
   ↓
从 plugins.json 移除该条 -> 重新发现 -> 通知渲染层忘掉它并清 localStorage（+ data/plugins/<id>/）
```

删目录失败（被占用、权限不足）时，插件会被**放回停用前的状态**并原话报错 ——
"点了一下卸载，插件反而被停了"是不能接受的。

### 6.5 标准目录结构

```text
plugins/<插件 id>/
├── package.json     # 必需：name（决定 id）/ displayName / version / main / permissions
├── index.ts | index.js   # 入口（.ts 由 esbuild 运行时编译；打包运行时读 dist/plugins 预编译产物）
└── …                # 插件自己的资源（脚本、模板、数据文件）
```

```json
{
  "name": "pomodoro-plugin",
  "displayName": "番茄钟",
  "version": "0.1.0",
  "description": "25 分钟计时 + 到点提醒",
  "author": "you",
  "main": "index.ts",
  "permissions": ["notify", "ui"]
}
```

> 还**没有**做的：从 `.zip` / URL 安装（需要解压与下载，属于另一件事）、
> 版本比对与升级提示、插件签名校验。留出的形状是"安装器只认一个已解压的目录"，
> 将来加解压/下载都只是往它前面接一步。

---

## 7. 怎么把插件随时关掉
三个入口，同一份实现（都落到 `PluginManager.setPluginEnabled`，写盘 + 现场回收）：

| 入口 | 位置 |
| --- | --- |
| 设置窗口 →「插件」面板 | 一行一个开关；旁边列出它声明的权限（被收窄的画虚线）；「重新发现插件」按钮 |
| 托盘 / 右键菜单 →「插件」 | 上半是插件自己注册的动作（番茄钟"开始/暂停"这类），下半是**可点的开关**（`●` 运行中 / `○` 已关闭） |
| 插件自己 | `context.ui` 只是入口，没有"自己关自己"的接口（防误触）；真要退出请让用户点开关 |

关掉一个插件时**按顺序**发生这些事（`PluginHost.disablePlugin` + `PluginRuntime.revoke`）：

```text
Main:   写回 plugins.json（enabled=false）
        收回权限（getEffectivePermissions -> []）
        清掉主进程定时器、杀掉它起的子进程、下线菜单项与面板快照
Renderer: 退订它的事件订阅
        取消渲染层侧定时器
        跑它登记的 lifecycle.onDispose 回调
        调它自己的 deactivate()
        状态标记为 inactive；聊天窗口的插件页签随之消失
```

两个刻意的顺序决定：

- **先回收 Main 侧资源，再通知渲染层**：即使渲染层卡住/崩了，权限与资源也已经收回。
- **先退订事件，最后才调 `deactivate()`**：插件在收尾过程中不该还能收到桌宠事件。

再次打开同一个插件 = 现场取代码 + `activate()`，不需要重启，也不影响别的插件
（整体「重载插件」会重新发现清单并把所有插件重来一遍，那是另一条路径）。

---

## 8. 面板协议速查（给将来写 UI 的插件）

```ts
context.ui.registerPanel({
  id: 'todo',
  title: '待办',
  html: `
    <ul class="todo">…</ul>
    <input data-plugin-field="text" placeholder="加一条" />
    <button data-plugin-action="add" data-plugin-value="high">高优先级</button>
    <button data-plugin-action="add">加</button>
  `,
  async onAction({ actionId, fields }) {
    if (actionId === 'add') {
      addItem(fields.text, fields.value === 'high');   // fields 是**整面板**的快照
      return renderHtml();                             // 返回新 HTML 即刷新
    }
  },
});
```

- `data-plugin-action="<id>"`：点击 -> `onAction({ panelId, actionId, fields })`。
- `data-plugin-field="<name>"`：值随动作一起回传（checkbox/radio 为 `'1'` / `'0'`）。
- `data-plugin-value="<v>"`：按钮自带的值，合并到 `fields.value`（不覆盖同名输入框）。
- 面板里可以用的标签/属性见 `src/shared/plugin-panel-html.ts` 的允许清单；`class` 与内联 `style`
  可用（进度条这类展示靠它），`id` / `for` / `script` / `on*` / 非 `data:` 图片 / 非 http(s) 链接一律剔除。
- 面板渲染在**聊天窗口**的插件页签里（普通窗口、能滚动、能打字），桌宠窗口放不下这些内容。
