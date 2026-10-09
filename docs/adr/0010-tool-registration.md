# 工具注册三硬伤导致会话静默

09-24 实测：点开始建单后会话无任何动静，根因不在面板，在 host 工具注册链，
三处硬伤叠加，工具从没注册上，模型根本看不到 debate_*：

1. 裸对象注册必抛：`ToolRuntime.register` 要求 `output { schema, render }`，
   缺了直接抛 TypeError，又被外层 try/catch 静默吞掉。必须传完整形态
   （parameters 用 JSON Schema 壳，output 补 `{ schema:{type:'string'}, render }`）。
2. 服务读取方式错：`inject` 只声明了 `webServer`，却用 `(ctx as …).tools`
   属性读取，cordis 抛 `cannot get property without inject`，同样被吞掉。
   改数组 `inject: ['webServer','tools','subagents']` + `ctx.get('tools')`。
3. 会话读取接口错：`parent.session.events?.(0)` 已无此接口，
   真实面是 `snapshotEvents(fromSeq?, toSeqExclusive?)`。保留 events 作 legacy 兜底。

教训：host 注册失败必须可观测。新增 `/dsh-debate/api/debug`
自检路由（返回模型可见的 debate_* 工具名），curl 即判，不用进 GUI。
另：建单成功后触发语自动填输入框并发送，免手工复制粘贴；
发送失败才留手动兜底（复制按钮保留）。
