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
