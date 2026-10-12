import { describe, expect, it } from 'vitest'
import { CAPTURE_HOTKEY_DEFAULT, CAPTURE_PIN_OPACITY_DEFAULT, PIN_THROUGH_HOTKEY_DEFAULT, sanitizeCaptureHotkey, sanitizeCaptureMagnifier, sanitizeCapturePinOpacity, sanitizeCaptureSaveDir } from './settings'

describe('sanitizeCaptureHotkey', () => {
  it('去空白', () => {
    expect(sanitizeCaptureHotkey('  F1  ', CAPTURE_HOTKEY_DEFAULT)).toBe('F1')
  })

  it('空 / 非字符串 / 全空白回默认', () => {
    expect(sanitizeCaptureHotkey('', CAPTURE_HOTKEY_DEFAULT)).toBe(CAPTURE_HOTKEY_DEFAULT)
    expect(sanitizeCaptureHotkey('   ', CAPTURE_HOTKEY_DEFAULT)).toBe(CAPTURE_HOTKEY_DEFAULT)
    expect(sanitizeCaptureHotkey(undefined, PIN_THROUGH_HOTKEY_DEFAULT)).toBe(PIN_THROUGH_HOTKEY_DEFAULT)
    expect(sanitizeCaptureHotkey(42, CAPTURE_HOTKEY_DEFAULT)).toBe(CAPTURE_HOTKEY_DEFAULT)
  })
})

describe('sanitizeCaptureSaveDir', () => {
  it('去首尾空白与末尾分隔符', () => {
    expect(sanitizeCaptureSaveDir('  D:\\shots\\  ')).toBe('D:\\shots')
    expect(sanitizeCaptureSaveDir('D:/shots/')).toBe('D:/shots')
  })

  it('盘根留住分隔符', () => {
    expect(sanitizeCaptureSaveDir('C:\\')).toBe('C:\\')
    expect(sanitizeCaptureSaveDir('C:/')).toBe('C:/')
  })

  it('空 / 非字符串回空串（= 未设置）', () => {
    expect(sanitizeCaptureSaveDir('')).toBe('')
    expect(sanitizeCaptureSaveDir(null)).toBe('')
    expect(sanitizeCaptureSaveDir('   ')).toBe('')
  })
})

describe('sanitizeCapturePinOpacity / sanitizeCaptureMagnifier', () => {
  it('透明度越界夹回区间、认不出的回默认', () => {
    expect(sanitizeCapturePinOpacity(5)).toBe(20)
    expect(sanitizeCapturePinOpacity(150)).toBe(100)
    expect(sanitizeCapturePinOpacity('80')).toBe(CAPTURE_PIN_OPACITY_DEFAULT)
  })

  it('放大镜只有显式 false 才关', () => {
    expect(sanitizeCaptureMagnifier(undefined)).toBe(true)
    expect(sanitizeCaptureMagnifier(false)).toBe(false)
  })
})
