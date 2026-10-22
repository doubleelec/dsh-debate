# 任务面板：AI 推荐涉及仓 + 入口前置草稿门

2026-10-22 落地。用户反馈：面板打开即全勾选仓库是错的——影响哪几个仓
应该由 cross-tasks 功能按任务来判断，面板只负责把判断结果摆出来让人审核；
入口"✦ 增强"应在输入框有内容时才能点（改名"增强会话"）。

## 抉择

- **"影响仓库" = 涉及仓（involved），不同名同物**：不引入新词，
  GLOSSARY 只新增"涉及仓推荐"，措辞用"推荐"不用"判定"。
- **"建任务之后再选仓"与代码矛盾**：`build` 写盘不可逆（directive + 一仓一封
  to-*.md），先 build 后选仓等于先写盘后定范围。正确顺序只能是
  选仓（用户审核）→ build → 预览 → launch；用户真正要的是"模型先推荐、人只审核"。
- **AI 只做"涉及仓推荐"，不碰任务描述**：任务描述 = 输入框草稿原文透传；
  title 缺省取推荐附带的简短标题，失败回退草稿前 40 字，再失败回退 slug。
- **推荐不是判决**：`task/recommend` 只做预勾选 + 理由展示；判不出来
  （描述含糊/调用失败）→ 空选 + 提示手勾，勾选权永远在用户手里。
- **整钮禁用是一次有意的反转**：推翻 ADR-0025"辩论无草稿可进面板"的可达性决定。
  空输入时整个"✦ 增强会话"按钮禁用（含辩论入口）。后人看到不要当 bug 改回去。

## 落点

- host 新增 `task/recommend`（第 8 条 task 路由）：输入任务描述 + 扫描到的
  repo 清单，host 起 one-shot 子 agent 做推荐（parent 三段式照抄 runHostDebate），
  返回 `{ recommended[], reasons{}, title }`，经 `cross_tasks/recommend.ts`
  `parseRecommendText` 清洗（未知仓过滤、标题截断、非法抛错→路由 ok:false）。
- `task.ts`：`suggestScanDefaults` 改契约——只定 slug，不预勾选；
  新增 `suggestTitleFromDraft`（标题回退）、`applyRecommendDefaults`（推荐合并）。
- 面板流程：开面板（需草稿非空）→ 自动 scan（只展示）→ 自动 recommend
  （预勾选 + 理由 + AI 标题，用户手改标题后不再覆盖）→ 用户审核勾选
  → build → 预览 → 确认 launch。
- WIRE-01 "7 task routes" → "8 task routes"。

## Client 落点

- `TaskDialog`：新增任务描述字段（prefill 自草稿，可改，[重新推荐] 按钮）；
  scan 后自动调 `task/recommend`；失败 → 空选 + 提示手勾 + 标题回退。
- 入口：dock 按钮改名"✦ 增强会话"，`disabled={!ready}` + 置灰；
  `openTask` 收草稿进 `prefillTaskDesc`（草稿不清）。
