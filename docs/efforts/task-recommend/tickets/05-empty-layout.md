# 05 — 空推荐不再误导 + 勾选行/预览对齐

Status: claimed

## 背景（用户反馈 2026-10-22，界面实测）

1. 仍然是"AI 没有挑出涉及仓,请手动勾选"。
2. 设计仓界面乱七八糟，没有对齐。

## What to build

- **空推荐即失败**：路由 `cleaned.recommended.length === 0` 时回 `ok:false`
  + 诊断（`stopReason`/`rawLen`/`rawHead`/`knownCount`），面板走失败分支
  （带原文透出 + 手勾提示）；删除面板那句误导人的"AI 没有挑出"。
  机制解释：空有两种可能——模型真给了空，或全被已知仓（repo/part）过滤掉；
  对用户都是"没挑出来"，不应报"AI 没有挑出"这种似是而非的话。
  下一步定位靠失败提示里的 `stop/rawLen/known/原文头` 四件套。
- **勾选行两行式**：grid 三列（checkbox/路径等宽/kind 胶囊），
  AI 理由 + 外部原因另起一行缩进（grid-column 2/-1），不再一行挤爆。
- **预览对齐**：预览行 grid 两列（仓路径/cwd），虚线分隔。
- 去多余 `.dshe-row`（slug 单字段不再套 row）。

## Done when

- 四门全绿；3080 实测：空推荐走失败分支带诊断；勾选行/预览对齐。

## Result

- 2026-10-22 落地：build + sandbox 245/245 + pytest 34 + arch ALL CLEAR。
  done，待提交推送 + 装机验证。
