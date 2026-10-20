import { describe, expect, it } from 'vitest'
import { ANNOTATION_TOOLS, MOSAIC_BLOCK_DEFAULT, STROKE_WIDTH_DEFAULT, TEXT_SIZE_DEFAULT } from './palette'
import { defaultToolStyle, defaultToolStyles } from './tool-style'

describe('tool-style', () => {
  it('默认档位就是最小一档（细 / 小 / 小）', () => {
    expect(STROKE_WIDTH_DEFAULT).toBe(2)
    expect(MOSAIC_BLOCK_DEFAULT).toBe(6)
    expect(TEXT_SIZE_DEFAULT).toBe(16)

    const style = defaultToolStyle()
    expect(style.strokeWidth).toBe(STROKE_WIDTH_DEFAULT)
    expect(style.block).toBe(MOSAIC_BLOCK_DEFAULT)
    expect(style.textSize).toBe(TEXT_SIZE_DEFAULT)
  })

  it('每个工具各一份，改一个不带上别的', () => {
    const styles = defaultToolStyles()
    expect(Object.keys(styles).sort()).toEqual(ANNOTATION_TOOLS.map(item => item.tool).sort())

    styles.rect.strokeWidth = 8
    expect(styles.arrow.strokeWidth).toBe(STROKE_WIDTH_DEFAULT)
  })
})
