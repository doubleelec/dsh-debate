# 会话接管 B 方案：忙快照 + 一键双停 + 打断可映射

2026-10-20 落地。辩论期间发起会话是空闲的（host 后台直驱，模型那一 turn
已结束），用户随时能说话、模型正常起 turn——和辩论各说各的。
B 方案不管"续跑"，只做"看得见 + 停得干净 + 断得可指"。

三件套（`DebateSession` 新增三字段 + 一条新路由）：

- `parentBusy: boolean | null`——每轮边界采一次 `parent.status`
  （轮询不订阅，host 侧无 parent.ctx 监听保证），`state` 暴露，
  面板会话行显示"发起会话忙/闲"。`null`=没采过（false 会谎报"采过且闲"）。
- `/api/interrupt` 一键双停——先 `parent.cancel({kind:'user'}, {keepInbox:true})`
  停发起会话的 turn（用户刚说的话留着），再 abort 后台 debate。
  只做"停两边"，续跑是下一跳。面板"一键双停"按钮。
- `interruptedAt: { round, seq } | null`——stop/interrupt 时 transcript
  停在哪，面板在实录对应位置画"⛔ 此处被打断"线。
  transcript 本来就全保留，缺的只是"打断点在哪"这个映射。
  开题前就停了记 `null`（没东西可指）。

纯函数（可单测）：`interruptMarkOf`（末条位置，空记 null）、
`parentBusyOf`（只认 `running`）、`interruptPlanOf`（cancelKind=user +
keepInbox=true）。

落盘：两字段都是可选审计字段，老记录缺即 `null` 恢复，不 bump 记录版本
（ADR-0021 判例）。恢复的局 `parentBusy` 只是"那时忙不忙"的快照。
