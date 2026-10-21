# dsh-session-enhance

> DSH native plugin with two functions: deliberate open-ended questions (builder/challenger/synthesizer → argument map) and run cross-repo tasks (scan → build → launch → report/collect).
> 双功能原生插件：思辨（建构/挑战/制图三角色产出论证地图）+ 跨仓任务（扫结构→建材料→拉会话→回信汇总）。
> 人工操作插件：不注册任何模型工具（`contributes.tools` 为空），面板按钮建单，host 后台直驱。

## 功能

- **思辨**：输入框 `✦ 增强` 菜单 → 思辨项 → 以草稿为议题起点，单线分叉跑建构/挑战交替，制图出五件套地图（详见 `docs/architecture.md` §4.4a）。
- **跨仓任务**：`✦ 增强` 菜单 → 多仓任务项 → `TaskDialog` 走 scan → build → launch 三步（人审改 issued 后拉起），report/collect 汇总回信（详见 §4.4b 与 `docs/adr/0025-task-merge.md`）。

## 状态

v0.14.0：全量更名（`dsh-debate` → `dsh-session-enhance`，不兼容旧路由/KV/报告路径）+ 去模型工具（人工操作插件，不再注册旧 `debate_*`/`task_*` 工具名）。单线分叉默认（ADR-0024）+ 任务并入（ADR-0025）。完整循环按 `docs/architecture.md` 推进。
v0.1 spec 之后的变化见 `docs/action-plan.md` 的 S0~S27 进度表（入口/轮数/裁判/直驱/互盲/路由/地图形状均有 ADR 指路；原 `docs/efforts/debate-v01/` 已按约定在发布后删除，记录由 git 历史保留）。

## 领域文档

- `CONTEXT.md`:术语表（以此为准，含多仓任务词汇）
- `docs/adr/`:25 个已定决策（思辨 0001~0024 + 任务并入 0025）
- `docs/architecture.md`:全工程唯一架构描述（双功能）
- `docs/agents/`:工程 skill 约定（issue tracker / domain）

## 开发

```powershell
# 1) 装依赖(首次)
npm install

# 2) 构建(lib/ 是 DSH 真正加载的)
npm run build

# 3) 单测
npm test

# 4) dev 联调:把本仓库 symlink 到 dev profile(3090),一次即可
$p = "$env:USERPROFILE\.dsh\profiles\dev\node_modules\@doubleelec\dsh-session-enhance"
cmd /c mklink /D "$p" "<repo>"   # 需一次管理员审批
# 之后每次: npm run build + 刷新 3090

# 5) 发到 prod(3080):一次提权
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

## 用法(现状)

1. 点输入框 `✦ 增强` 菜单 → 思辨项（有草稿则以草稿为议题起点，无草稿也开面板，面板提示先写问题）。
2. 对话框里配三模型 + 最大轮数(1~20，默认 5；超 20 按 20 跑并在进度里留痕)；问题/题型/视角/背景执行时从当前会话自动判断。
3. 点开始即建单，host 后台直驱开题 → 交锋 → 制图（面板轮询看实况，不发触发语）。
4. 面板轮询展示 transcript；完成后出成果地图 markdown 全文 + 结论文档（`<工作区>/docs/session-enhance/`）。结构化五件套暂不解析（只产文本）。
