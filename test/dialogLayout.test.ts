import { describe, expect, it } from 'vitest'
import { clampDialogHeight, clampDialogWidth, clampStoredHeight, clampStoredWidth, loadManualHeight, loadManualWidth, saveManualHeight, saveManualWidth } from '../src/client/dialogLayout'

describe('clampDialogHeight', () => {
  it('rounds and clamps the manual height into range', () => {
    // vh=800,top=48 -> maxH=736
    expect(clampDialogHeight(500.6, 48, 800)).toBe(501)
    expect(clampDialogHeight(10, 48, 800)).toBe(360)
    expect(clampDialogHeight(5000, 48, 800)).toBe(736)
  })
})

describe('manual height storage', () => {
  it('is a safe no-op without window (node env)', () => {
    expect(loadManualHeight()).toBe(null)
    expect(() => saveManualHeight(500)).not.toThrow()
    expect(() => saveManualHeight(null)).not.toThrow()
  })
})

describe('clampDialogWidth', () => {
  it('rounds and clamps the manual width into range', () => {
    expect(clampDialogWidth(400.6, 1280)).toBe(401)
    expect(clampDialogWidth(100, 1280)).toBe(360)
    expect(clampDialogWidth(5000, 1280)).toBe(1248)
  })

  it('never goes below min even when the viewport is tiny', () => {
    expect(clampDialogWidth(200, 300)).toBe(360)
  })
})

describe('manual width storage', () => {
  it('is a safe no-op without window (node env)', () => {
    expect(loadManualWidth()).toBe(null)
    expect(() => saveManualWidth(400)).not.toThrow()
    expect(() => saveManualWidth(null)).not.toThrow()
  })
})

describe('clampStoredHeight/clampStoredWidth', () => {
  it('passes null through (falls back to default size)', () => {
    expect(clampStoredHeight(null, 48, 800)).toBe(null)
    expect(clampStoredWidth(null, 1280)).toBe(null)
  })

  it('clamps a stale oversized value into the current viewport', () => {
    expect(clampStoredHeight(2000, 48, 800)).toBe(736)
    expect(clampStoredWidth(2000, 1280)).toBe(1248)
  })

  it('keeps an in-range stored value intact', () => {
    expect(clampStoredHeight(500, 48, 800)).toBe(500)
    expect(clampStoredWidth(400, 1280)).toBe(400)
  })
})
