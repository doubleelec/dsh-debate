/**
 * 持久化与结论文档(纯函数层,不碰 fs / 不碰 ctx)。
 *
 * 两条独立的耐久化路径,各有各的理由:
 * 1. **整局记录**(`toRecord`/`fromRecord` → `ctx.storage` 的 KV 单元):
 *    修掉"宿主一重启,面板里的局就 unknown-id"。记录是权威副本,面板拿 id 就能重新打开。
 * 2. **结论文档**(`renderReport` → 工作区里的 markdown 文件):
 *    给人和未来的 agent 一个**有地址的产物**。对话区那条镜像消息会被上下文压缩吃掉,
 *    文件不会——压缩之后 `read <路径>` 就能拿回逐字原文。
 *
 * 这里只放纯函数:文件名推导、渲染、记录形状校验。IO 与生命周期在 index.ts。
 */
import type { DebateConfig, DebateMap, DebateRound, DebateStatus, GapSpan, TranscriptEntry } from './debate'

/** 记录格式版本:不兼容变更才 +1(必填新增/改名/删字段/语义变);可选审计字段(缺即 unknown、只审计不 gate)不 bump,见 ADR-0021。 */
export const RECORD_VERSION = 1

/** 存储单元名。必须匹配 UNIT_NAME_RE `/^[a-z][a-z0-9_]*$/`——**不能用连字符**。 */
export const STORAGE_UNIT = 'dsh_debate'
/** 存储表名。 */
export const STORAGE_TABLE = 'sessions'

/** 结论文档所在目录(相对工作区,posix 分隔符)。 */
export const REPORT_DIR = 'docs/debates'

/** slug 码点上限。文件名是索引不是复述:12 字 + 日期 + id 尾足够定位,标题全文在文件内第一行。 */
export const SLUG_MAX_CODEPOINTS = 12

/** 文件名里的语气词:占位置但不定位,去掉了不影响认出是哪一局。 */
const SLUG_STOPWORDS = /我现在想|不要太|根据|这个|一个|更好|还是|是否|该不该|一下|这些|怎么|如何|什么|为什么|能不能|可以|进行/g

/**
 * 承接语外壳(S15):文件名里混进来的指代必须清掉。
 * 纵深:就算 question 里混了承接语(如 hint 和历史拼成的长句),文件名也不该是废话
 * ("就以上问题继续辩论" → 清完剩空 → 回落 debate)。
 * 清掉的是外壳(以上/继续/辩论…),实质问题(如"管理架构")保留。
 */
const SLUG_CONTINUATION = /(就|请|那请|那么|那|针对|关于|对于|围绕|围绕着)?(以上|上述|前面|之前|刚才|刚刚|先前)(的|这个问题|这些问题|那个问题|讨论|内容|话题)?(继续|接着|再|重新|新开|另起|深入|展开|细化)?(辩论|辩一轮|辩一下|讨论|聊聊|说说|讲讲|来一轮|一轮|一下)?/gu

/** 停机原因取值域(校验用,顺序即枚举)。 */
const STOP_REASONS = ['convergence', 'saturation', 'maxRounds', 'manual'] as const
type StopReason = (typeof STOP_REASONS)[number]

/**
 * 可持久化的一局。
 * **白名单**:只列这些字段,所以以后往内存会话里加字段不会悄悄改变落盘格式;
 * 要持久化就必须显式加到这里,相容性因此是可审计的。
 * 不落盘的两项:`streaming`(转瞬即逝的打字机中间态)、`mirrorToChat`(绑在发起会话上,重启后无意义)。
 */
export interface SessionRecord {
  /** 记录格式版本。 */
  v: number
  id: string
  config: DebateConfig
  status: DebateStatus
  round: number
  transcript: TranscriptEntry[]
  map: DebateMap | null
  mapText: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  progress: string
  mirrorCount: number
  mirrorError: string | null
  parentSid: string | null
  stopReason: StopReason | null
  rounds: DebateRound[]
  mode: 'single' | 'resident' | 'oneShot'
  residentError: string | null
  decisionSummary: string | null
  /** 单线分叉清扫失败原因(null=清干净或本局没走单线)。可选审计字段,老记录缺它即 null。 */
  sweepError?: string | null
  /** 本局清掉的分叉会话 id。可选审计字段,老记录缺它即 []。 */
  sweptSessions?: string[]
  /** 结论文档相对工作区的路径(写过才有);绝对路径由 targetCwd + 它拼出来,移动工作区也不失效。 */
  reportRel: string | null
  /** 生效笼型(S16,可选审计字段:老记录缺它即按 null 恢复,不 bump 版本,见 ADR-0021)。 */
  cageNote?: string | null
  /** 打断点(S17,可选审计字段:老记录缺它即按 null 恢复,不 bump 版本,见 ADR-0021)。 */
  interruptedAt?: { round: number; seq: number } | null
  /** 发起会话忙快照(S17,可选审计字段:老记录缺它即按 false 恢复,不 bump 版本,见 ADR-0021)。 */
  parentBusy?: boolean | null
}

/** `toRecord` 的入参面:内存会话只要形状对得上即可(结构子类型,不比 index.ts 的私有接口耦合)。 */
export interface PersistableSession extends Omit<SessionRecord, 'v' | 'reportRel'> {
  reportRel?: string | null
}

/** 摘出可持久化字段。显式逐字段赋值——不做展开,免得把瞬时态一起写进去。 */
export function toRecord(s: PersistableSession): SessionRecord {
  return {
    v: RECORD_VERSION,
    id: s.id,
    config: s.config,
    status: s.status,
    round: s.round,
    transcript: s.transcript,
    map: s.map,
    mapText: s.mapText,
    error: s.error,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    progress: s.progress,
    mirrorCount: s.mirrorCount,
    mirrorError: s.mirrorError,
    parentSid: s.parentSid,
    stopReason: s.stopReason,
    rounds: s.rounds,
    mode: s.mode,
    residentError: s.residentError,
    decisionSummary: s.decisionSummary,
    reportRel: s.reportRel ?? null,
    cageNote: s.cageNote ?? null,
    interruptedAt: s.interruptedAt ?? null,
    parentBusy: s.parentBusy ?? null,
    sweepError: (s as { sweepError?: string | null }).sweepError ?? null,
    sweptSessions: Array.isArray((s as { sweptSessions?: unknown }).sweptSessions)
      ? (s as { sweptSessions: string[] }).sweptSessions
      : [],
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

/**
 * 把一条已存记录还原成内存会话。
 * 判据只到"能不能用"这一层:关键字段缺失/版本超前/根本不是对象 → null(调用方跳过该条);
 * 次要字段缺失一律补默认值——**多恢复一局胜过少恢复一局**,一条坏记录不该拖垮整张表。
 */
export function fromRecord(raw: unknown): SessionRecord | null {
  if (!isObj(raw)) return null
  const v = num(raw.v, -1)
  if (v < 1 || v > RECORD_VERSION) return null
  const id = str(raw.id)
  if (id === '') return null
  const config = isObj(raw.config) ? (raw.config as unknown as DebateConfig) : null
  if (config === null) return null
  if (!isObj(config.builder) || !isObj(config.challenger)) return null
  const status = str(raw.status, 'stopped') as DebateStatus
  const stop = str(raw.stopReason)
  return {
    v,
    id,
    config,
    status,
    round: num(raw.round, -1),
    transcript: arr<TranscriptEntry>(raw.transcript),
    map: isObj(raw.map) ? (raw.map as unknown as DebateMap) : null,
    mapText: typeof raw.mapText === 'string' ? raw.mapText : null,
    error: typeof raw.error === 'string' ? raw.error : null,
    createdAt: num(raw.createdAt, 0),
    updatedAt: num(raw.updatedAt, 0),
    progress: str(raw.progress),
    mirrorCount: num(raw.mirrorCount, 0),
    mirrorError: typeof raw.mirrorError === 'string' ? raw.mirrorError : null,
    parentSid: typeof raw.parentSid === 'string' ? raw.parentSid : null,
    stopReason: (STOP_REASONS as readonly string[]).includes(stop) ? (stop as StopReason) : null,
    rounds: arr<DebateRound>(raw.rounds),
    mode: str(raw.mode) === 'resident' ? 'resident' : str(raw.mode) === 'single' ? 'single' : 'oneShot',
    residentError: typeof raw.residentError === 'string' ? raw.residentError : null,
    decisionSummary: typeof raw.decisionSummary === 'string' ? raw.decisionSummary : null,
    reportRel: typeof raw.reportRel === 'string' ? raw.reportRel : null,
    cageNote: typeof raw.cageNote === 'string' ? raw.cageNote : null,
    interruptedAt: isObj(raw.interruptedAt) && typeof raw.interruptedAt.round === 'number' && typeof raw.interruptedAt.seq === 'number'
      ? { round: raw.interruptedAt.round as number, seq: raw.interruptedAt.seq as number }
      : null,
    parentBusy: raw.parentBusy === true ? true : raw.parentBusy === false ? false : null,
    sweepError: typeof raw.sweepError === 'string' ? raw.sweepError : null,
    sweptSessions: arr<string>(raw.sweptSessions),
  }
}

/**
 * 恢复后的收尾:上次记的是 running,说明进程是在半途消失的(宿主重启/崩溃),
 * 那个后台任务已经不存在了。标成 stopped 并在 progress 里说清原因——
 * 面板显示"还在跑"而实际永远不动,比显示"已中断"更糟。
 */
export function markInterrupted(rec: SessionRecord, note: string): SessionRecord {
  if (rec.status !== 'running') return rec
  return { ...rec, status: 'stopped', progress: note, updatedAt: Date.now() }
}

/** Windows 文件名禁字符 + 控制字符 + 常见路径分隔符。 */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]/g

/**
 * 问题 → 文件名片段。保留中文(问题多半是中文,换成拼音只会更难认),
 * 只清掉文件名里非法的字符与结构隐患。
 * 精练:先去语气词(占位置不定位),再按码点切到 12 字——
 * 线上实测 40 字 slug 让 ls 糊成三行;文件名是索引,标题全文在文件内第一行。
 */
export function slugify(q: string): string {
  const cleaned = q
    .replace(SLUG_CONTINUATION, '')
    // 承接语清完剩下标点/空白(如"就以上问题继续辩论"→"问题继续辩论"→"继续辩论"),再清一轮残留。
    .replace(/^(问题|话题|讨论|内容)?(继续|接着|再|重新|新开|另起|深入|展开|细化)?(辩论|辩一轮|辩一下|讨论|聊聊|说说|讲讲|来一轮|一轮|一下)?/u, '')
    .replace(SLUG_STOPWORDS, '')
    .replace(UNSAFE, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    // Windows 不允许名字以点/空格结尾,连字符开头也容易被当成参数。
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
  const capped = Array.from(cleaned).slice(0, SLUG_MAX_CODEPOINTS).join('')
  return capped.replace(/[-.\s]+$/g, '') || 'debate'
}

/** 本地时间戳(不用 toLocaleString:输出形状要稳定,不随宿主 locale 变)。 */
export function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 本地日期(文件名用,`YYYY-MM-DD`)。 */
export function dayStamp(ms: number): string {
  return stamp(ms).slice(0, 10)
}

/** 时长的人话形式:取一个量级就够,别写成 1 小时 7 分 13 秒。 */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

/**
 * 结论文档的相对路径:`docs/debates/<日期>-<问题 slug>-<id 尾>.md`。
 * 带上 id 尾:同一天问同一个问题两次也不会互相覆盖,而且能从文件名反查到是哪一局。
 */
export function reportRelPath(createdAt: number, question: string, id: string): string {
  const tail = Array.from(id.replace(/[^a-zA-Z0-9]/g, '')).slice(-6).join('') || 'unknown'
  return `${REPORT_DIR}/${dayStamp(createdAt)}-${slugify(question)}-${tail}.md`
}

/** 渲染结论文档所需的一切(全部显式传入,保持本模块无 IO、可单测)。 */
export interface ReportInput {
  id: string
  question: string
  questionType: string
  lenses: string[]
  targetCwd: string | null
  createdAt: number
  finishedAt: number
  status: DebateStatus
  error: string | null
  stopReason: StopReason | null
  maxRounds: number
  decisionSummary: string | null
  mapText: string | null
  rounds: DebateRound[]
  transcript: TranscriptEntry[]
  /** 生成者标识(版本号),由调用方传入以免本模块依赖 version.ts。 */
  generator: string
  /** 面板/对话区里那个停机原因的人话文本(与面板同一份口径)。 */
  stopText: string
  /** 缺口年龄(调用方用 parseGaps 逐轮抽 + gapAge 算);缺了就不写"未覆盖"节,不猜。 */
  gapSpans?: GapSpan[]
}

/** 表格单元:竖线会撕裂表格,换行会撕裂行。 */
const cell = (v: unknown): string => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim() || '—'

/** 正文块:内容里若出现 `</details>` 会把外层折叠块提前关闭。 */
const body = (v: string): string => v.replace(/<\/details>/gi, '<\\/details>')

/**
 * 渲染结论文档。
 * 排布按"人先读结论、再按需下钻"来:决策摘要 → 成果地图 → 每轮判定表 → 折叠的全文。
 * 全文折叠但不丢弃——文件很便宜,而"当时到底怎么说的"只有全文能回答。
 */
export function renderReport(i: ReportInput): string {
  const lines: string[] = []
  const totalChars = i.transcript.reduce((n, e) => n + e.text.length, 0)

  lines.push(`# 辩论:${i.question || '(问题缺失)'}`, '')
  lines.push('| 项 | 值 |', '| --- | --- |')
  lines.push(`| 局 id | \`${cell(i.id)}\` |`)
  lines.push(`| 题型 | ${cell(i.questionType)} · ${i.lenses.length} 视角 |`)
  lines.push(`| 工作区 | ${i.targetCwd ? `\`${cell(i.targetCwd)}\`` : '—(未指定)'} |`)
  lines.push(`| 起止 | ${cell(stamp(i.createdAt))} → ${cell(stamp(i.finishedAt))}(${cell(duration(i.finishedAt - i.createdAt))}) |`)
  lines.push(`| 状态 | ${cell(i.status)}${i.error ? ` · 错误:${cell(i.error)}` : ''} |`)
  lines.push(`| 停机 | ${cell(i.stopText)} |`)
  lines.push(`| 交锋 | ${i.rounds.length} 轮(上限 ${i.maxRounds}) |`)
  lines.push(`| 全文 | ${i.transcript.length} 段 · ${totalChars.toLocaleString('en-US')} 字 |`)
  lines.push(`| 生成 | ${cell(i.generator)} · ${cell(stamp(i.finishedAt))} |`, '')

  lines.push('## 决策摘要', '')
  lines.push(body(i.decisionSummary ?? '_(制图员未产出决策摘要,也没有可兜底的判定数据)_'), '')

  lines.push('## 成果地图', '')
  lines.push(i.mapText ? body(i.mapText) : '_(本轮没有成果地图:辩论未跑到制图阶段)_', '')

  lines.push('## 每轮判定', '')
  if (i.rounds.length === 0) {
    lines.push('_(没有交锋记录)_', '')
  } else {
    lines.push('| 轮 | 建构 agree | 挑战 agree | 新增 | 未决 | 引用命中 | 建构答案 | 挑战答案 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const r of i.rounds) {
      const pend = r.pendingItems === null ? '—' : String(r.pendingItems.length)
      const hit = r.quoteAudit?.hitRate === null || r.quoteAudit?.hitRate === undefined
        ? '—'
        : `${r.quoteAudit.quotedLines}/${r.quoteAudit.quotableLines}(${Math.round(r.quoteAudit.hitRate * 100)}%)`
      lines.push(`| R${r.round} | ${r.builderAgree ? '✅' : '—'} | ${r.challengerAgree ? '✅' : '—'} | ${r.hasNewInfo ? '有' : '无'} | ${pend} | ${hit} | ${cell(r.builderAnswer)} | ${cell(r.challengerAnswer)} |`)
    }
    lines.push('')
    lines.push(`> 未决 = 挑战者自报的未决条件条数(焦点账本);引用命中 = 挑战者引用建构者原文的片段命中率(ADR-0014/0017)。`, '')
  }

  // 未覆盖:一致达成时仍存活的缺口(只说事实,不拦停机;没给 gapSpans 就不写,不猜)。
  // 展示截断与兜底收尾各管各的数(报告是文档可长,收尾是对话区要短),常量散两处是故意的。
  const uncovered = (i.gapSpans ?? []).filter((g) => g.lastRound >= i.rounds.length && i.rounds.length > 0)
  if (uncovered.length > 0) {
    lines.push('## 未覆盖(一致达成时仍存活的缺口)', '')
    for (const g of uncovered.slice(0, 10)) {
      lines.push(`- ${cell(g.gap)}:自 R${g.firstRound} 存活 ${g.age} 轮(至 R${g.lastRound})`)
    }
    if (uncovered.length > 10) lines.push(`- ……等共 ${uncovered.length} 条`)
    lines.push('')
  }

  lines.push('## 全文交锋记录', '')
  for (const e of i.transcript) {
    const round = e.round >= 0 ? `R${e.round}` : '—'
    lines.push(`<details><summary>${cell(round)} ${cell(e.role)} · ${e.text.length.toLocaleString('en-US')} 字</summary>`, '')
    lines.push(body(e.text), '')
    lines.push('</details>', '')
  }

  return lines.join('\n')
}
