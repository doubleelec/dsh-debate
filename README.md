# dsh-debate

> DSH native plugin that debates open-ended questions via builder/challenger/synthesizer roles and returns a structured, chat-readable argument map.
> 双视角辩论:为开放性论证题跑建构 / 挑战 / 制图三角色,产出结构化、可直接在对话里读的论证地图,而非单一结论。

## 状态

v0.1 架子:面板(全配置对话框)+ host 路由(`/dsh-debate/api/*`)+ `debate_run` 工具 + 协议单测。
完整辩论循环(双模型路由、制图 schema、饱和检测)按 `docs/debate-design.md` 推进。

## 领域文档

- `CONTEXT.md`:术语表(以此为准)
- `docs/adr/`:6 个已定决策(地图非结论、三角色、混合视角、饱和停机、断言分层、制图员复用)
- `docs/debate-design.md`:设计草稿
- `docs/agents/`:工程 skill 约定(issue tracker / domain)

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
