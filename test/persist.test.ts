import { describe, expect, it } from 'vitest'
import {
  fromRecord,
  markInterrupted,
  RECORD_VERSION,
  renderReport,
  reportRelPath,
  REPORT_DIR,
  slugify,
  STORAGE_UNIT,
  toRecord,
  type PersistableSession,
  type ReportInput,
} from '../src/persist'
import type { DebateConfig, DebateRound, TranscriptEntry } from '../src/debate'

const cfg = (): DebateConfig => ({
  builder: { provider: 'p', model: 'm' },
  challenger: { provider: 'p', model: 'm' },
  synthesizer: { provider: 'p', model: 'm' },
  maxRounds: 5,
  targetCwd: 'D:\\work\\proj',
  auto: { question: '该不该上 K8s?', questionType: 'selection', lenses: ['a', 'b'], context: '' },
})

const mkSession = (over: Partial<PersistableSession> = {}): PersistableSession => ({
  id: 'debate-abc-1',
  config: cfg(),
  status: 'done',
  round: 3,
  transcript: [],
  map: null,
  mapText: null,
  error: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  progress: '已完成',
  mirrorCount: 7,
  mirrorError: null,
  parentSid: 'sid-1',
  stopReason: 'convergence',
  rounds: [],
  mode: 'resident',
  residentError: null,
  decisionSummary: '## 决策摘要\n上。',
  reportRel: null,
  ...over,
})

describe('记录白名单(toRecord)', () => {
  it('只搬白名单字段:进程内瞬时态(streaming/mirrorToChat/flush)一律不落盘', () => {
    const live = {
      ...mkSession(),
      streaming: { builder: { round: 1, kind: 'text', text: '半句' } },
      mirrorToChat: true,
      flush: () => {},
    }
    const rec = toRecord(live as unknown as PersistableSession)
    expect('streaming' in rec).toBe(false)
    expect('mirrorToChat' in rec).toBe(false)
    expect('flush' in rec).toBe(false)
    expect(rec.v).toBe(RECORD_VERSION)
  })

  it('显式补 v:磁盘上的每条记录都带格式版本,升级时才判断得出能不能读', () => {
    expect(toRecord(mkSession()).v).toBe(RECORD_VERSION)
  })
})

describe('记录往返(toRecord → fromRecord)', () => {
  it('关键字段逐项保真', () => {
    const rounds: DebateRound[] = [{
      round: 1, builderAnswer: 'A', builderAgree: false, challengerAnswer: 'B', challengerAgree: false,
      hasNewInfo: true, builderRelayChars: 100, protoVersion: 4, pendingItems: ['x'],
      quoteAudit: { quotableLines: 4, quotedLines: 2, hitLines: [1], hitRate: 0.5 },
    }]
    const tr: TranscriptEntry[] = [{ seq: 1, role: 'builder', round: 1, text: 'hi' }]
    const rec = toRecord(mkSession({ rounds, transcript: tr, reportRel: 'docs/debates/x.md' }))
    const back = fromRecord(rec)
    expect(back).not.toBeNull()
    expect(back?.id).toBe('debate-abc-1')
    expect(back?.config.auto?.question).toBe('该不该上 K8s?')
    expect(back?.stopReason).toBe('convergence')
    expect(back?.rounds[0]?.pendingItems).toEqual(['x'])
    expect(back?.rounds[0]?.quoteAudit.hitRate).toBe(0.5)
    expect(back?.transcript[0]?.text).toBe('hi')
    expect(back?.reportRel).toBe('docs/debates/x.md')
    expect(back?.mode).toBe('resident')
  })

  it('JSON 往返(过一遍序列化)后仍然等价——真实路径就是这样存的', () => {
    const rec = toRecord(mkSession())
    expect(fromRecord(JSON.parse(JSON.stringify(rec)))).toEqual(rec)
  })
})

describe('坏记录不拖垮整表(fromRecord)', () => {
  it.each([
    ['不是对象', 42],
    ['null', null],
    ['数组', []],
    ['没有 id', { v: 1, config: cfg() }],
    ['id 不是字符串', { v: 1, id: 7, config: cfg() }],
    ['没有 config', { v: 1, id: 'x' }],
    ['config.builder 不是对象', { v: 1, id: 'x', config: { challenger: {}, maxRounds: 3 } }],
    ['版本号 0(非法)', { v: 0, id: 'x', config: cfg() }],
    ['版本号超前(未来格式)', { v: RECORD_VERSION + 1, id: 'x', config: cfg() }],
    ['版本号缺失', { id: 'x', config: cfg() }],
  ])('拒绝:%s', (_name, raw) => {
    expect(fromRecord(raw)).toBeNull()
  })

  it('次要字段缺失一律补默认值:多恢复一局胜过少恢复一局', () => {
    const back = fromRecord({ v: 1, id: 'x', config: cfg() })
    expect(back).not.toBeNull()
    expect(back?.transcript).toEqual([])
    expect(back?.rounds).toEqual([])
    expect(back?.status).toBe('stopped')
    expect(back?.mode).toBe('oneShot')
    expect(back?.mapText).toBeNull()
    expect(back?.reportRel).toBeNull()
    expect(back?.stopReason).toBeNull()
  })

  it('stopReason 只认已知取值:脏值降级为 null,而不是把脏值透给下游', () => {
    expect(fromRecord({ v: 1, id: 'x', config: cfg(), stopReason: 'weird' })?.stopReason).toBeNull()
    expect(fromRecord({ v: 1, id: 'x', config: cfg(), stopReason: 'manual' })?.stopReason).toBe('manual')
  })
})

describe('恢复后的收尾(markInterrupted)', () => {
  it('running 的局标成 stopped 并写明原因——显示"还在跑"而实际永不动最糟', () => {
    const out = markInterrupted(toRecord(mkSession({ status: 'running', progress: '第 2 轮' })), '宿主重启,已中断')
    expect(out.status).toBe('stopped')
    expect(out.progress).toBe('宿主重启,已中断')
  })

  it('已完成/失败的局原样不动(它们本来就不该被改写)', () => {
    const done = toRecord(mkSession({ status: 'done' }))
    expect(markInterrupted(done, 'x')).toEqual(done)
    const failed = toRecord(mkSession({ status: 'failed' }))
    expect(markInterrupted(failed, 'x')).toEqual(failed)
  })
})

describe('文件名安全(slugify / reportRelPath)', () => {
  it('单元名必须匹配 UNIT_NAME_RE:用下划线不用连字符', () => {
    expect(STORAGE_UNIT).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('清掉 Windows 非法字符与路径分隔符', () => {
    const s = slugify('a/b\\c:d*e?f"g<h>i|j')
    expect(s).not.toMatch(/[\\/:*?"<>|]/)
  })

  it('空白折成单个连字符,首尾不留连字符/点/空格;问号是非法文件名字符,清掉而不是保留', () => {
    const s = slugify('  该不该   上 K8s?  ')
    expect(s).toBe('该不该-上-K8s')
    expect(s.startsWith('-')).toBe(false)
    expect(s.endsWith('-')).toBe(false)
    expect(slugify('...trailing...')).toBe('trailing')
  })

  it('中文保留(问题多半是中文,换成拼音只会更难认)', () => {
    expect(slugify('该不该上 K8s')).toContain('该不该上')
  })

  it('按码点截断:不把代理对劈成两半', () => {
    const s = slugify('🚀'.repeat(60))
    expect(Array.from(s).length).toBe(40)
    expect(s).not.toContain('\ufffd')
  })

  it('清空或全非法字符时回落 debate,不产出空文件名', () => {
    expect(slugify('')).toBe('debate')
    expect(slugify('///***')).toBe('debate')
    expect(slugify('   ')).toBe('debate')
  })

  it('路径形状固定:docs/debates/<日期>-<slug>-<id尾>.md', () => {
    const p = reportRelPath(1_700_000_000_000, '该不该上 K8s?', 'debate-abc123-7')
    expect(p.startsWith(`${REPORT_DIR}/`)).toBe(true)
    expect(p.endsWith('.md')).toBe(true)
    expect(p.split('/').length).toBe(3)
    expect(p).toMatch(/^docs\/debates\/\d{4}-\d{2}-\d{2}-.+-[a-zA-Z0-9]{6}\.md$/)
  })

  it('同一问题不同局不互相覆盖(文件名带 id 尾)', () => {
    const a = reportRelPath(1, 'q', 'debate-aaa111-1')
    const b = reportRelPath(1, 'q', 'debate-bbb222-2')
    expect(a).not.toBe(b)
  })

  it('确定性:同输入同输出,不掺时间/随机', () => {
    expect(reportRelPath(1_700_000_000_000, 'q', 'debate-abc123-7'))
      .toBe(reportRelPath(1_700_000_000_000, 'q', 'debate-abc123-7'))
  })

  it('文件名部分不含非法字符(整段检查,不只检查 slug)', () => {
    const base = reportRelPath(Date.now(), 'a/b\\c:d*e?f"g<h>i|j\n换行', 'debate-xyz789-3').split('/').pop() ?? ''
    expect(base).not.toMatch(/[\\/:*?"<>|]/)
    expect(base.endsWith('.')).toBe(false)
    expect(base.endsWith(' ')).toBe(false)
  })
})

describe('结论文档渲染(renderReport)', () => {
  const rounds: DebateRound[] = [{
    round: 1, builderAnswer: 'A|含竖线', builderAgree: true, challengerAnswer: 'B', challengerAgree: false,
    hasNewInfo: true, builderRelayChars: 10, protoVersion: 4, pendingItems: null,
    quoteAudit: { quotableLines: 0, quotedLines: 0, hitLines: [], hitRate: null },
  }]
  const input = (over: Partial<ReportInput> = {}): ReportInput => ({
    id: 'debate-abc-1',
    question: '该不该上 K8s?',
    questionType: 'selection',
    lenses: ['a', 'b'],
    targetCwd: 'D:\\work\\proj',
    createdAt: 1_700_000_000_000,
    finishedAt: 1_700_000_600_000,
    status: 'done',
    error: null,
    stopReason: 'convergence',
    maxRounds: 5,
    decisionSummary: '## 决策摘要\n上,分两期。',
    mapText: '## 成果地图\n- 视角:成本',
    rounds,
    transcript: [{ seq: 1, role: 'builder', round: 1, text: '正文' }],
    generator: 'dsh-debate v0.5.0',
    stopText: '共识收敛(第 1 轮双方 agree 同一答案)',
    ...over,
  })

  it('先结论后细节:决策摘要排在成果地图与全文之前', () => {
    const md = renderReport(input())
    expect(md.indexOf('## 决策摘要')).toBeLessThan(md.indexOf('## 成果地图'))
    expect(md.indexOf('## 成果地图')).toBeLessThan(md.indexOf('## 每轮判定'))
    expect(md.indexOf('## 每轮判定')).toBeLessThan(md.indexOf('## 全文交锋记录'))
  })

  it('元信息表带齐局 id/题型/工作区/停机/生成版本', () => {
    const md = renderReport(input())
    expect(md).toContain('debate-abc-1')
    expect(md).toContain('selection · 2 视角')
    expect(md).toContain('共识收敛')
    expect(md).toContain('dsh-debate v0.5.0')
    expect(md).toContain('10 分钟')
  })

  it('表格单元里的竖线被转义:否则会撕裂表格', () => {
    const md = renderReport(input())
    expect(md).toContain('A\\|含竖线')
    // 转义后每张表的数据行分隔符数量仍然正确(不出现多出来的裸竖线)。
    const row = md.split('\n').find((l) => l.startsWith('| R1 '))
    expect(row).toBeDefined()
  })

  it('正文里的 </details> 被中和:否则会把外层折叠块提前关掉', () => {
    const md = renderReport(input({
      transcript: [{ seq: 1, role: 'builder', round: 1, text: 'a</details>b' }],
    }))
    expect(md).not.toContain('a</details>b')
    expect(md).toContain('<\\/details>')
  })

  it('没跑到制图就收尾时,明确写"没有成果地图"而不是留白', () => {
    const md = renderReport(input({ mapText: null, stopReason: 'maxRounds', stopText: '跑满上限(5 轮)' }))
    expect(md).toContain('没有成果地图')
  })

  it('没有决策摘要也没有判定数据时不假装有结论', () => {
    const md = renderReport(input({ decisionSummary: null, rounds: [], transcript: [] }))
    expect(md).toContain('未产出决策摘要')
    expect(md).toContain('没有交锋记录')
  })

  it('全文进折叠块并标出字数,方便按需下钻', () => {
    const md = renderReport(input())
    expect(md).toContain('<details><summary>')
    expect(md).toContain('builder')
    expect(md).toContain('正文')
  })
})
