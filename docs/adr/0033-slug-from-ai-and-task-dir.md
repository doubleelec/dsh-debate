# ADR-0033 — slug 由 AI 拟、任务目录显示全路径、操作等权

- 状态：已采纳（2026-10-23）
- 上下文：ADR-0029（去牵头仓，slug 按任务）/ ADR-0031（面板控件）/ ADR-0032（不静默退化）
- 触发：用户对面板的第二轮提问（模板是什么、slug 不够准、任务根目录不够具体、两键权重不一）

## 背景

面板能跑通后，用户逐项挑语义问题：

1. "模板目录"的模板到底干什么用？（界面上没解释，字段又出现得比主流程显眼）
2. slug 不够准：`清理本文件夹下所有的 .tmp。` 洗出来是 `tmp`/`task`，用户要 `cleanup-tmp`
   ——2-3 个英文词、短横线、≤20 字符。
3. "任务根目录"只到 `.tasks`，用户要看到完整任务目录（`….cross-tasks/cleanup-tmp`）。
4. 建任务键与取消键大小权重悬殊（主键满宽蓝底，取消是小号副键）。

## 决定

1. **模板目录降级进"高级"并解释清楚**：它是产出物骨架（`directive_template.md` 出总指示、
   `to_template.md` 出每仓派活），内建默认已够跑，只有自家仓库有模板规范时才需要。
   主界面不再出现该字段。
2. **slug 由 AI 在推荐时一并给出**（`{"…", "slug": "cleanup-tmp"}`）。正则洗中文永远只能得到
   `task`，而模型本来就在读任务描述；让它顺手回答"用 2-3 个英文词概括"是最省的做法。
   - 提示词写死规则：2-3 个英文词、小写、短横线、≤20 字符、看得出任务（不要中文、不要拿仓库名当任务）。
   - `sanitizeTaskSlug`（纯函数）归一模型输出：小写 → 非 `[a-z0-9]` 转短横 → 按**词边界**截到 20。
   - 模型没给时才回落到 `suggestSlugFromText`：中文动词/对象词表（清理→cleanup、修复→fix…）
     ＋描述里的 ASCII 词，最多 3 词、总长 ≤20；全洗空回 `task`。
   - `validateSlug` 增一条"不超过 20 字符"，与生成规则同口径。
3. **任务根目录缺省改 `<父目录>/.cross-tasks`**（原 `.tasks`），主界面改为显示**完整任务目录**
   预览：`<tasks_root>/<slug>-<时间戳>`（slug 已定，时间戳建目录时确定），并注明
   `directive.md` 与 `to-<仓>.md` 都落在那里；`tasks_root` 输入框移进"高级"。
4. **两键等权**：`建任务并预览会话` 与 `取消` 同宽同高同一套 `.dshe-start` 尺寸，差别只在
   底色（主键实心、取消描边）——用 `dshe-btnrow` 统一布局，不再用 `.dshe-copybtn` 小号字。

## 后果

- 好处：slug 可读且与任务对应（`cleanup-tmp` 而不是 `tmp`）；用户点按钮前就能看到材料会落到哪；
  两个动作在视觉上等价，不诱导误点；模板概念有解释且不再占主位。
- 代价：推荐链多了一个字段（`slug`），模型偶尔会回中文 slug 或超长词——`sanitizeTaskSlug`
  归一后仍可能是空串，此时回落词表；两种来源都不理想时回 `task`（用户可改）。
- 兼容：`.tasks` 与 `.cross-tasks` 都只是目录名，旧任务目录不迁移；面板只影响新建。

## 验证

- `tests/vitest/task-recommend.test.ts`：`slug` 缺省回空串、`Cleanup TMP`→`cleanup-tmp`、
  中文/超长被洗。
- `tests/vitest/task-panel.test.ts`：`suggestSlugFromText('清理本文件夹下所有的 .tmp。')`
  === `cleanup-tmp`、`升级依赖并跑测试` === `upgrade-test-deps`、`validateSlug` 拒 >20、
  `suggestTasksRoot` 回 `.cross-tasks`。
- `tests/vitest/task-routes.test.ts`：推荐提示词含 slug 规则（沿用 prompt 断言）。
