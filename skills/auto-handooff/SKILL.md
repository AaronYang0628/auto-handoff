---
name: auto-handooff
description: Compatibility alias for auto-handoff when the user explicitly invokes the earlier spelling to hand off a Codex task to a fresh session.
---

# Auto Handoff 兼容别名

这是 `auto-handoff` 的旧拼写别名。读取同级目录的 [auto-handoff 技能](../auto-handoff/SKILL.md)，完整执行其输入确认、checkpoint、只读初始化和恢复流程。

如果主技能未安装，停止并说明需要安装 `auto-handoff`，不要自行猜测替代命令或创建会话。若当前已处于交接初始化，只输出接收报告，不再次启动交接。
