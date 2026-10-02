# 兼容性与验证边界

记录日期：2026-10-02。运行前仍应在自己的安装上执行 `csm doctor`。

## 当前验证范围

| 组合或能力 | 状态 | 已有证据及限制 |
| --- | --- | --- |
| Linux x86_64 / Node.js v24.19.0 / npm 11.9.0 | 本地开发环境 | 运行时版本已检查；最低支持 Node.js 22.18，安装包运行编译后的 JavaScript |
| Codex CLI 0.159.2：非交互启动参数 | 帮助接口已验证 | `exec --help` 有 `--profile`、`--cd`、`--sandbox read-only`、`--json`、`--output-schema`、`--output-last-message` 和 stdin 提示词 |
| Codex CLI 0.159.2：恢复参数 | 帮助接口已验证 | `resume --help` 接受明确 session ID、profile 和 cwd |
| 有效账号、模型、profile 的真实创建与恢复 | 未验证 | 当前未执行认证后的真实初始化或交互恢复；模拟测试不能证明这些能力在用户环境成功 |
| Windows 原生 | 未验证 | 路径、shell 引用、可执行入口和安装需单独实测 |
| WSL | 未验证 | 不从 Linux 容器测试推断 WSL 已验证，也不把 WSL 当作 Windows 原生 |
| macOS | 未验证 | 尚无该平台的端到端记录 |
| 现有 TUI 的只读日志采集 | 部分支持 | 需要显式绑定 session、cwd 和允许读取的日志来源；未知格式降级 |
| App Server 附着任意现有 TUI | 未实现 | 启动新 App Server 不代表订阅了原来的 TUI |
| 原生 TUI 自定义 csm 状态栏渲染 | 未实现 | 使用 Codex 原生内置项；csm 建议在独立终端/状态命令中显示 |

已执行的示例见 [验证记录](verification.md)；本仓库的自动化测试结果见实际 `npm test` 输出。fixtures 是合成输入，不是脱敏后伪装成真实会话的证明。

## 安装与构建

运行包使用 `dist` 中的 JavaScript。`npm ci` 的 `prepare` 和打包的 `prepack` 会执行构建；禁用生命周期脚本时需要自己执行 `npm run build`。源码测试使用 TypeScript，开发依赖包含编译器，但运行时没有第三方依赖。不能直接在 `node_modules` 中依赖 Node 对 `.ts` 文件的原生类型擦除。

## v0.2 偏离检查试用范围

偏离检查可在已安装 CLI 上按需运行，不需要真实 handoff、目标 profile、监听端口或后台服务。技能对证据的定点复核发生在当前 Codex 对话里，不代表 CLI 能自动附着所有 TUI 或理解任意原始日志。

当前支持的确定性约束是明确文件存在、不存在和字节哈希不变；语义型 `manual` 要求仍需定点复核。验收需要明确注册并显式运行的命令，调用者导入的通过结果不会当作 CLI 实测。文件范围和读取量有上限，未列出的文件、外部状态和缺失语义字段可能漏检。

这是用于收集实项目反馈的 advisory/shadow 试用，不是已校准偏离概率或自动换会话系统。Linux 合成回放不能替代实项目验收，也不表示 Windows、WSL 或 macOS 已验证。协议与步骤见[试用指南](drift-trial.md)。

## Profile 版本差异

本机 0.159.2 的帮助将 `--profile NAME` 解释为叠加 `$CODEX_HOME/NAME.config.toml`。官方文档说明 0.134.0 起使用独立 profile 文件，旧版 `[profiles.NAME]` 不再是同一接口。请依据已安装 CLI 的帮助和 `doctor` 报告确认布局，勿把某种目录结构当成所有版本的通用事实。[官方 profile 配置说明](https://learn.chatgpt.com/docs/config-file/config-advanced)

`csm` 不创建、迁移或替换 profile。选定的 profile 不存在、不能加载或模型不可用时应停止，不能回退到另一个 profile/provider/model。启动与恢复使用同一 `CODEX_HOME`；跨主机复制一个 ID 不等于复制会话存储。

## 技能调用

官方明确支持在 Codex CLI 用 `$` 提及技能，或通过 `/skills` 选择。默认用户级技能目录是 `~/.agents/skills`，项目级目录是 `.agents/skills`。安装后若未出现，重启 Codex 再检查。[官方技能说明](https://learn.chatgpt.com/docs/build-skills)

`$auto-handoff` 是本项目支持的入口。`/auto-handoff` 不是本项目注册的 Codex 内置 slash command。旧 custom prompt 的 `/prompts:auto-handoff` 路径属于不同机制，本项目不自动安装该配置。

## 原生 statusline

可在自己的 Codex 配置中合并以下内置项。若已有 `[tui]`，只修改对应 `status_line`，不要重复创建 TOML 表：

```toml
[tui]
status_line = ["model-with-reasoning", "context-remaining", "current-dir"]
```

这些是官方示例中的内置项；`csm` 不自动改配置，也不会把任意 shell 命令插入这条状态栏。[官方配置示例](https://learn.chatgpt.com/docs/config-file/config-sample)

原生栏的上下文显示和 csm 的监测来源可能不同。不要从原生界面的存在推断 csm 已取得同一指标；csm 缺少观测证据时仍显示 `unknown`。

## 恢复后的权限

初始化明确使用只读沙箱。恢复会话时，Codex 是否保留初始化权限以及 profile 的覆盖优先级仍需实测。`csm` 返回的恢复命令不会擅自增加可写或危险权限参数。准备继续开发前，在新会话中检查 `/status` 和 `/permissions`，按自己的权限要求确认是否允许写入。不能把“已恢复会话”直接等同于“已恢复原来的写入权限”。

## 进一步验证

要把“帮助接口已验证”升级为“真实交接通过”，需要使用用户已选定的有效 profile 完成：创建新会话、成功只读初始化、核验真实 ID、用返回命令交互恢复，并确认首句和初始化结果可见、项目未被初始化修改。只收到 `thread.started` 不满足完成条件。所需模型调用可能产生正常用量或费用。
