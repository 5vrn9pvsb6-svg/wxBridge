# 源代码工程质量评估报告

## 1. 已核实问题

### F-01：微信私聊入口默认开放，`pairing` 配置没有实际配对校验

- 严重程度及依据：高；该入口可驱动本机 Codex/Claude 会话，错误的默认授权会扩大远程执行边界。
- 关联维度：SQ-11、SQ-15、SQ-16。
- 定位：`src/platforms/weixin/config.ts:6,25,29,67-78`；`src/platforms/weixin/plugin.ts:761-777`；`config/examples/weixin.service.env.example:10-15`。
- 证据：E-06。默认私聊策略和示例都是 `open`；配置允许 `pairing`，但运行时只处理 `disabled` 和 `allowlist`，其他值直接返回 `true`。全仓搜索未找到另一处配对校验。
- 影响：公开部署时，维护者可能以为 `pairing` 会执行所有者绑定，实际行为却等同开放；若账号可被非预期联系人触达，可能让其向本机代理提交任务。
- 来源：既有；默认策略与分支在当前工作区变更之前已经存在。
- 建议及验证：发布前将默认值和安装示例改为 `allowlist` 或实现真正的配对状态机；对 `open/allowlist/disabled/pairing` 四种策略增加端到端授权用例，并验证未授权私聊无法进入命令分发。

### F-02：仓库规定的 TypeScript 发布门禁当前失败

- 严重程度及依据：高；CI 明确执行 `npm run typecheck`，当前快照无法通过这一必经门禁。
- 关联维度：SQ-12、SQ-14、SQ-16。
- 定位：`tsconfig.json:19-23`；`packages/codex-provider-relay/examples/*.ts`；`packages/codex-provider-relay/test/file_search_executor.test.ts`；`.github/workflows/ci.yml:30-37`。
- 证据：E-07。根 `tsconfig` 把所有 `packages/**/*.ts` 纳入检查，但 relay 示例无法解析 `@codex-provider/core`，relay 测试还有同步值/Promise 联合类型错误。
- 影响：当前分支不能形成绿色 CI；暂停中的包工作流会阻断 CodexBridge 主产品发布，且维护者难以区分产品缺陷和试验包缺陷。
- 来源：既有；报错所在包与根 `tsconfig.json` 不在本次已跟踪变更中。
- 建议及验证：二选一：完成 relay 包的 workspace/paths 和类型修复，或把暂停包从根门禁拆成独立工作区门禁；在干净检出、Node 24 环境运行 `npm ci && npm run typecheck`，退出码必须为 0。

### F-03：完整测试在目标用户常见的中国时区下不确定，且包含真实时区泄漏

- 严重程度及依据：高；完整测试 683 项中 4 项失败，日期归一化会把请求指定的 `Etc/UTC` 错算一天。
- 关联维度：SQ-04、SQ-14、SQ-16。
- 定位：`src/core/assistant_record_service.ts:937-955,1018-1029`；`test/core/bridge_coordinator.test.ts:3167-3187`。
- 证据：E-08、E-09。`createAssistantWallClockDate` 先把指定时区格式化为无时区字符串，再由 `new Date(string)` 按宿主时区解析；同一测试在 `TZ=UTC` 通过，在 `TZ=Asia/Shanghai` 失败，期望 `2026-04-28 UTC`、实际得到 `2026-04-27 UTC`。
- 影响：测试结果取决于执行机器时区；更重要的是，在非 UTC 主机处理显式 UTC 元数据时会产生错误日期。
- 来源：既有；相关实现不在当前已跟踪变更中。
- 建议及验证：使用基于 `Intl.DateTimeFormat(...).formatToParts()` 的显式墙钟运算或成熟时区库，避免无时区字符串往返；至少在 `UTC` 与 `Asia/Shanghai` 两个时区运行相关测试和完整套件。

### F-04：生产依赖审计存在 1 个 critical 和 5 个 high 告警

- 严重程度及依据：高；直接依赖 `@modelcontextprotocol/sdk@1.29.0` 命中高危 OAuth 告警，其传递依赖还带入 `proxy-addr@2.0.7` critical 等告警，审计均报告可修复版本。
- 关联维度：SQ-16；这是发布安全专项问题，不用于替代八维工程质量判断。
- 定位：`package.json:51-57`；`package-lock.json` 中 `@modelcontextprotocol/sdk@1.29.0`、`proxy-addr@2.0.7`、`hono@4.12.18`、`fast-uri@3.1.0`、`ws@8.20.0`。
- 证据：E-10。使用 npm 官方 registry 运行生产依赖审计，结果为 critical 1、high 5、moderate 3、low 1；`@modelcontextprotocol/sdk` 是直接依赖，修复版本可用。
- 影响：即使部分漏洞路径未被本项目调用，公开发布仍需要完成可达性判断和升级回归，不能把已知 critical/high 告警留给安装者自行发现。
- 来源：本次变更相关；`@modelcontextprotocol/sdk` 在当前差异中由传递依赖提升为直接依赖并被 Claude 通道使用。
- 建议及验证：升级到已修复的 SDK/传递版本，重新锁定依赖；运行 `npm audit --omit=dev`、类型检查、完整测试、Claude 通道和本地 MCP 通道烟测。若某告警不可达，应形成带调用路径依据的例外记录，而不是仅忽略审计。

### F-05：公开源码发布缺少许可与发布边界

- 严重程度及依据：高；仓库没有 LICENSE，根包同时设置了 `private: true`，因此“发布到 GitHub”和“发布到 npm”目前都没有完整交付定义。
- 关联维度：SQ-11、SQ-12。
- 定位：`package.json:1-5`；仓库根目录；npm dry-run 打包结果。
- 证据：E-11。没有找到 LICENSE/CHANGELOG/SECURITY/CONTRIBUTING；`npm pack --dry-run` 会生成包含 456 个条目的 8.90 MB 解包内容，根包没有 `files` 白名单。
- 影响：GitHub 公开仓库的复用权限不明确；若目标是 npm 发布，`private: true` 会直接阻止发布，且当前包面会捎带测试、设计文档、试验包和生成资源。
- 来源：既有。
- 建议及验证：先明确仅 GitHub 源码发布还是同时 npm 发布；前者至少补许可证、变更说明和支持边界，后者还要取消 `private`、设置 `files/exports/bin` 并检查 `npm pack --dry-run` 文件清单。

### F-06：核心能力仅支持 macOS，但 CI 没有 macOS/桌面协议兼容门禁

- 严重程度及依据：中；关键共享链路依赖 macOS 和桌面应用内部、版本化 IPC 协议，但自动化矩阵仅覆盖 Ubuntu/Windows。
- 关联维度：SQ-11、SQ-14、SQ-16。
- 定位：`README.md:501-539`；`.github/workflows/ci.yml:9-37`。
- 证据：E-02、E-12。README 明确限制为 macOS + ChatGPT/Codex desktop，并说明桌面更新可能要求兼容更新；CI 矩阵只有 `ubuntu-latest` 和 `windows-latest`。本地评审环境 Node 23.11.0，也低于声明的 Node >=24。
- 影响：最关键平台和协议变化不会在常规 CI 中被发现；当前本机测试通过也不能代表受支持运行时。
- 来源：本次能力新增后形成的发布缺口。
- 建议及验证：增加 macOS + Node 24 作业，至少运行 IPC/relay/runtime 测试；发布前在干净用户环境执行一次真实桌面所有者发现、提交、输出同步、结束通知、重启续传、`/exit` 和锁屏场景烟测，并记录兼容的桌面版本。

### F-07：关键协调文件过大，后续维护仍高度依赖集中式入口

- 严重程度及依据：中；新功能虽已拆出专用模块，但命令、会话和路由接线仍集中在超大协调器与运行时文件中。
- 关联维度：SQ-04、SQ-03、SQ-16。
- 定位：`src/core/bridge_coordinator.ts`（21,718 行）；`src/providers/codex/app_client.ts`（4,619 行）；`src/runtime/weixin_bridge_runtime.ts`（2,450 行）。
- 证据：E-04、E-13。桌面同步已拆成 IPC、relay、sync、delivery、checkpoint、notice 模块，这是正向结构；但代表性命令改动仍跨 coordinator、session service、router、runtime、provider 和 i18n，当前已跟踪差异涉及 21 个文件。
- 影响：新增一个会话状态或命令行为时，调用链和副作用仍需跨大文件重建，增加漏改和回归定位成本。
- 来源：既有热点，本次变更暴露了维护成本。
- 建议及验证：不做整体重写；先把 `/enter`、`/exit`、`/status` 及共享绑定状态迁入独立 command/service 边界，让 coordinator 只编排契约。用现有回归测试验证对外消息和持久化行为不变。

### F-08：安装示例没有携带桌面共享所需配置

- 严重程度及依据：中；README 说明功能必须显式开启，但稳定服务环境模板和其变量清单没有该开关。
- 关联维度：SQ-11、SQ-16。
- 定位：`README.md:501-505,623-629`；`config/examples/weixin.service.env.example:1-90`。
- 证据：E-14。README 要求 `CODEXBRIDGE_CODEX_DESKTOP_SHARED_THREAD=1`，而服务环境示例没有桌面共享、IPC socket、transport、poll/timeout 等配置。
- 影响：新用户按安装说明部署后容易得到“功能代码存在但未启用”的状态，排障必须反查 README 其他章节。
- 来源：本次功能新增后的文档同步缺口。
- 建议及验证：在 macOS 服务模板中加入带安全说明的共享开关和默认 transport，并让安装章节的稳定变量清单链接到共享章节；从干净检出按文档完成一次安装验收。

## 2. 对象与范围

| 字段 | 内容 |
| --- | --- |
| 项目、评审日期 | CodexBridge `0.1.15`，2026-10-11（Asia/Shanghai） |
| 评估模式与范围 | 完整八维工程质量评估，重点核查微信与 Codex/Claude 桌面共享会话、发布门禁、安装文档和公开发布准备度 |
| 评审前快照与比较基线 | HEAD `92166e02f4c7c8fcc0d223e894dd33664db754ea`；已跟踪差异 SHA-256 `e6d53772ac78f2c6c721af65c3e39b734fdda821e52b643a1ec2f93924dacc1f`；未跟踪纳入材料聚合哈希 `d0c807c89605aa906a0a1ac6e8cb0702c6a9d04c43cc93ab981bb25c368bcf5f` |
| 评审前已有改动 | 21 个已跟踪文件修改，另有 13 个未跟踪路径条目；未跟踪的 Claude provider、Codex desktop IPC/relay、runtime sync/checkpoint/notice、设计文档和测试均纳入评估 |
| 用途与约束 | 已知用途是个人微信远程进入/退出既有 PC 会话并同步输出；目标按用户表述为提交到个人 GitHub。公开发布按“其他人可从干净环境安装和可靠使用”判断；不假设 npm 发布，相关差异单列 |
| 已检查与排除 | 检查 README、服务模板、CI、根构建配置、微信授权、共享链路、日期失败路径和相关测试。未全面审阅 Web UI、Mission Control、所有 provider 业务规则、生成资源及第三方实现 |
| 本轮评审输出 | `docs/reviews/source-code-quality-review-20261011-161430.md`；未修改被评审源码、测试、配置或依赖 |
| 材料变化与重核 | 写报告前复核的已跟踪差异哈希仍为上述值；报告本身是新增评审产物，不作为本轮正证据 |
| 扩展/维护场景及依据 | 代表性扩展采用当前工作区已实现的 Claude Code 共享 provider；代表性维护采用本轮已出现的重复分段、忙状态、结束通知与重启续传问题 |
| 方法版本 | `source-code-quality-review` Skill 1.4；`SOURCE-QUALITY-2.1` |

### 覆盖记录

| 路径/业务流程 | 选择依据与关联维度 | 文件与调用/依赖边界 | 检查深度 | 正常、失败及边界分支 | 未覆盖内容与评分限制 |
| --- | --- | --- | --- | --- | --- |
| 微信进入/退出共享会话 | 产品核心流程；SQ-03/04/12/14/16 | coordinator -> provider shared-session contract -> desktop relay -> runtime sync -> WeChat delivery | 源码阅读、契约追踪、91 项相关测试实际执行 | 正常提交、已有忙轮次、断连歧义、重启续传、重复抑制、语音转写、结束通知 | 未做真实微信账号和真实桌面版本端到端长稳测试 |
| 微信访问控制 | 公开发布安全边界；SQ-11/15/16 | config -> plugin `isScopeAllowed` -> inbound dispatch | 全仓搜索和分支核查 | open、allowlist、disabled；pairing 的缺失处理 | 未做完整威胁模型或渗透测试 |
| 构建、测试与发布包 | 发布门禁；SQ-11/12/14/16 | package scripts、tsconfig、CI、lockfile、npm pack | 配置阅读和命令实际执行 | typecheck、全量测试、时区对照、依赖审计、dry-run 打包 | 未在干净 Node 24、macOS CI 或 Windows 主机重跑 |
| 文档和服务安装 | 交接与可部署性；SQ-11 | README、WeChat 命令文档、服务 env 示例、设计文档 | 静态一致性核查 | 开关、限制、恢复、锁屏、Claude 共享 | 未实际执行全新机器安装脚本 |
| Claude provider 扩展 | 代表性演进；SQ-03/12/13/15 | provider contract、Claude shared sessions、runtime common sync | 差异与接口追踪、测试文件核查 | 会话列举、共享、输出、完成、停止 | 未运行真实 Claude development channel |

## 3. 八维评分

| 编号 | 维度 | 分数 | 状态 | 对应锚点与评分理由 | 正证据 | 反证/核实缺口 | 充分度与限制 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SQ-11 | 文档完整性与一致性 | 2 | 已评分 | 共享行为、限制和命令说明较完整，但公开许可、发布说明和服务配置入口缺失，关键安装信息仍需反查，未达到“基本可用且主要内容一致”的 3 分 | E-02、E-03 | F-05、F-08；README 的验证命令当前失败 | 充分；限于当前仓库文档与 GitHub 发布目标 |
| SQ-04 | 代码清晰度与可读性 | 3 | 已评分 | 新增桌面模块命名和职责能沿正常/失败路径理解，关键协议歧义有明确表达；但时区字符串往返隐藏宿主语义，超大协调文件形成局部难读热点，未达到关键路径无需反复跨处推断的 4 分 | E-04、E-05 | F-03、F-07 | 有限；未逐行评审全仓 10 万余行源码 |
| SQ-12 | 架构合理性 | 3 | 已评分 | 平台、provider、desktop relay 与 delivery/checkpoint 分层基本匹配用途；但根构建边界把暂停包纳入主门禁，macOS 核心能力没有对应平台验证，存在局部结构风险，未达到 4 分 | E-04、E-05 | F-02、F-06 | 充分覆盖共享链路，非共享子系统仅目录级核查 |
| SQ-03 | 模块划分、内聚与耦合 | 3 | 已评分 | IPC、rollout、同步、发送、检查点和通知均有明确模块，规则可定位；共享命令接线仍集中于 21,718 行 coordinator 并跨多个大文件，未达到内部细节充分受保护的 4 分 | E-04、E-13 | F-07 | 充分覆盖本次共享功能；不代表所有 provider |
| SQ-13 | 扩展性 | 4 | 已评分 | 实际新增 Claude 共享 provider 复用了 shared-session/provider 契约和 runtime 同步机制，Codex 与 Claude 的差异保留在各自适配器，代表性扩展可解释；未到 5 分，因为根接线仍需多处人工修改且完整门禁未通过 | E-05、E-15 | F-02、F-07；未做外部第三方 provider 扩展实验 | 充分；结论只适用于“新增桌面共享 provider”这一变化 |
| SQ-14 | 可测试性 | 3 | 已评分 | IPC、时钟、reader、submitter、发送和持久化依赖可替换，相关 91 项测试可快速隔离运行；但时区依赖泄漏且完整套件失败，未达到关键时间状态可控的 4 分 | E-04、E-08 | F-02、F-03、F-06 | 充分覆盖结构与本机执行；真实桌面/微信边界未执行 |
| SQ-15 | 复用与一致性 | 3 | 已评分 | Codex/Claude 共用共享会话契约、同步与完成通知，重复发送通过统一 checkpoint 处理；但 `pairing` 配置语义与授权实现不一致，未达到共同规则契约清楚的 4 分 | E-04、E-15 | F-01 | 有限；未系统做全仓重复规则扫描 |
| SQ-16 | 变更与维护成本 | 3 | 已评分 | 重复片段、结束通知和重启续传已有专用模块与回归用例，代表性修复入口可定位；大 coordinator、失败的根门禁和缺少平台兼容测试仍提高影响分析成本，未达到结构牵连受控的 4 分 | E-04、E-05 | F-01 至 F-08 | 充分覆盖当前发布变更；没有长期维护工时数据 |

## 4. 总体判断

总体结论：基本可维护但有局部风险。

桌面共享能力本身已越过“原型”阶段：IPC 提交、只读观察、输出分段、重复抑制、检查点恢复和结束耗时通知均有独立实现与针对性测试，Codex 与 Claude 共享也证明了 provider 契约具有实际扩展能力。当前个人环境继续使用或做小范围内测是合理的。

但当前快照不应直接标记为公开 beta 或稳定版：仓库级类型检查失败，完整测试在 Asia/Shanghai 下失败，微信私聊授权默认值和 `pairing` 语义不安全，生产依赖审计有 critical/high 告警，且公开仓库缺少许可证。上述问题属于发布门禁，不是再补一个用户功能就能解决。完成 P0 后可进入公开 beta；要称为稳定版，还需 macOS + Node 24 自动化、干净机器安装和真实桌面协议烟测。

本报告不是安全审计、业务正确性证明或发布批准；依赖审计与授权默认值只是发布准备度中已发现的明显专项问题。

产物与个人贡献：本报告仅评价工程产物；个人提出、审阅或理解相关设计的行为证据未在此评估，不能据此确定个人 AI 编程驾驭能力。

## 5. 证据登记

| 证据 ID | 版本与定位 | 类型 | 可核对事实 | 限制 |
| --- | --- | --- | --- | --- |
| E-01 | HEAD `92166e0`；2026-10-11 16:14 +0800 | 直接事实 | 工作区有 21 个已跟踪修改和 13 个未跟踪路径条目；已跟踪差异哈希已记录 | 未跟踪目录条目可包含多个文件 |
| E-02 | `README.md:501-539` | 直接事实 | 文档说明 `/enter`、`/exit`、输出同步、结束耗时、重启检查点、锁屏条件和 IPC 兼容限制 | 文档存在不证明真实桌面已验收 |
| E-03 | `docs/design/*`、`docs/usage/weixin-slash-commands.md` | 直接事实 | 当前变更包含后台共享、输出同步、Claude 共享设计材料和命令说明 | 设计材料不能替代实现和运行证据 |
| E-04 | `src/providers/codex/desktop_*`、`src/runtime/desktop_*`；相关测试命令 | 直接事实 | 专用模块覆盖 IPC、relay、sync、delivery、checkpoint、notice；91 项选定测试全部通过，耗时约 0.76 秒 | 运行在 Node 23.11.0，不是声明的 Node 24 |
| E-05 | `src/types/provider.ts`、`src/providers/claude/*`、`src/providers/codex/plugin.ts` | 直接事实 | provider 共享契约承接 Codex 和 Claude 两种实现，runtime 复用同步/通知组件 | 未执行真实 Claude channel |
| E-06 | `src/platforms/weixin/config.ts:25,29`；`src/platforms/weixin/plugin.ts:761-777` | 直接事实 | 默认 DM policy 为 open；pairing 被接受但没有独立校验分支，最终返回 true | 未开展完整认证安全审计 |
| E-07 | `npm run typecheck -- --pretty false` | 直接事实 | 退出码 2；6 个 relay 示例无法解析 `@codex-provider/core`，多处测试存在 Promise 联合类型错误 | 本机 Node 23 低于声明版本，但这些是 TypeScript 解析/类型错误 |
| E-08 | `npm test` | 直接事实 | 683 项：645 通过、4 失败、34 跳过；4 个失败均在 `bridge_coordinator` 助理记录日期相关用例 | 未在 Node 24 重跑完整套件 |
| E-09 | 相同单测分别设置 `TZ=UTC` 与 `TZ=Asia/Shanghai` | 直接事实 | UTC 下 1/1 通过；Asia/Shanghai 下 1/1 失败，显式 `Etc/UTC` 的“昨天”少算一天 | 只隔离复现了 4 个失败中的代表性一项 |
| E-10 | `npm audit --omit=dev --registry=https://registry.npmjs.org --json` | 直接事实 | 生产依赖告警合计 10：critical 1、high 5、moderate 3、low 1；严重项均显示 fixAvailable | 没有完成漏洞调用路径可达性分析 |
| E-11 | 根目录、`package.json:1-5`、`npm pack --dry-run --json` | 直接事实 | 无常见许可/变更/安全/贡献文件；根包 private；dry-run 为 456 项、3.29 MB 压缩、8.90 MB 解包 | GitHub 源码发布不要求 npm 包，但仍需要许可决策 |
| E-12 | `.github/workflows/ci.yml:13-37`；`README.md:528-535` | 直接事实 | CI 只有 Ubuntu/Windows + Node 24；核心桌面共享明确只支持 macOS | 手工 macOS 验收可能存在，但仓库内无记录 |
| E-13 | `wc -l` 与当前差异统计 | 直接事实 | coordinator 21,718 行、Codex app client 4,619 行、WeChat runtime 2,450 行；已跟踪差异为 1,717 增、184 删 | 行数只是热点线索，结论结合了实际调用追踪 |
| E-14 | `README.md:501-505,623-629`；`config/examples/weixin.service.env.example` | 直接事实 | README 要求共享开关，稳定服务变量清单和 env 示例没有该开关 | 用户可手工添加环境变量 |
| E-15 | 当前 Claude provider 变更及测试目录 | 条件推断 | 已完成的第二 provider 表明共享契约能承接同类扩展 | 完整根门禁失败，不能称为已完成发布验证 |

## 6. 实际检查与未验证项

| 检查 | 版本、规则/配置及环境 | 命令与原始结果定位 | 状态 | 范围与限制 |
| --- | --- | --- | --- | --- |
| TypeScript 根门禁 | TypeScript 6.0.3；`tsconfig.json`；Node 23.11.0 | `npm run typecheck -- --pretty false` | 失败，退出码 2 | relay 示例解析和测试类型错误；CI 同样调用该脚本 |
| 完整默认测试 | 项目 `scripts/test.mjs`；Asia/Shanghai | `npm test` | 失败，683 项中 4 项失败 | 645 通过、34 跳过；未在 Node 24 重跑 |
| 时区隔离复现 | 同一单测，显式 `Etc/UTC` 元数据 | `TZ=UTC npm test -- --test-name-pattern ...` 与 `TZ=Asia/Shanghai ...` | UTC 通过；Asia/Shanghai 失败 | 证明至少一项为宿主时区泄漏 |
| 桌面共享相关回归 | IPC、relay、checkpoint、WeChat runtime 四组测试 | `npm test -- --test test/providers/codex/desktop_ipc_client.test.ts test/providers/codex/desktop_thread_relay.test.ts test/runtime/desktop_sync_checkpoint.test.ts test/runtime/weixin_bridge_runtime.test.ts` | 通过，91/91 | 使用替身，不等于真实微信/桌面端到端 |
| 生产依赖审计 | npm 10.9.2；官方 npm registry | `npm audit --omit=dev --registry=https://registry.npmjs.org --json` | 失败，1 critical、5 high | 原配置镜像不支持 audit，因此显式使用官方 registry；未做可达性分析 |
| npm 包面预览 | npm pack dry-run | `npm pack --dry-run --json` | 命令通过 | 根包 private，结果只用于观察文件边界 |
| 差异格式检查 | Git 当前已跟踪差异 | `git diff --check` | 通过 | 不检查未跟踪文件内容格式 |
| 受支持运行时 | `package.json` 要求 Node >=24 | `node --version` | 未验证；本机为 23.11.0 | 需要 Node 24 干净环境复核全部门禁 |

候选问题与证据缺口：尚未核实桌面应用升级后的协议兼容矩阵、真实微信断线重连的长时间稳定性、锁屏但不休眠时的连续可用性、Claude development channel 的组织策略差异，以及 10 个依赖告警在本项目调用路径上的实际可达性。正式发布前应以真实环境烟测和最小安全审查补齐，不把模拟测试外推为端到端证明。

专项边界：本次不是完整安全审计、性能压测、隐私合规评估或法律意见。已运行依赖审计并检查入口授权默认值；未扫描密钥历史、供应链脚本、数据留存合规、DoS 上限或所有 IPC 攻击面。本报告不是发布批准。

## 7. 优先改进

| 优先级 | 关联问题/维度 | 最小建议及取舍 | 怎样验证改善 |
| --- | --- | --- | --- |
| P0 | F-01 / SQ-11/15/16 | 把默认 DM 政策改为 allowlist，或完成真实 pairing；这是公开发布前的访问边界，不建议仅加警告文字 | 未授权联系人、空 allowlist、错误配对码全部被拒绝；授权用户正常使用共享/独立会话 |
| P0 | F-02 / SQ-12/14/16 | 修复 relay workspace/type errors，或把暂停包从主门禁拆开；保持主产品 CI 可独立判定 | 干净 Node 24 环境 `npm ci && npm run typecheck` 为 0 |
| P0 | F-03 / SQ-04/14/16 | 修复显式时区的墙钟运算，并将 UTC/Asia-Shanghai 纳入日期回归 | 两个 TZ 下完整测试均为 0 失败 |
| P0 | F-04 / SQ-16 | 升级 MCP SDK 与严重传递依赖，必要时记录有证据的不可达例外 | 生产审计无 critical/high，Claude/MCP 路径回归通过 |
| P0 | F-05 / SQ-11/12 | 明确 GitHub-only 或 npm 发布，补许可证和首版变更说明 | 仓库页显示明确许可；发布清单与目标渠道一致 |
| P1 | F-06 / SQ-11/14/16 | 增加 macOS + Node 24 CI，并记录兼容桌面版本的手工烟测 | CI 绿色；真实提交、同步、结束通知、重启、退出、锁屏用例留有结果 |
| P1 | F-08 / SQ-11/16 | 同步服务 env 示例、安装变量清单和共享配置说明 | 从干净检出只按 README 可启用功能并通过 `/status` 验证 |
| P1 | F-05 / SQ-11/12 | 若发布 npm，定义 `files/exports/bin`；若仅 GitHub，保留 private 并在 README 明说 | dry-run 只含运行所需文件；安装命令与发布渠道一致 |
| P2 | F-07 / SQ-03/04/16 | 渐进提取共享会话命令/绑定服务，不整体重写 coordinator | 现有相关测试无行为变化，新命令状态修改集中在明确模块 |

