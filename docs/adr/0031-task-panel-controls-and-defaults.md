# ADR-0031 — 任务面板去掉多余控件、模板内建、provider/model 可选

- 状态：已采纳（2026-10-23）
- 上下文：ADR-0025（任务并入）/ ADR-0029（去牵头仓、去标题）/ ADR-0030（推荐上下文）
- 触发：用户逐条审面板提出的六个问题

## 背景

推荐链修好后，用户把面板当产品审了一遍，指出六处多余或缺失：

1. "重新扫描"按钮多余——面板本来就打开即扫。
2. "重新推荐"多余——扫描完自动推荐；真正缺的是"取消"。
3. "全选可用仓"不选 `docs`（`unknown`），那就不该把它列进勾选区。
4. "默认 .tasks"按钮多余——字段名"任务根目录(.tasks)"已经说过。
5. provider/model 该是菜单，不该手打。
6. 点"建任务并预览会话"报 `ENOENT ... directive_template.md`。

## 决定

1. **父目录改动即重扫**：去掉"重新扫描"按钮，`parentRoot` 失焦或回车时若值变了就重扫
   （`scannedRoot` 记住上次扫的值，没变不打扰）。
2. **去"重新推荐"，加"取消"**：描述失焦且内容变了才重推（`recommendedDesc` 记忆）；
   "取消"与"建任务并预览会话"并排，直接关面板。
3. **勾选区只列真仓**：`repo` / `part` 才进清单；`unknown` / `external` 收进一行
   "已忽略 N 个非仓目录:…"，不再出现"列着但全选不到"的矛盾状态。
4. **去"默认 .tasks"按钮**：`tasksRoot` 空时由 scan 直接填好默认值，字段不再需要按钮或占位提示。
5. **provider / model 改下拉**：新增只读路由 `POST /api/task/models`
   （`llm.listProviders()` + 逐 provider `listModels()` + `agentDefaultModel.currentSelection()`）；
   面板拿到列表就渲染 `<select>`（首项"宿主默认"），拿不到（老宿主/测试 fake ctx）退化为手输。
   WIRE-01 task 路由 9→10 条。
6. **模板内建**：`cross_tasks/materials.ts` 导出 `DEFAULT_DIRECTIVE_TEMPLATE` /
   `DEFAULT_TO_TEMPLATE`，来源优先级改为 **显式文本 > `templateDir` 里的真身 > 内建默认**。
   旧逻辑在两者都不给时去 `tasksRoot` 上一级找 `directive_template.md`——那里通常没有该文件，
   于是每次 build 都 `ENOENT`。回退到"猜一个目录读文件"本身就是错的设计。

## 后果

- 好处：面板控件数与真实动作一致（扫、推、建、拉、收 + 取消）；build 不再依赖外部模板文件，
  开箱即用；provider/model 从记忆负担变成选择。
- 代价：模板内建后，编排库若有自定义模板必须显式填"模板目录"，否则用户拿到的是通用模板
  （这是有意的：通用模板可跑，缺省不再崩）。
- 未做：`unknown` 目录不参与任务（它们不是 git 仓，起会话也没有 diff 可看；如需支持，
  应先在 scan 侧给它一个明确的 kind 语义，而不是让它半列不列）。

## 验证

- `tests/vitest/task-routes.test.ts`：不传模板 build 成功且回填正确、`task/models` 空列表不抛、
  路由表锁在 10 条。
- `tests/src/test_invariants.py::test_src_task_routes_are_ten`。
