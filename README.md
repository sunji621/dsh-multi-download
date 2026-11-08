# dsh-multi-download

[English](README.en.md) · 中文

给 DeepSeek Harness 的 agent 加一个**多线程下载器**：`download_file` / `download_task` 两个工具。

零依赖 —— 只用 Node 内置的 `fetch` + `fs`，不引用任何 `@deepseek-ai/*` 包，因此不受 asar 内模块解析影响，也不用装任何东西。

## 它做什么

| 能力 | 说明 |
| --- | --- |
| 多连接并发 | HTTP `Range` 分段，默认 8 条连接（上限 16），大文件接近带宽上限而不是单连接限速 |
| 断点续传 | 分片落在目标旁的 `<dest>.dshdl/`，失败/取消后对同一 `dest` 再调一次就接着下（服务器 ETag/大小变了会自动丢弃旧分片） |
| 自动退化 | 服务器不支持 `Range`（返回 200）或文件太小 → 自动单连接流式下载 |
| 完整性 | 分片合并后校验字节数，先写 `merged.bin` 再原子 `rename`，不会留下半截目标文件 |
| 重试 | 网络错误 / 5xx / 429 指数退避重试（默认 4 次）；写盘错误、404、401 不重试 |
| 进度与取消 | 后台任务 + `download_task` 查询实时速度/百分比/已下字节，可取消 |
| 安全 | 目标已存在默认报错（`overwrite: true` 才覆盖）；自定义请求头（Cookie/Referer/Authorization） |

## 工具

### `download_file`

```jsonc
{
  "url": "https://example.com/big.iso",   // 必填，http/https 直链
  "dest": "D:\\data\\big.iso",            // 必填，绝对路径最佳；相对路径基于 baseDir
  "connections": 8,                        // 可选，1..16
  "headers": { "Referer": "https://example.com/" }, // 可选
  "overwrite": false,                      // 可选
  "resume": true,                          // 可选，false = 丢弃旧分片重下
  "background": false                      // 可选，true = 立即返回任务 id
}
```

`dest` 以 `/` 或 `\` 结尾（或指向已存在目录）时自动按 URL 取文件名。

返回（节选）：`{ ok, state, id, path, url, bytes, total, percent, connections, segments, resumed, speedBps, avgBps, elapsedSec, error, code }`。

### `download_task`

```jsonc
{ "action": "list" }                    // 列出最近任务
{ "action": "status", "id": "dl-1a2b" } // 单个任务进度
{ "action": "cancel", "id": "dl-1a2b" } // 取消（保留分片，可续传）
```

## 安装

```js
// 在 DSH 会话里（plugin_manager 需要 danger-full-access）
plugin_manager({ action: "install_bundle", target: "D:\\dshwork\\dsh-multi-download" })
```

安装后 `cordis_inspect_query` 应能看到 `download_file` / `download_task`；新装 bundle 一般 HMR 生效，替换已装包需重启 DSH。

## 配置（`cordis.patch.yml`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `connections` | 8 | 默认并发连接数 |
| `maxConnections` | 16 | 工具参数上限（会被钳制） |
| `minSegmentBytes` | 2097152 | 小于该字节数的文件不分段 |
| `retries` | 4 | 单请求重试次数 |
| `requestTimeoutMs` | 45000 | 探测/建连超时 |
| `stallTimeoutMs` | 30000 | 无数据停滞多久断开重试 |
| `baseDir` | `''` | `dest` 相对路径基准（空 = 用户 Downloads 目录；也读环境变量 `DSH_DOWNLOAD_DIR`） |
| `userAgent` | 插件 UA | 默认 User-Agent |
| `keepTemp` | false | 成功后保留 `.dshdl` 临时目录 |
| `maxTasks` / `taskTtlMs` | 64 / 6h | 任务注册表上限与保留时间 |

## 自测

```bash
node tests/run.mjs
```

覆盖 40 项断言：工具 schema 子集合规、插件装配、分段并发 + SHA256 校验、覆盖保护、不支持 Range 的服务器、目录式 dest、404/401/空文件/非法 URL、后台 status/list/cancel、取消后续传、并发多任务、baseDir 解析。

## 边界

- 只支持 `http/https`（不支持 ftp / magnet / HLS 分片协议）。
- 不吃 CDN 的 `Content-Encoding: gzip`（探测与分片请求都强制 `accept-encoding: identity`，保证字节偏移与 `Content-Length` 一致）。
- 单文件任务在进程内注册表里，DSH 重启后任务记录丢失；但磁盘分片还在，重新 `download_file` 同 `dest` 会续传。
- 目标路径的父目录会自动创建；只读/无权限路径会报 `EACCES/EPERM`（不重试）。
