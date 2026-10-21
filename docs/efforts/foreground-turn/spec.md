# 前台占位 turn Spec

Status: claimed

## Problem Statement

思辨建单后，`runHostDebate` 是纯后台任务（建单路由建单即返，不占发起会话的
turn）。发起会话全程 `idle`：发送按钮不变、没有"深度求索中"蓝字，对话区只
有 `session.append` 的 mirror 摘要（不唤醒模型、不占 turn）。用户预期"会话被
思辨接管、进入运行中状态"，实际看到的和"没跑起来"难以区分。

根因：ADR-0023 只做了 B 方案（忙快照 + 一键双停 + 打断可映射），"续跑是下
一跳"——但该下一跳从未被认领。术语"会话接管"名实不符。

## Solution

开题后在发起会话里起一个真实、可取消的 turn 占住它：心跳汇报进度（读
`state` 的 progress），用户点停止或发消息即双停（复用 `/api/interrupt`），思
辨结束 turn 自然收。面板保持现状（轮询实况），对话框是否自关另议（本 effort
不管，只做会话区运行态）。

## Decisions

- 占位 turn 的内容只做进度心跳，不跑论证（论证仍在子会话/子 agent 里）。
- 取消语义与一键双停同源：turn 取消即 abort 后台思辨（`controllers`）。
- 思辨正常结束/失败/被停时，占位 turn 必须收（不留僵尸 turn）。

## Open questions (T1 探针回答前不冻结方案)

- Q1：host 对 parent 调 `followup` 是否触发其 turn，还是只进 inbox？
- Q2：turn 心跳用什么机制（长文本流？周期性 followup？宿主有无进度 API）？
- Q3：用户在占位 turn 进行中发消息，语义是"打断并双停"还是"排队等思辨结束"？
- Q4：若宿主无"让指定会话起 turn"能力，降级方案是什么（面板常驻提示？放弃？）？

## Out of Scope

- 对话框自动关闭（另议，与本 effort 正交）。
- "会话接管"术语重命名（docs 小改，T3 顺手做，不单独立项）。
- ADR-0023 已交付的三件套不动。

## Testing Decisions

- T1 探针：真实 3090/dev 跑结论（`followup` 对 parent 的行为实测，不是单测能回答的）。
- 实现后：单测覆盖中断映射（turn 取消 → abort → interruptedAt 落盘），真跑一局验
  证"发送变停止 + 蓝字出现 + 取消即双停 + 结束 turn 收"。
- 回归：vitest + pytest + arch 全绿。

## Further Notes

- 前置阅读：ADR-0011（host 直驱）、ADR-0023（B 方案边界）、`src/index.ts`
  `/start` 路由（L1716~L1785）与 `/interrupt` 路由（L1889~L1925）。
- 术语以 CONTEXT.md 为准。
