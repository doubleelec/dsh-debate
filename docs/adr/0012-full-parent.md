# 自建 parent 挂默认 preset：子 agent 满血的优雅通道

09-30 真探针（`debug-child-tools` 行为验证）：自建 parent 挂 `standard`
preset 后，子 agent 自报 31 个工具：`read/grep/glob/write/edit/pwsh`
`web_fetch/web_search/subagent/workflow/skill/todo` 全有，外加 4 个
`debate_*`。结论：满血通道 = preset 继承链本身，不用喂料，不用改部署。

链路（源码级）：`subagents.start('spawn')` → `applyChildComposition`
先 `composeFrom(parent.ctx)` 完整继承 parent 的 preset standing mount，
再 `tools.restrict(toolFilter)` 交集收窄。我们不传 `toolFilter`，
子 agent = parent 的完整工具集。`restrict` 单向收窄，插件层加不上去，
但也用不着加：`standard` preset 里文件/shell/检索/网络本来全有。

自建 parent 必须走 webhook 样板（`dsh-webhook` 的 `createWebhookSession`）：
`meta.agentPreset = presets.defaultId` + `setup` 里
`await presets.mount(agentCtx, presetId)`。缺这一步 parent 落在空
global 层，子 agent 只有 4 个 `debate_*`（09-30 实测 `scopeToolCount=4`）。
`createFullParent` 封装了这套，主链路与探针共用。

提示词配合：边界声明只禁 `debate_*`（链路已在驱动你），文件/检索/
shell/网络工具该用就用，查不到才标缺失。之前“一律只输出文本”的版本
把子 agent 吓得连试都不试（E1 自述“未调用任何工具”），起反作用。

自检路由：`/api/debug-child-tools`（行为探针，子 agent 自报工具表；
无活体时自建满血 parent，用完 dispose）。保留，不删。
