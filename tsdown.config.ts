import { defineConfig } from 'tsdown'

// 入口为插件主文件；运行时 JS 输出到 lib/，声明文件输出到 lib/types/。
// 源码使用 NodeNext 风格的 .js 扩展名引用，tsdown 会自动解析到 .ts 源文件。
export default defineConfig({
  entry: ['src/index.ts'],
  tsconfig: 'tsconfig.build.json',
  format: ['esm'],
  outDir: 'lib',
  dts: true,
  clean: true,
})
