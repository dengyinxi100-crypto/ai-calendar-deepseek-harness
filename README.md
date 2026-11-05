# dsh-ai-calendar

把 **「AI 智能日历」** 嵌进 [DeepSeek Harness](https://github.com/deepseek-ai) 的插件：侧栏多一个「日历」面板，主区域内嵌完整日历界面；同时给 Agent 注册一组日历工具，并挂一个可拖拽 / 可缩放的定时任务浮窗。

日历自己的多模型 AI 助手被替换成 **Harness 已配置的 DeepSeek 路由**——不额外填 key，直接用你 Harness 里的模型，按 token 计费。

---

## 功能

### 侧栏面板

- 侧栏出现「日历」入口，未完成任务数以小徽标显示
- 点击后主区域嵌入完整日历（月视图 / 时间线 / 任务看板 / 日志）
- 面板顶部显示当日消耗：`DeepSeek API · 付费 · 今日 ¥0.0000 / 0 tok`，悬停可看总计、调用次数、输入输出 token

### 定时任务浮窗

- 挂在 Harness 页面左下角，**可拖动、可拖拽右下角缩放**，位置和尺寸会记住
- 显示：到点提醒（红色强调条 + 「到点」胶囊）、接下来 4 条提醒、未完成任务数
- 点条目直接跳到日历面板
- 视觉沿用应用自己的任务卡（白底 / `#2D3036` 文字 / 16px 圆角 / 柔和投影）
- 提醒到点自动弹出并高亮 2.6 秒；`×` 或日历「主题设置 → 悬浮窗」开关都能关掉
- 不依赖日历面板是否打开：只要 Harness 开着就每 15 秒轮询一次

### Agent 工具

| 工具 | 作用 |
| --- | --- |
| `calendar_status` | 后端状态、端口、数据路径、记录总数 |
| `calendar_list_logs` | 按日期区间 / 是否周期 / 是否任务查询 |
| `calendar_create_log` | 新建日志或任务 |
| `calendar_update_log` | 修改已有记录 |
| `calendar_delete_log` | 删除记录 |
| `calendar_summarize` | 读真实日志后让 DeepSeek 生成中文总结 |

### AI 接管

- `/api/ai/chat`：把用户消息连同**数据库摘要**（总量 + 今天 / 之后 + 最近记录含 id）一起喂给模型
- 模型返回 `{"reply": "...", "ops": [...]}`，插件真的执行 create / update / delete，再按执行结果回一句人话
- 回复下方一行淡灰色标注：`模型 deepseek-official/deepseek-flash · 入 N / 出 M tokens · ¥0.0000`
- 不显示 SQL、不显示 provider id、不显示技术细节

---

## 要求

- **Node.js ≥ 20**
- DeepSeek Harness（含 Web GUI）
- 能编译或下载 `better-sqlite3` 的平台（Windows / macOS / Linux 主流版本都有预编译包）

## 安装

### 方式一：Harness 插件管理

在 Harness 的「插件」里安装本包（npm 包名 `dsh-ai-calendar`，或 git 地址）：

```
dsh-ai-calendar
```

或本地目录：

```
file:F:/path/to/dsh-ai-calendar
```

### 方式二：手动装进 profile

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-ai-calendar
```

然后确认 `package.json` 的 `dsh.profile.bundles` 里包含 `dsh-ai-calendar`。

### 安装后

**重启一次 DeepSeek Harness**，侧栏就会出现「日历」。

> 宿主插件模块只在启动时加载一次，所以插件升级后必须重启 Harness 才会生效；client / shim 部分刷新页面即可。

---

## 配置

全部可选，通过环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_CALENDAR_ROOT` / `DSH_CALENDAR_APP_ROOT` | 包内 `rsc/` | 覆盖日历前端与后端所在目录（开发时指向源码项目） |
| `DSH_CALENDAR_PORT` | `3001` | 后端端口 |
| `DSH_CALENDAR_AI_MODEL` | 跟随 Harness 路由 | 强制指定模型名 |
| `DSH_CALENDAR_PRICE_INPUT_PER_M` | `2` | 输入单价（元 / 百万 token），仅用于估算显示 |
| `DSH_CALENDAR_PRICE_OUTPUT_PER_M` | `8` | 输出单价（元 / 百万 token） |

## 数据

- 日历数据存在后端 SQLite，默认在 `%APPDATA%` 下的应用数据目录
- Harness 侧的用量账本存在浏览器 `localStorage`（`dsh_ai_calendar_usage_v1`），按天累计、保留 30 天
- 诊断日志：`%TEMP%/dsh-ai-calendar/diag.log`

---

## 常见问题

**侧栏没有「日历」**
检查 profile 的 `dsh.profile.bundles` 是否包含 `dsh-ai-calendar`，然后重启 Harness。

**面板里空白**
多半是静态资源路径问题。插件会在响应时注入 `<base href="/dsh-calendar/app/">`，构建产物里不要自带 `<base href="/">`。

**提示「日历服务没能启动」**
端口 3001 被占用，或 `better-sqlite3` 原生模块没装好。装好后点「刷新」，或先手动跑：

```bash
node rsc/server/index.cjs
```

**改了日历源码但界面没变**
发布包内的 `rsc/` 是构建快照。重新构建应用后要同步：

```bash
node scripts/package-plugin.mjs   # 仅仓库内开发者可用
```

开发时也可以直接用 `DSH_CALENDAR_ROOT=F:/AI calendar` 指向源码项目。

**用量每次重启清零**
新版已改为 `localStorage` 账本，不再清零。若仍看到 0，请确认页面已刷新到最新 client 版本。

---

## 开发

插件本地开发时用到一些辅助脚本（按本机路径编写，**不进发布包、也不进仓库**）：

| 脚本 | 用途 |
| --- | --- |
| `scripts/smoke.mjs` | 宿主侧冒烟：路由、静态、代理、AI 接管、6 个工具 |
| `scripts/smoke-client.mjs` | 客户端契约 + 插槽注册 + SSR 渲染 |
| `scripts/package-plugin.mjs` | 把前端 `dist` 与 `server/index.cjs` 内嵌进 `rsc/` |
| `scripts/probe-*.mjs` / `verify-*.mjs` | 各类端到端探针 |

仓库里只有可发布的运行时文件；要重新构建内嵌资源，请用本地的 `package-plugin.mjs`，或用 `DSH_CALENDAR_ROOT` 指向源码项目。

