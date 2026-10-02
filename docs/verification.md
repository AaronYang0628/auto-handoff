# 验证记录

日期：2026-10-02。文档示例环境：Linux x86_64、Node.js v24.19.0、npm 11.9.0、Codex CLI 0.159.2。

## v0.1 已执行的文档示例

| 检查 | 结果 | 能证明的范围 |
| --- | --- | --- |
| `node bin/csm.mjs --help` | 通过 | 文档所列 CLI 入口存在 |
| 构建后的 tarball 安装到独立 `node_modules` 后运行 CLI | 通过 | `csm --version` 返回 0.1.0，`doctor` 能探测真实 Codex 帮助；无需从安装目录执行 TypeScript |
| `node bin/csm.mjs doctor` | 通过 | 本机 Codex 帮助包含初始化/恢复所需参数；`real_model_handoff_verified` 为 `false` |
| `node docs/demo.mjs` | 通过 | 合成项目可生成 checkpoint 和启动预览，包含中文与空格路径；`dry_run: true`、`launches: 0` |
| 监测说明中的 fixture 生成、watch、status | 通过 | 得到 75% `estimated`、`checkpoint` 建议；9,000,000 累计 token 单独保留 |
| 临时项目级技能安装、重复安装、旧别名 | 通过 | 目标布局和幂等安装符合命令说明 |
| 修改已安装技能后卸载 | 通过 | 未修改的托管文件移除，修改过的技能文件保留 |
| 两份技能 frontmatter、文档相对链接、JSON 模板、演示脚本语法 | 通过 | 基本结构和引用有效；不代表真实 Agent 行为已端到端验证 |

所有示例使用隔离临时目录与合成数据，没有访问真实会话日志或凭据，也没有创建模型会话。示例生成的临时材料会保留供检查。

## 自动化测试

在仓库根目录执行：

```bash
npm ci
npm run typecheck
npm run check
npm test
```

v0.1 发布快照（提交 `ad4e5395369d6f899ec3fd42d8a35a434cffa561`）在 Linux 的 Node.js 22.18.0 和 24.19.0 上分别为 **76/76 通过**，严格类型检查、构建和语法检查通过。后续版本以当前命令输出为准。安装包使用编译后的 JavaScript，已在独立临时目录验证 tarball 安装入口。

测试按实际代码覆盖 checkpoint/交接边界、模拟启动结果、安装及监测场景；以执行输出为准。模拟的 `thread.started` 只验证解析与状态机，不是可供真实 `codex resume` 使用的 session。

## v0.2 偏离试用文档冒烟

v0.2.0 的最终本地检查在 Linux / Node.js 24.19.0 上为 **126/126 测试通过**；严格类型检查、全部相关源码语法检查、构建、两种文档演示和独立 tarball 安装后的偏离演示均通过。Node.js 22.18 与 24 的发布检查由同一提交对应的 CI 矩阵执行。

已在隔离的临时项目（含中文及空格路径）填入协议文档的基线/观察 JSON，并运行编译后的 CLI：

- 保存基线后如实报告缺失验收；相同原输入重复保存会复用状态
- `check` / `review` 可输出缺失验证与有界复核包
- 显式注册并授权的合成 `npm test` 通过后，当前相同范围得到实测 pass
- 删除临时项目的声明必需文件后，得到文件约束冲突及旧验证过期
- `observe` 的手动候选和 true / false / uncertain / missed 反馈入口均可解析并保存
- 变更基线默认被拒绝；显式 `--replace-baseline` 会创建不同修订
- `node docs/drift-demo.mjs` 通过：三次受控相同失败得到候选，记录有意重试反馈，修改合成文件后实测 pass 且候选消失
- 页面 9 项测试、静态构建和文档变更检查通过

这些是合成输入与受控脚本检查，不是用户项目上的准确率证明，没有创建真实模型会话。当前完整测试数量以 `npm test` 及对应 CI 输出为准；上述 v0.1 的 76 项记录不是 v0.2 的总数。

## 尚待真实环境验证

- 用户自行配置的任意有效 profile 在创建与恢复时均保持正确生效
- 完成实际模型初始化后，用返回的准确 ID 恢复并看到首句、材料核验结果
- 恢复后的沙箱/审批权限是否继承，以及 `/permissions` 的实际操作
- 当前 TUI 日志格式、可采集字段及刷新延迟
- Windows 原生、WSL、macOS；不能从 Linux 测试推断它们已通过

这些是产品兼容性待验证项，不需要某个特定人的配置。任何使用者都应选自己的 profile；仓库没有内置个人模型、provider 或账户信息。

## 项目页面

- `npm run build:site` 构建通过；9 个页面测试覆盖静态资源、链接、双语切换、复制反馈和安全输出目录
- 构建后的静态资源 HTTP 读取检查通过
- 本地预览曾被云浏览器拒绝；随后已在实际公开页面核验英文/中文切换及对应复制反馈
- v0.1 [CI 运行](https://github.com/AaronYang0628/auto-handoff/actions/runs/36964510984)（Node.js 22.18 / 24）与 [Pages 部署](https://github.com/AaronYang0628/auto-handoff/actions/runs/36964510915)已验证
- [公开项目页](https://aaronyang0628.github.io/auto-handoff/)已检查；上述记录不替代后续版本的部署及界面验收
