# 停机三条件：共识收敛 / 覆盖饱和 / 跑满

09-30 grill 定下的停机语义：一局辩论在**任一**条件成立时停，`stopReason` 记明是哪一条。

1. **共识收敛（convergence）**：双方显式自报 `agree=true`，且 `answer=` 归一化后一致
   （`roundConverged` + `isConverged`）。地图产品下共识本身就是最强的完成信号。
2. **覆盖饱和（saturation）**：一整轮无新增信息（`isSaturated` → `hasNewInfo=false`，
   由 `detectNewInfo` 看新增缺口/视角/状态变化信号与文本相似度）。
3. **跑满（maxRounds）**：`maxRounds`（默认 5，钳 1~10）兜底，防无边辩论。

## 与 ADR-0004 的关系（本条是修正，不是推翻）

ADR-0004 的措辞是「停在覆盖饱和**而非**共识收敛」——那是在"产物＝单一结论、共识要靠
模型互相放水"的语境下写的。产物改成成果地图后，共识不再是唯一终点，但仍是最强信号，
所以 grill 决定**两条都留**：饱和防车轱辘，共识提前收，maxRounds 防 hang。

因此本条 **supersedes ADR-0004 的排他性表述**（"而非共识收敛"），保留其饱和思想。
ADR-0004 原文不改，作为历史决议留档——实战中挑战者据此判出"实现与 ADR 反向"，
正说明留档 + 修正比改写历史更可审计。

## 判定输入必须落盘（可审计性）

`stopReason` 只说"停在哪条"，答不了"停得对不对"。所以每轮把**判定所用的解析结果**
记进会话 `rounds: DebateRound[]`（`builderAnswer/builderAgree/challengerAnswer/challengerAgree/hasNewInfo`），
`/api/state` 一并返回；`toDebateRound` 保证**判定与审计用的是同一份解析输入**，
避免"判定用一份、审计看另一份"的漂移。

实测教训：`parseAgree` 曾用 `\b` 收尾，而 JS 的 `\b` 按 ASCII 词边界算，
中文 `agree=是` 因此永远匹配不上——共识条件静默失效。修法是中文分支不用 `\b`，
改用行尾/非词字符前瞻。

## Considered Options

- **只留饱和度（ADR-0004 原样）**：模型可能早就互相认可了还在硬辩，烧 token。
- **只留共识**：共识不到就无限辩，没有 saturaiton 兜底会车轱辘。
- **模型自报"我饱和了"**：要改 prompt 协议且模型自评不可靠；host 启发式零模型成本。
  （已选启发式，代价是召回偏低——见 `docs/architecture.md` §6 风险。）

## Consequences

- 停止理由可回跳：`stopReason` + `rounds[]` + transcript `[R轮 #seq 角色]` 三件套。
- 共识条件依赖模型守约输出 `agree=`/`answer=` 行；prompt 已把停机信号单列成段并警示漏写后果，
  解析器对全角/中文/大小写容忍，但仍可能出现假阴性（该停止却跑满）——比假阳性安全。
- `rounds[]` 只在内存，重启即清（与 transcript 同命）。
