# ADR-0032 — 能力缺失是缺陷，不是退化理由

- 状态：已采纳（2026-10-23）
- 上下文：ADR-0031（provider/model 改下拉）
- 触发：用户追问"取不到列表时退化为手输"——这逻辑对不对？

## 问题

ADR-0031 落地时，`task/models` 写成"`llm` 服务取不到就回空列表，面板退化为手输框"。用户指出：
**先判断"取不到"是机制不允许还是代码错误；前者改设计，后者修问题。退化不是答案。**

## 调查

`llm` 是宿主注册的 Context 服务：`@deepseek-ai/dsh-llm` 的 `declare module` 明确
`interface Context { llm: LlmRuntime }`，且 `LlmRuntime` 提供
`listProviders(): LlmProviderInfo[]` 与 `listModels(provider): Promise<LlmModelInfo[]>`。
插件 apply 运行在宿主 context 里，`ctx.get('llm')` 就是该服务。

结论：**机制允许，列表本应取得到**。原来的"退化"分支是我凭空加的防御，它把接线缺陷
（服务名写错、依赖没装、apply 跑在错误 context）伪装成"正常的手输状态"，
用户永远不会知道东西坏了。

## 决定

1. **`llm` 缺失 = 接线缺陷 → `ok:false` + 明确错误**，面板显示红色错误块
   "这是接线缺陷(宿主 Context.llm 应提供 listProviders/listModels),不是需要手填的理由"，
   下拉禁用、只能用宿主默认。不提供手输替代路径。
2. **单 provider 的 `listModels` 抛错**（适配器可以不广告模型，是合法能力差异，不是缺陷）：
   收进 `providerErrors[{provider,error}]` 逐个点名，**不静默吞**；面板在该 provider 被选中时
   显示"该 provider 未广告模型清单(<原因>)"，只有这种**经点名确认**的情形才允许手填 model id。
3. 一般规则（写进评审口径）：**降级/兜底只在"机制明确不支持"且"降级本身有独立价值"时才允许，
   且必须在 UI 上说清降级原因**。以"以防万一"为由的静默兜底一律视为缺陷。

## 后果

- 好处：坏了会喊；`providerErrors` 让"适配器不广告清单"和"服务没接上"在界面上可分辨；
  手填只在被证明需要时出现。
- 代价：宿主若真的没有 `llm`（极端裁剪的嵌入场景），面板会一直显示错误——这是**如实反映**，
  不是新问题。
- 回归锁：`tests/vitest/task-routes.test.ts` 两例——正常列表（含单个 provider 失败被点名）
  与 `llm` 缺失必须 `ok:false`。

## 验证

- `tests/vitest/task-routes.test.ts`：`task/models` 契约（providers/models/providerErrors/current）、
  `llm` 缺失报错。
- 真机：重启后 `node scripts/probe-recommend.mjs` 同族探针，或面板下拉是否列出真实 provider。
