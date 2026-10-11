# CodexBridge

[English](./README.md) | [简体中文](./README.zh-CN.md)

CodexBridge is a Codex-centered gateway for connecting multiple chat platforms to one shared Codex engine, while switching backend provider profiles inside Codex when needed.

Original upstream repository: [Gan-Xing/CodexBridge](https://github.com/Gan-Xing/CodexBridge). This version is based on that project and includes additional changes.

## Current Direction

- First delivery target: `WeChat + Codex`
- Package-side experiments are paused for now
- `packages/codex-gateway` is not under active development
- `packages/mission-control` is not under active development
- `packages/codex-native-api` is retained as the only package planned for possible future work, but it is also paused for now
- Core rule: platforms are adapters, Codex stays the execution engine, and Codex thread state stays the source of truth

## Documents

- [Core architecture](./docs/architecture/codexbridge-core-architecture.md)
- [Roadmap TODO](./docs/todo/roadmap.md)
- [Codex Native API TODO](./docs/todo/codex-native-api.md)
- [Codex Gateway TODO - paused](./docs/todo/codex-gateway.md)
- [Mission Control TODO - paused](./docs/todo/mission-control.md)
- [Mission Control architecture - historical reference](./docs/architecture/mission-control.md)
- [WeChat slash command reference](./docs/usage/weixin-slash-commands.md)

## Repository Layout

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

## Status

Project bootstrap is now focused on:

1. Keeping `WeChat + Codex` as the product center
2. Avoiding more backend/package expansion until the bridge direction is clearer
3. Treating `codex-gateway` and `mission-control` as paused workstreams
4. Keeping `codex-native-api` only as a retained future option, not as active work

Current implemented bridge pieces:

- Core session routing with WeChat-friendly slash commands, including `/helps`, `/status`, `/usage`, `/login`, `/stop`, `/review`, `/plan`, `/skills`, `/plugins`, `/automation`, `/weibo`, `/new`, `/uploads`, `/as`, `/log`, `/todo`, `/remind`, `/note`, `/provider`, `/models`, `/model`, `/personality`, `/instructions`, `/fast`, `/threads`, `/search`, `/next`, `/prev`, `/open`, `/enter`, `/exit`, `/peek`, `/rename`, `/permissions`, `/allow`, `/deny`, `/reconnect`, `/retry`, `/restart`, and `/lang`
- `/open` now rebinds the current scope and immediately returns a short recent-turn preview, so users can resume an old thread with one command instead of calling `/peek` first
- File-backed JSON repositories for persistent bridge state
- WeChat platform skeleton for Hermes-compatible iLink config loading, QR account state reuse, inbound DM normalization, long-poll client/poller wiring, context-token persistence, text chunking, and outbound text/typing delivery
- Codex profile loader and initial Codex app-server client/plugin path for shared thread execution
- WeChat runtime wiring that feeds poll events into the shared bridge coordinator and sends responses back through the WeChat transport
- OpenAI-compatible Responses adapter for non-OpenAI Chat Completions providers, including compact fallback, SSE stream translation, tool-call repair, provider/model capability rules, and gated live-provider smoke tests

Package workstream status:

- `packages/codex-gateway`: paused
- `packages/mission-control`: paused
- `packages/codex-native-api`: retained for later only; currently paused

## OpenAI-Compatible Provider Validation

Live provider validation is opt-in so normal tests do not spend API quota.

```bash
CODEXBRIDGE_TEST_LIVE_OPENAI_COMPATIBLE=1 pnpm exec tsx --test test/providers/openai_compatible/live_provider_smoke.test.ts
```

Supported smoke env names:

```text
DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_DEFAULT_MODEL
MINIMAX_API_KEY / MINIMAX_BASE_URL / MINIMAX_MODEL
QWEN_API_KEY or DASHSCOPE_API_KEY / QWEN_BASE_URL / QWEN_MODEL
OPENROUTER_API_KEY / OPENROUTER_BASE_URL / OPENROUTER_MODEL
KIMI_API_KEY / KIMI_BASE_URL / KIMI_MODEL
GEMINI_API_KEY / GEMINI_BASE_URL / GEMINI_MODEL
IFLOW_API_KEY / IFLOW_BASE_URL / IFLOW_MODEL
```

Runtime WebSocket is still disabled for the local OpenAI-compatible adapter until the server grows an upgrade handler. The CLIProxyAPI-style WebSocket transcript/tool-call repair logic is implemented as a tested module first, so enabling WebSocket later has a safe core to call instead of reintroducing transcript corruption.

## WeChat Slash Commands

The WeChat bridge now uses a text-first command surface designed for chat, not buttons.
Recommended entrypoints:

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
/as 今天修复了 /pg search 日记召回太宽的问题 #CodexBridge
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
/models
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

### `/models` and `/ms`

List available models for the current provider profile.

Examples:

```text
/models
/ms
```

### `/automation` and `/auto`

Create and manage scheduled background jobs. Results are always delivered back to the same WeChat chat.

Examples:

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

### `/as`, `/log`, `/todo`, `/remind`, and `/note`

Personal assistant records for WeChat. `/as` is the natural-language entry for logs, todos, reminders, and notes. It asks Codex to decide whether the message is a new record or a management action on an existing record; local keyword rules are only a conservative fallback when the provider is unavailable. `/log`, `/todo`, `/remind`, and `/note` remain shortcuts when you want to force a category.

Examples:

```text
/as 今天修复了 /pg search 日记召回太宽的问题 #CodexBridge
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

`/as` also manages existing records with natural language. Codex first routes the message as create, update, complete, cancel, or archive. It only targets an existing record when the message clearly refers to the same concrete item; otherwise it creates a new log/todo/reminder/note. Existing-record changes are shown as a pending draft and are only written after `/as ok`. Use `/as edit <change instruction>` to refine that pending update draft, or `/as cancel` to discard it.

For natural-language updates, the bridge prefers a short-lived Codex app-server rewrite thread, so the host Codex subscription handles the “original record + modification instruction” merge. API-key based Agents SDK normalization is only a fallback when Codex normalization is unavailable; local rules are the final fallback.

`/up` can stage files first. If the final message is `/as`, `/log`, `/todo`, `/remind`, or `/note`, the staged files are archived onto the assistant record under `~/.codexbridge/assistant/attachments/YYYY/MM/DD/<recordId>/`; structured records are stored in `~/.codexbridge/runtime/assistant_records.json`.

Boundary: `/remind` only notifies, `/todo` tracks user-owned work, and `/auto` runs scheduled system work.

### `/plan` and `/pl`

Inspect or switch the session-level collaboration mode for future turns.

Examples:

```text
/plan
/pl
/plan on
/plan off
```

`/plan on` enables native `plan` mode for later turns in the current bridge session. `/plan off` restores the native `default` collaboration mode. This is a mode toggle, not an approval flow.

OpenAI-compatible runtime adapter:

- CodexBridge can expose non-OpenAI providers through a local Responses adapter while Codex app-server still talks to a Responses-shaped endpoint.
- The adapter now handles `/responses/compact`, Chat Completions conversion, stream error mapping, CLIProxyAPI top-level stream error chunks, stream read failure framing, configured transient upstream retry, usage fallback including Gemini-family `usageMetadata`, provider/model thinking policy, CLIProxyAPI-style payload compatibility (`default`, `default-raw`/`defaultRaw`, `override`, `override-raw`/`overrideRaw`, `filter`, `root`, protocol/model matching), multimodal input capability flags, and model capability metadata.
- DeepSeek, MiniMax, Qwen, OpenRouter, Kimi, Gemini, and iFlow are loaded as `providerKind: openai-compatible`; they differ by env vars and capability presets only, not separate provider plugin classes.
- The model capability catalog follows the same direction as CLIProxyAPI: model quirks are represented as data (`thinking`, `payload`, tool support, multimodal support, token caps), while the executor stays generic.
- Current built-in catalog covers the CLIProxyAPI model families used by Codex-style routing: Codex, DeepSeek, MiniMax, Qwen, iFlow, Kimi, OpenRouter, Gemini/AI Studio/Vertex, Claude, and Antigravity. `*_MODEL_CATALOG_PATH` can also point at a CLIProxyAPI `models.json`-shaped catalog object; CodexBridge flattens it and merges model token/thinking metadata into runtime capabilities. Native auth/header systems from CLIProxyAPI are not copied into this adapter; use provider env vars or the custom `CODEX_COMPAT_*` profile for deployment-specific credentials.
- Auth pools, proxy rotation, and custom provider header management remain deployment-layer concerns and are intentionally separate from the generic OpenAI-compatible adapter.

Runtime provider examples:

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
CODEX_COMPAT_CAPABILITIES=default # or deepseek/minimax/qwen/kimi/gemini/iflow/openrouter
CODEX_COMPAT_REQUEST_RETRY=2
```

### `/model` and `/m`

Check or switch the model used for future turns.

Examples:

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

All slash commands support command-scoped help flags:

```text
/threads -h
/open --help
/permissions -helps
```

Best-practice rule:

- use `/helps` for command discovery
- use `/login` and `/login list` to manage the host Codex account pool before switching accounts with `/login <index>`
- use `/review`, `/review base <branch>`, or `/review commit <sha>` when you want a native Codex code review without changing the current thread binding
- use `/plan on` when you want later turns in the current session to prioritize planning first, and `/plan off` when you want to restore the default collaboration mode
- use `/skills` to inspect what Codex can currently see in the active project, `/skills search <keyword>` for related matches, and `/skills show <index>` to understand what a skill is for before enabling or disabling it
- use `/auto add ...` in natural language first; the bridge will draft a schedule, then `/auto confirm` creates the job
- use `/threads` and numeric indexes on WeChat instead of copying raw thread ids
- use `/personality` to control the response style for future turns in the current scope
- use `/instructions` to manage the active Codex `AGENTS.md` custom instructions file
- use `/lang zh-CN` or `/lang en` to switch reply language for the current scope
- use `/allow 1` or `/allow 2` to approve, and `/deny` to reject, when Codex asks for approval mid-turn
- use `/retry` after an interrupted turn; it refreshes the current Codex session first, then reruns the previous request in the same thread
- use `/helps <command>` when you need exact usage and examples

See the full command reference in [docs/usage/weixin-slash-commands.md](./docs/usage/weixin-slash-commands.md).

## Validation

```bash
npm install
npm run typecheck
npm test
```

The validation suite is expected to pass on Linux, macOS, and Windows.

`npm test` is the isolated default test entrypoint. It clears live agent provider variables such as `CODEXBRIDGE_AGENT_*`, `OPENAI_*`, and `MINIMAX_API_KEY` before starting `node --test`, so unit and integration tests stay deterministic even when the host shell, CI runner, or service manager exports real model credentials.

When you intentionally want to keep live agent credentials and exercise the real external agent path, use the explicit opt-in script instead:

```bash
npm run test:live-agent
```

Keep `test:live-agent` separate from the main suite. It is for deliberate provider-backed verification, not for the default `npm test` gate.

## Deployment Quick Start

CodexBridge is currently distributed as a source repository. The root package intentionally remains `private`, so install dependencies from a clone rather than attempting to publish or install it as an npm package.

### Common Prerequisites

- Node.js `>= 24`
- `npm`
- A working Codex CLI login on the host

Recommended first check after cloning:

```bash
npm install
npm run typecheck
npm test
codex --version
```

If the Codex CLI is not installed yet, install it first:

```bash
npm install -g @openai/codex@latest --include=optional
codex --version
```

If `codex --version` still fails, fix that before attempting `weixin:login` or `weixin:serve`.

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

For long-running deployment, prefer the service-manager flow described below instead of leaving a terminal window open.

### Windows (First-Time Bring-Up)

Open PowerShell in the repo root and run:

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

If the host has multiple Codex shims on `PATH`, set the real native binary explicitly before starting the bridge:

```powershell
$env:CODEX_REAL_BIN = (Get-Command codex.exe).Source
npm run weixin:serve -- --cwd C:\absolute\path\to\workspace
```

Useful optional debug flag:

```powershell
$env:CODEXBRIDGE_DEBUG_WEIXIN = '1'
```

### What Was Hardened After the First Windows Deployment

The first Windows bring-up exposed four platform-specific issues:

1. Command discovery:
   the provider config originally assumed a Unix-style command lookup. The loader now resolves Windows executables directly and prefers a native `codex.exe` / `.com` binary over wrapper scripts when both exist.
2. Windows launch wrappers:
   if the host only exposes `codex.cmd` or `codex.bat`, the bridge now launches that wrapper through a Windows shell command line instead of failing during `spawn(...)`.
3. Startup diagnostics:
   if Codex cannot be launched, the bridge now fails with a direct `CODEX_REAL_BIN` / `codex.exe` / `codex.cmd` hint instead of leaving only a raw `spawn codex ENOENT`.
4. Thread materialization:
   transient `empty session file` reads from Codex session storage are now retried automatically instead of being treated as fatal turn failures.

### Runtime Defaults

- State directory: `~/.codexbridge`
- WeChat account files: `~/.codexbridge/weixin/accounts/`
- Serve lock file: `~/.codexbridge/runtime/weixin-serve.lock`
- Default Codex auth path: `~/.codex/auth.json`
- Default Codex instructions path: `~/.codex/AGENTS.md`

### WeChat Runtime Checklist

Binding the WeChat account is only the login step. Replies require the serve loop to stay alive.

Standard order:

1. `npm run weixin:login`
2. confirm the account file exists under `~/.codexbridge/weixin/accounts/`
3. start `npm run weixin:serve`
4. send `/h` or `/status` from WeChat as a smoke test
5. keep the process running, or install the platform service manager below

### Troubleshooting

- No reply after WeChat binding:
  confirm `weixin:serve` is still running. The QR login does not start a background worker by itself.
- `spawn codex ENOENT` or the bridge cannot start Codex:
  run `codex --version`. On Windows, set `CODEX_REAL_BIN` to the full path of `codex.exe` or `codex.cmd` if needed.
- Turn starts but no final reply is delivered:
  inspect debug logs with `CODEXBRIDGE_DEBUG_WEIXIN=1`. Transient `empty session file` reads are retried automatically in current builds.
- Need to inspect runtime state:
  account state is stored under `~/.codexbridge/weixin/accounts/`, and the current serve lock is stored under `~/.codexbridge/runtime/weixin-serve.lock`.

## Media Tooling

Image normalization and video thumbnail generation now use project-managed `ffmpeg` / `ffprobe` binaries via `ffmpeg-static` and `ffprobe-static`.

Resolution order:

- `CODEXBRIDGE_FFMPEG_PATH` / `CODEXBRIDGE_FFPROBE_PATH`
- `FFMPEG_PATH` / `FFPROBE_PATH`
- bundled binaries from project dependencies
- system `PATH` fallback

This keeps image/video media handling portable across Linux, macOS, and Windows without requiring a manual global `ffmpeg` install in the common case.

## WeChat Login

```bash
npm run weixin:login
```

Run the WeChat bridge loop:

```bash
npm run weixin:serve
```

By default the bridge uses the directory where `weixin:serve` is launched as the shared working directory for new sessions. You can override it with `--cwd` or `CODEXBRIDGE_DEFAULT_CWD`, and you can still rebind a specific chat with `/new /absolute/path/to/project`.

New service installations default direct messages to `allowlist`. Set the owner's WeChat sender ID before starting the service:

```bash
WEIXIN_DM_POLICY=allowlist
WEIXIN_ALLOWED_USERS=wxid_owner
```

To discover the sender ID during initial setup, temporarily enable `CODEXBRIDGE_DEBUG_WEIXIN=1`, send one message, and read the `scope_not_allowed` `scopeId` from the service log. Add that value to `WEIXIN_ALLOWED_USERS`, then turn debug logging off and restart the service. `WEIXIN_DM_POLICY=open` remains available as an explicit opt-in for deployments whose account exposure is otherwise controlled. The legacy value `pairing` is not supported and fails closed as `allowlist`.

### Share a Codex desktop thread on macOS

An existing WeChat chat can explicitly enter a Codex desktop thread and send text through the desktop app instead of opening a second writer for the same thread. Enable the opt-in relay in the service environment file:

```bash
CODEXBRIDGE_CODEX_DESKTOP_SHARED_THREAD=1
```

Restart `weixin:serve`, then use `/enter` in WeChat to list 10 available threads per page and `/enter <index>` to start sharing one. Use `/next` and `/prev` for additional pages. Sharing is never inferred from the current `/open` binding. Shared messages now use the desktop's local IPC coordination service to find the thread owner and submit a turn to that desktop instance. The desktop keeps its model, permissions and workspace settings; the bridge tracks the returned turn ID and reads the output back into WeChat. No window activation or simulated Return key is required with the default `ipc` transport. The desktop app remains the only writer, so the message and reply belong to the same PC thread.

This background path allows messages while the Mac's screen is locked, provided the desktop app and bridge remain running and the Mac stays awake and online. It does not unlock the computer or change power settings. Tasks that require interacting with an unlocked desktop can still be blocked. If the thread has no desktop owner, open it in the desktop app once before retrying. The adapter uses an internal, versioned desktop coordination protocol; a desktop update can require a bridge compatibility update. Missing owners and incompatible protocols fail explicitly, without starting a separate writer or automatically switching to GUI submission. A timeout/disconnect after submission can mean the message was accepted: check the thread before resending.

Send `/exit` to leave the desktop thread. CodexBridge keeps that desktop thread untouched and restores the standalone thread that was bound before `/enter`; it creates a new standalone thread only when the previous one is unavailable. `/exit` also works while a shared reply is running: the submitted reply continues in the original desktop thread, and new conversation messages wait for it to finish before using the standalone thread. `/status` reports either `desktop shared` or `standalone`.

Entering an already running desktop thread attaches a read-only output observer. Visible assistant messages from its unfinished turn and subsequent desktop-started turns are forwarded to WeChat in throttled segments, followed by the final result with duplicate text suppressed. Completed history, reasoning, and tool logs are excluded. The observer stops on `/exit`, binding changes, or service shutdown, and resumes for persisted shared bindings after restart. A busy desktop thread does not receive a second prompt from WeChat. Output appears when desktop message segments reach the rollout log; this is not token-by-token streaming. A message already being sent when you exit may still arrive.

After each shared reply finishes, WeChat receives a separate completion notice, for example `本轮回复已结束，耗时：2分15秒。`. Duration comes from the desktop turn log and includes time before a mid-turn `/enter`; it measures one reply, not the entire thread's lifetime. Interrupted or failed turns are labeled accordingly. If timing is missing, the notice says it was not recorded. This applies to both desktop-started and WeChat-submitted shared replies while still entered.

Shared rollout messages are sent as intact segments, with splitting only for WeChat's delivery size limit and throttling through its existing queue. Versions such as `rc.129` and IP addresses stay together in normal messages. Successful chunks, final results, and completion notices are acknowledged in `runtime/desktop-sync-checkpoints.json` under the bridge state directory, so restarting or reconnecting skips previously acknowledged output. The checkpoint stores hashes, not chat text, and is scoped to each WeChat chat, desktop binding, and turn. It retains the latest 256 turns. An abrupt crash between WeChat accepting a send and its local acknowledgement being saved can still cause that in-flight chunk to repeat.

WeChat quick reference:

```text
/enter：列出可选会话
/enter 2：进入第 2 个桌面会话
/status：查看当前是“桌面共享”还是“独立会话”
/exit：退出共享，原桌面会话保持不变，并退回微信自己的会话
```

Current limits:

- macOS and the ChatGPT/Codex desktop app only;
- the desktop app must remain running and own the selected thread;
- the Mac must remain logged in, awake and online; screen locking is allowed with IPC, while sleep/logout are not supported for immediate processing;
- desktop coordination protocol compatibility is required (owner discovery v1 and follower start-turn v2 in the inspected desktop build);
- plain text and voice messages with a WeChat transcript are supported; images, files, videos, and untranscribed voice fail explicitly instead of falling back to a second writer;
- `/stop` and WeChat-side approval handling do not control a desktop-owned turn yet.

`CODEXBRIDGE_CODEX_DESKTOP_TRANSPORT=ipc` is the default. `CODEXBRIDGE_CODEX_DESKTOP_IPC_SOCKET` optionally selects an absolute socket path; otherwise the adapter uses `$CODEX_HOME/ipc/ipc.sock` (or `~/.codex/ipc/ipc.sock`). The socket and its directory must be owned by the current user and not writable by other users.

For older desktop versions, explicitly set `CODEXBRIDGE_CODEX_DESKTOP_TRANSPORT=gui` to use the previous deep-link/Return-key method. That compatibility mode requires macOS Accessibility permission and an unlocked desktop. It is never selected automatically on IPC failure. Optional GUI tuning values are `CODEXBRIDGE_CODEX_DESKTOP_APP_NAME` and `CODEXBRIDGE_CODEX_DESKTOP_SUBMIT_DELAY_MS`; both transports retain `CODEXBRIDGE_CODEX_DESKTOP_POLL_INTERVAL_MS`, `CODEXBRIDGE_CODEX_DESKTOP_TIMEOUT_MS`, and `CODEXBRIDGE_CODEX_DESKTOP_MAX_PROMPT_CHARS` (IPC currently accepts up to 16,000 characters).

### Share an existing Claude Code session

The WeChat service also registers a `claude-code` sharing provider. Send `/enter claude` to browse local Claude Code sessions (10 per page), then `/enter <index>` to enter one. Listing sessions does not change the chat's current provider or binding. `/enter codex` returns to the Codex session list. `/status` identifies the bound provider and sharing mode; `/exit` restores the independent WeChat session that preceded sharing, including when it used Codex.

First enable the channel in the selected **interactive Claude Code CLI session**. Run this from the CodexBridge installation directory:

```bash
node --import tsx src/cli.ts claude share <existing-Claude-session-UUID>
```

The UUID is shown in the WeChat connection hint when you select an unconnected session. The launcher uses `claude --resume <UUID>` with the same project directory and adds a local MCP channel. It keeps the original history, model, project settings and tool permissions; it never forks the session or disables permission checks. Confirm Claude's development-channel prompt once. Use the same `--state-dir` as `weixin:serve` if it differs from `~/.codexbridge`. Omitting the UUID explicitly starts a new shareable Claude session.

Sessions that were started without channel support must first be reopened through this launcher. Do not run a second `--resume` process while the original unconfigured session is still running. This version cannot transparently attach to that process, and it does not control ordinary Claude Desktop chats. After the shareable session is running, PC and WeChat can both use it; no restart or foreground window activation is needed for subsequent messages.

Text and transcribed voice are sent to the existing session through [Claude Channels](https://code.claude.com/docs/en/channels-reference). Replies stay in the normal PC conversation. Visible assistant segments and real `turn_duration` records are read incrementally for WeChat synchronization and completion notices. Completed history, reasoning and tool output are excluded; the initial scan is capped at 8 MiB and subsequent polls at 512 KiB. An unfinished turn whose initiating message is beyond that initial window cannot be reconstructed. `/stop` can interrupt the currently correlated Claude CLI turn through its verified owning process; `/exit` only detaches sharing and leaves the task running.

Channels is a research preview: the launcher enables this custom server with `--dangerously-load-development-channels server:codexbridge-weixin`, which bypasses the channel allowlist only. Organization policy may still block delivery, and local tool approval dialogs may still need a response on the computer. A socket acknowledgement means the notification was written, not necessarily processed; missing transcript confirmation produces an uncertainty warning and never triggers a resend or a separate CLI writer. The channel socket and its directory are restricted to the current OS user. Keep the Claude process and bridge running and the computer awake and online for locked-screen use.

## i18n

The bridge now uses one unified i18n layer for user-visible runtime text.

- Supported locales:
  - `zh-CN`
  - `en`
- Default locale: `zh-CN`
- Process-wide override:
  - `CODEXBRIDGE_LOCALE=zh-CN`
  - `CODEXBRIDGE_LOCALE=en`

Example:

```bash
CODEXBRIDGE_LOCALE=en npm run weixin:serve
```

The locale currently affects:

- slash-command replies
- WeChat runtime failure messages
- CLI login / serve prompts
- bridge restart completion notifications

## Background Service

The bridge loop is `weixin:serve`. For unattended use, register it with the host service manager so it starts on login/boot and restarts after crashes.

Important limits:

- A service manager keeps CodeXBridge alive while the computer is powered on and the OS is running.
- It cannot receive messages while the host is powered off, asleep, or disconnected from the network.
- On desktop operating systems, user-level services depend on the user's login/session model. Linux `linger` and macOS `launchd` can run without an open terminal; Windows Task Scheduler below runs after user logon.

### Linux systemd User Service

Install and start the user service on Linux:

```bash
bash ./scripts/service/install-systemd-user.sh
```

Useful follow-up commands:

```bash
bash ./scripts/service/status-systemd-user.sh
bash ./scripts/service/restart-systemd-user.sh
bash ./scripts/service/logs-systemd-user.sh
bash ./scripts/service/logs-systemd-user.sh --follow
```

The installer uses `Restart=always` and attempts to enable `loginctl linger` so the user service can continue after logout. If linger cannot be enabled automatically, run:

```bash
loginctl enable-linger "$USER"
```

The installer writes a per-user environment file to:

```text
~/.config/codexbridge/weixin.service.env
```

That file is the stable place to adjust:

- `WEIXIN_ACCOUNT_ID`
- `WEIXIN_DM_POLICY` and `WEIXIN_ALLOWED_USERS`
- `CODEX_DEFAULT_PROVIDER_PROFILE_ID`
- `CODEXBRIDGE_CODEX_DESKTOP_SHARED_THREAD` and the optional desktop transport settings on macOS
- optional OpenAI-compatible provider keys such as `DEEPSEEK_*`, `MINIMAX_*`, `QWEN_*`, `OPENROUTER_*`, or `CODEX_COMPAT_*`
- `CODEXBRIDGE_DEBUG_WEIXIN`

### Windows Scheduled Task

Install and start a hidden per-user scheduled task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\service\install-windows-task.ps1
```

Useful follow-up commands:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\service\status-windows-task.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\service\restart-windows-task.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\service\logs-windows-task.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\service\logs-windows-task.ps1 -Follow
```

The installer writes the environment file to:

```text
%APPDATA%\codexbridge\weixin.service.env
```

Logs are written under:

```text
%USERPROFILE%\.codexbridge\logs\
```

If you need the task to start at machine startup instead of user logon, pass `-AtStartup`. That mode may require elevated privileges and a user environment that can still access the Codex auth files.

### macOS launchd User Service

Install and start the launch agent:

```bash
bash ./scripts/service/install-launchd-user.sh
```

Useful follow-up commands:

```bash
bash ./scripts/service/status-launchd-user.sh
bash ./scripts/service/restart-launchd-user.sh
bash ./scripts/service/logs-launchd-user.sh
bash ./scripts/service/logs-launchd-user.sh --follow
```

The installer writes:

```text
~/Library/LaunchAgents/com.ganxing.codexbridge-weixin.plist
~/.config/codexbridge/weixin.service.env
~/.codexbridge/logs/
```

### Service Runner

Windows and macOS use `scripts/service/run-weixin-service.mjs` as a small supervisor. It loads the service env file, starts:

```bash
node --import tsx src/cli.ts weixin serve
```

and restarts it after unexpected exit. Linux relies on systemd's native `Restart=always`.

Useful environment/config values:

- `--base-url`
- `--cwd`
- `--state-dir`
- `--bot-type`
- `--timeout-sec`

The login command fetches a QR code, saves the QR image under `~/.codexbridge/weixin/login/`, prints the file path, and waits until the scan is confirmed. Credentials are then stored under `~/.codexbridge/weixin/accounts/`. Runtime scripts now execute `tsx src/cli.ts` and `tsx src/index.ts` directly.
# wxBridge
