# dsh-debate Action Plan

> Resume point: Wave 6 - in flight: none - blocked: none
> S21 落定——`architecture.md` 正名为全工程唯一架构（双功能：辩论 §4.4a + 任务 §4.4b）；`debate-design.md` 收敛为辩论 v0.1 冻结草稿；CONTEXT 补多仓任务五词；README 重写双功能。
> S20 落定：测试单目录 + 占位换活门 + 文档补齐，双绿 + ALL CLEAR。
> 单线分叉后一局只产 1 个分叉会话文件（+N×3 个 one-shot 落盘，宿主行为改不了），结束扫掉只留结论文档；用户主会话零污染（转述+摘要才进对话区）。
> 待线上真跑一局复验：fork→交替→扫盘全链（面板看 `mode:single`）+ 版本号 bump（0.13.0→0.14.0，新功能 minor）。
> **迁到 v0.5.0 必须先重启宿主进程**：`lib/index.js` 只在宿主启动时加载。准确说不是 DSH 没有热重载，而是本 profile 没开**模块监听**（`dsh-base` 里 `hmr` 的 `root: []`，注释"module roots are opt-in"；ADR-0018 同日更正）。
> 重启前面板徽标显示 `v?` + 告警（旧宿主没有 `/api/version`，实测 POST 返回 405），这是设计行为不是故障。
> 重启后徽标应显示 `v0.5.0` 且无告警；随后跑一局真辩论复验两件事：S7（(a) 轮数是否真的下降、(b) 挑战者是否守约输出 `待决清单=` 行、(c) 对话区字数与收尾陈述是否可读）与 S9（(d) `<工作区>/docs/debates/` 下是否真出现结论文档、(e) 再重启一次后粘旧 id 是否仍能取到结论与全文）。
> 沙箱里 `npm test` 起不来（Vite 解析配置 `exec("net use")` → `spawn EPERM`），用 `npm run test:sandbox`：它编译并执行**同一份**测试文件，垫片遇到未实现的 matcher 会抛错而非静默通过。

## Waves

- **Wave 0 (Governance scaffolding)**: retrofit 基线——`architecture.toml`、`src/module.toml`、`src/client/module.toml`、vendored 治理套件、`docs/test_index.md`、`docs/architecture.md`。退出条件：`arch_engine.py check` 无 ERROR、pytest 治理门全绿。
- **Wave 1 (Resident debater)**: 常驻辩手核心——host 起两个常驻辩手会话，`followup` 交棒、`whenIdle` 等 turn、自有事件后缀取交棒结论；开题互盲、交锋串行、制图只读实录；停机三条件（ADR-0014）+ `mode`/`residentError`/`stopReason`/`rounds[]` 可观测；建对失败回退一次性并记原因；进度感知超时（4min stalled / 20min 硬顶）+ provider `error` 有界重投。退出条件：真 1 轮辩论端到端跑通，transcript 结构与交棒链不断。
- **Wave 2 (Context budget)**: 交棒载荷瘦身（ADR-0015：首见全文、此后跨轮传摘要+本轮变化、详细论证头尾截断，实测 -87%）+ `builderRelayChars` 可观测 + 饱和启发式否定关（B1）+ 跨入口判定同源（B2）+ 清死配置（B3）。退出条件：多轮 prompt 不爆，饱和可测。
- **Final Wave (Integration & System testing)**: 跨 host+client 联调（面板停机审计块 + 对话区镜像状态 + 实况页同款 + `splitSections` 抽纯文件可测）与全门回归 + B5/B6（ADR-0016）。退出条件：治理门 + vitest 全绿，一局可读的真辩论。
- **Wave 3 (Focus & legibility)**: 复盘一局真跑 10 轮（10.9 万字、饱和 10/10 误判、对话区灌 10.9 万字、7,015 字地图无决策陈述）后的协议 v4——未决清单焦点账本（`待决清单=` + `pendingStalled`）、新增判定只看「本轮变化」段、篇幅预算（1800 字）、对话区镜像摘要（`chatDigest`）、收尾陈述（制图「决策摘要」+ `buildFallbackSummary` 兜底）+ 面板收尾陈述块（ADR-0017）。退出条件：聚焦/有效/易懂三项各有实测读数支撑，一局跑完对话区直接给出下一步。
- **Wave 4 (Durability & verification)**: 结论落盘（ADR-0019）——整局记录进 KV 单元 `dsh_debate`、启动恢复、结论文档写 `<工作区>/docs/debates/`、镜像报路径、面板可观测；外加把"从不运行的测试套件"救回来（`npm run test:sandbox`）。退出条件：重启后旧 id 仍能取到结论，且回归有可重复的入口而不是一次性脚本。
- **Wave 5 (Test merge & doc completion)**: 测试单目录 + 占位换活门 + 文档补齐（S20）——`test/` 并入 `tests/vitest/`，三占位换 10 活门 + 四红线落 TOML，architecture.md 补 4.1/4.2/4.6。退出条件：vitest + pytest 双绿，arch check ALL CLEAR。

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
| B11 | 整个测试套件在本机沙箱里**从不运行**（vitest 解析配置 `exec("net use")` → `spawn EPERM`），验证退化成只剩类型检查；手写的一次性断言脚本还放在 `.tmp/`，而该目录约定"任何会话可随时清空"——工具和结论一起丢 | **done (S9)**：`npm run test:sandbox` 编译并执行**同一份**测试文件（不另写平行断言），垫片遇到未实现的 matcher 抛错而非静默通过；跑出 139/139 |
| B12 | 结论只活在 host 内存 + 对话区镜像里：前者一重启就 `unknown-id`，后者正是上下文压缩要吃掉的东西 | **done (S9)**：整局记录进 KV（重启后旧 id 仍可用）+ 结论文档进工作区（压缩后 `read <路径>` 仍能拿回逐字原文，ADR-0019） |
| B13 | 上限设 5 就第 5 轮一致、设 10 就第 10 轮一致：`第 R/M 轮` 的计数器给了模型明确的截止线压力，最后一轮主动收官；但所有停机说法都只写"共识收敛"，用户无法评估"轮数是不是刚好" | **done (S10)**：`convergedAtCap` 修饰位（只影响说法不影响停机）+ 镜像/收尾/面板三处标"压线"并给加轮复验建议（ADR-0020） |
| B14 | 引用指针无人校验：`live/run_live.py:162-172` 这种全场最硬的索赔建立在没人验过的指针上，`quoteAudit` 只验"抄没抄对方"，不管"引的文件存不存在" | **done (S11)**：`extractPointers` + `auditPointers`（只抽文件型、节引用不抽、只审计不 gate）+ 兜底/面板/报告三处报数（ADR-0021 判例） |
| B15 | 最大缺口存活整场：R0 点名的三处体积数到 R10 还没测，一致照样达成，但"这次一致没覆盖什么"没有一句现成的话 | **done (S11)**：`parseGaps` + `gapAge`（存活轮数进审计）+ 收尾/报告"未覆盖"声明（只说事实不拦停机） |
| B16 | 清单截断劈词：60 字硬切把"避免同 ef"/"作 \`.live_"这种半截话送进下一轮焦点块 | **done (S11)**：`clipWord` 回退到 60 字内最后一个空白/标点，无边界才硬切 |
| B17 | 轮数静默截断：用户填 20，`normalizeConfig` 里 `Math.min(10,…)` 静默压成 10，面板还显示 20 | **done (S12)**：上限 20（10 轮题刚好压线，超 20 未收敛多半真谈不拢）+ 钳制留痕（`config.note` 进第一条 progress） |
| B18 | 文件名啰嗦：40 码点 slug 让中文问题变成 40 字文件名，`ls` 糊成三行 | **done (S12)**：去语气词 + 12 码点上限（文件名是索引，标题全文在文件内第一行） |
| B19 | 总结晦涩：决策摘要写给参辩模型看的备忘录——"Goal 编排层""[R3#8]""试点跑任务记耗时"，没参辩的决策者看不懂 | **done (S12)**：制图 prompt 语言铁律三条（术语展开/依据说人话/下一步可执行）+ 兜底收尾同步 |
| B21 | 结论跑偏：决策摘要围着辩论过程转（"k≤3 只排隔离稳"），用户读完不知道下一步选什么 | **done (S14)**：题型结论形状（selection 给推荐/tradeoff 给条件式/review 给 verdict/causal 给机制）+ 结论/收敛状况拆行 + 制图输入清洗（去 host 协议行）+ answer= 收窄（普通读者一句话；只有选择题写可执行选择）+ 兜底分档（收敛/单方接受给可执行说法，未收敛无推荐） + 协议版本 5→6 |
| B22 | 文件名与内容双丢问题：hint"就以上问题继续辩论"被直接当整局问题，文件名是废话、内容看不出在辩管理架构 | **done (S15)**：承接语消解（hint 只有指代无实质问题时视为无 hint，回落找真正的用户问题）+ slugify 清承接语外壳做纵深 |
| B23 | 中间结论 invisible：R16"轮=2h 人在场"、R18 两合取既不在未决清单也不在判据锁存，下一轮看不见，R19 换个角度重开 | **done (S15)**：已决事项第三本账（concession 非定义接受行，随焦点块带进下一轮，已决不得重开除非给反例）+ 协议版本 6→7 |
| B20 | 打分题跑满 20 轮：R15–R20 全在"横连贯"一格里换尺子（同一格子四轮换三种含义），饱和停机全程没触发（每轮都有真新增），`stop=maxRounds` 但一方已接受 | **done (S13)**：定义锁存（已接受判据进焦点块，换尺重算即违规）+ 议题循环停机（清单在变但 4 轮清不空、答案面不动则提前收尾）+ 跑满细分（单方接受则结论可用，不说"谈崩"） |

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
| S9 | 结论落盘:整局记录进 KV 单元 `dsh_debate`(per-record,显式白名单)+ 启动恢复(半途的标已中断)+ 结论文档写 `<工作区>/docs/debates/`(日期-slug-id尾)+ 对话区镜像报路径 + `/api/history` + 面板显示路径/恢复标记/两类失败分开 | done (2026-10-01) | 真实 vitest 套件 **139/139**(新增 persist 35 条:白名单、宽容反序列化、文件名净化、markdown 结构)+ 真实构建产物集成断言 **11/11**(含 storage/history/docs-debates/ctx.effect 接线)+ tsc/build 绿 + pytest 治理门绿 |
| S10 | 压线共识明示:上限处一致加 `convergedAtCap` 修饰位(只改说法不改停机)+ 镜像/兜底收尾/面板审计三处标"压线"并给"加 1~2 轮复验"建议 | done (2026-10-19) | 真实 vitest 套件 **145/145**(新增 6 条:压线判据 7 分支、兜底三态、面板 stopKey 4 分支)+ 线上局 `debate-mveltqkm-1` 三元组复核(stop=convergence, R10 才双 agree)+ tsc/build 绿 |
| S11 | 诚实度三件:出处指针审计(只抽文件型、只审计不 gate)+ 缺口年龄(存活轮数+未覆盖声明)+ 清单截断不断词 | done (2026-10-19) | 真实 vitest 套件 **156/156**(新增 11 条:截断词边界、指针抽取/审计/裸路径、缺口抽取/年龄、接线、兜底两行、报告节、面板小结)+ 双轴 code-review(Standards 2 硬伤/Spec 4 真 bug 全收)+ tsc/build 绿 |
| S12 | 新局三反馈:轮数钳制留痕(上限 10→20)+ 文件名精练(去语气词+12 码点)+ 总结语言铁律(术语展开/依据说人话/下一步可执行) | done (2026-10-19) | 真实 vitest 套件 **160/160**(新增 4 条:钳制上限+留痕、制图铁律、兜底人话、slug 精练)+ 线上局 `debate-mvf5l8vs-1` 三元组复核(stop=convergence, R10 压线, `deploy_live` 指针命中)+ tsc/build 绿 |
| S13 | 打分题收敛三件:定义锁存(`settledDefsOf`+焦点块锁存段,换尺重算即违规)+ 议题循环停机(`isTopicLoop` 4 轮清不空+答案不动则饱和,停滞优先)+ 跑满细分(`isOneSidedAccept` 单方接受则结论可用)+ 协议版本 4→5 | done (2026-10-19) | 真实 vitest 套件 **165/165**(新增 5 条:锁存空清单不断、停滞/循环区分、单方接受分支+同源判据、分歧行豁免)+ 双轴 code-review 复审(Standards 2 硬伤/Spec 4 真 bug 全收)+ tsc/build 绿 |
| S14 | 结论答题化:制图 prompt 按题型给结论形状(`answerShapeOf`)+ 结论/收敛状况拆行(`过程不许进结论第一句)+ 制图输入清洗(`renderTranscriptForSynthesizer` 去协议行)+ answer= 收窄(`answerSpecOf`,交锋轮现场分类)+ 兜底分档(收敛/单方接受给可执行说法,未收敛无推荐)+ 协议版本 5→6 | done (2026-10-19) | 真实 vitest 套件 **170/170**(新增 5 条:题型形状 4 分支、结论职责拆分、answer 定义收窄、sanitize 去协议行、兜底分档)+ 构建产物断言 9/9 + tsc/build 绿 + pytest 治理门绿 |
| S15 | 问题保真与中间账本:承接语消解(`isContinuationHint`,hint 无实质问题时回落找真正用户问题)+ slugify 清承接语外壳做纵深 + 已决事项第三本账(`settledItemsOf`纯函数+`settledItemsOfSession`,随焦点块带进下一轮,已决不得重开)+ 协议版本 6→7 | done (2026-10-20) | 真实 vitest 套件 **174/174**(新增 4 条:hint 承接语过滤、slugify 兜底、已决收集分账、焦点块已决段)+ 构建产物断言 9/9 + tsc/build 绿 + pytest 治理门绿 |
| S16 | 白名单工具笼:deny 黑名单改 allow 白名单(fail-closed)+ 辩手 6 项/制图员 3 项 + 启动交集核对(失效剔除/空集失败)+ scope-local 执行期 guard + 生效笼型进已启动行与落盘(cageNote,可选审计字段,ADR-0022) | done (2026-10-20) | 真实 vitest 套件 **181/181**(新增 7 条:双名单只读、角色取名单、交集剔除/空集失败、visibleNamesOf、笼标签、guard 拦 scope-local、cageNote 往返)+ 构建产物断言 12/12 + tsc/build 绿 + pytest 治理门绿 |
| S17 | 会话接管 B 方案:忙快照(parentBusy 每轮采样)+ 一键双停(/api/interrupt,parent.cancel keepInbox + abort 后台)+ 打断可映射(interruptedAt 落盘/state/面板画线)(ADR-0023) | done (2026-10-20) | 真实 vitest 套件 **186/186**(新增 5 条:打断标记、落盘往返×2、忙快照、双停计划)+ 构建产物断言 14/14 + tsc/build 绿 + pytest 治理门绿 |
| S18 | 增强入口与跨仓任务并入(ADR-0025):launcher 三纯模块移植 src/task/ + /api/task/* 7 路由 + task_* 5 工具(host)+ 输入框增强菜单 + TaskDialog 三步面板 + src/client/task.ts 纯逻辑(client,原生发送键不借用) | done (2026-10-20) | 真实 suite 229/229(
pm run test:sandbox,含新增 task 22 + 增强 label 1)+ tsc/build 绿 + pytest 治理门 17 passed |
| S19 | 单线分叉(ADR-0024):单模型双角色交替线默认驱动——fork 发起会话(seed=当前上下文,isSeeded=true,模型锁定发起会话当前模型),建构写完挑战接着写(串行,无互盲);失败回退常驻(开题互盲),再失败回退 one-shot(失败链留痕`single:…; resident:…`);种子补 forked closer(照抄 openTurnClosers);结束扫分叉文件只留结论文档(sweepError/sweptSessions 落盘,可选审计字段不 bump 版本);防呆 isRouteIneffective 豁免单线 | done (2026-10-20) | 真实 vitest 套件 **192/192**(新增 6 条:fork 种子前缀+end-seed/开尾 closer/分叉血统+种子透传+模型锁定/串行交替 transcript 同形/mode 三态往返/sweep 落盘往返)+ 双轴 code-review 复审(Spec 3 硬伤全收:扫盘/模型锁定/失败链; SingleThread 包 ResidentAgent 去 cast)+ tsc/build 绿 |
| S20 | 测试合并与文档补全(arch reconcile):`test/` 11 文件并入 `tests/vitest/`(import 深度+1,动态 import 一处,tsconfig/vitest.config/test-sandbox.mjs 跟进);三占位换 10 活门(src 5/client 3/task 2,require_invariants=true×3,WIRE-01/CAGE-01/PANEL-01/PURE-01 四红线落 TOML);test_index 从治理目录扩为两扇门总目录(行为 11 行);architecture.md 补 Scope 双功能判据/4.1 三态载体/4.2 分层+Legend/4.6 安全视图/§7 单一 tests | done (2026-10-21) | vitest 229/229 + pytest 26 passed/5 skipped + arch check ALL CLEAR |
| S21 | 文档结构收敛(arch reconcile):architecture.md 正名为全工程唯一架构(Functions 双功能/利益相关者+任务发起人/QAS-7 先审后发/4.1 双 Context 图/4.2 task 三纯模块展开/4.4a+4.4b 双时序/4.5 同包发布/§7 229 用例构成);debate-design.md 收敛为辩论 v0.1 冻结草稿（定位+映射表快照注记）;CONTEXT 补多仓任务五词;README 重写双功能 | done (2026-10-21) | arch check ALL CLEAR + pytest 26 passed/5 skipped + sandbox 229/229 |
| S22 | 对称收敛(src/debate 与 src/task 平级对等):debate.ts/lenses.ts/persist.ts 搬入 src/debate/(host import/test import/require 同步);version.ts 留顶层共享;src/module.toml 加 debate + SYM-01 对称红线;src/debate/module.toml + DEBATE-01 + tests/src/debate/ 镜像;architecture.md §1/§4.2/§4.3/§7 同步整体架构图 | done (2026-10-21) | arch check ALL CLEAR + pytest 29 passed/5 skipped + sandbox 229/229 + build 205.95kB |
| S23 | 改名(src/task → src/cross_tasks):原型废弃腾名，内部目录取 cross_tasks(snake)，公开面 task_*/api/task/* 不动(breaking 边界);host import/vitest import/test_ref/TOML/文档同步;SYM-01 同步;命名三层写进 §1 Coverage(跨仓任务/cross_tasks/cross-tasks 不混用) | done (2026-10-21) | arch check ALL CLEAR + pytest 29 passed/5 skipped + sandbox 229/229 + build 205.97kB |
| S24 | 删 debate-design.md(冻结草稿进 git 历史) + 补 Context 总图:总图讲黑盒整体(用户/菜单/面板/插件/parent/agents/落点)，分图保留讲线细节;README/architecture 头注同步清理 | done (2026-10-21) | arch check ALL CLEAR + pytest 29 passed/5 skipped + sandbox 229/229 |
| S26 | 职责归图映射归表:4.2 换五层职责图(入口/交互/服务/载体/留存，无文件名);4.3 表 Reason 列补职责到目录映射(旧 src/task 记更名);文件名索引留 Elements | done (2026-10-21) | arch check ALL CLEAR + pytest 29 passed/5 skipped + sandbox 229/229 |
| S25 | Context 收成单总图:删 debate/task 分图(功能区分在内部，黑盒不分图);Elements 指向 4.4a/4.4b 时序;Logical 保持单整体图;Task 子图目录名同步 cross_tasks | done (2026-10-21) | arch check ALL CLEAR + pytest 29 passed/5 skipped + sandbox 229/229 |
