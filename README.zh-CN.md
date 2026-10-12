# wxBridage

[English](./README.md) | [简体中文](./README.zh-CN.md)

在微信里，继续你电脑上的 Codex 和 Claude Code 会话。

wxBridage 的核心功能是桌面会话共享：把微信接入电脑上已有的会话，沿用同一个对话、上下文和工作区。在微信发送的消息会进入所选会话；在电脑启动的任务，其可见输出也会同步到微信，方便离开电脑后继续跟进。

原始仓库：[Gan-Xing/CodexBridge](https://github.com/Gan-Xing/CodexBridge)。wxBridage 基于该项目修改和扩展，增加了 Codex 与 Claude Code 会话共享能力。

## 核心功能

- **共享已有会话**：在微信继续 Codex 桌面会话或 Claude Code 会话，保留原有历史和工作区。
- **先选择，再进入**：每页列出 10 个会话，明确选择后才进入共享；仅查看列表不会改变当前绑定。
- **手机跟进电脑任务**：同步可见进度和最终结果，每轮结束后单独通知完成状态与耗时，也支持跟进电脑端发起的任务。
- **退出后恢复自己的会话**：`/exit` 返回共享前的微信独立会话，原电脑会话及其中已提交的任务继续保留。
- **去重与重启恢复**：记录已确认的共享输出，服务重启或重连后跳过已确认发送的内容。
- **微信阅读报告**：回复中的本地报告链接会附带微信文件附件；Markdown 报告保留原格式和完整内容。

## 支持的共享会话

| 引擎 | 微信共享的对象 | 连接方式 |
| --- | --- | --- |
| Codex | Codex 桌面应用持有的已有会话 | 本地桌面 IPC，桌面端保持运行；Windows/WSL2 适配代码已实现，实机验收仍待完成。 |
| Claude（Claude Code） | 电脑上已有的交互式 Claude Code CLI 会话 | 在所选会话中启用本地 MCP Channel，启动器沿用原会话 ID。 |

这里的 Claude 支持具体指 **Claude Code 会话**；普通 Claude Desktop 应用的聊天会话暂不在此适配范围内。当前 Claude 共享通道依赖 Unix Socket 和用户归属检查，需要把桥接器与 Claude Code 运行在 macOS、Linux 或 WSL 中；原生 Windows 的 Claude 共享通道尚未实现。

## 在微信开始共享

连接微信并启用对应适配后，使用以下命令：

| 命令 | 作用 |
| --- | --- |
| `/enter` | 列出当前 Provider 可共享的会话，每页 10 个。 |
| `/enter codex` | 浏览 Codex 桌面会话。 |
| `/enter claude` | 浏览 Claude Code 会话。 |
| `/enter 2` | 进入当前列表第 2 个会话，后续消息发送到这个会话。 |
| `/next` / `/prev` | 下一页 / 上一页。 |
| `/status` | 查看当前 Provider、会话，以及“桌面共享”或“独立会话”状态。 |
| `/exit` | 退出共享，恢复之前的微信独立会话。 |

配置入口：[Codex 桌面共享](#codex-desktop-sharing) · [Claude Code 共享](#claude-code-session-sharing) · [Windows/WSL2 配置](#windows-wsl2-desktop-sharing)。

## 在微信打开本地报告

当助手的完整回复包含 `[分析报告](/项目目录/outputs/report.md)` 这类链接时，wxBridage 会另外发送微信文件附件。点击**文件附件**即可阅读：正文里的电脑本地链接本身仍不是网页地址。Markdown 报告保留 `.md` / `.markdown` 扩展名和原始字节内容，供微信客户端直接预览。PDF、TXT、CSV、Office 文档也保留原格式；支持的图片使用现有图片发送通道。原文件不被修改，也不会发布到公共网站。

独立会话与 Codex / Claude Code 共享会话均支持，包括电脑端发起的任务。附件在回复完成后发送，随后仍保留共享会话的结束及耗时通知。共享轮次已确认发送的附件在重连后会跳过。已有微信消息与 `/peek` 历史不会补发转换，需让助手重新发送报告。

自动发送仅限**所选会话工作目录内**可读取的普通文档，每轮最多 3 个、每个最多 25 MiB；若 `CODEXBRIDGE_MAX_OUTPUT_ARTIFACTS` / `CODEXBRIDGE_MAX_ARTIFACT_SIZE_BYTES` 设置更低，采用更低限制。隐藏文件、凭据文件、越出工作目录的路径和代码示例不自动发送；文件缺失、受限或上传失败会单独说明。文件路径必须能由桥接器所在系统读取，不会跨机器取文件或转换其他系统的路径。预览能力取决于微信客户端，必要时下载后选择“用其他应用打开”。

## 产品方向

- 以 **微信 + Codex / Claude Code 的桌面会话共享**为核心，优先做好进入、跟进和退出。
- 沿用所选会话已有的持有者、上下文、工作区和权限设置。
- 同时保留微信独立会话与显式选择的共享模式。

## 文档

- [核心架构](./docs/architecture/codexbridge-core-architecture.md)
- [macOS、Windows 和 Linux 平台适配架构](./docs/architecture/host-platform-adapters.md)
- [路线图 TODO](./docs/todo/roadmap.md)
- [Codex Native API TODO](./docs/todo/codex-native-api.md)
- [Codex Gateway TODO（已暂停）](./docs/todo/codex-gateway.md)
- [Mission Control TODO（已暂停）](./docs/todo/mission-control.md)
- [Mission Control 架构（历史参考）](./docs/architecture/mission-control.md)
- [微信斜杠命令参考](./docs/usage/weixin-slash-commands.md)
- [Claude Code 会话共享设计](./docs/design/claude-shared-sessions.md)
- [Windows/WSL2 共享及验证记录](./docs/design/windows-wsl-sharing-architecture.md)

## 仓库结构

```text
packages/
src/
  core/
  platforms/
  providers/
  runtime/
  store/
test/
docs/
```

## 项目状态

当前项目集中在以下方向：

1. 以 `微信 + Codex / Claude Code` 的桌面会话共享为产品中心
2. 优先保证会话连续性和输出送达，再考虑扩展更多后端和包
3. 将 `codex-gateway` 和 `mission-control` 保持为暂停状态
4. 仅保留 `codex-native-api` 作为未来选项，而不是当前工作流

目前已经实现的桥接能力包括：

- Codex 桌面会话与 Claude Code 会话共享，统一使用 `/enter`、`/status`、`/exit` 进入、查看和退出
- 跟进正在运行的共享任务、同步可见输出、发送结束耗时通知，并保存已确认输出以便重启恢复
- 面向微信的核心会话路由和斜杠命令，包括 `/helps`、`/status`、`/usage`、`/login`、`/stop`、`/review`、`/plan`、`/skills`、`/plugins`、`/automation`、`/weibo`、`/new`、`/uploads`、`/as`、`/log`、`/todo`、`/remind`、`/note`、`/provider`、`/models`、`/model`、`/personality`、`/instructions`、`/fast`、`/threads`、`/search`、`/next`、`/prev`、`/open`、`/enter`、`/exit`、`/peek`、`/rename`、`/permissions`、`/allow`、`/deny`、`/reconnect`、`/retry`、`/restart` 和 `/lang`
- `/open` 会重新绑定当前微信会话，并立即返回简短的最近对话预览，无需先调用 `/peek`
- 基于 JSON 文件的持久化桥接状态仓库
- 微信 iLink 兼容适配：配置加载、二维码账户状态复用、私聊消息标准化、长轮询、上下文令牌持久化、文本分段、文本和输入状态发送
- 用于微信独立 Codex 会话的 Profile 加载器及 Codex app-server 客户端/插件路径
- 微信运行时：把轮询事件交给共享协调器，并通过微信通道发送回复
- 面向非 OpenAI Chat Completions Provider 的 OpenAI-compatible Responses 适配器，支持压缩回退、SSE 转换、工具调用修复、Provider/模型能力规则及显式启用的在线测试

包工作流状态：

- `packages/codex-gateway`：暂停
- `packages/mission-control`：暂停
- `packages/codex-native-api`：仅为未来保留，目前暂停

## OpenAI-Compatible Provider 验证

在线 Provider 验证默认关闭，避免普通测试消耗 API 配额。

```bash
CODEXBRIDGE_TEST_LIVE_OPENAI_COMPATIBLE=1 pnpm exec tsx --test test/providers/openai_compatible/live_provider_smoke.test.ts
```

支持的测试环境变量：

```text
DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_DEFAULT_MODEL
MINIMAX_API_KEY / MINIMAX_BASE_URL / MINIMAX_MODEL
QWEN_API_KEY or DASHSCOPE_API_KEY / QWEN_BASE_URL / QWEN_MODEL
OPENROUTER_API_KEY / OPENROUTER_BASE_URL / OPENROUTER_MODEL
KIMI_API_KEY / KIMI_BASE_URL / KIMI_MODEL
GEMINI_API_KEY / GEMINI_BASE_URL / GEMINI_MODEL
IFLOW_API_KEY / IFLOW_BASE_URL / IFLOW_MODEL
```

本地 OpenAI-compatible 适配器暂未启用运行时 WebSocket，因为服务器还没有 upgrade handler。CLIProxyAPI 风格的 WebSocket 对话记录和工具调用修复逻辑已作为独立测试模块实现，后续启用时可以直接复用，避免重新引入记录损坏问题。

## 微信斜杠命令

微信桥接采用适合聊天场景的纯文本命令，而不是按钮界面。推荐入口：

```text
/helps
/h
/st
/login
/lg
/login list
/review
/rv
/review base main
/plan
/pl
/plan on
/skills
/sk
/skills search 新闻
/skills show 1
/plugins
/pg
/pg search 日记
/pg show 1
/auto
/auto add 每30分钟检查一次系统状态，有变化发送给我
/auto confirm
/auto list
/auto rename 1 晚间部署巡检
/auto del 1
/as 今天修复了 /pg search 日记召回太宽的问题 #wxBridage
/as 明天上午10点提醒我给王总回电话
/as ok
/as edit 把王总改成李总，时间改成明天上午11点
/log 今天测试微信桥接，发现插件搜索需要更高相关度
/todo 检查服务器磁盘空间
/todo done 1
/remind 每周一早上9点提醒我看项目进度
/note Notion 适合结构化日志，Google Drive 适合导出归档
/helps threads
/stop
/sp
/provider
/pd
/models
/ms
/model
/m
/model 1
/personality
/psn pragmatic
/instructions
/instructions edit
/fast
/fast off
/model gpt-5.4 xhigh
/model high
/threads
/th
/search bridge
/se bridge
/next
/nx
/prev
/pv
/open 2
/o 2
/peek 2
/pk 2
/rename 2 微信桥接排障
/rn 2 微信桥接排障
/model default
/lang
/permissions
/perm
/allow
/al
/allow 1
/allow 2
/deny
/dn
/retry
/rt
```

### `/models` 和 `/ms`

列出当前 Provider Profile 可用的模型。

```text
/models
/ms
```

### `/automation` 和 `/auto`

创建和管理定时后台任务，结果始终发回创建任务的同一个微信会话。

```text
/auto
/auto add 每30分钟检查一次系统状态，有变化发送给我
/auto add 每天早上7点调用 news skill 给我发送到微信
/auto add 工作日晚上6点检查部署状态，异常时通知我
/auto add 每天早上8点、中午13点、下午17点半，把待办事项整理后发到微信
/auto confirm
/auto edit 只把时间改成每小时，任务内容不变
/auto cancel
/weibo
/weibo top 10
/auto add 每5分钟把微博热搜前10条发给我
/auto list
/auto show 1
/auto pause 1
/auto resume 1
/auto rename 1 晚间部署巡检
/auto delete 1
/auto del 1
```

### `/as`、`/log`、`/todo`、`/remind` 和 `/note`

这些命令用于管理微信个人助理记录。`/as` 是日志、待办、提醒和笔记的自然语言入口：Codex 会判断消息是在创建记录，还是管理已有记录；只有 Provider 不可用时，才使用保守的本地关键词规则。需要强制指定分类时，可以直接使用 `/log`、`/todo`、`/remind` 或 `/note`。

```text
/as 今天修复了 /pg search 日记召回太宽的问题 #wxBridage
/as 明天上午10点提醒我给王总回电话
/as ok
/as 给王总回电话这件事已经完成了
/as ok
/as 修马桶发票已经拿回来了
/as edit 备注：还差医药发票不确定
/as ok
/log 今天测试微信桥接，发现插件搜索需要更高相关度
/todo 检查服务器磁盘空间
/todo done 1
/remind 每周一早上9点提醒我看项目进度
/note Notion 适合结构化日志，Google Drive 适合导出归档
```

`/as` 也可以用自然语言管理已有记录。Codex 会先把操作归类为创建、更新、完成、取消或归档；只有消息清楚指向同一件具体事项时才匹配已有记录，否则创建新记录。已有记录的变更会先生成待确认草稿，只有发送 `/as ok` 后才写入。使用 `/as edit <修改说明>` 调整草稿，或用 `/as cancel` 放弃草稿。

自然语言更新优先使用短生命周期的 Codex app-server 重写线程，由宿主 Codex 订阅完成“原记录 + 修改说明”的合并。基于 API Key 的 Agents SDK 仅在 Codex 标准化不可用时回退，本地规则是最后一级回退。

`/up` 可以预先暂存文件。如果最后发送 `/as`、`/log`、`/todo`、`/remind` 或 `/note`，暂存文件会归档到 `~/.codexbridge/assistant/attachments/YYYY/MM/DD/<recordId>/`，结构化记录保存在 `~/.codexbridge/runtime/assistant_records.json`。

边界：`/remind` 只负责通知，`/todo` 跟踪用户自己的工作，`/auto` 执行定时系统任务。

### `/plan` 和 `/pl`

查看或切换当前会话后续轮次的协作模式。

```text
/plan
/pl
/plan on
/plan off
```

`/plan on` 为当前桥接会话后续轮次启用原生 `plan` 模式，`/plan off` 恢复原生 `default` 模式。这是模式切换，不是审批流程。

OpenAI-compatible 运行时适配器：

- wxBridage 可以把非 OpenAI Provider 暴露成本地 Responses 适配器，同时让 Codex app-server 继续访问 Responses 形式的端点
- 适配器支持 `/responses/compact`、Chat Completions 转换、流错误映射、CLIProxyAPI 顶层流错误块、流读取失败封装、可配置的临时上游重试、Gemini `usageMetadata` 等 usage 回退、模型思考策略、CLIProxyAPI 风格的 payload 兼容、匹配规则、多模态能力和模型元数据
- DeepSeek、MiniMax、Qwen、OpenRouter、Kimi、Gemini 和 iFlow 使用 `providerKind: openai-compatible`，仅通过环境变量和能力预设区分，不各自实现独立插件类
- 模型能力目录遵循 CLIProxyAPI 的数据化方向：把 thinking、payload、工具、多模态、令牌上限等差异放在数据中，执行器保持通用
- 内置目录覆盖 Codex、DeepSeek、MiniMax、Qwen、iFlow、Kimi、OpenRouter、Gemini/AI Studio/Vertex、Claude 和 Antigravity；也可以用 `*_MODEL_CATALOG_PATH` 指向 CLIProxyAPI `models.json` 结构的目录文件
- 认证池、代理轮换、自定义 Provider Header 属于部署层职责，不进入通用适配器

运行时 Provider 示例：

```bash
DEEPSEEK_API_KEY=...
DEEPSEEK_DEFAULT_MODEL=deepseek-v4-flash

MINIMAX_API_KEY=...
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M2.7
MINIMAX_REQUEST_RETRY=2
MINIMAX_RETRY_STATUSES=429,503

KIMI_API_KEY=...
KIMI_BASE_URL=https://api.kimi.com/coding
KIMI_MODEL=kimi-k2

GEMINI_API_KEY=...
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
GEMINI_MODEL=gemini-2.5-pro

IFLOW_API_KEY=...
IFLOW_BASE_URL=https://apis.iflow.cn/v1
IFLOW_MODEL=qwen3-coder-plus

CODEX_COMPAT_PROVIDER_ID=custom
CODEX_COMPAT_API_KEY=...
CODEX_COMPAT_BASE_URL=https://provider.example/v1
CODEX_COMPAT_DEFAULT_MODEL=example-model
CODEX_COMPAT_CAPABILITIES=default # 或 deepseek/minimax/qwen/kimi/gemini/iflow/openrouter
CODEX_COMPAT_REQUEST_RETRY=2
```

### `/model` 和 `/m`

查看或切换后续轮次使用的模型。

```text
/model
/m
/model default
/model high
/model 1
/model 1 xhigh
/model gpt-5.4 xhigh
/model gpt-5.4
```

所有斜杠命令都支持命令级帮助参数：

```text
/threads -h
/open --help
/permissions -helps
```

推荐用法：

- 使用 `/helps` 发现命令
- 使用 `/login` 和 `/login list` 管理宿主 Codex 账户池，再用 `/login <序号>` 切换账户
- 使用 `/review`、`/review base <分支>` 或 `/review commit <SHA>` 运行原生 Codex 代码审查，不改变当前线程绑定
- 使用 `/plan on` 让后续轮次优先规划，使用 `/plan off` 恢复默认模式
- 使用 `/skills` 查看当前项目可见的 Skill，`/skills search <关键词>` 搜索，`/skills show <序号>` 查看详情
- 先用自然语言执行 `/auto add ...`，桥接器会生成草稿，发送 `/auto confirm` 后才创建任务
- 在微信中使用 `/threads` 和数字序号，不必复制原始线程 ID
- 使用 `/personality` 控制当前微信会话后续回复风格
- 使用 `/instructions` 管理当前 Codex 的 `AGENTS.md`
- 使用 `/lang zh-CN` 或 `/lang en` 切换当前微信会话语言
- Codex 在执行中请求审批时，使用 `/allow 1`、`/allow 2` 批准，或用 `/deny` 拒绝
- 中断后使用 `/retry`：它会先刷新当前 Codex 会话，再在同一线程中重试上一条请求
- 需要精确用法时，使用 `/helps <命令>`

完整命令说明见 [docs/usage/weixin-slash-commands.md](./docs/usage/weixin-slash-commands.md)。

## 验证

```bash
npm install
npm run typecheck
npm test
```

验证套件应当在 Linux、macOS 和 Windows 上通过。

`npm test` 是隔离的默认测试入口。它会在启动 `node --test` 前清除 `CODEXBRIDGE_AGENT_*`、`OPENAI_*`、`MINIMAX_API_KEY` 等在线 Provider 环境变量，避免宿主 Shell、CI 或服务管理器中的真实凭据影响单元测试和集成测试。

需要显式保留在线凭据并测试真实外部 Agent 时，使用：

```bash
npm run test:live-agent
```

`test:live-agent` 应与主测试套件分开，仅用于有意执行的在线 Provider 验证，不属于默认 `npm test` 门禁。

## 快速部署

wxBridage 当前以源代码仓库形式分发。根包保持 `private`，请克隆仓库后安装依赖，不要尝试把它作为 npm 包发布或安装。

配置示例沿用现有的 `CODEXBRIDGE_*` 环境变量和 `.codexbridge` 状态目录，按示例填写即可。

### 通用前置条件

- Node.js `>= 24`
- `npm`
- 使用 Codex 功能时，宿主机已经完成 Codex CLI 登录
- 共享 Claude 时，已安装并授权 Claude Code CLI，且已在所选会话中启用 Channel

克隆后建议先检查：

```bash
npm install
npm run typecheck
npm test
codex --version
```

如果尚未安装 Codex CLI：

```bash
npm install -g @openai/codex@latest --include=optional
codex --version
```

按 Codex 路径部署时，如果 `codex --version` 仍然失败，请先修复再继续下列命令。Claude Code 的会话和 Channel 配置见对应共享章节。

### Linux

```bash
npm install
npm run typecheck
npm test
npm run test:live-agent
codex --version
npm run weixin:login
npm run weixin:serve -- --cwd /absolute/path/to/workspace
```

长期运行请使用后文的服务管理器，不要依赖一直打开的终端窗口。

### Windows（首次启动）

在仓库根目录打开 PowerShell：

```powershell
npm install
npm run typecheck
npm test
npm run test:live-agent
codex --version
where codex
npm run weixin:login
npm run weixin:serve -- --cwd C:\absolute\path\to\workspace
```

如果 `PATH` 上有多个 Codex 启动入口，请显式设置原生可执行文件：

```powershell
$env:CODEX_REAL_BIN = (Get-Command codex.exe).Source
npm run weixin:serve -- --cwd C:\absolute\path\to\workspace
```

可选调试参数：

```powershell
$env:CODEXBRIDGE_DEBUG_WEIXIN = '1'
```

### 首次 Windows 部署后的加固

首次 Windows 启动暴露了四类平台问题，目前均已处理：

1. 命令发现：Provider 配置会直接解析 Windows 可执行文件，并优先选择原生 `codex.exe` / `.com`，而不是包装脚本。
2. Windows 启动包装：只有 `codex.cmd` 或 `codex.bat` 时，会通过 Windows Shell 命令行启动。
3. 启动诊断：Codex 无法启动时，会直接提示检查 `CODEX_REAL_BIN`、`codex.exe` 或 `codex.cmd`，而不是只留下 `spawn codex ENOENT`。
4. 线程落盘：Codex 会话文件短暂出现 `empty session file` 时会自动重试，不再直接把当前轮次判为失败。

### 运行时默认路径

- 状态目录：`~/.codexbridge`
- 微信账户文件：`~/.codexbridge/weixin/accounts/`
- 服务锁：`~/.codexbridge/runtime/weixin-serve.lock`
- Codex 默认认证文件：`~/.codex/auth.json`
- Codex 默认指令文件：`~/.codex/AGENTS.md`

### 微信运行检查清单

绑定微信账户只完成登录，真正回复消息还需要持续运行服务循环：

1. 执行 `npm run weixin:login`
2. 确认 `~/.codexbridge/weixin/accounts/` 下已有账户文件
3. 启动 `npm run weixin:serve`
4. 从微信发送 `/h` 或 `/status` 做冒烟测试
5. 保持进程运行，或安装后文的平台服务

### 故障排查

- 微信绑定后没有回复：确认 `weixin:serve` 仍在运行。二维码登录不会自动启动后台工作进程。
- 出现 `spawn codex ENOENT` 或无法启动 Codex：先运行 `codex --version`。Windows 上可把 `CODEX_REAL_BIN` 设置为 `codex.exe` 或 `codex.cmd` 的完整路径。
- 轮次已开始但没有最终回复：使用 `CODEXBRIDGE_DEBUG_WEIXIN=1` 检查日志。当前版本会自动重试短暂的 `empty session file`。
- 查看运行状态：账户状态在 `~/.codexbridge/weixin/accounts/`，当前服务锁在 `~/.codexbridge/runtime/weixin-serve.lock`。

## 媒体工具

图片标准化和视频缩略图通过项目依赖 `ffmpeg-static`、`ffprobe-static` 提供的 `ffmpeg` / `ffprobe` 执行。

解析顺序：

- `CODEXBRIDGE_FFMPEG_PATH` / `CODEXBRIDGE_FFPROBE_PATH`
- `FFMPEG_PATH` / `FFPROBE_PATH`
- 项目依赖附带的二进制文件
- 系统 `PATH`

通常无需手动全局安装 `ffmpeg`，即可在 Linux、macOS 和 Windows 上处理图片和视频。

## 微信登录

```bash
npm run weixin:login
```

启动微信桥接循环：

```bash
npm run weixin:serve
```

默认情况下，启动 `weixin:serve` 时所在目录就是新会话的共享工作目录。可以通过 `--cwd` 或 `CODEXBRIDGE_DEFAULT_CWD` 覆盖，也可以在微信中发送 `/new /absolute/path/to/project` 为特定会话重新绑定目录。

新安装的服务默认只允许白名单中的私聊用户，请先配置所有者的微信发送者 ID：

```bash
WEIXIN_DM_POLICY=allowlist
WEIXIN_ALLOWED_USERS=wxid_owner
```

首次配置时，可以临时启用 `CODEXBRIDGE_DEBUG_WEIXIN=1`，发送一条微信消息，然后从日志中的 `scope_not_allowed` 记录读取 `scopeId`。把它加入 `WEIXIN_ALLOWED_USERS` 后关闭调试并重启服务。仅在部署环境已有其他访问控制时，才建议显式使用 `WEIXIN_DM_POLICY=open`。旧的 `pairing` 值已不受支持，会按 `allowlist` 进行失败关闭。

<a id="codex-desktop-sharing"></a>

### 共享 Codex 桌面会话

微信会话可以显式进入已有的 Codex 桌面线程，通过桌面应用发送文字，而不是为同一线程启动第二个写入者。在服务环境文件中启用：

```bash
CODEXBRIDGE_CODEX_DESKTOP_SHARED_THREAD=1
```

重启 `weixin:serve` 后，在微信发送 `/enter`，每页列出 10 个桌面线程；发送 `/enter <序号>` 进入指定线程，使用 `/next`、`/prev` 翻页。仅执行 `/open` 不会自动启用桌面共享。

默认 `ipc` 模式通过桌面本地协调服务发现线程所有者，并把轮次提交给该桌面实例。桌面端继续使用自己的模型、权限和工作区设置；桥接器跟踪返回的轮次 ID，并把输出同步回微信。无需激活窗口或模拟回车键，桌面应用仍是唯一写入者，因此消息与回复都属于同一个 PC 线程。

只要桌面应用和桥接服务仍在运行，Mac 保持唤醒和联网，锁屏时也能继续发送消息。它不会解锁电脑或改变电源设置；需要操作已解锁桌面的任务仍可能阻塞。如果线程没有桌面所有者，请先在桌面应用中打开一次。桌面协调协议是内部版本化协议，桌面应用升级后可能需要同步升级桥接器。不兼容或没有所有者时会明确失败，不会自动切换 GUI 模式或启动第二个写入者。提交后发生超时或断开时，消息可能已经被接受，重发前请先检查线程。

发送 `/exit` 退出桌面线程。wxBridage 不会修改原桌面线程，而是恢复进入共享前绑定的微信独立线程；只有原独立线程不可用时才新建。共享回复仍在运行时也可以 `/exit`：已提交的任务会在原桌面线程继续，新消息会等待它完成，再进入独立线程。`/status` 会显示当前是“桌面共享”还是“独立会话”。

进入正在运行的桌面线程时，桥接器会附加只读输出观察器。未完成轮次和之后从桌面启动的轮次，其可见助手消息会按节流后的完整分段同步到微信，最后发送去重后的最终结果。已完成历史、推理和工具日志不会发送。观察器会在 `/exit`、绑定变化或服务关闭时停止，并会在服务重启后恢复已持久化的共享绑定。桌面线程忙碌时不会接受微信的第二条 Prompt。输出以桌面记录写入 rollout 日志为准，并非逐 Token 流式传输；退出瞬间已经在发送的消息仍可能到达。

每次共享回复结束后，微信会收到单独的完成通知，例如 `本轮回复已结束，耗时：2分15秒。`。耗时来自桌面轮次日志，包括在任务中途执行 `/enter` 之前已经发生的时间；它统计单次回复，而不是整个线程生命周期。中断和失败会使用对应状态；没有时间数据时会明确提示未记录。该行为同时适用于桌面发起和微信发起的共享回复。

0.1.25 起，共享进度约每 30 秒合并一次，在微信 UTF-8 长度限制内减少消息气泡；最终结果不受该等待窗口限制。`rc.129`、IP 地址等内容不会被随意截断。成功发送的分段、最终结果和完成通知会记录到状态目录下的 `runtime/desktop-sync-checkpoints.json`，重启或重连时会跳过已确认内容。该私有 Checkpoint 保存确认 Hash，必要时也保存每轮一批待重试进度的可见正文，以固定其发送内容和标识；按微信会话、桌面绑定和轮次隔离，最多保留最近 256 个轮次。如果微信已接收消息、但进程在本地确认落盘前崩溃，该条在途消息仍可能重复。

微信拒绝发送（包括持续 `-2`）或网络超时时，共享输出会留在队列中，每次失败返回后固定等 5 秒再次尝试，不设失败次数上限，也不依赖新消息、上下文更新或手机切回前台通知。共享文本由队列统一安排重试，不叠加通道内部的多轮退避；请求本身的耗时及通道发送排队仍可能延长实际间隔。接口恢复接受发送后自动续发积压。Codex 与 Claude Code 均支持，电脑和微信发起的共享轮次都适用。结束/耗时通知发送失败也会保留重试。读取会话记录失败会独立重连，每次发送使用最新保存的微信上下文令牌。成功确认后停止该条重试；`/exit`、切换绑定或停止服务会停止旧绑定的发送。

本机日志和[上游同类反馈](https://github.com/Tencent/openclaw-weixin/issues/81)显示，每次入站消息的回复上下文大约可发送 10 条消息。因此 wxBridage 会统计已确认的文本、命令回复、媒体及独立说明消息，限制进度最多用到前 7 条，预留最后 3 条。接近上限时，进度消息会附带一次提醒：发送 `/status` 可刷新上下文，不会向 AI 提交新任务。任务结束后优先发送结论，未发送的中间进度不再抢占额度，完整进度仍保留在桌面会话中。最终结果至少留一条额度给结束/耗时通知；结果过长时，通知会明确说明尚有内容待发，剩余结果保留到新上下文后补发。关联文件在结束通知后尝试发送。额度记录以 Hash 保存在私有的 `<accountsDir>/<accountId>.reply-budget.json` 中，重启不会清零；首次升级前已经消耗的远端额度无法回溯，收到新入站上下文后才能准确计数。本地预留造成的暂缓发送会由队列定时复查，不会用远端进度请求消耗预留额度。这能减少条数耗尽，但不能保证绕过令牌过期或其他微信侧限制。

上述自动恢复以微信接口重新接受发送为前提。持续返回 `-2` 不能直接等同于临时限流或手机切后台；也可能与会话上下文有关。0.1.23 起，允许会话的入站载荷即使不含可处理正文，也会先保存其中的新上下文并唤醒待发队列，不创建模型轮次。微信公开协议未保证切回前台会下发新上下文，因此不能承诺仅切前台就能解除服务端拒收。服务日志的 `weixin-delivery` 记录时间、返回码和不可逆关联摘要，不记录正文或原始令牌，用于区分队列未重试、持续拒收和已被接口接受三种情况。

`runtime/desktop-sync-outbox.json` 保存桥接器已收集到的可见输出，包括已结束但尚未送达的轮次，支持服务重启后恢复。这个本机私有文件包含待发送正文；按仅当前用户可读写的权限保存，每轮最终交付确认后清理。队列上限为 256 轮、每轮 1 MiB、合计 16 MiB；超限或落盘失败会报错，不静默丢弃。`/exit` 或切换共享绑定会取消旧绑定的积压输出。桥接器停止期间从未收集到的消息，不会从已完成历史补回。电脑和桥接器仍须联网运行；该机制不能绕过微信侧账号或发送限制。

微信快速参考：

```text
/enter：列出可选会话
/enter 2：进入第 2 个桌面会话
/status：查看当前是“桌面共享”还是“独立会话”
/exit：退出共享，原桌面会话保持不变，并退回微信自己的会话
```

当前限制：

- 支持原有 macOS 桌面共享，并新增下述 Windows/WSL2 适配；Windows/WSL 实机端到端验收仍待完成
- 桌面应用必须保持运行，并拥有选中的线程
- Mac 必须保持登录、唤醒和联网；IPC 支持锁屏，但休眠或退出登录后不能即时处理
- 桌面协调协议必须兼容（当前检查的桌面版本使用 owner discovery v1 和 follower start-turn v2）
- 支持纯文本和带微信转写文本的语音；图片、文件、视频和没有转写的语音会明确失败，不会回退到第二个写入者
- `/stop`、`/retry`、`/review`、`/compact`、`/goal` 和微信端审批暂时不能控制桌面拥有的轮次，请在桌面执行这些操作

`CODEXBRIDGE_CODEX_DESKTOP_TRANSPORT=ipc` 是默认值。可以用 `CODEXBRIDGE_CODEX_DESKTOP_IPC_SOCKET` 指定绝对 Socket 路径，否则使用 `$CODEX_HOME/ipc/ipc.sock`（或 `~/.codex/ipc/ipc.sock`）。Socket 及所在目录必须归当前用户所有，且其他用户不可写。

旧版桌面应用可以显式设置 `CODEXBRIDGE_CODEX_DESKTOP_TRANSPORT=gui`，使用旧的深层链接和回车键方式。该兼容模式要求 macOS 辅助功能权限及已解锁桌面；IPC 失败时绝不会自动切换到 GUI。GUI 可选参数为 `CODEXBRIDGE_CODEX_DESKTOP_APP_NAME` 和 `CODEXBRIDGE_CODEX_DESKTOP_SUBMIT_DELAY_MS`。两种模式都支持 `CODEXBRIDGE_CODEX_DESKTOP_POLL_INTERVAL_MS`、`CODEXBRIDGE_CODEX_DESKTOP_TIMEOUT_MS` 和 `CODEXBRIDGE_CODEX_DESKTOP_MAX_PROMPT_CHARS`；IPC 当前最多接受 16,000 字符。

<a id="windows-wsl2-desktop-sharing"></a>

### Windows 和 WSL2 桌面共享

0.1.17 新增 Windows 本地命名管道适配，WSL2 通过随仓库提供的 PowerShell 小助手连接。Windows Codex 桌面端必须保持运行，与助手使用同一个 Windows 用户，并持有所选会话。没有桌面持有者的普通 CLI 会话无法透明接管。目前已提供模拟连接和路由测试；Windows/WSL 桌面及锁屏微信往返仍需实机验收。

桥接器直接运行在 Windows 时，可以在 PowerShell 启动前配置；使用服务时，把对应的 `KEY=value` 写入服务环境文件：

~~~powershell
$env:CODEXBRIDGE_CODEX_DESKTOP_SHARED_THREAD = "1"
$env:CODEXBRIDGE_CODEX_DESKTOP_TRANSPORT = "ipc"
$env:CODEXBRIDGE_CODEX_DESKTOP_HOME = "$env:USERPROFILE\.codex"
$env:CODEXBRIDGE_CODEX_DESKTOP_HOST_ID = "local"
npm run weixin:serve
~~~

桥接器运行在 WSL2，目标是 **Windows 本地桌面会话**时：

~~~bash
export CODEXBRIDGE_CODEX_DESKTOP_SHARED_THREAD=1
export CODEXBRIDGE_CODEX_DESKTOP_TRANSPORT=ipc
export CODEXBRIDGE_CODEX_DESKTOP_HOME='/mnt/c/Users/Alice/.codex'
export CODEXBRIDGE_CODEX_DESKTOP_HOST_ID=local
npm run weixin:serve
~~~

把 Alice 和挂载路径换成实际值。目标是 **Windows 桌面端持有的 WSL Agent 会话**时，改成该 Agent 实际使用的目录和准确发行版主机，例如：

~~~bash
export CODEXBRIDGE_CODEX_DESKTOP_HOME='/home/alice/.codex'
export CODEXBRIDGE_CODEX_DESKTOP_HOST_ID='remote-wsl:Ubuntu'
~~~

发行版名称保留大小写并使用 URI 编码，例如 `Ubuntu Work` 对应 `remote-wsl:Ubuntu%20Work`。目录必须能被桥接器所在发行版读取，并与目标 Agent 一致。Windows 和 WSL 默认目录不同，因此 WSL 下必须显式设置桌面目录；桥接器不会改动独立会话的 `CODEX_HOME` 或复制认证文件。

连接只使用本机 `\\.\pipe\codex-ipc`，也可通过 `CODEXBRIDGE_CODEX_DESKTOP_IPC_SOCKET` 指定其他本机管道，不开放 TCP 端口。助手在发送桌面数据前检查管道服务端的 Windows 用户 SID。需要 Windows PowerShell 5.1/.NET、运行已审阅本地助手脚本的权限，以及可用的 WSL interoperability；助手不会修改执行策略或自动提权。策略阻止脚本时，请先检查 `Get-ExecutionPolicy -List`，按所在环境批准的策略处理。可以用 `CODEXBRIDGE_CODEX_DESKTOP_POWERSHELL_BIN` 指定系统 PowerShell 的绝对路径；Windows 挂载方式不同于默认值时，请指定 WSL 可执行的绝对路径。WSL 桥接器无需额外安装 Windows Node。

按配置启动或重启桥接器后，在微信发送 `/enter`，再用 `/enter 2` 选择，通过 `/status` 查看桌面主机。每个桥接器配置一个目录和主机；修改目标后必须重新 `/enter`。桌面目录是只读列表，支持 `/peek`、`/search`、`/next` 和 `/prev`；归档、重命名等管理操作请在桌面完成。`/threads` 切回独立会话列表。共享入口不可用时，`/exit` 仍能恢复之前的微信独立会话。

两种共享环境均保留前述可见输出同步、去重和单独的结束耗时通知。电脑及相关进程保持登录、唤醒和联网时，IPC 可以在锁屏后继续工作；关闭 WSL 会停止其中的桥接器，仅有 systemd 服务不能保证 WSL 实例持续运行。GUI 提交仍仅适用于 macOS。

找不到兼容持有者时，请先在 Windows 桌面打开目标会话，核对主机与目录。`owner-mismatch` 或 `owner-query-failed` 表示无法验证管道归属，应使用同一个 Windows 账户运行相关程序，不应绕过检查。协议不兼容需要更新适配。提交后确认丢失会提示“可能已提交”，不会自动重发。目录和日志读取都有上限，列表不完整时会显示说明。

路由版本和实机验证范围见[已确认架构及验证记录](docs/design/windows-wsl-sharing-architecture.md)。降级到旧版桥接器之前，请先 `/exit` 解除新增的桌面专用绑定。

<a id="claude-code-session-sharing"></a>

### 共享已有 Claude Code 会话

微信服务还注册了 `claude-code` 共享 Provider。发送 `/enter claude` 浏览本地 Claude Code 会话，每页 10 个；再发送 `/enter <序号>` 进入。仅列出会话不会改变当前 Provider 或绑定。`/enter codex` 返回 Codex 会话列表。`/status` 显示绑定的 Provider 和共享模式；`/exit` 恢复共享前的微信独立会话，包括原本使用 Codex 的会话。

需要先在选中的交互式 Claude Code CLI 会话中启用 Channel。在 wxBridage 安装目录执行：

```bash
node --import tsx src/cli.ts claude share <existing-Claude-session-UUID>
```

选择尚未连接的会话时，微信提示中会显示 UUID。启动器使用相同项目目录执行 `claude --resume <UUID>`，并加入本地 MCP Channel；它保留原历史、模型、项目设置和工具权限，不会 Fork 会话或关闭权限检查。首次使用需要确认 Claude 的 Development Channel 提示。如果 `weixin:serve` 没有使用默认的 `~/.codexbridge`，这里也要传入相同的 `--state-dir`。省略 UUID 会显式创建一个新的可共享 Claude 会话。

未启用 Channel 的既有会话必须通过该启动器重新打开。原本未配置的会话仍在运行时，不要再启动第二个 `--resume` 进程；当前版本无法透明附加到那个进程，也不能控制普通 Claude Desktop 聊天。可共享会话启动后，PC 和微信都可以使用，无需重启或激活前台窗口。

文本和带转写的语音通过 [Claude Channels](https://code.claude.com/docs/en/channels-reference) 发送到既有会话，回复仍保留在 PC 的正常对话中。桥接器增量读取可见助手分段和真实 `turn_duration`，用于微信同步和完成通知；已完成历史、推理和工具输出不会发送。首次扫描上限为 8 MiB，后续每次轮询上限为 512 KiB。若未完成轮次的起始消息位于首次扫描窗口之外，则无法重建。`/stop` 可以中断已确认所有进程的当前 Claude CLI 轮次；`/exit` 只解除共享，不会停止任务。

Channels 仍是 Research Preview。启动器通过 `--dangerously-load-development-channels server:codexbridge-weixin` 加载自定义服务，这只绕过 Channel Allowlist，不会绕过组织策略和本地工具审批。Socket 确认只表示通知已写入，不代表 Claude 一定已经处理；缺少 Transcript 确认时会提示结果不确定，绝不会自动重发或启动独立 CLI 写入者。Channel Socket 及目录仅允许当前系统用户访问。锁屏使用时仍需保持 Claude 进程和桥接服务运行，并确保电脑唤醒、联网。

## 国际化

桥接器对所有面向用户的运行时文本使用统一 i18n 层。

- 支持语言：`zh-CN`、`en`
- 默认语言：`zh-CN`
- 进程级覆盖：`CODEXBRIDGE_LOCALE=zh-CN` 或 `CODEXBRIDGE_LOCALE=en`

```bash
CODEXBRIDGE_LOCALE=en npm run weixin:serve
```

当前语言设置会影响：

- 斜杠命令回复
- 微信运行时错误信息
- CLI 登录和服务提示
- 桥接器重启完成通知

## 后台服务

桥接循环是 `weixin:serve`。无人值守时，请将它注册到宿主系统服务管理器，让它在登录/启动后运行，并在崩溃后自动重启。

重要限制：

- 服务管理器只能在电脑开机且操作系统正常运行时保持 wxBridage 在线
- 主机断电、休眠或离线时不能接收消息
- 桌面系统的用户级服务依赖用户会话模型；Linux `linger` 和 macOS `launchd` 不要求终端一直打开，下面的 Windows 计划任务在用户登录后运行

### Linux systemd 用户服务

```bash
bash ./scripts/service/install-systemd-user.sh
```

常用命令：

```bash
bash ./scripts/service/status-systemd-user.sh
bash ./scripts/service/restart-systemd-user.sh
bash ./scripts/service/logs-systemd-user.sh
bash ./scripts/service/logs-systemd-user.sh --follow
```

安装脚本使用 `Restart=always`，并尝试启用 `loginctl linger`。如果无法自动启用：

```bash
loginctl enable-linger "$USER"
```

用户环境文件位于：

```text
~/.config/codexbridge/weixin.service.env
```

可以在其中配置：

- `WEIXIN_ACCOUNT_ID`
- `WEIXIN_DM_POLICY` 和 `WEIXIN_ALLOWED_USERS`
- `CODEX_DEFAULT_PROVIDER_PROFILE_ID`
- macOS 上的 `CODEXBRIDGE_CODEX_DESKTOP_SHARED_THREAD` 及可选桌面传输设置
- `DEEPSEEK_*`、`MINIMAX_*`、`QWEN_*`、`OPENROUTER_*`、`CODEX_COMPAT_*` 等 Provider 配置
- `CODEXBRIDGE_DEBUG_WEIXIN`

### Windows 计划任务

安装并启动隐藏的用户级计划任务：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\service\install-windows-task.ps1
```

常用命令：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\service\status-windows-task.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\service\restart-windows-task.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\service\logs-windows-task.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\service\logs-windows-task.ps1 -Follow
```

环境文件：

```text
%APPDATA%\codexbridge\weixin.service.env
```

日志目录：

```text
%USERPROFILE%\.codexbridge\logs\
```

如果任务需要在开机时而不是用户登录时启动，可传入 `-AtStartup`。该模式可能需要管理员权限，并且运行用户仍需访问 Codex 认证文件。

### macOS launchd 用户服务

安装并启动 LaunchAgent：

```bash
bash ./scripts/service/install-launchd-user.sh
```

常用命令：

```bash
bash ./scripts/service/status-launchd-user.sh
bash ./scripts/service/restart-launchd-user.sh
bash ./scripts/service/logs-launchd-user.sh
bash ./scripts/service/logs-launchd-user.sh --follow
```

安装器写入：

```text
~/Library/LaunchAgents/com.ganxing.codexbridge-weixin.plist
~/.config/codexbridge/weixin.service.env
~/.codexbridge/logs/
```

### 服务运行器

Windows 和 macOS 使用 `scripts/service/run-weixin-service.mjs` 作为轻量监督进程。它加载服务环境文件，并启动：

```bash
node --import tsx src/cli.ts weixin serve
```

进程异常退出后会自动重启。Linux 直接使用 systemd 的 `Restart=always`。

常用环境或配置参数：

- `--base-url`
- `--cwd`
- `--state-dir`
- `--bot-type`
- `--timeout-sec`

登录命令会获取二维码，把图片保存到 `~/.codexbridge/weixin/login/`，输出文件路径并等待扫码确认。认证信息随后保存在 `~/.codexbridge/weixin/accounts/`。运行脚本直接执行 `tsx src/cli.ts` 和 `tsx src/index.ts`。
