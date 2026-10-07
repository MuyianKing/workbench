// accent-color 与 design-styles 各有一套色值工具（mixHex / relativeLuminance）：数学一致但坏输入
// 契约不同（后者防御式返回原值、有测试锁定），不合并 —— TS 会把星号导出的重名报成错误（TS2308），
// 所以 accent-color 走显式清单、收下除那两个函数外的全部导出；它们的用点都在包内，
// 外界要色值工具就走 design-styles 的防御式版本。
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
  contrastRatio,
  inkOnAccent,
  sanitizeAccentColor,
  sanitizeAccentInkMode,
} from './accent-color'
export * from './app-name'
export * from './appearance'
export * from './card-opacity'
export * from './design-demo'
export * from './design-export'
export * from './design-styles'
export * from './terminal-dock'
export * from './terminal-height'
export * from './theme'
export * from './views'
export * from './wallpaper'
export * from './workspace-background'
