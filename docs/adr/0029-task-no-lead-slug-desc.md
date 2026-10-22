# 任务面板：去牵头仓 + slug 按任务 + 去标题字段

2026-10-22 落地。用户界面实测反馈四连：

1. "AI 没有挑出涉及仓"——机制问题：`task/recommend` 失败/空推荐时面板
   只给一句话，没有诊断信息，定位全靠猜。
2. 不要"牵头仓"：程序自动建专用目录协调任务，不该让人指一个仓当头。
3. slug 取成 `dsh-plugins-workspace` 不对：slug 是对问题的英文缩写，
   用于建文件夹，不是工程名。
4. "一句话标题"与"任务描述"冗余：留一个。

## 抉择

- **协调位 = 任务目录自身**：`build` 写出的 `<slug>-<stamp>/` 下已有
  directive + 一仓一封 to-*.md，协调会话 cwd 指向它即可。
  `lead` 从 materials/路由/面板/测试全摘；directive 模板 `lead:` 行写
  `lead: none # 协调位见任务目录`（占位必须消灭，不能留 `<...>`）。
- **slug 从任务描述来**：`suggestSlugFromText`（小写化 → 非 alnum 转短横 →
  截 40 → 空回退 `task`）。推荐成功用 AI title 转 slug；失败用描述启发；
  中文描述洗空回退 `task` 是正常的（用户手改）。
  `suggestScanDefaults` 不再从父目录末段取 slug（那是工程名），只占位回 task。
- **留任务描述，去一句话标题**：`directive`/`to` 的标题位直接用描述
  （路由层超长截 80 字）；`suggestTitleFromDraft` 删除（无调用方）。
- **推荐排障透出**：`task/recommend` 成功/失败都带 `stopReason` + `rawLen`，
  失败再带 `rawHead`（原文前 200 字）；面板失败提示里原文展示，
  复现一次即定位（空推荐是模型真给了空，还是解析/过滤掉的）。

## 落点

- `src/client/task.ts`：`TaskBuildInput` 去 lead；`validateTaskBuild` 去牵头校验；
  新增 `suggestSlugFromText`；删除 `suggestTitleFromDraft`；
  `applyRecommendDefaults` 去 lead（只回 checked）；`suggestScanDefaults`
  只占位（checked 空 + slug task）。
- `src/cross_tasks/materials.ts`：`Fill/BuildMaterialsOpts` 去 lead；
  `handoffText` 去 `isLead` 分支。
- `src/index.ts`：build/launch 去 lead 校验 + 落点验；`handoffText` 调用去参；
  recommend 透出 stopReason/rawLen/rawHead。
- 面板：删牵头仓字段 + "牵头"按钮 + 一句话标题字段 + title/autoTitle 状态；
  slug 输入框改名为"任务英文缩写，AI 按描述自动拟"。
