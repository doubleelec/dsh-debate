# 02: 执行链打通

**What to build:** 模型按 debate_open → debate_round → debate_synthesize 三步执行，每步全文自然进会话，会话即直播，面板轮询做汇总。

**Blocked by:** 01: 空壳联调.

**Status:** ready-for-agent

- [ ] 一次端到端真辩论（开题互盲、至少两轮交锋、制图）完整跑完
- [ ] 每步结果进会话动态显示，transcript 按轮次与角色落面板
- [ ] 失败时状态置 failed 并显示错误而非静默
