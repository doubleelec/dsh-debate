# 04 — 推荐排障透出 + 去牵头仓 + slug 按任务 + 去标题字段

Status: claimed

## 背景（用户反馈 2026-10-22，界面实测）

1. "AI 没有挑出涉及仓"——简单问题不可能解不出，疑机制问题。
2. 不要"牵头仓"：程序自动建专用协调目录来协调任务。
3. slug 取成 `dsh-plugins-workspace` 不对：slug 是对问题的英文缩写，用于建文件夹。
4. "一句话标题"与"任务描述"冗余：留任务描述，去标题。

## What to build

- **排障**：`task/recommend` 响应加 `rawLen`（模型原文长度）+ `stopReason`；
  面板失败提示带上这两项 + 原文前 200 字（`rawHead`），复现一次即定位。
  prompt 自检：候选清单里 relPath 可能含中文？先 assertAscii 只验
  `recommended` 输出，不验输入——输入 relPath 是扫描来的，中文仓名不过
  ASCII 门会整单失败。排查：scan 回的 kind 是否全是 external/unknown
  （无 repo/part → 路由直接 `no recommendable repos`）。
- **去 lead**：`FillDirectiveOpts`/`BuildMaterialsOpts` 去 `lead` 字段；
  `fillDirective` 模板 `lead:` 行渲染为 `lead: none（协调位见任务目录）`
  （占位必须消灭，不能留 `<...>`）；`handoffText` 去 `isLead` 分支
  （保留签名兼容？不——调用处只有 launch，一并改）；
  build/launch 路由去 `lead required` + 校验 + 落点验；
  面板去牵头仓字段 + "牵头"按钮 + lead 状态；`validateTaskBuild` 去 lead 项；
  vitest 全量更新。GLOSSARY/ADR/arch 同步。
- **slug 按任务**：`task.ts` 新增 `suggestSlugFromText(text)`：
  小写化 → 非 `[a-z0-9]+` 转短横 → 压前后横 → 截 40 → 空回退 `task`；
  中文描述洗成空 → 回退 `task`（不再用 parentRoot 末段）。
  推荐成功用 AI title 转 slug（`applyRecommendDefaults` 不动）；
  推荐失败用描述转 slug；描述空（不应发生，入口门）回退 `task`。
- **去标题字段**：面板删"一句话标题"输入框 + title/autoTitle 状态；
  `directive`/`to` 的标题位用任务描述（`fillDirective`/`fillTo` 的
  title 参数改传描述，超长截 80 字由路由层做）；
  `TaskBuildInput` 去 title？不——materials 接口保留 title 字段
  （模板占位要填），只是面板不再让用户填另一套，统一传描述。
  `validateTaskBuild` 不验 title（本来也没验）。

## Done when

- 四门全绿；3080 实测：有输入开面板 → 自动扫 → 推荐带原文透出 →
  无牵头仓 → slug 是任务英文缩 → 只有一个描述框。

## Result

- 2026-10-22 落地：build + sandbox 245/245 + pytest 34 + arch ALL CLEAR。
  vitest 245（246-1：scanDefaults 用例 3→2）。
  ADR-0029；arch/QAS/Elements/4.4b/ADRs/test_index/GLOSSARY 同步。
  done，待提交推送 + 装机验证。
