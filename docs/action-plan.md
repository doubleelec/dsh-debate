# dsh-debate Action Plan

> Resume point: S7（协议 v4 聚焦与收尾）+ S8（版本真值）实现完成并本地验证通过——协议层直跑断言 39/39、版本真值集成断言 8/8（打真实构建产物）、`tsc --noEmit` / `npm run build` 绿、pytest 治理门 15 passed。
> **迁到 v0.4.0 必须先重启宿主进程**：`lib/index.js` 只在宿主启动时加载，DSH 无插件热重载（ADR-0018）。
> 重启前面板徽标显示 `v?` + 告警（旧宿主没有 `/api/version`，实测 POST 返回 405），这是设计行为不是故障。
> 重启后徽标应显示 `v0.4.0` 且无告警；随后跑一局真辩论复验 S7：(a) 轮数是否真的下降、(b) 挑战者是否守约输出 `待决清单=` 行、(c) 对话区字数与收尾陈述是否可读。

## Waves

- **Wave 0 (Governance scaffolding)**: retrofit 基线——`architecture.toml`、`src/module.toml`、`src/client/module.toml`、vendored 治理套件、`docs/test_index.md`、`docs/architecture.md`。退出条件：`arch_engine.py check` 无 ERROR、pytest 治理门全绿。
- **Wave 1 (Resident debater)**: 常驻辩手核心——host 起两个常驻辩手会话，`followup` 交棒、`whenIdle` 等 turn、自有事件后缀取交棒结论；开题互盲、交锋串行、制图只读实录；停机三条件（ADR-0014）+ `mode`/`residentError`/`stopReason`/`rounds[]` 可观测；建对失败回退一次性并记原因；进度感知超时（4min stalled / 20min 硬顶）+ provider `error` 有界重投。退出条件：真 1 轮辩论端到端跑通，transcript 结构与交棒链不断。
- **Wave 2 (Context budget)**: 交棒载荷瘦身（ADR-0015：首见全文、此后跨轮传摘要+本轮变化、详细论证头尾截断，实测 -87%）+ `builderRelayChars` 可观测 + 饱和启发式否定关（B1）+ 跨入口判定同源（B2）+ 清死配置（B3）。退出条件：多轮 prompt 不爆，饱和可测。
- **Final Wave (Integration & System testing)**: 跨 host+client 联调（面板停机审计块 + 对话区镜像状态 + 实况页同款 + `splitSections` 抽纯文件可测）与全门回归 + B5/B6（ADR-0016）。退出条件：治理门 + vitest 全绿，一局可读的真辩论。
- **Wave 3 (Focus & legibility)**: 复盘一局真跑 10 轮（10.9 万字、饱和 10/10 误判、对话区灌 10.9 万字、7,015 字地图无决策陈述）后的协议 v4——未决清单焦点账本（`待决清单=` + `pendingStalled`）、新增判定只看「本轮变化」段、篇幅预算（1800 字）、对话区镜像摘要（`chatDigest`）、收尾陈述（制图「决策摘要」+ `buildFallbackSummary` 兜底）+ 面板收尾陈述块（ADR-0017）。退出条件：聚焦/有效/易懂三项各有实测读数支撑，一局跑完对话区直接给出下一步。

## Serial constraints

- Wave 1 在 Wave 0 之后（治理门先绿，seam 才能动）。
- Wave 2 在 S1 接口冻结之后（交棒载荷形状先定，再做瘦身）。
- Final Wave 在 Wave 1 + Wave 2 之后（端到端只验稳定的 relay）。

## Backlog from live runs (辩手自己挖出来的真缺口)

真跑四局（1 轮 ×2 + 2 轮 ×2，均 `mode=resident`）后，挑战者侧独立读出的缺口：

| # | 缺口 | 状态 |
| - | ---- | ---- |
| B1 | `detectNewInfo` 关键词子串把否定句读成新增 → 饱和失效 | **done (S2)**：否定关 + 显式无新增声明 |
| B2 | 工具分步入口跑完即 `done` 但 `stopReason=null` | **done (S2)**：`recordRoundAndJudge` 判定同源 + `manual` |
| B3 | `judgeEnabled` 死配置（无实现、无人读、面板不传） | **done (S2)**：从 interface 移除 |
| B4 | 交棒载荷传全文 → 多轮膨胀 | **done (S2)**：`slimHandoff`（-87%） |
| B5 | `agree`/`answer` 解析无版本位，协议一改无法追溯旧局 | **done (S3)**：`STOP_PROTOCOL_VERSION=2`，`rounds[].protoVersion` 落盘 |
| B6 | 无"引用命中率 / 被裁区间"地面真值，瘦身是否砍掉关键证据无量化 | **done (S3)**：`auditQuotes` 片段级（12 字窗）+ `QUOTE_HIT_ALERT=0.3`；verify9 重算 R1 14/43、R2 37/67 |
| B7 | 防呆把双方 `MODEL:unknown` 误判成"路由没生效"整场毙掉 | **done (S3)**：`isRouteIneffective`，unknown/null 不参与判定 |
| B8 | `detectNewInfo` 在整篇 6000~8000 字里找信号词 → 10/10 轮误判"有新料"，饱和停机成死代码 | **done (S7)**：新增判定只看「本轮变化」段 + 未决清单焦点停滞（ADR-0017） |
| B9 | 挑战者每轮"接受①②但须补三处"，新条件散在正文无编号 → 逐轮重述、10 轮才收敛 | **done (S7)**：`待决清单=` 焦点账本逐条带进下一轮，已结项不得重开 |
| B10 | 对话区被逐字镜像灌入 10.9 万字；产物是 7,015 字地图，读完不知道下一步 | **done (S7)**：`chatDigest` 只镜像结论摘要 + 制图「决策摘要」段单独收尾 |

## Progress

| Spec | Description | Status | Gate |
| ---- | ----------- | ------ | ---- |
| S0 | Governance scaffolding: TOML + vendored suite + architecture.md | done (2026-09-30) | arch check 无 ERROR, pytest 治理门绿 |
| S1 | Resident debater core: 双常驻会话 + 交棒 + 停机三条件 + 可观测 + 进度感知超时 + 重投 | done (2026-09-30) | 真 1/2 轮端到端: tr=5/7, stop=maxRounds, mode=resident, rounds[] 落盘, 泄漏 0 |
| S2 | Context budget: 交棒瘦身 + 饱和否定关 + 判定同源 + 清死配置 | done (2026-09-30) | 真 2 轮 relay=[3628,2403], 协议层 19/19 真跑校验, 演进链完整 |
| S3 | Final integration & system testing: 联调 + 全门回归 + B5/B6/B7 | done (2026-09-30) | vitest **53/53** + S3 真跑 20/20 + 联调 2 轮 tr=7 + tsc/pytest/arch 全绿 |
| S4 | 实时流(A):常驻 turn 流式文本 + 工具心跳 + 开题统一清流 | done (2026-09-30) | vitest **55/55** + verify10/11 联调(stream/text/tools 均见) + 全门禁绿 |
| S5 | 目标工作区(targetCwd):评审别家工程 + 实况 API 基址推导 + sessionId 露出 | done (2026-09-30) | vitest **56/56** + verify12 ai_proxy 联调(挑战者读到 architecture-auto.md) + 全门禁绿 |
| S6 | 面板可读性:重开版本号徽标 + 可缩放/全屏(纵向覆盖输入框)/最小化 + 人话轮次标签与轮次小结 + 删独立实况页 + 纯函数抽取(`labels.ts`/`dialogLayout.ts`) | done (2026-10-01) | tsc/build 绿 + 纯函数直跑断言(labels 10/10、dialogLayout 14/14) + 生产 3080 目视 |
| S7 | 协议 v4 聚焦与收尾:未决清单焦点账本 + 新增判定只看变化段 + 篇幅预算 + 对话区镜像摘要 + 收尾陈述(决策摘要/兜底)+ 面板收尾块 | done (2026-10-01) | 协议层直跑断言 **39/39** + vitest 用例已补 + tsc/build 绿 + pytest 治理门 15 passed |
| S8 | 版本真值:构建期内联 `BUILD_VERSION` + `/api/version` 三方对账(内联/磁盘/mtime vs 启动时刻)+ 徽标显示正在跑的版本(取不到显示 `v?`)+ 重启宿主/刷新页面两类提示 | done (2026-10-01) | 真实构建产物集成断言 **8/8**(running==disk、mtime 可读、stale=false、反事实判 stale)+ tsc/build 绿 + pytest 治理门绿 |
