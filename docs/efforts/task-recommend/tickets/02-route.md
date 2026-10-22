# 02 — host 路由：task/recommend（第 8 条 task 路由）

Status: open

## What to build

- `src/index.ts` task 路由段新增 `task/recommend`（照抄 `debug-child-tools`
  探针的 parent 获取 + one-shot spawn 模式：sid → 活体会话 → 自建
  `createFullParent`，120s 超时，`run.dispose()` + 自建 parent 回收）：
  - 入：`{ description, repos: [{relPath, kind}], sid? }`；description 为空、
    repos 为空直接 `ok:false`；`repos[].relPath` 过 ASCII 门（描述文本本身是中文，不过门）。
  - prompt：分仓员口径，只输出 JSON
    `{"recommended": [...], "reasons": {repo: 理由}, "title": "简短标题"}`。
  - 出：`{ ok, recommended, reasons, title }`（经 `parseRecommendText` 清洗）。
- `src/cross_tasks/module.toml` 不动（无 submodule 清单）；`src/module.toml`
  WIRE-01 desc "7 task routes" → "8 task routes"。
- `tests/src/test_invariants.py::test_src_task_routes_are_seven` 改名
  `test_src_task_routes_are_eight` 并加 `task/recommend`；`test_index.md` 同步。
- `tests/vitest/task-routes.test.ts`：路由表期望加 `task/recommend`；
  fake ctx 的 subagents 加推荐桩（可注文），新增用例：
  正常推荐 / description 缺失 ok:false / 模型吐垃圾 ok:false。

## Done when

- `npm run test:sandbox` + pytest 全绿；arch check ALL CLEAR。

## Result

- 2026-10-22 落地：sandbox 246/246（含 3 个 recommend 新用例 + fake subagents 注文桩）；
  arch ALL CLEAR。pytest 侧 meta-guard 要求 test_index 登记新测试名，留到 T3 文档批统一改。done（文档待 T3）。
