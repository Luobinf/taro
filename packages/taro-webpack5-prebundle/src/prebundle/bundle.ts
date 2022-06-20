import swc from '@swc/core'
import { REG_SCRIPTS } from '@tarojs/helper'
import { init, parse } from 'es-module-lexer'
import esbuild, { Plugin } from 'esbuild'
import fs from 'fs-extra'
import path from 'path'
import Chain from 'webpack-chain'

import {
  externalModule,
  flattenId,
  getDefines,
  getHash,
  getResolve
} from '../utils'
import { assetsRE, CollectedDeps } from '../utils/constant'

type ExportsData = ReturnType<typeof parse> & { hasReExports?: boolean, needInterop?: boolean }

// esbuild generates nested directory output with lowest common ancestor base
// this is unpredictable and makes it difficult to analyze entry / output
// mapping. So what we do here is:
// 1. flatten all ids to eliminate slash
// 2. in the plugin, read the entry ourselves as virtual files to retain the
//    path.
export async function bundle (
  appPath: string,
  deps: CollectedDeps,
  chain: Chain,
  prebundleOutputDir: string,
  customEsbuildConfig: Record<string, any> = {}
) {
  await init

  const flattenDeps: CollectedDeps = new Map()
  const flatIdExports = new Map<string, ExportsData>()

  for (const [id, dep] of deps.entries()) {
    // flatten id
    const flatId = flattenId(id)
    flattenDeps.set(flatId, dep)
    // Use es-module-lexer to check ES exports
    // But "export * from" syntax should be checked alone
    const fileContent = fs.readFileSync(dep, 'utf-8')
    const exportsData: ExportsData = parse(fileContent)
    for (const { ss, se } of exportsData[0]) {
      const exp = fileContent.slice(ss, se)
      if (/export\s+\*\s+from/.test(exp)) {
        exportsData.hasReExports = true
      }
    }
    flatIdExports.set(flatId, exportsData)
  }

  // bundle deps
  const entryPlugin = getEntryPlugin({
    flattenDeps, flatIdExports, prebundleOutputDir
  })
  const customPlugins = customEsbuildConfig.plugins || []

  fs.existsSync(prebundleOutputDir)
    ? fs.emptyDirSync(prebundleOutputDir)
    : fs.ensureDirSync(prebundleOutputDir)

  const result = await esbuild.build({
    absWorkingDir: appPath,
    bundle: true,
    entryPoints: Array.from(flattenDeps.keys()),
    mainFields: ['main:h5', 'browser', 'module', 'jsnext:main', 'main'],
    format: 'esm',
    define: {
      ...getDefines(chain),
      // AMD 被 esbuild 转 ESM 后，是套着 ESM 外皮的 AMD 语法模块。
      // Webpack HarmonyDetectionParserPlugin 会阻止 AMDDefineDependencyParserPlugin 对这些模块的处理。
      // 导致这些模块报错（如 lodash）。目前的办法是把 define 置为 false，不支持 AMD 导出。
      define: 'false'
    },
    splitting: true,
    metafile: true,
    ignoreAnnotations: true,
    outdir: prebundleOutputDir,
    plugins: [
      entryPlugin,
      ...customPlugins
    ]
  })

  // esbuild 把 Commonjs 转 ESM 时，打包后只有 export default 语句，
  // 无法实现原模块 module.exports = 的功能。
  // 因此使用一个 CommonJS 规范的中间模块进行处理。
  const processAll: Promise<void>[] = []
  const metaOutput = result.metafile.outputs

  for (const outputName in metaOutput) {
    const output = metaOutput[outputName]

    if (!output.entryPoint?.startsWith('entry:')) continue

    const entry = output.entryPoint.replace(/^entry:/, '')
    if (!flatIdExports.has(entry)) continue

    const exportsData = flatIdExports.get(entry)
    if (
      exportsData?.needInterop &&
      output.exports.length === 1 &&
      output.exports[0] === 'default'
    ) {
      const srcPath = path.join(appPath, outputName)
      const destPath = path.join(appPath, outputName.replace(/(\.js)$/, '.core$1'))
      const p = fs.move(srcPath, destPath)
        .then(() => fs.writeFile(
          srcPath,
          `const m = require('./${path.basename(destPath)}')
module.exports = m.default
exports.default = module.exports
`
        ))

      processAll.push(p)
    }
  }

  await Promise.all(processAll)

  return {
    metafile: result.metafile
  }
}

function getEntryPlugin ({
  flattenDeps,
  flatIdExports,
  prebundleOutputDir,
  target
}: {
  flattenDeps: CollectedDeps
  flatIdExports: Map<string, ExportsData>
  prebundleOutputDir: string
  target?: swc.JscTarget
}): Plugin {
  const resolve = getResolve()
  return {
    name: 'entry',
    setup (build) {
      // assets
      build.onResolve({ filter: assetsRE }, async ({ path: id, resolveDir }) => {
        const filePath = path.isAbsolute(id) ? id : path.join(resolveDir, id)
        const fileExt = path.extname(filePath)
        const fileBasename = path.basename(filePath, fileExt)
        const fileContent = await fs.readFile(filePath)

        const outputFile = path.join(prebundleOutputDir, `${fileBasename}-${getHash(filePath)}${fileExt}`)
        await fs.writeFile(outputFile, fileContent)
        return externalModule({ path: `./${path.relative(prebundleOutputDir, outputFile)}` })
      })

      build.onResolve({ filter: /^[\w@][^:]/ }, async ({ path: id, importer }) => {
        // entry
        if (!importer && flattenDeps.has(id)) {
          return {
            path: id,
            namespace: 'entry'
          }
        }

        const resolvedPath = await resolve(path.dirname(importer), id)
        if (assetsRE.test(resolvedPath)) {
          return externalModule({ path: id })
        } else {
          return {
            path: resolvedPath
          }
        }
      })

      target && build.onLoad({ filter: REG_SCRIPTS }, async ({ path }) => {
        const result = await swc.transform(
          fs.readFileSync(path, 'utf-8'), {
            jsc: { target }
          })
        return { contents: result.code }
      })

      build.onLoad({ filter: /^[\w@][^:]/, namespace: 'entry' }, async ({ path: id }) => {
        let js = ''
        const filePath = flattenDeps.get(id)?.replace(/\\/g, '\\\\')
        const exportsData = flatIdExports.get(id)!
        const [importsList, exportsList] = exportsData
        const hasReExports = exportsData.hasReExports

        if (!importsList.length && !exportsList.length) {
          /** CommonJS */
          exportsData.needInterop = true
          js = `module.exports = require("${filePath}")`
        } else {
          /** ESM */
          if (exportsList.includes('default')) {
            // export default
            js += `import d from "${filePath}";export default d;`
          }
          if (
            hasReExports ||
            exportsList.length > 1 ||
            exportsList[0] !== 'default'
          ) {
            // export * from 'xx'
            // export const xx
            js += `export * from "${filePath}";`
          }
        }

        // console.log('\n[debug] found entry: ', id)
        // console.log('[debug]: filePath', filePath)
        // console.log('[debug] importsData: ', flatIdExports.get(id))
        // console.log('[debug] js: ', js)

        return {
          loader: 'js',
          contents: js,
          resolveDir: process.cwd()
        }
      })
    }
  }
}
