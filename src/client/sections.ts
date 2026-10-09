/**
 * dsh-debate — 面板实录分段(纯函数,与 React/CSS 无关,可单测)。
 *
 * 三段标题原样保留(host prompt 第 5 条强制),面板按段折叠渲染:
 * 结论摘要默认展开,详细论证/变化默认折叠。
 * 制图员的五件套没有三段标题,整段原样走 rest。
 */
export interface TurnSections {
  summary: string
  detail: string
  delta: string
  /** 非三段正文(制图员五件套等):整段原样展示,不进分段。 */
  rest: string
}

/** 实录分段:结论摘要默认展开,详细论证/变化默认折叠(可读性第一步)。 */
export function splitSections(text: string): TurnSections {
  const pick = (re: RegExp): string => {
    const m = text.match(re)
    return m ? m[1].trim() : ''
  }
  const summary = pick(/##\s*结论摘要([\s\S]*?)(?=##\s*(详细论证|本轮变化)|$)/)
  const detail = pick(/##\s*详细论证([\s\S]*?)(?=##\s*本轮变化|$)/)
  const delta = pick(/##\s*本轮变化([\s\S]*?)$/)
  const hasAny = summary !== '' || detail !== '' || delta !== ''
  return { summary, detail, delta, rest: hasAny ? '' : text }
}
