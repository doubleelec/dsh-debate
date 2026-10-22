# 03 — 面板：推荐审核流 + 入口改名/禁用 + 文档

Status: open

## What to build

- `src/client/index.tsx`：
  - 入口：dock 按钮改名"✦ 增强会话"，`disabled={!ready}` + 置灰
    （`.dshe-dockbtn-off` 已有）；`input.right` label 同步；
    `openTask` 收草稿进 `prefillTaskDesc`（任务描述）。
  - `TaskDialog`：新增任务描述字段（textarea，prefill 自草稿，可改，
    [重新推荐] 按钮）；scan 只展示结构不勾选；scan 后自动调
    `task/recommend` 预勾选 + 理由展示（`AI: …`）+ AI 标题（仅当标题仍为空或
    等于上次自动值时覆盖，由 `autoTitle` ref  guard）；失败 → 空选 +
    提示手勾 + 标题回退 `suggestTitleFromDraft`；slug 仍自拟。
  - 更新面板头注与 TaskDialog 注释（ADR-0025 → ADR-0028 流程）。
- pytest：新增 `test_client_task_recommend_wired`（面板调 `task/recommend` +
  用 `applyRecommendDefaults` 合并）；surface 门加新符号；`test_index.md` 加行。
- 文档：ADR-0028；`architecture.md` §4.4b 时序 + Elements + §5 ADR 列表 +
  QAS-7 行 + 任务流描述行；ADR-0026 加 supersede 注；GLOSSARY 加"涉及仓推荐"；
  `test_index.md` 行为表加 `task-recommend.test.ts` 行、改 `task-routes` 行计数。

## Done when

- 四门全绿；3080 硬刷验证。

## Result

- 2026-10-22 落地：build + sandbox 246/246 + pytest 34 + arch ALL CLEAR。
  `test_client_task_recommend_wired` 6/6 过；session.test.ts label 断言
  （`toContain('增强')`）不受改名影响（"增强会话"仍含"增强"）。
  done，待提交推送 + 装机验证。
