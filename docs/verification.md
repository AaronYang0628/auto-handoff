# 验证记录

日期：2026-10-02。文档示例环境：Linux x86_64、Node.js v24.19.0、npm 11.9.0、Codex CLI 0.159.2。

## 已执行的文档示例

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

本次交付源码测试在 Linux 的 Node.js 22.18.0 和 24.19.0 上分别为 **76/76 通过**，严格类型检查、构建和语法检查通过。后续版本以当前命令输出为准。安装包使用编译后的 JavaScript，已在独立临时目录验证 tarball 安装入口。

测试按实际代码覆盖 checkpoint/交接边界、模拟启动结果、安装及监测场景；以执行输出为准。模拟的 `thread.started` 只验证解析与状态机，不是可供真实 `codex resume` 使用的 session。

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
- 云端浏览器未能打开本地预览（ERR_BLOCKED_BY_CLIENT），未完成截图级视觉验收
- GitHub Actions/Pages 工作流已编写；远程运行与实际部署尚未验证
