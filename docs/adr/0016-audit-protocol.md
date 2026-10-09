# 停机信号协议版本化 + 引用审计

B5 与 B6 都是"缺口清单"里同一个根子的两面：**辩论过程的判定依据必须能被事后检验，
且检验口径本身必须可追溯**。S3 把它们一次做掉。

## B5:解析协议版本位

`parseAgree/parseAnswer` 的正则一改，历史局的 `rounds[]` 就失去了可比性
（S1 修过一次 `agree=是` 漏判，S2 加过否定关——那些旧局的 agree/answer
是用哪套规则算出来的，当时没记）。

做法：`STOP_PROTOCOL_VERSION` 常量（当前 2），`toDebateRound` 每次构造记录时写入
`protoVersion`。规则很死：**改解析正则/回落策略/信号词表，必先 bump 版本号**，
vitest 里有一条 `Number.isInteger && >=2` 的 existence 断言守着（防顺手改正则忘 bump）。

- v1：`agree=/answer=` 行 + 结论摘要回落；
- v2：+ 否定关 + 显式无新增声明（S2 的两处改动，当时没版本号，追认为 v2）。

代价：版本号只记"算的时候是哪套"，不做多版本并存解析——旧局不重算，
要重算就按当前版本重跑 `toDebateRound`（纯函数，transcript 还在就行）。

## B6:引用审计

挑战者的硬约束是"每条挑战必须引用对方原文"，但之前没人验证它做没做到。
不靠模型自报（它说引了就是引了？），靠 **transcript 回放统计**：

`auditQuotes(builderOut, challengerOut)` —
建构者本轮输出去掉段标题/`[对方自报]`行/`agree=/answer=`行/空行后，
长度≥12 字的行是"可引用行"；挑战者本轮 text 里出现该行原文即算命中。
返回 `{quotableLines, quotedLines, hitLines, hitRate}`，
无可引用行时 `hitRate=null`（与"引用 0 行"区分：前者是建构者输出太短，
后者是挑战者没干活）。

- `QUOTE_HIT_ALERT=0.3`：命中率低于此值告警——主要看**瘦身有没有砍掉关键证据**
  （B4 的瘦身把详细论证截到 60%+40%，如果挑战者引用的恰好是被裁中段，
  命中率会掉，这是目前唯一能量化瘦身质量的地面真值）。
- 阈值 12 字：防"的/了/上 K8s"式短行误命中；`hitLines` 记相对行号，
  可回跳 transcript 原文核对。

局限（已在 action-plan 记为 B6 后续）：子串命中是必要非充分条件——
复制了原文但曲解原意，审计看不出来；改写转述（钢人化复述本身就是改写）
不算命中，会系统性低估"真实引用"。所以 hitRate 是**下限估计**，
只用于告警"瘦身砍太多"，不用于判定"挑战者没干活"。

## 联调

host 早就经 `/api/state` 返回 `stopReason/rounds[]/mirrorCount/mirrorError`，
但面板和实况页都没接——S3 把它们接上：

- 面板 `DebateDialog`：新增"停机审计"块（stopReason + 每轮 agree✓/✗ +
  答案前 18 字 + 引用命中 + 交棒字数）与镜像状态行；
- 实况页 `live.ts`：meta 区同款信息（文本版）；
- `splitSections` 从 `index.tsx` 抽到 `src/client/sections.ts` 纯文件，
  面板分段逻辑可单测，不拖 React/CSS。
