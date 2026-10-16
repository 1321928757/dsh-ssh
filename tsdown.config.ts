import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from './node_modules/.pnpm/lightningcss@1.33.0/node_modules/lightningcss/node/index.js'
import { defineConfig } from 'tsdown'

const CLIENT_LOADER_ID = '@dsh-session-ssh/ssh'
const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))
const CSS_PREFIX = '\0dsh-session-ssh-css:'
const CSS_SUFFIX = '.mjs'
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    // Keep declarations emitted by `tsc -b` in lib/types; cleaning the shared
    // output directory would delete them before the package is installed.
    clean: false,
    outDir: 'lib',
    outExtensions: () => ({ js: '.js' }),
    external: [/^@deepseek-ai\//, 'react', 'react-dom'],
  },
  {
    // DSH's browser loader evaluates this artifact as a classic script and
    // expects it to register a lazy CommonJS-style factory on __ModuleLoader__.
    entry: { client: 'src/client/index.ts' },
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    clean: false,
    outDir: 'lib',
    outExtensions: () => ({ js: '.js' }),
    external: [...CLIENT_EXTERNALS],
    noExternal: (id: string) => CLIENT_EXTERNALS.includes(id as (typeof CLIENT_EXTERNALS)[number]) ? undefined : true,
    plugins: [{
      name: 'dsh-session-ssh-css-modules',
      resolveId(source: string, importer?: string) {
        if (!source.endsWith('.module.css')) return null
        const physical = importer === undefined ? source : resolvePath(dirname(importer), source)
        const repositoryPath = relative(REPOSITORY_ROOT, physical).split(sep).join('/')
        return CSS_PREFIX + repositoryPath + CSS_SUFFIX
      },
      async load(id: string) {
        if (!id.startsWith(CSS_PREFIX)) return null
        const repositoryPath = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
        const physical = resolvePath(REPOSITORY_ROOT, repositoryPath)
        const source = await readFile(physical)
        const result = transform({
          filename: repositoryPath,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name]))
        const tagId = `dsh-session-ssh/${basename(repositoryPath)}`
        return [
          `const css = ${JSON.stringify(result.code.toString())};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
          '  const tag = document.createElement("style");',
          '  tag.dataset.plugin = "@dsh-session-ssh/ssh";',
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `module.exports = ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    }],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_LOADER_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
