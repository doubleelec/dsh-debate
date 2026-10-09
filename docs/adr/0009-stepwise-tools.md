# 分步工具将会话直播，替代单次跑完

debate_run 一次跑完、会话静默等结果的形态，满足不了"辩论过程在会话中动态显示"。
执行链拆成 debate_open（开题）→ debate_round（逐轮）→ debate_synthesize（制图）三工具，
模型按面板状态机一步步调，每步返回的本轮全文自然落进会话，会话即直播。
面板照常轮询做汇总展示。debate_run 保留作兼容与单测。
代价是轮次纪律回到 prompt 约束，由面板状态（round/maxRounds）与工具返回的下一步指引兜底。
