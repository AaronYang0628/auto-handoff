# Checkpoint JSON 格式（schema_version 1）

所有顶层字段都应提供。数组允许为空，空数组表示当前没有已知条目；不要用空数组隐藏尚未核实的信息。`session_id` 和 `cwd` 必须与命令行输入一致。

```json
{
  "schema_version": 1,
  "session_id": "CURRENT_SOURCE_SESSION_ID",
  "cwd": "/absolute/path/to/project",
  "goal": "本次任务要交付什么，以及当前完成到哪里",
  "constraints": [
    {
      "id": "C1",
      "text": "保留现有公开 API；尚未得到修改它的授权",
      "source": "用户本次请求；注明可定位的消息或文档位置",
      "status": "confirmed"
    }
  ],
  "acceptance": ["[confirmed; source: 用户请求] 现有测试和新增回归测试通过"],
  "decisions": ["[verified; source: 路径及位置] 继续沿用现有存储格式"],
  "rejected_approaches": ["[verified; source: 测试命令及结果] 不重写存储层，原因是会破坏兼容性"],
  "todos": ["补充边界条件测试"],
  "blockers": [],
  "important_files": ["README.md"],
  "next_step": "先阅读 README.md 中的测试说明，再检查尚未完成的回归测试",
  "ongoing_operations": [],
  "writers_stopped": true
}
```

模板里的 ID、路径、条目和事实都必须替换；示例不是用户的要求。按真实任务需要增减数组项。

## 证据与状态

`constraints[].status` 使用以下值：

- `confirmed`：用户明确要求或确认
- `verified`：通过文件、工具结果或确定性检查核验
- `inferred`：推测，不能升级为用户要求
- `unverified`：待核实
- `superseded`：已被更新要求替代；在文字中注明替代条目，不继续执行旧要求

`source` 要可定位，例如用户消息日期/原意、`docs/spec.md#section`、测试命令与退出码。不要编造消息 ID、验证结果或引用。若来源不可定位，明确写出限制。

当前 schema 的 `acceptance`、`decisions`、`rejected_approaches` 是字符串数组；在关键条目前写 `[状态; source: 来源]` 保留证据。`next_step` 必须具体、能马上执行，并遵守仍有效的约束。将“上次尝试失败”和“以后都不能使用”区分开。

## 文件与写入边界

`important_files` 仅列与任务有关的项目相对路径。必读资料必须存在；若路径对应本次故意删除的文件，可以记录为预期不存在，并在决策中写明依据。脚本会核验这种缺失状态，不能借此把丢失的必读资料当作正常。不要列认证存储、环境变量文件、密钥、其他会话的聊天记录或无需传递的个人资料。敏感文件检测无法代替人工检查。

`ongoing_operations` 描述已知运行中的测试、生成器、后台命令或待确认的外部操作；尚有写入时如实填写并设 `writers_stopped: false`。只有自己和已知写入者都停止后才改为 `true`。文件快照只核验所捕获范围，不证明世界上没有其他进程写文件。

交接包能包含未提交改动的状态，但不会替用户提交代码。接收会话的初始化只核验材料，实际继续开发发生在用户恢复会话之后。
