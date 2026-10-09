/**
 * dsh-debate — 纯协议层(与载体无关,可单元测试)。
 *
 * 术语以 CONTEXT.md 为准:开放性论证题(open_question)、建构者(builder)、
 * 挑战者(challenger)、制图员(synthesizer)、视角(lens)、成果地图(debate_map)五件套、
 * 断言状态(claim_status 四态)、覆盖饱和(saturation)。
 */
import type { LensTemplate, QuestionType } from './lenses'
import { defaultLensIds } from './lenses'

/** 断言类型:事实 / 推理 / 价值判断(ADR-0005)。 */
export type ClaimKind = 'fact' | 'reasoning' | 'value'

/** 断言状态四态:已支撑 / 推断 / 缺失 / 矛盾 —— 没有第五态(ADR-0001/0005)。 */
export type ClaimStatus = 'supported' | 'inferred' | 'missing' | 'contradicted'

/** 第五态黑话:一旦出现视为无效输出,打回重出。 */
const BANNED_PHRASES = ['大概能', '基本满足', '总体可行', '原则上可以', '差不多', '应该没问题']

/** 检查文本是否含有第五态黑话。 */
export function containsBannedPhrase(text: string): string[] {
  return BANNED_PHRASES.filter((p) => text.includes(p))
}

/** 归一化答案:去空白/标点/大小写,用于共识收敛判定。标点表含 ASCII 全套(v3 补上半角逗号/句点等遗漏)。 */
export function normalizeAnswer(answer: string): string {
  return answer
    .replace(/\s+/g, '')
    .replace(/[。、，，．，！!？?；;：:「」『』（）()【】\[\]\"'“”‘’·…—–\-_\/\\|~@#￥$%^&*+=<>《》,.。、!?:;'"`~()\[\]{}]/g, '')
    .toLowerCase()
}

/** 共识收敛判定(双条件缺一不可):双方显式 agree 且归一化答案一致。 */
export function isConverged(aAgree: boolean, bAgree: boolean, aAnswer: string, bAnswer: string): boolean {
  if (!aAgree || !bAgree) return false
  if (aAnswer.trim() === '' || bAnswer.trim() === '') return false
  return normalizeAnswer(aAnswer) === normalizeAnswer(bAnswer)
}

/**
 * 停机信号解析协议版本(B5):prompt 里的自报格式一改就 +1,
 * 旧局靠 DebateRound.protoVersion 追溯当时用哪套解析。
 * v1: agree=/answer= 行 + 结论摘要回落;
 * v2: + 对方原文引用用【引R{轮}】…【/引】包裹(供引用审计,B6);
 * v3: + 归一化标点表补 ASCII 全套(半角逗号/句点曾漏判,共识召回补漏,只加不减)。
 */
export const STOP_PROTOCOL_VERSION = 3

/**
 * agree 自报解析:只认显式接受(大小写/全角/中文容忍)。
 * 注意:\\b 在 JS 里按 ASCII 词边界算,中文"是"不是词字符,`agree=是` 会被漏判——
 * 所以中文分支不用 \\b,改用行尾/非词字符前瞻。
 */
export function parseAgree(text: string): boolean {
  if (/(^|\n)\s*agree\s*[=:：]\s*(true|yes|是)\s*(?=$|[\s,;。)）])/i.test(text)) return true
  if (/(^|\n)\s*(接受|同意|认可)\s*(对方|该|这个)?\s*(答案|结论|方案)?\s*[=:：]\s*(true|yes|是)\s*(?=$|[\s,;。)）])/i.test(text)) return true
  return false
}

/** 答案自报解析:answer= 后同一行的文本(供归一化比对;缺失则回落结论摘要段)。 */
export function parseAnswer(text: string): string {
  const m = text.match(/(^|\n)\s*answer\s*[=:：]\s*([^\n]+)/i)
  if (m) return m[2].trim()
  const sec = text.match(/##\s*结论摘要\s*([\s\S]*?)(?=\n##\s*|$)/)
  return sec ? sec[1].trim().slice(0, 500) : ''
}

/**
 * 新增信息信号词。命中即算"本轮有新增"——但必须过否定关(见 hasNewInfoSignal)。
 */
const NEW_INFO_RE = /(缺口|缺失|新增|新发现|让步|收回|新视角|补充)/g

/** 否定词:出现在信号词前的窗口内,则该次命中不算新增(B1:"没有新增缺口"曾被读成有新增)。 */
const NEGATION_RE = /(没有|没有任何|无任何|不存在|未见|未发现|不再|尚未|未|无)/

/**
 * 文本里是否存在**未被否定**的新增信息信号。
 * 逐次命中信号词,回看前 8 个字符;窗内有否定词则视为该次命中被否定。
 * 例:"没有新增缺口" → 两次命中(新增/缺口)窗内都有"没有" → false;
 *     "新增缺口:缺压测数据" → 窗内无否定 → true。
 */
export function hasNewInfoSignal(text: string): boolean {
  NEW_INFO_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = NEW_INFO_RE.exec(text)) !== null) {
    const from = Math.max(0, m.index - 8)
    const window = text.slice(from, m.index)
    // 否定只在自己所在的那一行内生效,避免上一行的否定污染下一行。
    const lineStart = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'))
    const local = lineStart >= 0 ? window.slice(lineStart + 1) : window
    if (!NEGATION_RE.test(local)) return true
  }
  return false
}

/** 显式"无新增"声明:模型明说没有新东西时,别再靠相似度硬算成有新增(B1 补强)。 */
const DECLARED_NO_CHANGE_RE =
  /((没有|无|未|不再|尚未)\s*(任何)?\s*(新增|新)\s*(的)?\s*(缺口|视角|变化|信息|观点|让步|补充|挑战|发现))|((没有|无|未)\s*(让步|收回|补充))/

/** 饱和启发式(host 侧零模型成本):本轮相对上一轮是否有新增信息。 */
export function detectNewInfo(prev: string, curr: string): boolean {
  const norm = (t: string): string => normalizeAnswer(t).slice(0, 4000)
  const a = norm(prev)
  const b = norm(curr)
  if (a === '' || b === '') return true
  if (a === b) return false
  const positive = hasNewInfoSignal(curr)
  // 显式声明"本轮没有新增/没有让步"→ 直接认定无新增(否定关,先于相似度兜底)。
  if (!positive && DECLARED_NO_CHANGE_RE.test(curr)) return false
  // 非否定的新增信号即算有新增(否定关见 hasNewInfoSignal)。
  if (positive) return true
  // 文本相似度兜底:归一化后一方包含另一方且长度差 < 10% 视为车轱辘话。
  const longer = a.length >= b.length ? a : b
  const shorter = a.length >= b.length ? b : a
  if (longer.includes(shorter) && (longer.length - shorter.length) / longer.length < 0.1) return false
  return true
}

/** 交棒载荷瘦身结果。 */
export interface HandoffBrief {
  /** 投给下一棒的文本(结论摘要 + 本轮变化 + 截断后的详细论证 + 对方自报行)。 */
  text: string
  /** 原文字数。 */
  fullChars: number
  /** 瘦身后字数。 */
  briefChars: number
  /** 详细论证是否被截断。 */
  truncated: boolean
}

/** 取三段中的一段(标题行原样,内容到下一个 ## 为止)。 */
function sectionOf(text: string, name: string): string {
  const re = new RegExp(`##\\s*${name}\\s*([\\s\\S]*?)(?=\\n##\\s|$)`)
  const m = text.match(re)
  return m ? m[1].trim() : ''
}

/** 头尾截断:保头 60% 保尾 40%,中间插省略标记。 */
function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const head = Math.floor(max * 0.6)
  const tail = max - head
  return { text: `${text.slice(0, head)}\n…(详细论证中段已略,全文见 transcript)\n${text.slice(-tail)}`, truncated: true }
}

/**
 * 交棒载荷瘦身(B4/S2):跨轮交棒只传结论摘要 + 本轮变化,详细论证按预算头尾截断,
 * 并把对方的 agree/answer 自报压成一行(host 已解析,正文里不再重复)。
 * 全文仍在 transcript,审计可回跳;同轮内(builder→challenger)仍传全文,保证能逐条引用原文。
 */
export function slimHandoff(text: string, maxChars = HANDOFF_MAX_CHARS): HandoffBrief {
  const fullChars = text.length
  const agree = parseAgree(text) ? 'true' : 'false'
  const answer = parseAnswer(text)
  const head = `[对方自报] agree=${agree}${answer !== '' ? ` answer=${answer}` : ''}`
  const summary = sectionOf(text, '结论摘要')
  const delta = sectionOf(text, '本轮变化')
  const detail = sectionOf(text, '详细论证')
  const fixed = [head, summary !== '' ? `## 结论摘要\n${summary}` : '', delta !== '' ? `## 本轮变化\n${delta}` : '']
    .filter((s) => s !== '')
    .join('\n\n')
  const budget = Math.max(0, maxChars - fixed.length - 40)
  const clipped = clip(detail, budget)
  const parts = [fixed]
  if (detail !== '') parts.push(`## 详细论证${clipped.truncated ? '(已截断)' : ''}\n${clipped.text}`)
  const out = parts.join('\n\n')
  return { text: out, fullChars, briefChars: out.length, truncated: clipped.truncated }
}

/** 一轮交锋结果(落进会话供审计:为什么停要有据可查,见 QAS-2)。 */
export interface DebateRound {
  round: number
  builderAnswer: string
  builderAgree: boolean
  challengerAnswer: string
  challengerAgree: boolean
  /** 本轮是否有新增信息(新视角 / 新缺口 / 状态变化任一)。 */
  hasNewInfo: boolean
  /** 本轮投给建构者的交棒载荷字数(上下文预算可观测,B4/S2)。 */
  builderRelayChars: number
  /** 构造本记录时用的停机信号解析协议版本(协议一改就 +1,B5/S3)。 */
  protoVersion: number
  /** 挑战者本轮引用建构者原文的命中统计(B6/S3,见 auditQuotes)。 */
  quoteAudit: QuoteAudit
}

/**
 * 引用审计(B6):挑战者"必须引用对方原文"的硬约束有没有被遵守,
 * 用 transcript 回放统计量化,不靠模型自报。
 */
export interface QuoteAudit {
  /** 建构者本轮输出里可被引用的候选句数(去空白后长度≥阈值的实质句)。 */
  quotableLines: number
  /** 挑战者本轮命中了其中多少句(片段命中即算,见 QUOTE_FRAG_LEN)。 */
  quotedLines: number
  /** 含命中片段的建构者行号(1-based),可回跳 transcript 原文核对。 */
  hitLines: number[]
  /** 命中率 = quotedLines / quotableLines(无可引用句时为 null,不算 0)。 */
  hitRate: number | null
}

/** 可被引用的实质句:去空白后长度阈值(太短的不算引用,避免"的/了"式误命中)。 */
export const QUOTABLE_MIN_LEN = 12

/** 引用命中的片段窗口:挑战者包含建构者原文中连续这么多字即算命中(B6/S3:片段级)。 */
export const QUOTE_FRAG_LEN = 12

/** B6 实测锚:瘦身后挑战者引用命中率的告警线,低于此值说明瘦身砍掉了关键证据。 */
export const QUOTE_HIT_ALERT = 0.3

/**
 * 引用审计:用挑战者本轮 text 里是否出现建构者本轮原文**片段**来统计命中。
 * 整行子串太严——钢人化复述本来就是改写,挑战者常只抄短语(如"无成本闸成立")
 * 而非整行,整行口径会把"逐条打了 Q1-Q6"记成 0 命中(实测 verify9 R2:0/22)。
 * - 候选句:建构者输出去掉段标题/`[对方自报]`/`MODEL:`/`agree=/answer=`/空行后,
 *   长行再按句号/感叹/问号/分号切分,每句去空白后长度≥阈值才算;
 * - 命中:候选句中存在连续 QUOTE_FRAG_LEN 字原样出现在挑战者文本(去空白后)里;
 * - hitLines 记含命中片段的建构者行号(1-based),可回跳 transcript 原文核对。
 * 返回 hitRate=null 表示本轮无可引用句(建构者输出太短),与"引用 0 行"区分开。
 * 仍是下限估计:纯改写(一个字都不抄)依然抓不到,见 ADR-0016。
 */
export function auditQuotes(builderOut: string, challengerOut: string): QuoteAudit {
  const chal = challengerOut.replace(/\s+/g, '')
  const cands: Array<{ lineNo: number; text: string }> = []
  builderOut.split('\n').forEach((raw, idx) => {
    const line = raw.trim()
    if (line === '') return
    if (/^#{2,}\s/.test(line)) return
    if (/^\[对方自报\]/.test(line)) return
    if (/^MODEL:/i.test(line)) return
    if (/^(agree|answer)\s*[=:：]/.test(line)) return
    // 长行按句切分:多句各算各的,转述式引用常只抄其中一句。
    for (const seg of line.split(/(?<=[。！？；;])/)) {
      const s = seg.trim().replace(/\s+/g, '')
      if (s.length < QUOTABLE_MIN_LEN) continue
      cands.push({ lineNo: idx + 1, text: s })
    }
  })
  const hitLineSet = new Set<number>()
  let quoted = 0
  for (const c of cands) {
    if (hasFragHit(c.text, chal)) {
      quoted++
      hitLineSet.add(c.lineNo)
    }
  }
  return {
    quotableLines: cands.length,
    quotedLines: quoted,
    hitLines: [...hitLineSet].sort((a, b) => a - b),
    hitRate: cands.length === 0 ? null : quoted / cands.length,
  }
}

/** 候选句中是否存在连续 QUOTE_FRAG_LEN 字原样出现在挑战者文本里。 */
function hasFragHit(sent: string, chalNorm: string): boolean {
  if (sent.length < QUOTE_FRAG_LEN) return chalNorm.includes(sent)
  for (let i = 0; i + QUOTE_FRAG_LEN <= sent.length; i++) {
    if (chalNorm.includes(sent.slice(i, i + QUOTE_FRAG_LEN))) return true
  }
  return false
}

/** 由两侧原文构造一轮记录(解析只做一次,判定与审计共用同一份输入)。 */
export function toDebateRound(
  round: number,
  builderOut: string,
  challengerOut: string,
  prevCombined: string,
  builderRelayChars = 0,
): DebateRound {
  const currCombined = [builderOut, challengerOut].join('\n\n')
  return {
    round,
    builderAnswer: parseAnswer(builderOut),
    builderAgree: parseAgree(builderOut),
    challengerAnswer: parseAnswer(challengerOut),
    challengerAgree: parseAgree(challengerOut),
    hasNewInfo: detectNewInfo(prevCombined, currCombined),
    builderRelayChars,
    protoVersion: STOP_PROTOCOL_VERSION,
    quoteAudit: auditQuotes(builderOut, challengerOut),
  }
}

/** 由一轮记录判共识收敛(双方显式 agree 且归一化答案一致)。 */
export function roundConverged(r: DebateRound): boolean {
  return isConverged(r.builderAgree, r.challengerAgree, r.builderAnswer, r.challengerAnswer)
}

/**
 * 覆盖饱和判定(ADR-0004):一整轮无新增信息即停。
 * 调用方每轮结束后传入本轮记录;返回 true 表示已饱和应当停机。
 */
export function isSaturated(rounds: DebateRound[]): boolean {
  if (rounds.length === 0) return false
  const last = rounds[rounds.length - 1]
  return last.hasNewInfo === false
}

/** 辩论单状态机。 */
export type DebateStatus = 'idle' | 'running' | 'done' | 'failed' | 'stopped'

/** 辩论配置(v0.2:只留三模型+轮数,问题/题型/lens/背景全自动)。 */
export interface DebateConfig {
  /** 建构者路由,如 { provider: 'local-proxy', model: 'opencode-muse-spark-1.3' }。 */
  builder: { provider: string; model: string }
  /** 挑战者路由,默认与建构者相同(单模型双角色)。 */
  challenger: { provider: string; model: string }
  /** 制图员路由,默认复用建构者(ADR-0006:新会话即算独立)。 */
  synthesizer: { provider: string; model: string }
  /** 最大交锋轮数,默认 5。 */
  maxRounds: number
  /**
   * 目标工作区:辩手读文件的根目录(评审别家工程时填,如 D:\...\ai_proxy;空=沿用发起会话 cwd)。
   * host 建单即校验存在性,不存在直接报错,不等开题才挂。
   */
  targetCwd?: string
  /**
   * 自动判断结果(工具执行时从 parent 会话提取,面板不填):
   * question 由触发语/最近会话合成,questionType/lenses 由 classifyQuestion 定,
   * context 由 extractSessionContext 提炼。
   */
  auto?: {
    question: string
    questionType: QuestionType
    lenses: string[]
    context: string
  }
}

/** 背景包上限:防爆 token,超长由 host 截断。 */
export const CONTEXT_MAX_LEN = 4000

/** 跨轮交棒载荷上限:只传对方结论摘要 + 本轮变化,详细论证按此上限头尾截断(B4/S2)。 */
export const HANDOFF_MAX_CHARS = 2400

/** 默认配置(v0.2:只留三模型+轮数,问题/题型/lens/背景全自动;v0.3 挑战者默认 flash)。 */
export const DEFAULT_CONFIG = {
  builder: { provider: 'local-proxy', model: 'opencode-muse-spark-1.3' },
  challenger: { provider: 'local-proxy', model: 'opencode-ds41-flash' },
  synthesizer: { provider: 'local-proxy', model: 'opencode-muse-spark-1.3' },
  maxRounds: 5,
}

/**
 * 自动题型分类(v0.2 关键词启发式,后续可换模型分类):
 * 评审信号(满足/达标/符合/验证/评审/架构.*需求) → review;
 * 权衡信号(还是/权衡/优先/取舍/代价) → tradeoff;
 * 因果信号(为什么/怎么/原因/失败/慢/排查) → causal;
 * 否则 → selection。
 */
export function classifyQuestion(question: string): { questionType: QuestionType; lenses: string[] } {
  const q = question
  if (/满足|达标|符合|验证|评审|对照|达到|能不能|能否/.test(q)) return { questionType: 'review', lenses: defaultLensIds('review') }
  if (/还是|权衡|优先|取舍|代价|值得/.test(q)) return { questionType: 'tradeoff', lenses: defaultLensIds('tradeoff') }
  if (/为什么|怎么|原因|失败|慢|排查|解释|如何定位/.test(q)) return { questionType: 'causal', lenses: defaultLensIds('causal') }
  return { questionType: 'selection', lenses: defaultLensIds('selection') }
}

/** 会话事件最小面:提炼背景包所需子集,结构化防御读取。 */
export interface SessionEventLike {
  readonly type: string
  readonly data?: unknown
  [key: string]: unknown
}

/** 文本块最小面。 */
interface BlockLike {
  readonly type?: unknown
  readonly text?: unknown
}

/** 从未知结构里尽力抽文本块。 */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (b !== null && typeof b === 'object' && (b as BlockLike).type === 'text') {
      const t = (b as BlockLike).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n')
}

/** 从消息对象里尽力抽文本(兼容 content / text / message.content)。 */
function messageText(msg: unknown): string {
  if (typeof msg === 'string') return msg
  if (msg === null || typeof msg !== 'object') return ''
  const m = msg as Record<string, unknown>
  for (const key of ['content', 'text', 'body']) {
    const t = blocksText(m[key])
    if (t.trim() !== '') return t
  }
  if (m.message !== undefined) return messageText(m.message)
  return ''
}

/**
 * 从 parent 会话事件提炼背景包(v0.2):
 * 取最近 N 条 user/assistant 消息文本,去工具结果与系统提示,拼成背景。
 * 返回 '' 表示无可用背景(新会话)。
 */
export function extractSessionContext(events: SessionEventLike[], maxChars = CONTEXT_MAX_LEN, maxMessages = 10): string {
  const texts: string[] = []
  for (let i = events.length - 1; i >= 0 && texts.length < maxMessages; i--) {
    const ev = events[i]
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
    const data = ev.data as Record<string, unknown> | undefined
    const t = messageText(data?.message ?? data?.content ?? data).trim()
    if (t === '' || /debate_(open|round|synthesize|run)|辩论单/.test(t)) continue
    texts.unshift(t)
  }
  const joined = texts.join('\n\n---\n\n')
  return joined.length > maxChars ? joined.slice(-maxChars) : joined
}

/** transcript 条目。 */
export interface TranscriptEntry {
  seq: number
  role: 'builder' | 'challenger' | 'synthesizer' | 'judge' | 'system'
  round: number
  text: string
}

/** 成果地图五件套(ADR-0001)。 */
export interface DebateMap {
  lenses: Array<{ name: string; claim: string }>
  arguments: Array<{ claim: string; reasons: string[]; counterExamples: string[]; confidence: number }>
  grounding: Array<{ statement: string; kind: ClaimKind; status: ClaimStatus; source?: string }>
  disputes: Array<{ topic: string; agreed: boolean; kind: 'fact' | 'value' | null; detail: string }>
  gaps: Array<{ missing: string; howToFill: string }>
  verdict?: { opinion: string; reasons: string[] }
}

/** 组装建构者开题 prompt。 */
export function buildBuilderPrompt(question: string, lenses: LensTemplate[], questionType: QuestionType, context = ''): string {
  const lensList = lenses.map((l) => `- ${l.name}: ${l.description}`).join('\n')
  const ctxBlock = context.trim() !== '' ? `\n背景(前面会话已定,须遵守:已排除的不再铺,已验证的不再争,术语沿用,已决边界不重开):\n${context.trim()}\n` : ''
  return [
    `你是建构者(builder)。任务:为下面的开放性论证题把答案空间铺满,不许提前收敛到单一结论。`,
    `边界:你是被辩论链路调用的子 agent,首要产出是文本论证。不要调用任何 debate_* 工具(链路 already 在驱动你)。但你手里的文件读取/检索/shell/网络工具该用就用:凡是能外部检验的事实,优先用工具查证再写,查不到才标缺失。`,
    `找文件预算:用 glob/grep 找目标文件最多试 3 次(含换关键词/换目录),找不到就标"缺失(文件不在工作区)"然后基于题面继续写,不许无限翻目录。`,
    ``,
    `问题: ${question}`,
    ctxBlock,
    `题型: ${questionType}`,
    `你负责的视角(lens):`,
    `${lensList}`,
    ``,
    `要求:`,
    `1. 列出候选主张(允许多个并列),每个配支撑理由与置信度(0~1)。`,
    `2. 每条关键断言先分类型:事实(可外部检验)/推理(链条)/价值判断(偏好,只记录归属)。`,
    `3. 事实必须带出处指针(如"需求 §3.2");没有出处的"能"一律标为缺失,不许写成"能"。`,
    `4. 禁用黑话:大概能、基本满足、总体可行、原则上可以、差不多、应该没问题。`,
    `5. 同时自报你的模型身份,格式:MODEL:<provider>/<model>。你没有环境查询工具,如实填你被配置的模型名;不知道就写 MODEL:unknown,不许编造。`,
    `6. 停机信号:本段固定两行,单独成段放在最后,不要写进三段正文里(host 解析用):`,
    `   agree=false`,
    `   answer=<你的当前答案,一句话>`,
    `7. 输出必须分三段,段标题原样保留(面板按段折叠渲染):`,
    `   ## 结论摘要`,
    `   ## 详细论证`,
    `   ## 本轮变化`,
    `8. 各段内容:结论摘要=5 行内本轮立场 + 最关键的一条支撑/缺失;详细论证=候选主张与表格全放这里;本轮变化=开题轮只写一行「首轮,无对比」,不要照抄本条要求。`,
  ].join('\n')
}

/**
 * 组装建构者交锋轮 prompt(常驻与一次性共用)。
 * 之前建构者交锋轮复用挑战者 prompt(角色错位),这里改为建构者自己的回合:
 * 逐条回应挑战(接受或守住)、可修正答案、必须报本轮变化。
 */
export function buildBuilderRoundPrompt(
  question: string,
  challengerOutput: string,
  round: number,
  maxRounds: number,
  context = '',
): string {
  const ctxBlock = context.trim() !== '' ? `\n背景(前面会话已定:已验证的不再争,术语沿用,已决边界不重开):\n${context.trim()}\n` : ''
  return [
    `你是建构者(builder)。这是第 ${round}/${maxRounds} 轮交锋——挑战者刚给了你上一轮的挑战,你要回应它。`,
    `边界:你是被辩论链路调用的子 agent,首要产出是文本论证。不要调用任何 debate_* 工具;但你手里的文件读取/检索/网络工具该用就用:守不住的事实断言要用工具查证后再守,查不到就承认并改成缺失。`,
    `找文件预算:glob/grep 最多试 3 次,找不到就标"缺失(文件不在工作区)"。`,
    ``,
    `问题: ${question}`,
    ctxBlock,
    `挑战者本轮输出:`,
    `${challengerOutput}`,
    ``,
    `要求:`,
    `1. 逐条回应挑战:每条要么接受并修正你的主张(写清改成了什么),要么守住并给出证据指针;不许含糊带过。`,
    `2. 事实必须带出处指针;没有出处的"能"一律标为缺失。禁用黑话:大概能、基本满足、总体可行、原则上可以、差不多、应该没问题。`,
    `3. 自报模型身份,格式:MODEL:<provider>/<model>;不知道就写 MODEL:unknown,不许编造。`,
    `4. 停机信号:本段固定两行,单独成段放在最后,不要写进三段正文里(host 解析用):`,
    `   agree=true/false(完全接受挑战者当前答案时才是 true)`,
    `   answer=<接受时填挑战者的答案原文,否则填你自己修正后的答案,一句话>`,
    `5. 输出必须分三段,段标题原样保留(面板按段折叠渲染):`,
    `   ## 结论摘要`,
    `   ## 详细论证`,
    `   ## 本轮变化`,
    `6. 各段内容:结论摘要=5 行内本轮立场 + 最关键的一条支撑/缺失;详细论证=逐条回应与修正后的主张全放这里;本轮变化=相对上一轮新增/让步/新缺口各一条,不要照抄本条要求。`,
  ].join('\n')
}

/** 组装挑战者 prompt:必须先钢人化复述,再开火。 */
export function buildChallengerPrompt(
  question: string,
  builderOutput: string,
  history: string,
  round: number,
  maxRounds: number,
  context = '',
): string {
  const ctxBlock = context.trim() !== '' ? `\n背景(前面会话已定:已验证的不再挑战,已决边界不重开;挑战须引用对方本场原文):\n${context.trim()}\n` : ''
  return [
    `你是挑战者(challenger)。任务:打穿建构者的对照,专找四类洞:`,
    `1) 没覆盖的维度 2) 没覆盖的场景(常态/峰值/异常/增长) 3) 没证据的断言 4) 自相矛盾的推理。`,
    `边界:你是被辩论链路调用的子 agent,首要产出是文本论证。不要调用任何 debate_* 工具(链路 already 在驱动你)。但你手里的文件读取/检索/shell/网络工具该用就用:挑战对方的事实断言时,优先用工具查证,用查到的原文打脸;查不到才标缺失。`,
    `找文件预算:用 glob/grep 找目标文件最多试 3 次,找不到就标"缺失(文件不在工作区)"然后基于对方原文继续挑战,不许无限翻目录。`,
    ``,
    `问题: ${question}`,
    ctxBlock,
    `当前第 ${round}/${maxRounds} 轮。`,
    history !== '' ? `此前历史摘要:\n${history}\n` : ``,
    `建构者上一轮输出:\n${builderOutput}`,
    ``,
    `要求:`,
    `1. 先钢人化复述:用自己的话复述对方最强的版本,复述不对本轮无效。`,
    `2. 每条挑战必须引用对方原文(标轮次),承认有道理的部分写进 concession。`,
    `3. 只接受对方当前答案时才置 agree=true;agree=true 却写新答案视为无效。`,
    `4. 禁用黑话(同建构者)。同时自报模型身份,格式:MODEL:<provider>/<model>;没有环境查询工具,不知道就写 MODEL:unknown,不许编造。`,
    `5. 停机信号:本段固定两行,单独成段放在最后,不要写进三段正文里(host 解析用,漏写会导致共识停机失效):`,
    `   agree=true/false`,
    `   answer=<你的当前答案,一句话;接受对方时填对方答案原文>`,
    `6. 输出必须分三段,段标题原样保留(面板按段折叠渲染):`,
    `   ## 结论摘要`,
    `   ## 详细论证`,
    `   ## 本轮变化`,
    `7. 各段内容:结论摘要=5 行内打掉/保住了哪几条 + 本轮是否让步;详细论证=钢人化复述 + 逐条挑战 + concession 全放这里;本轮变化=相对上一轮新增挑战/收回挑战/新缺口各一条,不要照抄本条要求。`,
  ].join('\n')
}

/** 组装制图员 prompt:只读实录,不参辩(ADR-0002/0006)。 */
export function buildSynthesizerPrompt(question: string, transcript: string): string {
  return [
    `你是制图员(synthesizer)。你没有参与前面的辩论,现在只读实录输出成果地图。`,
    `美德是忠实:不添油加醋,不磨平分歧,分歧如实保留。`,
    ``,
    `问题: ${question}`,
    ``,
    `辩论实录:`,
    `${transcript}`,
    ``,
    `输出五件套(严格按此结构,先引用原话再写归纳,每个归纳必须带[轮次引用],没有出处的格子填"缺失"):`,
    `格式铁律:一律用分级列表(数字/短横缩进短行),不许用 Markdown 表格——成果会原样贴进对话区,对话区不渲染表格,竖线只会糊成一坨。`,
    `1. 视角清单:每行"lens 名:核心主张"。`,
    `2. 论证:每条主张分四行——主张 / 支撑理由 / 反例 / 置信度。`,
    `3. 依据:每条断言分四行——断言 / 类型(事实/推理/价值) / 状态(已支撑/推断/缺失/矛盾) / 出处指针。`,
    `4. 分歧:先列已一致(短行),再列真不一致,每条注明事实分歧还是价值排序分歧。`,
    `5. 缺口:每行"缺什么 + 建议补法(查文档/跑测试/压测/找人确认)"。`,
  ].join('\n')
}

/** transcript 拼装(供制图员输入)。 */
export function renderTranscript(entries: TranscriptEntry[]): string {
  return entries.map((e) => `[R${e.round} #${e.seq} ${e.role}] ${e.text}`).join('\n\n')
}
