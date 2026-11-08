# dsh-multi-download

[中文说明](README.md) · English

A **multi-threaded downloader plugin** for [DeepSeek Harness](https://github.com/deepseek-ai): it gives the agent two tools, `download_file` and `download_task`, backed by HTTP `Range` segment concurrency.

Zero dependencies — only Node's built-in `fetch` + `fs`, no `@deepseek-ai/*` imports, so it is immune to asar module-resolution quirks.

## What it does

| Capability | How |
| --- | --- |
| Multi-connection download | Splits the file with `Range: bytes=start-end` across N connections (default 8, max 16); files under `minSegmentBytes` (2 MiB) stay single-connection |
| Resumable | Segments + `meta.json` live in `<dest>.dshdl/`; re-call with the same `dest` to continue. Changed ETag/size discards stale segments |
| Auto fallback | Server answers `200` (no Range) → segments are dropped and the file is streamed on one connection |
| Integrity | Segment count and byte size verified, merged into `merged.bin`, then atomically renamed onto `dest` — never a half-written target |
| Retries | Network errors / 5xx / 429 back off exponentially (default 4 tries); 404, 401, `EACCES` are fatal |
| Progress & cancel | Background tasks with live speed/percent via `download_task`; cancel keeps segments for resume |
| Safety | Refuses to overwrite an existing file unless `overwrite: true`; custom headers (Cookie/Referer/Authorization) |

## Tools

### `download_file`

```jsonc
{
  "url": "https://example.com/big.iso",   // required, http/https
  "dest": "D:\\data\\big.iso",            // required; absolute preferred, relative resolves against baseDir
  "connections": 8,                        // optional, 1..16
  "headers": { "Referer": "https://example.com/" }, // optional
  "overwrite": false,                      // optional
  "resume": true,                          // optional, false discards old segments
  "background": false                      // optional, true returns a task id immediately
}
```

A `dest` ending in `/` or `\` (or pointing at an existing directory) derives the filename from the URL.

Returns (excerpt): `{ ok, state, id, path, url, bytes, total, percent, connections, segments, resumed, speedBps, avgBps, elapsedSec, error, code }`.

### `download_task`

```jsonc
{ "action": "list" }                    // recent tasks
{ "action": "status", "id": "dl-1a2b" } // one task: state, bytes, percent, speed
{ "action": "cancel", "id": "dl-1a2b" } // cancel, keeps segments for resume
```

## Install

```js
// inside a DSH session (plugin_manager requires danger-full-access)
plugin_manager({ action: "install_bundle", target: "D:\\path\\to\\dsh-multi-download" })
```

After installing, `cordis_inspect_query` (`Tool` / `listTools`) should list `download_file` and `download_task`. A freshly installed bundle usually hot-loads; replacing an already installed bundle needs a DSH restart.

## Configuration (`cordis.patch.yml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `connections` | 8 | default connection count |
| `maxConnections` | 16 | upper bound that clamps the tool argument |
| `minSegmentBytes` | 2097152 | files below this stay single-connection |
| `retries` | 4 | attempts per failed request |
| `requestTimeoutMs` | 45000 | probe / connect timeout |
| `stallTimeoutMs` | 30000 | abort and retry when no bytes arrive for this long |
| `baseDir` | `''` | base for relative `dest` (empty = user's Downloads; env `DSH_DOWNLOAD_DIR` also works) |
| `userAgent` | plugin UA | default User-Agent |
| `keepTemp` | false | keep `.dshdl/` after success |
| `maxTasks` / `taskTtlMs` | 64 / 6h | in-memory task registry limits |

## Tests

```bash
node tests/run.mjs
```

40 assertions against a local HTTP server (no network needed): tool-schema subset compliance, plugin mounting, segmented download with SHA-256 verification, overwrite protection, a server that ignores Range, directory-style `dest`, 404/401/empty body/bad URL, background status/list/cancel, resume after cancel, concurrent tasks, baseDir resolution.

## Limits

- `http/https` only (no ftp, magnet, or HLS segment protocols).
- Forces `accept-encoding: identity` so `Content-Length` and byte offsets stay honest.
- Task records live in process memory; DSH restarts lose them, but on-disk segments survive and resume works.

## License

MIT
