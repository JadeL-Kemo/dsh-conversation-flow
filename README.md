# dsh-conversation-flow

中文优先的对话「倒带 / 重新生成 / 删除本轮」插件，面向 DeepSeek Harness（DSH）0.2.2-rc.1。

仓库：<https://github.com/JadeL-Kemo/dsh-conversation-flow>

## 三种动作

| 动作 | 含义 | 对话 | 文件 |
| --- | --- | --- | --- |
| 倒带 ↶ | 回到某条提问之前（问题本身没问好 / 需求写错） | 截断到该提问之前 | 恢复到提问时的状态 |
| 重新生成 ⟳ | 对 AI 产出不满意，重跑一遍 | 截断后用同样的提问重跑 | 不动 |
| 删除本轮 ✕ | 这一轮没有参考价值，不留记录 | 只截断 | 不动 |
| 分支 | 两条线都满意，分开发展 | 用 DSH 原生「分叉会话」 | 不动 |
| 归档 | 对话完成，存档备用 | 用 DSH 原生「归档会话」 | 不动 |

## 使用

1. 重启 DSH 后，每条用户消息右侧出现 `↶ ⟳ ✕` 三个小按钮。
2. 点击按钮确认后：对话上下文被截断（会话日志保持 append-only，审计与旧记录仍在），被隐藏的消息从界面上消失。
3. 命令行等价物：`/flow-rewind`、`/flow-regen`、`/flow-drop`（不带参数列出候选，带 `@seq` 或序号执行）。

## 安装 / 卸载

```powershell
dsh plugin --profile desktop add file:H:/AgentWorkspace/Other/dsh-conversation-flow
dsh plugin --profile desktop remove dsh-conversation-flow
```

重启 DSH 后生效。

## 实现要点

- **对话截断**：`Session.append('user/message', marker, {surfaceOp:{op:'replace',startSeq,endSeq}, sourceEventSeqs})`，与官方 /compact 同款表层机制；日志 append-only。
- **文件恢复**：插件自有的检查点存储（默认 `%USERPROFILE%\.dsh\conversation-flow\<sessionId>\`）：每条用户消息生成一份密集清单，第一次 write/edit 前补录前值；恢复时按目标清单对照实时磁盘原子写/删。单文件上限 8 MiB，保留最近 100 份检查点。
- **客户端**：不使用已移除的快照 hooks，改为读取 `data-chat-turn` 行属性 + Host 轮次锚点接口；纯 DOM，无构建步骤。
- 子代理会话（`delegationDepth > 0`）不参与检查点与倒带。

## 已知限制

- 只对已打开的会话生效（Host 通过 `agents.get(sessionId)` 找活动 agent）。
- 运行中的回合会先被取消；倒带操作不可撤销（只能再倒带回去，日志仍在）。
- 文件恢复只覆盖本会话记录过的工作区文件；工作区之外、超过 8 MiB 或非本地后端的文件不恢复。

## 开发

```powershell
node --test tests/
```
