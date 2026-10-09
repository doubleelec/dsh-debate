# host 直驱：点开始就自动跑，不再经过触发语

09-28/29 实测链：自动发送触发语 via composer `submit()` 导致
`resume failed for session`（提交面在会话未就绪时顶坏状态机），
触发语烂在输入框；改手动复制又不优雅。

v0.3 改 host 直驱：`/start` 建单后以后台任务直接跑
`runHostDebate`（stepOpen→stepRound×N→stepSynthesize），
进度落 transcript，面板 2s 轮询展示。parent 优先
`ctx.agents.get(sid)`（面板从 input.right 标准 props 的 sessionId 传来）；
活体为空（重启后浏览器未重连）则 host 用 `agents.create`
自建一次性 parent（cwd=进程目录，模型=合成器路由），跑完 dispose。

探针验证（09-29）：1 轮“上不上K8s?”，开题双 4800 字→交锋→地图 8050 字，
`status=done`，无 MODEL: 回显泄漏（防呆通过）。
注意：开题约 2 分钟，交锋每方约 1-2 分钟，5 轮全程约 15-20 分钟，
面板轮询看进度即可。

自检路由：`/api/debug`（工具注册）+ `/api/debug-agent`（活体列表/sid 解析）。
