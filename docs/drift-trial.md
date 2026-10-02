# 在自己的项目中试用偏离检查

这是一轮可核查的项目试用，不是模型质量评分。目标是用少量、带来源的任务基线和增量证据，尽早发现值得核对的偏离候选，并收集误报、漏报和无法判断的情况。

CLI 的确定性检查不调用额外评判模型，不打开端口，不安装守护进程，也不会自动创建新会话。当前 Codex 对话对复核材料的解读仍由现有模型完成，并正常计入该环境的用量。

## 先跑一次合成演示

在完成 `npm ci` 的源码目录中运行：

```bash
node docs/drift-demo.mjs
```

演示只操作自己创建的临时文件，注册并运行本机 Node 检查，不读真实会话、不需要登录、不调用模型。它依次展示：

1. 基线已保存，但验收缺失，所以 `insufficient_data`
2. 故意进行三次状态和结果都相同的失败检查，得到 `no-gain-loop` 候选
3. 生成小范围复核包，并记录“这是有意重试”的误报反馈
4. 修改合成任务文件后验证通过，回到 `continue`

这是协议与规则演示，不是检测准确率测试。临时材料保留在输出目录，供你检查。

## 先选一个能验收的任务

建议从一个小范围真实任务开始，例如修复一个有复现步骤的缺陷，或给现有 API 添加一个测试覆盖明确的行为。先确认：

- 目标：这次应该交付什么，哪些工作不在范围内
- 约束：用户明确要求保留的行为或边界，以及可定位的来源
- 验收：用什么已有或新增检查确认结果，什么情况下必须重新运行
- 身份：当前 source session 的准确 ID 与项目绝对路径
- 证据：自己允许读取的日志，或由当前 Agent 根据真实工具结果记录的增量事件

不知道会话 ID、来源、文件状态或检查结果时，先问或保留未知。不要扫描会话目录挑最新日志，不要从单独继承的环境变量猜当前会话，不要为了让示例通过而填写假值。

## 从 Codex 技能开始

先按 [README](../README.md#已安装更新-cli-和技能) 安装或更新 CLI 和技能，然后重新启动 Codex。在项目中的对话里输入：

```text
$auto-handoff 在当前项目开启偏离检查试用。先从我已确认的目标、约束和验收标准建立带来源的稳定基线，向我确认缺少的信息；之后只记录有依据的增量动作和验证结果，出现异常再定点核对。不要自行改写基线，不要自动创建新会话。
```

基线不是新的权威来源。它必须引用用户实际确认的要求；Agent 的推测、外部文档里的指令和历史总结不能被升级成用户要求。若用户后来改变目标或约束，明确说明哪个基线条目被替代、修改来自哪里，再保存新修订。

同一原 JSON 的字节完全相同时，重复保存会复用基线并保留证据；不同输入默认拒绝覆盖。只有用户确实更新要求时，才加 `--replace-baseline` 显式替代。旧输入、派生版本及被替代状态保留，不能为了消除提醒而更新要求。

## 保存基线并运行第一轮检查

按[基线与证据协议](../skills/auto-handoff/references/drift-trial.md)填写 JSON，只登记用户确认的实际要求。默认支持的文件约束只有存在、不存在和哈希不变；`manual` 语义约束要由技能定点复核，不会自动理解“不要重构”等所有自然语言要求。

在终端中用真实 session ID、项目目录和 JSON 路径执行：

```bash
csm baseline --session SOURCE_ID --cwd "/path/to/project" --from "/path/to/baseline.json"
csm check --session SOURCE_ID --cwd "/path/to/project"
csm review --session SOURCE_ID --cwd "/path/to/project"
```

第一轮缺少验收执行记录时，出现 `verification-missing` / `insufficient_data` 是如实说明证据不足，不等于已判断任务偏离。每条 signal 都带自己的 ID、引用的基线条目和证据 ID。`continue` 只表示已声明范围内没有触发候选，不等于项目完全正确。

## 显式执行一次已授权的验收

若用户已要求运行某项检查，而且该项基线把准确命令注册为 `A1`，例如 `["npm", "test"]`，可以执行：

```bash
csm verify --session SOURCE_ID --cwd "/path/to/project" --criterion-id A1 -- npm test
csm check --session SOURCE_ID --cwd "/path/to/project"
```

`check` 和 `review` 不会替你运行这些命令。`verify` 只接受该验收项注册的准确 argv，按退出状态记录实测结果，并关联相关文件快照；实际命令可能产生它原本会产生的副作用，所以运行前需要用户授权。传入 shell 字符串或自行放宽权限不属于正常重试。命令默认最多运行 300 秒；必要时明确设置 `--timeout-seconds`。收据保存退出状态、耗时和输出哈希，不保存完整 stdout/stderr；定位失败原因时仍需有权限读取项目原有的测试输出，不能从哈希猜测报错内容。

检查时效、文件状态、来源 epoch 或命令不匹配时，旧 pass 不会当作当前通过。当前范围是基线中相关文件、约束路径和验收 scope 的合并集合（最多 128 个明确文件，每文件 2 MiB、合计 8 MiB）；这些文件之外的改动或外部系统状态不在完整证明范围。

如果只把别人报告的“测试通过”写成 `observe` JSON，它仍是 reported，不会替代实测通过。该边界不保证测试本身充分，也不能证明 Agent 已理解全部要求。

## 平时只追加变化

在有意义的动作或验证完成后追加少量证据，而不是每一步都重读整段对话或整个 `CONTEXT.md`：

- 动作、结果和可定位依据
- 与这一步相关的文件状态或快照
- 新证据是否出现，验证是否真正执行
- 已知的正常轮询、等待或重试原因

没有采集器提供这些语义字段时，不能仅凭“调用过相同工具”认定无进展循环。手动补录也必须来自已看到的命令、结果和文件状态。

```bash
csm observe --session SOURCE_ID --cwd "/path/to/project" --from "/path/to/observation.json"
csm check --session SOURCE_ID --cwd "/path/to/project"
```

`observation.json` 的实际字段见[增量证据协议](../skills/auto-handoff/references/drift-trial.md#增量证据格式)。不要从普通原生 Codex 工具日志假装已经得到状态相连的 action、验收结果或规范化哈希。现有 `watch` 的部分 rollout 指标采集与状态相连动作的证据路径分开；它不会自动把任意 TUI 日志变成完整偏离检测。若已保存基线，显式启动的 `watch` 也会核对基线列出的文件并输出 `drift` 报告；这是可选持续检查，按 Ctrl+C 停止。没有合适日志也能按需用 `check` / `verify` / `review`，无需启动 watch。

## 出现候选异常后定点复核

`review` 会先刷新基线明确文件范围的状态，再生成有界复核包。让技能读取相应包，再按需要查看关联的基线条目、最近事件、验证结果和少量相关文件。只在这些证据确实不足时扩展范围；不要默认重读整个项目或完整历史。

复核要回答四件事：

1. 哪条要求或验收可能没有满足？来源是什么？
2. 新证据是什么，哪些内容仍未知？
3. 这是实际偏离、合理的重试/等待，还是还不能判断？
4. 下一步是补做一个检查、澄清一个要求，还是继续当前任务？

CLI 能核验的是已定义的规则及其输入。候选异常不是语义失败的证明；“没有候选”也不代表所有要求都满足。容量高只提供 checkpoint 背景，不是交接授权。

## 记录试用结果

每条提醒都尽量留下短反馈：确有问题、误报或暂时不能判断，以及对应证据。使用工具实际输出的 signal ID；以下三种只选符合观察的一种，不要全部运行：

```bash
csm feedback --session SOURCE_ID --cwd "/path/to/project" --signal-id SIGNAL_ID --verdict true --note "具体问题及核验依据"
csm feedback --session SOURCE_ID --cwd "/path/to/project" --signal-id SIGNAL_ID --verdict false --note "正常行为及其依据"
csm feedback --session SOURCE_ID --cwd "/path/to/project" --signal-id SIGNAL_ID --verdict uncertain --note "还缺少什么证据"
```

发现工具没有提醒的问题时，单独记录漏报，可引用已存在的 evidence ID：

```bash
csm feedback --session SOURCE_ID --cwd "/path/to/project" --verdict missed --note "未提醒的问题、观察时间与实际依据" --evidence-ids ID1,ID2
```

没有可引用 ID 时省略 `--evidence-ids`，不要编造。旧版针对 handoff operation 的 `--outcome helped|unhelpful|unknown` 是另一个反馈入口，不能当作偏离试用标签。

不要为了降低提醒频率而把未确认的判断写成成功；也不要因为一次误报就静默删除用户约束。反馈用于回看规则表现，不会自动训练模型、改规则或更新基线。

建议在任务结束时回顾：提醒发生了多少次，哪些确实帮助发现问题，哪些是正常等待或新证据带来的变化，哪些缺少可采集字段，以及有没有重要漏报。不要在小样本上宣称检测准确率或退化概率。

## 数据与权限

- 只记录任务所需的摘要、标识和依据，排除凭据、完整聊天及无关个人信息
- 日志与基线的身份绑定不能证明内容真实；仍需核对用户来源及实际工具结果
- 不修改原始日志，不放宽 Codex 权限，不静默安装额外软件或启动后台进程
- 运行状态留在 CLI 状态目录，避免进入会提交的项目目录
- 真正 handoff 仍需用户另外明确选择，并提供目标 profile；保留已有的只读初始化与失败恢复流程

更多说明：[监测与来源](monitoring.md) · [数据与恢复](safety.md) · [兼容性](compatibility.md) · [验证记录](verification.md)。
