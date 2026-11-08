/**
 * dsh-multi-download · 模型工具层（裸 ToolDefinition，不依赖任何 DSH 包）
 */
import { DownloadError, snapshot, describeError } from './engine.js'

function fmtBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  if (v < 1024) return `${Math.round(v)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let x = v / 1024
  let i = 0
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i += 1
  }
  return `${x >= 100 ? x.toFixed(0) : x.toFixed(1)} ${units[i]}`
}

function fmtRate(bps) {
  return bps > 0 ? `${fmtBytes(bps)}/s` : '—'
}

function progressLine(t) {
  const pct = typeof t.percent === 'number' ? `${t.percent.toFixed(1)}%` : fmtBytes(t.bytes)
  const total = t.total ? ` / ${fmtBytes(t.total)}` : ''
  const mode = t.segments > 1 ? `${t.segments} 段并发` : '单连接'
  return `${t.state} · ${pct}${total} · ${fmtRate(t.speedBps)} · ${mode} · ${t.elapsedSec}s${t.resumed ? ' · 已续传' : ''}`
}

/**
 * 建工具。
 * @param {import('./engine.js').Downloader} downloader
 */
export function createTools(downloader) {
  const downloadFile = {
    name: 'download_file',
    description: [
      '用多线程（HTTP Range 分段并发）下载器把一个 http/https 直链下载到本地文件。',
      '特性：多连接并行（默认 8，可到 16）→ 大文件明显快于单线程 curl/wget；断点续传（失败或取消后对同一 dest 再调一次即可续上）；服务器不支持 Range 时自动退化为单连接；合并后校验字节数，先写临时文件再原子改名，不会留下半截目标文件。',
      'dest 建议传绝对路径（如 D:\\data\\pkg.zip）；传相对路径时以插件 baseDir 为基准（默认用户 Downloads 目录，结果里会回绝对路径）。dest 以 / 或 \\ 结尾、或指向已存在的目录时，自动按 URL 推导文件名。目标已存在会报错，除非 overwrite: true。',
      '大文件（几十 MB 以上）或想边下边干别的时传 background: true，会用 download_task 返回任务 id 供后续查询/取消。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http:// 或 https:// 直链（会自动跟随重定向）' },
        dest: {
          type: 'string',
          description: '保存路径（绝对路径最佳）；相对路径基于 baseDir（默认 Downloads）；以 / 结尾表示目录，自动取名',
        },
        connections: {
          type: 'integer',
          description: '并发连接数，默认 8，上限 16；小文件或服务器限速时没用，1 = 单连接',
        },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: '额外请求头，如 {"Referer":"https://example.com/","Cookie":"a=b"}',
        },
        overwrite: { type: 'boolean', description: '目标文件已存在时是否覆盖，默认 false' },
        resume: {
          type: 'boolean',
          description: '是否复用同 dest 旁的 .dshdl 分片续传，默认 true；false = 丢弃旧分片重新下',
        },
        background: {
          type: 'boolean',
          description: 'true = 立即返回任务 id 在后台下载；false/省略 = 阻塞到下载结束再返回结果',
        },
      },
      required: ['url', 'dest'],
    },
    output: {
      schema: {
        type: 'object',
        description: '下载结果',
        properties: {
          ok: { type: 'boolean', description: '是否成功完成' },
          state: { type: 'string', description: 'done | cancelled | error' },
          id: { type: 'string', description: '任务 id' },
          path: { type: 'string', description: '本地落盘绝对路径' },
          url: { type: 'string', description: '实际使用的 URL（重定向后）' },
          bytes: { type: 'number', description: '已下载字节' },
          total: { description: '总字节（未知时为 null）' },
          percent: { description: '完成百分比（未知时为 null）' },
          connections: { type: 'number', description: '请求的并发连接数' },
          segments: { type: 'number', description: '实际分片数（1 = 单连接）' },
          resumed: { type: 'boolean', description: '是否复用旧分片续传' },
          speedBps: { type: 'number', description: '实时速度（字节/秒）' },
          avgBps: { type: 'number', description: '平均速度（字节/秒）' },
          elapsedSec: { type: 'number', description: '耗时（秒）' },
          error: { type: 'string', description: '失败原因（成功时为空串）' },
          code: { type: 'string', description: '失败代码，如 HTTP_STATUS / EEXIST / CANCELLED' },
          message: { type: 'string', description: '一句话摘要' },
        },
      },
      render(args, value) {
        if (!value || typeof value !== 'object') return [{ type: 'text', text: String(value) }]
        const lines = []
        if (value.state === 'done') {
          lines.push(`✔ 下载完成：${value.path}`)
        } else if (value.state === 'cancelled') {
          lines.push(`⏹ 已取消：${value.path || value.url}`)
        } else if (value.state === 'error') {
          lines.push(`✘ 下载失败：${value.error || '未知错误'}`)
        } else {
          lines.push(`⏳ 已在后台开始：${value.path || '(' + value.url + ')'}`)
        }
        lines.push(`  ${progressLine(value)}`)
        if (value.state === 'done' || value.state === 'error') {
          lines.push(`  平均 ${fmtRate(value.avgBps)} · 任务 id ${value.id}`)
        } else {
          lines.push(`  任务 id ${value.id} —— 用 download_task 查进度（action:"status", id:"${value.id}"）`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 30 * 60 * 1000,
    isConcurrencySafe: () => true,
    presentCall(args) {
      try {
        const a = args && typeof args === 'object' ? args : {}
        const name = String(a.dest || a.url || '').split(/[\\/]/).filter(Boolean).pop() || '文件'
        return { card: 'generic', title: `多线程下载 · ${name}`, kind: 'fetch' }
      } catch {
        return undefined
      }
    },
    async execute(args, exec) {
      const background = args.background === true
      let task
      try {
        task = downloader.start({
          url: args.url,
          dest: args.dest,
          connections: args.connections,
          headers: args.headers,
          overwrite: args.overwrite === true,
          resume: args.resume !== false,
        })
      } catch (e) {
        return {
          ok: false,
          state: 'error',
          id: '',
          path: '',
          url: String(args.url || ''),
          bytes: 0,
          total: null,
          percent: null,
          connections: 0,
          segments: 0,
          resumed: false,
          speedBps: 0,
          avgBps: 0,
          elapsedSec: 0,
          error: describeError(e),
          code: (e && e.code) || 'DOWNLOAD_FAILED',
          message: describeError(e),
        }
      }

      if (background) {
        const snap = snapshot(task)
        return { ...snap, ok: true, message: `后台下载已启动：${snap.id}` }
      }

      let detach = () => {}
      if (exec && exec.signal) {
        const signal = exec.signal
        const onAbort = () => {
          try {
            downloader.cancel(task.id)
          } catch {
            /* ignore */
          }
        }
        if (signal.aborted) onAbort()
        else {
          signal.addEventListener('abort', onAbort, { once: true })
          detach = () => signal.removeEventListener('abort', onAbort)
        }
      }
      try {
        await task.promise
      } finally {
        detach()
      }
      const snap = snapshot(task)
      return {
        ...snap,
        ok: snap.state === 'done',
        message: snap.state === 'done' ? `下载完成：${snap.path}` : snap.error || snap.state,
      }
    },
  }

  const downloadTask = {
    name: 'download_task',
    description: [
      '查看 / 管理由 download_file 启动的下载任务（进程内注册表，跨工具调用保留）。',
      'action: "list" 列出最近任务；"status" 查单个任务进度（需 id）；"cancel" 取消任务（需 id，已下载的分片保留，可对同一 dest 再调 download_file 续传）。',
      '返回的 tasks 数组每项含 state / percent / bytes / total / speedBps / path / error。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'status', 'cancel'], description: '要执行的操作' },
        id: { type: 'string', description: '任务 id（status / cancel 必填），如 dl-1a2b3c4d' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          message: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                state: { type: 'string' },
                path: { type: 'string' },
                url: { type: 'string' },
                bytes: { type: 'number' },
                total: {},
                percent: {},
                speedBps: { type: 'number' },
                avgBps: { type: 'number' },
                elapsedSec: { type: 'number' },
                segments: { type: 'number' },
                resumed: { type: 'boolean' },
                error: { type: 'string' },
                code: { type: 'string' },
                connections: { type: 'number' },
              },
            },
          },
        },
      },
      render(args, value) {
        const tasks = value && Array.isArray(value.tasks) ? value.tasks : []
        if (tasks.length === 0) {
          return [{ type: 'text', text: value && value.message ? value.message : '没有下载任务' }]
        }
        const lines = [value && value.message ? value.message : `${tasks.length} 个任务`]
        for (const t of tasks) {
          lines.push(`- ${t.id} ${progressLine(t)}`)
          if (t.path) lines.push(`  → ${t.path}`)
          if (t.error) lines.push(`  ! ${t.error}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 60 * 1000,
    isConcurrencySafe: () => true,
    presentCall(args) {
      try {
        const a = args && typeof args === 'object' ? args : {}
        const label = a.action === 'cancel' ? '取消下载' : a.action === 'list' ? '下载任务列表' : '下载任务进度'
        return { card: 'generic', title: label, kind: 'fetch' }
      } catch {
        return undefined
      }
    },
    async execute(args) {
      const action = String(args.action || '').trim()
      if (action === 'list') {
        const tasks = downloader.list().map(snapshot)
        return { ok: true, action, message: tasks.length ? `${tasks.length} 个下载任务` : '还没有下载任务', tasks }
      }
      const id = String(args.id || '').trim()
      if (!id) throw new DownloadError(`${action} 需要 id 参数`, 'BAD_ARGS')
      if (action === 'status') {
        const task = downloader.get(id)
        if (!task) throw new DownloadError(`没有找到任务 ${id}（用 action:"list" 看现有任务）`, 'NO_TASK')
        const snap = snapshot(task)
        return { ok: snap.state !== 'error', action, message: `${snap.id} · ${snap.state}`, tasks: [snap] }
      }
      if (action === 'cancel') {
        const task = downloader.cancel(id)
        const snap = snapshot(task)
        return { ok: true, action, message: `已请求取消 ${snap.id}`, tasks: [snap] }
      }
      throw new DownloadError(`不认识的 action：${action}（可用 list / status / cancel）`, 'BAD_ARGS')
    },
  }

  return [downloadFile, downloadTask]
}
