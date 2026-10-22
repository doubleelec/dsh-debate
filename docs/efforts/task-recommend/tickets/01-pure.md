# 01 — 纯逻辑：推荐合并 + 标题回退 + 模型输出解析

Status: claimed

## What to build

- `src/client/task.ts`：
  - `suggestScanDefaults` 改契约：只定 `slug`（+ `title` 回退字段保留），
    `checked`/`lead` 恒为空（不再预勾选，ADR-0028）。
  - 新增 `suggestTitleFromDraft(draft)`：空白折叠后取前 40 字，超长加 `…`，
    空回 `''`（recommend 失败时的本地回退）。
  - 新增 `applyRecommendDefaults(found, recommended)`：recommended ∩
    扫描到的 repo/part（保推荐序、去重），`lead` = 首个；都不中则空选。
  - `validateTaskBuild` 的 involved 缺项文案更新（旧文案里的"点「加入」"
    在当前 UI 不存在）。
- `src/cross_tasks/recommend.ts`（新文件）：`parseRecommendText(text, known)`，
  从模型输出中提取 JSON（首 `{`…末 `}`），校验：
  `recommended` 只留 known 里的（保序去重），`reasons` 只留推荐仓的，
  `title` 去空白截 60 字；无 JSON/非法直接抛错（路由回 ok:false）。
- vitest：更新 `task-panel.test.ts`（scan 默认 + 新函数），
  新增 `task-recommend.test.ts`（解析：正常/未知仓过滤/无 JSON 抛错/标题截断）。

## Done when

- `npm run test:sandbox` 全绿；pytest client surface 门列出新符号。

## Result

- 2026-10-22 落地：sandbox 243/243（task-panel 11 用例 + task-recommend 5 用例）；
  pytest surface 门已登记 `suggestTitleFromDraft`/`applyRecommendDefaults`/`parseRecommendText`；
  vitest mirror 门已加 `task-recommend`。done。
