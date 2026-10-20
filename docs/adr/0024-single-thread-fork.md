# 单线分叉：单模型双角色交替线

2026-10-20 落地。互盲拿掉：用户要的是"两个模型就一个问题充分讨论"，
互盲是早期过度设计——挑战者能看到建构原文，逐条反驳反而更充分。

三条硬边界（源码实测）：

1. 同一会话内切模型没路——`followup` 只进 inbox，不带模型参数；
   `selectForNextRequest` 只在 session-controller 身上，插件侧拿不到。
   跨模型差异必须双会话（现状）或双 one-shot。
2. one-shot 必落盘——`spawn` → 随机 UUID → `create` → `createStoredSession`。
   宿主没有"无会话跑一次模型" API。
3. dispose 不删盘——`close()` 只关流。删盘只能插件自己 `rm`。

所以单线分叉只能是"单模型双角色"：

```
发起会话（不动，用户继续聊）
  └─ fork 分叉（seed=当前上下文，isSeeded=true）
      ├─ 建构 turn → 挑战 turn → …×N（全文在分叉里，主会话零污染）
      ├─ 制图 one-shot（照旧）→ 文档落盘
      └─ 结束：分叉 dispose，文档留，分叉文件扫掉
```

抉择：

- 载体用分叉不用发起会话——发起会话载体会把 N 轮全文灌进用户正在聊的
  会话，上下文暴涨；分叉隔离，主会话只收转述+摘要（跟现在 mirror 一样）。
- 种子照抄原生 fork（`buildForkSeed` 自实现，`session/end-seed` 标记带上）。
- 防呆豁免：单线是单模型双角色，`isRouteIneffective` 不查（双路同模型
  报一致只是事故，常驻/one-shot 才查）。

退路：`mode` 三态（`single | resident | oneShot`），老路保留，
单线失败回退常驻，常驻失败回退 one-shot。落盘 `fromRecord` 未知值
回落 one-shot，不 bump 记录版本。
