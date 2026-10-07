// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'app',
    markdown: false,
    jsonc: false,
    yaml: false,
    ignores: [
      'site/**',
      'apps/desktop/resources/**',
      'apps/desktop/src-tauri/**',
      'apps/desktop/scripts/**',
      '**/.preview/**',
      '**/out/**',
    ],
  },
  {
    rules: {
      // 事件名沿用项目的 kebab-case 约定（update:instruction / add-images 这类）
      'vue/custom-event-name-casing': ['error', 'kebab-case'],
      // 终端 ANSI 解析、文件名清理的正则里控制字符与冷僻区间是有意写的，不动语义
      'no-control-regex': 'off',
      'regexp/no-unused-capturing-group': 'off',
      'regexp/no-obscure-range': 'off',
      'regexp/no-super-linear-backtracking': 'off',
      'regexp/no-contradiction-with-assertion': 'off',
      'regexp/no-dupe-disjunctions': 'off',
      // while ((match = re.exec(x)) !== null) 是惯用的正则扫描写法
      'no-cond-assign': ['error', 'except-parens'],
      // 常量声明在使用之后（函数体内引用，模块初始化顺序有保证）
      'ts/no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
    },
  },
  {
    // 测试桩照着 Rust Err(String) 的契约 reject 字符串，不算错误
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'prefer-promise-reject-errors': 'off',
    },
  },
)
