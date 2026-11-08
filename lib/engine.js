/**
 * dsh-multi-download · 下载引擎（零依赖，只用 Node 内置模块）
 *
 * 能力：
 *   - HTTP Range 分段并发下载（一个文件同时开 N 条连接）
 *   - 断点续传（分片落盘 + meta.json，失败/取消后再次调用同一 dest 继续）
 *   - 进度 / 实时速度 / 平均速度 / 取消
 *   - 服务器不支持 Range 时自动退化为单连接流式下载
 *   - 失败重试（指数退避）、合并后字节数校验、原子落盘（先 merged 再 rename）
 */
import { createReadStream, existsSync, promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

let defaultBaseDirCache = ''

/**
 * 默认落盘目录：优先用户 Downloads（三平台通用），找不到则退回 home，
 * 再退回进程 cwd（宿主进程 cwd 通常是 DSH profile 目录，不适合当默认下载位置）。
 */
export function defaultBaseDir() {
  if (defaultBaseDirCache) return defaultBaseDirCache
  const home = os.homedir()
  let found = process.cwd()
  for (const candidate of [path.join(home, 'Downloads'), path.join(home, 'downloads'), home]) {
    if (existsSync(candidate)) {
      found = candidate
      break
    }
  }
  defaultBaseDirCache = found
  return found
}

export const DEFAULTS = {
  /** 默认并发连接数 */
  connections: 8,
  /** 允许的上限（工具入参会被钳制到这里） */
  maxConnections: 16,
  /** 小于该尺寸（字节）的文件不值得分段 */
  minSegmentBytes: 2 * 1024 * 1024,
  /** 单次请求失败后的重试次数 */
  retries: 4,
  /** 探测/建连超时（毫秒） */
  requestTimeoutMs: 45000,
  /** 传输停滞超时（毫秒）：超过这么久没有新数据就断开重试 */
  stallTimeoutMs: 30000,
  userAgent: 'dsh-multi-download/1.0.0 (+https://github.com/deepseek-ai)',
  /** dest 为相对路径时的基准目录；空 = 用户 Downloads（见 defaultBaseDir） */
  baseDir: '',
  /** 成功后是否保留 .dshdl 临时目录 */
  keepTemp: false,
  /** 内存里最多保留多少个任务记录 */
  maxTasks: 64,
  /** 已完成任务记录保留多久（毫秒） */
  taskTtlMs: 6 * 60 * 60 * 1000,
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524])
const FATAL_CODES = new Set([
  'RANGE_UNSUPPORTED', 'BAD_URL', 'EEXIST', 'EACCES', 'EPERM', 'ENOSPC',
  'EROFS', 'OVERRUN', 'SIZE_MISMATCH', 'EMPTY_BODY',
])

export class DownloadError extends Error {
  constructor(message, code = 'DOWNLOAD_FAILED', status = 0) {
    super(message)
    this.name = 'DownloadError'
    this.code = code
    this.status = status
  }
}

/* ────────────────────────────── 小工具 ────────────────────────────── */

export function clampInt(value, fallback, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

export function normalizeConfig(input) {
  const c = input && typeof input === 'object' ? input : {}
  const cfg = { ...DEFAULTS }
  cfg.connections = clampInt(c.connections, DEFAULTS.connections, 1, 64)
  cfg.maxConnections = clampInt(c.maxConnections, DEFAULTS.maxConnections, 1, 64)
  if (cfg.maxConnections < cfg.connections) cfg.maxConnections = cfg.connections
  cfg.minSegmentBytes = clampInt(c.minSegmentBytes, DEFAULTS.minSegmentBytes, 64 * 1024, 256 * 1024 * 1024)
  cfg.retries = clampInt(c.retries, DEFAULTS.retries, 0, 12)
  cfg.requestTimeoutMs = clampInt(c.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 1000, 600000)
  cfg.stallTimeoutMs = clampInt(c.stallTimeoutMs, DEFAULTS.stallTimeoutMs, 1000, 600000)
  cfg.maxTasks = clampInt(c.maxTasks, DEFAULTS.maxTasks, 4, 512)
  cfg.taskTtlMs = clampInt(c.taskTtlMs, DEFAULTS.taskTtlMs, 60000, 7 * 24 * 3600 * 1000)
  if (typeof c.userAgent === 'string' && c.userAgent.trim()) cfg.userAgent = c.userAgent.trim()
  if (typeof c.baseDir === 'string') cfg.baseDir = c.baseDir.trim()
  if (typeof c.keepTemp === 'boolean') cfg.keepTemp = c.keepTemp
  return cfg
}

function normalizeHeaders(input) {
  const out = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  for (const [k, v] of Object.entries(input)) {
    if (typeof k !== 'string' || !k.trim()) continue
    if (v === undefined || v === null) continue
    out[k.trim().toLowerCase()] = String(v)
  }
  return out
}

/** 从 URL 推导一个安全的文件名 */
export function filenameFromUrl(rawUrl) {
  let name = ''
  try {
    const u = new URL(rawUrl)
    const seg = u.pathname.split('/').filter(Boolean).pop() || ''
    name = decodeURIComponent(seg)
  } catch {
    name = ''
  }
  name = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  if (!name || name === '.' || name === '..') return 'download.bin'
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 12)
    name = name.slice(0, 120 - ext.length) + ext
  }
  return name
}

async function fileSize(p) {
  try {
    const st = await fsp.stat(p)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

async function readJson(p) {
  try {
    const raw = await fsp.readFile(p, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function writeJson(p, value) {
  await fsp.writeFile(p, JSON.stringify(value), 'utf8')
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new DownloadError('已取消', 'CANCELLED'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DownloadError('已取消', 'CANCELLED'))
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (timer.unref) timer.unref()
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 组合外部取消信号 + 可刷新的停滞定时器。
 * touch() 重置计时（每收到一块数据调用一次）。
 */
function makeAbortBox(outer, timeoutMs) {
  const ctrl = new AbortController()
  let timer = null
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      ctrl.abort(new DownloadError(`网络停滞超过 ${Math.round(timeoutMs / 1000)} 秒`, 'STALL'))
    }, timeoutMs)
    if (timer.unref) timer.unref()
  }
  const onOuterAbort = () => ctrl.abort(new DownloadError('已取消', 'CANCELLED'))
  if (outer) {
    if (outer.aborted) onOuterAbort()
    else outer.addEventListener('abort', onOuterAbort, { once: true })
  }
  if (!ctrl.signal.aborted) arm()
  return {
    signal: ctrl.signal,
    touch: arm,
    dispose() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (outer) outer.removeEventListener('abort', onOuterAbort)
    },
  }
}

function normalizeNetError(e, outer) {
  if (outer && outer.aborted) return new DownloadError('已取消', 'CANCELLED')
  const cause = e && e.cause
  const code = (cause && cause.code) || (e && e.code) || ''
  const msg = (e && e.message) || String(e)
  return new DownloadError(code ? `${msg} (${code})` : msg, code || 'NETWORK', 0)
}

function retryable(e) {
  if (!e) return true
  if (e.code && FATAL_CODES.has(e.code)) return false
  if (e.status && !RETRYABLE_STATUS.has(e.status)) return false
  return true
}

/** 人类可读的错误描述（也用于工具回执） */
export function describeError(e) {
  if (!e) return '未知错误'
  const cause = e && e.cause
  const code = (cause && cause.code) || (e && e.code) || ''
  const table = {
    ENOTFOUND: '域名解析失败',
    EAI_AGAIN: 'DNS 暂时不可用',
    ECONNREFUSED: '连接被拒绝',
    ECONNRESET: '连接被重置',
    ECONNABORTED: '连接中断',
    ETIMEDOUT: '连接超时',
    UND_ERR_CONNECT_TIMEOUT: '建连超时',
    UND_ERR_HEADERS_TIMEOUT: '响应头超时',
    UND_ERR_BODY_TIMEOUT: '接收正文超时',
    UND_ERR_SOCKET: '套接字错误',
    EPIPE: '连接被对方关闭',
    ENOSPC: '磁盘空间不足',
    EACCES: '没有写入权限',
    EPERM: '没有写入权限',
    EROFS: '目标在只读文件系统上',
    EEXIST: '目标文件已存在',
    ERR_INVALID_URL: 'URL 格式不合法',
  }
  const raw = String((e && e.message) || e)
  const causeMsg = String((cause && cause.message) || '')
  // 我们自己抛的 DownloadError 消息已经是人话，直接用它（必要时补上错误码）
  if (e && e.name === 'DownloadError') {
    return code && table[code] && !raw.includes(table[code]) ? `${raw}（${code}）` : raw
  }
  if (code && table[code]) return `${table[code]}（${code}）`
  if (e && e.status) return `HTTP ${e.status}`
  return causeMsg ? `${raw}: ${causeMsg}` : raw
}

/* ────────────────────────────── HTTP ────────────────────────────── */

/**
 * 探测一次：拿最终 URL、总大小、是否支持 Range、ETag。
 * 只读 0-0 一个字节的 Range 请求，读完立刻断开正文。
 */
async function probe(url, headers, cfg, outer) {
  const box = makeAbortBox(outer, cfg.requestTimeoutMs)
  let res
  try {
    res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: box.signal,
      headers: {
        ...headers,
        'user-agent': cfg.userAgent,
        'accept-encoding': 'identity',
        range: 'bytes=0-0',
      },
    })
  } catch (e) {
    box.dispose()
    throw normalizeNetError(e, outer)
  }
  box.dispose()

  const status = res.status
  const info = {
    status,
    statusText: res.statusText || '',
    finalUrl: res.url || url,
    size: null,
    ranges: false,
    etag: res.headers.get('etag') || '',
    lastModified: res.headers.get('last-modified') || '',
    contentType: res.headers.get('content-type') || '',
  }
  try {
    await (res.body && res.body.cancel())
  } catch {
    /* ignore */
  }

  if (status === 206) {
    const cr = res.headers.get('content-range') || ''
    const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(cr)
    if (m) {
      if (m[3] !== '*') info.size = Number(m[3])
      info.ranges = info.size !== null && info.size > 0
    }
  } else if (status === 200) {
    const cl = (res.headers.get('content-length') || '').trim()
    if (/^\d+$/.test(cl)) info.size = Number(cl)
    const ar = (res.headers.get('accept-ranges') || '').toLowerCase()
    info.ranges = ar.includes('bytes') && info.size !== null && info.size > 0
  } else if (status === 416) {
    throw new DownloadError('服务器返回 416（Range 不可满足），该 URL 可能不支持分段下载', 'RANGE_NOT_SATISFIABLE', 416)
  } else if (status === 401 || status === 403) {
    throw new DownloadError(`HTTP ${status}：需要授权（可在 headers 里传 Cookie / Authorization / Referer）`, 'HTTP_STATUS', status)
  } else {
    throw new DownloadError(`HTTP ${status} ${info.statusText}`.trim(), 'HTTP_STATUS', status)
  }
  if (info.size === 0) {
    throw new DownloadError('服务器返回的文件大小为 0 字节', 'EMPTY_BODY', status)
  }
  return info
}

/* ────────────────────────────── 分片规划 ────────────────────────────── */

export function planSegments(size, wanted, minSegmentBytes) {
  if (!(size > 0)) return []
  const maxBySize = Math.max(1, Math.floor(size / Math.max(1, minSegmentBytes)))
  const n = Math.max(1, Math.min(wanted, maxBySize))
  const chunk = Math.ceil(size / n)
  const segs = []
  for (let i = 0; i < n; i += 1) {
    const start = i * chunk
    const end = Math.min(size - 1, start + chunk - 1)
    if (start <= end) segs.push({ index: segs.length, start, end })
  }
  return segs
}

async function finalize(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true })
  try {
    await fsp.rename(from, to)
  } catch (e) {
    if (e && (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES')) {
      await fsp.rm(to, { force: true })
      await fsp.rename(from, to)
    } else {
      throw e
    }
  }
}

/* ────────────────────────────── 速度 ────────────────────────────── */

function bump(task, n) {
  task.bytes += n
  const now = Date.now()
  if (now - task.lastSampleAt >= 250) {
    task.lastSampleAt = now
    task.samples.push({ t: now, b: task.bytes })
    if (task.samples.length > 60) task.samples.shift()
  }
}

function speedOf(task) {
  const s = task.samples
  if (s.length < 2) return 0
  const last = s[s.length - 1]
  let first = s[0]
  for (let i = s.length - 1; i >= 0; i -= 1) {
    if (last.t - s[i].t >= 2000) {
      first = s[i]
      break
    }
  }
  const dt = (last.t - first.t) / 1000
  if (!(dt > 0)) return 0
  return Math.max(0, (last.b - first.b) / dt)
}

/** 把内部任务压成无损 JSON 快照（工具回执用） */
export function snapshot(task) {
  const now = task.finishedAt || Date.now()
  const elapsed = Math.max(0, (now - task.startedAt) / 1000)
  const total = typeof task.total === 'number' && task.total > 0 ? task.total : null
  const bytes = Math.max(0, Math.trunc(task.bytes))
  const percent = total ? Math.min(100, Math.round((bytes / total) * 1000) / 10) : null
  return {
    id: task.id,
    state: task.state,
    path: task.dest || '',
    url: task.url,
    bytes,
    total,
    percent,
    connections: task.connections,
    segments: task.segments,
    resumed: task.resumed === true,
    speedBps: task.state === 'running' ? Math.round(speedOf(task)) : 0,
    avgBps: elapsed > 0 ? Math.round(bytes / elapsed) : 0,
    elapsedSec: Math.round(elapsed * 10) / 10,
    error: task.error || '',
    code: task.code || '',
  }
}

/* ────────────────────────────── 下载器 ────────────────────────────── */

export class Downloader {
  constructor(config) {
    this.config = normalizeConfig(config)
    this.tasks = new Map()
  }

  get(id) {
    return this.tasks.get(id) || null
  }

  list() {
    this.prune()
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  cancel(id) {
    const task = this.tasks.get(id)
    if (!task) throw new DownloadError(`没有找到任务 ${id}`, 'NO_TASK')
    if (task.state === 'done' || task.state === 'error' || task.state === 'cancelled') return task
    task.cancelled = true
    task.ctrl.abort(new DownloadError('已取消', 'CANCELLED'))
    return task
  }

  prune() {
    const now = Date.now()
    for (const [id, t] of this.tasks) {
      const finished = t.state === 'done' || t.state === 'error' || t.state === 'cancelled'
      if (finished && now - t.finishedAt > this.config.taskTtlMs) this.tasks.delete(id)
    }
    while (this.tasks.size > this.config.maxTasks) {
      let victim = null
      for (const [id, t] of this.tasks) {
        const finished = t.state === 'done' || t.state === 'error' || t.state === 'cancelled'
        if (!finished) continue
        if (!victim || t.finishedAt < victim[1].finishedAt) victim = [id, t]
      }
      if (!victim) break
      this.tasks.delete(victim[0])
    }
  }

  /**
   * 启动一个下载任务，立即返回任务对象（task.promise 完成后结算）。
   * @param {{url:string,dest?:string,connections?:number,headers?:object,overwrite?:boolean,resume?:boolean}} opts
   */
  start(opts) {
    const cfg = this.config
    const url = String((opts && opts.url) || '').trim()
    if (!/^https?:\/\/\S+$/i.test(url)) {
      throw new DownloadError('url 必须是合法的 http:// 或 https:// 直链', 'BAD_URL')
    }
    const task = {
      id: `dl-${randomUUID().slice(0, 8)}`,
      url,
      dest: '',
      state: 'probing',
      bytes: 0,
      total: null,
      etag: '',
      connections: clampInt(opts && opts.connections, cfg.connections, 1, cfg.maxConnections),
      startedAt: Date.now(),
      finishedAt: 0,
      error: '',
      code: '',
      cancelled: false,
      ctrl: new AbortController(),
      samples: [],
      lastSampleAt: 0,
      segments: 0,
      resumed: false,
      tmpDir: '',
      promise: null,
    }
    this.prune()
    this.tasks.set(task.id, task)
    task.promise = this.#execute(task, opts || {}).catch(() => {})
    return task
  }

  async #execute(task, opts) {
    const cfg = this.config
    try {
      const headers = normalizeHeaders(opts.headers)
      const info = await probe(task.url, headers, cfg, task.ctrl.signal)
      task.url = info.finalUrl
      task.total = info.size
      task.etag = info.etag
      task.dest = await this.#resolveDest(opts.dest, info.finalUrl, opts.overwrite === true)
      task.state = 'running'

      const bigEnough = info.size !== null && info.size >= cfg.minSegmentBytes * 2
      if (info.ranges && bigEnough && task.connections > 1) {
        try {
          await this.#runSegmented(task, info, headers, opts)
        } catch (e) {
          if (e && e.code === 'RANGE_UNSUPPORTED') {
            // 服务器实际不支持 Range：清掉分片，退化为单连接
            await fsp.rm(task.tmpDir, { recursive: true, force: true }).catch(() => {})
            task.bytes = 0
            task.samples = []
            task.segments = 0
            task.resumed = false
            await this.#runSingle(task, headers)
          } else {
            throw e
          }
        }
      } else {
        await this.#runSingle(task, headers)
      }

      task.finishedAt = Date.now()
      task.state = 'done'
      if (task.total !== null) task.bytes = task.total
      if (!cfg.keepTemp && task.tmpDir) {
        await fsp.rm(task.tmpDir, { recursive: true, force: true }).catch(() => {})
      }
    } catch (e) {
      task.finishedAt = Date.now()
      if (task.cancelled || (task.ctrl.signal.aborted && !(e && e.code === 'STALL'))) {
        task.state = 'cancelled'
        task.error = '已取消（临时分片保留在目标旁的 .dshdl 目录，可续传）'
        task.code = 'CANCELLED'
      } else {
        task.state = 'error'
        task.error = describeError(e)
        task.code = (e && e.code) || 'DOWNLOAD_FAILED'
      }
    }
  }

  async #resolveDest(destRaw, finalUrl, overwrite) {
    const cfg = this.config
    const base = cfg.baseDir || defaultBaseDir()
    let dest = typeof destRaw === 'string' ? destRaw.trim() : ''
    let asDir = false
    if (!dest) {
      dest = filenameFromUrl(finalUrl)
      asDir = true
    } else if (/[\\/]$/.test(dest)) {
      asDir = true
    }
    let abs = path.resolve(base, dest)
    if (!asDir) {
      const st = await fsp.stat(abs).catch(() => null)
      if (st && st.isDirectory()) asDir = true
    }
    if (asDir) abs = path.join(abs, filenameFromUrl(finalUrl))
    if (!abs || /[\\/]$/.test(abs)) abs = path.join(abs || base, 'download.bin')
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    if (overwrite !== true) {
      const st = await fsp.stat(abs).catch(() => null)
      if (st && st.isFile()) {
        throw new DownloadError(
          `目标文件已存在：${abs}（传 overwrite: true 覆盖，或换一个 dest）`,
          'EEXIST',
        )
      }
    }
    return abs
  }

  async #runSegmented(task, info, headers, opts) {
    const cfg = this.config
    const size = info.size
    const segs = planSegments(size, task.connections, cfg.minSegmentBytes)
    task.segments = segs.length
    task.tmpDir = `${task.dest}.dshdl`
    await fsp.mkdir(task.tmpDir, { recursive: true })

    const metaPath = path.join(task.tmpDir, 'meta.json')
    const meta = opts.resume === false ? null : await readJson(metaPath)
    const compatible =
      meta &&
      meta.version === 1 &&
      meta.url === info.finalUrl &&
      meta.size === size &&
      Array.isArray(meta.segments) &&
      meta.segments.length === segs.length &&
      meta.segments.every((s, i) => s && s.start === segs[i].start && s.end === segs[i].end)

    if (!compatible) {
      await fsp.rm(task.tmpDir, { recursive: true, force: true })
      await fsp.mkdir(task.tmpDir, { recursive: true })
      await writeJson(metaPath, {
        version: 1,
        url: info.finalUrl,
        size,
        etag: info.etag,
        lastModified: info.lastModified,
        segments: segs,
        createdAt: Date.now(),
      })
    }

    const parts = segs.map((s) => path.join(task.tmpDir, `seg-${s.index}.part`))
    let ready = 0
    for (let i = 0; i < segs.length; i += 1) {
      const len = segs[i].end - segs[i].start + 1
      let have = await fileSize(parts[i])
      if (have > len) {
        await fsp.truncate(parts[i], 0)
        have = 0
      }
      if (have > 0) task.resumed = true
      ready += have
    }
    task.bytes = ready
    task.samples = [{ t: Date.now(), b: ready }]
    task.lastSampleAt = Date.now()

    const settled = await Promise.allSettled(
      segs.map((seg, i) => this.#runSegment(task, seg, parts[i], headers, cfg)),
    )
    const failed = settled.find((r) => r.status === 'rejected')
    if (failed) throw failed.reason

    task.state = 'merging'
    const merged = path.join(task.tmpDir, 'merged.bin')
    const fh = await fsp.open(merged, 'w')
    try {
      for (const part of parts) {
        const rs = createReadStream(part)
        // eslint-disable-next-line no-await-in-loop
        for await (const chunk of rs) await fh.write(chunk)
      }
    } finally {
      await fh.close().catch(() => {})
    }
    const mergedSize = await fileSize(merged)
    if (mergedSize !== size) {
      throw new DownloadError(`合并校验失败：期望 ${size} 字节，实际 ${mergedSize} 字节`, 'SIZE_MISMATCH')
    }
    await finalize(merged, task.dest)
    task.state = 'running'
  }

  async #runSegment(task, seg, part, headers, cfg) {
    const len = seg.end - seg.start + 1
    let done = await fileSize(part)
    if (done >= len) return
    if (done < 0) done = 0
    let attempt = 0
    for (;;) {
      const from = seg.start + done
      const box = makeAbortBox(task.ctrl.signal, cfg.stallTimeoutMs)
      let fh = null
      try {
        const res = await fetch(task.url, {
          method: 'GET',
          redirect: 'follow',
          signal: box.signal,
          headers: {
            ...headers,
            'user-agent': cfg.userAgent,
            'accept-encoding': 'identity',
            range: `bytes=${from}-${seg.end}`,
          },
        })
        if (res.status === 200) {
          try {
            await (res.body && res.body.cancel())
          } catch {
            /* ignore */
          }
          throw new DownloadError('服务器忽略了 Range 请求（返回 200 全量）', 'RANGE_UNSUPPORTED', 200)
        }
        if (res.status !== 206) {
          try {
            await (res.body && res.body.cancel())
          } catch {
            /* ignore */
          }
          throw new DownloadError(`分段请求返回 HTTP ${res.status}`, 'HTTP_STATUS', res.status)
        }
        if (!res.body) throw new DownloadError('响应没有正文', 'EMPTY_BODY')
        fh = await fsp.open(part, 'a')
        for await (const chunk of res.body) {
          box.touch()
          await fh.write(chunk)
          done += chunk.length
          bump(task, chunk.length)
          if (done > len) throw new DownloadError('分段数据超出请求范围（服务器 Range 处理异常）', 'OVERRUN')
        }
        if (done !== len) {
          throw new DownloadError(`分段 ${seg.index} 不完整：${done}/${len} 字节`, 'SHORT_READ', 0)
        }
        return
      } catch (e) {
        if (task.ctrl.signal.aborted) throw new DownloadError('已取消', 'CANCELLED')
        attempt += 1
        if (attempt > cfg.retries || !retryable(e)) throw e
        // eslint-disable-next-line no-await-in-loop
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)), task.ctrl.signal)
      } finally {
        if (fh) await fh.close().catch(() => {})
        box.dispose()
      }
    }
  }

  async #runSingle(task, headers) {
    const cfg = this.config
    task.tmpDir = `${task.dest}.dshdl`
    await fsp.mkdir(task.tmpDir, { recursive: true })
    const part = path.join(task.tmpDir, 'single.part')
    await fsp.rm(part, { force: true })
    let attempt = 0
    for (;;) {
      const box = makeAbortBox(task.ctrl.signal, cfg.stallTimeoutMs)
      let fh = null
      try {
        const res = await fetch(task.url, {
          method: 'GET',
          redirect: 'follow',
          signal: box.signal,
          headers: { ...headers, 'user-agent': cfg.userAgent },
        })
        if (!res.ok) {
          try {
            await (res.body && res.body.cancel())
          } catch {
            /* ignore */
          }
          throw new DownloadError(`HTTP ${res.status} ${res.statusText || ''}`.trim(), 'HTTP_STATUS', res.status)
        }
        if (!res.body) throw new DownloadError('响应没有正文', 'EMPTY_BODY')
        task.bytes = 0
        task.samples = [{ t: Date.now(), b: 0 }]
        task.lastSampleAt = Date.now()
        fh = await fsp.open(part, 'w')
        for await (const chunk of res.body) {
          box.touch()
          await fh.write(chunk)
          bump(task, chunk.length)
        }
        const got = await fileSize(part)
        if (task.total !== null && got !== task.total) {
          throw new DownloadError(`下载不完整：${got}/${task.total} 字节`, 'SHORT_READ', 0)
        }
        await finalize(part, task.dest)
        return
      } catch (e) {
        if (task.ctrl.signal.aborted) throw new DownloadError('已取消', 'CANCELLED')
        attempt += 1
        if (attempt > cfg.retries || !retryable(e)) throw e
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)), task.ctrl.signal)
      } finally {
        if (fh) await fh.close().catch(() => {})
        box.dispose()
      }
    }
  }
}
