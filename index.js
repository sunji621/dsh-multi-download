/**
 * dsh-multi-download · DSH Host 插件入口
 *
 * 注册两个模型工具：
 *   - download_file：多线程（HTTP Range 分段并发）下载到本地文件
 *   - download_task：查询 / 取消 / 列出下载任务
 *
 * 设计取舍：不 import 任何 @deepseek-ai/* 包，只用 Node 内置能力（fetch + fs），
 * 因此无需 peerDependencies，也不受 asar 内包名解析影响。
 */
import { DEFAULTS, Downloader } from './lib/engine.js'
import { createTools } from './lib/tools.js'

export const name = 'dsh-multi-download'

/** 只用 tools 服务；不 inject 可选服务，避免装不上 */
export const inject = ['tools']

/**
 * @param {import('cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  if (!settings.baseDir && process.env.DSH_DOWNLOAD_DIR) {
    settings.baseDir = process.env.DSH_DOWNLOAD_DIR
  }
  const downloader = new Downloader(settings)
  for (const tool of createTools(downloader)) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-multi-download: tools.register(${tool.name})`)
  }
  ctx.logger?.info?.('dsh-multi-download 已就绪：download_file / download_task（默认 %d 连接）', settings.connections)
}
