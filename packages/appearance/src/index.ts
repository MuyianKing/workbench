// 色值工具全包只有一份（./color.ts）：主题色派生与设计参考库共用，契约是「只认带 # 的 hex、
// 坏输入不抛错」（mixHex 原样回第一个值、亮度按 0）。
export {
  ACCENT_COLOR_DEFAULT,
  ACCENT_INK_DEFAULT,
  ACCENT_INK_MODES,
  ACCENT_PRESETS,
  ACCENT_VARIABLE_NAMES,
  type AccentInkMode,
  type AccentVariableName,
  type AccentVariables,
  accentVariables,
  inkOnAccent,
  sanitizeAccentColor,
  sanitizeAccentInkMode,
} from './accent-color'
export * from './app-name'
export * from './appearance'
export * from './card-opacity'
export * from './color'
export * from './design-demo'
export * from './design-export'
export * from './design-styles'
export * from './sync-config'
export * from './terminal-dock'
export * from './terminal-height'
export * from './theme'
export * from './video-float'
export * from './views'
export * from './wallpaper'
export * from './workspace-background'
