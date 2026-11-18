# Project Pulse · Codex / Claude Code 项目管理插件

<img src="assets/logo.png" width="96" height="96" alt="Project Pulse">

**一个在 Codex、Claude Code 中都能使用的项目管理插件。** 一屏查看各项目里 Codex、Claude Code 以及 magpie 所管理 agent 的进行中会话、完成未读结果和关联待办，点击即可回到原对话。

A desktop plugin for Codex and Claude Code that tracks project activity, unread results, and linked todos across Codex, Claude Code and the agents magpie manages. See what is running across projects and jump directly to the original chats.

[MIT](LICENSE) · [版本记录](CHANGELOG.md) · [图标能力与限制](docs/branding.md) · [验收记录](docs/design-qa.md)

## 界面预览

**项目总览** · 在同一屏查看各项目的进行中会话、完成未读和待办。

![Project Pulse 项目总览：自适应多列卡片展示各项目的会话与待办状态](docs/images/project-overview.png)

**关联待办** · 为项目或会话记录下一步行动，设置优先级与截止日期。

![Project Pulse 关联待办：待办绑定项目，并显示优先级与截止日期](docs/images/linked-todos.png)

截图已裁切并脱敏；私人项目名、路径和待办内容已替换为匿名示例，头像已移除。

## 能做什么

- **跨项目总览**：读取本机 Codex 已导入项目，以及 Claude Code 与 magpie 所列会话的工作目录，展示进行中会话、完成未读、待办和最近活动。
- **多个 agent 汇在一起**：同一目录下 Codex 与 Claude Code 的会话归到同一个项目；不在 Codex 项目里的目录按所在 git 仓库成组。每条会话标出来自哪个 agent。
- **真实未读**：跟随 Codex 桌面阅读状态；账号、主机或数据格式无法确认时显示未知，不用历史记录猜测。
- **直接回到对话**：点击会话标题打开原聊天（Codex 跳转桌面 App，Claude Code 在终端 `claude --resume`，其他 agent 复制恢复命令），行尾加号创建关联待办。
- **项目与会话待办**：支持优先级、截止日期、状态、编辑、删除和 JSON 导出；数据独立保存在本机。
- **从待办开始工作**：在 macOS 上点击待办的「开始」。已关联 Codex 对话时打开原对话，并复制带 ID 的指令供粘贴。仅关联项目时在项目内打开新对话并预填指令。补充要求并发送后，Codex 通过插件将该待办标为进行中。
- **紧凑的原生面板**：白底、中性灰、顶部导航、自适应多列卡片、统一搜索下拉与日历。卡片按未读蓝色、进行中紫色、待办淡橙色显示。

插件由 Skill、stdio MCP 和 MCP App 组成，声明官方 `global` / `thread` 入口。入口位置和图标渲染由客户端决定。另提供相同界面的 localhost 网页供开发和兼容使用。

## 支持的 agent

| 来源 | 读什么 | 状态 | 未读 | 点击会话 |
| --- | --- | --- | --- | --- |
| Codex | `CODEX_HOME`（默认 `~/.codex`）的 SQLite，只读 | 回合记录 | 跟随桌面阅读状态 | 打开 Codex 原对话 |
| Claude Code | `CLAUDE_CONFIG_DIR`、`~/.claude` 与 magpie 各订阅账号目录下的 `projects/*/*.jsonl`，只读开头和结尾 | 最后一条消息：正常结束 / 中断 / 出错；运行中按 30 分钟内有写入判断 | 无（不计入未读） | 终端里 `claude --resume`（非默认目录会带上 `CLAUDE_CONFIG_DIR`） |
| magpie | `magpie sessions --json` 列出的其他 agent（Antigravity、OpenCode、Pi、Cursor 等），后台刷新 | 未知 | 无 | 复制 magpie 给的恢复命令，不代为执行 |

- 只读最近 30 天有活动的 Claude Code / magpie 会话（`PULSE_DAYS` 可调）；只开过没聊的空会话不显示。系统临时目录里的会话不算项目（`PULSE_SKIP_TEMP=0` 保留）。
- `PULSE_SOURCES=codex,claude,magpie` 选择数据源；`PULSE_CLAUDE_DIRS`（`:` 分隔）替换 Claude 配置目录列表；`PULSE_MAGPIE_HOME`、`PULSE_MAGPIE_BIN` 指定 magpie 目录与命令。
- 某个来源读不了只在设置里说明，不挡其他来源；全部读不了才报不可用。

## 从 GitHub 安装（Codex）

需要支持插件命令的 Codex CLI、Codex 桌面 App、Git 和 **Python 3.10+**。当前主要在 macOS 验证；其它平台的原生聊天跳转尚未验证。无需 API Key、pip 运行时依赖或 Node.js。

```sh
codex plugin marketplace add saberc8/codex-project-pulse --ref main
codex plugin add codex-project-pulse@project-pulse
```

仓库自带 `.agents/plugins/marketplace.json`，市场名为 `project-pulse`。上面第一条命令也可使用完整 GitHub 仓库 URL。这是 GitHub 市场安装，不代表已经上架官方 Plugin Directory。

安装或更新后，**完整退出并重新打开 Codex 所在的桌面 App**，再打开 Project Pulse 系统入口，或在聊天中输入 `$project-pulse` / “打开项目总控台”。CLI 成功只表示磁盘文件已更新；面板内刷新按钮只刷新数据，不能替换正在运行的旧 MCP 进程或旧页面。

更新：

```sh
codex plugin marketplace upgrade project-pulse
codex plugin add codex-project-pulse@project-pulse
```

核对安装和 MCP 路径：

```sh
codex plugin list --marketplace project-pulse --json
codex mcp get project_pulse --json
```

也可在客户端提供的 GitHub 市场导入入口填写 `https://github.com/saberc8/codex-project-pulse`，再安装该市场内的插件；入口名称与可用性取决于客户端版本和账号，本文以可验证的 CLI 流程为准。企业管理员的 “Import and sync from GitHub” 属于工作区分发流程，个人安装不需要走该流程。

依据：[官方市场安装文档](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli)及[本地插件更新说明](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually)。

## 在 Claude Code 中安装

```sh
claude plugin marketplace add saberc8/codex-project-pulse
claude plugin install codex-project-pulse@project-pulse
```

或在会话里 `/plugin install codex-project-pulse --marketplace saberc8/codex-project-pulse`。仓库自带 `.claude-plugin/plugin.json` 与 `.claude-plugin/marketplace.json`；MCP 服务通过 `src/project_pulse/stdio_server.py` 按路径启动，不依赖工作目录。装好后用 skill 或直接让 Claude 调用 `open_dashboard`。

## 通过 magpie 分发给所有 agent

magpie 的 library 把一个 MCP 服务和 skill 写进它管理的每个 agent。克隆仓库后：

```sh
magpie library mcp add project_pulse python3 <仓库路径>/src/project_pulse/stdio_server.py
```

再把 `skills/project-pulse` 放进 magpie library 的 skill 目录（或 `~/.agents/skills` 后 `magpie library skill hand-over project-pulse`）。会显示插件界面（MCP Apps）的宿主会出现 Project Pulse 面板；其他宿主通过 `open_dashboard` 返回的本机链接打开。

## 图标状态

页面内导航已支持线性 / 实心切换与真实未读蓝点，打开面板不会清除未读。系统入口通过标准 MCP `icons` 提供浅色 / 深色 PNG，并在未读状态变化时发出工具列表更新通知；0.1.11 修复了首次连接时服务器回退图标没有带上未读状态的问题。

**Codex 最左侧系统入口的蓝点颜色和实时刷新仍待原生验证；选中后线性 / 实心切换尚未实现。** 当前公开规范没有找到独立未读角标或 selected / active 双态资源字段。PNG 是对截图中图标被灰化问题的兼容尝试，不能保证宿主保留颜色。页面内效果和 favicon 不能替代这一验收。详见 [图标调研](docs/branding.md)。

## 数据与权限

- Codex 原始数据从 `CODEX_HOME`（默认 `~/.codex`）读取，SQLite 始终以 `mode=ro` 和 `query_only` 打开。Codex 退出后会话库是 WAL 模式却没有 `-wal` / `-shm` 时，以 `immutable=1` 读取（没有未合并的写入，读到的就是完整数据），仍然不写。不改写聊天、阅读状态或原表。
- Claude Code 会话文件只读开头 256KB 与结尾 512KB，按文件大小和修改时间缓存；最后一条记录过长时才整份读一次。不读工具输出与思考内容，答复只取最后一条助手文字。
- magpie 只调用 `magpie sessions --json`，不读 magpie 的私有文件；它给的恢复命令只供复制。
- 个人待办、置顶和历史处理记录保存在 `~/.local/share/codex-project-pulse/pulse.sqlite3`。测试可通过 `PULSE_DATA_DIR` 隔离。
- 未读使用 `.codex-global-state.json` 中当前账号、本地主机的桌面阅读索引；不会回退到旧 SQLite receipt。当前适配单一可确认账号身份，格式变化或身份不明确时显示未知。
- “完成”表示最近一轮完成，不推断整个项目完成。完成未读收件箱只计完成且未读的会话；入口未读提示还包括运行中仍有旧结果未读的会话。
- 默认排除归档会话与内部子代理。已归档聊天的关联待办仍可完成。
- 面板不请求或渲染答复正文；点击标题直接跳转。底层兼容接口可读取最终答复，不返回推理或工具输出。
- HTTP 服务仅监听 `127.0.0.1`，校验 Host / Origin，写入要求短期 token。前端依赖随包提供，无 CDN、遥测或外部数据上传代码。通过 MCP 查询时，工具返回内容会交给调用它的 Codex 客户端。

本机数据结构**不是稳定公开 SDK**，Codex、Claude Code 或 magpie 升级都可能需要更新适配器。当前不覆盖云项目、远程主机或实时审批队列；两小时没有更新的运行状态显示未知。标题、答复及附件均视为数据，不作为指令执行。

## 本地开发

```sh
git clone https://github.com/saberc8/codex-project-pulse.git
cd codex-project-pulse
PYTHONPATH=src python3 -m project_pulse
```

打开 `http://127.0.0.1:4318`。无前端构建步骤；全部运行代码位于 `src/project_pulse/`，不需要符号链接。

本地安装当前检出目录：

```sh
codex plugin marketplace add "$PWD"
codex plugin add codex-project-pulse@project-pulse
```

本地源和 GitHub 源使用相同市场名；切换来源后请检查 `codex plugin marketplace list --json`，确认来源符合预期。

```text
src/project_pulse/         Python 服务、数据适配、MCP 和 web/ 前端
assets/                   Logo 与入口图标
tests/                    数据、协议、状态和 bridge 测试
docs/                     设计验收与图标调研
skills/project-pulse/     插件调用 Skill
.agents/plugins/          GitHub / 本地市场清单
plugin.json / mcp.json     标准插件清单
.codex-plugin/ / .mcp.json 兼容清单
```

验证：

```sh
python3 -m unittest discover -s tests -v
node --check src/project_pulse/web/app.js
node --check src/project_pulse/web/components.js
node --check src/project_pulse/web/brand.js
node --check src/project_pulse/web/mcp-bridge.js
node --test tests/*.test.cjs
```

测试使用临时数据目录，不修改真实项目、待办或未读状态。变更数据适配时，请补充匿名 fixture；报告兼容性问题时请先删除账号标识、路径、标题与答复内容。

## 许可证

本项目按 [MIT License](LICENSE) 开源，是独立社区项目，与 OpenAI 无隶属关系。Lucide 0.468.0（ISC）、Tom Select 2.4.3（Apache-2.0）、Flatpickr 4.6.13（MIT）的固定分发文件及原许可证保存在 `src/project_pulse/web/vendor/`。
