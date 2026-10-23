# ADR-0030 — 推荐链补上下文与可观测

- 状态：已采纳（2026-10-21）
- 上下文：ADR-0028（推荐 + 人审核）/ ADR-0029（去牵头仓、去标题、去诊断）
- 修订：ADR-0028 的"候选只给路径 + kind"与"失败只透四元组"部分作废

## 背景

"AI 没有挑出涉及仓"反复出现，前两轮都在管道上打补丁（回 ok:false、透 stopReason /
rawLen / rawHead / knownCount、面板改文案）。用闭环探针直接打真实路由（`scripts/probe-recommend.mjs`）
后，现场是：

```
SCAN: docs(unknown) / dsh-session-enhance(repo) / dsh-shims(repo) / dsh-workspace-explorer(repo)
RECOMMEND: stopReason=completed, rawLen=59, knownCount=3
rawHead: {"recommended": [], "reasons": {}, "title": "修 broker 空语义"}
```

同一路由换成点得出仓名的描述，一次就成功（`recommended: ["dsh-session-enhance"]` + 理由）。
即**管道没坏，是决策依据不足**：分仓员只看到 `relPath (kind)`，任务描述没点名仓名时，
它没有任何语义依据去判断，只能回空数组——而空数组在面板上和"失败"长得一样。

## 决定

1. **候选仓带自述**（`src/cross_tasks/candidates.ts`）：每个候选补一行判断依据，
   优先级 `package.json` description → `module.toml` description → README 首个标题 →
   顶层目录名单，截 120 字。prompt 里以 `- <relPath> (<kind>) — <自述>` 呈现，
   并明写"仓路径必须原样抄候选的路径"。
2. **输出写法宽容**（`recommend.ts` 的 `normalizeRepoRef` / `matchRecommended`）：
   模型回 `Dsh-Session-Enhance` / `dsh-session-enhance/` / `./libs/broker` / 裸 `broker`
   都能归一命中已知仓；`reasons` 的键同样归一后回填。只有真正不认识（含 unknown/external）
   的路径才丢弃。
3. **空推荐说清原因**：回 `ok:false` + `error:"AI 认为候选里没有相关仓(模型回空)"`
   + `candidates[]` + `descriptors{}` + `rawHead`；面板在勾选区上方展示
   "AI 为什么没挑出来"+候选清单，模型原文与自述收进折叠块。
4. **不加词法兜底**（用户裁决）：判不出就是空选，程序不替人做判断；本 ADR 只补
   **依据**（自述）与**解释**（候选 + 原文），不改变"AI 推荐、人审核"边界。
5. **推荐尝试进环形缓冲**：最近 20 次尝试（描述 / 候选 / 自述 / 模型原文 / 结论 /
   耗时）存内存，新增只读路由 `POST /api/task/recommend/log`
   （`{limit?}` → `{ok, entries[]}`），与 `/api/debug*` 同性质。WIRE-01 task 路由 8→9 条。
6. **排障入口落仓库**：`scripts/probe-recommend.mjs` 直接打真实 host
   （version → scan → recommend），一条命令取全量现场，不需要用户在界面上复述报错。

## 后果

- 好处：描述与候选语义相关时推荐可用（探针实测）；失败原因自解释；排障从"人复述"
  变成"一条命令"；模型输出写法漂移不再导致整单空。
- 代价：每次推荐多读 O(候选数) 个小文件（package.json / module.toml / README），
  实测 4 候选 < 10ms；日志驻��内存 20 条（原文截 4000 字），进程重启即清。
- 未做（明确放弃）：词法兜底预勾选（违背"推荐不是判决"）；让分仓员读仓内容（成本高、
  自述已够用，必要时再加）。

## 修订（2026-10-23）：推荐只有一件事——选集合

上线后用户真实草稿是 `清理本文件夹下所有的 .tmp。`——模型仍回空，但**这次模型没错**：
提示词只教了"改某个仓的 bug"这一档，而这是"每个仓各清各的 `.tmp`"。

第一版修订把任务分成"归属型 / 遍在型"两类，**这个二分是假的**（用户指出）：把一个任务
分给多个仓的会话，和分给一个仓的会话，是同一件事——选出这次工作会动到的仓集合。
数量（1 个 / 几个 / 全部 / 0 个）不是分类，是基数。

最终提示词只说一句判断标准："数量不是判断标准：可以是 1 个、几个、或全部候选，
只看'这活会不会动到它'"，配四个基数示例（修某仓 bug → 1；清理各仓 `.tmp` → 全部；
只补某仓 README → 1；毫不相干 → 空）。另把 `parentRoot` 带进 prompt（"候选仓都在它
下面"），让"本文件夹/这里/所有目录"这类指代可解析。

双向实测（同模型）：
- `清理本文件夹下所有的 .tmp。` → 三个仓全中，理由"清理范围覆盖整个父文件夹，该仓的
  .tmp 也在范围内"。
- `修 dsh-shims 里 ssh 钩子生成的 shim 名字冲突。` → 只中 `dsh-shims`，未多选。

只改**判断依据**，不改"AI 推荐、人审核"边界，也不引入词法兜底。

## 验证

- `tests/vitest/task-candidates.test.ts`：自述来源优先级 / 截断 / 批量。
- `tests/vitest/task-recommend.test.ts`：写法归一匹配 + reasons 漂移键。
- `tests/vitest/task-routes.test.ts`：空推荐回候选清单、`recommend/log` 可取、
  提示词保留"数量不是判断标准"这一句。
- `tests/src/test_invariants.py::test_src_task_routes_are_nine`。
- 真机闭环：`node scripts/probe-recommend.mjs <parentRoot> "<描述>"`。
