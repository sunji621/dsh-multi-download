/**
 * dsh-multi-download 自测（node tests/run.mjs）
 *
 * 覆盖：工具 schema 子集合规、apply() 注册、分段并发下载（哈希校验）、断点续传、
 * 不支持 Range 的服务器、覆盖保护、404、目录式 dest、后台任务 status/list/cancel。
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { apply } from '../index.js'
import { defaultBaseDir } from '../lib/engine.js'

const TMP = path.join(os.tmpdir(), `dsh-multi-download-test-${process.pid}`)

let passed = 0
let failed = 0
function ok(name, cond, detail) {
  if (cond) {
    passed += 1
    console.log(`  ✔ ${name}`)
  } else {
    failed += 1
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ───────────── 测试数据与 HTTP 服务器 ───────────── */

function makeData(size) {
  const b = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i += 1) b[i] = (i * 31 + 7) & 0xff
  return b
}

const BIG = makeData(12 * 1024 * 1024 + 123)
const MID = makeData(8 * 1024 * 1024)
const SMALL = makeData(64 * 1024)

function parseRange(header, total) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(header || '').trim())
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1)
  if (start >= total || start > end) return null
  return { start, end }
}

function sendFull(res, buf) {
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(buf.length),
    'accept-ranges': 'bytes',
    etag: `"${buf.length}"`,
  })
  res.end(buf)
}

function sendRange(res, buf, { start, end }) {
  res.writeHead(206, {
    'content-type': 'application/octet-stream',
    'content-length': String(end - start + 1),
    'content-range': `bytes ${start}-${end}/${buf.length}`,
    'accept-ranges': 'bytes',
    etag: `"${buf.length}"`,
  })
  res.end(buf.subarray(start, end + 1))
}

/** 限速发送（用于制造可取消的下载） */
async function sendSlowRange(res, buf, range, step, delayMs) {
  const { start, end } = range
  res.writeHead(206, {
    'content-type': 'application/octet-stream',
    'content-length': String(end - start + 1),
    'content-range': `bytes ${start}-${end}/${buf.length}`,
    'accept-ranges': 'bytes',
  })
  let pos = start
  while (pos <= end) {
    const next = Math.min(end + 1, pos + step)
    if (!res.write(buf.subarray(pos, next))) {
      await new Promise((r) => res.once('drain', r))
    }
    pos = next
    if (res.destroyed) return
    await sleep(delayMs)
  }
  res.end()
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname
    try {
      if (p === '/404') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      if (p === '/auth') {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('need auth')
        return
      }
      if (p === '/empty.bin') {
        res.writeHead(200, { 'content-length': '0' })
        res.end()
        return
      }
      if (p === '/range/big.bin') {
        const r = parseRange(req.headers.range, BIG.length)
        if (r) sendRange(res, BIG, r)
        else sendFull(res, BIG)
        return
      }
      if (p === '/range/small.bin') {
        const r = parseRange(req.headers.range, SMALL.length)
        if (r) sendRange(res, SMALL, r)
        else sendFull(res, SMALL)
        return
      }
      if (p === '/norange/mid.bin') {
        // 完全不支持 Range：无论请求头如何都回 200 全量
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(MID.length) })
        res.end(MID)
        return
      }
      if (p === '/slow/mid.bin') {
        // 支持 Range 但限速：约 256KB / 100ms 每条连接
        const r = parseRange(req.headers.range, MID.length)
        if (r) await sendSlowRange(res, MID, r, 256 * 1024, 100)
        else {
          res.writeHead(200, { 'content-length': String(MID.length) })
          res.end(MID)
        }
        return
      }
      res.writeHead(404)
      res.end()
    } catch {
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    }
  })
}

/* ───────────── 模拟 DSH 工具注册 ───────────── */

const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
const SUPPORTED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', ...ANNOTATIONS])
const TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']

function validateSchemaSubset(node, at, problems) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    problems.push(`${at} 不是 schema 对象`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!SUPPORTED.has(key)) problems.push(`${at}.${key} 不在支持子集内`)
  }
  if (Object.hasOwn(node, 'oneOf')) {
    problems.push(`${at}.oneOf 本插件未使用，跳过深检`)
    return
  }
  if (!Object.hasOwn(node, 'type')) return
  if (!TYPES.includes(node.type)) {
    problems.push(`${at}.type 必须是单一类型字符串`)
    return
  }
  if (node.type === 'object' && Object.hasOwn(node, 'properties')) {
    for (const [k, v] of Object.entries(node.properties)) validateSchemaSubset(v, `${at}.properties.${k}`, problems)
  }
  if (node.type === 'array' && Object.hasOwn(node, 'items')) validateSchemaSubset(node.items, `${at}.items`, problems)
  if (Object.hasOwn(node, 'additionalProperties') && node.type !== 'object') problems.push(`${at}.additionalProperties 仅可用于 object`)
  if (Object.hasOwn(node, 'additionalProperties') && node.additionalProperties && typeof node.additionalProperties === 'object') {
    validateSchemaSubset(node.additionalProperties, `${at}.additionalProperties`, problems)
  }
  if (Object.hasOwn(node, 'required') && node.type !== 'object') problems.push(`${at}.required 仅可用于 object`)
  for (const key of ['enum', 'const']) {
    if (Object.hasOwn(node, key) && !['string', 'number', 'integer', 'boolean', 'null'].includes(node.type)) {
      problems.push(`${at}.${key} 不能用于 ${node.type}`)
    }
  }
}

function mountPlugin(config) {
  const registered = []
  const disposers = []
  const ctx = {
    tools: {
      register(def) {
        registered.push(def)
        const dispose = () => {
          const i = registered.indexOf(def)
          if (i >= 0) registered.splice(i, 1)
        }
        disposers.push(dispose)
        return dispose
      },
    },
    effect(fn) {
      return fn()
    },
    logger: undefined,
  }
  apply(ctx, config)
  return { tools: registered, disposers }
}

/* ───────────── 主流程 ───────────── */

async function main() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  await fsp.mkdir(TMP, { recursive: true })

  console.log('\n[1] 插件装配与 schema 子集')
  const { tools } = mountPlugin({ connections: 4, minSegmentBytes: 1024 * 1024, stallTimeoutMs: 5000, requestTimeoutMs: 5000 })
  ok('注册了 2 个工具', tools.length === 2, `实际 ${tools.length}`)
  const names = tools.map((t) => t.name).sort()
  ok('工具名正确', names.join(',') === 'download_file,download_task', names.join(','))
  for (const tool of tools) {
    const problems = []
    validateSchemaSubset(tool.parameters, `${tool.name}.parameters`, problems)
    validateSchemaSubset(tool.output.schema, `${tool.name}.output`, problems)
    ok(`${tool.name} schema 合法`, problems.length === 0, problems.join('; '))
    ok(`${tool.name} 有 timeoutMs`, Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0)
    ok(`${tool.name} render 返回 text block`, (() => {
      const blocks = tool.output.render({}, { state: 'done', path: 'x', bytes: 1, total: 2, percent: 50, segments: 2, speedBps: 1, avgBps: 1, elapsedSec: 0.1, resumed: false, id: 'dl-1', error: '', code: '', url: 'u', connections: 2 })
      return Array.isArray(blocks) && blocks[0] && blocks[0].type === 'text' && typeof blocks[0].text === 'string'
    })())
  }

  const file = tools.find((t) => t.name === 'download_file')
  const task = tools.find((t) => t.name === 'download_task')
  const run = (tool, args) => tool.execute(args, { signal: new AbortController().signal })

  console.log('\n[2] 分段并发下载 + 哈希校验')
  const bigDest = path.join(TMP, 'big.bin')
  let r = await run(file, { url: `${origin}/range/big.bin`, dest: bigDest, connections: 6 })
  ok('下载成功', r.ok === true, r.error)
  ok('分片数 > 1', r.segments > 1, `segments=${r.segments}`)
  ok('字节数一致', r.bytes === BIG.length, `${r.bytes} vs ${BIG.length}`)
  const got = await fsp.readFile(bigDest)
  ok('内容哈希一致', sha(got) === sha(BIG))
  ok('临时目录已清理', !(await fsp.stat(`${bigDest}.dshdl`).catch(() => null)))

  console.log('\n[3] 覆盖保护 / overwrite')
  r = await run(file, { url: `${origin}/range/big.bin`, dest: bigDest })
  ok('未覆盖时报 EEXIST', r.ok === false && r.code === 'EEXIST', `${r.state}/${r.code}`)
  r = await run(file, { url: `${origin}/range/big.bin`, dest: bigDest, overwrite: true, connections: 3 })
  ok('overwrite 成功', r.ok === true, r.error)

  console.log('\n[4] 不支持 Range 的服务器退化为单连接')
  const midDest = path.join(TMP, 'mid.bin')
  r = await run(file, { url: `${origin}/norange/mid.bin`, dest: midDest, connections: 8 })
  ok('下载成功', r.ok === true, r.error)
  ok('单连接（segments=1）', r.segments <= 1, `segments=${r.segments}`)
  ok('内容哈希一致', sha(await fsp.readFile(midDest)) === sha(MID))

  console.log('\n[5] 小文件单连接 + 目录式 dest 自动取名')
  const dirDest = path.join(TMP, 'auto-dir') + path.sep
  r = await run(file, { url: `${origin}/range/small.bin`, dest: dirDest, connections: 8 })
  ok('下载成功', r.ok === true, r.error)
  ok('自动文件名 small.bin', path.basename(r.path) === 'small.bin', r.path)
  ok('内容哈希一致', sha(await fsp.readFile(r.path)) === sha(SMALL))

  console.log('\n[6] 错误路径：404 / 401 / 空文件 / 非法 URL')
  r = await run(file, { url: `${origin}/404`, dest: path.join(TMP, 'x404.bin') })
  ok('404 失败且不落盘', r.ok === false && r.code === 'HTTP_STATUS' && /404/.test(r.error), `${r.code} ${r.error}`)
  r = await run(file, { url: `${origin}/auth`, dest: path.join(TMP, 'x401.bin') })
  ok('401 提示授权', r.ok === false && /授权/.test(r.error), r.error)
  r = await run(file, { url: `${origin}/empty.bin`, dest: path.join(TMP, 'x0.bin') })
  ok('空文件失败', r.ok === false && r.code === 'EMPTY_BODY', `${r.code}`)
  r = await run(file, { url: 'ftp://x/y', dest: path.join(TMP, 'y.bin') })
  ok('非法协议被拒', r.ok === false && r.code === 'BAD_URL', `${r.code}`)

  console.log('\n[7] 后台任务：status / list / cancel / 断点续传')
  const slowDest = path.join(TMP, 'slow.bin')
  let bg = await run(file, { url: `${origin}/slow/mid.bin`, dest: slowDest, connections: 4, background: true })
  ok('后台启动返回 id', bg.ok === true && /^dl-/.test(bg.id), bg.error)
  await sleep(500)
  let st = await run(task, { action: 'status', id: bg.id })
  ok('status 可见进度', st.ok === true && st.tasks[0].bytes > 0, JSON.stringify(st.tasks[0]))
  const mid = st.tasks[0]
  ok('进度 < 100%', mid.percent !== null && mid.percent < 100, String(mid.percent))
  let list = await run(task, { action: 'list' })
  ok('list 含该任务', list.ok === true && list.tasks.some((t) => t.id === bg.id))
  const cancelled = await run(task, { action: 'cancel', id: bg.id })
  ok('cancel 返回取消态', ['cancelled', 'running'].includes(cancelled.tasks[0].state), cancelled.tasks[0].state)
  await sleep(600)
  st = await run(task, { action: 'status', id: bg.id })
  ok('取消后状态为 cancelled', st.tasks[0].state === 'cancelled', st.tasks[0].state)
  const have = await fsp.stat(`${slowDest}.dshdl`).then(() => true).catch(() => false)
  ok('取消后保留 .dshdl 分片', have === true)

  r = await run(file, { url: `${origin}/slow/mid.bin`, dest: slowDest, connections: 4 })
  ok('续传后完成', r.ok === true, r.error)
  ok('续传标记 resumed=true', r.resumed === true, String(r.resumed))
  ok('续传后内容哈希一致', sha(await fsp.readFile(slowDest)) === sha(MID))

  st = await run(task, { action: 'status', id: 'dl-not-exist' }).catch((e) => ({ thrown: String(e) }))
  ok('未知任务 id 报错', Boolean(st.thrown), JSON.stringify(st))

  console.log('\n[8] 并发多任务（同进程共享引擎）')
  const p1 = path.join(TMP, 'c1.bin')
  const p2 = path.join(TMP, 'c2.bin')
  const [a, b] = await Promise.all([
    run(file, { url: `${origin}/range/big.bin`, dest: p1, connections: 4 }),
    run(file, { url: `${origin}/range/big.bin`, dest: p2, connections: 4 }),
  ])
  ok('并发任务都成功', a.ok && b.ok, `${a.error} / ${b.error}`)
  ok('并发结果哈希一致', sha(await fsp.readFile(p1)) === sha(BIG) && sha(await fsp.readFile(p2)) === sha(BIG))

  console.log('\n[9] baseDir 解析')
  const expectedDefault = [path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'downloads'), os.homedir()]
    .find((p) => existsSync(p))
  ok('默认 baseDir 是已存在的 Downloads/home', defaultBaseDir() === expectedDefault, defaultBaseDir())
  const { tools: localTools } = mountPlugin({ connections: 2, baseDir: TMP })
  const localFile = localTools.find((t) => t.name === 'download_file')
  const r9 = await localFile.execute({ url: `${origin}/range/small.bin`, dest: path.join('sub', 'rel.bin') }, { signal: new AbortController().signal })
  ok('相对 dest 落在 baseDir 下', r9.ok === true && r9.path === path.join(TMP, 'sub', 'rel.bin'), r9.error || r9.path)

  server.close()
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {})

  console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`)
  if (failed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('测试崩溃：', e)
  process.exitCode = 1
})
