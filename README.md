# dsh-conversation-flow

中文优先的 DSH 插件：**对话倒带 / 重新生成 / 删除本轮 / 删除会话**，面向 DeepSeek Harness（DSH）0.2.2-rc.1。

仓库：<https://github.com/JadeL-Kemo/dsh-conversation-flow>

一个插件覆盖五种能力中的四种；「分支」与「归档」继续用 DSH 原生功能（二者语义不同，不重复实现）。

## 动作对照

| 动作 | 含义 | 对话 | 文件 |
| --- | --- | --- | --- |
| 倒带 ↶ | 回到某条提问之前（问题本身没问好 / 需求写错） | 截断到该提问之前 | 恢复到提问时的状态 |
| 重新生成 ⟳ | 对 AI 产出不满意，重跑一遍 | 截断后用同样的提问重跑 | 不动 |
| 删除本轮 ✕ | 这一轮没有参考价值，不留记录 | 只截断 | 不动 |
| 删除会话（⋯ 菜单） | 整个会话没有价值（测试会话 / 旧分支） | 会话移入回收站，列表消失 | 不动 |
| 分支 | 两条线都满意，分开发展 | DSH 原生「分叉会话」 | 不动 |
| 归档 | 对话完成，存档备用 | DSH 原生「归档会话」 | 不动 |

## 使用

1. 重启 DSH 后：
   - 每条用户消息右侧出现 `↶ ⟳ ✕` 三个小按钮（悬停/常驻视主题而定）。
   - 会话行 `⋯` 菜单底部出现红色「删除会话」。
2. 点击后均有确认弹窗：对话截断是表层 replace（日志 append-only，旧记录仍可审计），被隐藏的消息从界面消失。
3. 命令行等价物：`/flow-rewind`、`/flow-regen`、`/flow-drop`（不带参数列出候选，带 `@seq` 或序号执行）。
4. 「删除会话」是软删除：会话目录移入 `<sessions root>/.sessions-trash/`，24 小时内可手工还原（payload 去掉 `.trash` 后缀、目录移回原位），超时自动清理。

## 安装 / 卸载

```powershell
dsh plugin --profile desktop add file:H:/AgentWorkspace/Other/dsh-conversation-flow
dsh plugin --profile desktop remove dsh-conversation-flow
```

重启 DSH 后生效。插件自带宿主删除路由（`POST /api/dsh-conversation-flow/delete-session`），不依赖其它插件。

## 实现要点

- **对话截断**：`Session.append('user/message', marker, {surfaceOp:{op:'replace',startSeq,endSeq}, sourceEventSeqs})`，与官方 /compact 同款表层机制；日志 append-only。
- **文件恢复**：插件自有的检查点存储（默认 `%USERPROFILE%\.dsh\conversation-flow\<sessionId>\`）：每条用户消息生成一份密集清单，第一次 write/edit 前补录前值；恢复时按目标清单对照实时磁盘原子写/删。单文件上限 8 MiB，保留最近 100 份检查点。
- **删除会话**：宿主 `sessionPersistence` 的 `config.root` + 后端目录布局（`<root>/<projectKey>/<encodeSegment(id)>/`）；先给 canonical payload 加 `.trash` 后缀（宿主列表扫描立即不可见），再把目录移入 `.sessions-trash/` 并写 `manifest.json`；活动会话仅在宿主提供 `cancel({kind:'disposed'}) + whenIdle()` 时先停后删，否则 409 session-busy；同时尽力清理 workspace 记账与投影缓存。
- **客户端**：不使用已移除的快照 hooks，改为读取 `data-chat-turn` 行属性 + Host 轮次锚点接口；删除项走官方 `contextMenus` 注册表（`target: 'session'`），纯 DOM，无构建步骤。
- 子代理会话（`delegationDepth > 0`）不参与检查点与倒带。

## 已知限制

- 倒带/重新生成/删除本轮只对已打开的会话生效（Host 通过 `agents.get(sessionId)` 找活动 agent）。
- 删除会话只能删宿主启动时已知的会话（`persistence.list()` 为启动缓存；刚新建、尚未重启的会话可能 404）。
- 删除当前打开的会话会先停止它，界面回到新会话；确认框有提示。
- 运行中的回合会先被取消；倒带操作不可撤销（只能再倒带回去，日志仍在）。
- 文件恢复只覆盖本会话记录过的工作区文件；工作区之外、超过 8 MiB 或非本地后端的文件不恢复。
- 附件是内容寻址共享存储，删除会话不会删除附件字节。

## 开发

```powershell
npm test        # node --test tests/plan.test.mjs tests/store.test.mjs tests/delete.test.mjs tests/host-smoke.test.mjs
```
