# T3: 实现与回归

Status: open

**What to build:** 按 T2 冻结方案实现前台占位 turn + 全门回归。

**Blocked by:** 02-design.

- [ ] host：start 后起占位 turn、心跳、取消→双停、结束收 turn
- [ ] 中断映射：turn 取消 → abort → `interruptedAt` 落盘（单测覆盖）
- [ ] 真跑一局验证：发送变停止 + 蓝字 + 取消即双停 + 结束收 turn
- [ ] 术语小改（"会话接管"重命名，docs 同步）+ vitest/pytest/arch 全绿
