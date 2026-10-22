# 任务面板：打开即扫、预览即确认门

> 2026-10-22 修订：本 ADR 的"repo 全勾选、牵头取首个"回填已被 ADR-0028 作废
> （scan 只展示结构，涉及仓由 `task/recommend` 按任务描述推荐、用户审核）。
> slug 自拟与预览确认门保留，继续有效。

2026-10-21 落地。用户反馈建多仓任务时表单全手填太烦，要求：
打开面板自动填上、去掉"扫描结构"按钮、拉起前先看到将建会话并确认。

## 抉择

- **父目录默认只用当前会话 cwd**：偏好里的旧 parentRoot 跨工程会串台，
  直接忽略；无 cwd（自建 parent 等）则空着并提示去目标会话里开面板。
- **打开即扫**：面板挂载自动调一次 `task/scan`，repo 全勾选、牵头取首个
  repo、slug/标题从父目录末段转小写短横（`suggestScanDefaults` 纯函数，
  中文名洗成空时回退 `task`）；用户逐项可改，"扫描结构"按钮改为"重新扫描"
  （换父目录/目录变化时手扫）。
- **预览即确认门**：`build` 成功后直接进预览——逐仓列出"仓→cwd→provider/model"，
  "确认拉起"按钮才调 `task/launch`。预览是 launch 的前置门，不是事后展示。
- **确认即签发（直发）**：launch 带 `skipIssuedCheck: true`，不再要求人手把
  directive.md 改成 issued；directive 照常写盘留痕，issued 门只在外部直调
  host 路由时兜底（路由层测试用例保留 draft 拒收/issued 放行）。
- **provider/model 不预填**：host 缺省读宿主 `agentPresets` 默认，面板保持
  可选输入；预览里缺省显示"(宿主默认)"。
- **`parseInvolvedLines` 留着**：task.ts 公开纯函数（测试+surface 门绑定），
  面板改走勾选后暂无调用，但不删——删导出是 breaking。

## Client 落点

- `src/client/task.ts` 新增 `defaultParentRoot` + `suggestScanDefaults`
  （无 React/CSS，node 直测；surface 门登记）。
- `TaskDialog`：挂载 `useEffect` 自动扫一次；`build` 后置 `preview` 状态；
  `launch` 前必须有预览确认；按钮文案"建任务并预览会话"→"确认拉起"。
