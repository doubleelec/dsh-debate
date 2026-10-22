# 多仓任务：AI 推荐涉及仓 + 入口前置草稿门

Status: claimed（单会话落地）

## 背景

用户反馈（2026-10-22）：任务面板打开即全勾选仓库是错的——
影响哪几个仓应该由 cross-tasks 功能按任务来判断，面板只负责把判断结果
摆出来让人审核。入口"✦ 增强"应在输入框有内容时才能点（建议改名"增强会话"）；
多仓任务建起来之后，再弹对话框让用户选影响仓库（= 审核勾选）。

## 建模裁定（domain-modeling，2026-10-22）

1. **"影响仓库" = 涉及仓（involved）**：不同名同物，不引入新词。
   GLOSSARY 只新增"涉及仓推荐"，措辞用"推荐"不用"判定"。
2. **"建任务之后再选仓"与代码矛盾**：`build` 写盘不可逆（directive + 一仓一封
   to-*.md），先 build 后选仓等于先写盘后定范围。正确顺序只能是
   选仓（用户审核）→ build → 预览 → launch；用户真正要的是"模型先推荐、人只审核"。
3. **AI 只做"涉及仓推荐"，不碰任务描述**：任务描述 = 输入框草稿原文透传；
   title 缺省取 AI 推荐附带的简短标题，失败回退草稿前 40 字，再失败回退 slug。
4. **推荐不是判决**：`task/recommend` 只做预勾选 + 理由展示；判不出来（描述含糊/
   调用失败）→ 空选 + 提示手勾，勾选权永远在用户手里。
5. **整钮禁用是一次有意的反转**：推翻 ADR-0025"辩论无草稿可进面板"的可达性决定，
   ADR-0028 明确记录，免得后人当 bug 改回去。

## 落点

- 新增 host 路由 `task/recommend`（第 8 条 task 路由）：输入任务描述 + 扫描到的
  repo 清单，host 起 one-shot 子 agent 做推荐，返回 `{ recommended[], reasons{}, title }`。
  WIRE-01 的"7 task 路由"锁同步修订为 8。
- 面板流程：开面板（需草稿非空，入口整钮禁用）→ 自动 scan（只展示结构，不勾选）
  → 自动 recommend（预勾选 + 理由展示 + AI 标题）→ 用户审核勾选
  → build → 预览 → 确认 launch。
- `task.ts`：`suggestScanDefaults` 不再预勾选/定牵头（只定 slug）；
  新增 `suggestTitleFromDraft`（标题回退）、`applyRecommendDefaults`（推荐合并）。
- `cross_tasks/recommend.ts`：新增 `parseRecommendText`（模型 JSON 输出解析，
  未知仓过滤、标题截断）。
- 入口改名"✦ 增强会话"，空草稿整钮禁用（`disabled={!ready}` + 置灰样式）。

## Tickets

- `tickets/01-pure.md`：task.ts + recommend.ts 纯逻辑 + vitest。
- `tickets/02-route.md`：host task/recommend 路由 + 路由测试 + WIRE-01 锁更新。
- `tickets/03-panel.md`：面板推荐审核流 + 入口改名/禁用 + pytest + 文档。
