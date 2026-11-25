import { describe, expect, it } from 'vitest'
import { NOTE_PAGE_SIZE_DEFAULT, notePageSizeCss, sanitizeNotePageSize } from './page-size'

describe('sanitizeNotePageSize', () => {
  it('缺项与坏值都回默认 A4', () => {
    expect(sanitizeNotePageSize(undefined)).toBe('A4')
    expect(sanitizeNotePageSize(null)).toBe('A4')
    expect(sanitizeNotePageSize('')).toBe('A4')
    expect(sanitizeNotePageSize('B5')).toBe('A4')
    expect(sanitizeNotePageSize(42)).toBe('A4')
    expect(NOTE_PAGE_SIZE_DEFAULT).toBe('A4')
  })

  it('认得 A4 与 Letter，大小写与两端空白都收敛', () => {
    expect(sanitizeNotePageSize('A4')).toBe('A4')
    expect(sanitizeNotePageSize(' letter ')).toBe('Letter')
    expect(sanitizeNotePageSize('Letter')).toBe('Letter')
  })
})

describe('notePageSizeCss', () => {
  it('两种纸张各有 @page size 与相称的容器宽度', () => {
    expect(notePageSizeCss('A4')).toEqual({ atPage: 'A4', maxWidth: '730px' })
    expect(notePageSizeCss('Letter')).toEqual({ atPage: 'Letter', maxWidth: '752px' })
  })
})
