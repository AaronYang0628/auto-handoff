# auto-handoff

**把当前 Codex 任务交给一个新会话，带上关键决策、约束和下一步。**

中文 · [English](README.en.md)

长任务需要换一个会话继续时，重新讲一遍背景容易漏掉约束、试过的方案或未完成的工作。auto-handoff 提供一个 Codex 技能和配套 CLI：整理结构化交接包，用你指定的 profile 初始化新会话，再返回准确的恢复命令。

```text
当前任务 → checkpoint → 新会话只读核验 → 用准确 session ID 恢复
```

旧会话和未提交改动保留。你决定何时交接、用哪个 profile，以及何时继续写代码。

> **当前状态：早期版本，面向 Codex CLI。** 2026-10-02 的 v0.1 发布快照：Linux 上 Node.js 22.18.0 / 24.19.0 的 67 项核心测试及 9 项页面测试通过（共 76 项）；Codex CLI 0.159.2 的命令帮助接口已核对。真实账号的创建、模型初始化和交互恢复尚未完成端到端验证；macOS、Windows 原生和 WSL 也未验证。详见[兼容性](docs/compatibility.md)和[验证记录](docs/verification.md)。

## 让你的 Codex 帮你安装

**把下面这句话复制到 Codex，让它按 README 安装 CLI 和技能：**

```text
请从 https://github.com/AaronYang0628/auto-handoff 安装 CLI 和用户级技能，按照 README 检查 Node.js 版本并完成安装，运行 csm doctor；不要改我的 profile 或模型配置，也先不要执行真实交接。
```

**不需要启动服务。** auto-handoff 是按需运行的本地 CLI 和 Codex 技能，不需要 Docker、监听端口或后台守护进程。安装不会自动开始监测或执行交接；真实交接由你另外发起，并会使用所选 Codex 模型服务。

可选的 `csm watch` 只有在你主动运行时才开始：带 `--once` 检查一次后退出，不带则在当前终端持续轮询，按 Ctrl+C 停止。普通 checkpoint / handoff 不依赖 watch。

## 安装一次

准备好：

- Node.js **22.18+** 和 npm
- Git
- 已安装的 Codex CLI；只有执行真实交接时，才需要你自己选定并确认可用的 profile

在终端运行：

```bash
git clone https://github.com/AaronYang0628/auto-handoff.git
cd auto-handoff
npm ci
npm link
csm install --scope user
csm doctor
```

`csm` 是本项目的 CLI，`auto-handoff` 也是同一个命令的别名。当前安装方式是从源码检出安装。

- `npm ci` 自动编译 JavaScript；若禁用了安装脚本，手动执行 `npm run build`
- `npm link` 将命令链接到当前检出目录，使用期间请保留该目录及其路径
- `csm install --scope user` 将技能安装到 `~/.agents/skills`，不改模型、profile 或 Codex 配置
- `csm doctor` 检查本机命令帮助是否包含所需接口；`supported` 不代表登录、profile 或真实模型调用已验证

重启 Codex 后，通过 `/skills` 检查是否能找到 `auto-handoff`。运行技能的环境也必须能通过 PATH 找到 `csm`。全局 npm 目录不可写时，使用适合自己的可写 npm 前缀，不必通过管理员权限强行安装。

只想安装到一个项目？使用 `csm install --scope project --cwd "/path/to/project"`。安装器遇到已有的非托管技能或修改过的托管文件会停止，避免覆盖它们。

## 已安装？更新 CLI 和技能

在原来的源码目录里更新，先确认 `git status --short` 中没有需要保留或处理的本地改动，再执行：

```bash
git pull --ff-only
npm ci
npm link
csm uninstall --scope user
csm install --scope user
csm doctor
```

新版本的技能内容有变化时，安装器不会直接覆盖旧包，所以需要先卸载旧的托管技能再安装。**若卸载结果的 `preserved` 非空，请先核对和备份自己修改的文件，停止安装并手动合并；不要删除它们来绕过保护。** 项目级安装使用对应的 `--scope project --cwd "/path/to/project"`；使用旧别名时在卸载和安装都加上 `--legacy-alias`。

保留现有源码路径，重新启动 Codex，再检查 `/skills`。升级不会删除运行状态、修改 profile、启动监测或执行真实交接。

## 在真实项目中试用偏离检查

在你正在开发的 Codex 对话中输入：

```text
$auto-handoff 在当前项目开启偏离检查试用。先从我已确认的目标、约束和验收标准建立带来源的稳定基线，向我确认缺少的信息；之后只记录有依据的增量动作和验证结果，出现异常再定点核对。不要自行改写基线，不要自动创建新会话。
```

这条入口与交接是两件事：**试用偏离检查不要求创建新会话，也不要求反复重读整份 CONTEXT.md。**

- 基线保留用户确认的要求及其来源；后续要求改变时明确更新，不让当前 Agent 的总结静默覆盖它
- 低成本规则检查有证据的无进展重复、可确定检查的约束，以及缺失或过期的验证；未采集到的字段保留 `unknown`
- 只在出现候选异常时，让当前技能消费小范围复核材料，并查看对应约束、近期证据和相关文件
- 上下文占用只是容量背景或 checkpoint 时机，不再单独给出 `handoff_suggested`，也不判断模型“变笨”
- CLI 不调用额外的评判模型，也不生成自评分；当前 Codex 对话中的复核仍使用现有模型，按该环境正常计入用量

具体来源绑定、实际支持的证据字段、复核与试用反馈见[项目试用指南](docs/drift-trial.md)。建议先选一个范围小、验收清楚的真实任务，记录正确提醒、误报、无法判断和漏报；合成测试不能证明真实项目里的提醒准确率。

也可以先在仓库里运行一个不读真实项目、不调用模型的合成演示：

```bash
node docs/drift-demo.mjs
```

它故意重复三次相同失败检查，生成 `no-gain-loop` 候选并记录一次“有意重试”的误报反馈；修改合成文件后，实测验证通过，候选消失。材料保留在输出的临时目录，不代表真实项目的检测效果。

## 在 Codex 中使用

在你要交接的 **Codex 对话中**输入，替换为自己的准确 profile 名：

```text
$auto-handoff 用 profile=YOUR_PROFILE 交接当前任务
```

也可以通过 `/skills` 选择 `auto-handoff`，再说明目标 profile。每次由你选择 profile，仓库不包含任何个人模型、provider 或账号配置。

技能会：

1. 确认当前 session ID、工作目录和目标 profile；无法可靠取得时请你补充，不猜“最近的会话”
2. 在停止已知写入后，整理目标、约束、决策、排除方案、重要文件和下一步，保存交接包
3. 启动新的持久会话，以只读方式核对材料、文件快照和初始化报告
4. 成功后返回真实的新 session ID、profile、工作目录及完整的 `codex resume` 命令

执行**工具实际返回的恢复命令**。恢复后先检查 `/status` 和 `/permissions`，再继续开发：只读初始化的权限可能被保留，不能假设 profile 自动恢复写权限。当前终端不会被自动替换。

真实 handoff 会使用所选 Codex profile/provider 调用模型，可能产生正常用量或费用。运行前请检查交接材料，尤其是重要文件列表。

> `$auto-handoff` 是技能入口；`/auto-handoff` 不是本项目注册的内置命令。若需要旧拼写 `$auto-handooff`，安装时添加 `--legacy-alias`。

## 先看一次无账号演示

在仓库根目录运行，无需登录或启动 Codex：

```bash
node docs/demo.mjs
```

**示例输出，节选自合成演示的 `preview` 对象：**

```json
{
  "dry_run": true,
  "profile": "synthetic-demo-no-launch",
  "launches": 0
}
```

完整输出还包括 checkpoint 路径、启动参数和初始化提示词。演示使用包含中文及空格路径的临时项目，不启动模型，也不生成可恢复的真实 session ID；临时材料保留供检查。

没有全局安装 CLI 也能试：完成 `npm ci` 后，运行 `node bin/csm.mjs --help`。

## 能做什么

| 能力 | 当前行为与边界 |
| --- | --- |
| 整理任务上下文 | 技能提炼当前对话，CLI 校验并保存交接包；不是完整聊天备份 |
| 指定 profile | 创建与恢复使用你明确选择的 profile，不自动选择或回退 |
| 只读初始化 | 新会话核验材料后等待你继续；不在初始化阶段推进开发 |
| 保留原工作 | 保留旧会话和未提交改动；不自动暂存、提交、回滚或切换终端 |
| 失败恢复 | 保存操作记录及已取得的新 ID；对不确定结果阻止盲目重复创建 |
| 监测与建议 | 只读显式绑定的日志；提供带依据的建议，不自动触发 handoff |
| 配置与状态栏 | 不修改 Codex 配置；原生状态栏用 Codex 内置项，csm 输出单独查看 |

名称中的 auto 指交接材料与初始化流程。**创建新会话始终需要你的明确选择，监测阈值本身不会授权交接。**

## 手动运行 CLI

希望检查每一步或接入自己的流程，可以从 [JSON 模板](examples/task-state.json)开始，按[任务状态格式](skills/auto-handoff/references/task-state.md)填写。

模板默认 `writers_stopped: false`。确认自己和已知后台操作已停止写入后，才能改为 `true`。将下面的大写占位项替换为真实值：

```bash
csm checkpoint --session SOURCE_ID --cwd "/path/to/project" --from "/path/to/task-state.json"
csm handoff --session SOURCE_ID --cwd "/path/to/project" --profile YOUR_PROFILE --dry-run
csm handoff --session SOURCE_ID --cwd "/path/to/project" --profile YOUR_PROFILE
```

`--dry-run` 预览启动信息，不创建模型会话。实际交接保持同一用户、`CODEX_HOME`、会话存储环境和工作目录；`--codex` 可指定 Codex 可执行文件。

重试时使用原 `--operation-id`。复用会返回历史结果，不再创建会话；若 `snapshot_revalidated: false`，需要检查之后的项目变化。有新 session ID 或状态为 `uncertain` 时，先按返回信息核对和恢复，不要换 operation ID 盲目重建。完整流程见[数据与失败恢复](docs/safety.md)。

## 可选：监测与状态栏

手动交接不依赖监测。需要监测时，明确选择你有权限读取、属于该 session 的日志文件：

```bash
csm watch --session SOURCE_ID --cwd "/path/to/project" \
  --source "/path/to/selected-log.jsonl" --once
csm status --session SOURCE_ID --cwd "/path/to/project" --json
```

去掉 `--once` 可持续轮询。工具校验日志中的 session ID 和 cwd，不扫描会话目录寻找最新日志。当前日志适配为部分支持，不能保证兼容所有 Codex TUI 版本。

- 无数据显示 `unknown`，估算和过期数据有明确标记
- 累计 token、缓存 token 与上下文占用分别处理
- 建议带规则和证据，不给未经校准的“健康分”，不把高占用等同于质量下降
- 规则参数只影响当次命令，不修改 Codex 配置

监测规则、人工标记、阈值配置和合成回放见[监测说明](docs/monitoring.md)。

原生 Codex 状态栏可手动合并以下内置项；已有 `[tui]` 时只修改字段，不重复创建 TOML 表：

```toml
[tui]
status_line = ["model-with-reasoning", "context-remaining", "current-dir"]
```

csm 不把自定义 shell 命令插入原生状态栏，也不自动附着任意已有 TUI。原生栏有数据不代表 csm 已取得同一指标。详见[状态栏兼容性](docs/compatibility.md#原生-statusline)。

## 数据与安全

- 状态默认存放在 `$XDG_STATE_HOME/auto-handoff`，未设置时为 `~/.local/state/auto-handoff`；可用 `--state-dir` 指定独立目录，避免放进会被提交的项目目录
- 只带完成任务所需的信息，不放凭据、认证文件、完整聊天记录或无关个人资料。敏感路径检查不能替代人工检查
- 本地保存交接包不代表离线运行：真实 handoff 的提示词及新会话读取的内容会由所选 Codex 配置的模型服务处理
- 工具不读取认证文件、不伪造 session ID、不用 `--last` 选会话，也不绕过审批或放宽权限
- 只读沙箱主要约束 Codex 的本地执行，不是对所有插件、hook 和远端系统的独立隔离层；使用可信的 Codex 配置

更多边界、失败状态和恢复步骤见[数据与失败恢复](docs/safety.md)。

## 开发与验证

```bash
npm ci
npm run typecheck
npm run check
npm test
```

源码为 TypeScript，安装包运行编译后的 JavaScript，无运行时第三方依赖。测试使用隔离临时目录、合成事件和模拟 Codex 入口，不需要模型账号，也不能代替真实创建与恢复的验证。

文档导航：[项目试用](docs/drift-trial.md) · [基线/证据协议](skills/auto-handoff/references/drift-trial.md) · [兼容性](docs/compatibility.md) · [验证记录](docs/verification.md) · [监测说明](docs/monitoring.md) · [数据与恢复](docs/safety.md) · [技能说明](skills/auto-handoff/SKILL.md) · [checkpoint 格式](skills/auto-handoff/references/task-state.md) · [项目页发布](docs/publishing.md)

## 卸载

先卸载技能，再移除 CLI 链接：

```bash
csm uninstall --scope user
npm uninstall --global auto-handoff
```

项目级安装使用 `csm uninstall --scope project --cwd "/path/to/project"`；装过旧别名时添加 `--legacy-alias`。卸载只移除安装器记录的未修改文件，修改过的文件会保留。

卸载不会清理状态材料或 Codex 原始会话。确认不再使用后，再自行决定是否删除这些数据。

## 许可证

尚未指定许可证。公开仓库本身不等于授予开源使用许可；复用或分发前请先确认授权。
