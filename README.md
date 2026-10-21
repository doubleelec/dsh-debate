# dsh-debate

> DSH native plugin with two functions: debate open-ended questions (builder/challenger/synthesizer → argument map) and run cross-repo tasks (scan → build → launch → report/collect).
> 双功能原生插件：辩论（建构/挑战/制图三角色产出论证地图）+ 跨仓任务（扫结构→建材料→拉会话→回信汇总）。

## 功能

- **辩论**：输入框 `✦ 增强` 菜单 → 辩论项 → 以草稿为辩题起点，单线分叉跑建构/挑战交替，制图出五件套地图（详见 `docs/architecture.md` §4.4a）。
- **跨仓任务**：`✦ 增强` 菜单 → 多仓任务项 → `TaskDialog` 走 scan → build → launch 三步（人审改 issued 后拉起），report/collect 汇总回信（详见 §4.4b 与 `docs/adr/0025-task-merge.md`）。

## 状态

v0.13.0：辩论单线分叉默认（ADR-0024）+ 任务并入（ADR-0025）。完整循环按 `docs/architecture.md` 推进。

## 领域文档

- `CONTEXT.md`:术语表（以此为准，含多仓任务词汇）
- `docs/adr/`:25 个已定决策（辩论 0001~0024 + 任务并入 0025）
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
$p = "$env:USERPROFILE\.dsh\profiles\dev\node_modules\@doubleelec\dsh-debate"
cmd /c mklink /D "$p" "<repo>"   # 需一次管理员审批
# 之后每次: npm run build + 刷新 3090

# 5) 发到 prod(3080):一次提权
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

## 用法(v0.1)

1. 点会话 header 的"⚔ 辩论"胶囊(或输入框旁的"⚔ 辩论"小钮,自动抓草稿当问题)。
2. 对话框里一次配全:问题、题型、视角开关、建构/挑战/制图模型、最大轮数、裁判开关。
3. 点"开始辩论"建单 → 按提示在输入框发一句话触发模型调 `debate_run` 执行。
4. 面板轮询展示 transcript;完成后出结构化论证地图(分级列表,对话区直接可读)。
