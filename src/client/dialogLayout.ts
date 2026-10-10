/**
 * 辩论窗口尺寸纯函数(无 DOM / 无副作用,可单元测试)。
 *
 * 照抄 explorer 的 popupLayout:手动宽高存 localStorage,双击恢复自动;
 * 渲染时钳制旧值(大显示器存的尺寸在小视口上不溢出)。
 * 差异:辩论框默认更大(要装实况流),下限更高;key 前缀 dshd。
 */

/** 自动/手动高度下限:保底装下标题栏 + 一块实况。 */
export const DIALOG_MIN_H = 360
/** 手动高度 localStorage key。 */
export const DIALOG_MANUAL_H_KEY = 'dshd.dialogH.v1'
/** 默认高度:标题栏 + 配置区 + ~10 行实况。 */
export const DIALOG_DEFAULT_H = 560
/** 手动宽度下限:再窄实况卡片没法看。 */
export const DIALOG_MIN_W = 360
/** 手动宽度 localStorage key。 */
export const DIALOG_MANUAL_W_KEY = 'dshd.dialogW.v1'
/** 默认宽度:沿用旧固定宽度 720。 */
export const DIALOG_DEFAULT_W = 720

/**
 * 手动高度钳制(拖拽中 / 渲染时用,顺手取整)。
 */
export function clampDialogHeight(h: number, top: number, vh: number, minH = DIALOG_MIN_H): number {
  const maxH = Math.max(minH, vh - top - 16)
  return Math.min(Math.max(minH, Math.round(h)), maxH)
}

/**
 * 读手动高度:无存储 / 非法值 / 无 window(node 单测)一律返回 null(回落默认高度)。
 */
export function loadManualHeight(key = DIALOG_MANUAL_H_KEY): number | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(key)
    if (raw == null || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * 写手动高度:null 清除(恢复默认);存储不可用时静默忽略。
 */
export function saveManualHeight(h: number | null, key = DIALOG_MANUAL_H_KEY): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    if (h == null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, String(Math.round(h)))
  } catch {
    /* 存储不可用时忽略,默认高度兜底 */
  }
}

/**
 * 手动宽度钳制(拖拽中 / 渲染时用,顺手取整)。
 * @param w - 拖拽目标宽度;右下拉手是右拉变宽(增量为正),与 explorer 左下拉手反号。
 * @param vw - 视口宽度;最大留 16px 边距。
 */
export function clampDialogWidth(w: number, vw: number, minW = DIALOG_MIN_W): number {
  const maxW = Math.max(minW, vw - 32)
  return Math.min(Math.max(minW, Math.round(w)), maxW)
}

/**
 * 读手动宽度:无存储 / 非法值 / 无 window(node 单测)一律返回 null(回落默认宽度)。
 */
export function loadManualWidth(key = DIALOG_MANUAL_W_KEY): number | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(key)
    if (raw == null || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * 写手动宽度:null 清除(恢复默认宽度);存储不可用时静默忽略。
 */
export function saveManualWidth(w: number | null, key = DIALOG_MANUAL_W_KEY): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    if (w == null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, String(Math.round(w)))
  } catch {
    /* 存储不可用时忽略,默认宽度兜底 */
  }
}

/**
 * 渲染时钳制已存的手动高度:localStorage 的旧值可能来自更大的视口,
 * 直接使用会溢出当前窗口。null 保持 null(回落默认高度)。
 */
export function clampStoredHeight(h: number | null, top: number, vh: number): number | null {
  return h == null ? null : clampDialogHeight(h, top, vh)
}

/** 渲染时钳制已存的手动宽度,逻辑同上。 */
export function clampStoredWidth(w: number | null, vw: number): number | null {
  return w == null ? null : clampDialogWidth(w, vw)
}
