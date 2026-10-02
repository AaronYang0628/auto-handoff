# 监测与建议

监测不会创建新会话。`watch` 只读取明确指定的文件，`status` 展示已经保存的观测；没有输入来源时仍可手动 checkpoint / handoff。

## 使用明确来源

```bash
csm watch --session SOURCE_ID --cwd "/path/to/project" \
  --source "/path/to/selected-log.jsonl" --once
csm status --session SOURCE_ID --cwd "/path/to/project" --json
```

来源必须是你有权限读取、与这一个 source session 对应的常规文件。第一条元数据需要同时匹配 session ID 和绝对 cwd；同目录中另一个 session 的日志会被拒绝。工具不会扫描你的会话目录、按修改时间挑“最新”日志，或修改原始日志。

去掉 `--once` 后持续轮询，默认每 5 秒一次；`--interval-seconds` 接受 1–3600 秒。Ctrl+C 停止。首次及状态发生变化时输出 JSON，相同状态不重复刷屏。消费者应读取 `recommendation.notify` 判断是否需要再次提醒，不能把每次输出当作新提醒。

## 合成数据回放

以下示例在仓库根目录的 Bash 终端运行，无需真实会话或模型调用：

```bash
demo_dir="$(mktemp -d)"
node fixtures/create-monitor-fixture.mjs "$demo_dir/source.jsonl" "$PWD"
node bin/csm.mjs watch --session synthetic-monitor-session --cwd "$PWD" \
  --source "$demo_dir/source.jsonl" --once --state-dir "$demo_dir/state"
node bin/csm.mjs status --session synthetic-monitor-session --cwd "$PWD" \
  --state-dir "$demo_dir/state" --json
```

生成器写入当前时间和准确 cwd，拒绝覆盖已有文件。预期为 `context_occupancy_percent.value: 75`、`availability: estimated`、建议 `checkpoint`；独立的累计 token 为 9,000,000，不能把它解释成占用率。数字和模型名均为合成样例。临时目录可在检查后自行清理。

## 两种适配器

| adapter | 输入与边界 |
| --- | --- |
| `codex-rollout-v1-partial`（默认） | 合成 fixtures 验证过的部分 rollout JSONL 形状；不能承诺所有 Codex 版本或现有 TUI 都兼容 |
| `csm-jsonl-v1` | 本项目的明确事件输入协议，用于测试或已有数据适配；并不自动连接 Codex TUI |

不支持的格式或缺失字段会留下诊断信息/`unknown`，不能把未知占用显示为 0%。切换来源时必须重新验证身份。重新运行 `watch` 时继续保留已有读取位置、去重状态和观测；日志轮换或截断会重新验证新文件。

rollout 中“上次请求 token / 模型窗口”只标为 `estimated`，表示上次观测的估算，不是实时剩余上下文的保证。`csm-jsonl-v1` 只有明确声明 `measurement_method: runtime_reported_context` 的可信适配输入才按可用数据处理；声明本身不能替代来源校验。

压缩事件会使旧上下文占用估算失效，直到取得更新的用量观测；累计量单独保留。累计 token、累计缓存 token、最后一次上下文 token 和窗口大小分别输出。缓存量不是费用，实际模型不从请求模型推断。每个指标都包含值、单位、观测时间、来源、测量方法、可用性和缺失原因。

## 默认规则

| 信号 | 建议 |
| --- | --- |
| 可用/估算占用 <70% | `continue` |
| 可用/估算占用 ≥70%、<85% | `checkpoint`，准备材料 |
| 可用/估算占用 ≥85% | `handoff_suggested`，由用户选择阶段边界 |
| 新鲜的约束失守/重复人工标记 | `review` |
| 连续 3 次等价动作，且声明的文件状态、证据和结果不变 | 重复候选，`review`；不自动判定语义失败 |
| 阶段完成标记 | 可作为 checkpoint 时机，不代表质量下降 |
| 支持格式的压缩事件 | 核对关键状态，不自动判定退化 |
| 没有足够的新鲜证据 | `insufficient_data` |

新代码/文件快照、新证据、预期轮询或不同结果会打断重复候选。普通原始工具调用缺少这些语义字段时，不假装有可靠的重复检测。

默认新鲜度窗口 15 分钟、提醒冷却 5 分钟，重复建议会去重。监测命令可通过以下参数调整，参数只对本次调用生效，不会改 Codex 配置：

```text
--checkpoint-percent 70
--handoff-percent 85
--repetition-count 3
--cooldown-seconds 300
--stale-after-seconds 900
```

checkpoint 阈值必须低于 handoff 阈值，handoff 阈值不超过 100；重复次数至少为 2。需要保持自定义规则时，在 `watch`、`status` 和 `mark` 调用中使用同一组参数。规则是启发式，不提供退化概率或健康总分。

## 手动标记与反馈

```bash
csm mark --session SOURCE_ID --cwd "/path/to/project" \
  --kind constraint-violation --constraint-id C1 --note "简短描述核验依据"
csm mark --session SOURCE_ID --cwd "/path/to/project" --kind phase-complete
csm feedback --session SOURCE_ID --cwd "/path/to/project" \
  --operation-id OPERATION_ID --outcome helped --note "关键约束恢复，下一步明确"
```

`mark` 类型还包括 `repetition`；约束失守必须关联 constraint ID。`feedback` 的 outcome 可为 `helped`、`unhelpful`、`unknown`，并绑定已经记录的交接 operation。笔记保存在本地，避免填写密钥或无关个人资料。

## 有界保留

最多保留 2,000 个标准化事件和 20,000 个去重 ID。压缩计数表示仍保留的已观测事件数，不是完整历史总量；超出保留窗口的旧数据回放可能再次被看到。每次最多读取 8 MiB，单行上限 1 MiB；分批写入的末尾半行等补齐后再解析。

证据包含来源路径、文件标识、日志代次、字节位置、行号和记录哈希。标准化存储不保留原始聊天/工具负载全文，人工 note 仍按用户填写的内容保存。

这些建议不能决定模型是否“变笨”，也不能替代验收测试。开始一次 handoff 仍需用户的明确选择与目标 profile。
