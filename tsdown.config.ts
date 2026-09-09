import { defineConfig, type UserConfig } from 'tsdown'

/**
 * 数据库驱动是**可选依赖**：运行时用变量说明符 `await import(spec)` 动态加载，
 * 本地与用户环境里都可能没有这两个包。声明 external，打包器就不会尝试解析它们。
 */
const OPTIONAL_DRIVERS = ['mysql2', 'mysql2/promise', 'pg']

// 主机半身：入口为插件主文件；运行时 JS 输出到 lib/，声明文件输出到 lib/types/。
// 源码使用 NodeNext 风格的 .js 扩展名引用，tsdown 会自动解析到 .ts 源文件。
// 两个产物并行构建且共用 lib/，因此谁都不能开 `clean`：清理统一由
// `prebuild` 脚本完成（否则后跑的那个会把前一个的 clean 目标删掉）。
const host: UserConfig = {
  entry: ['src/index.ts'],
  tsconfig: 'tsconfig.build.json',
  format: ['esm'],
  outDir: 'lib',
  dts: true,
  clean: false,
  external: OPTIONAL_DRIVERS,
}

/**
 * 平台为浏览器 bundle 预置的 seed 词（`packages/client/web/src/platform.ts`）。
 * 这些说明符运行时由模块表提供，打包时必须保持 external；其余依赖全部内联，
 * 否则打包产物会 require 一个模块表答不出来的名字。
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const isPlatformModule = (specifier: string): boolean => PLATFORM_MODULES.includes(specifier)

/**
 * 浏览器半身：CJS 工厂包，注册到 `window.__ModuleLoader__`（与 dsh 的 client
 * bundle 契约一致）。`clean` 必须为 false，否则会清掉上面主机半身的产物。
 */
const client: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: true,
  // `react` 是浏览器模块表的 seed 词，本地没有可解析的包：直接声明 external，
  // 免得打包器把它当成「未解析依赖」报警。
  external: PLATFORM_MODULES,
  deps: {
    neverBundle: isPlatformModule,
    alwaysBundle: (specifier: string) => !isPlatformModule(specifier),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('dsh-lh-data')}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
