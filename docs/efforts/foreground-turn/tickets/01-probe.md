# T1: 前台能力探针

Status: claimed

**What to build:** 在真实 dev 环境回答 spec 的 Q1~Q4，不写业务代码，只跑探针并记录结论。

**Blocked by:** None (can start immediately).

**探针清单：**

- [ ] P1：host 拿到 parent（`agents.get(sid)`）后调 `followup`，观察发起会话是否起 turn（看发送按钮/蓝字/事件流）
- [ ] P2：占位 turn 存续期间 host 心跳更新进度，观察 UI 如何呈现（流式追加？整块刷新？）
- [ ] P3：用户在占位 turn 中点停止/发新消息，观察 `cancel` 语义与 inbox 排队行为
- [ ] P4：思辨后台 abort 时，占位 turn 是否自然收、有无僵尸态

**退出标准：**四个探针各有"实测结论 + 复现步骤"，写入本文件 `## Comments`；结论决定 T2 方案走向（可做 / 降级 / 放弃）。

## Comments

### P0 能力枚举（2026-10-21，3080 实测，`debug-parent` 路由）

`agents.get(sid)` 拿到的 parent 面上有（`cap` 实测）：

- `followup: function` —— 真身 `followup(input) { this.send(input, "next-turn", true) }`。
  语义是"发 next-turn"，**不是纯 inbox 投递**：第三个参数 `true` 按 DSH 惯例是"唤
  醒/起 turn"标志。这是从未走过的路，但门是开着的。
- `cancel: function` —— `cancel(cause, options)`，`keepInbox` 语义与 S17 已用的一致。
- `whenIdle: function` —— `async whenIdle()`，等 turn 跑完可用。
- `status: string` —— 注意：parent 面上的 `status` 是**字符串字段**，不是函数。
  S17 的 `parentBusyOf` 读的是 `parent.status === 'running'`，与此一致（`agents.get`
  返回的是 agent 对象，`status` 是其当前状态快照）。
- `dispose: undefined` —— parent 不能 dispose（符合预期：发起会话的命不归插件管）。
- `session: object`（`append` 面在）+ `ctx: object`（工具表可读）。

`keys` 全表：activityDone / assistantAttemptCounter / assistantStreamRevision /
ctx / dispatch / frozenMessages / id / inbox / loopCtx / options / phase /
requestHeaderLogged / requestSurfaceGeneration / runtimeContext / scope /
session / systemPrompt。

**P0 结论：前台占位 turn 的能力门是开着的。**`followup(input)` 发 next-turn，
理论上能让发起会话起一个真实 turn。P1（真调一次看会话区是否进入运行态）值
得动手。风险：`send(input, "next-turn", true)` 的具体 UI 语义（蓝字？停止按钮？
用户消息插队？）只能真调看，文档推不出来。
