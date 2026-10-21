# 增强入口与跨仓任务并入

2026-10-20 落地。把 `dsh-task-launcher`（scan/build/launch/report/collect）
并入 `dsh-session-enhance`，输入框"⚔ 辩论"按钮改为"增强"弹菜单（辩论/多仓任务）；
多仓任务走 overlay 新面板 + 显式"开始任务"按钮启动。
v0.14.0 修订：全量更名 `dsh-debate` → `dsh-session-enhance`（路由前缀
`/dsh-session-enhance/api/`，报告目录 `docs/session-enhance/`，KV 单元
`dsh_session_enhance`）；去模型工具——人工操作插件，不再注册旧工具名，
面板走 HTTP 路由驱动。

## 抉择

- **入口改菜单不改键**：`conversation.input.right` 的 `inputActions` 全仓只有
  `setDraft` 一个可用回调（`submit?` 仅 `InputActs` 接口声明一处，
  runtime 类型与全仓无一处调用点）。原生发送键（Jenny 键）无监听点、
  不可拦截借用——多仓任务启动必须走 overlay 面板里的显式按钮，
  用户回车只管发自己的消息，不触发任务。
- **task 模块并入 `src/task/`**：launcher 的 `scan/materials/ensure-session`
  三纯模块移植成 TS（`scan.ts`/`materials.ts`/`ensure-session.ts`），
  模板真身仍在各编排库（finance 落点即 cross-tasks 模板文件，
  由 `templateDir`/`directiveTemplate`/`toTemplate` 显式传入，不绑死）。
- **路由挂 `/dsh-session-enhance/api/task/*`**：7 条（version/scan/build/launch/
  report/collect/stop），与 deliberation 路由同文件注册（逐条
  `ctx.webServer.register`，数组静默失效见 explorer 经验）。
- **模型工具 0 个（v0.14.0 起）**：人工操作插件，不再注册旧 task 系工具名（旧注册名作废），面板走 HTTP 路由驱动。
- **launch 三道门照抄 ensureGroupedSession**：`meta.cwd` → workspace 注册 →
  `attachSession` → `followup` 派活；`provider/model` 显式优先，
  缺省读宿主 `agentPresets` 默认，都没有则显式报错。
- **issued 门保留**：launch 前 directive 须 `status: issued`，
  草稿直拉会话在 spec 用户故事 3 已否决（空模板会话浪费）。

## Client 落点（同日补记）

- **增强菜单不置灰**：`✦ 增强` 按钮常亮，菜单两项各走各的门——辩论项有草稿则
  以草稿为辩题起点、无草稿也开面板（面板提示先写问题，比按钮置灰更可达）；
  任务项无草稿也能开（标题/仓走面板表单，草稿留给用户自己发）。
- **双面板同 overlay**：`DebateRoot` 同时订阅 `panelOpen` 与 `taskPanelOpen`，
  `TaskDialog` 走 scan → build → launch 三步显式按钮；偏好
  （parentRoot/tasksRoot/templateDir/provider/model）存 localStorage。
- **纯逻辑抽 `src/client/task.ts`**：`parseInvolvedLines/suggestTasksRoot/
  validateSlug/validateTaskBuild/loadTaskPrefs/saveTaskPrefs` 无 React/CSS，
  单测不拖浏览器（node environment 直跑）。
- **旧按钮断言更新**：`test/session.test.ts` 加增强 label 用例
  （含辩论独占名不再出现），旧 `⚔ 辩论` 按钮无残留。
