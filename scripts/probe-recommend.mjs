// 推荐链闭环探针(ADR-0030):直接打真实 host 路由,不经过浏览器面板。
// 用途:一条命令取现场——版本 / 扫描结果 / 推荐响应(含 rawHead / stopReason / knownCount),
// 排障时不需要用户在界面上复述报错。
//
// 用法:
//   node scripts/probe-recommend.mjs [parentRoot] [任务描述]
//   node scripts/probe-recommend.mjs --log            # 直接读最近推荐记录
//   PROBE_BASE=http://127.0.0.1:3090 node scripts/probe-recommend.mjs ...   # 打 dev profile
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3080'

async function post(method, payload) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/dsh-session-enhance/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { __nonJson: text.slice(0, 800) }
  }
  return { status: res.status, ms: Date.now() - t0, json }
}

const argv = process.argv.slice(2)

if (argv[0] === '--log') {
  const log = await post('task/recommend/log', { limit: Number(argv[1] || 5) })
  console.log(JSON.stringify(log.json, null, 2))
  process.exit(0)
}

const parentRoot = argv[0] || process.env.PROBE_ROOT || 'D:/Users/Elec/Documents/dsh-plugins-workspace'
const desc = argv[1] || process.env.PROBE_DESC || '修 dsh-session-enhance 的任务面板'

const v = await post('version', {})
console.log('VERSION  ', JSON.stringify(v.json))
const s = await post('task/scan', { parentRoot })
const reposAll = s.json.repos || []
console.log('SCAN     ', s.status, `${s.ms}ms`, `repos=${reposAll.length}`)
for (const r of reposAll) console.log('           ', r.relPath, r.kind, r.reason || '')
const repos = reposAll.map((r) => ({ relPath: r.relPath, kind: r.kind, absPath: r.absPath }))
console.log('DESC     ', JSON.stringify(desc))
const rec = await post('task/recommend', { description: desc, repos })
console.log('RECOMMEND', rec.status, `${rec.ms}ms`)
console.log(JSON.stringify(rec.json, null, 2))
