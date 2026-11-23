// 并发测试运行器（2026-11-23 机制批）：test/*-cases.ts 全量并发执行，替代串行 && 链。
// 设计判据：①每套件独立进程（tmpdir/process.pid 隔离已全量铺），并发无共享态；
// ②失败即汇总非首败即停（串行链首败即停——并行语义取「全量跑完报全败」，信息更多）；
// ③输出按套件分段，失败套件末尾重放摘要，grep 友好。
import { readdirSync } from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const dir = join(root, "test")
const files = readdirSync(dir).filter((f) => f.endsWith("-cases.ts")).sort()
const CONCURRENCY = 6

/** @type {{ file: string; code: number; tail: string[] }[]} */
const results = []
let next = 0
let running = 0
let failed = 0

function runOne(file) {
  running++
  const t0 = Date.now()
  const child = spawn(process.execPath, ["run", join("test", file)], { cwd: root, shell: false })
  const tail = []
  const push = (d) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue
      tail.push(line)
      if (tail.length > 6) tail.shift()
    }
  }
  child.stdout.on("data", push)
  child.stderr.on("data", push)
  child.on("close", (code) => {
    running--
    results.push({ file, code: code ?? 1, tail })
    if (code !== 0) failed++
    while (running < CONCURRENCY && next < files.length) runOne(files[next++])
    if (next >= files.length && running === 0) finish(Date.now() - t0)
  })
}

function finish(elapsedMs) {
  const pass = results.filter((r) => r.code === 0).length
  console.log(`\ntest-runner: ${pass}/${results.length} suites pass (${Math.round(elapsedMs / 1000)}s, concurrency=${CONCURRENCY})`)
  for (const r of results.filter((x) => x.code !== 0)) {
    console.log(`\nFAIL ${r.file}`)
    for (const line of r.tail) console.log(`  ${line}`)
  }
  process.exit(failed === 0 ? 0 : 1)
}

while (next < Math.min(CONCURRENCY, files.length)) runOne(files[next++])
