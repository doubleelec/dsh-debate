# 可选审计字段不 bump 记录版本

`persist.ts` 头注释曾写"字段增删就 +1"。这条太严:审计型字段每次都 bump,
会让旧 host 把本可读的新局整局拒读(`fromRecord`: `v > RECORD_VERSION → null`),
违反"多恢复一局胜过少恢复一局"。

## 决定:只有不兼容变更才 bump

`RECORD_VERSION` 只在以下情况 +1:

- 新增**必填**字段(老记录缺它即不可用);
- 字段改名/删除;
- 字段语义改变(老代码按旧语义读会错);
- 老代码无法安全忽略的变更。

满足三件套的可选审计字段**不 bump**:

1. `?` 可选,老记录缺它即读成 unknown/null;
2. 只审计不 gate(不参与停机/恢复/渲染的必需路径);
3. 新代码读老记录、老代码读新记录,双向安全(多余字段 JS 直接忽略)。

## 判例:pointerAudit

`DebateRound.pointerAudit?: PointerAudit | null`(S11):老局缺字段 → 面板/收尾
按"无审计数"处理(null/unknown),不停机不报错;旧 host 读带它的新记录,
`rounds` 整数组透传,多余字段忽略,整局照读。双向兼容,bump 反而有害。

同一规则适用于后续审计字段(如 `gapSpans` 若某天进记录):先对三件套,
全满足就不 bump,缺一条就 bump。

## Consequences

- `persist.ts` 头注释改为"不兼容变更才 +1,见 ADR-0021"。
- 版本号 churn 消失:审计字段可以持续长,不再每次制造一次全拒读。
- 代价:读代码的人要认三件套,不能只看"字段增没增"——本 ADR 即检查表。
