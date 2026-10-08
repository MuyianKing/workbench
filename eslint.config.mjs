// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'app',
    /**
     * **vue 必须显式打开**：antfu 那套默认是从**当前工作目录**能不能 resolve 到 `vue` 来判的
     * （见它源码里的 `isPackageExists('vue')`），而这个仓库的 vue 在 `apps/desktop` 里 ——
     * 从根目录跑 `pnpm run lint`（脚本的 cwd 就是根）它探不到，于是 `.vue` 一个都不匹配
     * （报 "File ignored because no matching configuration was supplied"）、
     * 而下面那条全局的 `vue/*` 规则又会因为找不到 vue 插件直接把整次 lint 打挂。
     */
    vue: true,
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
      /**
       * 生成物不进 lint：`packages/ai/src/ai-builtin-models.generated.ts` 是
       * `scripts/vendor-pi.mjs` 从内置 Pi 的模型目录现生成的（一整张压成一行的 JSON 表，
       * 两万九千条 style 报错全出自它）。它跟着文件名末尾的 `.generated` 认，
       * 重跑 `pnpm run vendor:pi` 会被整份覆盖 —— 改它不是「改代码」。
       */
      '**/*.generated.ts',
    ],
  },
  {
    rules: {
      // 事件名沿用项目的 kebab-case 约定（update:instruction / add-images 这类）
      'vue/custom-event-name-casing': ['error', 'kebab-case'],
      /**
       * 模板里用到的组件必须在脚本里 import（`el-*` / `El*` 那几个是 app.use(ElementPlus)
       * 全局注册的，放过）。少一行 import 时 **vue-tsc 与 vite build 都不报错** ——
       * 那个标签会被当成认不出的元素渲染成空，现象是「按钮在、点下去什么都没发生」，
       * 2026-10 在密码页的「分组设置」弹框上踩过一次。
       */
      'vue/no-undef-components': ['error', { ignorePatterns: ['^(el|El)'] }],
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
