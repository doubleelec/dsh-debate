# 工具笼改白名单：deny 黑名单 fail-open，allow 白名单 fail-closed

2026-10-20 白名单辩论结论 + 落地。旧笼是 17 项 deny 黑名单：
只禁点名的，**后来出现的新工具默认放行**——只读角色每加一个新工具
就是一次敞口，fail-open。新笼是 allow 白名单：只留点名的，
后来出现的一律排除，fail-closed。

双名单（2026-10-20 线上 scope 实测：standard preset，31 个全局工具）：

- 辩手（建构/挑战）六项：`read/read_image/glob/grep/web_fetch/web_search`
  （读文件找证据 + 联网查证）。
- 制图员三项：`read/read_image/glob`（只读实录，不参辩，不联网）。

启动核对（`resolveToolAllow`，纯函数）：种子名单与宿主实际工具表
（parent 的 `schemas` 全局视图，与 debug-agent 同源）取交集，
失效名剔掉并留痕（`dropped`），不整场毙掉。
取不到实际表（接口不存在/抛错）→ 按种子先发、标 unverified，
让系统自己的 unknown 校验报错——不把可选接口当启动硬依赖。
交集为空 → 显式抛 `empty-allow`，不无笼裸奔。

scope-local（`subagent`）走执行期 guard（`scopedToolGuard`）：
restrict/allow 只动**全局层**，scoped 注册随后合并、不受影响，
所以这类名字列进 allow/deny 都会 unknown 抛错（实测沿用旧结论）。
one-shot 无 guard 挂载点（子 agent 由 `subagents.start` 内部组装），
只挂常驻 setup；guard 挂不上不拦创建。

生效笼型记 `cageNote`：并入已启动进度行（开局挂一次，不必每轮刷新）
+ 落盘。可选审计字段：老记录缺它即按 null 恢复，不 bump 记录版本
（ADR-0021 判例）。

自检路由：`/api/debug-child-tools` 加 `caged=true` 带笼模式，
子 agent 自报笼内视角（辩论结论"先跑一次带笼探针定最小工具集"的落点）。
