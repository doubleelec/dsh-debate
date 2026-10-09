# 常驻辩手 + 交棒结论：替代一次性起辩

09-30 摸透的高层设施：常驻辩手不是 `subagents.start('spawn')` 一次性口，
而是 host 用 `agents.create` 起两个常驻辩手会话（各绑自己的模型路由与
preset 继承），每轮 host 用 `followup(UserMessage)` 把对方交棒结论投进
inbox 触发下一 turn，用 `whenIdle()` 等 turn 跑完，再用
`finalAssistantOutput(child-owned events)` 取交棒结论（最后非空助手输出）。
`Agent` 的 live 面（`followup`/`whenIdle`/`status`/`session.snapshotEvents`）
在 `dsh-agent` runtime-types 即有，不依赖 continuable 管理器
（那套要 `sessionPersistence` + `sessionQuery`，插件 host 未必挂载）。

grill 四轮共识（09-30）：终点=成果地图五件套；入口=输入框按钮+overlay；
配置=面板三模型+轮数；记忆=常驻双会话+全文交棒；停机=跑满/饱和/agree；
视角=全自动；工具=只读笼；制图独立；裁判默认关；失败=建对失败回退/中途即停。

为什么值得换（对照 CONTEXT.md 术语）：

- 现行一次性起辩（`one_shot_delegation`）每方每轮都是新会话，
  上一轮查过什么、让过什么全忘，只能靠 prompt 里塞对方原文续命，
  所以每篇都是 4000+ 字从零铺全的“大文档”，读起来碎。
- 常驻辩手（`resident_debater`）整场存活：查过的文件、让过的点、
  上轮的坑都在自己会话里，交棒的只是交棒结论（`handoff_conclusion`），
  下一棒接着往下辩，有演进、有让步、可读。

Seam 落点（codebase-design 语言）：辩论循环 Module 的 interface
（开题→交锋×N→制图，`stepOpen/stepRound/stepSynthesize` 签名）不动，
新增 `stepOpenResident/stepRoundResident` 与 `createResidentPair/driveResidentTurn`
并行，主循环常驻优先、建对失败回退一次性（`askSubagent` 保留）。
停机三条件（`parseAgree/parseAnswer/detectNewInfo/isConverged`）走协议层，
主循环每轮后判定：共识即停 / 饱和即停 / 跑满即停，`stopReason` 落会话。

## Considered Options

- `ctx.subagents.startContinuable` + `steerPrompt/queuePrompt`：正宗可续聊，
  但要 persistence/query 双服务，且 delivery 语义（steer 打断 nearest step
  vs queue 排队）对辩论这种严格串行反而多余。host 直驱更简单直接。
- `subagent_fork` 继承完整历史：KV 复用香，但 fork 把 parent 全历史带进来，
  建构挑战互看对方全量记忆，互盲就破了。spawn 式干净起手 + host 中转
  对方结论，才是互盲交锋要的形状。
- 保持一次性只做 prompt 瘦身：不动架构，但跨轮无记忆的根子还在，
  立场不演进，可读性天花板低。否决。

## Consequences

- Host 要自己写等 turn 循环（`whenIdle` + 单步超时 + stop 中止），
  不再是 `run.result` 一句话。
- Context 膨胀要接预算：交棒载荷只传结论摘要 + 本轮变化（Wave 2），
  全文留 transcript 引用；必要时 compaction。
- 开题互盲、交锋串行、制图只读实录的规则搬进 relay 重写一遍；
  制图员仍一次性（只读实录，无需记忆）。
- 工具笼与 persona 绑在创建时的 `setup` 里（`tools.restrict(deny)` +
  角色 system section），整场有效，不用每轮重传。
